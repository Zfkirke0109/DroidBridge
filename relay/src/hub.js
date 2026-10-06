// @ts-check
/**
 * In-memory hand-off between Claude's MCP requests and the phone's long polls.
 *
 * Nothing here is persisted. If the Durable Object is evicted, requests in flight fail and are
 * never replayed. Every entry ends in exactly one outcome:
 *
 *   offline      no poll waiting and none ended within the online grace: not delivered
 *   busy         too many requests in flight: not delivered
 *   unavailable  online, but no poll arrived within the hand-off window: not delivered
 *   settled      delivered, and the phone posted a response with the right shard token
 *   unknown      delivered, and no response arrived before the deadline
 *
 * A command is "delivered" the moment it is placed into a poll response body, and it is
 * removed from the hand-off list at that moment, so no later poll can see it again.
 */

import { constantTimeEqual } from './util.js';

/**
 * @typedef {{ kind: 'offline' } | { kind: 'busy' } | { kind: 'unavailable' } | { kind: 'unknown' }
 *   | { kind: 'settled', payload: Record<string, any> }} Outcome
 * @typedef {{
 *   id: string, shardToken: string, command: Record<string, any>,
 *   state: 'handoff' | 'delivered' | 'done', settleWithinMs: number,
 *   resolve: (outcome: Outcome) => void, timer: unknown, detach: () => void
 * }} Entry
 * @typedef {{ resolve: (commands: Record<string, any>[]) => void, timer: unknown, detach: () => void }} ParkedPoll
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: unknown) => void }} Timers
 */

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
   * Offers a command to the phone. Resolves once the request has an outcome.
   * @param {Record<string, any>} command
   * @param {{ configured: boolean, settleWithinMs: number, signal?: AbortSignal | null }} options
   * @returns {Promise<Outcome>}
   */
  submit(command, { configured, settleWithinMs, signal }) {
    if (!configured || !this.isOnline()) return Promise.resolve({ kind: 'offline' });
    if (this.entries.size >= this.maxInFlight) return Promise.resolve({ kind: 'busy' });
    return new Promise((resolve) => {
      /** @type {Entry} */
      const entry = {
        id: command.request_id,
        shardToken: command.shard_token,
        command,
        state: 'handoff',
        settleWithinMs,
        resolve,
        timer: undefined,
        detach: () => {},
      };
      this.entries.set(entry.id, entry);
      const poll = this.parked;
      if (poll) {
        this.#endParkedPoll(poll);
        this.#deliver(entry);
        poll.resolve([command]);
        return;
      }
      this.handoff.push(entry);
      entry.timer = this.timers.setTimeout(() => this.#expireHandoff(entry), this.timings.handoffMs);
      // If Claude gives up while the command still waits for a poll, it is never delivered.
      if (signal && !signal.aborted) {
        const onAbort = () => this.#expireHandoff(entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /**
   * A long poll from the phone. Resolves with the delivered commands (empty on timeout).
   * @param {number} limit 1..8
   * @param {number} timeoutMs already capped by the caller
   * @param {AbortSignal | null} [signal]
   * @returns {Promise<Record<string, any>[]>}
   */
  poll(limit, timeoutMs, signal) {
    // Only one parked poll at a time: a new poll ends the previous one with no commands.
    const previous = this.parked;
    if (previous) {
      this.#endParkedPoll(previous);
      previous.resolve([]);
    }
    if (this.handoff.length > 0) {
      const batch = this.handoff.splice(0, limit);
      for (const entry of batch) this.#deliver(entry);
      this.lastPollEndedAt = this.now();
      return Promise.resolve(batch.map((entry) => entry.command));
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
      if (signal && !signal.aborted) {
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
   * @param {Record<string, any>} payload
   */
  settle(requestId, shardToken, payload) {
    if (typeof requestId !== 'string' || typeof shardToken !== 'string') return false;
    const entry = this.entries.get(requestId);
    if (!entry || entry.state !== 'delivered') return false;
    if (!constantTimeEqual(shardToken, entry.shardToken)) return false;
    this.#finish(entry, { kind: 'settled', payload });
    return true;
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

  /** @param {ParkedPoll} poll */
  #endParkedPoll(poll) {
    this.timers.clearTimeout(poll.timer);
    poll.detach();
    if (this.parked === poll) this.parked = null;
    this.lastPollEndedAt = this.now();
  }

  /** @param {Entry} entry */
  #deliver(entry) {
    this.timers.clearTimeout(entry.timer);
    entry.detach();
    entry.detach = () => {};
    entry.state = 'delivered';
    entry.timer = this.timers.setTimeout(() => {
      if (entry.state === 'delivered') this.#finish(entry, { kind: 'unknown' });
    }, entry.settleWithinMs);
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
    this.timers.clearTimeout(entry.timer);
    entry.detach();
    this.entries.delete(entry.id);
    entry.resolve(outcome);
  }
}
