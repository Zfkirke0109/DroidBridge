// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_CALLBACK,
  ORIGIN,
  authorizeGet,
  authorizePost,
  makeRelay,
  mcp,
  obtainTokens,
  pair,
  pkcePair,
  poll,
  register,
  requestIdFrom,
  respond,
  tokenPost,
  waitFor,
} from './helpers.js';

test('happy path: register, consent with pairing code, PKCE token, MCP round trip', async () => {
  const t = makeRelay();

  // Dynamic client registration with a hostile name.
  const reg = await register(t, { client_name: '<script>alert(1)</script>"&\'' });
  assert.equal(reg.status, 201);
  assert.equal(reg.headers.get('cache-control'), 'no-store');
  const client = await reg.json();
  assert.match(client.client_id, /^dbrcl_[A-Za-z0-9_-]{22}$/);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.deepEqual(client.redirect_uris, [CLAUDE_CALLBACK]);
  assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(client.response_types, ['code']);
  assert.equal(typeof client.client_id_issued_at, 'number');

  // GET /authorize renders the consent page.
  const { verifier, challenge } = pkcePair();
  const page = await authorizeGet(t, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz-state',
    scope: 'droidbridge',
    resource: `${ORIGIN}/mcp`,
  });
  assert.equal(page.status, 200);
  assert.equal(
    page.headers.get('content-security-policy'),
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.ok(!html.includes('<script>'), 'client name is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;'));
  assert.ok(html.includes('claude.ai'), 'names the redirect host');
  assert.ok(html.includes('control this phone through DroidBridge with the permissions you granted on the device'));
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /inputmode="text"/);
  assert.match(html, /autocapitalize="characters"/);
  assert.match(html, /<form method="post" action="\/authorize">/);
  const requestId = requestIdFrom(html);

  // The phone shows K7QM-2XPA and posts only its hash.
  const pairing = await pair(t, 'K7QM2XPA', 300);
  assert.equal(pairing.expires_at, new Date(t.clock.now() + 300_000).toISOString());
  assert.ok(![...t.storage.map.values()].some((value) => JSON.stringify(value).includes('K7QM2XPA')));

  // The user types the code in lowercase with the dash.
  const allowed = await authorizePost(t, { request_id: requestId, pairing_code: 'k7qm-2xpa', action: 'allow' });
  assert.equal(allowed.status, 302);
  const location = new URL(/** @type {string} */ (allowed.headers.get('location')));
  assert.equal(`${location.origin}${location.pathname}`, CLAUDE_CALLBACK);
  assert.equal(location.searchParams.get('state'), 'xyz-state');
  assert.equal(location.searchParams.get('iss'), ORIGIN);
  const code = /** @type {string} */ (location.searchParams.get('code'));
  assert.match(code, /^dbrc_[A-Za-z0-9_-]{43}$/);
  // Pairing and pending request are consumed; only hashes are stored.
  assert.equal(await t.storage.get('pairing'), undefined);
  assert.equal(t.storage.keys('pending:').length, 0);
  assert.ok(!t.storage.keys('').some((key) => key.includes(code)));

  // Token exchange with PKCE.
  const tokenRes = await tokenPost(t, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  });
  assert.equal(tokenRes.status, 200);
  assert.equal(tokenRes.headers.get('cache-control'), 'no-store');
  assert.equal(tokenRes.headers.get('pragma'), 'no-cache');
  const tokens = await tokenRes.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, 'droidbridge');
  assert.match(tokens.access_token, /^dbra_[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^dbrr_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify([...t.storage.map.entries()]);
  assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), 'tokens are hashed');
  assert.ok(!stored.includes(t.device.key));

  // The phone is parked on a poll.
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);

  // Claude calls a tool, with headers that must not reach the phone.
  const message = { jsonrpc: '2.0', id: 'rpc-7', method: 'tools/call', params: { name: 'command', arguments: { argv: ['id'] } } };
  const mcpPromise = mcp(t, tokens.access_token, message, {
    headers: {
      cookie: 'session=abc',
      'mcp-session-id': 'sess-1',
      'mcp-method': 'tools/call',
      'mcp-name': 'command',
      'x-forwarded-for': '203.0.113.9',
    },
  });

  const pollRes = await pollPromise;
  assert.equal(pollRes.status, 200);
  const { commands } = await pollRes.json();
  assert.equal(commands.length, 1);
  const [command] = commands;
  assert.equal(command.command_type, 'jsonrpc');
  assert.match(command.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(command.shard_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(command.channel, 'main');
  assert.equal(command.created_at, new Date(t.clock.now()).toISOString());
  assert.equal(command.response_timeout, '240s');
  assert.deepEqual(command.jsonrpc, message);
  assert.deepEqual(command.headers, {
    'Content-Type': ['application/json'],
    Accept: ['application/json, text/event-stream'],
    'MCP-Protocol-Version': ['2026-07-28'],
    'Mcp-Method': ['tools/call'],
    'Mcp-Name': ['command'],
  });
  const forwarded = JSON.stringify(command).toLowerCase();
  for (const leaked of ['authorization', 'cookie', 'mcp-session-id', 'x-forwarded-for', tokens.access_token.toLowerCase()]) {
    assert.ok(!forwarded.includes(leaked), `${leaked} is not forwarded`);
  }

  // The phone answers.
  const ack = await respond(t, command, {
    resp_json: { jsonrpc: '2.0', id: 'rpc-7', result: { content: [{ type: 'text', text: 'uid=0' }] } },
  });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), {});

  const answer = await mcpPromise;
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'application/json');
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get('mcp-session-id'), null);
  assert.deepEqual(await answer.json(), {
    jsonrpc: '2.0',
    id: 'rpc-7',
    result: { content: [{ type: 'text', text: 'uid=0' }] },
  });

  // Nothing left in flight, no timers left behind.
  assert.deepEqual(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
  assert.equal(t.errors.length, 0);
});

test('notification round trip: phone notify_ack status reaches Claude with no body', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answerPromise = mcp(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const [command] = (await (await pollPromise).json()).commands;
  assert.equal(command.jsonrpc.id, undefined);
  assert.equal((await respond(t, command)).status, 200);
  const answer = await answerPromise;
  assert.equal(answer.status, 202);
  assert.equal(await answer.text(), '');
});

test('an invalid phone status code: HTTP 200 JSON-RPC error for requests, 502 for notifications', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  for (const bad of [700, 99, 150, 'x']) {
    const pollPromise = poll(t);
    await waitFor(() => t.relay.hub.inspect().parked);
    const answerPromise = mcp(t, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const [command] = (await (await pollPromise).json()).commands;
    assert.equal((await respond(t, command, { resp_code: bad })).status, 200);
    const answer = await answerPromise;
    assert.equal(answer.status, 200, `resp_code ${bad}`);
    const body = await answer.json();
    assert.equal(body.id, 3);
    assert.equal(body.error.code, -32603);
    assert.deepEqual(body.error.data.droidbridge_relay, { state: 'invalid_device_reply', delivered: true, retried: false });
    assert.match(body.error.message, /not retried/);
  }
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const notePromise = mcp(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const [command] = (await (await pollPromise).json()).commands;
  assert.equal((await respond(t, command, { resp_code: 42 })).status, 200);
  const note = await notePromise;
  assert.equal(note.status, 502);
  assert.equal(await note.text(), '');
});

test('metadata endpoints follow the design', async () => {
  const t = makeRelay();
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const res = await t.relay.fetch(new Request(`${ORIGIN}${path}`));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['droidbridge'],
      bearer_methods_supported: ['header'],
    });
  }
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const res = await t.relay.fetch(new Request(`${ORIGIN}${path}`));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['droidbridge'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  }
  assert.equal((await t.relay.fetch(new Request(`${ORIGIN}/.well-known/nothing`))).status, 404);
  assert.equal(
    (await t.relay.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, { method: 'POST' }))).status,
    405,
  );
});

test('PUBLIC_ORIGIN overrides the request origin everywhere', async () => {
  const t = makeRelay({ env: { PUBLIC_ORIGIN: 'https://phone-relay.example.com/' } });
  const res = await t.relay.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`));
  assert.equal((await res.json()).resource, 'https://phone-relay.example.com/mcp');
  const challenge = (await mcp(t, null, {})).headers.get('www-authenticate');
  assert.equal(
    challenge,
    'Bearer resource_metadata="https://phone-relay.example.com/.well-known/oauth-protected-resource", scope="droidbridge"',
  );
});

test('the consent Deny button redirects with access_denied and forgets the request', async () => {
  const t = makeRelay();
  const client = await (await register(t)).json();
  const { challenge } = pkcePair();
  const page = await authorizeGet(t, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's1',
  });
  const requestId = requestIdFrom(await page.text());
  const denied = await authorizePost(t, { request_id: requestId, action: 'deny' });
  assert.equal(denied.status, 302);
  const location = new URL(/** @type {string} */ (denied.headers.get('location')));
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 's1');
  assert.equal(location.searchParams.get('iss'), ORIGIN);
  assert.equal(location.searchParams.get('code'), null);
  const again = await authorizePost(t, { request_id: requestId, action: 'allow', pairing_code: 'AAAA-AAAA' });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /expired or was already answered/);
});

test('a cross-site POST to /authorize is refused', async () => {
  const t = makeRelay();
  const client = await (await register(t)).json();
  const { challenge } = pkcePair();
  const page = await authorizeGet(t, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const requestId = requestIdFrom(await page.text());
  await pair(t, 'ABCDEFGH');
  const res = await authorizePost(
    t,
    { request_id: requestId, action: 'allow', pairing_code: 'ABCD-EFGH' },
    { origin: 'https://evil.example' },
  );
  assert.equal(res.status, 403);
  assert.ok(await t.storage.get('pairing'), 'pairing untouched');
});
