// @ts-check
/**
 * The relay core. One instance lives in the single Durable Object; tests construct it directly
 * with in-memory storage, a fake clock and fake timers.
 */

import { handleDevice } from './device.js';
import { GrantStore } from './grants.js';
import { DeviceHub } from './hub.js';
import { RELAY_ANSWER_HEADER, handleMcp, mcpFailure, mcpProgress } from './mcp.js';
import { OAuthServer, parseExtraRedirectUris } from './oauth.js';
import { json, Mutex } from './util.js';

export const DEFAULT_TIMINGS = Object.freeze({
  /** a phone whose poll ended this recently still counts as online */
  onlineGraceMs: 5000,
  /** how long a request waits for the next poll when the phone is between polls */
  handoffMs: 5000,
  /** extra time after response_timeout before a delivered request is settled as unknown */
  responseGraceMs: 5000,
  /** longest a poll is parked, whatever timeout_ms asks for */
  pollCapMs: 25_000,
});

export const MAX_IN_FLIGHT = 16;
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 240;

/**
 * @typedef {{
 *   DEVICE_KEY_SHA256?: string, RESPONSE_TIMEOUT_SECONDS?: string, CIMD_ALLOWED_HOSTS?: string,
 *   EXTRA_REDIRECT_URIS?: string, PUBLIC_ORIGIN?: string, [key: string]: unknown
 * }} Env
 * @typedef {ReturnType<typeof readConfig>} Config
 * @typedef {import('./grants.js').Storage} Storage
 * @typedef {import('./hub.js').Timers} Timers
 */

/** @param {unknown} value */
function parsePublicOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim().replace(/\/+$/, ''));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * RESPONSE_TIMEOUT_SECONDS as whole seconds clamped to 10..900. Any number is clamped (rounded
 * to whole seconds first); only a value that is not a number at all falls back to the default.
 * @param {unknown} value
 */
function parseResponseTimeout(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return DEFAULT_RESPONSE_TIMEOUT_SECONDS;
  return Math.min(900, Math.max(10, Math.round(Number(raw))));
}

/** @param {Env} env */
export function readConfig(env) {
  const deviceKeyHash = typeof env.DEVICE_KEY_SHA256 === 'string' ? env.DEVICE_KEY_SHA256.trim() : '';
  const hosts = typeof env.CIMD_ALLOWED_HOSTS === 'string' ? env.CIMD_ALLOWED_HOSTS : 'claude.ai,claude.com';
  return {
    deviceKeyHash,
    deviceKeyConfigured: /^[0-9a-f]{64}$/.test(deviceKeyHash),
    responseTimeoutSeconds: parseResponseTimeout(env.RESPONSE_TIMEOUT_SECONDS),
    cimdHosts: hosts
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    extraRedirectUris: parseExtraRedirectUris(env.EXTRA_REDIRECT_URIS),
    publicOrigin: parsePublicOrigin(env.PUBLIC_ORIGIN),
  };
}

export class Relay {
  /**
   * @param {{
   *   storage: Storage,
   *   env?: Env,
   *   now?: () => number,
   *   random?: (n: number) => Uint8Array,
   *   fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
   *   timings?: Partial<typeof DEFAULT_TIMINGS>,
   *   timers?: Timers,
   *   onError?: (error: unknown) => void,
   * }} options
   */
  constructor({ storage, env = {}, now, random, fetchFn, timings = {}, timers, onError }) {
    this.storage = storage;
    this.env = env;
    this.now = now ?? (() => Date.now());
    this.random = random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.timers = timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(/** @type {any} */ (id)),
    };
    // Never log request details: bodies, headers and URLs can carry tokens, codes or keys.
    this.onError = onError ?? (() => console.error('droidbridge-relay: internal error'));
    this.config = readConfig(env);
    this.lock = new Mutex();
    this.grants = new GrantStore({ storage, now: this.now, random: this.random });
    this.hub = new DeviceHub({
      now: this.now,
      timers: this.timers,
      timings: this.timings,
      maxInFlight: MAX_IN_FLIGHT,
    });
    this.oauth = new OAuthServer(this);
    this.lastSweepAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Routes one request. A failure on POST /mcp is never a 5xx: the request may already have
   * reached the phone, so it is answered by the unknown-settlement rule (HTTP 200, JSON-RPC
   * -32002) with what is known about delivery. Other routes answer 500.
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);
    const progress = url.pathname === '/mcp' && request.method === 'POST' ? mcpProgress() : null;
    let response;
    try {
      response = await this.#route(request, url, progress);
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        // Reporting must never change the answer.
      }
      if (!progress) return json(500, { error: 'server_error' });
      response = await mcpFailure(this, request, progress);
    }
    if (progress) response.headers.set(RELAY_ANSWER_HEADER, '1');
    return response;
  }

  /**
   * The public origin: PUBLIC_ORIGIN when set, else the origin the request arrived on.
   * @param {URL} url
   */
  originFor(url) {
    return this.config.publicOrigin ?? url.origin;
  }

  /**
   * Purges expired records at most once a minute. Call outside the lock.
   */
  async maybeSweep() {
    const now = this.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    await this.lock.run(() => this.grants.sweep());
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {import('./mcp.js').McpProgress | null} progress set for POST /mcp
   */
  async #route(request, url, progress) {
    const origin = this.originFor(url);
    const path = url.pathname;
    if (path === '/mcp') return handleMcp(this, request, origin, progress ?? undefined);
    if (path.startsWith('/device/')) return handleDevice(this, request, url);
    if (path.startsWith('/.well-known/')) return this.oauth.wellKnown(request, path, origin);
    if (path === '/authorize') return this.oauth.authorize(request, url, origin);
    if (path === '/token') return this.oauth.token(request);
    if (path === '/register') return this.oauth.register(request);
    return json(404, { error: 'not_found' });
  }
}
