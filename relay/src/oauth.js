// @ts-check
/**
 * OAuth 2.1 authorization server for Claude (MCP 2026-07-28 authorization spec): metadata,
 * client ID metadata documents (CIMD), dynamic client registration, the pairing-code consent
 * page, and the token endpoint with PKCE, refresh rotation and reuse detection.
 */

import { TTL, refreshTokenFamily } from './grants.js';
import { consentPage, cspOrigin, messagePage } from './pages.js';
import {
  constantTimeEqual,
  decodeUtf8,
  isPlainObject,
  json,
  mediaType,
  methodNotAllowed,
  normalizePairingCode,
  normalizeResource,
  param,
  parseJson,
  randomBase64url,
  readBody,
  readResponseLimited,
  sha256Base64url,
  sha256Hex,
  uniqueParams,
} from './util.js';

export const SCOPE = 'droidbridge';

const CLAUDE_CALLBACKS = Object.freeze([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);
const LOOPBACK_CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):([1-9][0-9]{0,4})\/callback$/;
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;
const DCR_CLIENT_ID = /^dbrcl_[A-Za-z0-9_-]{22}$/;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// C0/C1 control characters and the Unicode bidi overrides that could disguise a client name.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export const OAUTH_LIMITS = Object.freeze({
  formBytes: 16 * 1024,
  jsonBytes: 16 * 1024,
  cimdBytes: 16 * 1024,
  cimdTimeoutMs: 5000,
  cimdCacheMax: 20,
  pendingMax: 50,
  pendingPerClientMax: 10,
  clientsMax: 100,
  registrationsPerHour: 20,
  /** wrong codes before the pairing code itself is cancelled, across all consent requests */
  pairingMaxAttempts: 5,
  /** failed submissions before one consent request is discarded */
  requestMaxAttempts: 3,
  stateMaxLength: 2048,
  redirectUrisMax: 10,
  clientNameMax: 200,
  clientIdMax: 2048,
});

/**
 * The redirect policy shared by CIMD and DCR clients: Claude's two callbacks, the Claude Code
 * loopback callback on any port, or an exact URI the operator listed in EXTRA_REDIRECT_URIS.
 * @param {unknown} uri
 * @param {readonly string[]} extraRedirectUris
 */
export function redirectUriAllowed(uri, extraRedirectUris) {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  const loopback = LOOPBACK_CALLBACK.exec(uri);
  if (loopback) return Number(loopback[1]) <= 65535;
  return extraRedirectUris.includes(uri);
}

/**
 * EXTRA_REDIRECT_URIS: comma or whitespace separated absolute URIs. Only https URIs, or http on
 * localhost or 127.0.0.1, without fragment or userinfo, whose origin the consent page's CSP
 * form-action can name (a DNS name or IPv4 address, so no IPv6 literal such as `[::1]`), are
 * kept; anything else is ignored. A URI the browser would refuse to be redirected to after the
 * consent form is never accepted.
 * @param {unknown} value
 */
export function parseExtraRedirectUris(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((uri) => {
      if (uri.includes('#')) return false;
      try {
        const url = new URL(uri);
        if (url.username || url.password || cspOrigin(url.origin) === null) return false;
        if (url.protocol === 'https:') return true;
        return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      } catch {
        return false;
      }
    });
}

/**
 * Why a URL client_id may not be fetched as a client ID metadata document, or null if it may.
 * @param {string} clientId
 * @param {readonly string[]} allowedHosts
 */
export function cimdUrlProblem(clientId, allowedHosts) {
  let url;
  try {
    url = new URL(clientId);
  } catch {
    return 'The client_id is not a valid URL.';
  }
  if (url.protocol !== 'https:') return 'A URL client_id must use https.';
  if (!allowedHosts.includes(url.hostname)) {
    return 'This relay does not accept clients published by that host.';
  }
  if (url.username || url.password || url.port !== '' || clientId.includes('#')) {
    return 'The client_id URL must not contain userinfo, a port or a fragment.';
  }
  if (url.href !== clientId) return 'The client_id URL is not in normalized form.';
  if (url.pathname === '/' || url.pathname === '') return 'The client_id URL must have a path.';
  return null;
}

/**
 * @param {string | undefined} value
 * @returns {string | null} the granted scope, or null when something else was requested
 */
function parseScope(value) {
  if (value === undefined) return SCOPE;
  const parts = value.split(' ').filter(Boolean);
  if (parts.some((part) => part !== SCOPE)) return null;
  return SCOPE;
}

/**
 * A 302 to the client's redirect_uri. Existing query parameters are kept.
 * @param {string} redirectUri
 * @param {Record<string, string | undefined>} params
 */
function redirectTo(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * @param {number} status
 * @param {string} error
 * @param {string} description
 */
function tokenError(status, error, description) {
  return json(status, { error, error_description: description }, { Pragma: 'no-cache' });
}

/**
 * @typedef {{ client_id: string, client_name?: string, redirect_uris: string[], kind: 'cimd' | 'dcr' }} ResolvedClient
 * @typedef {import('./relay.js').Relay} Relay
 */

export class OAuthServer {
  /** @param {Relay} relay */
  constructor(relay) {
    this.relay = relay;
  }

  get storage() {
    return this.relay.storage;
  }

  // ---------------------------------------------------------------- metadata

  /**
   * @param {Request} request
   * @param {string} path
   * @param {string} origin
   */
  wellKnown(request, path, origin) {
    let body;
    switch (path) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        body = {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ['header'],
        };
        break;
      case '/.well-known/oauth-authorization-server':
      case '/.well-known/openid-configuration':
        body = {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [SCOPE],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        };
        break;
      default:
        return json(404, { error: 'not_found' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(['GET', 'HEAD']);
    return json(200, body, { 'Cache-Control': 'public, max-age=300' });
  }

  // ---------------------------------------------------------------- clients

  /**
   * Resolves a client_id to its registered redirect URIs: a DCR client stored here, or a CIMD
   * URL on an allowed host.
   * @param {string} clientId
   * @returns {Promise<{ client: ResolvedClient } | { error: string }>}
   */
  async resolveClient(clientId) {
    if (clientId.length > OAUTH_LIMITS.clientIdMax) return { error: 'The client_id is too long.' };
    if (DCR_CLIENT_ID.test(clientId)) {
      const stored = await this.storage.get(`client:${clientId}`);
      if (!stored) {
        return {
          error:
            'This client is not registered with this relay. Remove the connector in Claude and add it again.',
        };
      }
      return {
        client: {
          client_id: stored.client_id,
          client_name: stored.client_name,
          redirect_uris: stored.redirect_uris,
          kind: 'dcr',
        },
      };
    }
    if (URL_LIKE.test(clientId)) {
      const problem = cimdUrlProblem(clientId, this.relay.config.cimdHosts);
      if (problem) return { error: problem };
      return this.#fetchCimd(clientId);
    }
    return { error: 'This client is not registered with this relay.' };
  }

  /**
   * True when a client_id names a client this relay could have issued a code to.
   * @param {string} clientId
   */
  async #clientKnown(clientId) {
    if (DCR_CLIENT_ID.test(clientId)) return Boolean(await this.storage.get(`client:${clientId}`));
    return (
      clientId.length <= OAUTH_LIMITS.clientIdMax &&
      URL_LIKE.test(clientId) &&
      cimdUrlProblem(clientId, this.relay.config.cimdHosts) === null
    );
  }

  /**
   * Fetches (or reads from cache) a client ID metadata document: no redirects, 5 s timeout,
   * 16 KiB cap, cached at most 1 hour.
   * @param {string} clientId
   * @returns {Promise<{ client: ResolvedClient } | { error: string }>}
   */
  async #fetchCimd(clientId) {
    const key = `cimd:${await sha256Hex(clientId)}`;
    const cached = await this.storage.get(key);
    if (cached && cached.client_id === clientId && cached.expiresAt > this.relay.now()) {
      return {
        client: {
          client_id: cached.client_id,
          client_name: cached.client_name,
          redirect_uris: cached.redirect_uris,
          kind: 'cimd',
        },
      };
    }
    const failure = { error: "The client's metadata document could not be loaded or is not valid." };
    const download = await this.#downloadCimd(clientId);
    if (!download) return failure;
    const doc = parseJson(decodeUtf8(download.bytes));
    if (!isPlainObject(doc) || doc.client_id !== clientId) return failure;
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((uri) => typeof uri === 'string')) {
      return failure;
    }
    if (doc.client_name !== undefined && typeof doc.client_name !== 'string') return failure;
    const client = {
      client_id: clientId,
      client_name:
        typeof doc.client_name === 'string'
          ? doc.client_name.slice(0, OAUTH_LIMITS.clientNameMax)
          : undefined,
      redirect_uris: /** @type {string[]} */ (uris),
    };
    const ttl = cacheLifetime(download.cacheControl);
    if (ttl > 0) {
      await this.relay.lock.run(async () => {
        const now = this.relay.now();
        const entries = [...(await this.storage.list({ prefix: 'cimd:' }))].sort(
          (a, b) => (a[1]?.expiresAt ?? 0) - (b[1]?.expiresAt ?? 0),
        );
        let count = entries.length;
        for (const [entryKey, entry] of entries) {
          if (count < OAUTH_LIMITS.cimdCacheMax && entry?.expiresAt > now) break;
          if (entryKey === key) continue;
          await this.storage.delete(entryKey);
          count -= 1;
        }
        await this.storage.put(key, { ...client, expiresAt: now + ttl });
      });
    }
    return { client: { ...client, kind: 'cimd' } };
  }

  /**
   * Downloads a client metadata document: no redirects, at most cimdBytes, and cimdTimeoutMs for
   * the fetch and the body together. The deadline runs on the relay's timers, so tests can hold
   * the fetch at the boundary with a fake clock. Null on any failure, a timer failure included.
   * @param {string} clientId
   * @returns {Promise<{ bytes: Uint8Array, cacheControl: string | null } | null>}
   */
  async #downloadCimd(clientId) {
    const controller = new AbortController();
    /** @type {unknown} */
    let timer;
    try {
      timer = this.relay.timers.setTimeout(() => controller.abort(), OAUTH_LIMITS.cimdTimeoutMs);
      // Workers implement only "follow" and "manual"; with "manual" any redirect surfaces as a
      // 3xx status, which is refused below, so no redirect is ever followed.
      const response = await this.relay.fetchFn(clientId, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readResponseLimited(response, OAUTH_LIMITS.cimdBytes);
      return bytes ? { bytes, cacheControl: response.headers.get('cache-control') } : null;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) {
        try {
          this.relay.timers.clearTimeout(timer);
        } catch {
          // A timer left running only aborts a download that has already finished.
        }
      }
    }
  }

  // ---------------------------------------------------------------- /authorize

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {string} origin
   */
  authorize(request, url, origin) {
    if (request.method === 'GET') return this.#authorizeGet(url, origin);
    if (request.method === 'POST') return this.#authorizePost(request, url, origin);
    return methodNotAllowed(['GET', 'POST']);
  }

  /**
   * @param {URL} url
   * @param {string} origin
   */
  async #authorizeGet(url, origin) {
    const params = uniqueParams(url.searchParams);
    if (!params) {
      return messagePage(400, 'Invalid authorization request', 'A parameter was repeated in the authorization request.');
    }
    const clientId = param(params, 'client_id');
    const redirectUri = param(params, 'redirect_uri');
    if (!clientId) {
      return messagePage(400, 'Invalid authorization request', 'The authorization request has no client_id.');
    }
    if (!redirectUri) {
      return messagePage(400, 'Invalid authorization request', 'The authorization request has no redirect_uri.');
    }
    const resolved = await this.resolveClient(clientId);
    if ('error' in resolved) return messagePage(400, 'Unknown client', resolved.error);
    const client = resolved.client;
    if (
      !client.redirect_uris.includes(redirectUri) ||
      !redirectUriAllowed(redirectUri, this.relay.config.extraRedirectUris)
    ) {
      return messagePage(
        400,
        'Redirect not allowed',
        'The redirect_uri is not registered for this client or is not allowed by this relay.',
      );
    }

    // The client and redirect_uri are trusted from here on, so errors go back to the client.
    const state = param(params, 'state');
    if (state !== undefined && state.length > OAUTH_LIMITS.stateMaxLength) {
      return redirectTo(redirectUri, {
        error: 'invalid_request',
        error_description: 'The state parameter is too long.',
        iss: origin,
      });
    }
    /** @param {string} error @param {string} description */
    const fail = (error, description) =>
      redirectTo(redirectUri, { error, error_description: description, state, iss: origin });
    if (param(params, 'response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (param(params, 'code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const codeChallenge = param(params, 'code_challenge');
    if (!codeChallenge || !PKCE_VALUE.test(codeChallenge)) {
      return fail('invalid_request', 'code_challenge must be 43 to 128 unreserved characters.');
    }
    const scope = parseScope(param(params, 'scope'));
    if (!scope) return fail('invalid_scope', `Only the ${SCOPE} scope is supported.`);
    const resource = /** @type {string} */ (normalizeResource(`${origin}/mcp`));
    const requestedResource = param(params, 'resource');
    if (requestedResource !== undefined && normalizeResource(requestedResource) !== resource) {
      return fail('invalid_target', `The resource must be ${origin}/mcp.`);
    }

    await this.relay.maybeSweep();
    return this.relay.lock.run(async () => {
      const now = this.relay.now();
      let live = 0;
      let liveForClient = 0;
      for (const [key, record] of await this.storage.list({ prefix: 'pending:' })) {
        if (!record || record.expiresAt <= now) {
          await this.storage.delete(key);
          continue;
        }
        live += 1;
        if (record.client_id === client.client_id) liveForClient += 1;
      }
      // A global cap, and a per-client cap so one client cannot take every slot.
      if (live >= OAUTH_LIMITS.pendingMax || liveForClient >= OAUTH_LIMITS.pendingPerClientMax) {
        return messagePage(
          429,
          'Too many waiting requests',
          'Too many authorization requests are waiting for approval. Wait a few minutes, then start connecting again from Claude.',
        );
      }
      const requestId = randomBase64url(this.relay.random);
      const pending = {
        client_id: client.client_id,
        client_name: client.client_name,
        client_kind: client.kind,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        state,
        resource,
        scope,
        attempts: 0,
        expiresAt: now + TTL.pendingMs,
      };
      await this.storage.put(`pending:${await sha256Hex(requestId)}`, pending);
      return consentPage({
        clientName: pending.client_name,
        clientId: pending.client_id,
        clientKind: pending.client_kind,
        redirectUri,
        requestId,
      });
    });
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {string} origin
   */
  async #authorizePost(request, url, origin) {
    const unreadable = () =>
      messagePage(400, 'Invalid request', 'The form could not be read. Start connecting again from Claude.');
    if (mediaType(request) !== 'application/x-www-form-urlencoded') return unreadable();
    const bytes = await readBody(request, OAUTH_LIMITS.formBytes);
    if (!bytes) return messagePage(413, 'Invalid request', 'The form is too large.');
    const text = decodeUtf8(bytes);
    const form = text === null ? null : uniqueParams(new URLSearchParams(text));
    if (!form) return unreadable();
    // A browser posting this form sends Origin: null (the page sets Referrer-Policy: no-referrer)
    // or our own origin. Any other explicit origin is a cross-site post.
    const postedFrom = request.headers.get('origin');
    if (postedFrom && postedFrom !== 'null' && postedFrom !== origin && postedFrom !== url.origin) {
      return messagePage(403, 'Request refused', 'This form was submitted from another site.');
    }
    const requestId = param(form, 'request_id');
    const expired = () =>
      messagePage(
        400,
        'Request expired',
        'This authorization request has expired or was already answered. Start connecting again from Claude.',
      );
    if (!requestId || requestId.length > 128) return expired();

    return this.relay.lock.run(async () => {
      const now = this.relay.now();
      const pendingKey = `pending:${await sha256Hex(requestId)}`;
      const pending = await this.storage.get(pendingKey);
      if (!pending || pending.expiresAt <= now) {
        if (pending) await this.storage.delete(pendingKey);
        return expired();
      }
      /** @param {number} status @param {string} notice */
      const again = (status, notice) =>
        consentPage({
          status,
          clientName: pending.client_name,
          clientId: pending.client_id,
          clientKind: pending.client_kind,
          redirectUri: pending.redirect_uri,
          requestId,
          notice,
        });

      const action = param(form, 'action');
      if (action === 'deny') {
        await this.storage.delete(pendingKey);
        return redirectTo(pending.redirect_uri, {
          error: 'access_denied',
          error_description: 'The request was denied on the DroidBridge relay consent page.',
          state: pending.state,
          iss: origin,
        });
      }
      if (action !== 'allow') return again(400, 'Choose Allow or Deny.');

      const typed = param(form, 'pairing_code') ?? '';
      if (!typed.trim()) return again(400, 'Enter the pairing code shown in DroidBridge.');
      const stored = await this.storage.get('pairing');
      const pairing = stored && stored.expiresAt > now ? stored : null;
      if (stored && !pairing) await this.storage.delete('pairing');
      const normalized = typed.length <= 64 ? normalizePairingCode(typed) : '';
      const typedHash = await sha256Hex(normalized);
      if (!pairing || !constantTimeEqual(typedHash, pairing.hash)) {
        // A wrong code and a missing or expired pairing get the same answer, so this page never
        // reveals whether a pairing code is active. Both count against this consent request.
        if (pairing) {
          const attempts = (Number(pairing.attempts) || 0) + 1;
          if (attempts >= OAUTH_LIMITS.pairingMaxAttempts) await this.storage.delete('pairing');
          else await this.storage.put('pairing', { ...pairing, attempts });
        }
        const requestAttempts = (Number(pending.attempts) || 0) + 1;
        if (requestAttempts >= OAUTH_LIMITS.requestMaxAttempts) {
          await this.storage.delete(pendingKey);
          return messagePage(
            403,
            'Request cancelled',
            'The pairing code was not accepted 3 times, so this request was cancelled. In DroidBridge, tap Pair Claude for a new code, then start connecting again from Claude.',
          );
        }
        await this.storage.put(pendingKey, { ...pending, attempts: requestAttempts });
        return again(
          403,
          'That code did not work. In DroidBridge, tap Pair Claude and type the code it shows. Each code works once, for up to 10 minutes.',
        );
      }

      await this.storage.delete('pairing');
      await this.storage.delete(pendingKey);
      const code = `dbrc_${randomBase64url(this.relay.random)}`;
      await this.storage.put(`code:${await sha256Hex(code)}`, {
        client_id: pending.client_id,
        redirect_uri: pending.redirect_uri,
        code_challenge: pending.code_challenge,
        resource: pending.resource,
        scope: pending.scope,
        expiresAt: now + TTL.codeMs,
        purgeAt: now + TTL.codeMs + TTL.codeRetentionMs,
        usedAt: null,
        family: null,
      });
      return redirectTo(pending.redirect_uri, { code, state: pending.state, iss: origin });
    });
  }

  // ---------------------------------------------------------------- /token

  /** @param {Request} request */
  async token(request) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    if (mediaType(request) !== 'application/x-www-form-urlencoded') {
      return tokenError(400, 'invalid_request', 'Send the token request as application/x-www-form-urlencoded.');
    }
    const bytes = await readBody(request, OAUTH_LIMITS.formBytes);
    if (!bytes) return tokenError(413, 'invalid_request', 'The token request is too large.');
    const text = decodeUtf8(bytes);
    const form = text === null ? null : uniqueParams(new URLSearchParams(text));
    if (!form) return tokenError(400, 'invalid_request', 'The token request is malformed or repeats a parameter.');
    const grantType = param(form, 'grant_type');
    if (!grantType) return tokenError(400, 'invalid_request', 'grant_type is required.');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return tokenError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
    }
    await this.relay.maybeSweep();
    return this.relay.lock.run(() =>
      grantType === 'authorization_code' ? this.#redeemCode(form) : this.#refresh(form),
    );
  }

  /** @param {Map<string, string>} form */
  async #redeemCode(form) {
    const code = param(form, 'code');
    const redirectUri = param(form, 'redirect_uri');
    const clientId = param(form, 'client_id');
    const verifier = param(form, 'code_verifier');
    const resource = param(form, 'resource');
    const key = code ? `code:${await sha256Hex(code)}` : null;
    const record = key ? await this.storage.get(key) : undefined;
    if (key && record?.usedAt) {
      // RFC 6749 section 4.1.2: a replayed code revokes every token issued from it. This runs
      // before every other parameter check, so a replay revokes whatever client_id,
      // redirect_uri or code_verifier comes with it, like a replayed refresh token. token()
      // has only checked that the request is well formed (form-encoded, within the size cap,
      // no repeated parameter, a supported grant_type); one that is not is refused unread.
      await this.relay.grants.revokeFamily(record.family);
      await this.storage.put(key, { ...record, family: null });
      return tokenError(400, 'invalid_grant', 'The authorization code was already used. Tokens issued from it were revoked.');
    }
    if (!key || !redirectUri || !clientId || !verifier) {
      return tokenError(400, 'invalid_request', 'code, redirect_uri, client_id and code_verifier are required.');
    }
    if (!PKCE_VALUE.test(verifier)) {
      return tokenError(400, 'invalid_request', 'code_verifier must be 43 to 128 unreserved characters.');
    }
    if (!(await this.#clientKnown(clientId))) {
      return tokenError(401, 'invalid_client', 'The client is not known to this relay.');
    }
    if (!record) return tokenError(400, 'invalid_grant', 'The authorization code is not valid.');
    const now = this.relay.now();
    if (record.expiresAt <= now) return tokenError(400, 'invalid_grant', 'The authorization code has expired.');
    // Consumed from here on, whether or not the checks below pass.
    record.usedAt = now;
    await this.storage.put(key, record);
    if (record.client_id !== clientId) {
      return tokenError(400, 'invalid_grant', 'The authorization code was issued to another client.');
    }
    if (record.redirect_uri !== redirectUri) {
      return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    }
    if (resource !== undefined && normalizeResource(resource) !== record.resource) {
      return tokenError(400, 'invalid_target', 'resource does not match the authorization request.');
    }
    if (!constantTimeEqual(await sha256Base64url(verifier), record.code_challenge)) {
      return tokenError(400, 'invalid_grant', 'PKCE verification failed.');
    }
    const { family, tokens } = await this.relay.grants.createFamily({
      client_id: record.client_id,
      resource: record.resource,
      scope: record.scope,
    });
    record.family = family.id;
    await this.storage.put(key, record);
    return this.#tokenResponse(tokens, record.scope);
  }

  /** @param {Map<string, string>} form */
  async #refresh(form) {
    const refreshToken = param(form, 'refresh_token');
    const clientId = param(form, 'client_id');
    if (!refreshToken) return tokenError(400, 'invalid_request', 'refresh_token and client_id are required.');
    const key = `rt:${await sha256Hex(refreshToken)}`;
    const record = await this.storage.get(key);
    const now = this.relay.now();
    if (!record || record.used) {
      // A rotated refresh token came back: someone holds a copy. Revoke the whole grant. Its
      // record may already be trimmed or purged, so the family id inside the token decides.
      // This runs before every other parameter check, so a replay revokes whatever client_id
      // and scope come with it, or none. Only a live grant counts: a family past its expiry
      // (its newest refresh token has expired, so none of its tokens is live) is just waiting
      // for the sweep, and there is nothing to revoke.
      const familyId = record ? record.family : refreshTokenFamily(refreshToken);
      const family = familyId ? await this.storage.get(`family:${familyId}`) : undefined;
      if (family && typeof family.expiresAt === 'number' && family.expiresAt > now) {
        await this.relay.grants.revokeFamily(familyId);
        return tokenError(400, 'invalid_grant', 'The refresh token was already used. The grant was revoked.');
      }
      return tokenError(400, 'invalid_grant', 'The refresh token is not valid.');
    }
    if (!clientId) return tokenError(400, 'invalid_request', 'refresh_token and client_id are required.');
    if (!parseScope(param(form, 'scope'))) {
      return tokenError(400, 'invalid_scope', `Only the ${SCOPE} scope is supported.`);
    }
    if (!(await this.#clientKnown(clientId))) {
      return tokenError(401, 'invalid_client', 'The client is not known to this relay.');
    }
    if (record.expiresAt <= now) {
      // The record stays until the sweep purges it with its family, so presenting the token
      // again gets this same answer, never one that claims it was used.
      return tokenError(400, 'invalid_grant', 'The refresh token has expired.');
    }
    if (record.client_id !== clientId) {
      return tokenError(400, 'invalid_grant', 'The refresh token was issued to another client.');
    }
    const family = await this.storage.get(`family:${record.family}`);
    if (!family) return tokenError(400, 'invalid_grant', 'The grant was revoked.');
    const resource = param(form, 'resource');
    if (resource !== undefined && normalizeResource(resource) !== family.resource) {
      return tokenError(400, 'invalid_target', 'resource does not match the grant.');
    }
    await this.storage.put(key, { ...record, used: true });
    const tokens = await this.relay.grants.issue(family);
    return this.#tokenResponse(tokens, family.scope);
  }

  /**
   * @param {{ access_token: string, refresh_token: string, expires_in: number }} tokens
   * @param {string} scope
   */
  #tokenResponse(tokens, scope) {
    return json(
      200,
      {
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope,
      },
      { Pragma: 'no-cache' },
    );
  }

  // ---------------------------------------------------------------- /register

  /** @param {Request} request */
  async register(request) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    /** @param {number} status @param {string} error @param {string} description */
    const fail = (status, error, description) => json(status, { error, error_description: description });
    if (mediaType(request) !== 'application/json') {
      return fail(400, 'invalid_client_metadata', 'Send the client metadata as application/json.');
    }
    const bytes = await readBody(request, OAUTH_LIMITS.jsonBytes);
    if (!bytes) return fail(413, 'invalid_client_metadata', 'The client metadata is too large.');
    const body = parseJson(decodeUtf8(bytes));
    if (!isPlainObject(body)) return fail(400, 'invalid_client_metadata', 'The client metadata must be a JSON object.');

    const authMethod = body.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      return fail(400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") can register.');
    }
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > OAUTH_LIMITS.redirectUrisMax ||
      !uris.every((uri) => typeof uri === 'string')
    ) {
      return fail(400, 'invalid_redirect_uri', `redirect_uris must list 1 to ${OAUTH_LIMITS.redirectUrisMax} URIs.`);
    }
    if (!uris.every((uri) => redirectUriAllowed(uri, this.relay.config.extraRedirectUris))) {
      return fail(400, 'invalid_redirect_uri', 'A redirect URI is not allowed by this relay.');
    }
    if (!subsetOf(body.grant_types, ['authorization_code', 'refresh_token'])) {
      return fail(400, 'invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported.');
    }
    if (!subsetOf(body.response_types, ['code'])) {
      return fail(400, 'invalid_client_metadata', 'Only the code response type is supported.');
    }
    const name = body.client_name;
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length > OAUTH_LIMITS.clientNameMax || UNSAFE_NAME_CHARS.test(name))
    ) {
      return fail(400, 'invalid_client_metadata', `client_name must be plain text of at most ${OAUTH_LIMITS.clientNameMax} characters.`);
    }

    await this.relay.maybeSweep();
    return this.relay.lock.run(async () => {
      const now = this.relay.now();
      const hourAgo = now - 60 * 60 * 1000;
      /** @type {number[]} */
      const recent = ((await this.storage.get('rl:register')) ?? []).filter(
        (/** @type {unknown} */ at) => typeof at === 'number' && at > hourAgo,
      );
      if (recent.length >= OAUTH_LIMITS.registrationsPerHour) {
        const retryAfter = Math.max(1, Math.ceil((Math.min(...recent) - hourAgo) / 1000));
        return json(
          429,
          { error: 'too_many_requests', error_description: 'Too many client registrations. Try again later.' },
          { 'Retry-After': String(retryAfter) },
        );
      }
      const clients = await this.storage.list({ prefix: 'client:' });
      if (clients.size >= OAUTH_LIMITS.clientsMax) {
        const live = await this.relay.grants.liveClientIds();
        const evictable = [...clients.values()]
          .filter((client) => !live.has(client.client_id))
          .sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
        if (evictable.length === 0) {
          return fail(400, 'invalid_client_metadata', 'This relay already holds the maximum number of registered clients.');
        }
        await this.storage.delete(`client:${evictable[0].client_id}`);
      }
      const record = {
        client_id: `dbrcl_${randomBase64url(this.relay.random, 16)}`,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: typeof name === 'string' ? name : undefined,
        redirect_uris: /** @type {string[]} */ ([...uris]),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
      await this.storage.put(`client:${record.client_id}`, { ...record, created_ms: now });
      recent.push(now);
      await this.storage.put('rl:register', recent);
      return json(201, record);
    });
  }
}

/**
 * @param {unknown} value
 * @param {string[]} allowed
 */
function subsetOf(value, allowed) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && allowed.includes(item));
}

/**
 * How long a client metadata document may be cached: at most one hour, less if the publisher
 * says so, and not at all for no-store / no-cache.
 * @param {string | null} cacheControl
 */
function cacheLifetime(cacheControl) {
  const value = cacheControl ?? '';
  if (/(?:^|[\s,])(?:no-store|no-cache)(?:$|[\s,=])/i.test(value)) return 0;
  const maxAge = /(?:^|[\s,])max-age=(\d+)/i.exec(value);
  const limit = TTL.cimdMaxMs;
  return maxAge ? Math.min(limit, Number(maxAge[1]) * 1000) : limit;
}
