// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import worker, { RelayObject, isRelayRoute } from '../src/index.js';
import { constantTimeEqual, normalizePairingCode, normalizeResource } from '../src/util.js';
import { MemoryStorage, newDeviceKey } from './helpers.js';

/** A fake Durable Object namespace that records which object each request reached. */
function fakeNamespace() {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const paths = [];
  const namespace = {
    /** @param {string} name */
    idFromName(name) {
      names.push(name);
      return { name };
    },
    /** @param {{ name: string }} id */
    get(id) {
      return {
        /** @param {Request} request */
        fetch: async (request) => {
          paths.push(`${id.name} ${request.method} ${new URL(request.url).pathname}`);
          return new Response('from-do', { status: 299 });
        },
      };
    },
  };
  return { namespace, names, paths };
}

test('worker routes relay paths to the single "relay" Durable Object', async () => {
  const { namespace, names, paths } = fakeNamespace();
  const env = { RELAY: namespace };
  const routed = [
    '/mcp',
    '/device/v1/poll',
    '/device/v1/anything',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/authorize',
    '/token',
    '/register',
  ];
  for (const path of routed) {
    const res = await worker.fetch(new Request(`https://relay.example${path}?x=1`, { method: 'POST' }), env);
    assert.equal(res.status, 299, path);
    assert.equal(await res.text(), 'from-do');
  }
  assert.deepEqual(new Set(names), new Set(['relay']));
  assert.equal(paths.length, routed.length);

  const root = await worker.fetch(new Request('https://relay.example/'), env);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), 'DroidBridge relay');
  assert.match(root.headers.get('content-type') ?? '', /^text\/plain/);

  for (const path of ['/favicon.ico', '/mcp/', '/mcpx', '/device', '/devices/v1/poll', '/.well-knownx', '/authorize/x', '/admin']) {
    const res = await worker.fetch(new Request(`https://relay.example${path}`), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(paths.length, routed.length, 'unrouted paths never reach the Durable Object');
  assert.equal(isRelayRoute('/token'), true);
  assert.equal(isRelayRoute('/tokens'), false);
});

test('RelayObject wraps the relay core with Durable Object storage', async () => {
  const device = newDeviceKey();
  const object = new RelayObject({ storage: new MemoryStorage() }, { DEVICE_KEY_SHA256: device.hash });
  const meta = await object.fetch(new Request('https://relay.example/.well-known/oauth-protected-resource'));
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).resource, 'https://relay.example/mcp');
  const status = await object.fetch(
    new Request('https://relay.example/device/v1/status', { headers: { authorization: `Bearer ${device.key}` } }),
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).protocol, 'droidbridge-relay/1');
  assert.equal((await object.fetch(new Request('https://relay.example/nope'))).status, 404);
});

test('new-device-key script prints a well-formed key and its SHA-256', () => {
  const script = fileURLToPath(new URL('../scripts/new-device-key.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const key = /\b(dbrk_[A-Za-z0-9_-]+)\b/.exec(output)?.[1];
  const hash = /\b([0-9a-f]{64})\b/.exec(output)?.[1];
  assert.ok(key && hash);
  assert.match(key, /^dbrk_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, createHash('sha256').update(key).digest('hex'));
  assert.match(output, /npx wrangler@4 secret put DEVICE_KEY_SHA256/);
  const again = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  assert.ok(!again.includes(key), 'a fresh key every run');
});

test('helpers: pairing normalization, resource normalization, constant-time compare', () => {
  assert.equal(normalizePairingCode('k7qm-2xpa'), 'K7QM2XPA');
  assert.equal(normalizePairingCode(' o1L i-0 '), '01110');
  assert.equal(normalizeResource('HTTPS://Relay.Example:443/mcp/'), 'https://relay.example/mcp');
  assert.equal(normalizeResource('https://relay.example/mcp#x'), null);
  assert.equal(normalizeResource('https://u:p@relay.example/mcp'), null);
  assert.equal(normalizeResource('not a url'), null);
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

/** A namespace whose object reads the body, then fails or answers. */
function failingNamespace(/** @type {boolean} */ fail) {
  /** @type {string[]} */
  const bodies = [];
  const stub = {
    /** @param {Request} request */
    fetch: async (request) => {
      bodies.push(await request.text());
      if (fail) throw new Error('Durable Object reset because its code was updated.');
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
    },
  };
  return { namespace: { idFromName: () => ({}), get: () => stub }, bodies };
}

/** @param {string} body */
function mcpPost(body) {
  return new Request('https://relay.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body,
  });
}

test('a Durable Object failure on POST /mcp is a final HTTP 200 JSON-RPC -32002, never a 5xx', async () => {
  const { namespace, bodies } = failingNamespace(true);
  const env = { RELAY: namespace };
  const expectedData = { droidbridge_relay: { state: 'settlement_unknown', delivered: null, retried: false } };

  const withId = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":"r-9","method":"tools/call"}'), env);
  assert.equal(withId.status, 200);
  const body = await withId.json();
  assert.equal(body.id, 'r-9');
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data, expectedData);
  assert.match(body.error.message, /not retried/);
  assert.equal(bodies[0], '{"jsonrpc":"2.0","id":"r-9","method":"tools/call"}', 'the object received the full body');

  const numeric = await (await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":7,"method":"ping"}'), env)).json();
  assert.equal(numeric.id, 7);

  const unparseable = await worker.fetch(mcpPost('{oops'), env);
  assert.equal(unparseable.status, 200);
  const unparsed = await unparseable.json();
  assert.equal(unparsed.id, null);
  assert.deepEqual(unparsed.error.data, expectedData);

  const notification = await worker.fetch(mcpPost('{"jsonrpc":"2.0","method":"notifications/initialized"}'), env);
  assert.equal(notification.status, 200);
  assert.equal(await notification.text(), '');

  // Only POST /mcp is wrapped: other routes still surface the failure to the runtime.
  await assert.rejects(worker.fetch(new Request('https://relay.example/token', { method: 'POST', body: 'x' }), env));
  await assert.rejects(worker.fetch(new Request('https://relay.example/mcp'), env));
});

test('a healthy Durable Object answer on POST /mcp passes through unchanged', async () => {
  const { namespace, bodies } = failingNamespace(false);
  const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":1,"method":"ping"}'), { RELAY: namespace });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.equal(bodies[0], '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});
