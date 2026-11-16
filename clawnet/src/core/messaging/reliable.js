/**
 * Reliable end-to-end messaging (ARCHITECTURE.md 5.7, as amended by DESIGN.md 15.10 and
 * 15.12).
 *
 * `ReliableMessenger` seals outgoing messages, keeps every reliable one in a durable outbox
 * until it is acknowledged or expires, and retransmits it; for incoming sealed messages it
 * authenticates the sender, suppresses duplicates, dispatches by kind and acknowledges.
 *
 * The rules that matter, and why:
 *
 *   - The outbox holds the message already sealed. A retransmission is the same bytes with
 *     a new `try`, so nothing about the plaintext has to be kept and a restart cannot
 *     produce a second, different ciphertext for one id.
 *   - Replay protection is a cache keyed by (authenticated sender, id). The key is
 *     written only after the whole body verified and the handler succeeded, so a forged
 *     packet can neither burn an id nor suppress the genuine message. Each entry lives
 *     until ts + lifetime + skew, the end of the window in which `openMessage` would still
 *     accept the message, and the cache is persisted so a restart does not forget it.
 *   - An ack counts only when its authenticated sender is the message's destination.
 *   - Retransmission backs off exponentially with jitter from `retransmitMinMs` to
 *     `retransmitMaxMs`, with at most `maxInFlightPerDestination` unacknowledged messages
 *     per destination. An attempt triggered by a route appearing still waits for the
 *     backoff floor, plus up to two seconds of jitter, so a flapping link cannot make this
 *     node send a burst.
 *   - `try` is the attempt counter modulo 256. After a restart it starts from a random
 *     value; a forwarder's duplicate key also covers the body, so this is only extra care.
 *
 * Everything is injected (`originate`, the sealing functions, both clocks, the random
 * source, `schedule`, the three stores), so the unit tests run without sockets or timers.
 * There are no timers here: one deadline is kept for the whole messenger and armed through
 * `schedule`.
 *
 * Delivery to a kind's handler is at-least-once across a crash and exactly-once without
 * one, so every handler must be idempotent per message id (ARCHITECTURE.md 7.3).
 *
 * The stores must already be open: `index` and `seenLog` are Logs (`open()`ed), `bodies`
 * is a Blobs. Their lifetime belongs to the node (`NodeStorage#closeAll`); `close()` only
 * flushes them.
 */

import { ClawNetError, ConfigError, StateError, StoreError } from '../errors.js';
import { isValidNodeId, shortId, verifyCard } from '../crypto/identity.js';
import { openMessage, sealMessage } from '../crypto/envelope.js';
import { base64Decode, randomBytes, sha256 } from '../crypto/primitives.js';
import { canonicalBytes } from '../wire/canonical.js';
import { decodePacket, encodePacket } from '../wire/codec.js';
import { META_KIND_PATTERN, MetaKind, validateDataHeader, validateMeta } from '../wire/schema.js';
import { Limits, MESSAGE_ID_PATTERN, PacketType } from '../wire/types.js';
import { SeenCache } from './dedupe.js';

/** Most bytes of `meta` (canonical JSON, including the card and signature). */
export const MAX_META_BYTES = 8192;

/** Most bytes of `content` a sealed message carries. */
export const MAX_SEALED_CONTENT = 983040;

/** Most unacknowledged messages in flight to one destination (DESIGN.md 15.12). */
export const MAX_IN_FLIGHT_PER_DESTINATION = 4;

/** Upper bound of the jitter added to an attempt that a route appearing triggered. */
export const ROUTE_JITTER_MS = 2000;

/** Most inbound messages whose handler is still running. */
export const MAX_INBOUND_IN_FLIGHT = 1024;

/** Outbox bodies up to this size are kept in memory; larger ones are read from the store. */
export const MEMORY_BODY_BYTES = 4096;

/** Total bytes of outbox bodies kept in memory. */
export const MEMORY_BODIES_TOTAL = 16 * 1024 * 1024;

/** Messages remembered by body hash so a byte-identical copy skips the public-key work. */
const RECENT_CAPACITY = 8192;
const RE_ACK_GATE_ENTRIES = 4096;
const AUTH_EVENTS_PER_SEC = 50;
const TIMER_BATCH = 256;
const INDEX_COMPACT_MIN_DEAD = 1000;
const SEEN_COMPACT_MIN_APPENDS = 1000;
const MAX_EVENT_TEXT = 200;
const EMPTY = Buffer.alloc(0);
// A 64-byte signature is always 88 base64 characters: the stand-in gives `meta` its final
// size before the signature exists, as sealMessage() does.
const HS_STAND_IN = 'A'.repeat(88);
const RESERVED_META_KEYS = Object.freeze(['kind', 'card', 'ts', 'hs', 'ack']);
const CUSTODY_STATES = Object.freeze(['pending', 'accepted', 'refused']);
const DEL_REASONS = Object.freeze(['acked', 'expired', 'cancelled']);

/**
 * @typedef {object} OutboxEntry
 * @property {string} id
 * @property {string} dst
 * @property {string} kind
 * @property {number} bytes size of the sealed packet
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {number} attempts transmissions so far
 * @property {number | null} nextAttemptAt wall-clock estimate of the next attempt
 * @property {'waiting' | 'backoff'} state `waiting`: no attempt is scheduled (no route, or
 *   held back by the in-flight limit); `backoff`: the next attempt is scheduled
 * @property {string | null} custodian
 * @property {'pending' | 'accepted' | 'refused' | null} custodyState
 * @property {boolean} custody
 */

/**
 * @typedef {object} InboundMessage
 * @property {string} id
 * @property {string} from authenticated sender
 * @property {object} card the sender's verified identity card
 * @property {string} kind
 * @property {Readonly<object>} meta all of `meta`, reserved keys included
 * @property {Buffer} content
 * @property {number} ts the sender's send time
 * @property {number} receivedAt
 * @property {string | null} prevHop the neighbour the packet arrived from
 * @property {string | null} viaCustody the mailbox that delivered it, if any
 */

/** A binary min-heap of `{ at, value }`; `at` is a number. */
class MinHeap {
  #items = [];

  get size() {
    return this.#items.length;
  }

  peek() {
    return this.#items[0];
  }

  push(at, value) {
    const items = this.#items;
    let i = items.length;
    items.push({ at, value });
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].at <= items[i].at) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].at < items[smallest].at) smallest = left;
        if (right < items.length && items[right].at < items[smallest].at) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Delivered message keys with their own expiry times (wall clock, because the expiry is
 * derived from the sender's signed `ts` and is persisted). Bounded: when full, the entry
 * nearest to its natural expiry goes first, which gives up the least replay protection.
 */
class SeenStore {
  #max;
  #expiry = new Map();
  #heap = new MinHeap();

  constructor(max) {
    this.#max = max;
  }

  has(key, now) {
    const exp = this.#expiry.get(key);
    if (exp === undefined) return false;
    if (exp > now) return true;
    this.#expiry.delete(key);
    return false;
  }

  /** @returns {boolean} true if the key was new */
  add(key, exp, now) {
    this.#prune(now);
    if (this.#expiry.has(key)) return false;
    while (this.#expiry.size >= this.#max) this.#evictOne();
    this.#expiry.set(key, exp);
    this.#heap.push(exp, key);
    // Lazy deletions leave stale heap items; this keeps them from accumulating.
    if (this.#heap.size > 2 * this.#max + 16) this.#rebuild();
    return true;
  }

  size(now) {
    this.#prune(now);
    return this.#expiry.size;
  }

  entries() {
    return [...this.#expiry];
  }

  #prune(now) {
    for (let top = this.#heap.peek(); top !== undefined && top.at <= now; top = this.#heap.peek()) {
      this.#heap.pop();
      if (this.#expiry.get(top.value) === top.at) this.#expiry.delete(top.value);
    }
  }

  #evictOne() {
    for (;;) {
      const top = this.#heap.pop();
      if (top === undefined) return;
      if (this.#expiry.get(top.value) === top.at) {
        this.#expiry.delete(top.value);
        return;
      }
    }
  }

  #rebuild() {
    this.#heap = new MinHeap();
    for (const [key, exp] of this.#expiry) this.#heap.push(exp, key);
  }
}

/**
 * Sealed messaging with an outbox and retransmission, and the receiving side with replay
 * protection and acknowledgements. See the file comment for the rules it keeps.
 */
export class ReliableMessenger {
  #identity;
  #cardOf;
  #originate;
  #isReachable;
  #routePath;
  #events;
  #now;
  #monoNow;
  #rng;
  #randomBytes;
  #setTimer;
  #log;
  #index;
  #bodies;
  #seenLog;
  #seal;
  #open;
  #ttl;
  #lifetimeMs;
  #skewMs;
  #minMs;
  #maxMs;
  #jitter;
  #outboxMaxEntries;
  #outboxMaxBytes;
  #maxInFlight;
  #maxPacketBytes;
  #maxInbound;

  #opened = false;
  #closed = false;
  #handlers = new Map();
  #cardKeys = new WeakMap();

  // Outbox.
  #entries = new Map();
  #byDst = new Map();
  #slots = new Map();
  #seq = 0;
  #outboxBytes = 0;
  #reserved = 0;
  #reservedBytes = 0;
  #memoryBytes = 0;
  #indexLines = 0;
  #compactingIndex = false;

  // Timer: one deadline for everything, kept in a heap with lazy invalidation.
  #due = new MinHeap();
  #timerAt = null;
  #cancelTimer = null;

  // Inbound.
  #seen;
  #seenMax;
  #seenAppends = 0;
  #compactingSeen = false;
  #reAckGate;
  #inbound = new Set();
  #recent = new Map();
  #recentRing = new Array(RECENT_CAPACITY);
  #recentPos = 0;
  #authTokens = AUTH_EVENTS_PER_SEC;
  #authClock;

  #ops = new Set();
  #stats = {
    sent: 0,
    retransmits: 0,
    acked: 0,
    expired: 0,
    cancelled: 0,
    received: 0,
    duplicates: 0,
    authFailures: 0,
    authEventsSuppressed: 0,
    malformed: 0,
    busy: 0,
    ackMismatch: 0,
    ackUnknown: 0,
    handlerErrors: 0,
    unhandled: 0,
    originateErrors: 0,
    storeErrors: 0,
    internalErrors: 0,
    outboxCorrupt: 0,
    seenCorrupt: 0,
  };

  /**
   * @param {object} options
   * @param {import('../crypto/identity.js').Identity} options.identity this node
   * @param {(id: string) => object | null} options.cardOf the identity card known for a
   *   node, or null; the card is verified here before its e2e key is used
   * @param {(packet: object, options?: { path?: string[] }) => ({ ok: true, nextHop: string } | { ok: false, reason: string })} options.originate
   *   hand a DATA packet `{ type, header, body }` to the forwarder
   * @param {(dst: string) => boolean} [options.isReachable] whether a route to `dst`
   *   exists; saves reading a body from disk for an attempt that cannot go anywhere
   * @param {(dst: string) => string[] | null} [options.routePath] the predicted route, for
   *   the `packet.sent` event
   * @param {{ emit: (type: string, data?: unknown) => unknown }} [options.events]
   * @param {() => number} [options.now] wall clock in ms: `ts`, expiry, anything persisted
   * @param {() => number} [options.monoNow] monotonic clock in ms (default
   *   `performance.now`): every interval
   * @param {() => number} [options.rng] uniform random number in [0, 1), for jitter
   * @param {(n: number) => Buffer} [options.randomBytes] cryptographic random bytes, for
   *   message ids and the initial `try`
   * @param {(fn: () => void, ms: number) => () => void} options.schedule one-shot timer; the
   *   returned function cancels it
   * @param {{ debug?: Function, warn?: Function }} [options.log]
   * @param {object} options.index the outbox index Log (open)
   * @param {object} options.bodies the outbox Blobs
   * @param {object} options.seenLog the seen-id Log (open)
   * @param {typeof sealMessage} [options.sealMessage] injected for tests
   * @param {typeof openMessage} [options.openMessage] injected for tests
   * @param {number} [options.ttl] hop limit of packets this node originates (default 16)
   * @param {number} options.messageLifetimeMs how long a message may be retransmitted and,
   *   at the recipient, how old a `ts` is accepted (default 7 days)
   * @param {number} options.maxClockSkewMs how far ahead a `ts` may be (default 5 minutes)
   * @param {number} [options.retransmitMinMs] first backoff and backoff floor (default 2000)
   * @param {number} [options.retransmitMaxMs] backoff ceiling (default 900000)
   * @param {number} [options.retransmitJitter] total relative width of the backoff jitter
   *   (default 0.2, so each delay is 0.9 to 1.1 times its nominal value)
   * @param {number} [options.outboxMaxEntries] default 10000
   * @param {number} [options.outboxMaxBytes] default 256 MiB
   * @param {number} [options.seenCacheEntries] default 100000
   * @param {number} [options.maxInFlightPerDestination] default MAX_IN_FLIGHT_PER_DESTINATION
   * @param {number} [options.maxPacketBytes] largest packet this node sends (default
   *   Limits.MAX_ROUTED_PACKET); a larger message is refused with ConfigError
   * @param {number} [options.maxInbound] most inbound handlers running at once
   * @throws {ConfigError} for a missing or malformed option
   */
  constructor({
    identity,
    cardOf,
    originate,
    isReachable,
    routePath,
    events,
    now = Date.now,
    monoNow = () => performance.now(),
    rng = Math.random,
    randomBytes: random = randomBytes,
    schedule,
    log,
    index,
    bodies,
    seenLog,
    sealMessage: seal = sealMessage,
    openMessage: openSealed = openMessage,
    ttl = 16,
    messageLifetimeMs = 604_800_000,
    maxClockSkewMs = 300_000,
    retransmitMinMs = 2_000,
    retransmitMaxMs = 900_000,
    retransmitJitter = 0.2,
    outboxMaxEntries = 10_000,
    outboxMaxBytes = 268_435_456,
    seenCacheEntries = 100_000,
    maxInFlightPerDestination = MAX_IN_FLIGHT_PER_DESTINATION,
    maxPacketBytes = Limits.MAX_ROUTED_PACKET,
    maxInbound = MAX_INBOUND_IN_FLIGHT,
  } = {}) {
    if (!isValidNodeId(identity?.nodeId) || identity.card === null || typeof identity.card !== 'object') {
      throw new ConfigError('identity must have a nodeId and a card');
    }
    for (const [fn, name] of [
      [cardOf, 'cardOf'], [originate, 'originate'], [now, 'now'], [monoNow, 'monoNow'],
      [rng, 'rng'], [random, 'randomBytes'], [schedule, 'schedule'], [seal, 'sealMessage'],
      [openSealed, 'openMessage'],
    ]) requireFunction(fn, name);
    if (isReachable !== undefined) requireFunction(isReachable, 'isReachable');
    if (routePath !== undefined) requireFunction(routePath, 'routePath');
    if (events !== undefined && typeof events?.emit !== 'function') {
      throw new ConfigError('events must have an emit function');
    }
    for (const [store, members, name] of [
      [index, ['read', 'append', 'rewrite', 'flush'], 'index'],
      [seenLog, ['read', 'append', 'rewrite', 'flush'], 'seenLog'],
      [bodies, ['put', 'get', 'delete', 'keys'], 'bodies'],
    ]) {
      if (store === null || typeof store !== 'object' || members.some((m) => typeof store[m] !== 'function')) {
        throw new ConfigError(`${name} must provide ${members.join(', ')}`);
      }
    }
    requireInteger(ttl, 'ttl', 1, Limits.MAX_TTL);
    requireInteger(messageLifetimeMs, 'messageLifetimeMs', 1, Number.MAX_SAFE_INTEGER / 4);
    requireInteger(maxClockSkewMs, 'maxClockSkewMs', 0, Number.MAX_SAFE_INTEGER / 4);
    requireInteger(retransmitMinMs, 'retransmitMinMs', 1, Number.MAX_SAFE_INTEGER / 4);
    requireInteger(retransmitMaxMs, 'retransmitMaxMs', retransmitMinMs, Number.MAX_SAFE_INTEGER / 4);
    requireInteger(outboxMaxEntries, 'outboxMaxEntries', 1, 10_000_000);
    requireInteger(outboxMaxBytes, 'outboxMaxBytes', 1, Number.MAX_SAFE_INTEGER);
    requireInteger(seenCacheEntries, 'seenCacheEntries', 1, 100_000_000);
    requireInteger(maxInFlightPerDestination, 'maxInFlightPerDestination', 1, 1024);
    requireInteger(maxPacketBytes, 'maxPacketBytes', 1, Limits.MAX_PACKET);
    requireInteger(maxInbound, 'maxInbound', 1, 1_000_000);
    if (typeof retransmitJitter !== 'number' || !(retransmitJitter >= 0 && retransmitJitter < 1)) {
      throw new ConfigError('retransmitJitter must be a number in [0, 1)');
    }
    this.#identity = identity;
    this.#cardOf = cardOf;
    this.#originate = originate;
    this.#isReachable = isReachable ?? null;
    this.#routePath = routePath ?? null;
    this.#events = events ?? null;
    this.#now = now;
    this.#monoNow = monoNow;
    this.#rng = rng;
    this.#randomBytes = random;
    this.#setTimer = schedule;
    this.#log = log ?? null;
    this.#index = index;
    this.#bodies = bodies;
    this.#seenLog = seenLog;
    this.#seal = seal;
    this.#open = openSealed;
    this.#ttl = ttl;
    this.#lifetimeMs = messageLifetimeMs;
    this.#skewMs = maxClockSkewMs;
    this.#minMs = retransmitMinMs;
    this.#maxMs = retransmitMaxMs;
    this.#jitter = retransmitJitter;
    this.#outboxMaxEntries = outboxMaxEntries;
    this.#outboxMaxBytes = outboxMaxBytes;
    this.#maxInFlight = maxInFlightPerDestination;
    this.#maxPacketBytes = maxPacketBytes;
    this.#maxInbound = maxInbound;
    this.#seenMax = seenCacheEntries;
    this.#seen = new SeenStore(seenCacheEntries);
    // A duplicate is re-acknowledged at most once per half backoff floor: the sender has
    // not even retransmitted yet inside that interval.
    this.#reAckGate = new SeenCache({
      maxEntries: RE_ACK_GATE_ENTRIES,
      ttlMs: Math.max(1, retransmitMinMs / 2),
      monoNow,
    });
    this.#authClock = monoNow();
  }

  /**
   * Load the outbox and the seen cache from their stores and schedule the first attempts.
   * Blobs without a live entry are deleted, entries without a blob and entries past their
   * lifetime are dropped, and unreadable or invalid records are skipped and counted.
   *
   * @returns {Promise<void>}
   * @throws {StateError} if already open
   * @throws {StoreError} if a store cannot be read
   */
  async open() {
    if (this.#opened || this.#closed) throw new StateError('already-open: open() was already called');
    const { entries, lines } = await this.#readIndex();
    const blobKeys = new Set(await this.#bodies.keys());
    const wall = this.#now();
    const dead = [];
    for (const entry of entries.values()) {
      if (!blobKeys.delete(entry.id)) {
        dead.push([entry, 'cancelled']);
      } else if (entry.expiresAt <= wall) {
        dead.push([entry, 'expired']);
        blobKeys.add(entry.id);
      }
    }
    for (const [entry] of dead) entries.delete(entry.id);
    // Orphans, and the bodies of entries that expired while the node was down.
    for (const orphan of blobKeys) await this.#bodies.delete(orphan);

    const known = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const entry of known) {
      this.#register({ ...entry, tryBase: this.#randomBytes(1)[0] });
    }
    this.#indexLines = lines;
    for (const [entry, why] of dead) {
      this.#indexLines += 1;
      await this.#index.append({ op: 'del', id: entry.id, why });
      this.#announceRemoval(entry, why);
    }
    // After the drops, so the rewrite does not resurrect what was just removed.
    this.#compactIndexIfWorthIt();

    await this.#readSeen();
    this.#opened = true;
    for (const [dst, list] of this.#byDst) {
      // Spread the first attempts: a restart must not make every message go at once.
      for (const entry of list) {
        if ((this.#slots.get(dst) ?? 0) >= this.#maxInFlight) break;
        this.#slots.set(dst, (this.#slots.get(dst) ?? 0) + 1);
        entry.slot = true;
        this.#scheduleAttempt(entry, this.#monoNow() + this.#rng() * this.#minMs);
      }
    }
    this.#arm();
  }

  /**
   * Stop: no further sends or attempts, wait for background work, flush the stores. The
   * stores themselves stay open for the node to close. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#timerAt = null;
    await this.settled();
    await Promise.allSettled([this.#index.flush(), this.#seenLog.flush()]);
  }

  /**
   * Resolves when all background work started so far (attempts, store writes, inbound
   * processing) has finished. Never rejects.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    while (this.#ops.size > 0) await Promise.all([...this.#ops]);
  }

  /**
   * Send a message.
   *
   * Reliable messages are stored sealed in the outbox and retransmitted until acknowledged
   * or expired; the result is `sent` when the first attempt left, `waiting` when it is held
   * (no route, or the destination's in-flight limit). An unreliable message is sent once
   * and nothing is stored: `sent` or `dropped`.
   *
   * @param {string} dst destination NodeId, not this node
   * @param {object} message
   * @param {string} message.kind META_KIND_PATTERN, not `ack`
   * @param {object} [message.meta] kind-specific fields; must not contain `kind`, `card`,
   *   `ts`, `hs` or `ack`, and must be canonical JSON (integers only)
   * @param {Uint8Array} [message.content] at most MAX_SEALED_CONTENT bytes
   * @param {boolean} [message.reliable] default true
   * @param {number} [message.lifetimeMs] shorter than the configured lifetime, for this one
   * @param {boolean} [message.custody] whether a mailbox may hold it (default true)
   * @returns {Promise<{ id: string, state: 'sent' | 'waiting' | 'dropped' }>}
   * @throws {ConfigError} for an invalid argument or a message too large for one packet
   * @throws {StateError} `unknown-destination` (no identity card), `outbox-full`, or a
   *   messenger that is not open
   * @throws {StoreError} if the outbox cannot be written
   */
  async send(dst, { kind, meta = {}, content = EMPTY, reliable = true, lifetimeMs, custody = true } = {}) {
    this.#requireOpen();
    if (!isValidNodeId(dst)) throw new ConfigError('dst must be a NodeId');
    if (dst === this.#identity.nodeId) throw new ConfigError('dst must not be this node');
    if (kind === MetaKind.ACK) throw new ConfigError('kind "ack" belongs to the messenger');
    if (typeof reliable !== 'boolean' || typeof custody !== 'boolean') {
      throw new ConfigError('reliable and custody must be booleans');
    }
    const lifetime = lifetimeMs ?? this.#lifetimeMs;
    requireInteger(lifetime, 'lifetimeMs', 1, this.#lifetimeMs);
    const e2eKey = this.#e2eKeyOf(dst);
    const createdAt = this.#now();
    const sealed = this.#sealPacket({ dst, e2eKey, kind, meta, content, reliable, createdAt });
    if (!reliable) return { id: sealed.id, state: this.#sendOnce(sealed.packet, dst) };

    if (
      this.#entries.size + this.#reserved >= this.#outboxMaxEntries ||
      this.#outboxBytes + this.#reservedBytes + sealed.bytes.length > this.#outboxMaxBytes
    ) {
      throw new StateError('outbox-full: too many messages are waiting to be acknowledged');
    }
    this.#reserved += 1;
    this.#reservedBytes += sealed.bytes.length;
    const entry = {
      id: sealed.id,
      dst,
      kind,
      bytes: sealed.bytes.length,
      createdAt,
      expiresAt: createdAt + lifetime,
      custody,
      custodian: null,
      custodyState: null,
      tryBase: 0,
    };
    try {
      await this.#bodies.put(entry.id, sealed.bytes);
      try {
        this.#indexLines += 1;
        await this.#index.append({
          op: 'add',
          id: entry.id,
          dst,
          kind,
          createdAt,
          expiresAt: entry.expiresAt,
          bytes: entry.bytes,
          custody,
        });
      } catch (error) {
        await this.#bodies.delete(entry.id).catch(() => {});
        throw error;
      }
    } finally {
      this.#reserved -= 1;
      this.#reservedBytes -= sealed.bytes.length;
    }
    const live = this.#register(entry);
    this.#keepBody(live, sealed.bytes);
    this.#emit('message.queued', { id: live.id, dst, kind, bytes: live.bytes });
    if (this.#takeSlot(live)) await this.#attempt(live, sealed.bytes);
    return { id: live.id, state: live.attempts > 0 ? 'sent' : 'waiting' };
  }

  /**
   * Register the handler of a kind. A kind has exactly one handler.
   *
   * The handler receives an InboundMessage; it may be async. It must be idempotent per
   * message id. A handler that throws or rejects causes the message not to be
   * acknowledged, so the sender retransmits it.
   *
   * @param {string} kind META_KIND_PATTERN, not `ack`
   * @param {(message: InboundMessage) => void | Promise<void>} handler
   * @returns {() => void} removes the handler; idempotent
   * @throws {ConfigError} for an invalid kind or handler, or a kind that already has one
   */
  onKind(kind, handler) {
    if (typeof kind !== 'string' || !META_KIND_PATTERN.test(kind) || kind === MetaKind.ACK) {
      throw new ConfigError('kind must match the kind pattern and not be "ack"');
    }
    requireFunction(handler, 'handler');
    if (this.#handlers.has(kind)) throw new ConfigError(`kind "${kind}" already has a handler`);
    this.#handlers.set(kind, handler);
    return () => {
      if (this.#handlers.get(kind) === handler) this.#handlers.delete(kind);
    };
  }

  /**
   * Handle a DATA packet addressed to this node whose body scheme is 1: the forwarder's
   * `data.sealed` handler. Never throws; the returned promise settles when the message has
   * been fully processed (handler run, ack sent) and never rejects.
   *
   * @param {{ header: object, body: Uint8Array }} packet
   * @param {{ from?: string }} [info] `from`: the neighbour it arrived from
   * @returns {Promise<void>}
   */
  handleData(packet, { from } = {}) {
    // Deferred by a microtask: a packet handed over from inside this node's own call stack
    // (an ack delivered while the message it acknowledges is still being sent) is only seen
    // once that call has finished and the outbox is consistent.
    const peer = isValidNodeId(from) ? from : null;
    const work = Promise.resolve().then(() => this.#receive(packet, peer)).catch((error) => {
      if (error instanceof StoreError) this.#stats.storeErrors += 1;
      else this.#stats.internalErrors += 1;
      this.#log?.warn?.('inbound message processing failed', { code: error?.code ?? null });
    });
    return this.#track(work);
  }

  /**
   * Tell the messenger which destinations became reachable. Entries for them are
   * attempted after the backoff floor (`retransmitMinMs` since the last attempt) plus up to
   * ROUTE_JITTER_MS of jitter; an attempt already scheduled sooner is left alone.
   *
   * @param {{ reachable: string[] }} change
   * @returns {void}
   */
  routesChanged({ reachable } = {}) {
    if (!this.#opened || this.#closed || !Array.isArray(reachable)) return;
    const now = this.#monoNow();
    for (const dst of reachable) {
      for (const entry of this.#byDst.get(dst) ?? []) {
        if (entry.busy) continue;
        if (!entry.slot && !this.#takeSlot(entry)) continue;
        const floor = entry.lastSentAt === null ? now : Math.max(now, entry.lastSentAt + this.#minMs);
        const due = floor + this.#rng() * ROUTE_JITTER_MS;
        if (entry.dueAt === null || due < entry.dueAt) this.#scheduleAttempt(entry, due);
      }
    }
    this.#arm();
  }

  /** @returns {OutboxEntry[]} every unacknowledged reliable message, oldest first */
  pending() {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq).map((e) => this.#view(e));
  }

  /**
   * @param {string} id
   * @returns {OutboxEntry | null}
   */
  get(id) {
    const entry = this.#entries.get(id);
    return entry === undefined ? null : this.#view(entry);
  }

  /**
   * The encoded DATA packet of an outbox entry as it was last transmitted (its current
   * `try`), which a mailbox takes into custody.
   *
   * @param {string} id
   * @returns {Promise<Buffer | null>} null if there is no such entry or its body is gone
   */
  async packetOf(id) {
    const entry = this.#entries.get(id);
    if (entry === undefined) return null;
    const bytes = entry.body ?? (await this.#bodies.get(id));
    if (bytes === null) return null;
    if (entry.lastTry === null) return Buffer.from(bytes);
    const { type, header, body } = decodePacket(bytes);
    return encodePacket({ type, header: { ...header, try: entry.lastTry }, body });
  }

  /**
   * Record that a mailbox holds, or refused to hold, this message. An entry that is gone
   * (acknowledged meanwhile) is ignored.
   *
   * @param {string} id
   * @param {string | null} custodian the mailbox NodeId
   * @param {'pending' | 'accepted' | 'refused' | null} state
   * @returns {void}
   * @throws {ConfigError} for an invalid argument
   */
  setCustodian(id, custodian, state) {
    if (custodian !== null && !isValidNodeId(custodian)) throw new ConfigError('custodian must be a NodeId or null');
    if (state !== null && !CUSTODY_STATES.includes(state)) throw new ConfigError('invalid custody state');
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    entry.custodian = custodian;
    entry.custodyState = state;
    this.#indexLines += 1;
    this.#persist(this.#index.append({ op: 'cust', id, custodian, state }));
  }

  /**
   * Stop retransmitting a message and remove it from the outbox.
   *
   * @param {string} id
   * @returns {boolean} whether there was such an entry
   */
  cancel(id) {
    const entry = this.#entries.get(id);
    return entry !== undefined && this.#remove(entry, 'cancelled');
  }

  /**
   * @returns {Record<string, number>} flat non-negative integers: `outboxEntries`,
   *   `outboxBytes`, `waiting`, `sent`, `retransmits`, `acked`, `expired`, `cancelled`,
   *   `received`, `duplicates`, `authFailures`, `authEventsSuppressed`, `malformed`, `busy`,
   *   `ackMismatch`, `ackUnknown`, `handlerErrors`, `unhandled`, `originateErrors`,
   *   `storeErrors`, `internalErrors`, `outboxCorrupt`, `seenCorrupt`, `seenEntries`, `inboundInFlight`
   */
  stats() {
    let waiting = 0;
    for (const entry of this.#entries.values()) if (entry.dueAt === null) waiting += 1;
    return {
      ...this.#stats,
      outboxEntries: this.#entries.size,
      outboxBytes: this.#outboxBytes,
      waiting,
      seenEntries: this.#seen.size(this.#now()),
      inboundInFlight: this.#inbound.size,
    };
  }

  // -------------------------------------------------------------------------------------
  // Sending

  #requireOpen() {
    if (!this.#opened || this.#closed) throw new StateError('not-open: the messenger is not open');
  }

  /** The recipient's e2e public key from the card directory, verified. */
  #e2eKeyOf(dst) {
    let card;
    try {
      card = this.#cardOf(dst);
    } catch {
      card = null;
    }
    const known = card !== null && typeof card === 'object';
    const cached = known ? this.#cardKeys.get(card) : undefined;
    if (cached !== undefined && cached.nodeId === dst) return cached.key;
    const verdict = known ? verifyCard(card) : { ok: false };
    if (!verdict.ok || verdict.nodeId !== dst) {
      throw new StateError(`unknown-destination: no usable identity card for ${shortId(dst)}`);
    }
    this.#cardKeys.set(card, { nodeId: dst, key: verdict.e2ePublicKey });
    return verdict.e2ePublicKey;
  }

  /**
   * Seal a message into a DATA packet with `try` 0.
   *
   * @returns {{ id: string, bytes: Buffer, packet: object }}
   * @throws {ConfigError}
   */
  #sealPacket({ dst, e2eKey, kind, meta, content, reliable, createdAt }) {
    if (typeof kind !== 'string' || !META_KIND_PATTERN.test(kind)) {
      throw new ConfigError('kind must match the kind pattern');
    }
    if (!isPlainObject(meta)) throw new ConfigError('meta must be a plain object');
    if (RESERVED_META_KEYS.some((key) => Object.hasOwn(meta, key))) {
      throw new ConfigError(`meta must not contain ${RESERVED_META_KEYS.join(', ')}`);
    }
    if (!(content instanceof Uint8Array)) throw new ConfigError('content must be bytes');
    if (content.length > MAX_SEALED_CONTENT) {
      throw new ConfigError(`content-too-large: at most ${MAX_SEALED_CONTENT} bytes`);
    }
    const fields = { ...meta, kind };
    // Only `msg` needs the flag to be present when it is false (its schema requires it).
    if (reliable) fields.ack = true;
    else if (kind === MetaKind.MSG) fields.ack = false;
    return this.#sealFields({ dst, e2eKey, fields, content, createdAt });
  }

  #sealFields({ dst, e2eKey, fields, content, createdAt }) {
    let body;
    let id;
    try {
      const metaBytes = canonicalBytes({
        ...fields,
        card: this.#identity.card,
        ts: createdAt,
        hs: HS_STAND_IN,
      }).length;
      if (metaBytes > MAX_META_BYTES) {
        throw new ConfigError(`meta-too-large: at most ${MAX_META_BYTES} bytes`);
      }
      id = this.#randomBytes(16).toString('hex');
      body = this.#seal({
        sender: this.#identity,
        recipientE2eKey: e2eKey,
        dst,
        id,
        meta: fields,
        content,
        now: createdAt,
      });
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`cannot seal message: ${error?.message ?? 'unknown error'}`, { cause: error });
    }
    const packet = { type: PacketType.DATA, header: { id, dst, ttl: this.#ttl, try: 0 }, body };
    let bytes;
    try {
      bytes = encodePacket(packet);
    } catch (cause) {
      throw new ConfigError('message-too-large: it does not fit in a packet', { cause });
    }
    if (bytes.length > this.#maxPacketBytes) {
      throw new ConfigError(`message-too-large: a packet is at most ${this.#maxPacketBytes} bytes`);
    }
    return { id, bytes, packet };
  }

  /** An unreliable send: one try, nothing stored. */
  #sendOnce(packet, dst) {
    try {
      const result = this.#originate(packet, this.#pathOption(dst));
      return result?.ok === true ? 'sent' : 'dropped';
    } catch (error) {
      this.#stats.originateErrors += 1;
      this.#log?.warn?.('originate failed', { code: error?.code ?? null });
      return 'dropped';
    }
  }

  #pathOption(dst) {
    let path = null;
    try {
      path = this.#routePath?.(dst) ?? null;
    } catch {
      path = null;
    }
    return Array.isArray(path) ? { path } : {};
  }

  // -------------------------------------------------------------------------------------
  // Outbox bookkeeping

  /** Add an entry to every index. */
  #register(base) {
    const entry = {
      ...base,
      seq: this.#seq,
      attempts: 0,
      lastSentAt: null,
      lastTry: null,
      dueAt: null,
      ver: 0,
      slot: false,
      busy: false,
      noRoute: false,
      body: null,
    };
    this.#seq += 1;
    this.#entries.set(entry.id, entry);
    const list = this.#byDst.get(entry.dst);
    if (list === undefined) this.#byDst.set(entry.dst, [entry]);
    else list.push(entry);
    this.#outboxBytes += entry.bytes;
    // The deadline for expiry is its own item in the heap.
    this.#due.push(this.#monoNow() + Math.max(0, entry.expiresAt - this.#now()), {
      id: entry.id,
      ver: -1,
    });
    this.#arm();
    return entry;
  }

  #keepBody(entry, bytes) {
    if (bytes.length <= MEMORY_BODY_BYTES && this.#memoryBytes + bytes.length <= MEMORY_BODIES_TOTAL) {
      entry.body = bytes;
      this.#memoryBytes += bytes.length;
    }
  }

  /** Reserve one of the destination's in-flight slots for an entry. */
  #takeSlot(entry) {
    if (entry.slot) return true;
    const used = this.#slots.get(entry.dst) ?? 0;
    if (used >= this.#maxInFlight) return false;
    this.#slots.set(entry.dst, used + 1);
    entry.slot = true;
    return true;
  }

  #releaseSlot(entry) {
    if (!entry.slot) return;
    entry.slot = false;
    const left = (this.#slots.get(entry.dst) ?? 1) - 1;
    if (left <= 0) this.#slots.delete(entry.dst);
    else this.#slots.set(entry.dst, left);
  }

  /** Remove an entry for `why`, tell the world, and persist the removal. */
  #remove(entry, why) {
    if (this.#entries.get(entry.id) !== entry) return false;
    this.#entries.delete(entry.id);
    const list = this.#byDst.get(entry.dst);
    if (list !== undefined) {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.#byDst.delete(entry.dst);
    }
    const hadSlot = entry.slot;
    this.#releaseSlot(entry);
    entry.ver += 1;
    this.#outboxBytes -= entry.bytes;
    if (entry.body !== null) this.#memoryBytes -= entry.body.length;
    entry.body = null;
    this.#announceRemoval(entry, why);
    this.#indexLines += 1;
    // The record first, then the blob: a crash in between leaves an orphan blob, which the
    // next open deletes, never an entry without its body.
    this.#persist(
      this.#index.append({ op: 'del', id: entry.id, why }).then(() => this.#bodies.delete(entry.id)),
    );
    this.#compactIndexIfWorthIt();
    if (hadSlot) this.#fill(entry.dst);
    this.#arm();
    return true;
  }

  #announceRemoval(entry, why) {
    const base = { id: entry.id, dst: entry.dst, kind: entry.kind };
    if (why === 'acked') {
      this.#stats.acked += 1;
      this.#emit('message.acked', {
        ...base,
        attempts: entry.attempts ?? 0,
        elapsedMs: Math.max(0, this.#now() - entry.createdAt),
      });
    } else if (why === 'expired') {
      this.#stats.expired += 1;
      this.#emit('message.expired', base);
    } else {
      this.#stats.cancelled += 1;
      this.#emit('message.cancelled', base);
    }
  }

  /** A slot freed up: start the oldest messages that were held back by the limit. */
  #fill(dst) {
    // A copy: an attempt may remove an entry (it has expired) while this loop runs.
    for (const entry of [...(this.#byDst.get(dst) ?? [])]) {
      if (entry.slot || entry.busy) continue;
      if (!this.#takeSlot(entry)) return;
      this.#track(this.#attempt(entry));
    }
  }

  #view(entry) {
    const nextAttemptAt = entry.dueAt === null
      ? null
      : Math.round(this.#now() + Math.max(0, entry.dueAt - this.#monoNow()));
    return {
      id: entry.id,
      dst: entry.dst,
      kind: entry.kind,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      attempts: entry.attempts,
      nextAttemptAt,
      state: entry.dueAt === null ? 'waiting' : 'backoff',
      custodian: entry.custodian,
      custodyState: entry.custodyState,
      custody: entry.custody,
    };
  }

  // -------------------------------------------------------------------------------------
  // Attempts and the timer

  /** Delay before the next attempt after `attempts` transmissions, with jitter. */
  #backoff(attempts) {
    const nominal = Math.min(this.#maxMs, this.#minMs * 2 ** Math.min(attempts - 1, 40));
    const factor = 1 - this.#jitter / 2 + this.#jitter * this.#rng();
    return nominal * factor;
  }

  /** Schedule an attempt at `due` (monotonic ms), replacing any earlier schedule. */
  #scheduleAttempt(entry, due) {
    entry.ver += 1;
    entry.dueAt = due;
    this.#due.push(due, { id: entry.id, ver: entry.ver });
  }

  /** Keep exactly one timer armed, for the earliest live deadline. */
  #arm() {
    if (this.#closed) return;
    let top = this.#due.peek();
    while (top !== undefined && this.#isStale(top.value)) {
      this.#due.pop();
      top = this.#due.peek();
    }
    if (top === undefined) {
      this.#cancelTimer?.();
      this.#cancelTimer = null;
      this.#timerAt = null;
      return;
    }
    if (this.#timerAt === top.at) return;
    this.#cancelTimer?.();
    this.#timerAt = top.at;
    const wait = Math.max(0, Math.ceil(top.at - this.#monoNow()));
    this.#cancelTimer = this.#setTimer(() => {
      this.#cancelTimer = null;
      this.#timerAt = null;
      this.#onTimer();
    }, wait);
  }

  #isStale({ id, ver }) {
    const entry = this.#entries.get(id);
    return entry === undefined || (ver !== -1 && ver !== entry.ver);
  }

  #onTimer() {
    if (this.#closed) return;
    const now = this.#monoNow();
    for (let n = 0; n < TIMER_BATCH; n += 1) {
      const top = this.#due.peek();
      if (top === undefined || top.at > now) break;
      this.#due.pop();
      if (this.#isStale(top.value)) continue;
      const entry = this.#entries.get(top.value.id);
      if (top.value.ver === -1) {
        this.#checkExpiry(entry);
      } else {
        entry.dueAt = null;
        this.#track(this.#attempt(entry));
      }
    }
    this.#arm();
  }

  /** Expire an entry whose lifetime is up; if the wall clock disagrees, look again later. */
  #checkExpiry(entry) {
    const left = entry.expiresAt - this.#now();
    if (left <= 0) this.#remove(entry, 'expired');
    else this.#due.push(this.#monoNow() + left, { id: entry.id, ver: -1 });
  }

  /**
   * One transmission attempt of an entry that holds a slot.
   *
   * @param {object} entry
   * @param {Buffer} [loaded] the packet bytes, when the caller has them
   */
  async #attempt(entry, loaded) {
    if (entry.busy || this.#closed || this.#entries.get(entry.id) !== entry) return;
    entry.busy = true;
    try {
      if (this.#now() >= entry.expiresAt) {
        this.#remove(entry, 'expired');
        return;
      }
      if (this.#isReachable !== null && !this.#reachable(entry.dst)) {
        this.#goWaiting(entry);
        return;
      }
      const bytes = entry.body ?? loaded ?? (await this.#readBody(entry));
      if (bytes === null || this.#closed || this.#entries.get(entry.id) !== entry) return;
      this.#transmit(entry, bytes);
    } finally {
      entry.busy = false;
    }
  }

  #reachable(dst) {
    try {
      return this.#isReachable(dst) === true;
    } catch {
      return false;
    }
  }

  async #readBody(entry) {
    let bytes;
    try {
      bytes = await this.#bodies.get(entry.id);
    } catch (error) {
      // An unreadable body can never be sent; waiting for it would only hide the loss.
      this.#stats.storeErrors += 1;
      this.#log?.warn?.('outbox body unreadable', { code: error?.code ?? null });
      bytes = null;
    }
    if (bytes === null) {
      this.#remove(entry, 'cancelled');
      return null;
    }
    this.#keepBody(entry, bytes);
    return bytes;
  }

  #transmit(entry, bytes) {
    const tryNo = (entry.tryBase + entry.attempts) & 0xff;
    let result;
    try {
      const { type, header, body } = decodePacket(bytes);
      result = this.#originate({ type, header: { ...header, try: tryNo }, body }, this.#pathOption(entry.dst));
    } catch (error) {
      // A deterministic failure must not become a hot loop: count it as an attempt.
      this.#stats.originateErrors += 1;
      this.#log?.warn?.('originate failed', { code: error?.code ?? null });
      result = { ok: true, nextHop: null, failed: true };
    }
    if (result?.ok === true) {
      entry.attempts += 1;
      entry.lastTry = tryNo;
      entry.lastSentAt = this.#monoNow();
      entry.noRoute = false;
      this.#scheduleAttempt(entry, entry.lastSentAt + this.#backoff(entry.attempts));
      if (result.failed !== true) {
        this.#stats.sent += 1;
        if (entry.attempts > 1) this.#stats.retransmits += 1;
        this.#emit('message.sent', {
          id: entry.id,
          dst: entry.dst,
          kind: entry.kind,
          attempt: entry.attempts,
          nextHop: result.nextHop,
        });
      }
    } else if (result?.reason === 'backpressure') {
      // Not an attempt: the link was busy, so ask again soon.
      this.#scheduleAttempt(entry, this.#monoNow() + Math.max(1, this.#minMs / 4));
    } else {
      this.#goWaiting(entry);
    }
    this.#arm();
  }

  /** No route: nothing is scheduled; a route appearing or a restart will schedule. */
  #goWaiting(entry) {
    entry.dueAt = null;
    entry.ver += 1;
    if (!entry.noRoute) {
      entry.noRoute = true;
      this.#emit('message.waiting', { id: entry.id, dst: entry.dst, kind: entry.kind });
    }
    // An entry that was never sent gives its slot back, so one that can go is not blocked.
    if (entry.attempts === 0) this.#releaseSlot(entry);
  }

  // -------------------------------------------------------------------------------------
  // Receiving

  async #receive(packet, from) {
    if (!this.#opened || this.#closed) return;
    const header = packet !== null && typeof packet === 'object' && packet.header !== null &&
      typeof packet.header === 'object' ? { ...packet.header } : null;
    const body = packet?.body;
    if (
      header === null ||
      !validateDataHeader(header).ok ||
      header.dst !== this.#identity.nodeId ||
      !(body instanceof Uint8Array) ||
      body.length === 0
    ) {
      this.#stats.malformed += 1;
      return;
    }
    const { id } = header;
    const bodyKey = `${id}${sha256(body).toString('hex')}`;
    const known = this.#recent.get(bodyKey);
    if (known !== undefined) {
      const key = `${known.sender}:${id}`;
      if (this.#seen.has(key, this.#now())) {
        await this.#duplicate(key, known, id, from, header);
        return;
      }
      this.#recent.delete(bodyKey);
    }

    let opened;
    try {
      opened = this.#open({
        recipient: this.#identity,
        dst: this.#identity.nodeId,
        id,
        body,
        now: this.#now(),
        maxAgeMs: this.#lifetimeMs,
        maxFutureMs: this.#skewMs,
      });
    } catch {
      // The previous hop is not blamed, and the id is not recorded: a forged packet must
      // not be able to block the genuine one.
      this.#authFailed(id, from);
      return;
    }
    const { senderId, card, meta, content } = opened;
    if (
      !validateMeta(meta).ok ||
      content.length > MAX_SEALED_CONTENT ||
      canonicalBytes(meta).length > MAX_META_BYTES
    ) {
      this.#stats.malformed += 1;
      return;
    }
    const key = `${senderId}:${id}`;
    const wantsAck = meta.ack === true;
    if (this.#seen.has(key, this.#now())) {
      await this.#duplicate(key, this.#remember(bodyKey, { sender: senderId, card, ack: wantsAck }), id, from, header);
      return;
    }
    if (this.#inbound.has(key)) return;

    if (meta.kind === MetaKind.ACK) {
      this.#onAck(senderId, meta);
      await this.#markSeen(key, senderId, id, meta.ts, bodyKey, card, false);
      return;
    }
    if (this.#inbound.size >= this.#maxInbound) {
      this.#stats.busy += 1;
      return;
    }
    const handler = this.#handlers.get(meta.kind);
    this.#inbound.add(key);
    try {
      if (handler === undefined) {
        this.#stats.unhandled += 1;
        this.#emit('message.unhandled', { id, from: senderId, kind: meta.kind });
      } else {
        await handler({
          id,
          from: senderId,
          card,
          kind: meta.kind,
          meta,
          content,
          ts: meta.ts,
          receivedAt: this.#now(),
          prevHop: from,
          viaCustody: header.cust ?? null,
        });
      }
    } catch (error) {
      // No ack and no record: the sender will retransmit and the handler gets another go.
      this.#stats.handlerErrors += 1;
      this.#emit('message.handler_error', {
        id,
        from: senderId,
        kind: meta.kind,
        message: safeMessage(error),
      });
      return;
    } finally {
      this.#inbound.delete(key);
    }

    await this.#markSeen(key, senderId, id, meta.ts, bodyKey, card, wantsAck);
    this.#stats.received += 1;
    this.#emit('message.received', {
      id,
      from: senderId,
      kind: meta.kind,
      bytes: content.length,
      prevHop: from,
      viaCustody: header.cust ?? null,
    });
    if (wantsAck) await this.#sendAck(senderId, card, id);
  }

  /**
   * Record a processed message: memory first (so a copy that arrives while the disk write
   * runs is already a duplicate), then the seen log.
   */
  async #markSeen(key, senderId, id, ts, bodyKey, card, ack) {
    const exp = ts + this.#lifetimeMs + this.#skewMs;
    this.#seen.add(key, exp, this.#now());
    this.#remember(bodyKey, { sender: senderId, card, ack });
    this.#seenAppends += 1;
    try {
      await this.#seenLog.append({ from: senderId, id, exp });
    } catch (error) {
      // Worst case a retransmission after a crash is delivered again, which handlers
      // tolerate; refusing to acknowledge would make the sender retry for a week.
      this.#stats.storeErrors += 1;
      this.#log?.warn?.('seen log write failed', { code: error?.code ?? null });
    }
    this.#compactSeenIfWorthIt();
  }

  /** A copy of a message already delivered: do not deliver it again, but re-acknowledge. */
  async #duplicate(key, known, id, prevHop, header) {
    this.#stats.duplicates += 1;
    this.#emit('message.duplicate', { id, prevHop, viaCustody: header.cust ?? null });
    if (known.ack && this.#reAckGate.add(key)) await this.#sendAck(known.sender, known.card, id);
  }

  #onAck(senderId, meta) {
    const entry = this.#entries.get(meta.id);
    if (entry === undefined) {
      this.#stats.ackUnknown += 1;
    } else if (entry.dst !== senderId) {
      // Authenticated, but not by the node it would have to come from.
      this.#stats.ackMismatch += 1;
      this.#log?.debug?.('ack from a node other than the destination', { from: shortId(senderId) });
    } else {
      this.#remove(entry, 'acked');
    }
  }

  /** Best-effort: an ack that cannot go is covered by the sender's next retransmission. */
  async #sendAck(dst, card, id) {
    try {
      const e2eKey = base64Decode(card.e2e, 32);
      const sealed = this.#sealFields({
        dst,
        e2eKey,
        fields: { kind: MetaKind.ACK, id },
        content: EMPTY,
        createdAt: this.#now(),
      });
      this.#sendOnce(sealed.packet, dst);
    } catch (error) {
      this.#log?.warn?.('ack not sent', { code: error?.code ?? null });
    }
  }

  /**
   * Remember that a message with these exact bytes was processed, so a byte-identical
   * retransmission is recognised without another round of public-key operations.
   */
  #remember(bodyKey, value) {
    const old = this.#recentRing[this.#recentPos];
    if (old !== undefined) this.#recent.delete(old);
    this.#recentRing[this.#recentPos] = bodyKey;
    this.#recentPos = (this.#recentPos + 1) % RECENT_CAPACITY;
    this.#recent.set(bodyKey, value);
    return value;
  }

  #authFailed(id, from) {
    this.#stats.authFailures += 1;
    const now = this.#monoNow();
    const elapsed = Math.max(0, now - this.#authClock);
    this.#authClock = now;
    this.#authTokens = Math.min(AUTH_EVENTS_PER_SEC, this.#authTokens + (elapsed * AUTH_EVENTS_PER_SEC) / 1000);
    if (this.#authTokens < 1) {
      this.#stats.authEventsSuppressed += 1;
      return;
    }
    this.#authTokens -= 1;
    this.#emit('packet.dropped', { id, type: 'data', dst: this.#identity.nodeId, from, reason: 'auth' });
  }

  // -------------------------------------------------------------------------------------
  // Persistence

  async #readIndex() {
    const entries = new Map();
    let lines = 0;
    for await (const record of this.#index.read()) {
      lines += 1;
      this.#applyIndexRecord(entries, record);
    }
    return { entries, lines };
  }

  #applyIndexRecord(entries, record) {
    const bad = () => {
      this.#stats.outboxCorrupt += 1;
    };
    if (record.op === 'add') {
      const ok =
        MESSAGE_ID_PATTERN.test(record.id) && isValidNodeId(record.dst) &&
        typeof record.kind === 'string' && META_KIND_PATTERN.test(record.kind) &&
        Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.expiresAt) &&
        record.expiresAt > record.createdAt && Number.isSafeInteger(record.bytes) && record.bytes >= 0 &&
        typeof record.custody === 'boolean';
      if (!ok) return bad();
      entries.set(record.id, {
        id: record.id,
        dst: record.dst,
        kind: record.kind,
        bytes: record.bytes,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        custody: record.custody,
        custodian: null,
        custodyState: null,
      });
    } else if (record.op === 'cust') {
      const entry = entries.get(record.id);
      const ok =
        entry !== undefined && (record.custodian === null || isValidNodeId(record.custodian)) &&
        (record.state === null || CUSTODY_STATES.includes(record.state));
      if (!ok) return bad();
      entry.custodian = record.custodian;
      entry.custodyState = record.state;
    } else if (record.op === 'del') {
      if (typeof record.id !== 'string' || !DEL_REASONS.includes(record.why)) return bad();
      entries.delete(record.id);
    } else {
      bad();
    }
    return undefined;
  }

  /** Rewrite the index when dead records outnumber live ones (and are worth a rewrite). */
  #compactIndexIfWorthIt() {
    if (this.#compactingIndex || this.#reserved > 0) return;
    let live = this.#entries.size;
    for (const entry of this.#entries.values()) if (entry.custodian !== null) live += 1;
    const dead = this.#indexLines - live;
    if (dead <= INDEX_COMPACT_MIN_DEAD || dead <= live) return;
    const records = [];
    for (const e of [...this.#entries.values()].sort((a, b) => a.seq - b.seq)) {
      records.push({
        op: 'add',
        id: e.id,
        dst: e.dst,
        kind: e.kind,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        bytes: e.bytes,
        custody: e.custody,
      });
      if (e.custodian !== null) {
        records.push({ op: 'cust', id: e.id, custodian: e.custodian, state: e.custodyState });
      }
    }
    this.#compactingIndex = true;
    this.#indexLines = records.length;
    this.#persist(this.#index.rewrite(records).finally(() => {
      this.#compactingIndex = false;
    }));
  }

  async #readSeen() {
    const now = this.#now();
    const live = [];
    let lines = 0;
    for await (const record of this.#seenLog.read()) {
      lines += 1;
      const ok =
        isValidNodeId(record.from) && typeof record.id === 'string' && MESSAGE_ID_PATTERN.test(record.id) &&
        Number.isSafeInteger(record.exp);
      if (!ok) this.#stats.seenCorrupt += 1;
      else if (record.exp > now) live.push([`${record.from}:${record.id}`, record.exp]);
    }
    for (const [key, exp] of live.sort((a, b) => b[1] - a[1]).slice(0, this.#seenMax)) {
      this.#seen.add(key, exp, now);
    }
    this.#seenAppends = lines;
    // More than half of it is dead: rewrite it, so the log does not grow for ever.
    if (lines > 0 && lines - this.#seen.size(now) > lines / 2) await this.#rewriteSeen();
  }

  #compactSeenIfWorthIt() {
    if (this.#compactingSeen || this.#seenAppends < SEEN_COMPACT_MIN_APPENDS) return;
    if (this.#seenAppends - this.#seen.size(this.#now()) <= this.#seenAppends / 2) return;
    this.#persist(this.#rewriteSeen());
  }

  async #rewriteSeen() {
    this.#compactingSeen = true;
    try {
      const records = this.#seen.entries().map(([key, exp]) => {
        const [from, id] = key.split(':');
        return { from, id, exp };
      });
      this.#seenAppends = records.length;
      await this.#seenLog.rewrite(records);
    } finally {
      this.#compactingSeen = false;
    }
  }

  /** Track background store work; a failure is counted and logged, never thrown. */
  #persist(promise) {
    return this.#track(promise.catch((error) => {
      this.#stats.storeErrors += 1;
      this.#log?.warn?.('store write failed', { code: error?.code ?? null });
    }));
  }

  #track(promise) {
    const done = promise.then(() => {}, () => {});
    this.#ops.add(done);
    done.then(() => this.#ops.delete(done));
    return promise;
  }

  #emit(type, data) {
    if (this.#events === null) return;
    try {
      this.#events.emit(type, data);
    } catch (error) {
      this.#log?.warn?.('event emit failed', { type, code: error?.code ?? null });
    }
  }
}

/** A short, plaintext-free description of an error for an event. */
function safeMessage(error) {
  const text = error instanceof ClawNetError ? error.message : (error?.name ?? 'Error');
  return String(text).slice(0, MAX_EVENT_TEXT);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new ConfigError(`${name} must be a function`);
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
}

