// @ts-check
/**
 * POST /mcp: Claude's side of the relay. Authenticates the OAuth access token, validates the
 * JSON-RPC message, hands it to the phone through the hub and turns the outcome into the HTTP
 * answer. The relay never interprets, queues for later, caches or retries a request.
 *
 * Messages travel as the text they arrived as. Claude's body goes into the poll response as
 * written and the phone's `resp_json` reaches Claude as the phone wrote it; the relay parses
 * them only to check them, and never sends JSON.stringify of a parsed message, which would round
 * every number through an IEEE double.
 */

import { memberSource, numberKey, scalarEnd, skipWhitespace, stringEnd } from './json.js';
import { SCOPE } from './oauth.js';
import {
  decodeUtf8,
  empty,
  isPlainObject,
  json,
  jsonText,
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
/**
 * Largest magnitude of a number the phone is sure to read. serde_json refuses a number beyond
 * the double range (1e400 is an error, not infinity), and it computes a number as its digits
 * times a power of ten, which can overflow within a few units in the last place of the largest
 * double (about 1.7977e308). This bound keeps clear of that.
 */
export const PHONE_NUMBER_MAX = 1.79e308;
/** An unpaired UTF-16 surrogate: in `u` mode a correctly paired one matches as one code point. */
const LONE_SURROGATE = /\p{Cs}/u;
/** A JSON integer the phone takes as an id: no fraction, no exponent, and not `-0`. */
const INTEGER_ID = /^(?:0|-?[1-9]\d{0,19})$/;
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;
/** Separators between JSON tokens: whitespace, commas and colons. */
const BETWEEN_TOKENS = /[ \t\n\r,:]*/y;
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
 * A JSON-RPC error response as JSON text. The id is given as JSON text too (the request's own
 * id exactly as Claude wrote it, see requestIdText), so an id above 2^53 is echoed unchanged.
 * @param {string | null} idText null for `"id":null`
 * @param {number} code
 * @param {string} message
 * @param {Record<string, unknown>} [relayData]
 */
export function rpcErrorText(idText, code, message, relayData) {
  /** @type {Record<string, unknown>} */
  const error = { code, message };
  if (relayData) error.data = { droidbridge_relay: relayData };
  return `{"jsonrpc":"2.0","id":${idText ?? 'null'},"error":${JSON.stringify(error)}}`;
}

/**
 * @param {number} status
 * @param {string | null} idText
 * @param {number} code
 * @param {string} message
 * @param {Record<string, unknown>} [relayData]
 * @param {Record<string, string>} [headers]
 */
function rpcErrorResponse(status, idText, code, message, relayData, headers = {}) {
  return jsonText(status, rpcErrorText(idText, code, message, relayData), headers);
}

/**
 * The id of a JSON-RPC request as JSON text, exactly as Claude wrote it, when it is an id the
 * phone answers: a string, or an integer written without fraction or exponent that fits a 64-bit
 * signed or unsigned integer. The phone reads any other number as a float and ignores the
 * request. Null when the id is anything else.
 * @param {string} text the message as JSON text
 * @param {Record<string, any>} message the same message, parsed
 * @returns {string | null}
 */
export function requestIdText(text, message) {
  const id = message.id;
  if (typeof id === 'string') return JSON.stringify(id);
  if (typeof id !== 'number') return null;
  const source = memberSource(text, 'id');
  if (source === undefined || !INTEGER_ID.test(source)) return null;
  const value = BigInt(source);
  return value >= I64_MIN && value <= U64_MAX ? source : null;
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
 * @typedef {{ text: string, message: unknown }} McpBody a request body as JSON text, and parsed
 * @typedef {{
 *   bodyRead: boolean, body: McpBody | undefined, requestId: string | null, delivered: boolean
 * }} McpProgress how far one POST /mcp got, so a failure can be answered with what is known
 */

/** @returns {McpProgress} */
export function mcpProgress() {
  return { bodyRead: false, body: undefined, requestId: null, delivered: false };
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
    return rpcErrorResponse(413, null, -32600, `The request body is larger than ${MCP_BODY_LIMIT_BYTES} bytes.`);
  }
  // The text is what the phone gets: it is forwarded as is, never re-encoded, so it stays within
  // the body limit and every number in it keeps its exact digits.
  const text = decodeUtf8(bytes);
  const message = parseJson(text);
  if (text === null || message === undefined) {
    return rpcErrorResponse(400, null, -32700, 'Parse error: the body is not valid JSON.');
  }
  if (!isPlainObject(message)) {
    return rpcErrorResponse(400, null, -32600, 'Invalid Request: the body must be a single JSON-RPC object.');
  }
  // The phone only answers JSON-RPC 2.0 requests and notifications with a string or integer id;
  // anything else would never be answered, so it is refused here instead of waiting it out.
  const isRequest = hasOwn(message, 'id');
  const idText = isRequest ? requestIdText(text, message) : null;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (isRequest && idText === null)) {
    return rpcErrorResponse(400, null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 request or notification.');
  }
  // The phone must be able to read the message text, or it would drop the whole poll response
  // carrying it, together with every other command in that response.
  const unreadable = phoneUnreadableReason(text);
  if (unreadable) {
    return isRequest ? rpcErrorResponse(400, idText, -32600, `Invalid Request: ${unreadable}`) : empty(400);
  }
  progress.body = { text, message };

  // 3. Forward only the allowlisted headers, in canonical case.
  /** @type {Record<string, string[]>} */
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name) ?? HEADER_DEFAULTS[name];
    if (value === undefined) continue;
    if (encoder.encode(value).byteLength > HEADER_VALUE_LIMIT_BYTES) {
      return isRequest ? rpcErrorResponse(400, idText, -32600, `The ${name} header is too long.`) : empty(400);
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
  };
  progress.requestId = command.request_id;
  // The hub adds the message as the command's `jsonrpc` member, as the text Claude sent.
  const outcome = await relay.hub.submit(command, text, {
    configured: relay.config.deviceKeyConfigured,
    settleWithinMs: seconds * 1000 + relay.timings.responseGraceMs,
    signal: request.signal,
    onDelivered: () => {
      progress.delivered = true;
    },
  });
  return outcomeResponse(outcome, isRequest, idText);
}

/**
 * Why the phone could not parse this message text, or null when it can. JSON.parse accepts all
 * of these, the phone's serde_json refuses them: nesting deeper than MCP_MAX_DEPTH (serde_json
 * stops at 128 levels for the whole poll response), a string or member name holding an unpaired
 * UTF-16 surrogate escape such as a cut emoji "\ud83d", and a number beyond PHONE_NUMBER_MAX.
 * It reads the text itself, the very text the phone gets, so it also checks a member that
 * JSON.parse dropped because a later member repeats its name. Iterative, so any depth is safe.
 * @param {string} text JSON text that JSON.parse accepted
 * @returns {string | null}
 */
export function phoneUnreadableReason(text) {
  let depth = 0;
  let i = 0;
  for (;;) {
    BETWEEN_TOKENS.lastIndex = i;
    if (BETWEEN_TOKENS.test(text)) i = BETWEEN_TOKENS.lastIndex;
    if (i >= text.length) return null;
    const c = text[i];
    if (c === '{' || c === '[') {
      depth += 1;
      if (depth > MCP_MAX_DEPTH) return `the message is nested more than ${MCP_MAX_DEPTH} levels deep.`;
      i += 1;
    } else if (c === '}' || c === ']') {
      depth -= 1;
      i += 1;
    } else if (c === '"') {
      const end = stringEnd(text, i);
      const token = text.slice(i, end);
      // Only a \u escape can spell a surrogate; decoded UTF-8 holds none of its own.
      if (LONE_SURROGATE.test(token.includes('\\u') ? JSON.parse(token) : token)) {
        return text[skipWhitespace(text, end)] === ':'
          ? 'a member name contains an unpaired UTF-16 surrogate.'
          : 'a string contains an unpaired UTF-16 surrogate.';
      }
      i = end;
    } else {
      const end = scalarEnd(text, i);
      if (c !== 't' && c !== 'f' && c !== 'n' && !(Math.abs(Number(text.slice(i, end))) <= PHONE_NUMBER_MAX)) {
        return `a number is beyond the range the phone can read (magnitude above ${PHONE_NUMBER_MAX}).`;
      }
      i = end;
    }
  }
}

/**
 * Whether `reply` is a JSON-RPC 2.0 response to the request with this id: exactly one of result
 * and error, an error with an integer code and a string message, and the same id. A string id
 * must be the same string. A number id must be a number of exactly the same value, compared on
 * the digits as written, so an id above 2^53 matches only itself.
 * @param {unknown} reply the phone's resp_json, parsed
 * @param {string} replyText the same resp_json as JSON text
 * @param {string} idText the request's id as JSON text (see requestIdText)
 */
export function isResponseFor(reply, replyText, idText) {
  if (!isPlainObject(reply) || reply.jsonrpc !== '2.0') return false;
  const hasResult = hasOwn(reply, 'result');
  const hasError = hasOwn(reply, 'error');
  if (hasResult === hasError) return false;
  if (hasError) {
    const error = reply.error;
    if (!isPlainObject(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') return false;
  }
  if (idText.startsWith('"')) return reply.id === JSON.parse(idText);
  // Different doubles always mean different numbers; the same double needs the exact digits.
  if (typeof reply.id !== 'number' || reply.id !== Number(idText)) return false;
  const replyId = memberSource(replyText, 'id');
  return replyId !== undefined && numberKey(replyId) === numberKey(idText);
}

/**
 * @param {Outcome} outcome
 * @param {boolean} isRequest
 * @param {string | null} idText the request's id as JSON text (see requestIdText)
 */
export function outcomeResponse(outcome, isRequest, idText) {
  /**
   * @param {number} status
   * @param {number} code
   * @param {string} message
   * @param {Record<string, unknown>} data
   * @param {Record<string, string>} [headers]
   */
  const relayError = (status, code, message, data, headers = {}) =>
    isRequest ? rpcErrorResponse(status, idText, code, message, data, headers) : empty(status, headers);

  // The phone's reply was delivered but cannot be passed on. A request gets HTTP 200 (no
  // HTTP-layer replay of something that may have run) with a JSON-RPC error; a notification has
  // no body to carry that, so it gets 502.
  const invalidReply = () =>
    isRequest
      ? rpcErrorResponse(200, idText, -32603, MESSAGES.invalid, {
          state: 'invalid_device_reply',
          delivered: true,
          retried: false,
        })
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
      const { payload, source } = outcome;
      const status = payload.resp_code;
      // 100..199 cannot be sent as a final response, so they count as invalid like 600+.
      if (!Number.isInteger(status) || status < 200 || status > 599) return invalidReply();
      if (!isRequest) return empty(status);
      // A request needs a JSON-RPC response for its own id, in a status that can carry a body;
      // anything else would leave Claude with an empty or wrong answer.
      const bodyless = status === 204 || status === 205 || status === 304;
      if (idText === null || bodyless || !isPlainObject(payload.resp_json)) return invalidReply();
      // Claude gets resp_json as the phone wrote it, not re-encoded.
      const replyText = memberSource(source, 'resp_json');
      if (replyText === undefined || !isResponseFor(payload.resp_json, replyText, idText)) return invalidReply();
      return jsonText(status, replyText);
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
 * @param {McpBody | undefined} body the request body; undefined when it is unknown or not JSON
 * @param {boolean | null} delivered whether the command reached a poll response; null when unknown
 */
export function relayFailureAnswer(body, delivered) {
  const data = { state: 'settlement_unknown', delivered, retried: false };
  const text =
    delivered === true
      ? MESSAGES.relayFailureDelivered
      : delivered === false
        ? MESSAGES.relayFailureNotDelivered
        : MESSAGES.relayFailure;
  const message = body?.message;
  if (!body || !isPlainObject(message)) return rpcErrorResponse(200, null, -32002, text, data);
  if (!hasOwn(message, 'id') && typeof message.method === 'string') return empty(200);
  /** @type {string | null} */
  let idText = null;
  try {
    idText = requestIdText(body.text, message);
  } catch {
    // Answer without the id rather than not at all.
  }
  return rpcErrorResponse(200, idText, -32002, text, data);
}

/**
 * The request body as JSON text and parsed; undefined when it is unreadable, too large or not
 * JSON.
 * @param {Request} request
 * @returns {Promise<McpBody | undefined>}
 */
export async function readMcpMessage(request) {
  try {
    const bytes = await readBody(request, MCP_BODY_LIMIT_BYTES);
    const text = bytes ? decodeUtf8(bytes) : null;
    const message = parseJson(text);
    return text === null || message === undefined ? undefined : { text, message };
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
  const body = progress.body ?? (progress.bodyRead ? undefined : await readMcpMessage(request));
  return relayFailureAnswer(body, delivered);
}
