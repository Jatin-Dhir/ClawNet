/**
 * ClawSync engine: gossip push and anti-entropy pull (DESIGN.md section 9).
 *
 * Two mechanisms keep the datasets of neighbouring nodes equal:
 *
 *   - Eager push. A record this node accepts as new is forwarded to every peer except
 *     the one it came from, batched for a few milliseconds. A record that is old or a
 *     duplicate is not accepted and therefore not forwarded; that is what ends the flood.
 *   - Anti-entropy. On link-up and then periodically with one random peer, a push-pull
 *     round. Per dataset we first send a hash of our whole digest (DESIGN.md section 15,
 *     item 20); if the peer's is the same, the dataset is done. Otherwise we send our
 *     digest page by page; for each page the peer answers with the records we lack
 *     (SYNC_DELTA) and a request for what it lacks (SYNC_REQUEST); we answer the request
 *     (SYNC_DELTA) and send the next page.
 *
 * A round is stop-and-wait: at most one digest page is outstanding per peer, and every
 * packet received triggers at most two packets in reply. The responder keeps no copy of
 * our digest. Where a page cannot be dealt with in one packet, the peer names the cursor
 * it got to and the next page restarts there, so a difference of any size is worked off
 * in bounded steps.
 *
 * What a peer can make this node do is bounded:
 *
 *   - nothing is stored unless the dataset's `check` passed it, and a record that fails
 *     is dropped, reported through `onError` and never forwarded;
 *   - a packet's list sizes are checked before the list is walked, and each list is
 *     handled in one pass;
 *   - within one round each record is sent to the peer at most once, in either role, and
 *     a peer may start a round at most once per `minRoundIntervalMs`;
 *   - a round takes at most `maxRoundSteps` pages, and pages shrink while a peer consumes
 *     only a little of each;
 *   - the gossip queue per peer holds at most `maxPendingPerPeer` records; beyond that
 *     records are dropped and anti-entropy repairs the gap;
 *   - a peer may introduce at most `newKeysPerMinute` keys (LWW) or streams (logs) this
 *     node did not know, and records of origins refused by `allowOrigin` are dropped;
 *     both are decided before any signature is checked (section 15, item 19).
 *
 * A dataset may also have a flood hold-down (section 15, item 17): every record it
 * accepts is stored at once, but per key at most one is flooded per interval, and the
 * newest one held back is flooded when the interval ends, so the newest is never lost.
 *
 * Pure protocol logic: the transport, the monotonic clock, the timer and the random
 * source are injected. Packet layouts are specified in SYNC-WIRE.md.
 */

import { CanonicalError, ConfigError, StateError, WireError } from '../core/errors.js';
import { canonicalBytes, parseCanonical } from '../core/wire/canonical.js';
import { Limits, PacketType } from '../core/wire/types.js';
import { SET_NAME_PATTERN, SyncFault } from './datasets.js';

/** Wire limits of the sync packets. Changing a value changes the protocol. */
export const SyncWire = Object.freeze({
  /** Most records in a GOSSIP or SYNC_DELTA, entries in a SYNC_DIGEST, items in a SYNC_REQUEST. */
  MAX_ITEMS: 1024,
  /** Largest record, as canonical JSON bytes. */
  MAX_RECORD: 64 * 1024,
  /** Largest body: what is left of a packet after the fixed prefix and a full header. */
  MAX_BODY: Limits.MAX_PACKET - 4 - Limits.MAX_HEADER,
});

/** Limits used when the constructor is not given others. */
export const DEFAULT_SYNC_LIMITS = Object.freeze({
  maxRecordsPerPacket: 256,
  maxBytesPerPacket: 256 * 1024,
  maxPendingPerPeer: 4096,
});

/** Length prefix of one record in a batch body. */
const FRAME_PREFIX = 4;

/** Smallest digest page, so that a round still advances when pages have shrunk. */
const MIN_PAGE = 8;

/** Cursor value for "the whole dataset has been covered". Never leaves this module. */
const END = Symbol('end');

/** `page` of a round whose outstanding packet is a summary, not a digest page. */
const SUMMARY = Symbol('summary');

/** A digest summary: SHA-256 as lowercase hex. */
const SUMMARY_PATTERN = /^[0-9a-f]{64}$/;

/** The new-key budget refills over this period. */
const BUDGET_PERIOD_MS = 60_000;

/**
 * Default of the `newKeysPerMinute` option: the size of a full default LSDB, so that a
 * node joining a large network can still learn all of it from one neighbour in a minute.
 */
export const DEFAULT_NEW_KEYS_PER_MINUTE = 10_000;

const DATASET_METHODS = [
  'offer',
  'syncKnows',
  'syncSummary',
  'syncPage',
  'syncCursor',
  'syncCompare',
  'syncReconcile',
  'syncServe',
  'syncConsumed',
];

/**
 * Encode records as a batch body: `u32be length || canonical JSON` per record.
 *
 * @param {object[]} records  1..SyncWire.MAX_ITEMS records
 * @returns {Buffer}
 * @throws {CanonicalError} if a record is not canonical-JSON data
 * @throws {WireError} if there are no records or too many, a record exceeds
 *   SyncWire.MAX_RECORD, or the batch exceeds SyncWire.MAX_BODY
 */
export function encodeRecords(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > SyncWire.MAX_ITEMS) {
    throw new WireError(`a record batch holds 1..${SyncWire.MAX_ITEMS} records`);
  }
  const batch = new Batch(SyncWire.MAX_ITEMS, SyncWire.MAX_BODY);
  for (const record of records) {
    const bytes = canonicalBytes(record);
    if (bytes.length > SyncWire.MAX_RECORD) {
      throw new WireError(`record is ${bytes.length} bytes, limit is ${SyncWire.MAX_RECORD}`);
    }
    if (!batch.add(bytes)) throw new WireError('record batch exceeds the body limit');
  }
  return batch.body();
}

/**
 * Decode a batch body received from a peer. Strict: the body must hold exactly `count`
 * records, each in canonical form.
 *
 * @param {Uint8Array} body
 * @param {number} count  the `n` of the packet header, 1..SyncWire.MAX_ITEMS
 * @returns {unknown[]} the parsed records; not yet validated by any dataset
 * @throws {SyncFault} "bad-header", "bad-body" or "bad-record"
 */
export function decodeRecords(body, count) {
  if (!(body instanceof Uint8Array)) throw new SyncFault('bad-body', 'body is not bytes');
  return splitFrames(asBuffer(body), itemCount(count)).map(parseRecord);
}

/**
 * Gossip and anti-entropy for a set of datasets over injected links.
 *
 * The owner wires it up: call addPeer/removePeer as links come and go, hand every
 * received GOSSIP, SYNC_DIGEST, SYNC_REQUEST and SYNC_DELTA packet to handlePacket, call
 * tick() every sync interval, and disconnect a peer reported through `onError`.
 */
export class SyncEngine {
  /** @type {object[]} datasets in round order */
  #order;
  /** @type {Map<string, object>} */
  #sets = new Map();
  #send;
  #now;
  #rng;
  #limits;
  #gossipBatchMs;
  #schedule;
  #onError;
  #self;
  #roundTimeoutMs;
  #minRoundIntervalMs;
  #maxRoundSteps;
  #newKeysPerMinute;
  #allowOrigin;
  /**
   * peerId -> {
   *   id,
   *   pending: Map<dataset, object[]>, pendingCount   gossip waiting for the next flush
   *   out: { round, set, summed, after, page, pageSize, steps, activeAt } | null   round
   *     we started; `page` is SUMMARY while the summary of dataset `set` is outstanding
   *   inbound: { round, startedAt, pushed: Map<name, cursor | END> } | null   round we serve
   *   budget: { tokens, at }   new keys this peer may still introduce
   * }
   */
  #peers = new Map();
  /**
   * dataset -> { dataset, ms, keys: Map<key, { at, pending }>, queue: Array<{ key, at }>,
   *   head }
   * for the datasets with a flood hold-down. `pending` is the newest record held back,
   * `{ record, except }`, or null. `queue` lists flood times in order; an item whose time
   * no longer matches its key's `at` is stale and skipped.
   */
  #holds = new Map();
  #roundSeq = 0;
  #cancelFlush = null;
  #cancelHold = null;
  #stats = newStats();

  /**
   * @param {object} options
   * @param {object[]} options.datasets  the datasets to synchronize, each implementing
   *   the sync contract of datasets.js; a round walks them in this order
   * @param {(peerId: string, packet: { type: number, header: object, body: Buffer }) => boolean}
   *   options.send  hand a packet to the link with `peerId`; returns false if it could
   *   not be queued. Must not call back into this engine synchronously.
   * @param {() => number} options.monoNow  MONOTONIC clock in milliseconds (for example
   *   `performance.now`). Every interval here is measured on it: round timeouts, the
   *   round rate, the new-key budget, flood hold-downs. The engine reads no wall clock.
   * @param {() => number} [options.rng=Math.random]  uniform in [0, 1); picks the peer of
   *   a periodic round. Not used for anything security relevant.
   * @param {object} [options.limits]  defaults: DEFAULT_SYNC_LIMITS
   * @param {number} [options.limits.maxRecordsPerPacket]  most records per GOSSIP or
   *   SYNC_DELTA, entries per digest page and items per request we send;
   *   1..SyncWire.MAX_ITEMS
   * @param {number} [options.limits.maxBytesPerPacket]  largest packet body we send, in
   *   bytes; SyncWire.MAX_RECORD + 4 .. SyncWire.MAX_BODY, so that any record fits
   * @param {number} [options.limits.maxPendingPerPeer]  most records queued for gossip
   *   per peer between flushes; >= 1
   * @param {number} [options.gossipBatchMs=25]  how long gossip is batched, in
   *   milliseconds; only used with `schedule`
   * @param {(fn: () => void, ms: number) => (() => void)} [options.schedule]  one-shot
   *   timer returning a cancel function. Without it nothing is flushed automatically and
   *   the owner calls flush().
   * @param {(peerId: string, reason: string, detail: string) => void} [options.onError]
   *   a peer broke the protocol; `reason` is a stable identifier ("invalid-record",
   *   "bad-digest", "bad-range", ...). The owner should disconnect the peer.
   * @param {string} [options.self]  this node's id. When given, of two nodes that link up
   *   only the one with the smaller id starts the link-up round, which halves the
   *   traffic of the first sync; a round is push-pull, so one is enough.
   * @param {number} [options.roundTimeoutMs=10000]  a round with no reply for this long
   *   is abandoned by the next tick()
   * @param {number} [options.minRoundIntervalMs=1000]  a peer that starts rounds more
   *   often than this is declined
   * @param {number} [options.maxRoundSteps=4096]  most digest pages one round may take;
   *   what is left is picked up by the next round
   * @param {number} [options.newKeysPerMinute=10000]  most records per peer and minute
   *   whose key (LWW) or stream (log) this node did not know; the rest are dropped
   *   before any signature work and left to a later round. The budget refills
   *   continuously and starts full.
   * @param {(origin: string) => boolean} [options.allowOrigin]  origin policy: a
   *   received record whose `origin` is a string for which this is not `true` is
   *   dropped before any signature work. Not a protocol violation: the relaying peer may
   *   apply another policy.
   * @param {Record<string, number>} [options.holdDownMs]  flood hold-down per dataset
   *   name, in milliseconds (for LSAs, 5000): per key at most one record is flooded per
   *   interval; the newest one received meanwhile is flooded when it ends. The dataset
   *   must implement syncKey(). Needs `schedule`, or calls of tick() or flush(), to
   *   release held records.
   * @throws {ConfigError} if an option is missing, malformed or out of range
   */
  constructor({
    datasets,
    send,
    monoNow,
    rng = Math.random,
    limits = {},
    gossipBatchMs = 25,
    schedule,
    onError,
    self,
    roundTimeoutMs = 10_000,
    minRoundIntervalMs = 1_000,
    maxRoundSteps = 4_096,
    newKeysPerMinute = DEFAULT_NEW_KEYS_PER_MINUTE,
    allowOrigin,
    holdDownMs = {},
  } = {}) {
    if (!Array.isArray(datasets) || datasets.length === 0) {
      throw new ConfigError('datasets must be a non-empty array');
    }
    for (const dataset of datasets) {
      if (dataset === null || typeof dataset !== 'object') {
        throw new ConfigError('each dataset must be an object');
      }
      if (typeof dataset.name !== 'string' || !SET_NAME_PATTERN.test(dataset.name)) {
        throw new ConfigError('dataset name must match /^[a-z][a-z0-9-]{0,31}$/');
      }
      for (const method of DATASET_METHODS) {
        if (typeof dataset[method] !== 'function') {
          throw new ConfigError(`dataset "${dataset.name}" does not implement ${method}()`);
        }
      }
      if (this.#sets.has(dataset.name)) {
        throw new ConfigError(`duplicate dataset name "${dataset.name}"`);
      }
      this.#sets.set(dataset.name, dataset);
    }
    this.#order = datasets.slice();

    for (const [label, fn] of [['send', send], ['monoNow', monoNow], ['rng', rng]]) {
      if (typeof fn !== 'function') throw new ConfigError(`${label} must be a function`);
    }
    const optional = [
      ['schedule', schedule],
      ['onError', onError],
      ['allowOrigin', allowOrigin],
    ];
    for (const [label, fn] of optional) {
      if (fn !== undefined && typeof fn !== 'function') {
        throw new ConfigError(`${label} must be a function when given`);
      }
    }
    if (self !== undefined && (typeof self !== 'string' || self === '')) {
      throw new ConfigError('self must be a non-empty string when given');
    }
    if (limits === null || typeof limits !== 'object') {
      throw new ConfigError('limits must be an object');
    }
    const merged = { ...DEFAULT_SYNC_LIMITS, ...limits };
    requireInteger(
      merged.maxRecordsPerPacket,
      'limits.maxRecordsPerPacket',
      1,
      SyncWire.MAX_ITEMS,
    );
    requireInteger(
      merged.maxBytesPerPacket,
      'limits.maxBytesPerPacket',
      SyncWire.MAX_RECORD + FRAME_PREFIX,
      SyncWire.MAX_BODY,
    );
    const unbounded = Number.MAX_SAFE_INTEGER;
    requireInteger(merged.maxPendingPerPeer, 'limits.maxPendingPerPeer', 1, unbounded);
    requireInteger(gossipBatchMs, 'gossipBatchMs', 0, unbounded);
    requireInteger(roundTimeoutMs, 'roundTimeoutMs', 1, unbounded);
    requireInteger(minRoundIntervalMs, 'minRoundIntervalMs', 0, unbounded);
    requireInteger(maxRoundSteps, 'maxRoundSteps', 1, unbounded);
    requireInteger(newKeysPerMinute, 'newKeysPerMinute', 1, unbounded);
    if (holdDownMs === null || typeof holdDownMs !== 'object' || Array.isArray(holdDownMs)) {
      throw new ConfigError('holdDownMs must be an object of dataset names to milliseconds');
    }
    for (const [name, ms] of Object.entries(holdDownMs)) {
      const dataset = this.#sets.get(name);
      if (dataset === undefined) throw new ConfigError(`holdDownMs: no dataset "${name}"`);
      if (typeof dataset.syncKey !== 'function') {
        throw new ConfigError(`holdDownMs: dataset "${name}" does not implement syncKey()`);
      }
      requireInteger(ms, `holdDownMs.${name}`, 1, unbounded);
      this.#holds.set(dataset, { dataset, ms, keys: new Map(), queue: [], head: 0 });
    }

    this.#send = send;
    this.#now = monoNow;
    this.#newKeysPerMinute = newKeysPerMinute;
    this.#allowOrigin = allowOrigin;
    this.#rng = rng;
    this.#limits = Object.freeze({
      maxRecordsPerPacket: merged.maxRecordsPerPacket,
      maxBytesPerPacket: merged.maxBytesPerPacket,
      maxPendingPerPeer: merged.maxPendingPerPeer,
    });
    this.#gossipBatchMs = gossipBatchMs;
    this.#schedule = schedule;
    this.#onError = onError;
    this.#self = self;
    this.#roundTimeoutMs = roundTimeoutMs;
    this.#minRoundIntervalMs = minRoundIntervalMs;
    this.#maxRoundSteps = maxRoundSteps;
  }

  /**
   * A link to `peerId` is up. Starts an anti-entropy round with it at once (unless
   * `self` was given and the peer has the smaller id, in which case the peer starts it).
   *
   * @param {string} peerId
   * @returns {boolean} false if the peer was already known, in which case nothing changes
   * @throws {ConfigError} if `peerId` is not a non-empty string
   */
  addPeer(peerId) {
    if (typeof peerId !== 'string' || peerId === '') {
      throw new ConfigError('peerId must be a non-empty string');
    }
    if (this.#peers.has(peerId)) return false;
    const peer = {
      id: peerId,
      pending: new Map(),
      pendingCount: 0,
      out: null,
      inbound: null,
      budget: { tokens: this.#newKeysPerMinute, at: this.#now() },
    };
    this.#peers.set(peerId, peer);
    if (this.#self === undefined || this.#self < peerId) this.#startRound(peer);
    return true;
  }

  /**
   * The link to `peerId` is gone. Drops its queued gossip and any round in progress.
   *
   * @param {string} peerId
   * @returns {boolean} whether the peer was known
   */
  removePeer(peerId) {
    return this.#peers.delete(peerId);
  }

  /**
   * Accept a record created by this node and push it to every peer.
   *
   * @param {string} datasetName
   * @param {object} record  a signed record; it goes through the dataset's `check` like
   *   any other, and must not be mutated afterwards
   * @returns {{ accepted: boolean, reason?: string }}  `reason` is the dataset's, or
   *   "unencodable" (not canonical-JSON data) or "too-large" (over SyncWire.MAX_RECORD)
   * @throws {StateError} if no dataset has that name
   */
  publish(datasetName, record) {
    const dataset = this.#sets.get(datasetName);
    if (dataset === undefined) throw new StateError('publish: unknown dataset');
    let bytes;
    try {
      bytes = canonicalBytes(record);
    } catch (err) {
      if (!(err instanceof CanonicalError)) throw err;
      return { accepted: false, reason: 'unencodable' };
    }
    // Refused here rather than at send time, so everything published can travel.
    if (bytes.length > SyncWire.MAX_RECORD) return { accepted: false, reason: 'too-large' };

    const result = dataset.offer(record);
    if (!result.accepted) return { accepted: false, reason: result.reason };
    this.#stats.published += 1;
    this.#forward(dataset, record, null);
    return { accepted: true };
  }

  /**
   * Process a sync packet received from a peer.
   *
   * Protocol violations are reported through `onError` and never thrown; the rest of the
   * offending packet is ignored. A packet from a peer that is not (or no longer) known
   * is dropped silently, because packets can still arrive just after removePeer().
   *
   * @param {string} peerId
   * @param {{ type: number, header: object, body?: Uint8Array }} packet  as decoded by
   *   core/wire/codec.js
   * @throws {StateError} if the packet is not an object or not one of the four sync types;
   *   that is a routing mistake of the caller, not of the peer
   */
  handlePacket(peerId, packet) {
    if (packet === null || typeof packet !== 'object') {
      throw new StateError('handlePacket: packet must be an object');
    }
    const handler = this.#handlerFor(packet.type);
    const peer = this.#peers.get(peerId);
    if (peer === undefined) {
      this.#stats.strayPackets += 1;
      return;
    }
    try {
      const { header, body } = packet;
      if (!isPlainObject(header)) throw new SyncFault('bad-header', 'header is not an object');
      if (!(body instanceof Uint8Array) || body.length === 0) {
        throw new SyncFault('bad-body', 'sync packets always carry a body');
      }
      if (body.length > SyncWire.MAX_BODY) throw new SyncFault('bad-body', 'body is too large');
      handler.call(this, peer, header, asBuffer(body), packet.type);
    } catch (err) {
      if (!(err instanceof SyncFault)) throw err;
      this.#stats.faults += 1;
      // Whatever the peer meant, a round with it cannot be trusted to continue.
      if (peer.out !== null) this.#abandon(peer);
      if (this.#onError !== undefined) this.#onError(peer.id, err.reason, err.message);
    }
  }

  /**
   * One periodic anti-entropy round: pick a random peer that has no round of ours in
   * progress and start one. Rounds that got no reply for `roundTimeoutMs` are abandoned
   * first, which makes their peers eligible again. The owner calls this every sync
   * interval.
   *
   * @returns {string | null} the peer a round was started with, or null if there was none
   */
  tick() {
    const now = this.#now();
    this.#releaseHolds(now);
    const idle = [];
    for (const peer of this.#peers.values()) {
      if (peer.out !== null) {
        const quiet = now - peer.out.activeAt;
        // A clock that stepped backwards must not keep a dead round alive.
        if (quiet < 0 || quiet >= this.#roundTimeoutMs) this.#abandon(peer);
      }
      if (peer.out === null) idle.push(peer);
    }
    if (idle.length === 0) return null;
    const peer = idle[pick(this.#rng, idle.length)];
    this.#startRound(peer);
    return peer.id;
  }

  /**
   * Send all batched gossip now, after releasing held records whose hold-down has
   * ended. Called by the batch timer; the owner calls it directly when it runs without
   * `schedule`.
   */
  flush() {
    this.#releaseHolds(this.#now());
    this.#disarm();
    // One encoding per record, shared by every peer it goes to.
    const encoded = new Map();
    for (const peer of this.#peers.values()) {
      if (peer.pendingCount > 0) this.#flushPeer(peer, encoded);
    }
  }

  /**
   * Stop: cancel the timers, forget every peer and every held record. Nothing is sent.
   * The datasets are untouched and the engine can be used again by adding peers.
   */
  close() {
    this.#disarm();
    this.#disarmHold();
    for (const hold of this.#holds.values()) {
      hold.keys.clear();
      hold.queue = [];
      hold.head = 0;
    }
    this.#peers.clear();
  }

  /**
   * @returns {object} a snapshot of the counters (all integers), plus `peers`, the
   *   number of known peers, `pending`, the records queued for gossip,
   *   `activeRounds`, the rounds this node started that are still in progress, and
   *   `held`, the records waiting for a flood hold-down to end
   */
  stats() {
    let pending = 0;
    let activeRounds = 0;
    for (const peer of this.#peers.values()) {
      pending += peer.pendingCount;
      if (peer.out !== null) activeRounds += 1;
    }
    let held = 0;
    for (const hold of this.#holds.values()) {
      for (const state of hold.keys.values()) if (state.pending !== null) held += 1;
    }
    return { ...this.#stats, peers: this.#peers.size, pending, activeRounds, held };
  }

  #handlerFor(type) {
    switch (type) {
      case PacketType.GOSSIP:
      case PacketType.SYNC_DELTA:
        return this.#onRecords;
      case PacketType.SYNC_DIGEST:
        return this.#onDigest;
      case PacketType.SYNC_REQUEST:
        return this.#onRequest;
      default:
        throw new StateError('handlePacket: not a sync packet type');
    }
  }

  /** GOSSIP and SYNC_DELTA: a batch of records for one dataset. */
  #onRecords(peer, header, body, type) {
    fields(header, ['n', 'set']);
    const name = setName(header.set);
    const count = itemCount(header.n);
    const frames = splitFrames(body, count);
    if (type === PacketType.GOSSIP) this.#stats.gossipIn += 1;
    else this.#stats.deltasIn += 1;
    this.#stats.recordsIn += count;

    const dataset = this.#sets.get(name);
    if (dataset === undefined) {
      // A peer may run datasets this node does not; its records are simply not for us.
      this.#stats.unknownSets += 1;
      return;
    }
    for (const frame of frames) {
      const record = parseRecord(frame);
      // Both decided before the dataset spends anything on the record.
      if (!this.#originAllowed(record)) {
        this.#stats.refusedOrigin += 1;
        continue;
      }
      if (!dataset.syncKnows(record) && !this.#spendBudget(peer)) {
        this.#stats.overBudget += 1;
        continue;
      }
      const result = dataset.offer(record, peer.id);
      if (result.accepted) {
        this.#stats.accepted += 1;
        this.#forward(dataset, record, peer.id);
      } else if (result.invalid) {
        // A correct peer validates before it relays. Stop here: nothing else in this
        // packet deserves a signature check.
        this.#stats.invalid += 1;
        throw new SyncFault('invalid-record', `${name}: ${result.reason}`);
      } else {
        this.#stats.ignored += 1;
      }
    }
  }

  /**
   * SYNC_DIGEST: a peer's digest summary or digest page. Answer a summary with "same" or
   * "go on", a page with what the peer lacks and what we lack.
   */
  #onDigest(peer, header, body) {
    const summary = isPlainObject(header) && Object.hasOwn(header, 'sum');
    if (summary) fields(header, ['round', 'set', 'sum']);
    else fields(header, ['after', 'round', 'set', 'upto'], ['hint']);
    const name = setName(header.set);
    const round = roundId(header.round);
    if (summary && (typeof header.sum !== 'string' || !SUMMARY_PATTERN.test(header.sum))) {
      throw new SyncFault('bad-header', 'sum is not a SHA-256 in hex');
    }
    if (header.hint !== undefined && !isPlainObject(header.hint)) {
      throw new SyncFault('bad-hint', 'hint is not an object');
    }
    const entries = parseList(body, 'bad-digest');
    if (summary && entries.length > 0) {
      throw new SyncFault('bad-digest', 'a summary carries an empty list');
    }
    this.#stats.digestsIn += 1;

    const now = this.#now();
    let inbound = peer.inbound;
    if (inbound !== null && round < inbound.round) {
      this.#stats.staleDigests += 1;
      return;
    }
    if (inbound === null || round > inbound.round) {
      if (inbound !== null) {
        const elapsed = now - inbound.startedAt;
        if (elapsed >= 0 && elapsed < this.#minRoundIntervalMs) {
          // Each round may cost us a copy of every dataset, so rounds are rationed.
          this.#stats.roundsRefused += 1;
          this.#decline(peer, name, round, 'round');
          return;
        }
      }
      inbound = { round, startedAt: now, pushed: new Map() };
      peer.inbound = inbound;
      this.#stats.roundsServed += 1;
    }

    const dataset = this.#sets.get(name);
    if (dataset === undefined) {
      this.#stats.unknownSets += 1;
      this.#decline(peer, name, round, 'set');
      return;
    }

    if (summary) {
      // Equal summaries: nothing to exchange for this dataset (DESIGN.md 15, item 20).
      this.#stats.summariesIn += 1;
      const same = dataset.syncSummary() === header.sum;
      if (same) this.#stats.summaryMatches += 1;
      const sent = this.#transmit(peer, {
        type: PacketType.SYNC_REQUEST,
        header: same ? { next: null, round, set: name, stop: 'same' } : { next: null, round, set: name },
        body: canonicalBytes([]),
      });
      if (sent) this.#stats.requestsOut += 1;
      return;
    }

    const after = header.after === null ? null : dataset.syncCursor(header.after);
    const upto = header.upto === null ? null : dataset.syncCursor(header.upto);
    // Pushes never go back over ground already covered in this round, so replaying a
    // digest cannot make us send a record twice.
    const pushed = inbound.pushed.get(name);
    const steps = dataset.syncReconcile(
      { after, upto, entries, hint: header.hint ?? {} },
      { push: pushed !== END, pushAfter: pushed === undefined || pushed === END ? null : pushed },
    );

    const batch = this.#batch();
    const wants = [];
    let wantBytes = 2;
    let next = null;
    let complete = true;
    for (const step of steps) {
      if (step.push !== undefined) {
        const bytes = this.#encode(step.push);
        if (bytes !== null && !batch.add(bytes)) {
          complete = false;
          break;
        }
      } else {
        const size = JSON.stringify(step.want).length + 1;
        if (
          wants.length >= this.#limits.maxRecordsPerPacket ||
          wantBytes + size > this.#limits.maxBytesPerPacket
        ) {
          complete = false;
          break;
        }
        wants.push(step.want);
        wantBytes += size;
      }
      next = step.cursor;
    }
    if (complete) next = null;

    // If the records cannot be sent, say nothing: the peer's round then times out
    // instead of moving on as though it had received them.
    if (batch.count > 0 && !this.#sendRecords(peer, PacketType.SYNC_DELTA, dataset, batch)) return;
    inbound.pushed.set(name, furthest(dataset, pushed, next ?? upto ?? END));

    const sent = this.#transmit(peer, {
      type: PacketType.SYNC_REQUEST,
      header: { next, round, set: name },
      body: canonicalBytes(wants),
    });
    if (sent) this.#stats.requestsOut += 1;
  }

  /** SYNC_REQUEST: the reply to our outstanding digest page. Serve it, then move on. */
  #onRequest(peer, header, body) {
    fields(header, ['next', 'round', 'set'], ['stop']);
    const name = setName(header.set);
    const round = roundId(header.round);
    const wants = parseList(body, 'bad-request');
    this.#stats.requestsIn += 1;

    const lane = peer.out;
    if (
      lane === null ||
      lane.round !== round ||
      lane.page === null ||
      this.#order[lane.set].name !== name
    ) {
      // A reply to a round we gave up on, or to a page already answered.
      this.#stats.staleReplies += 1;
      return;
    }
    const dataset = this.#order[lane.set];
    const page = lane.page;
    if (header.stop !== undefined && (header.next !== null || wants.length > 0)) {
      throw new SyncFault('bad-header', 'a stop carries no continuation and no request');
    }
    if (header.stop === 'round') {
      peer.out = null;
      this.#stats.roundsDeclined += 1;
      return;
    }
    if (page === SUMMARY) {
      // The answer to a summary: "same" ends the dataset, anything else starts its pages.
      if (header.stop === undefined && (header.next !== null || wants.length > 0)) {
        throw new SyncFault('bad-header', 'the answer to a summary carries no request');
      }
      if (header.stop !== undefined && header.stop !== 'same' && header.stop !== 'set') {
        throw new SyncFault('bad-header', 'unknown stop scope');
      }
      if (header.stop === 'same') this.#stats.summariesSkipped += 1;
      lane.after = header.stop === undefined ? null : END;
      lane.page = null;
      lane.activeAt = this.#now();
      this.#advance(peer);
      return;
    }

    const batch = this.#batch();
    // Where the next page starts: a cursor of the dataset, or END.
    let resume;
    if (header.stop !== undefined) {
      if (header.stop !== 'set') throw new SyncFault('bad-header', 'unknown stop scope');
      resume = END;
    } else {
      const next = header.next === null ? null : dataset.syncCursor(header.next);
      if (next !== null) {
        // A continuation that stays put would let a peer keep a round alive for ever.
        if (page.after !== null && dataset.syncCompare(next, page.after) <= 0) {
          throw new SyncFault('bad-cursor', 'continuation does not advance');
        }
        if (page.upto !== null && dataset.syncCompare(next, page.upto) > 0) {
          throw new SyncFault('bad-cursor', 'continuation is beyond the page');
        }
      }
      resume = next ?? page.upto ?? END;
      let served = null;
      for (const step of dataset.syncServe(wants, page, next)) {
        const bytes = this.#encode(step.record);
        if (bytes !== null && !batch.add(bytes)) {
          // The packet is full. Restart after the last record that went out; the peer
          // asks again for the rest when it sees the next page.
          resume = served;
          break;
        }
        served = step.cursor;
      }
    }

    if (batch.count > 0 && !this.#sendRecords(peer, PacketType.SYNC_DELTA, dataset, batch)) {
      this.#abandon(peer);
      return;
    }

    // Size the next page by how much of this one the exchange got through, so that a
    // peer that works off a page a few entries at a time is not sent the rest of it
    // again and again.
    const largest = this.#limits.maxRecordsPerPacket;
    const consumed = resume === END ? page.entries.length : dataset.syncConsumed(page, resume);
    lane.pageSize =
      consumed >= page.entries.length
        ? Math.min(largest, lane.pageSize * 2)
        : Math.min(largest, Math.max(MIN_PAGE, consumed * 2));
    lane.after = resume;
    lane.page = null;
    lane.activeAt = this.#now();
    this.#advance(peer);
  }

  #startRound(peer) {
    this.#roundSeq += 1;
    peer.out = {
      round: this.#roundSeq,
      set: 0,
      summed: false,
      after: null,
      page: null,
      pageSize: this.#limits.maxRecordsPerPacket,
      steps: 0,
      activeAt: this.#now(),
    };
    this.#stats.roundsStarted += 1;
    this.#advance(peer);
  }

  #abandon(peer) {
    peer.out = null;
    this.#stats.roundsAbandoned += 1;
  }

  #decline(peer, name, round, scope) {
    this.#transmit(peer, {
      type: PacketType.SYNC_REQUEST,
      header: { next: null, round, set: name, stop: scope },
      body: canonicalBytes([]),
    });
  }

  /**
   * Send the next packet of the round we run with `peer`: a dataset's summary first,
   * then its digest pages; or finish the round.
   */
  #advance(peer) {
    const lane = peer.out;
    if (lane.after === END) {
      lane.set += 1;
      lane.summed = false;
      lane.after = null;
      lane.pageSize = this.#limits.maxRecordsPerPacket;
    }
    if (lane.set >= this.#order.length) {
      peer.out = null;
      this.#stats.roundsCompleted += 1;
      return;
    }
    if (lane.steps >= this.#maxRoundSteps) {
      this.#abandon(peer);
      return;
    }
    lane.steps += 1;

    const dataset = this.#order[lane.set];
    if (!lane.summed) {
      lane.summed = true;
      const header = { round: lane.round, set: dataset.name, sum: dataset.syncSummary() };
      if (!this.#transmit(peer, { type: PacketType.SYNC_DIGEST, header, body: canonicalBytes([]) })) {
        this.#abandon(peer);
        return;
      }
      this.#stats.digestsOut += 1;
      this.#stats.summariesOut += 1;
      lane.page = SUMMARY;
      return;
    }
    const page = dataset.syncPage(lane.after, {
      maxEntries: lane.pageSize,
      maxBytes: this.#limits.maxBytesPerPacket,
    });
    const header = { after: page.after, round: lane.round, set: dataset.name, upto: page.upto };
    if (Object.keys(page.hint).length > 0) header.hint = page.hint;
    const body = canonicalBytes(page.entries);
    if (!this.#transmit(peer, { type: PacketType.SYNC_DIGEST, header, body })) {
      this.#abandon(peer);
      return;
    }
    this.#stats.digestsOut += 1;
    lane.page = page;
  }

  /**
   * A record this node just accepted: flood it, unless its dataset has a hold-down and
   * the record's key was flooded less than one interval ago. Then it waits, replacing
   * any record of that key already waiting, and the newest goes out when the interval
   * ends.
   */
  #forward(dataset, record, exceptPeerId) {
    const hold = this.#holds.get(dataset);
    const key = hold === undefined ? null : dataset.syncKey(record);
    if (key === null) {
      this.#queueGossip(dataset, record, exceptPeerId);
      return;
    }
    const now = this.#now();
    const state = hold.keys.get(key);
    if (state !== undefined && !elapsed(now, state.at, hold.ms)) {
      this.#stats.heldDown += 1;
      state.pending = { record, except: exceptPeerId };
      return;
    }
    this.#floodHeld(hold, key, record, exceptPeerId, now);
    this.#armHold();
  }

  /** Flood one record of a held dataset now and start its key's interval. */
  #floodHeld(hold, key, record, exceptPeerId, now) {
    hold.keys.set(key, { at: now, pending: null });
    hold.queue.push({ key, at: now });
    this.#queueGossip(hold.dataset, record, exceptPeerId);
  }

  /**
   * End the intervals that are over: flood what waits, forget keys that have been quiet
   * for a whole interval. Each queue is in time order, so this stops at the first
   * interval still running.
   */
  #releaseHolds(now) {
    for (const hold of this.#holds.values()) {
      const queue = hold.queue;
      while (hold.head < queue.length) {
        const item = queue[hold.head];
        if (!elapsed(now, item.at, hold.ms)) break;
        hold.head += 1;
        const state = hold.keys.get(item.key);
        // Superseded: the key was flooded again since, and has a later queue item.
        if (state === undefined || state.at !== item.at) continue;
        if (state.pending === null) {
          hold.keys.delete(item.key);
          continue;
        }
        const { record, except } = state.pending;
        this.#stats.heldReleased += 1;
        hold.keys.set(item.key, { at: now, pending: null });
        queue.push({ key: item.key, at: now });
        this.#queueGossip(hold.dataset, record, except);
      }
      // Drop the consumed head once it is half the array, so the queue stays O(live).
      if (hold.head > 64 && hold.head * 2 > queue.length) {
        hold.queue = queue.slice(hold.head);
        hold.head = 0;
      }
    }
    this.#armHold();
  }

  /** Make sure a timer fires when the earliest running hold-down interval ends. */
  #armHold() {
    if (this.#schedule === undefined || this.#cancelHold !== null) return;
    let due = Infinity;
    for (const hold of this.#holds.values()) {
      if (hold.head < hold.queue.length) due = Math.min(due, hold.queue[hold.head].at + hold.ms);
    }
    if (due === Infinity) return;
    const cancel = this.#schedule(() => {
      this.#cancelHold = null;
      this.#releaseHolds(this.#now());
    }, Math.max(0, due - this.#now()));
    this.#cancelHold = typeof cancel === 'function' ? cancel : () => {};
  }

  #disarmHold() {
    if (this.#cancelHold === null) return;
    const cancel = this.#cancelHold;
    this.#cancelHold = null;
    cancel();
  }

  /** Whether the origin policy lets a received record through. Fails closed. */
  #originAllowed(record) {
    if (this.#allowOrigin === undefined || !isPlainObject(record)) return true;
    const origin = record.origin;
    if (typeof origin !== 'string') return true;
    try {
      return this.#allowOrigin(origin) === true;
    } catch {
      return false;
    }
  }

  /** Take one token from the peer's new-key budget; false if there is none. */
  #spendBudget(peer) {
    const budget = peer.budget;
    const now = this.#now();
    const since = now - budget.at;
    // A clock that stepped back refills nothing and restarts the measurement.
    if (since > 0) {
      budget.tokens = Math.min(
        this.#newKeysPerMinute,
        budget.tokens + (since * this.#newKeysPerMinute) / BUDGET_PERIOD_MS,
      );
    }
    budget.at = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  /** Queue a record for every peer except its source. */
  #queueGossip(dataset, record, exceptPeerId) {
    let queued = false;
    for (const peer of this.#peers.values()) {
      if (peer.id === exceptPeerId) continue;
      if (peer.pendingCount >= this.#limits.maxPendingPerPeer) {
        this.#stats.gossipDropped += 1;
        continue;
      }
      const list = peer.pending.get(dataset);
      if (list === undefined) peer.pending.set(dataset, [record]);
      else list.push(record);
      peer.pendingCount += 1;
      queued = true;
    }
    if (queued && this.#schedule !== undefined && this.#cancelFlush === null) {
      const cancel = this.#schedule(() => {
        this.#cancelFlush = null;
        this.flush();
      }, this.#gossipBatchMs);
      this.#cancelFlush = typeof cancel === 'function' ? cancel : () => {};
    }
  }

  #disarm() {
    if (this.#cancelFlush === null) return;
    const cancel = this.#cancelFlush;
    this.#cancelFlush = null;
    cancel();
  }

  #flushPeer(peer, encoded) {
    const pending = peer.pending;
    let remaining = peer.pendingCount;
    peer.pending = new Map();
    peer.pendingCount = 0;
    for (const [dataset, records] of pending) {
      let batch = this.#batch();
      for (const record of records) {
        let bytes = encoded.get(record);
        if (bytes === undefined) {
          bytes = this.#encode(record);
          encoded.set(record, bytes);
        }
        if (bytes === null) {
          remaining -= 1;
          continue;
        }
        if (batch.add(bytes)) continue;
        if (!this.#sendGossip(peer, dataset, batch)) {
          this.#stats.gossipDropped += remaining;
          return;
        }
        remaining -= batch.count;
        batch = this.#batch();
        batch.add(bytes);
      }
      if (batch.count === 0) continue;
      if (!this.#sendGossip(peer, dataset, batch)) {
        // The link is saturated or gone. Anti-entropy will carry what gossip could not.
        this.#stats.gossipDropped += remaining;
        return;
      }
      remaining -= batch.count;
    }
  }

  #sendGossip(peer, dataset, batch) {
    return this.#sendRecords(peer, PacketType.GOSSIP, dataset, batch);
  }

  #sendRecords(peer, type, dataset, batch) {
    const sent = this.#transmit(peer, {
      type,
      header: { n: batch.count, set: dataset.name },
      body: batch.body(),
    });
    if (sent) {
      if (type === PacketType.GOSSIP) this.#stats.gossipOut += 1;
      else this.#stats.deltasOut += 1;
      this.#stats.recordsOut += batch.count;
    }
    return sent;
  }

  #transmit(peer, packet) {
    const sent = this.#send(peer.id, packet) === true;
    if (!sent) this.#stats.sendFailures += 1;
    return sent;
  }

  #batch() {
    return new Batch(this.#limits.maxRecordsPerPacket, this.#limits.maxBytesPerPacket);
  }

  /** Canonical bytes of a stored record, or null if it cannot travel. */
  #encode(record) {
    let bytes;
    try {
      bytes = canonicalBytes(record);
    } catch (err) {
      if (!(err instanceof CanonicalError)) throw err;
      bytes = null;
    }
    // Only a record put into a dataset behind the engine's back can get here.
    if (bytes === null || bytes.length > SyncWire.MAX_RECORD) {
      this.#stats.unsendable += 1;
      return null;
    }
    return bytes;
  }
}

/** A record batch under construction. The first record always fits. */
class Batch {
  #frames = [];
  #bytes = 0;
  #maxRecords;
  #maxBytes;

  constructor(maxRecords, maxBytes) {
    this.#maxRecords = maxRecords;
    this.#maxBytes = maxBytes;
  }

  get count() {
    return this.#frames.length;
  }

  /**
   * @param {Buffer} encoded one record as canonical JSON
   * @returns {boolean} false if the batch is full and the record was not added
   */
  add(encoded) {
    const size = FRAME_PREFIX + encoded.length;
    if (this.#frames.length >= this.#maxRecords) return false;
    if (this.#frames.length > 0 && this.#bytes + size > this.#maxBytes) return false;
    this.#frames.push(encoded);
    this.#bytes += size;
    return true;
  }

  body() {
    const out = Buffer.allocUnsafe(this.#bytes);
    let offset = 0;
    for (const frame of this.#frames) {
      offset = out.writeUInt32BE(frame.length, offset);
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }
}

function newStats() {
  return {
    /** records accepted from publish() */
    published: 0,
    /** records received in GOSSIP and SYNC_DELTA packets */
    recordsIn: 0,
    /** of those: stored as new */
    accepted: 0,
    /** of those: old, duplicate or softly refused; not stored, not reported */
    ignored: 0,
    /** of those: malformed or failed `check`; reported */
    invalid: 0,
    /** records sent in GOSSIP and SYNC_DELTA packets */
    recordsOut: 0,
    gossipIn: 0,
    gossipOut: 0,
    /** gossip records dropped because a queue was full or a send failed */
    gossipDropped: 0,
    digestsIn: 0,
    digestsOut: 0,
    requestsIn: 0,
    requestsOut: 0,
    deltasIn: 0,
    deltasOut: 0,
    roundsStarted: 0,
    roundsCompleted: 0,
    /** rounds of ours given up: no reply in time, a failed send, the page budget, a fault */
    roundsAbandoned: 0,
    /** rounds of ours the peer declined */
    roundsDeclined: 0,
    /** rounds started by peers that we served */
    roundsServed: 0,
    /** rounds started by peers that we declined for coming too soon */
    roundsRefused: 0,
    /** digests of a round older than the one we serve for that peer */
    staleDigests: 0,
    /** requests that match no outstanding page of ours */
    staleReplies: 0,
    /** packets for a dataset this node does not run */
    unknownSets: 0,
    /** packets from peers that are not known */
    strayPackets: 0,
    /** stored records that could not be encoded or exceed the record limit */
    unsendable: 0,
    /** send() calls that returned false */
    sendFailures: 0,
    /** protocol violations reported through onError */
    faults: 0,
    /** dataset summaries we sent, and those the peer answered with "same" */
    summariesOut: 0,
    summariesSkipped: 0,
    /** dataset summaries we received, and those equal to ours */
    summariesIn: 0,
    summaryMatches: 0,
    /** received records dropped because allowOrigin refused their origin */
    refusedOrigin: 0,
    /** received records with an unknown key dropped because the peer's budget was spent */
    overBudget: 0,
    /** records a hold-down kept back (a newer one replaces an older), and floods it released */
    heldDown: 0,
    heldReleased: 0,
  };
}

/**
 * Whether an interval of `ms` that started at `at` is over at `now`. A start in the
 * future means the clock stepped back; the interval then counts as over rather than
 * holding records for the size of the step.
 */
function elapsed(now, at, ms) {
  const age = now - at;
  return age < 0 || age >= ms;
}

/** The later of two "covered up to" marks of an inbound round. */
function furthest(dataset, previous, reached) {
  if (previous === undefined) return reached;
  if (previous === END || reached === END) return END;
  return dataset.syncCompare(previous, reached) >= 0 ? previous : reached;
}

function fields(header, required, optional = []) {
  for (const name of required) {
    if (!Object.hasOwn(header, name)) throw new SyncFault('bad-header', 'header lacks a field');
  }
  for (const name of Object.keys(header)) {
    if (!required.includes(name) && !optional.includes(name)) {
      throw new SyncFault('bad-header', 'header has an unknown field');
    }
  }
}

function setName(value) {
  if (typeof value !== 'string' || !SET_NAME_PATTERN.test(value)) {
    throw new SyncFault('bad-header', 'dataset name is malformed');
  }
  return value;
}

function roundId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncFault('bad-header', 'round is not a positive integer');
  }
  return value;
}

function itemCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SyncWire.MAX_ITEMS) {
    throw new SyncFault('bad-header', 'record count is out of range');
  }
  return value;
}

/** Cut a batch body into exactly `count` record frames without parsing them. */
function splitFrames(body, count) {
  const frames = [];
  let offset = 0;
  for (let k = 0; k < count; k += 1) {
    if (body.length - offset < FRAME_PREFIX) {
      throw new SyncFault('bad-body', 'record batch is truncated');
    }
    const length = body.readUInt32BE(offset);
    offset += FRAME_PREFIX;
    // "{}" is the shortest JSON object.
    if (length < 2 || length > SyncWire.MAX_RECORD) {
      throw new SyncFault('bad-body', 'record length is out of range');
    }
    if (length > body.length - offset) {
      throw new SyncFault('bad-body', 'record batch is truncated');
    }
    frames.push(body.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== body.length) throw new SyncFault('bad-body', 'record batch has trailing bytes');
  return frames;
}

function parseRecord(frame) {
  try {
    return parseCanonical(frame);
  } catch (err) {
    if (!(err instanceof CanonicalError)) throw err;
    throw new SyncFault('bad-record', 'record is not canonical JSON');
  }
}

/** Parse a digest or request body: a canonical JSON list of bounded length. */
function parseList(body, reason) {
  let list;
  try {
    list = parseCanonical(body);
  } catch (err) {
    if (!(err instanceof CanonicalError)) throw err;
    throw new SyncFault(reason, 'body is not canonical JSON');
  }
  if (!Array.isArray(list)) throw new SyncFault(reason, 'body is not a list');
  if (list.length > SyncWire.MAX_ITEMS) throw new SyncFault(reason, 'list is too long');
  return list;
}

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Index in 0..count-1 from an injected random source, whatever it returns. */
function pick(rng, count) {
  const value = rng();
  if (!(value >= 0)) return 0;
  return Math.min(count - 1, Math.floor(value * count));
}

function requireInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${label} must be an integer in ${min}..${max}`);
  }
}
