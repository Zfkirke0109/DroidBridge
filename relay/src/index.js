// @ts-check
/**
 * Worker entry. Every relay route goes to one Durable Object instance, so the parked phone
 * poll, the hand-off list and the OAuth state all live in one place.
 */

import { Relay } from './relay.js';
import { text } from './util.js';

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
