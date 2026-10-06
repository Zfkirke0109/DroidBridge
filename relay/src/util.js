// @ts-check
/**
 * Shared helpers: encoding, hashing, constant-time comparison, bounded body reads,
 * form/JSON parsing and small response builders. Web-standard APIs only, so the same code
 * runs in Cloudflare Workers and in Node 22.
 */

const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** @param {Uint8Array} bytes */
export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} text */
export async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes of `text`.
 * @param {string} text
 */
export async function sha256Hex(text) {
  return toHex(await sha256Bytes(text));
}

/**
 * base64url (no padding) SHA-256 of the ASCII bytes of `text`, as PKCE S256 uses it.
 * @param {string} text
 */
export async function sha256Base64url(text) {
  return base64url(await sha256Bytes(text));
}

/**
 * Compares two strings without an early exit, so the time taken does not reveal how long the
 * matching prefix is. Callers compare fixed-length values (hex digests, tokens), so the length
 * itself is not secret.
 * @param {string} a
 * @param {string} b
 */
export function constantTimeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const length = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Random bytes rendered as unpadded base64url. 32 bytes gives 43 characters (256 bits).
 * @param {(n: number) => Uint8Array} random
 * @param {number} [bytes]
 */
export function randomBase64url(random, bytes = 32) {
  return base64url(random(bytes));
}

/**
 * Reads a byte stream, giving up (and cancelling it) once it exceeds `maxBytes`.
 * @param {ReadableStream<Uint8Array> | null} stream
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>} the bytes, or null when the stream was too large
 */
export async function readStreamLimited(stream, maxBytes) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * True when a Content-Length header already declares more than `maxBytes`.
 * @param {Headers} headers
 * @param {number} maxBytes
 */
function declaresMoreThan(headers, maxBytes) {
  const declared = headers.get('content-length');
  return declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes;
}

/**
 * Reads a request body without ever holding more than `maxBytes` of it.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>} the bytes, or null when the body was too large
 */
export async function readBody(request, maxBytes) {
  if (declaresMoreThan(request.headers, maxBytes)) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  return readStreamLimited(request.body, maxBytes);
}

/**
 * Reads at most `maxBytes` of a fetch Response body; null when it is larger.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readResponseLimited(response, maxBytes) {
  if (declaresMoreThan(response.headers, maxBytes)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  return readStreamLimited(response.body, maxBytes);
}

/**
 * Strict UTF-8 decode; null on invalid input.
 * @param {Uint8Array} bytes
 */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses JSON; `undefined` when the text is not JSON.
 * @param {string | null} text
 * @returns {unknown}
 */
export function parseJson(text) {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The media type of a Content-Type header, lowercased and without parameters.
 * @param {Request} request
 */
export function mediaType(request) {
  return (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Parses form or query parameters. Returns null when any parameter appears more than once
 * (RFC 6749 section 3.1/3.2: parameters MUST NOT be repeated).
 * @param {URLSearchParams} params
 * @returns {Map<string, string> | null}
 */
export function uniqueParams(params) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [key, value] of params) {
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

/**
 * A parameter value, with an empty string treated as absent.
 * @param {Map<string, string>} params
 * @param {string} name
 */
export function param(params, name) {
  const value = params.get(name);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Normalizes a resource indicator for comparison: scheme and host lowercased (the URL parser
 * does that), default port dropped, and one trailing slash removed. Fragments and userinfo are
 * not allowed (RFC 8707), so those return null.
 * @param {string} value
 */
export function normalizeResource(value) {
  if (typeof value !== 'string' || value.includes('#')) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  let out = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * The relay accepts the pairing code the way people type it: any case, with or without the
 * dash or spaces, and with the Crockford look-alikes O, I and L.
 * @param {string} input
 */
export function normalizePairingCode(input) {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff' };

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/**
 * @param {number} status
 * @param {Record<string, string>} [headers]
 */
export function empty(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

/**
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string>} [headers]
 */
export function text(status, text, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/** @param {string[]} methods */
export function methodNotAllowed(methods) {
  return json(405, { error: 'method_not_allowed' }, { Allow: methods.join(', ') });
}

/**
 * Serializes async critical sections. Durable Object input gates already keep storage-only
 * sequences atomic; this keeps OAuth state transitions atomic in every host, including tests.
 */
export class Mutex {
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const result = this.#tail.then(() => fn());
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
