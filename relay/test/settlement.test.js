// @ts-check
// Execution settlement rules: offline, hand-off window, exactly-once delivery, unknown outcome.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_RESPONSE_LIMIT_BYTES } from '../src/device.js';
import { MCP_BODY_LIMIT_BYTES, MCP_MAX_DEPTH } from '../src/mcp.js';
import { readConfig } from '../src/relay.js';
import { makeRelay, mcp, obtainTokens, poll, respond, toolsCall, waitFor } from './helpers.js';

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
  assert.equal((await respond(t, entry.command)).status, 404);
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

  // A notification: 502 with no body, also at once.
  const note = await deliverOne(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await sendRaw(t, '{oops', note.command.shard_token)).status, 400);
  const noteRes = await note.answer;
  assert.equal(noteRes.status, 502);
  assert.equal(await noteRes.text(), '');
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

  // A notification: 502 with no body.
  const note = await deliverOne(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await send(note.command.shard_token)).status, 413);
  const noteRes = await note.answer;
  assert.equal(noteRes.status, 502);
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
  const answers = [mcp(t, token, toolsCall(1)), mcp(t, token, toolsCall(2)), mcp(t, token, toolsCall(3))];
  await waitFor(() => t.relay.hub.inspect().handoff === 3);
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

test('a relay failure while answering a delivered request is HTTP 200 -32002 delivered:true, never a 5xx', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const { answer, command } = await deliverOne(t, token, toolsCall('deep'));
  // A reply that parses but is too deeply nested to encode again for Claude.
  const depth = 100_000;
  const raw =
    `{"request_id":${JSON.stringify(command.request_id)},"channel":"main","resp_code":200,` +
    `"resp_type":"jsonrpc_response","resp_json":{"jsonrpc":"2.0","id":"deep","result":` +
    `${'['.repeat(depth)}${']'.repeat(depth)}}}`;
  assert.equal((await sendRaw(t, raw, command.shard_token)).status, 200);
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
    ['the phone parser limit', nestedCall('e', 124), /nested more than 64 levels/],
    ['5,000 levels', nestedCall('e', 5000), /nested more than 64 levels/],
    ['100,000 levels', nestedCall('e', 100_000), /nested more than 64 levels/],
  ];
  for (const [label, body, message] of refused) {
    const res = await mcp(t, token, body);
    assert.equal(res.status, 400, label);
    const reply = await res.json();
    assert.equal(reply.id, 'e', label);
    assert.equal(reply.error.code, -32600, label);
    assert.match(reply.error.message, message, label);
    assert.equal(reply.error.data, undefined, label);
    // A notification gets the status only.
    const note = await mcp(t, token, body.replace('"id":"e",', ''));
    assert.equal(note.status, 400, `${label} (notification)`);
    assert.equal(await note.text(), '');
  }
  assert.deepEqual(t.relay.hub.inspect().handoff, 1, 'nothing refused was handed off');

  // At the limit, and a correctly paired emoji, are accepted. The poll response the phone gets
  // stays well inside serde_json's 128-level limit and carries no lone surrogate escape.
  const deepest = mcp(t, token, nestedCall('deepest', MCP_MAX_DEPTH));
  const emoji = mcp(t, token, '{"jsonrpc":"2.0","id":"emoji","method":"tools/call","params":{"text":"\\ud83d\\ude00 ok"}}');
  await waitFor(() => t.relay.hub.inspect().handoff === 3);
  const pollRes = await poll(t, 0);
  assert.equal(pollRes.status, 200);
  const text = await pollRes.text();
  assert.doesNotMatch(text, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, 'no unpaired high surrogate escape');
  const { commands } = JSON.parse(text);
  assert.deepEqual(commands.map((command) => command.jsonrpc.id), ['innocent', 'deepest', 'emoji']);
  assert.equal(depthOf(commands[1].jsonrpc), MCP_MAX_DEPTH);
  assert.equal(depthOf(JSON.parse(text)), MCP_MAX_DEPTH + 3);
  assert.equal(commands[2].jsonrpc.params.text, '\u{1F600} ok');
  for (const command of commands) assert.equal((await respond(t, command)).status, 200);
  for (const answer of [innocent, deepest, emoji]) assert.equal((await answer).status, 200);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('a request larger than the limit once encoded for the phone is refused with 413 before delivery', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  // "1e20" (4 bytes) is encoded as 100000000000000000000 (21 bytes): under the body limit as
  // sent, more than four times over it once encoded.
  const count = Math.floor((MCP_BODY_LIMIT_BYTES - 200) / 5);
  const body = `{"jsonrpc":"2.0","id":"big","method":"tools/call","params":{"n":[${Array(count).fill('1e20').join(',')}]}}`;
  assert.ok(new TextEncoder().encode(body).byteLength <= MCP_BODY_LIMIT_BYTES);
  const res = await mcp(t, token, body);
  assert.equal(res.status, 413);
  const reply = await res.json();
  assert.equal(reply.id, 'big');
  assert.equal(reply.error.code, -32600);
  assert.match(reply.error.message, /larger than 262144 bytes once encoded/);
  const note = await mcp(t, token, body.replace('"id":"big",', ''));
  assert.equal(note.status, 413);
  assert.equal(await note.text(), '');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal((await poll(t, 0)).status, 204, 'nothing was handed off');
});

test('the hub encodes a command when it is submitted: one that cannot be encoded changes nothing', async () => {
  const t = makeRelay();
  const parked = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const options = { configured: true, settleWithinMs: 1000 };
  assert.throws(() => t.relay.hub.submit({ request_id: 'r', shard_token: 's', jsonrpc: { n: 1n } }, options), TypeError);
  assert.deepEqual(t.relay.hub.inspect(), { parked: true, handoff: 0, delivered: 0, inFlight: 0, lastPollEndedAt: null });
  // The poll stays parked and still gets the next command.
  const outcome = t.relay.hub.submit({ request_id: 'ok', shard_token: 's', jsonrpc: { jsonrpc: '2.0', method: 'x' } }, options);
  const res = await parked;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).commands[0].request_id, 'ok');
  await t.clock.advance(1000);
  assert.deepEqual(await outcome, { kind: 'unknown' });
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
  const answers = [mcp(t, token, toolsCall('b1')), mcp(t, token, toolsCall('b2')), mcp(t, token, toolsCall('b3'))];
  await waitFor(() => t.relay.hub.inspect().handoff === 3);
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
  const answers = [mcp(t, token, toolsCall('c1')), mcp(t, token, toolsCall('c2'))];
  await waitFor(() => t.relay.hub.inspect().handoff === 2);
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
