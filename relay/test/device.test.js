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
  register,
  requestIdFrom,
  sha256HexSync,
  tokenPost,
  toolsCall,
} from './helpers.js';

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

/** @param {ReturnType<typeof makeRelay>} t */
async function consent(t) {
  const client = await (await register(t)).json();
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

test('pairing: 5 wrong attempts invalidate the code', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'R2D2C3P0');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await authorizePost(t, { request_id: requestId, pairing_code: 'WXYZ-WXYZ', action: 'allow' });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not correct/);
    assert.equal((await t.storage.get('pairing')).attempts, attempt);
  }
  const fifth = await authorizePost(t, { request_id: requestId, pairing_code: 'nope', action: 'allow' });
  assert.equal(fifth.status, 403);
  assert.match(await fifth.text(), /Too many wrong codes/);
  assert.equal(await t.storage.get('pairing'), undefined);
  // Even the right code no longer works.
  const right = await authorizePost(t, { request_id: requestId, pairing_code: 'R2D2-C3P0', action: 'allow' });
  assert.equal(right.status, 409);
  assert.match(await right.text(), /tap Pair Claude first/);
});

test('pairing: no active code does not consume an attempt; an empty code is not an attempt', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  const none = await authorizePost(t, { request_id: requestId, pairing_code: 'ABCD-EFGH', action: 'allow' });
  assert.equal(none.status, 409);
  const html = await none.text();
  assert.match(html, /Open DroidBridge and tap Pair Claude first/);
  assert.equal(requestIdFrom(html), requestId, 'the form can be submitted again');
  await pair(t, 'ABCDEFGH');
  const blank = await authorizePost(t, { request_id: requestId, pairing_code: '  ', action: 'allow' });
  assert.equal(blank.status, 400);
  assert.equal((await t.storage.get('pairing')).attempts, 0);
  const ok = await authorizePost(t, { request_id: requestId, pairing_code: 'abcd efgh', action: 'allow' });
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
  assert.equal(res.status, 409);
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
  assert.equal(attempt.status, 409);
});

test('pairing: a new code replaces the old one and resets attempts', async () => {
  const t = makeRelay();
  const requestId = await consent(t);
  await pair(t, 'OLDC0DE1');
  await authorizePost(t, { request_id: requestId, pairing_code: 'XXXX-XXXX', action: 'allow' });
  assert.equal((await t.storage.get('pairing')).attempts, 1);
  await pair(t, 'NEWC0DE2');
  assert.equal((await t.storage.get('pairing')).attempts, 0);
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
  assert.equal((await t.storage.get('pairing')).attempts, 0);
});

test('consent page: at most 50 pending requests', async () => {
  const t = makeRelay();
  const client = await (await register(t)).json();
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
  };
  for (let i = 0; i < 50; i += 1) assert.equal((await authorizeGet(t, params)).status, 200);
  const full = await authorizeGet(t, params);
  assert.equal(full.status, 429);
  assert.equal(full.headers.get('location'), null);
  await t.clock.advance(10 * 60 * 1000);
  assert.equal((await authorizeGet(t, params)).status, 200, 'expired requests are pruned first');
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
    assert.equal(refresh.status, 401, 'the registered client is gone');
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
