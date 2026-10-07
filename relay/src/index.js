// @ts-check
/**
 * Worker entry. Every relay route goes to one Durable Object instance, so the parked phone
 * poll, the hand-off list and the OAuth state all live in one place.
 */

import { RELAY_ANSWER_HEADER, readMcpMessage, relayFailureAnswer } from './mcp.js';
import { Relay } from './relay.js';
import { text } from './util.js';

const EXACT_ROUTES = new Set(['/mcp', '/authorize', '/token', '/register']);

/** @param {string} pathname */
export function isRelayRoute(pathname) {
  return (
    EXACT_ROUTES.has(pathname) || pathname.startsWith('/device/') || pathname.startsWith('/.well-known/')
  );
}

/**
 * @typedef {{ fetch: (request: Request) => Promise<Response> }} Stub
 * @typedef {{ RELAY: { idFromName: (name: string) => unknown, get: (id: any) => Stub } }} WorkerEnv
 */

/**
 * The single Durable Object instance every relay route goes to.
 * @param {WorkerEnv} env
 */
function relayStub(env) {
  return env.RELAY.get(env.RELAY.idFromName('relay'));
}

export default {
  /**
   * @param {Request} request
   * @param {WorkerEnv} env
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isRelayRoute(pathname)) {
      if (pathname === '/mcp' && request.method === 'POST') return forwardMcp(env, request);
      return relayStub(env).fetch(request);
    }
    if (pathname === '/') {
      if (request.method === 'GET' || request.method === 'HEAD') return text(200, 'DroidBridge relay');
      return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    return text(404, 'Not found');
  },
};

/**
 * Forwards POST /mcp to the Durable Object. If the object fails (reset, deploy, network) or
 * answers with a 5xx it did not mean (one without its answer marker), the request may or may
 * not have reached the phone, so Claude gets the same final, non-retryable answer as an unknown
 * settlement (HTTP 200, JSON-RPC -32002, delivered null) instead of a 5xx an HTTP client might
 * replay. If the object cannot even be addressed, the request provably went nowhere (delivered
 * false). The object's deliberate answers, including its 503 for "not delivered", pass through
 * with the internal marker removed, once their body has been read in full.
 * @param {WorkerEnv} env
 * @param {Request} request
 */
async function forwardMcp(env, request) {
  const copy = request.clone();
  let stub;
  try {
    stub = relayStub(env);
  } catch {
    return relayFailure(copy, false);
  }
  let response;
  /** @type {ArrayBuffer} */
  let body;
  try {
    response = await stub.fetch(request);
    if (response.status >= 500 && !response.headers.has(RELAY_ANSWER_HEADER)) {
      response.body?.cancel().catch(() => {});
      return relayFailure(copy, null);
    }
    // The whole answer is read here, inside the failure handling: a body that breaks off after
    // the status (the object reset while sending a large phone reply) becomes the final
    // -32002 answer, never a truncated 200 that is not a JSON-RPC response.
    body = await response.arrayBuffer();
  } catch {
    return relayFailure(copy, null);
  }
  copy.body?.cancel().catch(() => {});
  const headers = new Headers(response.headers);
  headers.delete(RELAY_ANSWER_HEADER);
  return new Response(body.byteLength > 0 ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * HTTP 200 with JSON-RPC -32002 (echoing the id when the body parses), or an empty 200 for a
 * notification.
 * @param {Request} copy an unread clone of the request
 * @param {false | null} delivered false when the object was never reached, else unknown (null)
 */
async function relayFailure(copy, delivered) {
  return relayFailureAnswer(await readMcpMessage(copy), delivered);
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
