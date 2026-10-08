// @ts-check
// Shared test harness. It has no tests of its own (node --test runs it as an empty file).

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Relay } from '../src/relay.js';

export const ORIGIN = 'https://relay.example';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** The Durable Object storage KV subset, kept in memory and cloned like the real thing. */
export class MemoryStorage {
  constructor() {
    /** @type {Map<string, unknown>} */
    this.map = new Map();
  }
  /** @param {string} key */
  async get(key) {
    const value = this.map.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  /** @param {string} key @param {unknown} value */
  async put(key, value) {
    this.map.set(key, structuredClone(value));
  }
  /** @param {string} key */
  async delete(key) {
    return this.map.delete(key);
  }
  /** @param {{ prefix?: string }} [options] */
  async list({ prefix = '' } = {}) {
    const out = new Map();
    for (const key of [...this.map.keys()].sort()) {
      if (key.startsWith(prefix)) out.set(key, structuredClone(this.map.get(key)));
    }
    return out;
  }
  /** @param {string} prefix */
  keys(prefix) {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix));
  }
}

/** Yields to the event loop so pending promises (including WebCrypto digests) can settle. */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until `condition()` holds, yielding to the event loop between checks. No wall-clock
 * sleeps: it only lets already-queued work finish. Work off the main thread (WebCrypto digests)
 * can take many turns when the machine is busy running other test files, so it gives up after a
 * span of real time rather than after a number of turns.
 * @param {() => boolean} condition
 */
export async function waitFor(condition, timeoutMs = 10_000) {
  const giveUpAt = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > giveUpAt) assert.fail('condition was not reached');
    await tick();
  }
}

/**
 * The value of `promise`, which must settle without the fake clock moving: an answer that
 * would wait for a timer (a request accepted instead of refused) fails the test at once
 * instead of leaving it pending.
 * @template T
 * @param {Promise<T>} promise
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export async function promptly(promise, label = 'the answer came without waiting for the clock') {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const giveUpAt = performance.now() + 5000;
  while (!settled) {
    if (performance.now() > giveUpAt) assert.fail(label);
    await tick();
  }
  return promise;
}

/** A clock whose timers only fire when the test advances it. */
export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 6, 12, 0, 0)) {
    this.t = start;
    this.seq = 0;
    /** @type {Map<number, { at: number, fn: () => void, id: number }>} */
    this.timers = new Map();
    this.now = () => this.t;
    this.api = {
      /** @param {() => void} fn @param {number} ms */
      setTimeout: (fn, ms) => {
        const id = ++this.seq;
        this.timers.set(id, { at: this.t + Math.max(0, ms), fn, id });
        return id;
      },
      /** @param {unknown} id */
      clearTimeout: (id) => {
        this.timers.delete(/** @type {number} */ (id));
      },
    };
  }

  /** Advances time, firing due timers in order and letting their effects settle. */
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      await tick();
      let next = null;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) {
          next = timer;
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = target;
    await tick();
  }

  pendingTimers() {
    return this.timers.size;
  }
}

export function newDeviceKey() {
  const key = `dbrk_${randomBytes(32).toString('base64url')}`;
  return { key, hash: createHash('sha256').update(key).digest('hex') };
}

/** @param {string} value */
export function sha256HexSync(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** @param {string} [verifier] a random 64-character verifier when omitted */
export function pkcePair(verifier = randomBytes(48).toString('base64url')) {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * @param {{ env?: Record<string, string>, fetchFn?: any, timings?: Record<string, number> }} [options]
 */
export function makeRelay(options = {}) {
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  const device = newDeviceKey();
  /** @type {unknown[]} */
  const errors = [];
  const env = {
    DEVICE_KEY_SHA256: device.hash,
    RESPONSE_TIMEOUT_SECONDS: '240',
    CIMD_ALLOWED_HOSTS: 'claude.ai,claude.com',
    EXTRA_REDIRECT_URIS: '',
    PUBLIC_ORIGIN: '',
    ...options.env,
  };
  const fetchCalls = [];
  const fetchFn =
    options.fetchFn ??
    (async (/** @type {string} */ url, /** @type {any} */ init) => {
      fetchCalls.push({ url, init });
      throw new Error('unexpected fetch');
    });
  const relay = new Relay({
    storage,
    env,
    now: clock.now,
    fetchFn,
    timings: options.timings,
    timers: clock.api,
    onError: (error) => errors.push(error),
  });
  return { relay, clock, storage, device, env, errors, fetchCalls };
}

/**
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | Uint8Array, origin?: string }} [init]
 */
export function req(path, init = {}) {
  const { origin = ORIGIN, ...rest } = init;
  return new Request(`${origin}${path}`, /** @type {RequestInit} */ (rest));
}

/**
 * A device-route request with the device key.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} path
 * @param {{ method?: string, body?: unknown, key?: string | null, headers?: Record<string, string> }} [init]
 */
export function deviceFetch(t, path, init = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    'user-agent': 'droidbridge-android/0.4.3',
    'x-tunnel-client-name': 'droidbridge-android',
    'x-tunnel-client-instance-id': '6f1c3c7e-0000-4000-8000-000000000000',
    'x-tunnel-mcp-server-info': '{"version":2}',
    accept: 'application/json',
    ...init.headers,
  };
  const key = init.key === undefined ? t.device.key : init.key;
  if (key !== null) headers.authorization = `Bearer ${key}`;
  let body;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  return t.relay.fetch(req(path, { method: init.method ?? 'GET', headers, body }));
}

/** @param {ReturnType<typeof makeRelay>} t */
export function poll(t, timeoutMs = 15000, limit = 8) {
  return deviceFetch(t, `/device/v1/poll?limit=${limit}&timeout_ms=${timeoutMs}`);
}

/**
 * Posts the phone's response for a command.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, any>} command
 * @param {Record<string, any>} [overrides]
 * @param {string} [shardToken]
 */
export function respond(t, command, overrides = {}, shardToken = command.shard_token) {
  const isRequest = command.jsonrpc.id !== undefined;
  const body = isRequest
    ? {
        request_id: command.request_id,
        channel: command.channel,
        resp_json: { jsonrpc: '2.0', id: command.jsonrpc.id, result: { ok: true } },
        resp_headers: { 'Content-Type': ['application/json'] },
        resp_code: 200,
        resp_type: 'jsonrpc_response',
        ...overrides,
      }
    : { request_id: command.request_id, channel: command.channel, resp_code: 202, resp_type: 'notify_ack', ...overrides };
  return deviceFetch(t, '/device/v1/response', {
    method: 'POST',
    body,
    headers: { 'x-tunnel-shard-token': shardToken },
  });
}

/**
 * The phone side of pairing: stores the SHA-256 of the normalized code.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} normalizedCode
 * @param {number} [ttlSeconds]
 */
export async function pair(t, normalizedCode, ttlSeconds = 600) {
  const res = await deviceFetch(t, '/device/v1/pairing', {
    method: 'POST',
    body: { code_sha256: sha256HexSync(normalizedCode), ttl_seconds: ttlSeconds },
  });
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, unknown>} metadata
 * @param {Record<string, string>} [headers]
 */
export async function register(t, metadata = {}, headers = {}) {
  return t.relay.fetch(
    req('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], ...metadata }),
    }),
  );
}

/**
 * @param {Record<string, string | undefined>} params
 */
export function authorizeQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
  return `/authorize?${query}`;
}

/**
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, string | undefined>} params
 * @param {Record<string, string>} [headers]
 */
export function authorizeGet(t, params, headers = {}) {
  return t.relay.fetch(req(authorizeQuery(params), { headers }));
}

/** @param {string} html */
export function requestIdFrom(html) {
  const match = /name="request_id" value="([^"]+)"/.exec(html);
  assert.ok(match, 'consent page has a request_id');
  return match[1];
}

/**
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, string>} fields
 * @param {Record<string, string>} [headers]
 */
export function authorizePost(t, fields, headers = {}) {
  return t.relay.fetch(
    req('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/**
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, string>} fields
 * @param {string} [origin]
 */
export function tokenPost(t, fields, origin = ORIGIN) {
  return t.relay.fetch(
    req('/token', {
      method: 'POST',
      origin,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/**
 * Runs register -> authorize -> pairing -> consent -> code. Returns what /token needs.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {{ origin?: string, redirectUri?: string, clientId?: string, pairingCode?: string, resource?: string,
 *   verifier?: string }} [options]
 */
export async function obtainCode(t, options = {}) {
  const origin = options.origin ?? ORIGIN;
  const redirectUri = options.redirectUri ?? CLAUDE_CALLBACK;
  let clientId = options.clientId;
  if (!clientId) {
    const reg = await register(t, { redirect_uris: [redirectUri] });
    assert.equal(reg.status, 201);
    clientId = (await reg.json()).client_id;
  }
  const { verifier, challenge } = pkcePair(options.verifier);
  const state = `state-${randomBytes(6).toString('hex')}`;
  const page = await t.relay.fetch(
    req(
      authorizeQuery({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        scope: 'droidbridge',
        resource: options.resource ?? `${origin}/mcp`,
      }),
      { origin },
    ),
  );
  assert.equal(page.status, 200, 'consent page');
  const requestId = requestIdFrom(await page.text());
  const code = options.pairingCode ?? 'K7QM2XPA';
  await pair(t, code);
  const done = await t.relay.fetch(
    req('/authorize', {
      method: 'POST',
      origin,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId, pairing_code: code, action: 'allow' }).toString(),
    }),
  );
  assert.equal(done.status, 302, 'consent redirects');
  const location = new URL(/** @type {string} */ (done.headers.get('location')));
  assert.equal(location.searchParams.get('state'), state);
  return {
    clientId,
    redirectUri,
    verifier,
    state,
    code: /** @type {string} */ (location.searchParams.get('code')),
    origin,
  };
}

/**
 * Full flow to tokens.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Parameters<typeof obtainCode>[1]} [options]
 */
export async function obtainTokens(t, options = {}) {
  const grant = await obtainCode(t, options);
  const res = await tokenPost(
    t,
    {
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: grant.redirectUri,
      client_id: grant.clientId,
      code_verifier: grant.verifier,
      resource: `${grant.origin}/mcp`,
    },
    grant.origin,
  );
  assert.equal(res.status, 200, 'token exchange');
  const tokens = await res.json();
  return { ...grant, ...tokens };
}

/**
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string | null} accessToken
 * @param {unknown} message
 * @param {{ headers?: Record<string, string>, method?: string, origin?: string }} [init]
 */
export function mcp(t, accessToken, message, init = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    ...init.headers,
  };
  if (accessToken !== null) headers.authorization = `Bearer ${accessToken}`;
  const method = init.method ?? 'POST';
  return t.relay.fetch(
    req('/mcp', {
      method,
      origin: init.origin,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : typeof message === 'string' ? message : JSON.stringify(message),
    }),
  );
}

/** @param {number | string} id */
export function toolsCall(id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'command', arguments: { argv: ['id'] } } };
}
