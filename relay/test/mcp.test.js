// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_IN_FLIGHT } from '../src/relay.js';
import { ORIGIN, makeRelay, mcp, obtainTokens, poll, toolsCall, waitFor } from './helpers.js';

const CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="droidbridge"`;

test('/mcp 401 challenge without a token', async () => {
  const t = makeRelay();
  const res = await mcp(t, null, toolsCall());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), CHALLENGE);
  // Auth comes before the method check.
  const get = await mcp(t, null, undefined, { method: 'GET' });
  assert.equal(get.status, 401);
  assert.equal(get.headers.get('www-authenticate'), CHALLENGE);
  // A non-bearer scheme is not a presented bearer token.
  const basic = await mcp(t, null, toolsCall(), { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
  assert.equal(basic.headers.get('www-authenticate'), CHALLENGE);
});

test('/mcp 401 challenge with an invalid token', async () => {
  const t = makeRelay();
  for (const token of ['dbra_not-a-real-token', 'x'.repeat(600)]) {
    const res = await mcp(t, token, toolsCall());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), `${CHALLENGE}, error="invalid_token"`);
    assert.equal((await res.json()).error, 'invalid_token');
  }
  const malformed = await mcp(t, null, toolsCall(), { headers: { authorization: 'Bearer a b c' } });
  assert.equal(malformed.headers.get('www-authenticate'), `${CHALLENGE}, error="invalid_token"`);
});

test('a token issued for another resource is rejected', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t, { origin: 'https://a.relay.example' });
  // Valid on the origin it was issued for (device offline: 503 means it got past auth).
  assert.equal((await mcp(t, tokens.access_token, toolsCall(), { origin: 'https://a.relay.example' })).status, 503);
  const res = await mcp(t, tokens.access_token, toolsCall(), { origin: 'https://b.relay.example' });
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://b.relay.example/.well-known/oauth-protected-resource", scope="droidbridge", error="invalid_token"',
  );
});

test('an expired access token is rejected', async () => {
  const t = makeRelay();
  const tokens = await obtainTokens(t);
  assert.equal((await mcp(t, tokens.access_token, toolsCall())).status, 503);
  await t.clock.advance(60 * 60 * 1000);
  const res = await mcp(t, tokens.access_token, toolsCall());
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"$/);
});

test('GET and DELETE /mcp are 405 with Allow: POST', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const res = await mcp(t, token, method === 'GET' ? undefined : toolsCall(), { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST');
  }
});

test('wrong content type is 415; JSON with parameters is fine', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
    const res = await mcp(t, token, toolsCall(), { headers: { 'content-type': type } });
    assert.equal(res.status, 415, type);
  }
  const res = await mcp(t, token, toolsCall(), { headers: { 'content-type': 'Application/JSON; charset=utf-8' } });
  assert.equal(res.status, 503, 'passes validation; device offline');
});

test('body over 262144 bytes is 413', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const big = JSON.stringify({ ...toolsCall(), params: { pad: 'x'.repeat(262_144) } });
  const res = await mcp(t, token, big);
  assert.equal(res.status, 413);
  const exact = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', pad: '' });
  const padded = exact.replace('"pad":""', `"pad":"${'y'.repeat(262_144 - exact.length)}"`);
  assert.equal(new TextEncoder().encode(padded).byteLength, 262_144);
  assert.equal((await mcp(t, token, padded)).status, 503, 'exactly the limit is accepted');
});

test('invalid JSON and non-request bodies are 400 JSON-RPC errors with id null', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const cases = [
    ['{not json', -32700],
    ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600],
    ['"text"', -32600],
    ['{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600],
    ['{"jsonrpc":"2.0","id":1}', -32600],
    ['{"jsonrpc":"2.0","id":1,"result":{}}', -32600],
    ['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600],
    ['{"jsonrpc":"2.0","id":1.5,"method":"ping"}', -32600],
    ['{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}', -32600],
  ];
  for (const [body, code] of cases) {
    const res = await mcp(t, token, body);
    assert.equal(res.status, 400, String(body));
    const error = await res.json();
    assert.equal(error.jsonrpc, '2.0');
    assert.equal(error.id, null);
    assert.equal(error.error.code, code, String(body));
    assert.equal(typeof error.error.message, 'string');
  }
  const bad = new Uint8Array([0x7b, 0xff, 0x7d]);
  const res = await t.relay.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: bad,
    }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test('an over-long allowlisted header is refused, not truncated', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const res = await mcp(t, token, toolsCall(9), { headers: { 'mcp-name': 'n'.repeat(4097) } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).id, 9);
});

test('in-flight cap: the 17th concurrent request is 429 and not delivered', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  // Device online (poll just ended) but not polling: requests wait in the hand-off list.
  assert.equal((await poll(t, 0)).status, 204);
  const waiting = [];
  for (let i = 0; i < MAX_IN_FLIGHT; i += 1) waiting.push(mcp(t, token, toolsCall(i)));
  await waitFor(() => t.relay.hub.inspect().handoff === MAX_IN_FLIGHT);
  const busy = await mcp(t, token, toolsCall('over'));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '1');
  const body = await busy.json();
  assert.equal(body.id, 'over');
  assert.equal(body.error.code, -32001);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'busy', delivered: false });
  assert.match(body.error.message, /not delivered/);

  // A busy notification gets the status and no body.
  const busyNote = await mcp(t, token, { jsonrpc: '2.0', method: 'notifications/cancelled' });
  assert.equal(busyNote.status, 429);
  assert.equal(await busyNote.text(), '');

  // The phone polls: it gets 8, then 8 more; never the refused one.
  const first = await (await poll(t)).json();
  const second = await (await poll(t)).json();
  assert.equal(first.commands.length, 8);
  assert.equal(second.commands.length, 8);
  const ids = [...first.commands, ...second.commands].map((command) => command.jsonrpc.id);
  assert.ok(!ids.includes('over'));
  assert.deepEqual(new Set(ids).size, MAX_IN_FLIGHT);
  assert.equal(t.relay.hub.inspect().handoff, 0);
  // Let the delivered requests settle as unknown so no promise is left hanging.
  await t.clock.advance(245_000);
  const outcomes = await Promise.all(waiting);
  for (const res of outcomes) assert.equal(res.status, 200);
  assert.equal(t.clock.pendingTimers(), 0);
});
