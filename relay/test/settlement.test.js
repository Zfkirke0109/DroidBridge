// @ts-check
// Execution settlement rules: offline, hand-off window, exactly-once delivery, unknown outcome.
import assert from 'node:assert/strict';
import test from 'node:test';
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
  const send = (/** @type {string | Uint8Array} */ body) =>
    t.relay.fetch(
      new Request('https://relay.example/device/v1/response', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t.device.key}`,
          'content-type': 'application/json',
          'x-tunnel-shard-token': command.shard_token,
        },
        body,
      }),
    );
  assert.equal((await send('{oops')).status, 400);
  assert.equal((await send('[]')).status, 400);
  assert.equal((await send('{"request_id":5}')).status, 400);
  const huge = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20);
  assert.equal((await send(huge)).status, 413);
  assert.equal(t.relay.hub.inspect().delivered, 1, 'still pending after bad bodies');
  // A large but allowed body settles.
  const result = { jsonrpc: '2.0', id: 1, result: { text: 'z'.repeat(5 * 1024 * 1024) } };
  const ok = await send(
    JSON.stringify({
      request_id: command.request_id,
      channel: 'main',
      resp_json: result,
      resp_code: 200,
      resp_type: 'jsonrpc_response',
    }),
  );
  assert.equal(ok.status, 200);
  const res = await answer;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.text.length, 5 * 1024 * 1024);
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
