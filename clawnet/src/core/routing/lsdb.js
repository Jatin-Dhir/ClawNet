/**
 * Link-state database (DESIGN.md section 7, with the changes of section 15).
 *
 * Holds the newest link-state advertisement (LSA) of every node we have heard of and
 * derives the confirmed topology from them. Pure logic: the schema check, the signature
 * check, the origin policy and both clocks are injected, and ageing happens only when
 * expire() is called.
 *
 * What the database guarantees, whatever a peer sends:
 *
 *   - LSAs of one origin are totally ordered (section 15, item 14): the higher `seq`
 *     wins, and at equal `seq` the LSA whose canonical-JSON SHA-256 is greater wins and
 *     is accepted (so the caller floods it again). Two valid LSAs with one `seq` are
 *     equivocation and are reported through `onEquivocation`.
 *   - The highest sequence number outlives the LSA itself as a tombstone, so an expired
 *     advertisement cannot be replayed back in. The table of those numbers can be
 *     exported and restored, so it survives a restart.
 *   - Freshness (item 15): `seq` is wall-clock milliseconds, and an LSA more than
 *     `maxAgeMs + maxClockSkewMs` behind the wall clock, or more than `maxClockSkewMs`
 *     ahead of it, is refused. A former neighbour cannot keep replaying an old LSA to
 *     make a departed node look reachable.
 *   - The order of checks is: shape, origin policy, staleness, freshness, capacity, then
 *     signature. Replays and duplicates, by far the most common thing gossip delivers,
 *     and LSAs from refused origins are turned away before any signature is verified. A
 *     sequence number counts as "seen" only once its signature has verified, so a forged
 *     LSA cannot burn an origin's number space.
 *   - A link appears in graph() only while both endpoints advertise it, at the larger of
 *     the two advertised costs (item 18). A node can lie about its own links, never
 *     create one on someone else's behalf, and cannot attract traffic by understating
 *     its own side.
 *   - Age is measured from local receipt on the monotonic clock (item 21). The `ts` field
 *     of an LSA is never consulted.
 *   - Memory is bounded (item 19): at most `maxOrigins` LSAs with at most `maxLinks` links
 *     each, and at most `maxOrigins` tombstones. When the table is full, a newcomer
 *     displaces the held origin of lowest priority, and only if its own priority is
 *     strictly higher; by default an origin's priority is whether it is attached to the
 *     confirmed graph around this node.
 *
 * The bound has a cost that is stated rather than hidden: when more than `maxOrigins`
 * tombstones exist the oldest are dropped, after which a replay of that origin's last
 * LSA passes the staleness test (freshness still refuses it once it is old). That needs
 * on the order of `maxOrigins` identities and falls under "Sybil resistance", which
 * DESIGN.md lists as a non-goal beyond these caps.
 */

import { sha256 } from '../crypto/primitives.js';
import { CanonicalError, ConfigError, StateError, StoreError } from '../errors.js';
import { canonicalBytes, canonicalize } from '../wire/canonical.js';
import { Limits } from '../wire/types.js';
import { MAX_LINK_COST } from './metric.js';

/** `reason` values of a refused upsert. A failed `validate` may also supply its own. */
export const LsaReject = Object.freeze({
  /** The injected schema check refused the LSA and gave no reason of its own. */
  INVALID: 'invalid',
  /** The LSA passed the schema check but not the database's own structural checks. */
  MALFORMED: 'malformed',
  /** Not newer than what is held or remembered for this origin under the total order. */
  STALE: 'stale',
  /** An echo of our own LSA that is not newer than what we advertise. Nothing to do. */
  OWN_ORIGIN: 'own-origin',
  /** A genuine LSA of ours that the network holds and that we must supersede. */
  OWN_ORIGIN_NEWER: 'own-origin-newer',
  /** The table is full and this origin does not outrank the least valuable one held. */
  FULL: 'lsdb-full',
  /** The signature did not verify (or could not be checked). */
  BAD_SIGNATURE: 'bad-signature',
  /** `seq` is more than maxAgeMs + maxClockSkewMs behind the wall clock. */
  TOO_OLD: 'too-old',
  /** `seq` is more than maxClockSkewMs ahead of the wall clock. */
  TOO_NEW: 'too-new',
  /** The injected origin policy (blocklist, allowlist) refuses this origin. */
  REFUSED_ORIGIN: 'origin-refused',
});

/** Hex characters of the record hash that a digest entry carries (8 bytes). */
export const DIGEST_HASH_CHARS = 16;

/** Longest origin accepted from a persisted sequence table, in characters. */
const MAX_ORIGIN_LENGTH = 256;

/**
 * @typedef {object} Lsa
 * @property {string} origin  NodeId of the node the LSA describes
 * @property {number} seq     sequence number: wall-clock milliseconds, an integer >= 1
 * @property {Array<{ peer: string, cost: number }>} links  the origin's links; costs are
 *   integers in 1..65535, each peer appears once and is never the origin itself
 * @property {object} [caps]  the origin's capabilities, canonical-JSON data
 * @property {string} [sig]   signature; opaque to the database
 */

/**
 * @typedef {object} UpsertResult
 * @property {boolean} accepted  the LSA was installed
 * @property {boolean} changed   it altered links or caps (false for a pure refresh)
 * @property {string} [reason]   why it was refused, see {@link LsaReject}
 * @property {number} [seq]      with reason "own-origin-newer": the sequence number our
 *   own next LSA has to exceed
 * @property {unknown} [cause]   the exception, if an injected function threw
 */

/**
 * @typedef {object} LsdbChange
 * @property {'upsert' | 'local' | 'expire'} type  what mutated the topology
 * @property {readonly string[]} origins  the origins whose LSA was installed or removed;
 *   an upsert that displaced an origin from a full table lists the newcomer, then it
 */

/**
 * @typedef {object} Equivocation
 * @property {string} origin
 * @property {number} seq
 * @property {Lsa} kept      the LSA with the greater hash, now held
 * @property {Lsa} rejected  the other one
 */

export class Lsdb {
  #selfId;
  #validate;
  #verify;
  #monoNow;
  #wallNow;
  #maxAgeMs;
  #maxClockSkewMs;
  #tombstoneMs;
  #maxOrigins;
  #maxLinks;
  #priority;
  #allowOrigin;
  #onEquivocation;
  /**
   * origin -> { lsa, seq, hash, receivedAt, links: Map<peer, cost>, caps, capsKey,
   * equivocated }. `hash` is the hex SHA-256 of the LSA's canonical form; `equivocated`
   * is set once a second valid LSA with this `seq` has been seen and reported.
   */
  #entries = new Map();
  /** origin -> { seq, at } for origins whose LSA is gone. Oldest tombstone first. */
  #tombstones = new Map();
  #listeners = new Set();
  /** Cached eviction candidate: undefined = not computed, null = nothing evictable. */
  #victim = undefined;
  /** Origins reachable from us when #victim was computed (default priority only). */
  #attached = null;

  /**
   * @param {object} options
   * @param {string} options.selfId  this node's NodeId
   * @param {(lsa: unknown) => { ok: boolean, reason?: string }} options.validate  schema
   *   check for an LSA; anything but an object with `ok === true` refuses the LSA
   * @param {(lsa: Lsa) => boolean} options.verify  signature check; anything but `true`
   *   refuses the LSA
   * @param {() => number} options.monoNow  MONOTONIC clock in milliseconds: LSA age and
   *   tombstone age are measured on it (a backward step is tolerated)
   * @param {() => number} options.wallNow  WALL clock in milliseconds (`Date.now`): used
   *   only for the freshness of `seq` and for the stamps of exportSeqs()
   * @param {number} options.maxAgeMs     an LSA not refreshed for this long is removed
   *   by expire(); also the age, beyond the skew, past which a `seq` is too old
   * @param {number} options.maxClockSkewMs  clock difference tolerated between nodes, >= 0
   * @param {number} options.tombstoneMs  how long the highest sequence number of an
   *   origin without an LSA is remembered
   * @param {number} [options.maxOrigins=10000]  most LSAs held, our own included; also
   *   the most tombstones held
   * @param {number} [options.maxLinks=256]  most links one LSA may list
   * @param {(origin: string) => number} [options.priority]  value of keeping an origin
   *   when the table is full; the lowest goes first and a newcomer must be strictly
   *   higher to get in. Default: 1 for an origin attached to the confirmed graph around
   *   this node (reachable from selfId over links both ends advertise), else 0. Call
   *   priorityChanged() when the answers of a custom function change.
   * @param {(origin: string) => boolean} [options.allowOrigin]  origin policy (blocklist,
   *   allowlist); an LSA from an origin for which this is not `true` is refused before
   *   any signature work
   * @param {(event: Equivocation) => void} [options.onEquivocation]  told when two valid
   *   LSAs of one origin carry the same `seq`; called once per origin and `seq`
   * @throws {ConfigError} if an option is missing or out of range
   */
  constructor({
    selfId,
    validate,
    verify,
    monoNow,
    wallNow,
    maxAgeMs,
    maxClockSkewMs,
    tombstoneMs,
    maxOrigins = 10000,
    maxLinks = Limits.MAX_LSA_LINKS,
    priority,
    allowOrigin,
    onEquivocation,
  } = {}) {
    if (typeof selfId !== 'string' || selfId === '') {
      throw new ConfigError('selfId must be a non-empty string');
    }
    const required = [
      ['validate', validate],
      ['verify', verify],
      ['monoNow', monoNow],
      ['wallNow', wallNow],
    ];
    for (const [name, fn] of required) {
      if (typeof fn !== 'function') throw new ConfigError(`${name} must be a function`);
    }
    const optional = [
      ['priority', priority],
      ['allowOrigin', allowOrigin],
      ['onEquivocation', onEquivocation],
    ];
    for (const [name, fn] of optional) {
      if (fn !== undefined && typeof fn !== 'function') {
        throw new ConfigError(`${name} must be a function when given`);
      }
    }
    for (const [name, ms] of [['maxAgeMs', maxAgeMs], ['tombstoneMs', tombstoneMs]]) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
        throw new ConfigError(`${name} must be a finite number > 0`);
      }
    }
    if (typeof maxClockSkewMs !== 'number' || !Number.isFinite(maxClockSkewMs) || maxClockSkewMs < 0) {
      throw new ConfigError('maxClockSkewMs must be a finite number >= 0');
    }
    if (!Number.isSafeInteger(maxOrigins) || maxOrigins < 1) {
      throw new ConfigError('maxOrigins must be a positive integer');
    }
    if (!Number.isSafeInteger(maxLinks) || maxLinks < 0) {
      throw new ConfigError('maxLinks must be a non-negative integer');
    }
    this.#selfId = selfId;
    this.#validate = validate;
    this.#verify = verify;
    this.#monoNow = monoNow;
    this.#wallNow = wallNow;
    this.#maxAgeMs = maxAgeMs;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#tombstoneMs = tombstoneMs;
    this.#maxOrigins = maxOrigins;
    this.#maxLinks = maxLinks;
    this.#priority = priority;
    this.#allowOrigin = allowOrigin;
    this.#onEquivocation = onEquivocation;
  }

  /**
   * Offer an LSA received from the network.
   *
   * Never throws for anything the LSA contains. An exception thrown by `validate`,
   * `verify` or `allowOrigin` refuses the LSA and is returned as `cause`. The database
   * keeps a reference to an accepted LSA so that it can be re-gossiped byte for byte: do
   * not mutate it.
   *
   * An LSA carrying our own id is never installed (the self-originated rule of RFC 2328,
   * section 13.4; DESIGN.md section 15, item 16). If it is an echo of what we already
   * advertise (lower `seq`, or the very LSA we hold) the reason is "own-origin".
   * Otherwise its signature is checked, and if it is ours the reason is
   * "own-origin-newer" with its `seq`: the network holds an LSA of ours at or above our
   * own sequence number, and our next one must exceed it (typically after a restart
   * that lost the persisted number). The signature check comes first because without it
   * anyone could push our sequence number to its maximum.
   *
   * @param {unknown} lsa
   * @returns {UpsertResult}
   * @throws {StateError} if an injected clock misbehaves
   */
  upsert(lsa) {
    let verdict;
    try {
      verdict = this.#validate(lsa);
    } catch (cause) {
      return refused(LsaReject.INVALID, { cause });
    }
    if (verdict === null || typeof verdict !== 'object' || verdict.ok !== true) {
      const reason = verdict?.reason;
      return refused(typeof reason === 'string' && reason !== '' ? reason : LsaReject.INVALID);
    }

    const head = readHead(lsa);
    if (head === null) return refused(LsaReject.MALFORMED);
    const { origin, seq } = head;

    if (origin !== this.#selfId && this.#allowOrigin !== undefined) {
      let allowed;
      try {
        allowed = this.#allowOrigin(origin);
      } catch (cause) {
        return refused(LsaReject.REFUSED_ORIGIN, { cause });
      }
      if (allowed !== true) return refused(LsaReject.REFUSED_ORIGIN);
    }

    const now = this.#clock();
    const highest = this.#highestSeen(origin, now);
    if (seq < highest) return refused(origin === this.#selfId ? LsaReject.OWN_ORIGIN : LsaReject.STALE);

    const wall = this.#wallClock();
    if (seq < wall - (this.#maxAgeMs + this.#maxClockSkewMs)) return refused(LsaReject.TOO_OLD);
    if (seq > wall + this.#maxClockSkewMs) return refused(LsaReject.TOO_NEW);

    if (origin === this.#selfId) return this.#offerOwn(lsa, seq);

    const current = this.#entries.get(origin);
    // Equal to a remembered number without a live LSA: the tombstone refuses it whatever
    // its hash, so an expired origin cannot be revived at its old number.
    if (seq === highest && current?.seq !== seq) return refused(LsaReject.STALE);

    const body = readBody(lsa, origin, this.#maxLinks);
    if (body === null) return refused(LsaReject.MALFORMED);
    const hash = recordHash(lsa);
    if (hash === null) return refused(LsaReject.MALFORMED);

    if (current !== undefined && seq === current.seq) {
      return this.#offerTie(lsa, origin, seq, body, hash, current, now);
    }

    let victim = null;
    if (current === undefined) {
      // One slot stays reserved for our own LSA, so peers cannot crowd it out.
      const foreign = this.#entries.size - (this.#entries.has(this.#selfId) ? 1 : 0);
      if (foreign >= this.#maxOrigins - 1) {
        victim = this.#evictionCandidate();
        if (victim === null || this.#newcomerPriority(origin, body) <= victim.priority) {
          return refused(LsaReject.FULL);
        }
      }
    }

    const forged = this.#checkSignature(lsa);
    if (forged !== null) return forged;

    const evicted = victim === null ? null : this.#evict(victim.origin, now);
    return this.#install(lsa, origin, seq, hash, body, now, 'upsert', false, evicted);
  }

  /**
   * Install our own LSA. The signature is not verified (we just made it), and neither is
   * freshness: our own clock is the reference.
   *
   * @param {Lsa} lsa  must have `origin === selfId` and a `seq` greater than
   *   `highestSeq(selfId)`
   * @returns {{ accepted: true, changed: boolean }} `changed` as for upsert()
   * @throws {ConfigError} if the LSA does not pass `validate` or the structural checks,
   *   or names another origin
   * @throws {StateError} if `seq` is not greater than the highest already used
   */
  setLocal(lsa) {
    let verdict;
    try {
      verdict = this.#validate(lsa);
    } catch (cause) {
      throw new ConfigError('local LSA could not be validated', { cause });
    }
    if (verdict === null || typeof verdict !== 'object' || verdict.ok !== true) {
      const reason = typeof verdict?.reason === 'string' ? verdict.reason : LsaReject.INVALID;
      throw new ConfigError(`local LSA is not valid: ${reason}`);
    }
    const head = readHead(lsa);
    if (head === null) throw new ConfigError('local LSA is malformed');
    const { origin, seq } = head;
    if (origin !== this.#selfId) {
      throw new ConfigError('local LSA must have this node as its origin');
    }
    const now = this.#clock();
    const highest = this.#highestSeen(origin, now);
    if (seq <= highest) {
      throw new StateError(`local LSA seq ${seq} is not greater than ${highest}`);
    }
    const body = readBody(lsa, origin, this.#maxLinks);
    const hash = body === null ? null : recordHash(lsa);
    if (hash === null) throw new ConfigError('local LSA is malformed');
    return this.#install(lsa, origin, seq, hash, body, now, 'local', false);
  }

  /**
   * @param {string} origin
   * @returns {Lsa | undefined} the current LSA of that origin
   */
  get(origin) {
    return this.#entries.get(origin)?.lsa;
  }

  /**
   * @param {string} origin
   * @returns {boolean} whether a current LSA of that origin is held
   */
  has(origin) {
    return this.#entries.has(origin);
  }

  /**
   * @returns {Lsa[]} every current LSA, our own included
   */
  all() {
    return Array.from(this.#entries.values(), (entry) => entry.lsa);
  }

  /**
   * Summary for anti-entropy: what we hold, without the LSAs themselves. Two databases
   * hold the same LSAs exactly when (barring a 64-bit prefix collision) their digests
   * hold the same entries.
   *
   * @returns {Array<[string, number, string]>} `[origin, seq, hash]` for every current
   *   LSA, `hash` being the first 8 bytes of the SHA-256 of its canonical form as 16
   *   lowercase hex characters (DESIGN.md section 15, item 14)
   */
  digest() {
    return Array.from(this.#entries, ([origin, entry]) => [
      origin,
      entry.seq,
      entry.hash.slice(0, DIGEST_HASH_CHARS),
    ]);
  }

  /**
   * Highest verified sequence number seen for an origin: that of its current LSA, or
   * of its tombstone while that is remembered.
   *
   * @param {string} origin
   * @returns {number} 0 if nothing is known (valid sequence numbers start at 1)
   * @throws {StateError} if the injected clock misbehaves
   */
  highestSeq(origin) {
    return this.#highestSeen(origin, this.#clock());
  }

  /**
   * Number of current LSAs, our own included.
   *
   * @returns {number}
   */
  get size() {
    return this.#entries.size;
  }

  /**
   * Remove every LSA that was not refreshed within `maxAgeMs` of its local receipt, and
   * forget tombstones older than `tombstoneMs`. Our own LSA ages like any other; the
   * node keeps it alive by calling setLocal() on its refresh timer.
   *
   * Listeners are notified once if anything was removed.
   *
   * @returns {string[]} the origins whose LSA was removed
   * @throws {StateError} if the injected clock misbehaves
   */
  expire() {
    const now = this.#clock();
    const removed = [];
    for (const [origin, entry] of this.#entries) {
      // A receipt time ahead of the clock means the clock was set back. Restart the age
      // from now; otherwise a dead node's LSA would live on for the size of the step.
      if (entry.receivedAt > now) entry.receivedAt = now;
      if (now - entry.receivedAt < this.#maxAgeMs) continue;
      this.#entries.delete(origin);
      this.#tombstones.set(origin, { seq: entry.seq, at: now });
      removed.push(origin);
    }
    this.#trimTombstones(now);
    if (removed.length > 0) {
      this.#victim = undefined;
      this.#emit('expire', removed);
    }
    return removed;
  }

  /**
   * The confirmed topology: a link u - v is present only if u's current LSA lists v
   * AND v's current LSA lists u. Its cost, in both directions, is the larger of the two
   * advertised values (DESIGN.md section 15, item 18).
   *
   * @returns {Map<string, Map<string, number>>} node id -> (neighbor id -> cost). Every
   *   origin with a current LSA is a key, even if none of its links is confirmed. The
   *   maps are new on every call and belong to the caller.
   */
  graph() {
    const graph = new Map();
    for (const [origin, entry] of this.#entries) {
      const confirmed = new Map();
      for (const [peer, cost] of entry.links) {
        const back = this.#entries.get(peer)?.links.get(origin);
        if (back !== undefined) confirmed.set(peer, Math.max(cost, back));
      }
      graph.set(origin, confirmed);
    }
    return graph;
  }

  /**
   * Capabilities a node advertises in its current LSA.
   *
   * @param {string} nodeId
   * @returns {Readonly<Record<string, unknown>> | undefined} a deeply frozen copy taken
   *   when the LSA was installed (an empty object if the LSA had no `caps`), or
   *   undefined if no current LSA of that node is held
   */
  caps(nodeId) {
    return this.#entries.get(nodeId)?.caps;
  }

  /**
   * The highest-sequence memory as plain JSON data, for the node to persist: every
   * origin with a current LSA or a tombstone, with its highest verified `seq`.
   *
   * @returns {Array<[string, number, number]>} `[origin, seq, stamp]`, `stamp` in integer
   *   WALL-clock milliseconds: when the number was last current (now, for an origin with
   *   a current LSA). Oldest stamp first.
   * @throws {StateError} if an injected clock misbehaves
   */
  exportSeqs() {
    const now = this.#clock();
    const wall = this.#wallClock();
    const out = [];
    for (const [origin, tombstone] of this.#tombstones) {
      if (now - tombstone.at >= this.#tombstoneMs) continue;
      out.push([origin, tombstone.seq, Math.floor(wall - Math.max(0, now - tombstone.at))]);
    }
    out.sort((a, b) => a[2] - b[2]);
    const stamp = Math.floor(wall);
    for (const [origin, entry] of this.#entries) out.push([origin, entry.seq, stamp]);
    return out;
  }

  /**
   * Load a table written by exportSeqs(), at start-up before any LSA is offered. Each
   * number becomes a tombstone that lives `tombstoneMs` from its stamp, unless a
   * tombstone already remembers that origin at or above it; an origin that already has a
   * current LSA keeps that LSA's number. The newest `maxOrigins` survive.
   *
   * The table is not trusted: anything exportSeqs() could not have produced refuses the
   * whole table. A stamp ahead of the wall clock is pulled back to now.
   *
   * @param {unknown} table  exportSeqs() output after a JSON round trip
   * @returns {number} how many origins the table raised or added
   * @throws {StoreError} if the table is malformed
   * @throws {StateError} if an injected clock misbehaves
   */
  restoreSeqs(table) {
    if (!Array.isArray(table)) throw new StoreError('sequence table must be an array');
    const seen = new Set();
    for (let i = 0; i < table.length; i += 1) {
      const row = table[i];
      if (!Array.isArray(row) || row.length !== 3) {
        throw new StoreError(`sequence table row ${i} must be [origin, seq, stamp]`);
      }
      const [origin, seq, stamp] = row;
      if (typeof origin !== 'string' || origin === '' || origin.length > MAX_ORIGIN_LENGTH) {
        throw new StoreError(`sequence table row ${i} has an invalid origin`);
      }
      if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(stamp)) {
        throw new StoreError(`sequence table row ${i} has an invalid number`);
      }
      if (seen.has(origin)) throw new StoreError(`sequence table row ${i} repeats an origin`);
      seen.add(origin);
    }

    const now = this.#clock();
    const wall = this.#wallClock();
    let raised = 0;
    for (const [origin, seq, stamp] of table) {
      const age = wall - Math.min(stamp, wall);
      // A current LSA is the record of its origin; a tombstone beside it would be
      // overwritten by the LSA's own number when it expires.
      if (age >= this.#tombstoneMs || this.#entries.has(origin)) continue;
      if (seq <= this.#highestSeen(origin, now)) continue;
      this.#tombstones.set(origin, { seq, at: now - age });
      raised += 1;
    }
    // Keep the map oldest first, which expire() relies on to trim it in one pass.
    const ordered = [...this.#tombstones].sort((a, b) => a[1].at - b[1].at);
    this.#tombstones = new Map(ordered);
    this.#trimTombstones(now);
    return raised;
  }

  /**
   * Drop the cached eviction choice. Call when the answers of a custom `priority`
   * function change; topology changes are noticed without it.
   */
  priorityChanged() {
    this.#victim = undefined;
  }

  /**
   * Subscribe to topology changes. The listener runs synchronously, after the database
   * has been updated, and only when links, caps or the set of origins changed: a pure
   * refresh is silent. Every listener runs even if an earlier one throws; the first
   * exception is then rethrown from the call that caused the change, which by that
   * point has already taken effect.
   *
   * @param {(change: LsdbChange) => void} listener
   * @returns {() => void} unsubscribe
   * @throws {ConfigError} if listener is not a function
   */
  onChange(listener) {
    if (typeof listener !== 'function') {
      throw new ConfigError('listener must be a function');
    }
    // Wrapped so that subscribing the same function twice gives two subscriptions.
    const subscription = { listener };
    this.#listeners.add(subscription);
    return () => {
      this.#listeners.delete(subscription);
    };
  }

  /** A network copy of our own LSA, at or above what we remember: classify it. */
  #offerOwn(lsa, seq) {
    // Gossip can hand our current LSA back to us; that echo needs no reaction. The same
    // seq with a different hash is a conflicting LSA and falls through.
    const local = this.#entries.get(this.#selfId);
    if (local !== undefined && seq === local.seq && recordHash(lsa) === local.hash) {
      return refused(LsaReject.OWN_ORIGIN);
    }
    const forged = this.#checkSignature(lsa);
    if (forged !== null) return forged;
    return refused(LsaReject.OWN_ORIGIN_NEWER, { seq });
  }

  /** A foreign LSA with the same `seq` as the one held: the hash decides. */
  #offerTie(lsa, origin, seq, body, hash, current, now) {
    if (hash === current.hash) return refused(LsaReject.STALE);
    const wins = hash > current.hash;
    // A loser after the equivocation has been reported costs no further verification.
    if (!wins && current.equivocated) return refused(LsaReject.STALE);
    const forged = this.#checkSignature(lsa);
    if (forged !== null) return forged;

    const report = !current.equivocated;
    let result;
    if (wins) {
      result = this.#install(lsa, origin, seq, hash, body, now, 'upsert', true);
    } else {
      current.equivocated = true;
      result = refused(LsaReject.STALE);
    }
    if (report && this.#onEquivocation !== undefined) {
      this.#onEquivocation(
        Object.freeze({
          origin,
          seq,
          kept: wins ? lsa : current.lsa,
          rejected: wins ? current.lsa : lsa,
        }),
      );
    }
    return result;
  }

  /** @returns {UpsertResult | null} a refusal, or null if the signature verified */
  #checkSignature(lsa) {
    try {
      if (this.#verify(lsa) === true) return null;
    } catch (cause) {
      return refused(LsaReject.BAD_SIGNATURE, { cause });
    }
    return refused(LsaReject.BAD_SIGNATURE);
  }

  /**
   * Store an LSA, then tell the listeners once. `evicted` names the origin removed to
   * make room for it, which is part of the same change.
   */
  #install(lsa, origin, seq, hash, body, now, type, equivocated, evicted = null) {
    const previous = this.#entries.get(origin);
    const changed =
      evicted !== null ||
      previous === undefined ||
      previous.capsKey !== body.capsKey ||
      !sameLinks(previous.links, body.links);
    this.#entries.set(origin, { lsa, seq, hash, receivedAt: now, equivocated, ...body });
    this.#tombstones.delete(origin);
    if (changed) {
      this.#victim = undefined;
      this.#emit(type, evicted === null ? [origin] : [origin, evicted]);
    }
    return { accepted: true, changed };
  }

  /**
   * Remove an origin to make room; its number is remembered like an expired one's.
   * Listeners hear of it with the install that follows.
   *
   * @returns {string} the origin
   */
  #evict(origin, now) {
    const entry = this.#entries.get(origin);
    this.#entries.delete(origin);
    this.#tombstones.delete(origin);
    this.#tombstones.set(origin, { seq: entry.seq, at: now });
    this.#trimTombstones(now);
    return origin;
  }

  /**
   * Oldest first: drop the tombstones that have aged out, and as many more as it takes
   * to get back under the bound. One iterator does both. Asking the Map for its first
   * key once per removal would be quadratic, because in V8 every new iterator walks over
   * the entries deleted before it, and a whole database can expire in one call.
   */
  #trimTombstones(now) {
    let excess = this.#tombstones.size - this.#maxOrigins;
    for (const [origin, tombstone] of this.#tombstones) {
      if (excess <= 0 && now - tombstone.at < this.#tombstoneMs) break;
      this.#tombstones.delete(origin);
      excess -= 1;
    }
  }

  /**
   * The foreign origin to evict first: lowest priority, then smallest id, so that every
   * node with the same contents makes the same choice. Cached until the topology or the
   * priorities change, so a stream of refused newcomers costs O(1) each.
   *
   * @returns {{ origin: string, priority: number } | null}
   */
  #evictionCandidate() {
    if (this.#victim === undefined) {
      this.#attached = this.#priority === undefined ? this.#reachable() : null;
      let best = null;
      for (const origin of this.#entries.keys()) {
        if (origin === this.#selfId) continue;
        const priority = this.#priorityOf(origin);
        if (
          best === null ||
          priority < best.priority ||
          (priority === best.priority && origin < best.origin)
        ) {
          best = { origin, priority };
        }
      }
      this.#victim = best;
    }
    return this.#victim;
  }

  #priorityOf(origin) {
    if (this.#priority === undefined) return this.#attached.has(origin) ? 1 : 0;
    let value;
    try {
      value = this.#priority(origin);
    } catch {
      value = 0;
    }
    return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
  }

  /**
   * Priority of an origin that has no LSA here yet. With the default rule it is attached
   * if one of the links it advertises is to an attached node that advertises it back.
   */
  #newcomerPriority(origin, body) {
    if (this.#priority !== undefined) return this.#priorityOf(origin);
    for (const peer of body.links.keys()) {
      if (this.#attached.has(peer) && this.#entries.get(peer).links.has(origin)) return 1;
    }
    return 0;
  }

  /** Origins reachable from selfId over confirmed links, selfId included. O(V + E). */
  #reachable() {
    const reached = new Set();
    if (!this.#entries.has(this.#selfId)) return reached;
    const queue = [this.#selfId];
    reached.add(this.#selfId);
    for (let i = 0; i < queue.length; i += 1) {
      const node = queue[i];
      for (const peer of this.#entries.get(node).links.keys()) {
        if (reached.has(peer) || !this.#entries.get(peer)?.links.has(node)) continue;
        reached.add(peer);
        queue.push(peer);
      }
    }
    return reached;
  }

  #highestSeen(origin, now) {
    const entry = this.#entries.get(origin);
    if (entry !== undefined) return entry.seq;
    const tombstone = this.#tombstones.get(origin);
    if (tombstone === undefined) return 0;
    if (now - tombstone.at < this.#tombstoneMs) return tombstone.seq;
    // Checked here as well as in expire() so that how long a number is remembered does
    // not depend on how often the caller's expiry timer fires.
    this.#tombstones.delete(origin);
    return 0;
  }

  #clock() {
    return readClock(this.#monoNow, 'monoNow');
  }

  #wallClock() {
    return readClock(this.#wallNow, 'wallNow');
  }

  #emit(type, origins) {
    const change = Object.freeze({ type, origins: Object.freeze(origins.slice()) });
    let failed = false;
    let failure;
    // Iterate over a copy: a listener may unsubscribe, or mutate the database again.
    for (const { listener } of Array.from(this.#listeners)) {
      try {
        listener(change);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  }
}

/** @returns {UpsertResult} */
function refused(reason, extra) {
  return { accepted: false, changed: false, reason, ...extra };
}

function readClock(clock, name) {
  const now = clock();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new StateError(`${name}() must return a finite number of milliseconds`);
  }
  return now;
}

/**
 * Hex SHA-256 of a record's canonical JSON form: the tie-break of the total order.
 *
 * @returns {string | null} null if the record is not canonical-JSON data
 */
function recordHash(record) {
  try {
    return sha256(canonicalBytes(record)).toString('hex');
  } catch (error) {
    if (error instanceof CanonicalError) return null;
    throw error;
  }
}

/**
 * The two fields every decision starts from. Checked here even though `validate` has
 * run: the database must hold its invariants whatever schema check is plugged in.
 */
function readHead(lsa) {
  if (lsa === null || typeof lsa !== 'object') return null;
  const { origin, seq } = lsa;
  if (typeof origin !== 'string' || origin === '') return null;
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  return { origin, seq };
}

/**
 * Copy links and caps out of an LSA into structures the database owns, so that later
 * changes to the caller's object cannot alter the graph.
 *
 * @returns {{ links: Map<string, number>, caps: object, capsKey: string } | null} null if
 *   the LSA is malformed. A repeated peer and a link to oneself are refused rather than
 *   resolved, because there is no single right reading of either.
 */
function readBody(lsa, origin, maxLinks) {
  const { links: list, caps: rawCaps } = lsa;
  if (!Array.isArray(list) || list.length > maxLinks) return null;

  const links = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const link = list[i];
    if (link === null || typeof link !== 'object') return null;
    const { peer, cost } = link;
    if (typeof peer !== 'string' || peer === '' || peer === origin || links.has(peer)) return null;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > MAX_LINK_COST) return null;
    links.set(peer, cost);
  }

  let capsKey = '{}';
  if (rawCaps !== undefined) {
    if (rawCaps === null || typeof rawCaps !== 'object' || Array.isArray(rawCaps)) return null;
    try {
      // Canonical JSON is a key-order-independent fingerprint, which is what "did the
      // caps change" needs, and it bounds nesting depth.
      capsKey = canonicalize(rawCaps);
    } catch (error) {
      if (error instanceof CanonicalError) return null;
      throw error;
    }
  }
  return { links, caps: deepFreeze(JSON.parse(capsKey)), capsKey };
}

function sameLinks(a, b) {
  if (a.size !== b.size) return false;
  for (const [peer, cost] of a) {
    if (b.get(peer) !== cost) return false;
  }
  return true;
}

/** Freeze a JSON value and everything inside it. Depth is bounded by canonicalize(). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
