// @ts-check
/**
 * Device routes (protocol droidbridge-relay/1). The phone authenticates with its device key;
 * the relay holds only the key's SHA-256 (secret DEVICE_KEY_SHA256) and compares in constant
 * time. The poll/response shape is the OpenAI tunnel long-poll shape the phone already speaks.
 */

import {
  constantTimeEqual,
  decodeUtf8,
  empty,
  isPlainObject,
  json,
  methodNotAllowed,
  parseJson,
  readBody,
  sha256Hex,
} from './util.js';

export const PROTOCOL = 'droidbridge-relay/1';
/** The phone's MCP_RESPONSE_LIMIT_BYTES (12,000,000) plus 1 MiB for the tunnel envelope. */
export const DEVICE_RESPONSE_LIMIT_BYTES = 12_000_000 + 1024 * 1024;
const SMALL_BODY_LIMIT_BYTES = 4096;
const POLL_LIMIT_MAX = 8;
const POLL_DEFAULT_TIMEOUT_MS = 15_000;
const PAIRING_TTL_MAX_SECONDS = 600;
const HEX64 = /^[0-9a-f]{64}$/;

/** @type {Map<string, string[]>} */
const ROUTES = new Map([
  ['/device/v1/status', ['GET']],
  ['/device/v1/poll', ['GET']],
  ['/device/v1/response', ['POST']],
  ['/device/v1/pairing', ['POST', 'DELETE']],
  ['/device/v1/revoke', ['POST']],
]);

/**
 * @typedef {import('./relay.js').Relay} Relay
 */

/**
 * @param {Request} request
 * @param {string} expectedHash
 */
async function deviceKeyMatches(request, expectedHash) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer +(\S{1,512}) *$/i.exec(header);
  // Hash even when the header is missing, so both paths take the same work.
  const digest = await sha256Hex(match ? match[1] : '');
  return constantTimeEqual(digest, expectedHash) && match !== null;
}

/**
 * Parses a non-negative integer query parameter, clamped; the fallback when absent or invalid.
 * @param {string | null} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  if (value === null || !/^\d{1,9}$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

/**
 * @param {Relay} relay
 * @param {Request} request
 * @param {URL} url
 */
export async function handleDevice(relay, request, url) {
  const methods = ROUTES.get(url.pathname);
  if (!methods) return json(404, { error: 'not_found' });
  if (!relay.config.deviceKeyConfigured) return json(503, { error: 'relay_not_configured' });
  if (!(await deviceKeyMatches(request, relay.config.deviceKeyHash))) {
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="droidbridge-relay-device"' });
  }
  if (!methods.includes(request.method)) return methodNotAllowed(methods);

  switch (url.pathname) {
    case '/device/v1/status':
      return status(relay);
    case '/device/v1/poll':
      return poll(relay, request, url);
    case '/device/v1/response':
      return respond(relay, request);
    case '/device/v1/pairing':
      return request.method === 'DELETE' ? cancelPairing(relay) : startPairing(relay, request);
    case '/device/v1/revoke':
      return revoke(relay);
    default:
      return json(404, { error: 'not_found' });
  }
}

/** @param {Relay} relay */
async function status(relay) {
  const clients = await relay.grants.liveClientIds();
  const pairing = await relay.storage.get('pairing');
  return json(200, {
    schema_version: 1,
    protocol: PROTOCOL,
    authorized_clients: clients.size,
    pairing_active: Boolean(pairing && pairing.expiresAt > relay.now()),
  });
}

/**
 * @param {Relay} relay
 * @param {Request} request
 * @param {URL} url
 */
async function poll(relay, request, url) {
  const limit = clampInt(url.searchParams.get('limit'), 1, POLL_LIMIT_MAX, POLL_LIMIT_MAX);
  const cap = relay.timings.pollCapMs;
  const timeout = clampInt(url.searchParams.get('timeout_ms'), 0, cap, Math.min(POLL_DEFAULT_TIMEOUT_MS, cap));
  const commands = await relay.hub.poll(limit, timeout, request.signal);
  return commands.length > 0 ? json(200, { commands }) : empty(204);
}

/**
 * @param {Relay} relay
 * @param {Request} request
 */
async function respond(relay, request) {
  const bytes = await readBody(request, DEVICE_RESPONSE_LIMIT_BYTES);
  if (!bytes) {
    // Too large to read, so the request_id is unknown, but the shard token header still names
    // the request. Settle it now as an invalid device reply (resp_code 0 is outside 200..599)
    // instead of letting Claude wait out the deadline.
    relay.hub.settleByShardToken(request.headers.get('x-tunnel-shard-token'), {
      resp_code: 0,
      resp_type: 'oversize',
    });
    return json(413, { error: 'payload_too_large' });
  }
  const body = parseJson(decodeUtf8(bytes));
  if (!isPlainObject(body) || typeof body.request_id !== 'string') {
    return json(400, { error: 'invalid_request' });
  }
  const settled = relay.hub.settle(body.request_id, request.headers.get('x-tunnel-shard-token'), body);
  // 404 (never 401/403) for unknown, settled, expired or mismatched: the tunnel client treats
  // 401/403 as "operator action needed" and would stop.
  return settled ? json(200, {}) : json(404, { error: 'not_found' });
}

/**
 * @param {Relay} relay
 * @param {Request} request
 */
async function startPairing(relay, request) {
  const bytes = await readBody(request, SMALL_BODY_LIMIT_BYTES);
  if (!bytes) return json(413, { error: 'payload_too_large' });
  const body = parseJson(decodeUtf8(bytes));
  if (!isPlainObject(body) || typeof body.code_sha256 !== 'string' || !HEX64.test(body.code_sha256)) {
    return json(400, { error: 'invalid_request', error_description: 'code_sha256 must be 64 lowercase hex characters.' });
  }
  const ttl = body.ttl_seconds === undefined ? PAIRING_TTL_MAX_SECONDS : body.ttl_seconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > PAIRING_TTL_MAX_SECONDS) {
    return json(400, { error: 'invalid_request', error_description: 'ttl_seconds must be an integer from 1 to 600.' });
  }
  const expiresAt = relay.now() + ttl * 1000;
  await relay.lock.run(() =>
    relay.storage.put('pairing', { hash: body.code_sha256, expiresAt, attempts: 0 }),
  );
  return json(200, { expires_at: new Date(expiresAt).toISOString() });
}

/** @param {Relay} relay */
async function cancelPairing(relay) {
  await relay.lock.run(() => relay.storage.delete('pairing'));
  return empty(204);
}

/** @param {Relay} relay */
async function revoke(relay) {
  const revoked = await relay.lock.run(() => relay.grants.revokeAll());
  return json(200, { revoked_tokens: revoked });
}
