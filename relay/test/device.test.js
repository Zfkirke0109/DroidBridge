// @ts-check
// Device authentication, pairing, status and revocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_CALLBACK,
  authorizeGet,
  authorizePost,
  deviceFetch,
  makeRelay,
  mcp,
  newDeviceKey,
  obtainTokens,
  pair,
  pkcePair,
  poll,
  promptly,
  register,
  respond,
  requestIdFrom,
  sha256HexSync,
  tokenPost,
  toolsCall,
  waitFor,
} from './helpers.js';
import { clampInt } from '../src/device.js';

const DEVICE_ROUTES = [
  ['GET', '/device/v1/status'],
  ['GET', '/device/v1/poll?limit=8&timeout_ms=0'],
  ['POST', '/device/v1/response'],
  ['POST', '/device/v1/pairing'],
  ['DELETE', '/device/v1/pairing'],
  ['POST', '/device/v1/revoke'],
];

test('device auth: missing or wrong key is 401 on every device route', async () => {
  const t = makeRelay();
  const other = newDeviceKey();
  for (const [method, path] of DEVICE_ROUTES) {
    for (const key of [null, other.key, `${t.device.key}x`, t.device.key.toUpperCase(), '']) {
      const res = await deviceFetch(t, path, { method, key, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path} with ${key === null ? 'no key' : 'a wrong key'}`);
    }
    // The hash itself is not a key.
    const res = await deviceFetch(t, path, { method, key: t.device.hash });
    assert.equal(res.status, 401);
  }
  // Nothing changed: no pairing stored, nothing revoked.
  assert.equal(await t.storage.get('pairing'), undefined);
});

test('device auth: a misconfigured DEVICE_KEY_SHA256 is 503 relay_not_configured', async () => {
  for (const secret of [undefined, '', 'abc', 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
    const t = makeRelay({ env: { DEVICE_KEY_SHA256: /** @type {any} */ (secret) } });
    for (const [method, path] of DEVICE_ROUTES) {
      const res = await deviceFetch(t, path, { method });
      assert.equal(res.status, 503, `${secret} ${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'relay_not_configured' });
    }
  }
  // Surrounding whitespace in the secret is tolerated.
  const t = makeRelay();
  const padded = makeRelay({ env: { DEVICE_KEY_SHA256: `  ${t.device.hash}\n` } });
  assert.equal(padded.relay.config.deviceKeyConfigured, true);
});

test('device routes: unknown path 404, wrong method 405', async () => {
  const t = makeRelay();
  assert.equal((await deviceFetch(t, '/device/v1/nothing')).status, 404);
  assert.equal((await deviceFetch(t, '/device/v2/poll')).status, 404);
  const res = await deviceFetch(t, '/device/v1/status', { method: 'POST', body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
  assert.equal((await deviceFetch(t, '/device/v1/pairing', { method: 'GET' })).headers.get('allow'), 'POST, DELETE');
});

test('status reports the protocol, authorized clients and pairing state', async () => {
  const t = makeRelay();
  const first = await (await deviceFetch(t, '/device/v1/status')).json();
  assert.deepEqual(first, {
    schema_version: 1,
    protocol: 'droidbridge-relay/1',
    authorized_clients: 0,
    pairing_active: false,
  });
  await pair(t, 'AAAABBBB');
  assert.equal((await (await deviceFetch(t, '/device/v1/status')).json()).pairing_active, true);
  await obtainTokens(t, { pairingCode: 'CCCCDDDD' });
  await obtainTokens(t, { pairingCode: 'EEEEFFFF' });
  const status = await (await deviceFetch(t, '/device/v1/status')).json();
  assert.equal(status.authorized_clients, 2);
  assert.equal(status.pairing_active, false, 'pairing consumed');
});

/**
 * Opens a consent page and returns its request id.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} [clientId] an existing client; a new one is registered when omitted
 */
async function consent(t, clientId) {
  const client = clientId ? { client_id: clientId } : await (await register(t)).json();
  const page = await authorizeGet(t, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    state: 'p',
  });
  assert.equal(page.status, 200);
  return requestIdFrom(await page.text());
}

test('pairing: unauthenticated wrong attempts cannot cancel a phone-generated code', async () => {
  const t = makeRelay();
  await pair(t, 'R2D2C3P0');
  // A public client can create consent requests and submit guesses without the device key.
  const a = await consent(t);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await authorizePost(t, { request_id: a, pairing_code: 'WXYZ-WXYZ', action: 'allow' });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /That code did not work/);
  }
  const third = await authorizePost(t, { request_id: a, pairing_code: 'WXYZ-WXYZ', action: 'allow' });
  assert.equal(third.status, 403);
  assert.match(await third.text(), /this request was cancelled/);
  assert.ok(await t.storage.get('pairing'));
  // A second request cannot cancel the phone's code either.
  const b = await consent(t);
  await authorizePost(t, { request_id: b, pairing_code: 'nope', action: 'allow' });
  await authorizePost(t, { request_id: b, pairing_code: 'nope', action: 'allow' });
  assert.ok(await t.storage.get('pairing'));
  // The user can still finish their own consent request with the right code.
  const c = await consent(t);
  const right = await authorizePost(t, { request_id: c, pairing_code: 'R2D2-C3P0', action: 'allow' });
  assert.equal(right.status, 302);
});

test('pairing: 3 failed submissions discard the consent request, not the pairing code', async () => {
  const t = makeRelay();
  await pair(t, 'HJKM2222');
  const requestId = await consent(t);
  for (let i = 0; i < 3; i += 1) {
    await authorizePost(t, { request_id: requestId, pairing_code: 'BAAD-0000', action: 'allow' });
  }
  assert.equal(t.storage.keys('pending:').length, 0);
  const after = await authorizePost(t, { request_id: requestId, pairing_code: 'HJKM-2222', action: 'allow' });
  assert.equal(after.status, 400);
  assert.match(await after.text(), /expired or was already answered/);
  // The pairing code survives and works on a fresh request.
  assert.ok(await t.storage.get('pairing'));
  const fresh = await consent(t);
  assert.equal((await authorizePost(t, { request_id: fresh, pairing_code: 'HJKM-2222', action: 'allow' })).status, 302);
});
test('pairing: no active code answers exactly like a wrong code; an empty code is not an attempt', async () => {
  const t = makeRelay();
  const clientId = (await (await register(t)).json()).client_id;
  const withoutPairing = await consent(t, clientId);
  const none = await authorizePost(t, { request_id: withoutPairing, pairing_code: 'ABCD-EFGH', action: 'allow' });
  await pair(t, 'ABCDEFGH');
  const withPairing = await consent(t, clientId);
  const wrong = await authorizePost(t, { request_id: withPairing, pairing_code: 'ZZZZ-ZZZZ', action: 'allow' });
  assert.equal(none.status, wrong.status);
  assert.equal(none.status, 403);
  const strip = (/** @type {string} */ html, /** @type {string} */ id) => html.replaceAll(id, 'REQUEST_ID');
  const noneHtml = await none.text();
  assert.equal(strip(noneHtml, withoutPairing), strip(await wrong.text(), withPairing));
  assert.equal(requestIdFrom(noneHtml), withoutPairing, 'the form can be submitted again');
  assert.deepEqual([...none.headers.keys()], [...wrong.headers.keys()]);
  // Both count against their consent request.
  for (const key of t.storage.keys('pending:')) assert.equal((await t.storage.get(key)).attempts, 1);
  // An empty submission is not an attempt anywhere.
  const blank = await authorizePost(t, { request_id: withPairing, pairing_code: '  ', action: 'allow' });
  assert.equal(blank.status, 400);
  assert.ok(await t.storage.get('pairing'));
  const ok = await authorizePost(t, { request_id: withPairing, pairing_code: 'abcd efgh', action: 'allow' });
  assert.equal(ok.status, 302);
});
test('pairing: Crockford look-alikes are accepted (O->0, I/L->1)', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, '0123A1B1');
  const ok = await authorizePost(t, { request_id: requestId, pairing_code: 'o12-3ai bl', action: 'allow' });
  assert.equal(ok.status, 302);
});

test('pairing: an expired code is rejected', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'TTTT0000', 60);
  await t.clock.advance(60_000);
  const res = await authorizePost(t, { request_id: requestId, pairing_code: 'TTTT-0000', action: 'allow' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /That code did not work/);
  assert.equal(await t.storage.get('pairing'), undefined);
  assert.equal((await (await deviceFetch(t, '/device/v1/status')).json()).pairing_active, false);
});

test('pairing: DELETE cancels the code', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'KKKK2222');
  const res = await deviceFetch(t, '/device/v1/pairing', { method: 'DELETE' });
  assert.equal(res.status, 204);
  const attempt = await authorizePost(t, { request_id: requestId, pairing_code: 'KKKK-2222', action: 'allow' });
  assert.equal(attempt.status, 403);
});

test('pairing: a new code replaces the old one', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'OLDC0DE1');
  await authorizePost(t, { request_id: requestId, pairing_code: 'XXXX-XXXX', action: 'allow' });
  assert.ok(await t.storage.get('pairing'));
  await pair(t, 'NEWC0DE2');
  assert.ok(await t.storage.get('pairing'));
  assert.equal(
    (await authorizePost(t, { request_id: requestId, pairing_code: 'OLDC-0DE1', action: 'allow' })).status,
    403,
  );
  assert.equal(
    (await authorizePost(t, { request_id: requestId, pairing_code: 'NEWC-0DE2', action: 'allow' })).status,
    302,
  );
});

test('pairing: request validation', async () => {
  const t = makeRelay();
  const hash = sha256HexSync('ABCDEFGH');
  const bad = [
    { code_sha256: hash.toUpperCase(), ttl_seconds: 60 },
    { code_sha256: hash.slice(1), ttl_seconds: 60 },
    { code_sha256: hash, ttl_seconds: 0 },
    { code_sha256: hash, ttl_seconds: 601 },
    { code_sha256: hash, ttl_seconds: 1.5 },
    { code_sha256: hash, ttl_seconds: '60' },
    { ttl_seconds: 60 },
  ];
  for (const body of bad) {
    const res = await deviceFetch(t, '/device/v1/pairing', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await deviceFetch(t, '/device/v1/pairing', { method: 'POST', body: 'x' })).status, 400);
  assert.equal(await t.storage.get('pairing'), undefined);
});

test('consent page: an expired pending request is an error page', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'ABCDEFGH');
  await t.clock.advance(10 * 60 * 1000);
  const res = await authorizePost(t, { request_id: requestId, pairing_code: 'ABCD-EFGH', action: 'allow' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired/);
  assert.ok(await t.storage.get('pairing'));
});

test('consent page: at most 10 pending requests per client and 50 overall', async () => {
  const t = makeRelay();
  /** @param {string} clientId */
  const params = (clientId) => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
  });
  const clients = [];
  for (let i = 0; i < 6; i += 1) clients.push((await (await register(t)).json()).client_id);
  // Per client: 10, then refused, while another client still gets in.
  const source = (n) => ({ 'cf-connecting-ip': `198.51.100.${n}` });
  for (let i = 0; i < 10; i += 1) assert.equal((await authorizeGet(t, params(clients[0]), source(1))).status, 200);
  const perClient = await authorizeGet(t, params(clients[0]), source(1));
  assert.equal(perClient.status, 429);
  assert.equal(perClient.headers.get('location'), null);
  assert.equal((await authorizeGet(t, params(clients[1]), source(2))).status, 200);
  // Overall: 50.
  for (let i = 0; i < 9; i += 1) assert.equal((await authorizeGet(t, params(clients[1]), source(2))).status, 200);
  for (const [index, clientId] of clients.slice(2, 5).entries()) {
    for (let i = 0; i < 10; i += 1) assert.equal((await authorizeGet(t, params(clientId), source(index + 3))).status, 200);
  }
  assert.equal(t.storage.keys('pending:').length, 50);
  assert.equal((await authorizeGet(t, params(clients[5]), source(6))).status, 429);
  await t.clock.advance(10 * 60 * 1000);
  assert.equal((await authorizeGet(t, params(clients[0]), source(1))).status, 200, 'expired requests are pruned first');
  assert.equal(t.storage.keys('pending:').length, 1);
});

test('consent page: one source cannot fill all slots through multiple public clients', async () => {
  const t = makeRelay();
  const clients = [];
  for (let i = 0; i < 6; i += 1) clients.push((await (await register(t)).json()).client_id);
  const params = (clientId) => ({
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge, code_challenge_method: 'S256',
  });
  const attacker = { 'cf-connecting-ip': '198.51.100.10' };
  const legitimate = { 'cf-connecting-ip': '203.0.113.25' };
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await authorizeGet(t, params(clients[0]), attacker)).status, 200);
  }
  for (const clientId of clients.slice(1, 5)) {
    assert.equal((await authorizeGet(t, params(clientId), attacker)).status, 429);
  }
  assert.equal(t.storage.keys('pending:').length, 10);
  assert.equal((await authorizeGet(t, params(clients[5]), legitimate)).status, 200);
  assert.equal(t.storage.keys('pending:').length, 11);
  for (const key of t.storage.keys('pending:')) {
    const record = await t.storage.get(key);
    assert.equal(typeof record.sourceHash, 'string');
    assert.equal(record.sourceHash.length, 64);
    assert.ok(!JSON.stringify(record).includes('198.51.100.10'), 'no raw client IP is persisted');
  }
});

test('consent page: missing or malformed edge IP shares a bounded fallback bucket', async () => {
  const t = makeRelay();
  const a = (await (await register(t)).json()).client_id;
  const b = (await (await register(t)).json()).client_id;
  const params = (clientId) => ({
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge, code_challenge_method: 'S256',
  });
  for (let i = 0; i < 10; i += 1) assert.equal((await authorizeGet(t, params(a))).status, 200);
  assert.equal((await authorizeGet(t, params(b), { 'cf-connecting-ip': 'not-an-ip' })).status, 429);
  assert.equal((await authorizeGet(t, params(b), { 'cf-connecting-ip': '999.999.999.999' })).status, 429);
  assert.equal((await authorizeGet(t, params(b), { 'cf-connecting-ip': '203.0.113.26' })).status, 200);
  assert.equal((await authorizeGet(t, params(b), { 'cf-connecting-ip': '2001:db8::26' })).status, 200);
});

test('consent page: pre-upgrade pending records cannot keep the global cap full', async () => {
  const t = makeRelay();
  const clientId = (await (await register(t)).json()).client_id;
  for (let i = 0; i < 50; i += 1) {
    await t.storage.put(`pending:legacy-${i}`, { client_id: 'old-client', expiresAt: t.clock.now() + 600_000 });
  }
  const page = await authorizeGet(t, {
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge, code_challenge_method: 'S256',
  }, { 'cf-connecting-ip': '203.0.113.27' });
  assert.equal(page.status, 200);
  assert.equal(t.storage.keys('pending:').length, 1);
});
test('revoke: tokens stop working, clients are removed, status shows 0 authorized clients', async () => {
  const t = makeRelay();
  const a = await obtainTokens(t, { pairingCode: 'AAAA1111' });
  const b = await obtainTokens(t, { pairingCode: 'BBBB2222' });
  await pair(t, 'CCCC3333');
  const pendingId = await consent(t);
  assert.equal((await (await deviceFetch(t, '/device/v1/status')).json()).authorized_clients, 2);

  const res = await deviceFetch(t, '/device/v1/revoke', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked_tokens: 4 });

  for (const tokens of [a, b]) {
    assert.equal((await mcp(t, tokens.access_token, toolsCall())).status, 401);
    const refresh = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
    assert.equal(refresh.status, 400, 'the grant is gone');
    assert.equal((await refresh.json()).error, 'invalid_grant');
  }
  const status = await (await deviceFetch(t, '/device/v1/status')).json();
  assert.equal(status.authorized_clients, 0);
  assert.equal(status.pairing_active, false);
  for (const prefix of ['at:', 'rt:', 'family:', 'code:', 'pending:', 'client:', 'cimd:', 'pairing']) {
    assert.equal(t.storage.keys(prefix).length, 0, prefix);
  }
  // A pending consent from before the revoke cannot be completed.
  await pair(t, 'DDDD4444');
  const late = await authorizePost(t, { request_id: pendingId, pairing_code: 'DDDD-4444', action: 'allow' });
  assert.equal(late.status, 400);
  // Revoking again is harmless.
  assert.deepEqual(await (await deviceFetch(t, '/device/v1/revoke', { method: 'POST' })).json(), { revoked_tokens: 0 });
});

test('revoke withdraws an authenticated request still waiting for a phone poll', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const answer = mcp(t, token, toolsCall('before-revoke'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);

  assert.equal((await deviceFetch(t, '/device/v1/revoke', { method: 'POST' })).status, 200);
  const result = await promptly(answer);
  assert.equal(result.status, 403);
  assert.equal((await result.json()).error.data.droidbridge_relay.delivered, false);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal((await poll(t, 0)).status, 204, 'the revoked request cannot reach a later poll');
});

test('revoke settles a delivered request as unknown and rejects its late reply', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const waitingPoll = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = mcp(t, token, toolsCall('delivered-before-revoke'));
  const [command] = (await (await waitingPoll).json()).commands;

  assert.equal((await deviceFetch(t, '/device/v1/revoke', { method: 'POST' })).status, 200);
  const result = await promptly(answer);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).error.data.droidbridge_relay, {
    state: 'settlement_unknown',
    delivered: true,
    retried: false,
  });
  assert.equal((await respond(t, command)).status, 404);
});

test('revoke prevents a request authenticated before its body finished from reaching the phone', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const originalGet = t.storage.get.bind(t.storage);
  let accessRead = false;
  t.storage.get = async (key) => {
    const record = await originalGet(key);
    if (key.startsWith('at:')) accessRead = true;
    return record;
  };
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let bodyController;
  const body = new ReadableStream({
    start(controller) {
      bodyController = controller;
    },
  });
  const request = new Request('https://relay.example/mcp', /** @type {any} */ ({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    duplex: 'half',
  }));
  const answer = t.relay.fetch(request);
  await waitFor(() => accessRead);
  const waitingPoll = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);

  assert.equal((await deviceFetch(t, '/device/v1/revoke', { method: 'POST' })).status, 200);
  bodyController.enqueue(new TextEncoder().encode(JSON.stringify(toolsCall('slow-body'))));
  bodyController.close();
  const first = await Promise.race([
    answer.then((response) => ({ kind: 'answer', response })),
    waitingPoll.then((response) => ({ kind: 'poll', response })),
  ]);
  assert.equal(first.kind, 'answer', 'the stale access token must never release a phone command');
  assert.equal(first.response.status, 401);
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  await t.clock.advance(15_000);
  assert.equal((await waitingPoll).status, 204);
});

/**
 * How long a poll with this query stays parked, in fake-clock milliseconds, and its status.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} query
 */
async function parkedFor(t, query) {
  const startedAt = t.clock.now();
  /** @type {number | null} */
  let endedAt = null;
  const pending = deviceFetch(t, `/device/v1/poll?${query}`).then((res) => {
    endedAt = t.clock.now();
    return res;
  });
  await waitFor(() => t.relay.hub.inspect().parked || endedAt !== null);
  for (let i = 0; i < 40 && endedAt === null; i += 1) await t.clock.advance(1000);
  const res = await pending;
  return { ms: /** @type {number} */ (endedAt) - startedAt, status: res.status };
}

test('poll: timeout_ms of any size is capped at 25 000; a value that is not a number means 15 000', async () => {
  const t = makeRelay();
  /** @type {[string, number][]} */
  const cases = [
    ['25000', 25_000],
    ['30000', 25_000],
    ['999999999', 25_000],
    ['1000000000', 25_000],
    ['99999999999', 25_000],
    ['9'.repeat(400), 25_000],
    ['00000000000000000000001000', 1000],
    ['1000', 1000],
    ['0', 0],
    ['-1', 15_000],
    ['1.5', 15_000],
    ['1e5', 15_000],
    ['abc', 15_000],
    ['', 15_000],
  ];
  for (const [value, expected] of cases) {
    const { ms, status } = await parkedFor(t, `limit=8&timeout_ms=${value}`);
    assert.equal(status, 204, value);
    assert.equal(ms, expected, `timeout_ms=${value.length > 20 ? `${value.length} digits` : value}`);
  }
  assert.equal((await parkedFor(t, 'limit=8')).ms, 15_000, 'absent');
});

test('poll: limit of any size is capped at 8', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  for (const [limit, expected] of [['1000000000', 8], ['9'.repeat(50), 8], ['0', 1], ['3', 3], ['x', 8]]) {
    assert.equal((await deviceFetch(t, '/device/v1/poll?limit=8&timeout_ms=0')).status, 204);
    const answers = [];
    for (let i = 0; i < 9; i += 1) {
      answers.push(mcp(t, token, toolsCall(`${limit}-${i}`)));
      await waitFor(() => t.relay.hub.inspect().handoff === answers.length);
    }
    const res = await deviceFetch(t, `/device/v1/poll?limit=${limit}&timeout_ms=0`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).commands.length, expected, `limit=${limit.length > 20 ? 'long' : limit}`);
    // Everything else waits out the hand-off window or its deadline.
    await t.clock.advance(250_000);
    await Promise.all(answers);
  }
  assert.equal(clampInt('123456789012345678901234567890', 0, 25_000, 15_000), 25_000);
  assert.equal(clampInt(null, 0, 25_000, 15_000), 15_000);
});

test('the phone\'s polls delete expired consent requests from storage, without waiting for the sweep', async () => {
  const t = makeRelay();
  const client = await (await register(t)).json();
  const { challenge } = pkcePair();
  const page = await authorizeGet(t, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'secret-state',
  });
  assert.equal(page.status, 200);
  assert.equal(t.storage.keys('pending:').length, 1);
  const quickPoll = () => deviceFetch(t, '/device/v1/poll?limit=8&timeout_ms=0');

  // From here on only the phone talks to the relay. A sweep before the request expires keeps it.
  await t.clock.advance(9 * 60 * 1000);
  assert.equal((await quickPoll()).status, 204);
  await t.relay.lock.run(() => {}); // the sweep that poll started has run
  assert.equal(t.relay.lastSweepAt, t.clock.now(), 'a sweep ran');
  assert.equal(t.storage.keys('pending:').length, 1, 'still usable');

  // The next sweep a poll starts after it expired deletes it, state and all.
  await t.clock.advance(61_000);
  assert.equal((await quickPoll()).status, 204);
  await waitFor(() => t.storage.keys('pending:').length === 0);
  assert.equal(t.errors.length, 0);

  // A poll never waits for the sweep: here the sweep is stuck behind the lock.
  /** @type {() => void} */
  let release = () => {};
  const held = t.relay.lock.run(() => new Promise((resolve) => (release = () => resolve(undefined))));
  await t.clock.advance(61_000);
  assert.equal((await promptly(quickPoll(), 'the poll did not wait for the sweep')).status, 204);
  release();
  await held;
  await t.relay.lock.run(() => {}); // the sweep that waited has run
  assert.equal(t.errors.length, 0);

  // And a failing sweep is only reported; the poll is answered as usual.
  t.relay.grants.sweep = async () => {
    throw new Error('storage');
  };
  await t.clock.advance(61_000);
  assert.equal((await quickPoll()).status, 204);
  await waitFor(() => t.errors.length === 1);
});
