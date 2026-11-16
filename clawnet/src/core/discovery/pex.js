/**
 * Peer exchange (DESIGN.md section 8, item 3, and section 15, items 16 and 22).
 *
 * Every node publishes one signed *peer record*
 *
 * ```
 * { type: "peer", origin, seq, ts, addrs: Address[], caps, card, sig }
 * ```
 *
 * into the ClawSync `peer` dataset (an `LwwDataset` keyed by `origin`, versioned by
 * `seq`), so records spread to every node. The same records are the **card directory**:
 * a node can seal a message to any origin whose record it holds, because the record
 * carries the identity card with its end-to-end key.
 *
 * A node below its target peer count picks records of nodes it is not linked to and
 * dials one of their addresses (`maintain()`), subject to
 *
 *   - the address policy of `address-policy.js` (loopback, unspecified, multicast and
 *     link-local addresses are not dialed unless `discovery.allowLoopback` is set: a
 *     signature proves who announced an address, not that it is theirs), and
 *   - the shared `DialGovernor` (one attempt per IP, failure backoff per IP, a global
 *     rate cap), which is keyed by address and not by NodeId.
 *
 * The module opens no connection. It calls the injected `dial(address, hint)` through the
 * governor, `isKnown(id)` to skip nodes the peer manager is already linked to or backing
 * off from, and `publish(record)` (set by `attach`) to hand records to ClawSync. It has
 * no timers: the owner calls `refresh()` when the node's addresses may have changed and
 * `maintain(want)` from the peer manager's maintenance pass.
 *
 * **Our own record.** `seq = max(highest seq known + 1, now())`, so it rises with the
 * wall clock and a restart never goes backwards. The highest seq is kept in `state`
 * (`state.json`, key `peerSeq`). `refresh()` publishes only when the announced addresses
 * or capabilities changed, or nothing was published in this process yet. If a record of
 * our own origin arrives from the network with a seq at or above ours (we restarted and
 * lost track, or another node uses our key) we jump past it and publish again (the
 * self-originated rule of RFC 2328, section 13.4); doing that three times within ten
 * minutes is reported as `discovery.clone_suspected`.
 *
 * **Check functions** (see ARCHITECTURE.md 4.5). Hard failures, which make ClawSync blame
 * the relaying peer: a record that fails its schema, its signature, or whose card is not
 * valid. Soft failures: `ts` ahead of this node's clock by more than `maxClockSkewMs`
 * (`future`) and an origin refused by `allowOrigin` (`origin-refused`). The cheap soft
 * tests run before the signature is verified.
 */

import { performance } from 'node:perf_hooks';

import { verifyCard, verifyRecord } from '../crypto/identity.js';
import { ConfigError, StateError } from '../errors.js';
import { canonicalBytes } from '../wire/canonical.js';
import { validateAddress, validateCaps, validatePeerRecord } from '../wire/schema.js';
import { Limits, RecordType } from '../wire/types.js';
import { LwwDataset } from '../../sync/datasets.js';
import { checkLearnedAddress } from './address-policy.js';
import { BoundedSet } from './rate-limit.js';

/** Name of the dataset on the wire. */
export const PEER_DATASET = 'peer';

/** Most records scanned for candidates in one `maintain()` call. */
export const MAX_SCAN = 2048;

/** Window and threshold of the clone suspicion (see the module description). */
const CLONE_WINDOW_MS = 10 * 60_000;
const CLONE_THRESHOLD = 3;

/** Candidates remembered so that a record seen many times is announced once. */
const SEEN_CANDIDATES = 4096;

export class PeerExchange {
  #identity;
  #caps;
  #ownAddresses;
  #isKnown;
  #dial;
  #governor;
  #pex;
  #allowLoopback;
  #allowOrigin;
  #maxOrigins;
  #maxClockSkewMs;
  #doc;
  #state;
  #events;
  #now;
  #monoNow;
  #rng;
  #log;
  #dataset;
  #publish = null;
  /** The record this process last published, and the content (addrs, caps) it announced. */
  #published = null;
  #announced = null;
  /** Highest seq of our own origin that is known to exist. */
  #seq = 0;
  /** A foreign record of our origin made us jump: publish again on the next refresh. */
  #bumped = false;
  #bumpTimes = [];
  #cloneReportedAt = -Infinity;
  /** id -> card noted from a handshake or a beacon; insertion order is recency. */
  #cards = new Map();
  #seen = new BoundedSet(SEEN_CANDIDATES);
  #loading = false;
  #saveQueued = false;
  #stats = {
    published: 0,
    publishRefused: 0,
    accepted: 0,
    selfBumps: 0,
    equivocations: 0,
    maintains: 0,
    candidatesConsidered: 0,
    refusedAddresses: 0,
    dialsStarted: 0,
    dialsDenied: 0,
    dialsOk: 0,
    dialsFailed: 0,
    loaded: 0,
    loadRejected: 0,
    cardsRejected: 0,
    saves: 0,
  };

  /**
   * @param {object} options
   * @param {import('../crypto/identity.js').Identity} options.identity this node
   * @param {{ relay: boolean, mailbox: boolean, transit: boolean }} options.caps what the
   *   node advertises (`config.caps`)
   * @param {() => string[]} options.ownAddresses the addresses to announce (ARCHITECTURE.md
   *   4.6); invalid and surplus entries are dropped
   * @param {(id: string) => boolean} options.isKnown whether the peer manager is linked
   *   to, dialing or backing off from that node; an exception counts as true
   * @param {(address: string, hint: object) => unknown} options.dial the peer manager's
   *   dial function (see `dial-governor.js`)
   * @param {import('./dial-governor.js').DialGovernor} options.governor shared dial budget
   * @param {number} options.maxClockSkewMs `limits.maxClockSkewMs`
   * @param {boolean} [options.pex=true] `discovery.pex`; false keeps the records and the
   *   card directory but stops `maintain()` from dialing
   * @param {boolean} [options.allowLoopback=false] `discovery.allowLoopback`
   * @param {(origin: string) => boolean} [options.allowOrigin] blocklist and allowlist
   *   for record origins; an origin for which it is not `true` is neither stored nor dialed
   * @param {number} [options.maxOrigins=10000] `limits.maxOrigins`; also bounds the card
   *   directory
   * @param {{ data: any, update: (mutator: (data: any) => void) => void,
   *   flush: () => Promise<void> }} [options.doc] a loaded `peer-records.json` document
   *   holding `{ v: 1, records: [] }`; without it records are not persisted
   * @param {{ data: any, update: (mutator: (data: any) => void) => void,
   *   flush: () => Promise<void> }} [options.state] the loaded `state.json` document
   *   whose `peerSeq` this module keeps; without it the seq is derived from the clock
   * @param {{ emit: (type: string, data?: unknown) => unknown }} [options.events]
   * @param {() => number} [options.now] wall clock, milliseconds; default `Date.now`
   * @param {() => number} [options.monoNow] monotonic clock; default `performance.now`
   * @param {() => number} [options.rng] uniform in [0, 1); default `Math.random`
   * @param {object} [options.log]
   * @throws {ConfigError} if an option is missing or invalid
   */
  constructor({
    identity,
    caps,
    ownAddresses,
    isKnown,
    dial,
    governor,
    maxClockSkewMs,
    pex = true,
    allowLoopback = false,
    allowOrigin,
    maxOrigins = 10_000,
    doc,
    state,
    events,
    now = Date.now,
    monoNow = () => performance.now(),
    rng = Math.random,
    log,
  } = {}) {
    if (identity === null || typeof identity !== 'object' || typeof identity.signRecord !== 'function') {
      throw new ConfigError('pex: identity is required');
    }
    if (!validateCaps(caps).ok) throw new ConfigError('pex: caps must be { relay, mailbox, transit } booleans');
    for (const [label, fn] of [['ownAddresses', ownAddresses], ['isKnown', isKnown], ['dial', dial], ['now', now], ['monoNow', monoNow], ['rng', rng]]) {
      if (typeof fn !== 'function') throw new ConfigError(`pex: ${label} must be a function`);
    }
    if (allowOrigin !== undefined && typeof allowOrigin !== 'function') {
      throw new ConfigError('pex: allowOrigin must be a function when given');
    }
    if (governor === null || typeof governor !== 'object' || typeof governor.attempt !== 'function') {
      throw new ConfigError('pex: governor is required');
    }
    if (!Number.isInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
      throw new ConfigError('pex: maxClockSkewMs must be a non-negative integer');
    }
    if (!Number.isInteger(maxOrigins) || maxOrigins < 2) {
      throw new ConfigError('pex: maxOrigins must be at least 2');
    }
    this.#identity = identity;
    this.#caps = Object.freeze({ relay: caps.relay, mailbox: caps.mailbox, transit: caps.transit });
    this.#ownAddresses = ownAddresses;
    this.#isKnown = isKnown;
    this.#dial = dial;
    this.#governor = governor;
    this.#pex = pex === true;
    this.#allowLoopback = allowLoopback === true;
    this.#allowOrigin = allowOrigin;
    this.#maxOrigins = maxOrigins;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#doc = doc ?? null;
    this.#state = state ?? null;
    this.#events = events;
    this.#now = now;
    this.#monoNow = monoNow;
    this.#rng = rng;
    this.#log = log;
    const saved = this.#state?.data?.peerSeq;
    this.#seq = Number.isSafeInteger(saved) && saved > 0 ? saved : 0;

    this.#dataset = new LwwDataset({
      name: PEER_DATASET,
      key: record => record.origin,
      version: record => record.seq,
      check: record => this.#check(record),
      maxEntries: maxOrigins,
      onAccept: (record, info) => this.#onAccept(record, info),
      onEquivocation: event => this.#onEquivocation(event),
    });
    // Eviction must never remove the record this node originates.
    this.#dataset.pin(identity.nodeId);
  }

  /** @returns {LwwDataset} the `peer` dataset, to be given to the SyncEngine */
  get dataset() {
    return this.#dataset;
  }

  /**
   * Re-offer the persisted records. Each one goes through `check` again, signature
   * included: the file is not trusted. Call once, before the node starts syncing.
   *
   * @returns {Promise<number>} records accepted
   */
  async load() {
    const records = this.#doc?.data?.records;
    if (!Array.isArray(records)) return 0;
    this.#loading = true;
    try {
      for (const record of records.slice(0, this.#maxOrigins)) {
        let result;
        try {
          result = this.#dataset.offer(record);
        } catch (err) {
          this.#log?.warn?.('persisted peer record could not be loaded', { error: String(err?.message).slice(0, 200) });
          result = { accepted: false };
        }
        if (result.accepted) this.#stats.loaded += 1;
        else this.#stats.loadRejected += 1;
      }
    } finally {
      this.#loading = false;
    }
    return this.#stats.loaded;
  }

  /**
   * Connect the module to ClawSync.
   *
   * @param {(record: object) => { accepted: boolean, reason?: string }} publish usually
   *   `record => sync.publish('peer', record)`
   * @throws {StateError} if already attached
   * @throws {ConfigError} if `publish` is not a function
   */
  attach(publish) {
    if (typeof publish !== 'function') throw new ConfigError('pex: publish must be a function');
    if (this.#publish !== null) throw new StateError('already-attached: peer exchange has a publisher');
    this.#publish = publish;
  }

  /**
   * Publish our record if what it announces changed, or if nothing was published in this
   * process yet. Call after `attach`, at start and whenever `ownAddresses()` may have
   * changed (the peer manager's `onObserved`).
   *
   * @returns {boolean} whether a new record was published
   */
  refresh() {
    if (this.#publish === null) return false;
    const addrs = this.#announcedAddresses();
    const content = canonicalBytes({ addrs, caps: this.#caps }).toString('utf8');
    if (this.#published !== null && content === this.#announced && !this.#bumped) return false;

    const ts = this.#now();
    const seq = Math.max(this.#seq + 1, ts);
    const record = this.#identity.signRecord(RecordType.PEER, {
      seq,
      ts,
      addrs,
      caps: this.#caps,
      card: this.#identity.card,
    });
    // Remember the number before the record leaves, so a failure below can never make
    // this node reuse it.
    this.#raiseSeq(seq);
    // Set before publishing: the dataset calls back into #onAccept for this very record,
    // which must recognise it as ours and not as someone else's copy of our origin.
    const previous = this.#published;
    this.#published = record;
    const result = this.#publish(record);
    if (!result.accepted) {
      this.#published = previous;
      this.#stats.publishRefused += 1;
      this.#log?.warn?.('own peer record was not accepted', { reason: result.reason });
      return false;
    }
    this.#announced = content;
    this.#bumped = false;
    this.#stats.published += 1;
    return true;
  }

  /**
   * Remember a card that has been verified in a link handshake or a beacon, so that
   * messages can be sealed to its owner. The card is verified again here; one that does
   * not verify is ignored.
   *
   * @param {object} card
   * @returns {boolean} whether the card was stored
   */
  noteCard(card) {
    const verdict = verifyCard(card);
    if (!verdict.ok || verdict.nodeId === this.#identity.nodeId) {
      this.#stats.cardsRejected += 1;
      return false;
    }
    this.#cards.delete(verdict.nodeId);
    this.#cards.set(verdict.nodeId, Object.freeze({ id: card.id, link: card.link, e2e: card.e2e, sig: card.sig }));
    if (this.#cards.size > this.#maxOrigins) {
      this.#cards.delete(this.#cards.keys().next().value);
    }
    return true;
  }

  /**
   * @param {string} id a NodeId
   * @returns {object | null} the card noted from a handshake or beacon, else the card in
   *   the node's peer record, else null
   */
  cardOf(id) {
    return this.#cards.get(id) ?? this.#dataset.get(id)?.card ?? null;
  }

  /**
   * @param {string} id a NodeId
   * @returns {object | null} the peer record held for that node
   */
  recordOf(id) {
    return this.#dataset.get(id) ?? null;
  }

  /**
   * Dial up to `want` nodes chosen from the peer records. Nodes the peer manager already
   * knows, our own origin, refused origins and addresses the policy or the governor does
   * not allow are skipped. Nodes that advertise the relay capability come first.
   *
   * @param {number} want how many more peers the node would like (target minus links and
   *   dials in flight)
   * @returns {number} dials started
   */
  maintain(want) {
    this.#stats.maintains += 1;
    if (!this.#pex || !(want > 0)) return 0;
    const candidates = this.#pick(Math.min(want, 64));
    let started = 0;
    for (const candidate of candidates) {
      if (started >= want) break;
      if (this.#seen.add(`${candidate.addr} ${candidate.id}`)) {
        this.#events?.emit('discovery.candidate', { addr: candidate.addr, peer: candidate.id, source: 'pex' });
      }
      const result = this.#governor.attempt(candidate.addr, { id: candidate.id, source: 'pex' }, this.#dial);
      if (!result.started) {
        this.#stats.dialsDenied += 1;
        if (result.reason === 'rate') break;
        continue;
      }
      started += 1;
      this.#stats.dialsStarted += 1;
      result.done.then(outcome => {
        this.#stats[outcome.ok ? 'dialsOk' : 'dialsFailed'] += 1;
      });
    }
    return started;
  }

  /**
   * Wait until the records and the sequence number are on disk.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.#saveQueued) this.#save();
    await Promise.all([this.#doc?.flush(), this.#state?.flush()]);
  }

  /** @returns {object} counters and gauges, all non-negative integers */
  stats() {
    return {
      ...this.#stats,
      records: this.#dataset.size,
      cards: this.#cards.size,
      seq: this.#seq,
    };
  }

  /**
   * Choose dial candidates: scan a bounded, randomly placed stretch of the records and
   * keep one usable address per eligible node.
   */
  #pick(limit) {
    const records = this.#dataset.values();
    const count = records.length;
    if (count === 0) return [];
    const scan = Math.min(count, MAX_SCAN);
    const offset = Math.floor(this.#rng() * count) % count;
    const eligible = [];
    for (let k = 0; k < scan; k += 1) {
      const record = records[(offset + k) % count];
      const candidate = this.#candidateOf(record);
      if (candidate !== null) eligible.push(candidate);
    }
    // Relays first; the random starting point keeps the order within each class fair.
    eligible.sort((a, b) => Number(b.relay) - Number(a.relay));
    return eligible.slice(0, limit);
  }

  #candidateOf(record) {
    const id = record.origin;
    if (id === this.#identity.nodeId) return null;
    this.#stats.candidatesConsidered += 1;
    if (this.#allowOrigin !== undefined && !this.#originAllowed(id)) return null;
    if (this.#knows(id)) return null;
    for (const addr of record.addrs) {
      if (!checkLearnedAddress(addr, { allowLoopback: this.#allowLoopback }).ok) {
        this.#stats.refusedAddresses += 1;
        continue;
      }
      if (this.#governor.check(addr) !== null) continue;
      return { id, addr, relay: record.caps.relay === true };
    }
    return null;
  }

  #originAllowed(origin) {
    try {
      return this.#allowOrigin(origin) === true;
    } catch {
      return false;
    }
  }

  #knows(id) {
    try {
      return this.#isKnown(id) === true;
    } catch (err) {
      this.#log?.warn?.('isKnown threw', { error: String(err?.message).slice(0, 200) });
      return true;
    }
  }

  /** The addresses we announce: valid, distinct, at most MAX_PEER_ADDRS. */
  #announcedAddresses() {
    let list;
    try {
      list = this.#ownAddresses();
    } catch (err) {
      this.#log?.warn?.('ownAddresses threw', { error: String(err?.message).slice(0, 200) });
      list = [];
    }
    const out = [];
    if (Array.isArray(list)) {
      for (const addr of list) {
        if (out.length >= Limits.MAX_PEER_ADDRS) break;
        if (validateAddress(addr).ok && !out.includes(addr)) out.push(addr);
      }
    }
    return out;
  }

  /** `check` of the dataset; see the module description for hard and soft failures. */
  #check(record) {
    if (!validatePeerRecord(record).ok) return { ok: false, reason: 'bad-shape' };
    if (record.ts > this.#now() + this.#maxClockSkewMs) return { ok: false, reason: 'future', soft: true };
    if (
      this.#allowOrigin !== undefined &&
      record.origin !== this.#identity.nodeId &&
      !this.#originAllowed(record.origin)
    ) {
      return { ok: false, reason: 'origin-refused', soft: true };
    }
    if (!verifyRecord(record, RecordType.PEER).ok) return { ok: false, reason: 'bad-signature' };
    if (!verifyCard(record.card).ok) return { ok: false, reason: 'bad-card' };
    return { ok: true };
  }

  #onAccept(record) {
    if (record.origin === this.#identity.nodeId) {
      this.#onOwnOrigin(record);
      return;
    }
    this.#stats.accepted += 1;
    if (this.#loading) return;
    this.#scheduleSave();
    this.#events?.emit('peer.record', {
      peer: record.origin,
      seq: record.seq,
      addrs: [...record.addrs],
      caps: { ...record.caps },
    });
  }

  /** A record of our own origin entered the dataset. Ours is expected; another is not. */
  #onOwnOrigin(record) {
    if (this.#published !== null && record.sig === this.#published.sig) return;
    this.#raiseSeq(record.seq);
    this.#bumped = true;
    if (this.#loading) return;
    this.#stats.selfBumps += 1;
    const now = this.#monoNow();
    this.#bumpTimes = this.#bumpTimes.filter(at => now - at < CLONE_WINDOW_MS);
    this.#bumpTimes.push(now);
    if (this.#bumpTimes.length >= CLONE_THRESHOLD && now - this.#cloneReportedAt >= CLONE_WINDOW_MS) {
      this.#cloneReportedAt = now;
      this.#log?.warn?.('another node uses our identity', { bumps: this.#bumpTimes.length });
      this.#events?.emit('discovery.clone_suspected', {
        peer: this.#identity.nodeId,
        seq: record.seq,
        bumps: this.#bumpTimes.length,
      });
    }
    // Not inside the dataset's own call: publishing from here would re-enter it.
    queueMicrotask(() => {
      try {
        this.refresh();
      } catch (err) {
        this.#log?.error?.('republishing the peer record failed', { error: String(err?.message).slice(0, 200) });
      }
    });
  }

  #onEquivocation({ key, version }) {
    this.#stats.equivocations += 1;
    this.#events?.emit('peer.equivocation', { peer: key, seq: version });
  }

  #raiseSeq(seq) {
    if (seq <= this.#seq) return;
    this.#seq = seq;
    this.#state?.update(data => {
      data.peerSeq = seq;
    });
  }

  /** Coalesce saves: many records accepted in one tick cost one rewrite. */
  #scheduleSave() {
    if (this.#doc === null || this.#saveQueued) return;
    this.#saveQueued = true;
    queueMicrotask(() => {
      if (this.#saveQueued) this.#save();
    });
  }

  #save() {
    this.#saveQueued = false;
    const own = this.#identity.nodeId;
    const records = this.#dataset.values().filter(record => record.origin !== own);
    this.#doc.update(data => {
      data.v = 1;
      data.records = records;
    });
    this.#stats.saves += 1;
  }
}
