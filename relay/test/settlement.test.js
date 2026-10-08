// @ts-check
// Execution settlement rules: offline, hand-off window, exactly-once delivery, unknown outcome.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_RESPONSE_LIMIT_BYTES } from '../src/device.js';
import { encodeCommand } from '../src/hub.js';
import { MCP_BODY_LIMIT_BYTES, MCP_MAX_DEPTH } from '../src/mcp.js';
import { readConfig } from '../src/relay.js';
import { makeRelay, mcp, obtainTokens, poll, promptly, respond, tick, toolsCall, waitFor } from './helpers.js';

/** @param {ReturnType<typeof makeRelay>} t */
async function deliverOne(t, token, message = toolsCall(1)) {
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = mcp(t, token, message);
  const pollRes = await pollPromise;
  assert.equal(pollRes.status, 200);
  const [command] = (await pollRes.json()).commands;
  return { answer, command };
}

/**
 * Posts a raw body to /device/v1/response, with the shard token header unless it is undefined.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string | Uint8Array} body
 * @param {string | undefined} shardToken
 */
function sendRaw(t, body, shardToken) {
  return t.relay.fetch(
    new Request('https://relay.example/device/v1/response', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.device.key}`,
        'content-type': 'application/json',
        ...(shardToken === undefined ? {} : { 'x-tunnel-shard-token': shardToken }),
      },
      body,
    }),
  );
}

test('offline: no poll ever means 503, not delivered, nothing queued', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const res = await mcp(t, token, toolsCall('a'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    jsonrpc: '2.0',
    id: 'a',
    error: {
      code: -32001,
      message: 'DroidBridge is offline. The request was not delivered to the phone.',
      data: { droidbridge_relay: { state: 'offline', delivered: false } },
    },
  });
  // Offline notification: status only.
  const note = await mcp(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 503);
  assert.equal(await note.text(), '');
  // A poll afterwards gets nothing.
  const later = await poll(t, 0);
  assert.equal(later.status, 204);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('offline after the online grace: a poll that ended more than 5 s ago does not count', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  await t.clock.advance(5001);
  const res = await mcp(t, token, toolsCall());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.data.droidbridge_relay.state, 'offline');
});

test('hand-off timeout: online but no poll within 5 s is 503 unavailable and never delivered later', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204); // poll just ended: online
  const answerPromise = mcp(t, token, toolsCall('late'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  await t.clock.advance(4999);
  assert.equal(t.relay.hub.inspect().handoff, 1, 'still waiting just before the window closes');
  await t.clock.advance(1);
  const res = await answerPromise;
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.id, 'late');
  assert.equal(body.error.code, -32001);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'unavailable', delivered: false });
  assert.match(body.error.message, /not delivered/);
  // The phone polls right after: the dropped command is gone.
  const after = await poll(t, 0);
  assert.equal(after.status, 204);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('hand-off within the window: the next poll receives the waiting command exactly once', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const answerPromise = mcp(t, token, toolsCall('w'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  await t.clock.advance(3000);
  const pollRes = await poll(t);
  assert.equal(pollRes.status, 200);
  const [command] = (await pollRes.json()).commands;
  assert.equal(command.jsonrpc.id, 'w');
  // Passing the old hand-off deadline changes nothing: it was delivered.
  await t.clock.advance(5000);
  assert.equal((await poll(t, 0)).status, 204, 'never delivered twice');
  assert.equal((await respond(t, command)).status, 200);
  assert.equal((await answerPromise).status, 200);
});

test('unknown settlement: delivered, no response before the deadline, HTTP 200 -32002, not redelivered, late response 404', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token, toolsCall(42));
  assert.equal(command.response_timeout, '240s');
  await t.clock.advance(240_000 + 4_999);
  assert.equal(t.relay.hub.inspect().delivered, 1, 'still within the grace period');
  await t.clock.advance(1);
  const res = await answer;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    jsonrpc: '2.0',
    id: 42,
    error: {
      code: -32002,
      message:
        'DroidBridge did not report the outcome in time. The request may or may not have run on the phone, and it was not retried.',
      data: { droidbridge_relay: { state: 'settlement_unknown', delivered: true, retried: false } },
    },
  });
  assert.equal((await poll(t, 0)).status, 204, 'not delivered again');
  const late = await respond(t, command);
  assert.equal(late.status, 404);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('unknown settlement uses RESPONSE_TIMEOUT_SECONDS (clamped) plus the grace', async () => {
  const t = makeRelay({ env: { RESPONSE_TIMEOUT_SECONDS: '3' } });
  assert.equal(t.relay.config.responseTimeoutSeconds, 10);
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token);
  assert.equal(command.response_timeout, '10s');
  await t.clock.advance(15_000);
  assert.equal((await answer).status, 200);
  assert.equal(makeRelay({ env: { RESPONSE_TIMEOUT_SECONDS: '5000' } }).relay.config.responseTimeoutSeconds, 900);
  assert.equal(makeRelay({ env: { RESPONSE_TIMEOUT_SECONDS: 'abc' } }).relay.config.responseTimeoutSeconds, 240);
  // Every number is clamped, however it is written; only a value that is not a number at all
  // falls back to the default.
  /** @type {[string, number][]} */
  const cases = [
    ['999999', 900],
    ['1000000', 900],
    [`1${'0'.repeat(400)}`, 900],
    ['-5', 10],
    ['0', 10],
    ['300.5', 301],
    ['300.4', 300],
    [' 120 ', 120],
    ['+60', 60],
    ['1e3', 900],
    ['', 240],
    ['12s', 240],
    ['0x20', 240],
    ['Infinity', 240],
  ];
  for (const [value, expected] of cases) {
    assert.equal(readConfig({ RESPONSE_TIMEOUT_SECONDS: value }).responseTimeoutSeconds, expected, JSON.stringify(value));
  }
  assert.equal(readConfig({}).responseTimeoutSeconds, 240);
});

test('unknown settlement for a notification is HTTP 200 with no body', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer } = await deliverOne(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  await t.clock.advance(245_000);
  const res = await answer;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('shard token mismatch is 404 and leaves the request pending; the right token settles it', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token);
  const wrong = await respond(t, command, {}, 'A'.repeat(43));
  assert.equal(wrong.status, 404);
  const missing = await t.relay.fetch(
    new Request('https://relay.example/device/v1/response', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.device.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: command.request_id, channel: 'main', resp_code: 200, resp_type: 'jsonrpc_response' }),
    }),
  );
  assert.equal(missing.status, 404);
  assert.equal(t.relay.hub.inspect().delivered, 1);
  const right = await respond(t, command);
  assert.equal(right.status, 200);
  assert.equal((await answer).status, 200);
  // Settled: a second response is 404.
  assert.equal((await respond(t, command)).status, 404);
});

test('a response for a command still in the hand-off list (never delivered) is 404', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const answer = mcp(t, token, toolsCall());
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  const entry = [...t.relay.hub.entries.values()][0];
  assert.equal((await respond(t, JSON.parse(entry.wire))).status, 404);
  await t.clock.advance(5000);
  assert.equal((await answer).status, 503);
});

test('device response body limits and format', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token);
  // Unreadable bodies that do not carry the request's shard token settle nothing.
  for (const body of ['{oops', '[]', '{"request_id":5}']) {
    assert.equal((await sendRaw(t, body, 'A'.repeat(43))).status, 400, body);
    assert.equal((await sendRaw(t, body, undefined)).status, 400, body);
  }
  assert.equal(t.relay.hub.inspect().delivered, 1, 'still pending after bad bodies with no matching token');
  // A body just under the cap (the phone's 12,000,000-byte MCP limit plus envelope) settles.
  assert.equal(DEVICE_RESPONSE_LIMIT_BYTES, 12_000_000 + 1024 * 1024);
  const result = { jsonrpc: '2.0', id: 1, result: { text: 'z'.repeat(12_000_000) } };
  const ok = await sendRaw(
    t,
    JSON.stringify({
      request_id: command.request_id,
      channel: 'main',
      resp_json: result,
      resp_code: 200,
      resp_type: 'jsonrpc_response',
    }),
    command.shard_token,
  );
  assert.equal(ok.status, 200);
  const res = await answer;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.text.length, 12_000_000);
});

test('an unreadable device reply with the request\'s shard token is 400 and settles it at once as invalid_device_reply', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const unreadable = [
    '{oops',
    '',
    '[]',
    '"text"',
    'null',
    '{}',
    '{"request_id":5}',
    '{"request_id":null,"resp_code":200}',
    new Uint8Array([0x7b, 0xff, 0x7d]),
  ];
  for (const body of unreadable) {
    const label = typeof body === 'string' ? JSON.stringify(body) : 'invalid UTF-8';
    const { answer, command } = await deliverOne(t, token, toolsCall('bad'));
    const startedAt = t.clock.now();
    const ack = await sendRaw(t, body, command.shard_token);
    assert.equal(ack.status, 400, label);
    assert.deepEqual(await ack.json(), { error: 'invalid_request' });
    const res = await answer;
    assert.equal(t.clock.now(), startedAt, `${label}: no waiting for the deadline`);
    assert.equal(res.status, 200, label);
    const reply = await res.json();
    assert.equal(reply.id, 'bad');
    assert.equal(reply.error.code, -32603);
    assert.match(reply.error.message, /not retried/);
    assert.deepEqual(reply.error.data.droidbridge_relay, { state: 'invalid_device_reply', delivered: true, retried: false });
    assert.equal((await respond(t, command)).status, 404, `${label}: settled, a later valid reply is 404`);
    assert.equal(t.relay.hub.inspect().inFlight, 0);
  }
  assert.equal(t.clock.pendingTimers(), 0);

  // A notification: an empty 200 (never a 5xx a client could replay), also at once.
  const note = await deliverOne(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const noteStartedAt = t.clock.now();
  assert.equal((await sendRaw(t, '{oops', note.command.shard_token)).status, 400);
  const noteRes = await note.answer;
  assert.equal(t.clock.now(), noteStartedAt, 'no waiting for the deadline');
  assert.equal(noteRes.status, 200);
  assert.equal(await noteRes.text(), '');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('an oversized device reply is 413 and settles its request at once as invalid_device_reply', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const tooBig = new Uint8Array(DEVICE_RESPONSE_LIMIT_BYTES + 1).fill(0x20);
  const send = (/** @type {string | undefined} */ shardToken) => sendRaw(t, tooBig, shardToken);

  // A request: oversized replies with a wrong or missing shard token settle nothing.
  const { answer, command } = await deliverOne(t, token, toolsCall('big'));
  assert.equal((await send('A'.repeat(43))).status, 413);
  assert.equal((await send(undefined)).status, 413);
  assert.equal(t.relay.hub.inspect().delivered, 1);
  // With the right shard token, Claude is answered without the clock moving.
  const startedAt = t.clock.now();
  assert.equal((await send(command.shard_token)).status, 413);
  const res = await answer;
  assert.equal(t.clock.now(), startedAt, 'no waiting for the 245 s deadline');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'big');
  assert.equal(body.error.code, -32603);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'invalid_device_reply', delivered: true, retried: false });
  assert.equal((await respond(t, command)).status, 404, 'settled: a later reply is 404');
  assert.equal(t.clock.pendingTimers(), 0);

  // A notification: an empty 200.
  const note = await deliverOne(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await send(note.command.shard_token)).status, 413);
  const noteRes = await note.answer;
  assert.equal(noteRes.status, 200);
  assert.equal(await noteRes.text(), '');
});

test('a new poll supersedes a parked one: the old poll gets 204', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const first = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const second = poll(t);
  const firstRes = await first;
  assert.equal(firstRes.status, 204);
  assert.ok(t.relay.hub.inspect().parked, 'the new poll is parked');
  const answer = mcp(t, token, toolsCall('s'));
  const secondRes = await second;
  assert.equal(secondRes.status, 200);
  const [command] = (await secondRes.json()).commands;
  assert.equal(command.jsonrpc.id, 's');
  await respond(t, command);
  assert.equal((await answer).status, 200);
});

test('a parked poll ends with 204 after timeout_ms, capped at pollCapMs', async () => {
  const t = makeRelay();
  const short = poll(t, 15000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(14_999);
  assert.ok(t.relay.hub.inspect().parked);
  await t.clock.advance(1);
  assert.equal((await short).status, 204);
  assert.equal(t.relay.hub.inspect().lastPollEndedAt, t.clock.now());

  const capped = poll(t, 600_000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(25_000);
  assert.equal((await capped).status, 204);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('poll limit caps the batch; the remainder waits for the next poll', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  // One at a time: each request reaches the hand-off list only after its token is checked
  // (a WebCrypto digest off the main thread), so concurrent ones could arrive in any order.
  const answers = await submitInOrder(t, token, [1, 2, 3]);
  const first = await (await poll(t, 15000, 2)).json();
  assert.deepEqual(first.commands.map((command) => command.jsonrpc.id), [1, 2]);
  const second = await (await poll(t, 15000, 2)).json();
  assert.deepEqual(second.commands.map((command) => command.jsonrpc.id), [3]);
  for (const command of [...first.commands, ...second.commands]) assert.equal((await respond(t, command)).status, 200);
  for (const answer of answers) assert.equal((await answer).status, 200);
});

test('a Claude request that disconnects during hand-off is never delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const controller = new AbortController();
  const answer = t.relay.fetch(
    new Request('https://relay.example/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolsCall('gone')),
      signal: controller.signal,
    }),
  );
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  controller.abort();
  const res = await answer;
  assert.equal(res.status, 503);
  assert.equal((await poll(t, 0)).status, 204);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('misconfigured device secret: /mcp answers like offline', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  // Same storage, a relay instance whose secret is broken.
  const { Relay } = await import('../src/relay.js');
  const broken = new Relay({
    storage: t.storage,
    env: { ...t.env, DEVICE_KEY_SHA256: 'not-hex' },
    now: t.clock.now,
    timers: t.clock.api,
  });
  const res = await broken.fetch(
    new Request('https://relay.example/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolsCall('m')),
    }),
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.data.droidbridge_relay.state, 'offline');
});

test('a relay failure after the command was offered but before delivery is HTTP 200 -32002 delivered:false, and it is never delivered later', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204); // online, between polls: the command waits for a poll
  // The hand-off timer fails right after the command joined the hand-off list.
  const original = t.clock.api.setTimeout;
  t.clock.api.setTimeout = () => {
    t.clock.api.setTimeout = original;
    throw new Error('timer failure');
  };
  const res = await mcp(t, token, toolsCall('offered'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'offered');
  assert.equal(body.error.code, -32002);
  assert.match(body.error.message, /not delivered/);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
  assert.equal(t.errors.length, 1, 'the failure is reported');
  // Withdrawn from the hand-off list: the next poll gets nothing, nothing is left in flight.
  assert.equal((await poll(t, 0)).status, 204);
  assert.deepEqual(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

/**
 * Makes the MCP handler fail once its request has an outcome, the way a bug or a reset while
 * answering would: after the phone's reply settled the delivered request.
 * @param {ReturnType<typeof makeRelay>} t
 */
function failAfterOutcome(t) {
  const submit = t.relay.hub.submit.bind(t.relay.hub);
  t.relay.hub.submit = (...args) =>
    submit(...args).then(() => {
      throw new RangeError('answer failure');
    });
}

test('a relay failure while answering a delivered request is HTTP 200 -32002 delivered:true, never a 5xx', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  failAfterOutcome(t);
  const { answer, command } = await deliverOne(t, token, toolsCall('deep'));
  assert.equal((await respond(t, command)).status, 200);
  const res = await answer;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'deep');
  assert.equal(body.error.code, -32002);
  assert.match(body.error.message, /may or may not have run/);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: true, retried: false });
  assert.ok(t.errors[0] instanceof RangeError, 'the failure is reported');
  assert.equal((await respond(t, command)).status, 404, 'settled: a later reply is 404');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

/**
 * Makes the `nth` setTimeout call from now on throw once, the way the tests above inject a
 * timer failure.
 * @param {ReturnType<typeof makeRelay>} t
 */
function failNthTimer(t, nth = 1) {
  const original = t.clock.api.setTimeout;
  let calls = 0;
  t.clock.api.setTimeout = (fn, ms) => {
    calls += 1;
    if (calls < nth) return original(fn, ms);
    t.clock.api.setTimeout = original;
    throw new Error('timer failure');
  };
}

/**
 * Deepest nesting of objects and arrays in a JSON value (a scalar is 0).
 * @param {unknown} value
 * @returns {number}
 */
function depthOf(value) {
  if (typeof value !== 'object' || value === null) return 0;
  return 1 + Math.max(0, ...Object.values(value).map(depthOf));
}

/** A tools/call whose arguments nest arrays so that the whole message is `depth` levels deep. */
function nestedCall(/** @type {string} */ id, /** @type {number} */ depth) {
  // message (1) > params (2) > arguments (3) > x: arrays from level 4 on
  const arrays = depth - 3;
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"command",` +
    `"arguments":{"x":${'['.repeat(arrays)}${']'.repeat(arrays)}}}}`;
}

/** The same, nesting objects instead of arrays: `{"a":{"a":…{}}}` from level 4 on. */
function nestedObjectCall(/** @type {string} */ id, /** @type {number} */ depth) {
  const objects = depth - 3;
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"command",` +
    `"arguments":${'{"a":'.repeat(objects)}{}${'}'.repeat(objects)}}}`;
}

/** Alternating objects and arrays: `{"a":[{"a":[…]}]}`, `depth` levels in all. */
function nestedMixedCall(/** @type {string} */ id, /** @type {number} */ depth) {
  let inner = '0';
  for (let level = depth; level > 3; level -= 1) inner = level % 2 === 0 ? `{"a":${inner}}` : `[${inner}]`;
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"command",` +
    `"arguments":{"x":${inner}}}}`;
}

test('a request the phone could not parse is refused with 400 before delivery, and never spoils a poll for others', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204); // online: accepted requests wait in the hand-off list
  const innocent = mcp(t, token, toolsCall('innocent'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);

  /** @type {[string, string, RegExp][]} */
  const refused = [
    ['cut emoji', '{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"text":"cut emoji \\ud83d"}}', /unpaired UTF-16 surrogate/],
    ['lone low surrogate', '{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"t":["\\ude00x"]}}', /unpaired UTF-16 surrogate/],
    ['reversed pair', '{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"t":"\\ude00\\ud83d"}}', /unpaired UTF-16 surrogate/],
    ['surrogate in a member name', '{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"\\ud800":1}}', /member name contains an unpaired/],
    ['surrogate in the method', '{"jsonrpc":"2.0","id":"e","method":"tools/\\udbff"}', /unpaired UTF-16 surrogate/],
    ['one level too deep', nestedCall('e', MCP_MAX_DEPTH + 1), /nested more than 64 levels/],
    ['objects one level too deep', nestedObjectCall('e', MCP_MAX_DEPTH + 1), /nested more than 64 levels/],
    ['objects and arrays one level too deep', nestedMixedCall('e', MCP_MAX_DEPTH + 1), /nested more than 64 levels/],
    ['5,000 levels of objects', nestedObjectCall('e', 5000), /nested more than 64 levels/],
    ['the phone parser limit', nestedCall('e', 124), /nested more than 64 levels/],
    // JSON.parse keeps only the last of repeated members, but the phone reads the whole text.
    ['a cut emoji in a repeated member', '{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"t":"\\ud83d","t":"ok"}}', /unpaired UTF-16 surrogate/],
    [
      'deep nesting in a repeated member',
      `{"jsonrpc":"2.0","id":"e","method":"tools/call","params":{"name":"command","arguments":{"x":${'['.repeat(67)}${']'.repeat(67)}},"arguments":{}}}`,
      /nested more than 64 levels/,
    ],
    ['5,000 levels', nestedCall('e', 5000), /nested more than 64 levels/],
    ['100,000 levels', nestedCall('e', 100_000), /nested more than 64 levels/],
  ];
  for (const [label, body, message] of refused) {
    const res = await promptly(mcp(t, token, body), `${label}: refused at once`);
    assert.equal(res.status, 400, label);
    const reply = await res.json();
    assert.equal(reply.id, 'e', label);
    assert.equal(reply.error.code, -32600, label);
    assert.match(reply.error.message, message, label);
    assert.equal(reply.error.data, undefined, label);
    // A notification gets the status only.
    const note = await promptly(mcp(t, token, body.replace('"id":"e",', '')), `${label} (notification)`);
    assert.equal(note.status, 400, `${label} (notification)`);
    assert.equal(await note.text(), '');
  }
  assert.deepEqual(t.relay.hub.inspect().handoff, 1, 'nothing refused was handed off');

  // At the limit, and a correctly paired emoji, are accepted. The poll response the phone gets
  // stays well inside serde_json's 128-level limit and carries no lone surrogate escape.
  /** @type {Promise<Response>[]} */
  const accepted = [];
  for (const body of [
    nestedCall('deepest', MCP_MAX_DEPTH),
    '{"jsonrpc":"2.0","id":"emoji","method":"tools/call","params":{"text":"\\ud83d\\ude00 ok"}}',
    nestedObjectCall('objects', MCP_MAX_DEPTH),
    nestedMixedCall('mixed', MCP_MAX_DEPTH),
  ]) {
    accepted.push(mcp(t, token, body));
    await waitFor(() => t.relay.hub.inspect().handoff === accepted.length + 1);
  }
  const pollRes = await poll(t, 0);
  assert.equal(pollRes.status, 200);
  const text = await pollRes.text();
  assert.doesNotMatch(text, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, 'no unpaired high surrogate escape');
  const { commands } = JSON.parse(text);
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), ['innocent', 'deepest', 'emoji', 'objects', 'mixed']);
  assert.equal(depthOf(commands[1].jsonrpc), MCP_MAX_DEPTH);
  assert.equal(depthOf(commands[3].jsonrpc), MCP_MAX_DEPTH);
  assert.equal(depthOf(commands[4].jsonrpc), MCP_MAX_DEPTH);
  assert.equal(depthOf(JSON.parse(text)), MCP_MAX_DEPTH + 3);
  assert.equal(commands[2].jsonrpc.params.text, '\u{1F600} ok');
  for (const command of commands) assert.equal((await respond(t, command)).status, 200);
  for (const answer of [innocent, ...accepted]) assert.equal((await answer).status, 200);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('the phone gets each request as the text Claude sent: eight at the body limit fit one poll response', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const encoder = new TextEncoder();
  /**
   * A tools/call of exactly MCP_BODY_LIMIT_BYTES bytes: CJK text (3 bytes per character in
   * UTF-8, one UTF-16 unit) and the number 1e20 (4 bytes as written, 21 if it were re-encoded
   * as 100000000000000000000).
   * @param {number} id
   */
  function atLimit(id) {
    const head = `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"command","arguments":{"t":"`;
    const middle = `${'\u4e2d'.repeat(20_000)}","n":[`;
    const tail = ']}}}';
    const room = MCP_BODY_LIMIT_BYTES - encoder.encode(head + middle + tail).byteLength;
    const count = Math.floor((room + 1) / 5);
    const numbers = Array(count).fill('1e20').join(',');
    const pad = ' '.repeat(room - numbers.length);
    const body = head + middle + numbers + tail + pad;
    assert.equal(encoder.encode(body).byteLength, MCP_BODY_LIMIT_BYTES);
    return body;
  }
  const bodies = Array.from({ length: 8 }, (_, i) => atLimit(i + 1));
  /** @type {Promise<Response>[]} */
  const answers = [];
  for (const body of bodies) {
    answers.push(mcp(t, token, body));
    await waitFor(() => t.relay.hub.inspect().handoff === answers.length);
  }

  const pollRes = await poll(t, 0);
  assert.equal(pollRes.status, 200);
  const bytes = new Uint8Array(await pollRes.arrayBuffer());
  // The phone drops a whole poll response above MAX_POLL_BODY_BYTES
  // (rust/crates/app_native/src/tunnel.rs: MCP_BODY_LIMIT_BYTES * 25 + 64 KiB).
  assert.ok(bytes.byteLength <= MCP_BODY_LIMIT_BYTES * 25 + 64 * 1024, `poll body of ${bytes.byteLength} bytes`);
  assert.ok(bytes.byteLength < MCP_BODY_LIMIT_BYTES * 8 + 8 * 1024, 'nothing was re-encoded larger');
  const text = new TextDecoder().decode(bytes);
  for (const body of bodies) assert.ok(text.includes(`"jsonrpc":${body}}`), 'the message text is forwarded as sent');
  const { commands } = JSON.parse(text);
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const command of commands) assert.equal((await respond(t, command)).status, 200);
  for (const answer of answers) assert.equal((await answer).status, 200);

  // One byte more is refused, counted in UTF-8 bytes: this body has far fewer UTF-16 units
  // (characters as JavaScript counts them) than the limit.
  const over = `${atLimit(9)} `;
  assert.ok(over.length < MCP_BODY_LIMIT_BYTES);
  assert.equal(encoder.encode(over).byteLength, MCP_BODY_LIMIT_BYTES + 1);
  const res = await mcp(t, token, over);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, -32600);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal((await poll(t, 0)).status, 204, 'nothing was handed off');
});

test('the hub encodes a command when it is submitted: one that cannot be encoded changes nothing', async () => {
  const t = makeRelay();
  const options = { configured: true, settleWithinMs: 1000 };
  const unencodable = { request_id: 'r', shard_token: 's', n: 1n };

  // Between polls (online, nothing parked): it never joins the hand-off list.
  assert.equal((await poll(t, 0)).status, 204);
  const before = t.relay.hub.inspect();
  assert.throws(() => t.relay.hub.submit(unencodable, '{}', options), TypeError);
  assert.deepEqual(t.relay.hub.inspect(), before);
  assert.equal(t.clock.pendingTimers(), 0, 'no hand-off timer was armed');
  assert.equal((await poll(t, 0)).status, 204, 'the next poll gets nothing');

  // A parked poll: it stays parked and still gets the next command.
  const parked = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  assert.throws(() => t.relay.hub.submit(unencodable, '{}', options), TypeError);
  assert.equal(t.relay.hub.inspect().parked, true);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  const outcome = t.relay.hub.submit({ request_id: 'ok', shard_token: 's' }, '{"jsonrpc":"2.0","method":"x"}', options);
  const res = await parked;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"commands":[{"request_id":"ok","shard_token":"s","jsonrpc":{"jsonrpc":"2.0","method":"x"}}]}');
  await t.clock.advance(1000);
  assert.deepEqual(await outcome, { kind: 'unknown' });
});

test('encodeCommand adds the message text as the jsonrpc member, unchanged', () => {
  const message = '{"jsonrpc":"2.0","id":9007199254740993,"method":"x","params":{"n":1e400,"z":-0}}';
  assert.equal(
    encodeCommand({ request_id: 'r', headers: { A: ['b'] } }, message),
    `{"request_id":"r","headers":{"A":["b"]},"jsonrpc":${message}}`,
  );
  assert.equal(encodeCommand({}, '{}'), '{"jsonrpc":{}}');
  assert.throws(() => encodeCommand({ jsonrpc: {} }, '{}'), TypeError);
  assert.throws(() => encodeCommand({ request_id: 'r' }, /** @type {any} */ ({ jsonrpc: '2.0' })), TypeError);
  assert.throws(() => encodeCommand(/** @type {any} */ ([]), '{}'), TypeError);
});

test('a timer failure while handing a command to a parked poll delivers nothing and leaves the poll parked', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const parked = poll(t, 15000);
  await waitFor(() => t.relay.hub.inspect().parked);
  failNthTimer(t); // the deadline of the command about to be delivered
  const res = await mcp(t, token, toolsCall('p'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'p');
  assert.equal(body.error.code, -32002);
  assert.match(body.error.message, /not delivered/);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
  assert.equal(t.errors.length, 1, 'the failure is reported');
  assert.deepEqual(t.relay.hub.inspect().parked, true, 'the poll is still parked');
  assert.equal(t.relay.hub.inspect().inFlight, 0);

  // The same poll carries the next request, and ends on its own when nothing comes.
  const answer = mcp(t, token, toolsCall('next'));
  const pollRes = await parked;
  assert.equal(pollRes.status, 200);
  const { commands } = await pollRes.json();
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), ['next']);
  assert.equal((await respond(t, commands[0])).status, 200);
  assert.equal((await answer).status, 200);

  const idle = poll(t, 15000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(15_000);
  assert.equal((await idle).status, 204);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('a timer failure while a poll takes the hand-off batch delivers none of it; the next poll gets every command', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const answers = await submitInOrder(t, token, ['b1', 'b2', 'b3']);
  failNthTimer(t, 2); // the second deadline of the batch
  const failed = await poll(t, 0);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'server_error' });
  assert.equal(t.errors.length, 1);
  const state = t.relay.hub.inspect();
  assert.equal(state.handoff, 3, 'every command still waits');
  assert.equal(state.delivered, 0, 'none was marked delivered');
  assert.equal(state.inFlight, 3);

  const pollRes = await poll(t, 0);
  assert.equal(pollRes.status, 200);
  const { commands } = await pollRes.json();
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), ['b1', 'b2', 'b3']);
  for (const command of commands) assert.equal((await respond(t, command)).status, 200);
  for (const answer of answers) assert.equal((await answer).status, 200);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('a timer failure on a poll with no later poll ends every waiting request as not delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const answers = await submitInOrder(t, token, ['c1', 'c2']);
  failNthTimer(t, 1);
  assert.equal((await poll(t, 0)).status, 500);
  await t.clock.advance(5000);
  for (const answer of answers) {
    const res = await answer;
    assert.equal(res.status, 503);
    assert.deepEqual((await res.json()).error.data.droidbridge_relay, { state: 'unavailable', delivered: false });
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

/**
 * Sends one tools/call per id, each only after the previous one waits in the hand-off list, so
 * the list holds them in this order. Returns Claude's pending answers.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} token
 * @param {(string | number)[]} ids
 */
async function submitInOrder(t, token, ids) {
  const answers = [];
  for (const id of ids) {
    answers.push(mcp(t, token, toolsCall(id)));
    await waitFor(() => t.relay.hub.inspect().handoff === answers.length);
  }
  return answers;
}

/**
 * Makes the next clearTimeout call throw once.
 * @param {ReturnType<typeof makeRelay>} t
 */
function failNextClear(t) {
  const original = t.clock.api.clearTimeout;
  t.clock.api.clearTimeout = () => {
    t.clock.api.clearTimeout = original;
    throw new Error('clearTimeout failure');
  };
}

/**
 * Whether `promise` settles within a few turns of the event loop (no clock time passes).
 * @param {Promise<unknown>} promise
 */
async function settlesSoon(promise, turns = 200) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < turns && !done; i += 1) await tick();
  return done;
}

test('a timer that cannot be cleared never strands a request, and does nothing when it fires later', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);

  // The deadline of a request the phone answers.
  const { answer, command } = await deliverOne(t, token, toolsCall('settle'));
  failNextClear(t);
  assert.equal((await respond(t, command)).status, 200, 'the phone\'s reply is accepted');
  assert.ok(await settlesSoon(answer), 'Claude is answered');
  const res = await answer;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 'settle', result: { ok: true } });
  assert.equal(t.relay.hub.inspect().inFlight, 0);

  // The timeout of a parked poll that a request ends. Its stale timer later fires while a newer
  // poll is parked, and leaves that poll alone.
  const parked = poll(t, 15_000);
  await waitFor(() => t.relay.hub.inspect().parked);
  failNextClear(t);
  const second = mcp(t, token, toolsCall('parked'));
  const pollRes = await parked;
  assert.equal(pollRes.status, 200);
  const [parkedCommand] = (await pollRes.json()).commands;
  assert.equal(parkedCommand.jsonrpc.id, 'parked');
  await t.clock.advance(1000);
  const next = poll(t, 15_000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(14_500); // past the first poll's timeout, not the second's
  assert.equal(t.relay.hub.inspect().parked, true, 'the newer poll is still parked');
  assert.equal((await respond(t, parkedCommand)).status, 200);
  assert.equal((await second).status, 200);

  // The hand-off timer of a request a poll takes. It fires after the request was delivered and
  // does not end it as unavailable.
  await t.clock.advance(1000);
  assert.equal((await next).status, 204);
  const third = mcp(t, token, toolsCall('handoff'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  failNextClear(t);
  const taken = await poll(t, 0);
  assert.equal(taken.status, 200);
  const [handoffCommand] = (await taken.json()).commands;
  await t.clock.advance(5000);
  assert.equal(await settlesSoon(third, 20), false, 'still waiting for the phone');
  assert.equal((await respond(t, handoffCommand)).status, 200);
  assert.equal((await third).status, 200);

  // Every stale timer has fired by now and changed nothing.
  await t.clock.advance(250_000);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('a deadline left over from a failed poll never ends the request that a later poll delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const first = mcp(t, token, toolsCall('b1'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  const second = mcp(t, token, toolsCall('b2'));
  await waitFor(() => t.relay.hub.inspect().handoff === 2);
  // The poll arms b1's deadline, fails to arm b2's, and cannot clear b1's: that timer stays.
  failNthTimer(t, 2);
  failNextClear(t);
  assert.equal((await poll(t, 0)).status, 500);
  assert.equal(t.relay.hub.inspect().delivered, 0);

  // 3 s later a poll delivers both with fresh deadlines (245 s from now).
  await t.clock.advance(3000);
  const pollRes = await poll(t, 0);
  assert.equal(pollRes.status, 200);
  const { commands } = await pollRes.json();
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), ['b1', 'b2']);

  // The stale deadline fires (245 s after the failed poll), 3 s before b1's real one.
  await t.clock.advance(244_000);
  assert.equal(await settlesSoon(first, 20), false, 'b1 is not ended before its deadline');
  assert.equal((await respond(t, commands[0])).status, 200, 'the phone\'s reply is still accepted');
  const res = await first;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 'b1', result: { ok: true } });
  assert.equal((await respond(t, commands[1])).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(t.clock.pendingTimers(), 0);
});

/**
 * A POST /mcp with its own abort signal.
 * @param {string} token
 * @param {unknown} message
 * @param {AbortSignal} signal
 */
function mcpWithSignal(/** @type {ReturnType<typeof makeRelay>} */ t, token, message, signal) {
  return t.relay.fetch(
    new Request('https://relay.example/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal,
    }),
  );
}

/** A device poll with its own abort signal. */
function pollWithSignal(/** @type {ReturnType<typeof makeRelay>} */ t, /** @type {AbortSignal} */ signal, timeoutMs = 15000) {
  return t.relay.fetch(
    new Request(`https://relay.example/device/v1/poll?limit=8&timeout_ms=${timeoutMs}`, {
      headers: { authorization: `Bearer ${t.device.key}` },
      signal,
    }),
  );
}

test('a Claude request that is already aborted is never offered to the phone, whether a poll waits or not', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const gone = new AbortController();
  gone.abort();

  // A poll waits: it is not handed the abandoned request and stays parked.
  const parked = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const res = await mcpWithSignal(t, token, toolsCall('gone'), gone.signal);
  assert.equal(res.status, 503);
  assert.deepEqual((await res.json()).error.data.droidbridge_relay, { state: 'unavailable', delivered: false });
  assert.equal(t.relay.hub.inspect().parked, true);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  await t.clock.advance(15_000);
  assert.equal((await parked).status, 204);

  // Between polls: it does not join the hand-off list.
  const between = await mcpWithSignal(t, token, toolsCall('gone'), gone.signal);
  assert.equal(between.status, 503);
  assert.equal((await poll(t, 0)).status, 204);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('a Claude request aborted while it is being authenticated is never delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  // Hold the access-token lookup until the request has been aborted.
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let reached = false;
  const lookup = t.relay.grants.lookupAccess.bind(t.relay.grants);
  t.relay.grants.lookupAccess = async (/** @type {string} */ value) => {
    reached = true;
    await gate;
    return lookup(value);
  };
  const controller = new AbortController();
  const answer = mcpWithSignal(t, token, toolsCall('abandoned'), controller.signal);
  await waitFor(() => reached);
  controller.abort();
  release();
  const res = await answer;
  assert.equal(res.status, 503);
  assert.deepEqual((await res.json()).error.data.droidbridge_relay, { state: 'unavailable', delivered: false });
  assert.equal((await poll(t, 0)).status, 204, 'the next poll gets nothing');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('a phone poll that is already aborted takes no command, is never parked and does not make the phone online', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const gone = new AbortController();
  gone.abort();

  // Offline phone: a dead poll does not bring it online.
  assert.equal((await pollWithSignal(t, gone.signal)).status, 204);
  assert.equal(t.relay.hub.inspect().parked, false);
  const offline = await mcp(t, token, toolsCall('o'));
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error.data.droidbridge_relay.state, 'offline');

  // A command waiting in the hand-off list stays there for a live poll.
  assert.equal((await poll(t, 0)).status, 204);
  const answer = mcp(t, token, toolsCall('w'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  assert.equal((await pollWithSignal(t, gone.signal)).status, 204);
  assert.deepEqual(t.relay.hub.inspect().handoff, 1);
  assert.equal(t.relay.hub.inspect().delivered, 0);
  const live = await poll(t, 0);
  assert.equal(live.status, 200);
  const [command] = (await live.json()).commands;
  assert.equal(command.jsonrpc.id, 'w');
  assert.equal((await respond(t, command)).status, 200);
  assert.equal((await answer).status, 200);
});

test('a parked phone poll whose connection drops stops counting as waiting', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const controller = new AbortController();
  const parked = pollWithSignal(t, controller.signal);
  await waitFor(() => t.relay.hub.inspect().parked);
  controller.abort();
  assert.equal((await parked).status, 204);
  assert.equal(t.relay.hub.inspect().parked, false);
  // Within the online grace a request waits for the next poll instead of being lost in the
  // dead one; with no poll it ends as not delivered.
  const answer = mcp(t, token, toolsCall('after-drop'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  await t.clock.advance(5000);
  const res = await answer;
  assert.equal(res.status, 503);
  assert.deepEqual((await res.json()).error.data.droidbridge_relay, { state: 'unavailable', delivered: false });
});

test('without a disconnect signal a dead poll is handed requests until it times out, and counts as online 5 s more', async () => {
  // What enable_request_signal prevents: the relay cannot tell this poll's connection is gone.
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const dead = poll(t, 25_000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(24_000);
  const lost = mcp(t, token, toolsCall('lost'));
  assert.equal((await dead).status, 200, 'handed to the dead poll');
  await t.clock.advance(1000);
  assert.equal(t.relay.hub.isOnline(), true);
  const idle = poll(t, 25_000);
  await waitFor(() => t.relay.hub.inspect().parked);
  await t.clock.advance(25_000);
  assert.equal((await idle).status, 204);
  await t.clock.advance(5000);
  assert.equal(t.relay.hub.isOnline(), true, '30 s after that poll started');
  await t.clock.advance(1);
  assert.equal(t.relay.hub.isOnline(), false);
  await t.clock.advance(245_000);
  const res = await lost;
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).error.data.droidbridge_relay, {
    state: 'settlement_unknown',
    delivered: true,
    retried: false,
  });
});

test('withdraw: a delivered request ends as unknown and a late reply is 404; a waiting one is never delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token, toolsCall('wd'));
  assert.equal(t.relay.hub.withdraw(command.request_id), true);
  const res = await answer;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: true, retried: false });
  assert.equal((await respond(t, command)).status, 404, 'withdrawn: a late reply is 404');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.relay.hub.withdraw(command.request_id), null, 'no longer held');

  assert.equal((await poll(t, 0)).status, 204);
  const waiting = mcp(t, token, toolsCall('ww'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  const [entry] = t.relay.hub.entries.values();
  assert.equal(t.relay.hub.withdraw(entry.id), false);
  assert.equal((await waiting).status, 503);
  assert.equal((await poll(t, 0)).status, 204, 'never delivered later');
  assert.equal(t.clock.pendingTimers(), 0);
});

test('a device reply whose upload fails partway settles nothing, so the phone can post it again', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token, toolsCall('m'));
  const broken = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"request_id":${JSON.stringify(command.request_id)},"resp_json":`));
      controller.error(new Error('connection reset'));
    },
  });
  const res = await t.relay.fetch(
    new Request('https://relay.example/device/v1/response', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.device.key}`,
        'content-type': 'application/json',
        'x-tunnel-shard-token': command.shard_token,
      },
      body: broken,
      // @ts-ignore Node needs duplex for a stream body
      duplex: 'half',
    }),
  );
  assert.equal(res.status, 500);
  assert.equal(t.relay.hub.inspect().delivered, 1, 'still waiting for the reply');
  assert.equal((await respond(t, command)).status, 200, 'the retried reply settles it');
  const ok = await answer;
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { jsonrpc: '2.0', id: 'm', result: { ok: true } });
});

test('when reporting a relay failure fails too, POST /mcp still gets HTTP 200 -32002 delivered:false', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  t.relay.onError = () => {
    throw new Error('logger down');
  };
  t.relay.grants.lookupAccess = async () => {
    throw new Error('storage');
  };
  const res = await mcp(t, token, toolsCall('e'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'e');
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
  // Other routes still answer 500.
  t.relay.grants.liveClientIds = async () => {
    throw new Error('storage');
  };
  const status = await t.relay.fetch(
    new Request('https://relay.example/device/v1/status', { headers: { authorization: `Bearer ${t.device.key}` } }),
  );
  assert.equal(status.status, 500);
});
