// @ts-check
/**
 * In-memory hand-off between Claude's MCP requests and the phone's long polls.
 *
 * Nothing here is persisted. If the Durable Object is evicted, requests in flight fail and are
 * never replayed. Every entry ends in exactly one outcome:
 *
 *   offline      no poll waiting and none ended within the online grace: not delivered
 *   busy         too many requests in flight: not delivered
 *   unavailable  online, but no poll arrived within the hand-off window, or Claude gave up
 *                before a poll took it: not delivered
 *   settled      delivered, and the phone posted a response with the right shard token
 *   invalid      delivered, and the phone posted a reply that could not be read (too large,
 *                not JSON, or no request_id) carrying the request's shard token
 *   unknown      delivered, and no response arrived before the deadline
 *
 * A command is "delivered" the moment it is placed into a poll response body, and it is
 * removed from the hand-off list at that moment, so no later poll can see it again.
 *
 * Delivery is all or nothing. Each command is encoded to its wire form (JSON text) when it is
 * submitted, so a poll response body is only joined strings and cannot fail to build after its
 * commands were marked delivered. The wire form carries the JSON-RPC message as the text Claude
 * sent, never re-encoded (see encodeCommand). Every deadline timer a poll needs is armed before
 * anything changes: if arming one fails, no command of that poll is marked delivered, every one
 * of them stays in the hand-off list (or the parked poll stays parked), and the failure surfaces
 * to the caller. So a delivered command always has a deadline, and a command is never reported
 * as delivered unless its poll response body exists.
 */

import { constantTimeEqual } from './util.js';

/**
 * @typedef {{ kind: 'offline' } | { kind: 'busy' } | { kind: 'unavailable' } | { kind: 'unknown' }
 *   | { kind: 'invalid' } | { kind: 'settled', payload: Record<string, any>, source: string }} Outcome
 *   a settled outcome carries the phone's reply parsed (payload) and as JSON text (source)
 * @typedef {{
 *   id: string, shardToken: string, command: Record<string, any>, wire: string,
 *   state: 'handoff' | 'delivered' | 'done', settleWithinMs: number,
 *   resolve: (outcome: Outcome) => void, timer: unknown, detach: () => void,
 *   onDelivered: () => void
 * }} Entry
 * @typedef {{ resolve: (commands: string[]) => void, timer: unknown, detach: () => void }} ParkedPoll
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: unknown) => void }} Timers
 */

/**
 * The wire form of a command: its fields as JSON, with the JSON-RPC message added as the member
 * `jsonrpc` exactly as the given JSON text. Throws when the fields cannot be encoded.
 * @param {Record<string, any>} command the fields, without `jsonrpc`
 * @param {string} jsonrpc the message as JSON text, already validated
 */
export function encodeCommand(command, jsonrpc) {
  if (typeof jsonrpc !== 'string') throw new TypeError('the message must be JSON text');
  if (Object.prototype.hasOwnProperty.call(command, 'jsonrpc')) throw new TypeError('jsonrpc is added here');
  const fields = JSON.stringify(command);
  if (typeof fields !== 'string' || !fields.startsWith('{')) throw new TypeError('a command must be an object');
  return `${fields === '{}' ? '{' : `${fields.slice(0, -1)},`}"jsonrpc":${jsonrpc}}`;
}

export class DeviceHub {
  /**
   * @param {{ now: () => number, timers: Timers,
   *   timings: { onlineGraceMs: number, handoffMs: number }, maxInFlight: number }} options
   */
  constructor({ now, timers, timings, maxInFlight }) {
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.maxInFlight = maxInFlight;
    /** @type {Map<string, Entry>} every request not yet answered, by request_id */
    this.entries = new Map();
    /** @type {Entry[]} waiting for the next poll, oldest first */
    this.handoff = [];
    /** @type {ParkedPoll | null} */
    this.parked = null;
    /** @type {number | null} */
    this.lastPollEndedAt = null;
  }

  /** The phone counts as online while a poll is parked or shortly after one ended. */
  isOnline() {
    if (this.parked) return true;
    return (
      this.lastPollEndedAt !== null &&
      this.now() - this.lastPollEndedAt <= this.timings.onlineGraceMs
    );
  }

  /**
   * Offers a command to the phone. Resolves once the request has an outcome. `onDelivered` runs
   * at the moment the command is placed into a poll response. Throws (leaving the hub
   * unchanged) when the command cannot be encoded or a timer cannot be armed.
   * @param {Record<string, any>} command the command's fields, without `jsonrpc`
   * @param {string} jsonrpc the JSON-RPC message as JSON text, sent to the phone as it is
   * @param {{ configured: boolean, settleWithinMs: number, signal?: AbortSignal | null,
   *   onDelivered?: () => void }} options
   * @returns {Promise<Outcome>}
   */
  submit(command, jsonrpc, { configured, settleWithinMs, signal, onDelivered = () => {} }) {
    if (!configured || !this.isOnline()) return Promise.resolve({ kind: 'offline' });
    // Claude already gave up (its request was aborted while it was authenticated or read):
    // the command is never offered to the phone.
    if (signal?.aborted) return Promise.resolve({ kind: 'unavailable' });
    if (this.entries.size >= this.maxInFlight) return Promise.resolve({ kind: 'busy' });
    // Encoded before anything changes, on either path, so a command that cannot be encoded is
    // never held.
    const wire = encodeCommand(command, jsonrpc);
    /** @type {(outcome: Outcome) => void} */
    let resolve = () => {};
    /** @type {Promise<Outcome>} */
    const outcome = new Promise((settle) => {
      resolve = settle;
    });
    /** @type {Entry} */
    const entry = {
      id: command.request_id,
      shardToken: command.shard_token,
      command,
      wire,
      state: 'handoff',
      settleWithinMs,
      resolve,
      timer: undefined,
      detach: () => {},
      onDelivered,
    };
    const poll = this.parked;
    if (poll) {
      // Armed before anything changes: if this throws, the poll stays parked and the hub
      // never held the command.
      const deadline = this.#armDeadline(entry);
      this.entries.set(entry.id, entry);
      this.#endParkedPoll(poll);
      this.#markDelivered(entry, deadline);
      poll.resolve([entry.wire]);
      return outcome;
    }
    entry.timer = this.timers.setTimeout(() => this.#expireHandoff(entry), this.timings.handoffMs);
    this.entries.set(entry.id, entry);
    this.handoff.push(entry);
    // If Claude gives up while the command still waits for a poll, it is never delivered.
    if (signal) {
      const onAbort = () => this.#expireHandoff(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detach = () => signal.removeEventListener('abort', onAbort);
    }
    return outcome;
  }

  /**
   * A long poll from the phone. Resolves with the delivered commands in wire form (JSON text),
   * empty on timeout. Throws (delivering nothing) when a timer cannot be armed.
   * @param {number} limit 1..8
   * @param {number} timeoutMs already capped by the caller
   * @param {AbortSignal | null} [signal]
   * @returns {Promise<string[]>}
   */
  poll(limit, timeoutMs, signal) {
    // The phone already went away (its poll was aborted while the device key was checked): the
    // poll is treated as never having arrived, so it takes no command and is never parked.
    if (signal?.aborted) return Promise.resolve([]);
    // Only one parked poll at a time: a new poll ends the previous one with no commands.
    const previous = this.parked;
    if (previous) {
      this.#endParkedPoll(previous);
      previous.resolve([]);
    }
    if (this.handoff.length > 0) {
      const batch = this.handoff.slice(0, limit);
      const deadlines = this.#armDeadlines(batch);
      this.handoff.splice(0, batch.length);
      batch.forEach((entry, index) => this.#markDelivered(entry, deadlines[index]));
      this.lastPollEndedAt = this.now();
      return Promise.resolve(batch.map((entry) => entry.wire));
    }
    if (timeoutMs <= 0) {
      this.lastPollEndedAt = this.now();
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      /** @type {ParkedPoll} */
      const poll = { resolve, timer: undefined, detach: () => {} };
      poll.timer = this.timers.setTimeout(() => {
        if (this.parked !== poll) return;
        this.#endParkedPoll(poll);
        resolve([]);
      }, timeoutMs);
      if (signal) {
        const onAbort = () => {
          if (this.parked !== poll) return;
          this.#endParkedPoll(poll);
          resolve([]);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        poll.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.parked = poll;
    });
  }

  /**
   * Settles a delivered request with the phone's response. False (404 to the phone) when the
   * request is unknown, not delivered, already settled or expired, or the shard token differs.
   * @param {unknown} requestId
   * @param {unknown} shardToken
   * @param {Record<string, any>} payload the reply, parsed
   * @param {string} source the same reply as JSON text
   */
  settle(requestId, shardToken, payload, source) {
    if (typeof requestId !== 'string' || typeof shardToken !== 'string') return false;
    const entry = this.entries.get(requestId);
    if (!entry || entry.state !== 'delivered') return false;
    if (!constantTimeEqual(shardToken, entry.shardToken)) return false;
    this.#finish(entry, { kind: 'settled', payload, source });
    return true;
  }

  /**
   * Settles the delivered request holding this shard token as an invalid device reply, when the
   * phone's reply could not be read for its request_id (too large, not JSON, no request_id).
   * Compares against every delivered entry in constant time per entry. False when none matches.
   * @param {unknown} shardToken
   */
  rejectByShardToken(shardToken) {
    if (typeof shardToken !== 'string' || shardToken === '') return false;
    /** @type {Entry | null} */
    let match = null;
    for (const entry of this.entries.values()) {
      if (entry.state === 'delivered' && constantTimeEqual(shardToken, entry.shardToken)) match = entry;
    }
    if (!match) return false;
    this.#finish(match, { kind: 'invalid' });
    return true;
  }

  /**
   * Takes a request out of the hub after its MCP handler failed, so it can never be delivered
   * later and no reply is waited for. A late reply from the phone then gets 404.
   * @param {string} requestId
   * @returns {boolean | null} whether it had been delivered; null when the hub no longer holds it
   */
  withdraw(requestId) {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    const delivered = entry.state === 'delivered';
    if (!delivered) {
      const index = this.handoff.indexOf(entry);
      if (index !== -1) this.handoff.splice(index, 1);
    }
    this.#finish(entry, delivered ? { kind: 'unknown' } : { kind: 'unavailable' });
    return delivered;
  }

  /** Counters for tests and diagnostics; carries no secrets. */
  inspect() {
    let delivered = 0;
    for (const entry of this.entries.values()) if (entry.state === 'delivered') delivered += 1;
    return {
      parked: this.parked !== null,
      handoff: this.handoff.length,
      delivered,
      inFlight: this.entries.size,
      lastPollEndedAt: this.lastPollEndedAt,
    };
  }

  /**
   * Clears a timer. Best effort: every timer callback checks that its target is still in the
   * state it was armed for, so a timer that could not be cleared does nothing when it fires.
   * @param {unknown} timer
   */
  #clear(timer) {
    try {
      this.timers.clearTimeout(timer);
    } catch {
      // See above.
    }
  }

  /** @param {ParkedPoll} poll */
  #endParkedPoll(poll) {
    this.#clear(poll.timer);
    poll.detach();
    if (this.parked === poll) this.parked = null;
    this.lastPollEndedAt = this.now();
  }

  /**
   * Arms the settle deadline of a command about to be delivered. It fires only while the entry
   * is delivered and still holds this very timer.
   * @param {Entry} entry
   */
  #armDeadline(entry) {
    /** @type {unknown} */
    let timer;
    timer = this.timers.setTimeout(() => {
      if (entry.state === 'delivered' && entry.timer === timer) this.#finish(entry, { kind: 'unknown' });
    }, entry.settleWithinMs);
    return timer;
  }

  /**
   * Arms the deadlines of a whole batch, or none: on a failure the ones already armed are
   * cleared and the error is rethrown before any entry changes.
   * @param {Entry[]} batch
   */
  #armDeadlines(batch) {
    /** @type {unknown[]} */
    const armed = [];
    try {
      for (const entry of batch) armed.push(this.#armDeadline(entry));
    } catch (error) {
      for (const timer of armed) this.#clear(timer);
      throw error;
    }
    return armed;
  }

  /**
   * Marks an entry delivered with its already armed deadline. Nothing here can fail.
   * @param {Entry} entry
   * @param {unknown} deadline
   */
  #markDelivered(entry, deadline) {
    this.#clear(entry.timer);
    entry.detach();
    entry.detach = () => {};
    entry.state = 'delivered';
    entry.timer = deadline;
    entry.onDelivered();
  }

  /** @param {Entry} entry */
  #expireHandoff(entry) {
    if (entry.state !== 'handoff') return;
    const index = this.handoff.indexOf(entry);
    if (index !== -1) this.handoff.splice(index, 1);
    this.#finish(entry, { kind: 'unavailable' });
  }

  /**
   * @param {Entry} entry
   * @param {Outcome} outcome
   */
  #finish(entry, outcome) {
    if (entry.state === 'done') return;
    entry.state = 'done';
    this.#clear(entry.timer);
    entry.detach();
    this.entries.delete(entry.id);
    entry.resolve(outcome);
  }
}
