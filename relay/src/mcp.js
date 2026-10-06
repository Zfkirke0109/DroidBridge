// @ts-check
/**
 * POST /mcp: Claude's side of the relay. Authenticates the OAuth access token, validates the
 * JSON-RPC message, hands it to the phone through the hub and turns the outcome into the HTTP
 * answer. The relay never interprets, queues for later, caches or retries a request.
 */

import { SCOPE } from './oauth.js';
import {
  decodeUtf8,
  empty,
  isPlainObject,
  json,
  mediaType,
  methodNotAllowed,
  normalizeResource,
  parseJson,
  randomBase64url,
  readBody,
} from './util.js';

export const MCP_BODY_LIMIT_BYTES = 262_144;
const HEADER_VALUE_LIMIT_BYTES = 4096;
/** Canonical names of the only request headers forwarded to the phone. */
const FORWARDED_HEADERS = ['Content-Type', 'Accept', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'];
/** @type {Record<string, string>} */
const HEADER_DEFAULTS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]{1,512}=*) *$/i;
const encoder = new TextEncoder();

export const MESSAGES = Object.freeze({
  offline: 'DroidBridge is offline. The request was not delivered to the phone.',
  unavailable:
    'DroidBridge did not pick up the request in time. The request was not delivered to the phone.',
  busy: 'DroidBridge is busy with too many requests. The request was not delivered to the phone.',
  unknown:
    'DroidBridge did not report the outcome in time. The request may or may not have run on the phone, and it was not retried.',
  invalid:
    'DroidBridge sent an invalid reply. The request may or may not have run on the phone, and it was not retried.',
  relayFailure:
    'The DroidBridge relay failed while handling the request. It may or may not have reached the phone, and it was not retried.',
});

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {Record<string, unknown>} [relayData]
 */
export function rpcError(id, code, message, relayData) {
  /** @type {Record<string, unknown>} */
  const error = { code, message };
  if (relayData) error.data = { droidbridge_relay: relayData };
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * @param {string} origin
 * @param {boolean} presented whether a bearer token was sent at all
 */
function unauthorized(origin, presented) {
  let challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
  if (presented) challenge += ', error="invalid_token"';
  const body = presented
    ? { error: 'invalid_token', error_description: 'The access token is invalid, expired, or was issued for another resource.' }
    : { error: 'unauthorized', error_description: 'This MCP server requires OAuth authorization.' };
  return json(401, body, { 'WWW-Authenticate': challenge });
}

/**
 * @typedef {import('./relay.js').Relay} Relay
 * @typedef {import('./hub.js').Outcome} Outcome
 */

/**
 * @param {Relay} relay
 * @param {Request} request
 * @param {string} origin
 */
export async function handleMcp(relay, request, origin) {
  // 1. Authentication, before anything else is looked at.
  const authorization = request.headers.get('authorization');
  const presented = authorization !== null && /^bearer(?:\s|$)/i.test(authorization.trim());
  const match = authorization === null ? null : BEARER.exec(authorization);
  const record = match ? await relay.grants.lookupAccess(match[1]) : null;
  const resource = normalizeResource(`${origin}/mcp`);
  if (
    !record ||
    record.resource !== resource ||
    !String(record.scope ?? '').split(' ').includes(SCOPE)
  ) {
    return unauthorized(origin, presented);
  }

  // 2. Method, media type, size, JSON-RPC shape.
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (mediaType(request) !== 'application/json') {
    return json(415, { error: 'unsupported_media_type', error_description: 'Content-Type must be application/json.' });
  }
  const bytes = await readBody(request, MCP_BODY_LIMIT_BYTES);
  if (!bytes) {
    return json(413, rpcError(null, -32600, `The request body is larger than ${MCP_BODY_LIMIT_BYTES} bytes.`));
  }
  const message = parseJson(decodeUtf8(bytes));
  if (message === undefined) return json(400, rpcError(null, -32700, 'Parse error: the body is not valid JSON.'));
  if (!isPlainObject(message)) {
    return json(400, rpcError(null, -32600, 'Invalid Request: the body must be a single JSON-RPC object.'));
  }
  // The phone only answers JSON-RPC 2.0 requests and notifications with a string or integer id;
  // anything else would never be answered, so it is refused here instead of waiting it out.
  const isRequest = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = message.id;
  if (
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string' ||
    (isRequest && typeof id !== 'string' && !Number.isSafeInteger(id))
  ) {
    return json(400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 request or notification.'));
  }

  // 3. Forward only the allowlisted headers, in canonical case.
  /** @type {Record<string, string[]>} */
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name) ?? HEADER_DEFAULTS[name];
    if (value === undefined) continue;
    if (encoder.encode(value).byteLength > HEADER_VALUE_LIMIT_BYTES) {
      return isRequest
        ? json(400, rpcError(id, -32600, `The ${name} header is too long.`))
        : empty(400);
    }
    headers[name] = [value];
  }

  // 4. Hand off.
  const seconds = relay.config.responseTimeoutSeconds;
  const command = {
    command_type: 'jsonrpc',
    request_id: crypto.randomUUID(),
    shard_token: randomBase64url(relay.random),
    channel: 'main',
    created_at: new Date(relay.now()).toISOString(),
    response_timeout: `${seconds}s`,
    headers,
    jsonrpc: message,
  };
  const outcome = await relay.hub.submit(command, {
    configured: relay.config.deviceKeyConfigured,
    settleWithinMs: seconds * 1000 + relay.timings.responseGraceMs,
    signal: request.signal,
  });
  return outcomeResponse(outcome, isRequest, id);
}

/**
 * @param {Outcome} outcome
 * @param {boolean} isRequest
 * @param {unknown} id
 */
export function outcomeResponse(outcome, isRequest, id) {
  /**
   * @param {number} status
   * @param {number} code
   * @param {string} message
   * @param {Record<string, unknown>} data
   * @param {Record<string, string>} [headers]
   */
  const relayError = (status, code, message, data, headers = {}) =>
    isRequest ? json(status, rpcError(id, code, message, data), headers) : empty(status, headers);

  switch (outcome.kind) {
    case 'offline':
      return relayError(503, -32001, MESSAGES.offline, { state: 'offline', delivered: false });
    case 'unavailable':
      return relayError(503, -32001, MESSAGES.unavailable, { state: 'unavailable', delivered: false });
    case 'busy':
      return relayError(429, -32001, MESSAGES.busy, { state: 'busy', delivered: false }, { 'Retry-After': '1' });
    case 'unknown':
      // HTTP 200 so no HTTP-layer client replays a request that may already have run.
      return relayError(200, -32002, MESSAGES.unknown, {
        state: 'settlement_unknown',
        delivered: true,
        retried: false,
      });
    case 'settled': {
      const payload = outcome.payload;
      const status = payload.resp_code;
      // 100..199 cannot be sent as a final response, so they count as invalid like 600+.
      // A request gets HTTP 200 (no HTTP-layer replay of something that may have run) with a
      // JSON-RPC error; a notification has no body to carry that, so it gets 502.
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        if (!isRequest) return empty(502);
        return json(
          200,
          rpcError(id, -32603, MESSAGES.invalid, { state: 'invalid_device_reply', delivered: true, retried: false }),
        );
      }
      const bodyless = status === 204 || status === 205 || status === 304;
      if (
        !isRequest ||
        bodyless ||
        payload.resp_type === 'notify_ack' ||
        payload.resp_json === undefined ||
        payload.resp_json === null
      ) {
        return empty(status);
      }
      return json(status, payload.resp_json);
    }
    default:
      return relayError(500, -32603, 'Internal relay error.', { state: 'internal', delivered: false });
  }
}
