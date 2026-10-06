// @ts-check
/**
 * Durable OAuth state. Only SHA-256 hashes (lowercase hex) of access tokens, refresh tokens,
 * authorization codes, consent request ids and the pairing code are ever stored.
 *
 * Keys (Durable Object storage):
 *   pairing               { hash, expiresAt, attempts }
 *   pending:<sha256(id)>  pending consent request, 10 min
 *   code:<sha256(code)>   authorization code, 60 s (kept 10 more minutes for reuse detection)
 *   at:<sha256(token)>    access token { family, client_id, resource, scope, expiresAt }
 *   rt:<sha256(token)>    refresh token { family, client_id, used, expiresAt }
 *   family:<id>           grant from one code exchange { access[], refresh[], ... }
 *   client:<client_id>    dynamically registered client
 *   cimd:<sha256(url)>    cached client ID metadata document, at most 1 h
 *   rl:register           registration timestamps of the last hour
 *
 * Every collection is bounded: pending consents (50), clients (100), cached documents (20),
 * and per family 8 access and 16 refresh hashes; codes need the phone's pairing code.
 */

import { randomBase64url, sha256Hex } from './util.js';

export const TTL = {
  accessMs: 60 * 60 * 1000,
  refreshMs: 30 * 24 * 60 * 60 * 1000,
  codeMs: 60 * 1000,
  codeRetentionMs: 10 * 60 * 1000,
  pendingMs: 10 * 60 * 1000,
  cimdMaxMs: 60 * 60 * 1000,
};

const FAMILY_ACCESS_KEEP = 8;
const FAMILY_REFRESH_KEEP = 16;
const EXPIRING_PREFIXES = ['pending:', 'code:', 'at:', 'rt:', 'cimd:'];

/**
 * @typedef {{ get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<boolean>, list: (options: { prefix: string }) => Promise<Map<string, any>> }} Storage
 * @typedef {{ id: string, client_id: string, resource: string, scope: string, created_at: number,
 *   access: string[], refresh: string[], expiresAt: number }} Family
 */

export class GrantStore {
  /**
   * @param {{ storage: Storage, now: () => number, random: (n: number) => Uint8Array }} deps
   */
  constructor({ storage, now, random }) {
    this.storage = storage;
    this.now = now;
    this.random = random;
  }

  /**
   * Finds a live access token record.
   * @param {string} token
   */
  async lookupAccess(token) {
    const record = await this.storage.get(`at:${await sha256Hex(token)}`);
    if (!record || record.expiresAt <= this.now()) return null;
    return record;
  }

  /**
   * Starts a token family for a redeemed authorization code and issues its first tokens.
   * @param {{ client_id: string, resource: string, scope: string }} grant
   */
  async createFamily({ client_id, resource, scope }) {
    /** @type {Family} */
    const family = {
      id: randomBase64url(this.random, 16),
      client_id,
      resource,
      scope,
      created_at: this.now(),
      access: [],
      refresh: [],
      expiresAt: 0,
    };
    const tokens = await this.issue(family);
    return { family, tokens };
  }

  /**
   * Issues a new access/refresh pair into a family and stores it. Old hashes beyond the
   * per-family limits are deleted, which keeps storage bounded however often a client refreshes.
   * @param {Family} family
   */
  async issue(family) {
    const now = this.now();
    const accessToken = `dbra_${randomBase64url(this.random)}`;
    const refreshToken = `dbrr_${randomBase64url(this.random)}`;
    const accessHash = await sha256Hex(accessToken);
    const refreshHash = await sha256Hex(refreshToken);
    await this.storage.put(`at:${accessHash}`, {
      family: family.id,
      client_id: family.client_id,
      resource: family.resource,
      scope: family.scope,
      expiresAt: now + TTL.accessMs,
    });
    await this.storage.put(`rt:${refreshHash}`, {
      family: family.id,
      client_id: family.client_id,
      used: false,
      expiresAt: now + TTL.refreshMs,
    });
    family.access.push(accessHash);
    family.refresh.push(refreshHash);
    while (family.access.length > FAMILY_ACCESS_KEEP) {
      await this.storage.delete(`at:${family.access.shift()}`);
    }
    while (family.refresh.length > FAMILY_REFRESH_KEEP) {
      await this.storage.delete(`rt:${family.refresh.shift()}`);
    }
    family.expiresAt = now + TTL.refreshMs;
    await this.storage.put(`family:${family.id}`, family);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Math.floor(TTL.accessMs / 1000),
    };
  }

  /**
   * Revokes a whole family: every access and refresh token issued in it.
   * @param {string | undefined | null} familyId
   * @returns {Promise<number>} live tokens revoked
   */
  async revokeFamily(familyId) {
    if (!familyId) return 0;
    /** @type {Family | undefined} */
    const family = await this.storage.get(`family:${familyId}`);
    if (!family) return 0;
    const now = this.now();
    let revoked = 0;
    for (const hash of family.access) {
      const record = await this.storage.get(`at:${hash}`);
      if (record && record.expiresAt > now) revoked += 1;
      await this.storage.delete(`at:${hash}`);
    }
    for (const hash of family.refresh) {
      const record = await this.storage.get(`rt:${hash}`);
      if (record && !record.used && record.expiresAt > now) revoked += 1;
      await this.storage.delete(`rt:${hash}`);
    }
    await this.storage.delete(`family:${familyId}`);
    return revoked;
  }

  /**
   * Client ids holding at least one live access token or live, unused refresh token.
   * @returns {Promise<Set<string>>}
   */
  async liveClientIds() {
    const now = this.now();
    /** @type {Set<string>} */
    const ids = new Set();
    for (const record of (await this.storage.list({ prefix: 'at:' })).values()) {
      if (record.expiresAt > now) ids.add(record.client_id);
    }
    for (const record of (await this.storage.list({ prefix: 'rt:' })).values()) {
      if (!record.used && record.expiresAt > now) ids.add(record.client_id);
    }
    return ids;
  }

  /**
   * Revokes every Claude grant: tokens, families, codes, pending consents, registered clients,
   * cached client documents and the pairing code.
   * @returns {Promise<number>} live access and refresh tokens revoked
   */
  async revokeAll() {
    const now = this.now();
    let revoked = 0;
    for (const [key, record] of await this.storage.list({ prefix: 'at:' })) {
      if (record.expiresAt > now) revoked += 1;
      await this.storage.delete(key);
    }
    for (const [key, record] of await this.storage.list({ prefix: 'rt:' })) {
      if (!record.used && record.expiresAt > now) revoked += 1;
      await this.storage.delete(key);
    }
    for (const prefix of ['family:', 'code:', 'pending:', 'client:', 'cimd:']) {
      for (const key of (await this.storage.list({ prefix })).keys()) await this.storage.delete(key);
    }
    await this.storage.delete('pairing');
    return revoked;
  }

  /** Deletes every expired record. Bounded by the collection caps above. */
  async sweep() {
    const now = this.now();
    for (const prefix of EXPIRING_PREFIXES) {
      for (const [key, record] of await this.storage.list({ prefix })) {
        const until = record?.purgeAt ?? record?.expiresAt;
        if (typeof until !== 'number' || until <= now) await this.storage.delete(key);
      }
    }
    for (const [key, family] of await this.storage.list({ prefix: 'family:' })) {
      if (family && typeof family.expiresAt === 'number' && family.expiresAt > now) continue;
      if (family?.id) await this.revokeFamily(family.id);
      await this.storage.delete(key);
    }
    const pairing = await this.storage.get('pairing');
    if (pairing && pairing.expiresAt <= now) await this.storage.delete('pairing');
  }
}
