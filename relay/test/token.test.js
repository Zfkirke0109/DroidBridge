// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { Relay } from '../src/relay.js';
import {
  ORIGIN,
  makeRelay,
  obtainCode,
  obtainTokens,
  pkcePair,
  poll,
  respond,
  sha256HexSync,
  tokenPost,
  mcp,
  promptly,
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

test('code_verifier must be 43 to 128 unreserved characters, both ends included', async () => {
  // [verifier the code was issued for, a verifier one character outside the range]
  const cases = [
    [`${'a'.repeat(42)}~`, 'a'.repeat(42)],
    [`${'-._~'.repeat(31)}aZ09`, `${'-._~'.repeat(32)}a`],
  ];
  for (const [verifier, outside] of cases) {
    const t = makeRelay();
    const grant = await obtainCode(t, { verifier });
    assert.equal(grant.verifier.length === 43 || grant.verifier.length === 128, true);
    const refused = await tokenPost(t, codeExchange(grant, { code_verifier: outside }));
    assert.equal(refused.status, 400, `${outside.length}`);
    const error = await refused.json();
    assert.equal(error.error, 'invalid_request', `${outside.length}`);
    assert.match(error.error_description, /43 to 128/);
    // Refused for its format, before the code was looked at, so the code still works.
    const res = await tokenPost(t, codeExchange(grant));
    assert.equal(res.status, 200, `${verifier.length}`);
  }
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

test('code replay still withdraws a family when its metadata read fails', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const queued = mcp(t, tokens.access_token, toolsCall('code-read-error'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  const originalGet = t.storage.get.bind(t.storage);
  t.storage.get = async (key) => {
    if (key.startsWith('family:')) throw new Error('selective family read failure');
    return originalGet(key);
  };

  const replay = await tokenPost(t, codeExchange(tokens));
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error_description, /grant was revoked/);
  assert.equal((await promptly(queued)).status, 403);
  assert.equal(t.storage.keys('family:').length, 0, 'the authority was removed despite the failed read');
  assert.ok(t.storage.keys('at:').length > 0, 'unreadable metadata leaves inert hashes for the sweep');
  t.storage.get = originalGet;

  assert.equal((await mcp(t, tokens.access_token, toolsCall())).status, 401);
  const refresh = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
  });
  assert.equal(refresh.status, 400);
  await t.relay.grants.sweep();
  assert.equal(t.storage.keys('at:').length + t.storage.keys('rt:').length, 0,
    'a later sweep removes the orphan hashes');
});

test('failed cleanup after code replay cannot revive orphan access tokens after restart', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const queued = mcp(t, tokens.access_token, toolsCall('queued-code-replay'));
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  const deleteKey = t.storage.delete.bind(t.storage);
  t.storage.delete = async (key) => {
    if (key.startsWith('at:')) throw new Error('cleanup interrupted after family deletion');
    return deleteKey(key);
  };

  const replay = await tokenPost(t, codeExchange(tokens));
  assert.equal(replay.status, 500);
  assert.equal((await promptly(queued)).status, 403, 'queued work is withdrawn');
  assert.equal(t.storage.keys('family:').length, 0, 'revocation commit survived cleanup failure');
  assert.equal(t.storage.keys('at:').length, 1, 'an orphan access record remains for the regression');
  assert.equal(t.storage.keys('rt:').length, 1, 'an orphan refresh record remains for the regression');
  t.storage.delete = deleteKey;

  t.relay = new Relay({ storage: t.storage, env: t.env, now: t.clock.now, timers: t.clock.api });
  assert.equal(await t.relay.grants.lookupAccess(tokens.access_token), null);
  assert.equal((await t.relay.grants.liveClientIds()).size, 0);
  assert.equal((await mcp(t, tokens.access_token, toolsCall())).status, 401);
  const refresh = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
  });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json()).error, 'invalid_grant');
  assert.equal(t.storage.keys('at:').length + t.storage.keys('rt:').length, 0,
    'the next sweep cleans up orphan token records');
  const again = await tokenPost(t, codeExchange(tokens));
  assert.equal(again.status, 400);
  assert.match((await again.json()).error_description, /grant is no longer active/);
});

test('code reuse settles a command already delivered from its grant as unknown', async () => {
  const t = makeRelay();
  const grant = await obtainCode(t);
  const tokens = await (await tokenPost(t, codeExchange(grant))).json();
  const waitingPoll = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = mcp(t, tokens.access_token, toolsCall('replayed-code'));
  const [command] = (await (await waitingPoll).json()).commands;

  assert.equal((await tokenPost(t, codeExchange(grant))).status, 400);
  const result = await promptly(answer);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).error.data.droidbridge_relay, {
    state: 'settlement_unknown', delivered: true, retried: false,
  });
  assert.equal((await respond(t, command)).status, 404);
});

test('a replayed code revokes its grant whatever client_id, redirect_uri or code_verifier comes with it', async () => {
  // Each of these alone would be refused before the code is looked at (401 invalid_client or
  // 400 invalid_request); a replay must still revoke, as a replayed refresh token does.
  /** @type {Record<string, string>[]} */
  const variants = [
    { client_id: 'nobody-here' },
    { client_id: '' },
    { code_verifier: 'x'.repeat(10) },
    { code_verifier: '' },
    { redirect_uri: '' },
    { redirect_uri: 'https://claude.com/api/mcp/auth_callback' },
    { resource: 'https://other.example/mcp' },
  ];
  for (const overrides of variants) {
    const label = JSON.stringify(overrides);
    const t = makeRelay();
    const grant = await obtainCode(t);
    const first = await tokenPost(t, codeExchange(grant));
    assert.equal(first.status, 200);
    const tokens = await first.json();
    assert.ok(await tokenWorks(t, tokens.access_token), label);
    const replay = await tokenPost(t, codeExchange(grant, overrides));
    assert.equal(replay.status, 400, label);
    const error = await replay.json();
    assert.equal(error.error, 'invalid_grant', label);
    assert.match(error.error_description, /already used\. Tokens issued from it were revoked/, label);
    assert.equal(await tokenWorks(t, tokens.access_token), false, `${label}: the grant is revoked`);
    const refresh = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: grant.clientId });
    assert.equal(refresh.status, 400, label);
    assert.equal(t.storage.keys('family:').length, 0, label);
  }
  // A code that was never redeemed is not consumed by a request refused for those reasons.
  const t = makeRelay();
  const grant = await obtainCode(t);
  assert.equal((await tokenPost(t, codeExchange(grant, { client_id: 'nobody-here' }))).status, 401);
  assert.equal((await tokenPost(t, codeExchange(grant, { code_verifier: 'x' }))).status, 400);
  assert.equal((await tokenPost(t, codeExchange(grant))).status, 200);
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

test('failed cleanup after refresh replay cannot revive orphan refresh tokens after restart', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const rotated = await (await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
  })).json();
  const waitingPoll = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const delivered = mcp(t, rotated.access_token, toolsCall('delivered-refresh-replay'));
  const [command] = (await (await waitingPoll).json()).commands;
  const deleteKey = t.storage.delete.bind(t.storage);
  t.storage.delete = async (key) => {
    if (key.startsWith('rt:')) throw new Error('cleanup interrupted after family deletion');
    return deleteKey(key);
  };

  const replay = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
  });
  assert.equal(replay.status, 500);
  const answer = await promptly(delivered);
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).error.data.droidbridge_relay, {
    state: 'settlement_unknown', delivered: true, retried: false,
  });
  assert.equal((await respond(t, command)).status, 404);
  assert.equal(t.storage.keys('family:').length, 0);
  assert.ok(t.storage.keys('rt:').length > 0, 'orphan refresh records remain for the regression');
  t.storage.delete = deleteKey;

  t.relay = new Relay({ storage: t.storage, env: t.env, now: t.clock.now, timers: t.clock.api });
  assert.equal((await t.relay.grants.liveClientIds()).size, 0);
  assert.equal((await mcp(t, rotated.access_token, toolsCall())).status, 401);
  const current = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: tokens.clientId,
  });
  assert.equal(current.status, 400);
  assert.equal((await current.json()).error, 'invalid_grant');
  const again = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error_description, 'The refresh token is not valid.');
});

test('refresh replay commits revocation before a selective token-record read can fail', async () => {
  for (const prefix of ['at:', 'rt:']) {
    const t = makeRelay();
    const tokens = await obtainTokens(t);
    const rotated = await (await tokenPost(t, {
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
    })).json();
    assert.equal((await poll(t, 0)).status, 204);
    const queued = mcp(t, rotated.access_token, toolsCall(`refresh-read-error-${prefix}`));
    await waitFor(() => t.relay.hub.inspect().handoff === 1);
    const originalGet = t.storage.get.bind(t.storage);
    const currentRefreshKey = `rt:${sha256HexSync(rotated.refresh_token)}`;
    t.storage.get = async (key) => {
      if (key.startsWith('at:') || (prefix === 'rt:' && key === currentRefreshKey)) {
        throw new Error('selective token-count read failure');
      }
      return originalGet(key);
    };

    const replay = await tokenPost(t, {
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId,
    });
    assert.equal(replay.status, 400, prefix);
    assert.equal((await replay.json()).error, 'invalid_grant', prefix);
    assert.equal((await promptly(queued)).status, 403, prefix);
    assert.equal(t.storage.keys('family:').length, 0, prefix);
    t.storage.get = originalGet;
    assert.equal((await mcp(t, rotated.access_token, toolsCall())).status, 401, prefix);
    const later = await tokenPost(t, {
      grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: tokens.clientId,
    });
    assert.equal(later.status, 400, prefix);
  }
});

test('a replayed refresh token withdraws only its family\'s queued commands', async () => {
  const t = makeRelay();
  const first = await obtainTokens(t);
  const second = await obtainTokens(t, { pairingCode: 'QQQQ2222' });
  const rotated = await (
    await tokenPost(t, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId })
  ).json();
  assert.equal((await poll(t, 0)).status, 204);
  const firstAnswer = mcp(t, rotated.access_token, toolsCall('revoked-family'));
  const secondAnswer = mcp(t, second.access_token, toolsCall('other-family'));
  await waitFor(() => t.relay.hub.inspect().handoff === 2);

  const replay = await tokenPost(t, {
    grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId,
  });
  assert.equal(replay.status, 400);
  const withdrawn = await promptly(firstAnswer);
  assert.equal(withdrawn.status, 403);
  assert.equal((await withdrawn.json()).error.data.droidbridge_relay.delivered, false);
  assert.equal(t.relay.hub.inspect().handoff, 1);
  const [command] = (await (await poll(t, 0)).json()).commands;
  assert.equal(command.jsonrpc.id, 'other-family');
  assert.equal((await respond(t, command)).status, 200);
  assert.equal((await secondAnswer).status, 200);
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

test('a replayed refresh token revokes whatever scope comes with it, or with no client_id at all', async () => {
  /** @type {[string, Record<string, string>][]} */
  const variants = [
    ['another scope', { scope: 'other' }],
    ['no client_id', { client_id: '' }],
    ['no client_id, another scope', { client_id: '', scope: 'droidbridge admin' }],
  ];
  for (const [label, overrides] of variants) {
    const t = makeRelay();
    const tokens = await obtainTokens(t);
    const rotated = await (
      await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId })
    ).json();
    assert.ok(await tokenWorks(t, rotated.access_token), label);
    /** @type {Record<string, string>} */
    const form = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId, ...overrides };
    if (form.client_id === '') delete form.client_id;
    const replay = await tokenPost(t, form);
    assert.equal(replay.status, 400, label);
    assert.equal((await replay.json()).error_description, 'The refresh token was already used. The grant was revoked.', label);
    assert.equal(await tokenWorks(t, rotated.access_token), false, `${label}: the grant is revoked`);
    assert.equal(t.storage.keys('family:').length, 0, label);
  }

  // The same parameters with a live, unused refresh token are refused and do not use it up.
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const noClient = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.equal(noClient.status, 400);
  assert.equal((await noClient.json()).error, 'invalid_request');
  const otherScope = await tokenPost(t, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.clientId,
    scope: 'other',
  });
  assert.equal(otherScope.status, 400);
  assert.equal((await otherScope.json()).error, 'invalid_scope');
  assert.ok(await tokenWorks(t, tokens.access_token));
  const refreshed = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
  assert.equal(refreshed.status, 200);
});

test('a malformed token request is refused before its code or refresh token is looked at, and revokes nothing', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const rotated = await (
    await tokenPost(t, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId })
  ).json();
  /** @param {string} type @param {string} body */
  const post = (type, body) =>
    t.relay.fetch(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { 'content-type': type }, body }));
  const form = 'application/x-www-form-urlencoded';
  const code = `grant_type=authorization_code&code=${tokens.code}`;
  const refresh = `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`;
  for (const [type, body] of [
    [form, `${code}&client_id=${tokens.clientId}&client_id=x`],
    [form, `${code}&code=${tokens.code}`],
    ['application/json', JSON.stringify({ grant_type: 'authorization_code', code: tokens.code })],
    [form, `${refresh}&client_id=${tokens.clientId}&client_id=x`],
    [form, `${refresh}&grant_type=refresh_token`],
    ['text/plain', refresh],
  ]) {
    const res = await post(type, body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error, 'invalid_request', body);
    assert.ok(await tokenWorks(t, rotated.access_token), `${body}: nothing revoked`);
  }
  // Well formed, the same replays revoke.
  const replay = await post(form, refresh);
  assert.equal((await replay.json()).error_description, 'The refresh token was already used. The grant was revoked.');
  assert.equal(await tokenWorks(t, rotated.access_token), false);
});

test('each family keeps the hashes of exactly its last 8 access and 16 refresh tokens', async () => {
  const t = makeRelay();
  const first = await obtainTokens(t);
  const access = [first.access_token];
  const refresh = [first.refresh_token];
  for (let i = 0; i < 19; i += 1) {
    const res = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: refresh.at(-1), client_id: first.clientId });
    assert.equal(res.status, 200);
    const tokens = await res.json();
    access.push(tokens.access_token);
    refresh.push(tokens.refresh_token);
  }
  assert.equal(t.storage.keys('at:').length, 8);
  assert.equal(t.storage.keys('rt:').length, 16);
  // The newest 8 access tokens still work (none has expired); the one before them is gone.
  for (const [i, token] of access.entries()) {
    assert.equal(await tokenWorks(t, token), i >= access.length - 8, `access token ${i}`);
  }
  for (const [i, token] of refresh.entries()) {
    const kept = (await t.storage.get(`rt:${sha256HexSync(token)}`)) !== undefined;
    assert.equal(kept, i >= refresh.length - 16, `refresh token ${i}`);
  }
});

test('an expired refresh token gets the same answer however often it comes, and claims no use', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const day = 24 * 60 * 60 * 1000;
  /** @param {string} token */
  const refresh = async (token) => {
    const res = await tokenPost(t, { grant_type: 'refresh_token', refresh_token: token, client_id: tokens.clientId });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_grant');
    return body.error_description;
  };
  // A sweep runs 30 s before the grant expires, so the next one is due only after it expired.
  await t.clock.advance(30 * day - 30_000);
  await refresh('garbage');
  await t.clock.advance(31_000);
  assert.equal(t.storage.keys('family:').length, 1, 'the expired grant is not swept yet');

  // Never used, now expired: the same answer every time, never "already used".
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await refresh(tokens.refresh_token), 'The refresh token has expired.');
  }
  // Once the sweep has purged the grant the token is simply unknown.
  await t.clock.advance(60_000);
  assert.equal(await refresh(tokens.refresh_token), 'The refresh token is not valid.');
  assert.equal(t.storage.keys('family:').length + t.storage.keys('rt:').length, 0);
});

test('a rotated refresh token that comes back after its grant expired revokes nothing and claims no revocation', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  const day = 24 * 60 * 60 * 1000;
  /** @param {string} token */
  const refresh = (token) =>
    tokenPost(t, { grant_type: 'refresh_token', refresh_token: token, client_id: tokens.clientId });
  const rotated = await (await refresh(tokens.refresh_token)).json();
  assert.ok(rotated.refresh_token);
  await t.clock.advance(30 * day - 30_000);
  await refresh('garbage'); // runs the sweep
  await t.clock.advance(31_000);

  const replay = await refresh(tokens.refresh_token);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error_description, 'The refresh token is not valid.');
  assert.equal(t.storage.keys('family:').length, 1, 'nothing revoked; the sweep purges it');
  const latest = await refresh(rotated.refresh_token);
  assert.equal((await latest.json()).error_description, 'The refresh token has expired.');

  // While the grant is live, the same replay revokes it (see the tests above).
  const live = makeRelay();
  const liveTokens = await obtainTokens(live);
  const liveRotated = await (
    await tokenPost(live, { grant_type: 'refresh_token', refresh_token: liveTokens.refresh_token, client_id: liveTokens.clientId })
  ).json();
  await live.clock.advance(30 * day - 1000);
  const liveReplay = await tokenPost(live, {
    grant_type: 'refresh_token',
    refresh_token: liveTokens.refresh_token,
    client_id: liveTokens.clientId,
  });
  assert.equal((await liveReplay.json()).error_description, 'The refresh token was already used. The grant was revoked.');
  assert.equal(live.storage.keys('family:').length, 0);
  const afterRevoke = await tokenPost(live, {
    grant_type: 'refresh_token',
    refresh_token: liveRotated.refresh_token,
    client_id: liveTokens.clientId,
  });
  assert.equal(afterRevoke.status, 400);
});
