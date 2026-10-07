// @ts-check
// Client ID metadata documents (CIMD) and the redirect policy.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cimdUrlProblem, parseExtraRedirectUris, redirectUriAllowed } from '../src/oauth.js';
import { cspOrigin } from '../src/pages.js';
import {
  CLAUDE_CALLBACK,
  authorizeGet,
  makeRelay,
  pair,
  pkcePair,
  register,
  requestIdFrom,
  tokenPost,
  authorizePost,
} from './helpers.js';

const CIMD_URL = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

/** @param {unknown} doc @param {Record<string, string>} [headers] @param {number} [status] */
function documentFetch(doc, headers = {}, status = 200) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetchFn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    const body = typeof doc === 'string' ? doc : JSON.stringify(doc);
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetchFn, calls };
}

function cimdParams(clientId = CIMD_URL, redirectUri = CLAUDE_CALLBACK) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    state: 'st',
  };
}

test('CIMD: an allowed host is fetched safely, shown, cached, and can complete the flow', async () => {
  const { fetchFn, calls } = documentFetch({
    client_id: CIMD_URL,
    client_name: 'Claude',
    redirect_uris: [CLAUDE_CALLBACK],
    token_endpoint_auth_method: 'none',
  });
  const t = makeRelay({ fetchFn });
  const { verifier, challenge } = pkcePair();
  const page = await authorizeGet(t, { ...cimdParams(), code_challenge: challenge });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Allow Claude to use DroidBridge\?/);
  assert.match(html, /Identity document published by claude\.ai/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CIMD_URL);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  // Cached: a second authorization does not fetch again.
  assert.equal((await authorizeGet(t, cimdParams())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(t.storage.keys('cimd:').length, 1);

  // And the cache expires within the hour.
  await t.clock.advance(60 * 60 * 1000 + 1);
  assert.equal((await authorizeGet(t, cimdParams())).status, 200);
  assert.equal(calls.length, 2);

  // The CIMD client can finish the flow.
  await pair(t, 'ZZZZ1111');
  const done = await authorizePost(t, { request_id: requestIdFrom(html), pairing_code: 'zzzz-1111', action: 'allow' });
  // The first consent page expired after the clock moved an hour, so start a fresh one.
  assert.equal(done.status, 400);
  const fresh = await authorizeGet(t, { ...cimdParams(), code_challenge: challenge });
  const allowed = await authorizePost(t, {
    request_id: requestIdFrom(await fresh.text()),
    pairing_code: 'zzzz-1111',
    action: 'allow',
  });
  assert.equal(allowed.status, 302);
  const code = new URL(/** @type {string} */ (allowed.headers.get('location'))).searchParams.get('code');
  const tokens = await tokenPost(t, {
    grant_type: 'authorization_code',
    code: /** @type {string} */ (code),
    redirect_uri: CLAUDE_CALLBACK,
    client_id: CIMD_URL,
    code_verifier: verifier,
  });
  assert.equal(tokens.status, 200);
});

test('CIMD: a disallowed host is refused without fetching', async () => {
  const t = makeRelay();
  for (const clientId of [
    'https://evil.example/client.json',
    'https://claude.ai.evil.example/client.json',
    'http://claude.ai/oauth/client',
    'https://claude.ai:8443/oauth/client',
    'https://user@claude.ai/oauth/client',
    'https://claude.ai/',
    'https://claude.ai/oauth/client#frag',
    'https://CLAUDE.ai/oauth/client',
    'https://claude.ai/a/../oauth/client',
  ]) {
    const res = await authorizeGet(t, cimdParams(clientId));
    assert.equal(res.status, 400, clientId);
    assert.equal(res.headers.get('location'), null, `${clientId} is never redirected to`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  }
  assert.equal(t.fetchCalls.length, 0);
});

test('CIMD: a document whose client_id differs is refused', async () => {
  const { fetchFn, calls } = documentFetch({
    client_id: 'https://claude.ai/some/other/client',
    client_name: 'Claude',
    redirect_uris: [CLAUDE_CALLBACK],
  });
  const t = makeRelay({ fetchFn });
  const res = await authorizeGet(t, cimdParams());
  assert.equal(res.status, 400);
  assert.match(await res.text(), /could not be loaded or is not valid/);
  assert.equal(calls.length, 1);
  assert.equal(t.storage.keys('cimd:').length, 0);
});

test('CIMD: a redirect_uri the document does not list is refused with a page', async () => {
  const { fetchFn } = documentFetch({
    client_id: CIMD_URL,
    redirect_uris: ['https://claude.com/api/mcp/auth_callback'],
  });
  const t = makeRelay({ fetchFn });
  const res = await authorizeGet(t, cimdParams(CIMD_URL, CLAUDE_CALLBACK));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /Redirect not allowed/);
});

test('CIMD: an unnamed client is shown as "Unnamed client"', async () => {
  const { fetchFn } = documentFetch({ client_id: CIMD_URL, redirect_uris: [CLAUDE_CALLBACK] });
  const t = makeRelay({ fetchFn });
  const res = await authorizeGet(t, cimdParams());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Unnamed client/);
});

test('CIMD: redirects, errors, oversize and malformed documents are refused', async () => {
  const cases = [
    { name: 'redirect', fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) },
    { name: 'not found', fetch: async () => new Response('nope', { status: 404 }) },
    { name: 'network error', fetch: async () => { throw new TypeError('network'); } },
    {
      name: 'too large',
      fetch: async () =>
        new Response(JSON.stringify({ client_id: CIMD_URL, redirect_uris: [CLAUDE_CALLBACK], pad: 'x'.repeat(17000) })),
    },
    { name: 'not json', fetch: async () => new Response('<html>') },
    { name: 'array', fetch: async () => new Response('[]') },
    { name: 'no redirect_uris', fetch: async () => new Response(JSON.stringify({ client_id: CIMD_URL })) },
    {
      name: 'bad name',
      fetch: async () => new Response(JSON.stringify({ client_id: CIMD_URL, client_name: 5, redirect_uris: [CLAUDE_CALLBACK] })),
    },
  ];
  for (const { name, fetch } of cases) {
    const t = makeRelay({ fetchFn: fetch });
    const res = await authorizeGet(t, cimdParams());
    assert.equal(res.status, 400, name);
    assert.equal(res.headers.get('location'), null, name);
  }
});

test('CIMD: Cache-Control no-store is honoured', async () => {
  const { fetchFn, calls } = documentFetch(
    { client_id: CIMD_URL, redirect_uris: [CLAUDE_CALLBACK] },
    { 'cache-control': 'no-store' },
  );
  const t = makeRelay({ fetchFn });
  assert.equal((await authorizeGet(t, cimdParams())).status, 200);
  assert.equal((await authorizeGet(t, cimdParams())).status, 200);
  assert.equal(calls.length, 2);
});

test('CIMD: an empty CIMD_ALLOWED_HOSTS disables URL client ids', async () => {
  const t = makeRelay({ env: { CIMD_ALLOWED_HOSTS: '' } });
  assert.equal((await authorizeGet(t, cimdParams())).status, 400);
  assert.equal(t.fetchCalls.length, 0);
});

const HOSTILE_REDIRECTS = [
  'https://evil.example/callback',
  'http://localhost.evil.com/callback',
  'javascript:alert(1)',
  'http://localhost:0/callback',
  'http://localhost:65536/callback',
  'http://localhost:080/callback',
  'http://localhost/callback',
  'http://localhost:3000/callback/../../evil',
  'http://localhost:3000/callback?next=https://evil.example',
  'http://localhost:3000/other',
  'https://localhost:3000/callback',
  'http://[::1]:3000/callback',
  'https://claude.ai/api/mcp/auth_callback/',
  'https://claude.ai/api/mcp/auth_callback?x=1',
  'https://claude.ai.evil.example/api/mcp/auth_callback',
  'HTTPS://claude.ai/api/mcp/auth_callback',
  'https://claude.ai@evil.example/api/mcp/auth_callback',
  'data:text/html,hi',
];

test('redirect policy: open-redirect attempts are rejected at /register', async () => {
  const t = makeRelay();
  for (const uri of HOSTILE_REDIRECTS) {
    const res = await register(t, { redirect_uris: [uri] });
    assert.equal(res.status, 400, uri);
    assert.equal((await res.json()).error, 'invalid_redirect_uri', uri);
  }
  // One bad URI among good ones still fails.
  const mixed = await register(t, { redirect_uris: [CLAUDE_CALLBACK, 'https://evil.example/callback'] });
  assert.equal(mixed.status, 400);
  assert.equal(t.storage.keys('client:').length, 0);
});

test('redirect policy: unregistered or disallowed redirect_uri at /authorize is a page, never a redirect', async () => {
  const t = makeRelay({ env: { EXTRA_REDIRECT_URIS: '' } });
  const client = await (await register(t, { redirect_uris: [CLAUDE_CALLBACK, 'http://localhost:4711/callback'] })).json();
  for (const uri of HOSTILE_REDIRECTS) {
    const res = await authorizeGet(t, cimdParams(client.client_id, uri));
    assert.equal(res.status, 400, uri);
    assert.equal(res.headers.get('location'), null, uri);
  }
  // Registered loopback on another port than requested: not registered, refused.
  const other = await authorizeGet(t, cimdParams(client.client_id, 'http://localhost:4712/callback'));
  assert.equal(other.status, 400);
  // Policy re-check: a stored client whose redirect later stops passing the policy is refused.
  const stored = await t.storage.get(`client:${client.client_id}`);
  await t.storage.put(`client:${client.client_id}`, { ...stored, redirect_uris: ['https://evil.example/callback'] });
  const tampered = await authorizeGet(t, cimdParams(client.client_id, 'https://evil.example/callback'));
  assert.equal(tampered.status, 400);
  assert.equal(tampered.headers.get('location'), null);
});

test('redirect policy: loopback callbacks on any port are allowed', async () => {
  const t = makeRelay();
  const uris = ['http://localhost:1/callback', 'http://127.0.0.1:65535/callback', 'http://localhost:33418/callback'];
  const res = await register(t, { redirect_uris: uris });
  assert.equal(res.status, 201);
  const client = await res.json();
  for (const uri of uris) {
    const page = await authorizeGet(t, cimdParams(client.client_id, uri));
    assert.equal(page.status, 200, uri);
    const port = new URL(uri).port;
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      new RegExp(`form-action 'self' http://(localhost|127\\.0\\.0\\.1):${port};`),
    );
  }
});

test('redirect policy: EXTRA_REDIRECT_URIS allows exact extra URIs only', async () => {
  const t = makeRelay({
    env: { EXTRA_REDIRECT_URIS: 'https://inspector.example/oauth/callback, javascript:alert(1) ftp://x.example/cb' },
  });
  assert.deepEqual(t.relay.config.extraRedirectUris, ['https://inspector.example/oauth/callback']);
  assert.equal((await register(t, { redirect_uris: ['https://inspector.example/oauth/callback'] })).status, 201);
  assert.equal((await register(t, { redirect_uris: ['https://inspector.example/oauth/callback2'] })).status, 400);
  assert.equal((await register(t, { redirect_uris: ['javascript:alert(1)'] })).status, 400);
});

test('redirect policy: EXTRA_REDIRECT_URIS keeps only URIs whose origin the consent page CSP can name', async () => {
  const t = makeRelay({
    env: {
      EXTRA_REDIRECT_URIS:
        'http://[::1]:8080/callback https://[2001:db8::1]/cb https://a_b.example/cb http://192.168.1.5/cb ' +
        'https://inspector.example:8443/oauth/callback http://127.0.0.1:9000/cb',
    },
  });
  assert.deepEqual(t.relay.config.extraRedirectUris, [
    'https://inspector.example:8443/oauth/callback',
    'http://127.0.0.1:9000/cb',
  ]);
  // A URI the browser could never be redirected to after the consent form is refused up front.
  for (const uri of ['http://[::1]:8080/callback', 'https://[2001:db8::1]/cb', 'https://a_b.example/cb']) {
    const res = await register(t, { redirect_uris: [uri] });
    assert.equal(res.status, 400, uri);
    assert.equal((await res.json()).error, 'invalid_redirect_uri', uri);
  }
  // Every accepted one gets its origin into form-action.
  for (const uri of t.relay.config.extraRedirectUris) {
    const client = await (await register(t, { redirect_uris: [uri] })).json();
    const page = await authorizeGet(t, cimdParams(client.client_id, uri));
    assert.equal(page.status, 200, uri);
    assert.match(page.headers.get('content-security-policy') ?? '', new RegExp(`form-action 'self' ${new URL(uri).origin};`));
  }
  assert.equal(cspOrigin('http://[::1]:8080'), null);
  assert.equal(cspOrigin('https://a.example:8443'), 'https://a.example:8443');
  assert.equal(cspOrigin(undefined), null);
});

test('redirect policy unit checks', () => {
  assert.ok(redirectUriAllowed(CLAUDE_CALLBACK, []));
  assert.ok(redirectUriAllowed('https://claude.com/api/mcp/auth_callback', []));
  assert.ok(redirectUriAllowed('http://127.0.0.1:8080/callback', []));
  for (const uri of HOSTILE_REDIRECTS) assert.equal(redirectUriAllowed(uri, []), false, uri);
  assert.equal(redirectUriAllowed(42, []), false);
  assert.deepEqual(parseExtraRedirectUris('http://localhost:9/cb,https://a.example/x#f'), ['http://localhost:9/cb']);
  assert.equal(cimdUrlProblem(CIMD_URL, ['claude.ai']), null);
  assert.notEqual(cimdUrlProblem(CIMD_URL, ['claude.com']), null);
});

test('/authorize errors after the client is trusted go back to the redirect_uri', async () => {
  const t = makeRelay();
  const client = await (await register(t)).json();
  const base = cimdParams(client.client_id);
  /** @param {Record<string, string | undefined>} overrides */
  const errorOf = async (overrides) => {
    const res = await authorizeGet(t, { ...base, ...overrides });
    assert.equal(res.status, 302);
    const location = new URL(/** @type {string} */ (res.headers.get('location')));
    assert.equal(`${location.origin}${location.pathname}`, CLAUDE_CALLBACK);
    assert.equal(location.searchParams.get('iss'), 'https://relay.example');
    assert.equal(location.searchParams.get('state'), 'st');
    assert.ok(location.searchParams.get('error_description'));
    return location.searchParams.get('error');
  };
  assert.equal(await errorOf({ response_type: 'token' }), 'unsupported_response_type');
  assert.equal(await errorOf({ code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge_method: undefined }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge: 'short' }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge: `${'a'.repeat(42)}!` }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge: 'a'.repeat(129) }), 'invalid_request');
  assert.equal(await errorOf({ scope: 'droidbridge admin' }), 'invalid_scope');
  assert.equal(await errorOf({ scope: 'openid' }), 'invalid_scope');
  assert.equal(await errorOf({ resource: 'https://other.example/mcp' }), 'invalid_target');
  assert.equal(await errorOf({ resource: 'https://relay.example/mcp/other' }), 'invalid_target');
  // Accepted resource spellings: case of scheme/host, one trailing slash, default port.
  for (const resource of ['HTTPS://Relay.Example/mcp', 'https://relay.example/mcp/', 'https://relay.example:443/mcp']) {
    assert.equal((await authorizeGet(t, { ...base, resource })).status, 200, resource);
  }
  // Repeated parameters: an error page, not a redirect.
  const repeated = await t.relay.fetch(
    new Request(`https://relay.example/authorize?client_id=${client.client_id}&client_id=x&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}`),
  );
  assert.equal(repeated.status, 400);
  assert.equal(repeated.headers.get('location'), null);
  // Unknown DCR client: an error page.
  const unknown = await authorizeGet(t, { ...base, client_id: 'dbrcl_AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('location'), null);
});

test('/register validation, rate limit and client cap', async () => {
  const t = makeRelay();
  const bad = [
    [{ token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ redirect_uris: 'https://claude.ai/api/mcp/auth_callback' }, 'invalid_redirect_uri'],
    [{ grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
    [{ response_types: ['token'] }, 'invalid_client_metadata'],
    [{ client_name: 'x'.repeat(201) }, 'invalid_client_metadata'],
    [{ client_name: 'Claude‮' }, 'invalid_client_metadata'],
  ];
  for (const [metadata, error] of bad) {
    const res = await register(t, /** @type {Record<string, unknown>} */ (metadata));
    assert.equal(res.status, 400, JSON.stringify(metadata));
    assert.equal((await res.json()).error, error);
  }
  const wrongType = await t.relay.fetch(
    new Request('https://relay.example/register', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
  );
  assert.equal(wrongType.status, 400);
  const big = await register(t, { pad: 'x'.repeat(17 * 1024) });
  assert.equal(big.status, 413);

  // 20 registrations per hour.
  for (let i = 0; i < 20; i += 1) assert.equal((await register(t)).status, 201);
  const limited = await register(t);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  await t.clock.advance(60 * 60 * 1000 + 1);
  assert.equal((await register(t)).status, 201);
});

test('/register evicts the oldest client without live tokens at 100 clients', async () => {
  const t = makeRelay();
  // Seed 100 stored clients directly (the hourly rate limit would otherwise take 5 hours).
  for (let i = 0; i < 100; i += 1) {
    const id = `dbrcl_${String(i).padStart(22, '0')}`;
    await t.storage.put(`client:${id}`, {
      client_id: id,
      redirect_uris: [CLAUDE_CALLBACK],
      created_ms: t.clock.now() + i,
    });
  }
  // Client 0 holds a live token, so client 1 is the oldest evictable one.
  await t.storage.put('at:feed', { family: 'f', client_id: 'dbrcl_0000000000000000000000', resource: 'x', scope: 'droidbridge', expiresAt: t.clock.now() + 1000 });
  const res = await register(t);
  assert.equal(res.status, 201);
  assert.equal(t.storage.keys('client:').length, 100);
  assert.ok(await t.storage.get('client:dbrcl_0000000000000000000000'));
  assert.equal(await t.storage.get('client:dbrcl_0000000000000000000001'), undefined);

  // When every stored client has live tokens, registration is refused.
  for (const key of t.storage.keys('client:')) {
    const id = key.slice('client:'.length);
    await t.storage.put(`at:${id}`, { family: 'f', client_id: id, resource: 'x', scope: 'droidbridge', expiresAt: t.clock.now() + 1000 });
  }
  const full = await register(t);
  assert.equal(full.status, 400);
  assert.equal((await full.json()).error, 'invalid_client_metadata');
});

test('CIMD: the document cache holds at most 20 entries', async () => {
  const fetchFn = async (/** @type {string} */ url) =>
    new Response(JSON.stringify({ client_id: url, redirect_uris: [CLAUDE_CALLBACK] }));
  const t = makeRelay({ fetchFn });
  for (let i = 0; i < 25; i += 1) {
    const res = await authorizeGet(t, cimdParams(`https://claude.ai/clients/${i}`));
    assert.equal(res.status, 200);
    await t.clock.advance(1000);
  }
  assert.equal(t.storage.keys('cimd:').length, 20);
});
