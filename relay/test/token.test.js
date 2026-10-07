// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORIGIN,
  makeRelay,
  obtainCode,
  obtainTokens,
  pkcePair,
  poll,
  respond,
  tokenPost,
  mcp,
  waitFor,
  toolsCall,
} from './helpers.js';

/** @param {Awaited<ReturnType<typeof obtainCode>>} grant @param {Record<string, string>} [overrides] */
function codeExchange(grant, overrides = {}) {
  return {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    client_id: grant.clientId,
    code_verifier: grant.verifier,
    ...overrides,
  };
}

/** True when the access token is accepted at /mcp (the device is offline, so 503 means "authorized"). */
async function tokenWorks(t, token) {
  const res = await mcp(t, token, toolsCall());
  return res.status !== 401;
}

test('PKCE failure is invalid_grant and consumes the code', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const wrong = await tokenPost(t, codeExchange(grant, { code_verifier: pkcePair().verifier }));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  const right = await tokenPost(t, codeExchange(grant));
  assert.equal(right.status, 400);
  assert.equal((await right.json()).error, 'invalid_grant');
  assert.equal(t.storage.keys('at:').length, 0);
});

test('malformed verifier and missing parameters are invalid_request', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  for (const overrides of [{ code_verifier: 'short' }, { code: '' }, { redirect_uri: '' }, { client_id: '' }]) {
    const res = await tokenPost(t, codeExchange(grant, overrides));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request', JSON.stringify(overrides));
  }
  // None of those consumed the code.
  assert.equal((await tokenPost(t, codeExchange(grant))).status, 200);
});

test('wrong redirect_uri at /token is invalid_grant', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const res = await tokenPost(t, codeExchange(grant, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('another client_id at /token is invalid_grant; an unknown one is invalid_client (401)', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const unknown = await tokenPost(t, codeExchange(grant, { client_id: 'dbrcl_BBBBBBBBBBBBBBBBBBBBBB' }));
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error, 'invalid_client');
  const other = await obtainCode(t, { pairingCode: 'QQQQ2222' });
  const res = await tokenPost(t, codeExchange(grant, { client_id: other.clientId }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('resource mismatch at /token is invalid_target', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const res = await tokenPost(t, codeExchange(grant, { resource: 'https://other.example/mcp' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_target');
});

test('expired code is invalid_grant', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  await t.clock.advance(60_001);
  const res = await tokenPost(t, codeExchange(grant));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('code reuse revokes the family issued from it', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const first = await tokenPost(t, codeExchange(grant));
  assert.equal(first.status, 200);
  const tokens = await first.json();
  assert.ok(await tokenWorks(t, tokens.access_token));

  const replay = await tokenPost(t, codeExchange(grant));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');

  assert.equal(await tokenWorks(t, tokens.access_token), false, 'access token from the first exchange is revoked');
  const refresh = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: grant.clientId,
  });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json()).error, 'invalid_grant');
});

test('a replayed code still revokes its grant long after the code expired, for as long as the grant exists', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const first = await tokenPost(t, codeExchange(grant));
  assert.equal(first.status, 200);
  const tokens = await first.json();
  // Well past the code's 60 s life and 10 minute retention; every /token call sweeps first.
  await t.clock.advance(12 * 60 * 1000);
  await t.clock.advance(20 * 24 * 60 * 60 * 1000);
  const refreshed = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: grant.clientId });
  assert.equal(refreshed.status, 200);
  const current = await refreshed.json();
  assert.ok(await tokenWorks(t, current.access_token));
  assert.equal(t.storage.keys('code:').length, 1, 'the redeemed code is kept while its grant exists');
  const replay = await tokenPost(t, codeExchange(grant));
  assert.equal(replay.status, 400);
  const error = await replay.json();
  assert.equal(error.error, 'invalid_grant');
  assert.match(error.error_description, /already used\. Tokens issued from it were revoked/);
  assert.equal(await tokenWorks(t, current.access_token), false, 'the grant is revoked');
  const refresh = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: current.refresh_token, client_id: grant.clientId });
  assert.equal(refresh.status, 400);
  // With the grant gone nothing is left to revoke, and the code record is purged.
  await t.clock.advance(61_000);
  await tokenPost(t, { grant_type: 'refresh_token', refresh_token: 'x', client_id: grant.clientId });
  assert.equal(t.storage.keys('code:').length, 0);
});

test('a redeemed code is purged once its grant expires; an unredeemed one after its retention', async () => {
  const t = makeRelay();
  const redeemed = await obtainCode(t);
  assert.equal((await tokenPost(t, codeExchange(redeemed))).status, 200);
  const unused = await obtainCode(t, { pairingCode: 'QQQQ2222' });
  assert.ok(unused.code);
  assert.equal(t.storage.keys('code:').length, 2);
  await t.clock.advance(11 * 60 * 1000);
  await t.relay.maybeSweep();
  assert.equal(t.storage.keys('code:').length, 1, 'the unredeemed code is gone after its retention');
  await t.clock.advance(30 * 24 * 60 * 60 * 1000);
  await t.relay.maybeSweep();
  assert.equal(t.storage.keys('family:').length, 0);
  assert.equal(t.storage.keys('code:').length, 0, 'the redeemed code goes with its grant');
  const replay = await tokenPost(t, codeExchange(redeemed));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error_description, 'The authorization code is not valid.');
});

test('refresh rotation issues new tokens and retires the old refresh token', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  await t.clock.advance(30 * 60 * 1000);
  const res = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.clientId,
    resource: `${ORIGIN}/mcp`,
    scope: 'droidbridge',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const next = await res.json();
  assert.notEqual(next.access_token, tokens.access_token);
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal(next.expires_in, 3600);
  assert.ok(await tokenWorks(t, next.access_token));

  // The new refresh token works and rotates again.
  const again = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: tokens.clientId });
  assert.equal(again.status, 200);

  // Client mismatch and resource mismatch are refused.
  const latest = await again.json();
  const mismatch = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: latest.refresh_token, client_id: 'https://claude.ai/oauth/client' });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, 'invalid_grant');
  const target = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: latest.refresh_token,
    client_id: tokens.clientId,
    resource: 'https://other.example/mcp',
  });
  assert.equal((await target.json()).error, 'invalid_target');
  const scope = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: latest.refresh_token,
    client_id: tokens.clientId,
    scope: 'admin',
  });
  assert.equal((await scope.json()).error, 'invalid_scope');
});

test('refresh token reuse revokes the entire family', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const rotated = await (
    await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId })
  ).json();
  assert.ok(await tokenWorks(t, rotated.access_token));

  const reuse = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, 'invalid_grant');

  assert.equal(await tokenWorks(t, rotated.access_token), false);
  assert.equal(await tokenWorks(t, tokens.access_token), false);
  const stillRotated = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: tokens.clientId });
  assert.equal(stillRotated.status, 400);
  assert.equal(t.storage.keys('family:').length, 0);
});

test('refresh tokens expire after 30 days; storage stays bounded under heavy refreshing', async () => {
  const t = makeRelay();
  let tokens = await obtainTokens(t);
  const clientId = tokens.clientId;
  for (let i = 0; i < 40; i += 1) {
    const res = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(res.status, 200);
    tokens = { ...tokens, ...(await res.json()) };
  }
  assert.ok(t.storage.keys('at:').length <= 8);
  assert.ok(t.storage.keys('rt:').length <= 16);
  await t.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
  const expired = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(expired.status, 400);
  // The sweep (run by /token) purged the family and its tokens.
  assert.equal(t.storage.keys('family:').length, 0);
  assert.equal(t.storage.keys('at:').length, 0);
  assert.equal(t.storage.keys('rt:').length, 0);
});

test('/token request format errors', async () => {
  const t = makeRelay();
  const json = await t.relay.fetch(
    new Request(`${ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  );
  assert.equal(json.status, 400);
  assert.equal((await json.json()).error, 'invalid_request');
  assert.equal((await tokenPost(t, { grant_type: 'password' })).status, 400);
  assert.equal((await (await tokenPost(t, { grant_type: 'password' })).json()).error, 'unsupported_grant_type');
  assert.equal((await (await tokenPost(t, {})).json()).error, 'invalid_request');
  const repeated = await t.relay.fetch(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&grant_type=authorization_code',
    }),
  );
  assert.equal((await repeated.json()).error, 'invalid_request');
  const big = await tokenPost(t, { grant_type: 'refresh_token', pad: 'x'.repeat(17 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await t.relay.fetch(new Request(`${ORIGIN}/token`))).status, 405);
});

test('a code cannot be redeemed twice even when both requests race', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const [a, b] = await Promise.all([tokenPost(t, codeExchange(grant)), tokenPost(t, codeExchange(grant))]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  // The loser triggered reuse detection, so the winner's tokens are revoked too.
  const winner = a.status === 200 ? await a.json() : await b.json();
  assert.equal(await tokenWorks(t, winner.access_token), false);
});

test('an access token stays valid across requests until it expires', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  for (let i = 0; i < 2; i += 1) {
    const pollPromise = poll(t);
    await waitFor(() => t.relay.hub.inspect().parked);
    const answer = mcp(t, tokens.access_token, toolsCall(i));
    const [command] = (await (await pollPromise).json()).commands;
    await respond(t, command);
    assert.equal((await answer).status, 200);
  }
});

test('replaying the first refresh token after 20 rotations still revokes the whole family', async () => {
  const t = makeRelay();
  const first = await obtainTokens(t);
  let latest = first;
  for (let i = 0; i < 20; i += 1) {
    const res = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: latest.refresh_token, client_id: first.clientId });
    assert.equal(res.status, 200);
    latest = { ...latest, ...(await res.json()) };
  }
  // The first token's own record was trimmed long ago; storage stays bounded.
  assert.ok(t.storage.keys('rt:').length <= 16);
  assert.ok(await tokenWorks(t, latest.access_token));

  const replay = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId });
  assert.equal(replay.status, 400);
  const error = await replay.json();
  assert.equal(error.error, 'invalid_grant');
  assert.match(error.error_description, /revoked/);

  assert.equal(t.storage.keys('family:').length, 0);
  assert.equal(await tokenWorks(t, latest.access_token), false, 'latest access token revoked');
  const refresh = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: latest.refresh_token, client_id: first.clientId });
  assert.equal(refresh.status, 400, 'latest refresh token revoked');
  assert.equal(t.storage.keys('at:').length + t.storage.keys('rt:').length, 0);
});

test('a replayed refresh token revokes even with a wrong client_id; garbage tokens revoke nothing', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const rotated = await (
    await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId })
  ).json();
  // Unknown or malformed tokens with no live family: plain invalid_grant, grant untouched.
  for (const garbage of ['dbrr_nope', `dbrr_${'A'.repeat(22)}.${'B'.repeat(43)}`, 'x'.repeat(80)]) {
    const res = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: garbage, client_id: tokens.clientId });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_grant');
  }
  assert.ok(await tokenWorks(t, rotated.access_token));
  const replay = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: 'dbrcl_CCCCCCCCCCCCCCCCCCCCCC',
  });
  assert.equal(replay.status, 400);
  assert.equal(await tokenWorks(t, rotated.access_token), false);
});
