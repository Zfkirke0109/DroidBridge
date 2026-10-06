// @ts-check
/**
 * Worker entry. Every relay route goes to one Durable Object instance, so the parked phone
 * poll, the hand-off list and the OAuth state all live in one place.
 */

import { MCP_BODY_LIMIT_BYTES, MESSAGES, rpcError } from './mcp.js';
import { Relay } from './relay.js';
import { decodeUtf8, empty, isPlainObject, json, parseJson, readBody, text } from './util.js';

const EXACT_ROUTES = new Set(['/mcp', '/authorize', '/token', '/register']);

/** @param {string} pathname */
export function isRelayRoute(pathname) {
  return (
    EXACT_ROUTES.has(pathname) || pathname.startsWith('/device/') || pathname.startsWith('/.well-known/')
  );
}

export default {
  /**
   * @param {Request} request
   * @param {{ RELAY: { idFromName: (name: string) => unknown, get: (id: any) => { fetch: (request: Request) => Promise<Response> } } }} env
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isRelayRoute(pathname)) {
      const stub = env.RELAY.get(env.RELAY.idFromName('relay'));
      if (pathname === '/mcp' && request.method === 'POST') return forwardMcp(stub, request);
      return stub.fetch(request);
    }
    if (pathname === '/') {
      if (request.method === 'GET' || request.method === 'HEAD') return text(200, 'DroidBridge relay');
      return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    return text(404, 'Not found');
  },
};

/**
 * Forwards POST /mcp to the Durable Object. If the object fails (reset, deploy, network), the
 * request may or may not have reached the phone, so Claude gets the same final, non-retryable
 * answer as an unknown settlement instead of a 5xx an HTTP client might replay.
 * @param {{ fetch: (request: Request) => Promise<Response> }} stub
 * @param {Request} request
 */
async function forwardMcp(stub, request) {
  const copy = request.clone();
  let response;
  try {
    response = await stub.fetch(request);
  } catch {
    return relayFailure(copy);
  }
  copy.body?.cancel().catch(() => {});
  return response;
}

/**
 * HTTP 200 with JSON-RPC -32002 (echoing the id when the body parses), or an empty 200 for a
 * notification, matching the unknown-settlement rule.
 * @param {Request} copy an unread clone of the request
 */
async function relayFailure(copy) {
  const message = await readJson(copy);
  const data = { state: 'settlement_unknown', delivered: null, retried: false };
  if (!isPlainObject(message)) return json(200, rpcError(null, -32002, MESSAGES.relayFailure, data));
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (!hasId && typeof message.method === 'string') return empty(200);
  const id = typeof message.id === 'string' || Number.isSafeInteger(message.id) ? message.id : null;
  return json(200, rpcError(id, -32002, MESSAGES.relayFailure, data));
}

/**
 * The request body as JSON, or undefined when it is unreadable, too large or not JSON.
 * @param {Request} request
 * @returns {Promise<unknown>}
 */
async function readJson(request) {
  try {
    const bytes = await readBody(request, MCP_BODY_LIMIT_BYTES);
    return bytes ? parseJson(decodeUtf8(bytes)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Durable Object. A plain class with fetch() (no `cloudflare:workers` import), so the
 * module also loads in Node for tests. In-memory state (parked poll, hand-off list) lives as
 * long as this instance; OAuth state lives in its SQLite-backed storage.
 */
export class RelayObject {
  /**
   * @param {{ storage: import('./grants.js').Storage }} ctx
   * @param {import('./relay.js').Env} env
   */
  constructor(ctx, env) {
    this.relay = new Relay({ storage: ctx.storage, env });
  }

  /** @param {Request} request */
  fetch(request) {
    return this.relay.fetch(request);
  }
}
