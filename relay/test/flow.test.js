// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { RELAY_ANSWER_HEADER, outcomeResponse } from '../src/mcp.js';
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

test('an invalid phone status code: HTTP 200 JSON-RPC error for requests, an empty HTTP 200 for notifications', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  // Not an integer from 200 to 599: just past either end, far past it, or a fraction.
  for (const bad of [700, 600, 699, 199, 99, 150, 0, -1, 200.5, 404.5, 'x', '200', null, true]) {
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
  // A notification has no body to carry the error: it gets an empty 200, never a 5xx a client
  // could replay after delivery.
  for (const bad of [42, 700, 600, 99, 150, 200.5, 'x']) {
    const pollPromise = poll(t);
    await waitFor(() => t.relay.hub.inspect().parked);
    const notePromise = mcp(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const [command] = (await (await pollPromise).json()).commands;
    assert.equal((await respond(t, command, { resp_code: bad })).status, 200);
    const note = await notePromise;
    assert.equal(note.status, 200, `resp_code ${bad}`);
    assert.equal(note.headers.get(RELAY_ANSWER_HEADER), '1', 'a deliberate answer');
    assert.equal(await note.text(), '');
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

/**
 * Delivers one message to the phone, posts the phone's reply with `overrides`, and returns the
 * phone's acknowledgement and Claude's answer.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} token
 * @param {Record<string, unknown>} message
 * @param {Record<string, unknown>} overrides
 */
async function roundTrip(t, token, message, overrides) {
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answerPromise = mcp(t, token, message);
  const [command] = (await (await pollPromise).json()).commands;
  const ack = await respond(t, command, overrides);
  return { ack, answer: await answerPromise };
}

test('a request reply without a JSON-RPC response for the same id is an invalid device reply', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const request = { jsonrpc: '2.0', id: 3, method: 'tools/list' };
  /** @type {Record<string, unknown>[]} */
  const invalid = [
    { resp_json: undefined }, // missing
    { resp_json: null },
    { resp_json: 'ok' },
    { resp_json: 3 },
    { resp_json: true },
    { resp_json: [{ jsonrpc: '2.0', id: 3, result: {} }] },
    { resp_json: { id: 3, result: {} } }, // no jsonrpc
    { resp_json: { jsonrpc: '1.0', id: 3, result: {} } },
    { resp_json: { jsonrpc: '2.0', id: 4, result: {} } }, // another id
    { resp_json: { jsonrpc: '2.0', id: '3', result: {} } }, // same digits, another type
    { resp_json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } },
    { resp_json: { jsonrpc: '2.0', result: {} } }, // no id
    { resp_json: { jsonrpc: '2.0', id: 3 } }, // neither result nor error
    { resp_json: { jsonrpc: '2.0', id: 3, result: {}, error: { code: -1, message: 'x' } } }, // both
    { resp_json: { jsonrpc: '2.0', id: 3, error: 'boom' } },
    { resp_json: { jsonrpc: '2.0', id: 3, error: null } },
    { resp_json: { jsonrpc: '2.0', id: 3, error: [] } },
    { resp_json: { jsonrpc: '2.0', id: 3, error: { code: 1.5, message: 'x' } } },
    { resp_json: { jsonrpc: '2.0', id: 3, error: { code: -1 } } },
    { resp_code: 204 }, // a valid body in a status that cannot carry one
    { resp_code: 205 },
    { resp_code: 304 },
    { resp_type: 'notify_ack', resp_json: undefined },
    // An error status changes nothing: the reply still has to be a response to the request.
    { resp_code: 500, resp_json: undefined },
    { resp_code: 500, resp_json: null },
    { resp_code: 502, resp_json: 'Bad Gateway' },
    { resp_code: 503, resp_json: { jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'Runtime unavailable' } } },
    { resp_code: 500, resp_json: { jsonrpc: '2.0', id: 3, error: null } },
    { resp_code: 404, resp_json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'x' } } },
    { resp_code: 413, resp_json: undefined },
    { resp_code: 429, resp_json: { jsonrpc: '2.0', id: '3', error: { code: -32000, message: 'x' } } },
  ];
  for (const overrides of invalid) {
    const label = JSON.stringify(overrides);
    const { ack, answer } = await roundTrip(t, token, request, overrides);
    assert.equal(ack.status, 200, `${label}: the phone's reply is accepted`);
    assert.equal(answer.status, 200, label);
    const body = await answer.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 3, label);
    assert.equal(body.error.code, -32603, label);
    assert.match(body.error.message, /may or may not have run.*not retried/);
    assert.deepEqual(body.error.data.droidbridge_relay, { state: 'invalid_device_reply', delivered: true, retried: false });
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('valid JSON-RPC replies pass through with the phone status when no client would replay it', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  /** @type {[Record<string, unknown>, Record<string, unknown>, number][]} */
  const cases = [
    [{ jsonrpc: '2.0', id: 'abc', method: 'ping' }, { jsonrpc: '2.0', id: 'abc', result: null }, 200],
    [{ jsonrpc: '2.0', id: 0, method: 'ping' }, { jsonrpc: '2.0', id: 0, result: {} }, 200],
    [
      { jsonrpc: '2.0', id: 5, method: 'tools/call' },
      { jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found' } },
      404,
    ],
    [
      { jsonrpc: '2.0', id: 6, method: 'tools/call' },
      { jsonrpc: '2.0', id: 6, error: { code: -32602, message: 'Invalid params' } },
      400,
    ],
    // Neighbours of the statuses that become HTTP 200 still pass through: an MCP client resends
    // after a 403 only when its WWW-Authenticate asks for more scope, and the relay never
    // forwards the phone's headers.
    ...[400, 402, 403, 406, 409, 412, 414, 415, 420, 422, 424, 426, 428, 430, 499].map(
      (status) => /** @type {[Record<string, unknown>, Record<string, unknown>, number]} */ ([
        { jsonrpc: '2.0', id: status, method: 'tools/call' },
        { jsonrpc: '2.0', id: status, error: { code: -32000, message: `phone ${status}` } },
        status,
      ]),
    ),
  ];
  for (const [request, reply, status] of cases) {
    const { ack, answer } = await roundTrip(t, token, request, { resp_json: reply, resp_code: status });
    assert.equal(ack.status, 200);
    assert.equal(answer.status, status);
    assert.equal(answer.headers.get(RELAY_ANSWER_HEADER), '1');
    assert.deepEqual(await answer.json(), reply);
  }
  // A notification needs no body: a valid status passes through without one.
  for (const status of [202, 400, 404]) {
    const note = await roundTrip(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, { resp_code: status });
    assert.equal(note.answer.status, status);
    assert.equal(await note.answer.text(), '');
  }
});

test('after delivery a phone status a client could replay, or 413, reaches Claude as HTTP 200', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  // The phone's facade answers 413 when its tunnel client's re-encoding made the message longer
  // than 262 144 bytes; a 5xx, 429, 408, 425 or 421 could make an HTTP client run it a second
  // time, and so could 401 or 407, after which an MCP client gets new credentials and resends.
  for (const status of [413, 500, 503, 429, 408, 425, 401, 407, 421, 502, 504, 599]) {
    const reply = { jsonrpc: '2.0', id: status, error: { code: -32603, message: 'MCP request failed' } };
    const { ack, answer } = await roundTrip(t, token, { jsonrpc: '2.0', id: status, method: 'tools/call' }, {
      resp_json: reply,
      resp_code: status,
    });
    assert.equal(ack.status, 200);
    assert.equal(answer.status, 200, `phone status ${status}`);
    assert.equal(answer.headers.get('content-type'), 'application/json');
    assert.equal(answer.headers.get(RELAY_ANSWER_HEADER), '1');
    assert.deepEqual(await answer.json(), reply, 'the phone\'s JSON-RPC error, unchanged');
  }
  // The reply is still checked: a 413 carrying another request's id is an invalid device reply.
  const other = await roundTrip(t, token, { jsonrpc: '2.0', id: 'big', method: 'tools/call' }, {
    resp_json: { jsonrpc: '2.0', id: 'other', error: { code: -32603, message: 'MCP request failed' } },
    resp_code: 413,
  });
  assert.equal(other.answer.status, 200);
  const invalid = await other.answer.json();
  assert.equal(invalid.id, 'big');
  assert.equal(invalid.error.code, -32603);
  assert.deepEqual(invalid.error.data.droidbridge_relay, { state: 'invalid_device_reply', delivered: true, retried: false });
  // A notification gets an empty 200.
  for (const status of [413, 429, 500, 408, 425, 401, 407, 421, 503, 599]) {
    const note = await roundTrip(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, { resp_code: status });
    assert.equal(note.ack.status, 200);
    assert.equal(note.answer.status, 200, `phone status ${status}`);
    assert.equal(await note.answer.text(), '');
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.clock.pendingTimers(), 0);
});

test('outcomeResponse: every phone status from 200 to 599, for a request and a notification', async () => {
  // Statuses an HTTP client may retry on its own, and 413, which is kept for "not delivered".
  const replayable = (/** @type {number} */ status) =>
    [401, 407, 408, 413, 421, 425, 429].includes(status) || status >= 500;
  const reply = '{"jsonrpc":"2.0","id":1,"result":{}}';
  for (let status = 200; status <= 599; status += 1) {
    const bodyless = status === 204 || status === 205 || status === 304;
    const source = `{"request_id":"r","resp_json":${reply},"resp_code":${status}}`;
    const outcome = /** @type {const} */ ({ kind: 'settled', payload: JSON.parse(source), source });
    const expected = replayable(status) ? 200 : status;
    const res = outcomeResponse(outcome, true, '1');
    assert.equal(res.status, bodyless ? 200 : expected, `request, phone status ${status}`);
    const text = await res.text();
    if (bodyless) assert.equal(JSON.parse(text).error.code, -32603, `request, phone status ${status}`);
    else assert.equal(text, reply, `request, phone status ${status}`);
    const note = outcomeResponse(outcome, false, null);
    assert.equal(note.status, expected, `notification, phone status ${status}`);
    assert.equal(await note.text(), '');
  }
  // Nothing but an integer from 200 to 599 is a valid status. A request's reply with any other
  // is invalid even with a valid body (HTTP 200, -32603); a notification's is an empty 200.
  for (const status of [199, 600, 601, 699, 0, -1, 200.5, 404.5, 599.5]) {
    const source = `{"request_id":"r","resp_json":${reply},"resp_code":${status}}`;
    const outcome = /** @type {const} */ ({ kind: 'settled', payload: JSON.parse(source), source });
    const res = outcomeResponse(outcome, true, '1');
    assert.equal(res.status, 200, `request, phone status ${status}`);
    const body = await res.json();
    assert.equal(body.error.code, -32603, `request, phone status ${status}`);
    assert.equal(body.error.data.droidbridge_relay.state, 'invalid_device_reply');
    const note = outcomeResponse(outcome, false, null);
    assert.equal(note.status, 200, `notification, phone status ${status}`);
  }
  assert.equal(outcomeResponse({ kind: 'invalid' }, false, null).status, 200);
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
