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
