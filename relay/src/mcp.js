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
/**
 * Deepest nesting of objects and arrays accepted in a message, counting the message object
 * itself as level 1. The phone's JSON parser (serde_json) refuses a poll response nested more
 * than 128 levels in all, and the poll envelope adds 3, so this keeps a wide margin.
 */
export const MCP_MAX_DEPTH = 64;
/** An unpaired UTF-16 surrogate: in `u` mode a correctly paired one matches as one code point. */
const LONE_SURROGATE = /\p{Cs}/u;
/**
 * Set by the Durable Object on every POST /mcp answer it makes on purpose, so the Worker can
 * tell a deliberate status (503 offline, a notification's 502, the phone's own 5xx) from a
 * failure. Internal: the Worker removes it before the answer reaches Claude.
 */
export const RELAY_ANSWER_HEADER = 'X-DroidBridge-Relay-Answer';
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
  relayFailureDelivered:
    'The DroidBridge relay failed after handing the request to the phone. The request may or may not have run on the phone, and it was not retried.',
  relayFailureNotDelivered:
    'The DroidBridge relay failed before handing the request to the phone. The request was not delivered to the phone, and it was not retried.',
});

const hasOwn = (/** @type {object} */ value, /** @type {string} */ key) =>
  Object.prototype.hasOwnProperty.call(value, key);

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
 * @typedef {{
 *   bodyRead: boolean, message: Record<string, any> | undefined,
 *   requestId: string | null, delivered: boolean
 * }} McpProgress how far one POST /mcp got, so a failure can be answered with what is known
 */

/** @returns {McpProgress} */
export function mcpProgress() {
  return { bodyRead: false, message: undefined, requestId: null, delivered: false };
}

/**
 * @param {Relay} relay
 * @param {Request} request
 * @param {string} origin
 * @param {McpProgress} [progress] filled in as the request advances
 */
export async function handleMcp(relay, request, origin, progress = mcpProgress()) {
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
  progress.bodyRead = true;
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
  // The phone must be able to read the message as the relay re-encodes it, or it would drop the
  // whole poll response carrying it, together with every other command in that response.
  const unreadable = phoneUnreadableReason(message);
  if (unreadable) return isRequest ? json(400, rpcError(id, -32600, `Invalid Request: ${unreadable}`)) : empty(400);
  if (encoder.encode(JSON.stringify(message)).byteLength > MCP_BODY_LIMIT_BYTES) {
    const tooLarge = `The request is larger than ${MCP_BODY_LIMIT_BYTES} bytes once encoded for the phone.`;
    return isRequest ? json(413, rpcError(id, -32600, tooLarge)) : empty(413);
  }
  progress.message = message;

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
  progress.requestId = command.request_id;
  const outcome = await relay.hub.submit(command, {
    configured: relay.config.deviceKeyConfigured,
    settleWithinMs: seconds * 1000 + relay.timings.responseGraceMs,
    signal: request.signal,
    onDelivered: () => {
      progress.delivered = true;
    },
  });
  return outcomeResponse(outcome, isRequest, id);
}

/**
 * Why the phone could not parse this message once the relay encodes it into a poll response,
 * or null when it can. JSON.parse accepts both cases, the phone's serde_json refuses them:
 * nesting deeper than MCP_MAX_DEPTH (serde_json stops at 128 levels for the whole poll
 * response), and a string or key holding an unpaired UTF-16 surrogate, such as a cut emoji
 * "\ud83d" (JSON.stringify writes it back as that escape, which serde_json rejects). Walks the
 * value without recursion, so any depth JSON.parse produced is safe to inspect.
 * @param {unknown} message
 * @returns {string | null}
 */
export function phoneUnreadableReason(message) {
  /** @type {[unknown, number][]} */
  const stack = [[message, 1]];
  while (stack.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (stack.pop());
    if (typeof value === 'string') {
      if (LONE_SURROGATE.test(value)) return 'a string contains an unpaired UTF-16 surrogate.';
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MCP_MAX_DEPTH) return `the message is nested more than ${MCP_MAX_DEPTH} levels deep.`;
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, depth + 1]);
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (LONE_SURROGATE.test(key)) return 'a member name contains an unpaired UTF-16 surrogate.';
      stack.push([item, depth + 1]);
    }
  }
  return null;
}

/**
 * Whether `reply` is a JSON-RPC 2.0 response to the request with this id: the same id (and
 * type), exactly one of result and error, and an error with an integer code and a string
 * message.
 * @param {unknown} reply
 * @param {unknown} id
 */
export function isResponseFor(reply, id) {
  if (!isPlainObject(reply) || reply.jsonrpc !== '2.0' || reply.id !== id) return false;
  const hasResult = hasOwn(reply, 'result');
  const hasError = hasOwn(reply, 'error');
  if (hasResult === hasError) return false;
  if (hasResult) return true;
  const error = reply.error;
  return isPlainObject(error) && Number.isInteger(error.code) && typeof error.message === 'string';
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

  // The phone's reply was delivered but cannot be passed on. A request gets HTTP 200 (no
  // HTTP-layer replay of something that may have run) with a JSON-RPC error; a notification has
  // no body to carry that, so it gets 502.
  const invalidReply = () =>
    isRequest
      ? json(
          200,
          rpcError(id, -32603, MESSAGES.invalid, { state: 'invalid_device_reply', delivered: true, retried: false }),
        )
      : empty(502);

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
    case 'invalid':
      return invalidReply();
    case 'settled': {
      const payload = outcome.payload;
      const status = payload.resp_code;
      // 100..199 cannot be sent as a final response, so they count as invalid like 600+.
      if (!Number.isInteger(status) || status < 200 || status > 599) return invalidReply();
      if (!isRequest) return empty(status);
      // A request needs a JSON-RPC response for its own id, in a status that can carry a body;
      // anything else would leave Claude with an empty or wrong answer.
      const bodyless = status === 204 || status === 205 || status === 304;
      if (bodyless || !isResponseFor(payload.resp_json, id)) return invalidReply();
      return json(status, payload.resp_json);
    }
    default:
      // Unreachable; the caller's failure path answers with what is known about delivery.
      throw new Error('unexpected hub outcome');
  }
}

/**
 * The final answer when the relay fails while handling POST /mcp: HTTP 200 with JSON-RPC
 * -32002 (echoing the id when the body is known), or an empty 200 for a notification, matching
 * the unknown-settlement rule. Never a 5xx an HTTP client might replay.
 * @param {unknown} message the parsed body; undefined when it is unknown or not JSON
 * @param {boolean | null} delivered whether the command reached a poll response; null when unknown
 */
export function relayFailureAnswer(message, delivered) {
  const data = { state: 'settlement_unknown', delivered, retried: false };
  const text =
    delivered === true
      ? MESSAGES.relayFailureDelivered
      : delivered === false
        ? MESSAGES.relayFailureNotDelivered
        : MESSAGES.relayFailure;
  if (!isPlainObject(message)) return json(200, rpcError(null, -32002, text, data));
  if (!hasOwn(message, 'id') && typeof message.method === 'string') return empty(200);
  const id = typeof message.id === 'string' || Number.isSafeInteger(message.id) ? message.id : null;
  return json(200, rpcError(id, -32002, text, data));
}

/**
 * The request body as JSON; undefined when it is unreadable, too large or not JSON.
 * @param {Request} request
 * @returns {Promise<unknown>}
 */
export async function readMcpMessage(request) {
  try {
    const bytes = await readBody(request, MCP_BODY_LIMIT_BYTES);
    return bytes ? parseJson(decodeUtf8(bytes)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers a POST /mcp whose handling threw. The command is withdrawn from the hub first, so one
 * still waiting for a poll can never be delivered after this answer, and a delivered one stops
 * holding an in-flight slot (a late reply from the phone gets 404).
 * @param {Relay} relay
 * @param {Request} request
 * @param {McpProgress} progress
 */
export async function mcpFailure(relay, request, progress) {
  /** @type {boolean | null} */
  let delivered = progress.delivered;
  if (progress.requestId !== null) {
    try {
      if (relay.hub.withdraw(progress.requestId) === true) delivered = true;
    } catch {
      if (!delivered) delivered = null;
    }
  }
  // Before the body was read (a failure during authentication) it can still be read for the id.
  const message = progress.message ?? (progress.bodyRead ? undefined : await readMcpMessage(request));
  return relayFailureAnswer(message, delivered);
}
