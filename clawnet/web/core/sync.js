/**
 * ClawSync for the web core: a port of the engine's SyncEngine (`src/sync/antientropy.js`)
 * that speaks the same four packets (GOSSIP, SYNC_DIGEST, SYNC_REQUEST, SYNC_DELTA) with
 * the same rules, in both roles:
 *
 *   - as the responder of a round a peer starts: answer a summary with "same" or "go on",
 *     a digest page with the records the peer lacks (SYNC_DELTA) and a request for what we
 *     lack (SYNC_REQUEST); decline datasets we do not run (`stop: "set"`) and rounds that
 *     come too fast (`stop: "round"`);
 *   - as the initiator: on link-up (when our id is the smaller, as in the engine) and every
 *     sync interval, walk each dataset's summary and pages and serve what the peer asks.
 *
 * Records received are offered to the dataset, which verifies them before storing. What
 * the port leaves out: the flood hold-down (a phone has one neighbour and never floods a
 * record back to it) and anything about log datasets (the phone runs `lsa` and `peer`).
 * Gossip carries only the records this node publishes itself.
 */

import { CanonicalError } from '../../src/core/errors.js';
import { Limits, PacketType } from '../../src/core/wire/types.js';
import { readU32 } from './bytes.js';
import { canonicalBytes, PACKET_PREFIX_BYTES, parseCanonical } from './codec.js';
import { MAX_RECORD, RECORD_OVERHEAD, SET_NAME_PATTERN, SyncFault } from './lww.js';

export const SyncWire = Object.freeze({
  MAX_ITEMS: 1024,
  MAX_RECORD,
  MAX_BODY: Limits.MAX_PACKET - 4 - Limits.MAX_HEADER,
  MAX_PACKET: Limits.MAX_SYNC_PACKET,
});

const LIST_HEADER_ALLOWANCE = 1024;
const FRAME_PREFIX = 4;
const MIN_PAGE = 8;
const END = Symbol('end');
const SUMMARY = Symbol('summary');
const SUMMARY_PATTERN = /^[0-9a-f]{64}$/;
const BUDGET_PERIOD_MS = 60_000;

export class SyncEngine {
  #order;
  #sets = new Map();
  #send;
  #now;
  #rng;
  #maxRecordsPerPacket = 256;
  #maxBytesPerPacket = Limits.MAX_SYNC_PACKET;
  #maxPendingPerPeer = 4096;
  #maxRecord;
  #batchBytes;
  #listBytes;
  #gossipBatchMs;
  #schedule;
  #onError;
  #self;
  #roundTimeoutMs;
  #minRoundIntervalMs;
  #maxRoundSteps;
  #newKeysPerMinute;
  #allowOrigin;
  #peers = new Map();
  #roundSeq = 0;
  #cancelFlush = null;
  stats = {
    published: 0, recordsIn: 0, accepted: 0, ignored: 0, invalid: 0, recordsOut: 0, gossipIn: 0, gossipOut: 0,
    digestsIn: 0, digestsOut: 0, requestsIn: 0, requestsOut: 0, deltasIn: 0, deltasOut: 0, roundsStarted: 0,
    roundsCompleted: 0, roundsAbandoned: 0, roundsDeclined: 0, roundsServed: 0, roundsRefused: 0, unknownSets: 0,
    faults: 0, summariesSkipped: 0, summaryMatches: 0, sendFailures: 0,
  };

  /**
   * @param {object} options as the engine's SyncEngine: datasets, send, monoNow, rng,
   *   gossipBatchMs, schedule, onError, self, roundTimeoutMs, minRoundIntervalMs,
   *   maxRoundSteps, newKeysPerMinute, allowOrigin
   */
  constructor({
    datasets,
    send,
    monoNow,
    rng = Math.random,
    gossipBatchMs = 25,
    schedule,
    onError,
    self,
    roundTimeoutMs = 10_000,
    minRoundIntervalMs = 1_000,
    maxRoundSteps = 4_096,
    newKeysPerMinute = 10_000,
    allowOrigin,
  } = {}) {
    if (!Array.isArray(datasets) || datasets.length === 0) throw new TypeError('datasets must be a non-empty array');
    for (const dataset of datasets) this.#sets.set(dataset.name, dataset);
    this.#order = datasets.slice();
    this.#send = send;
    this.#now = monoNow;
    this.#rng = rng;
    this.#gossipBatchMs = gossipBatchMs;
    this.#schedule = schedule;
    this.#onError = onError;
    this.#self = self;
    this.#roundTimeoutMs = roundTimeoutMs;
    this.#minRoundIntervalMs = minRoundIntervalMs;
    this.#maxRoundSteps = maxRoundSteps;
    this.#newKeysPerMinute = newKeysPerMinute;
    this.#allowOrigin = allowOrigin;
    this.#maxRecord = this.#maxBytesPerPacket - RECORD_OVERHEAD;
    this.#batchBytes = this.#maxRecord + FRAME_PREFIX;
    this.#listBytes = this.#maxBytesPerPacket - PACKET_PREFIX_BYTES - LIST_HEADER_ALLOWANCE;
  }

  /** A link is up; start a round unless the peer's id is the smaller one. */
  addPeer(peerId) {
    if (this.#peers.has(peerId)) return false;
    const peer = { id: peerId, pending: new Map(), pendingCount: 0, out: null, inbound: null, budget: { tokens: this.#newKeysPerMinute, at: this.#now() } };
    this.#peers.set(peerId, peer);
    if (this.#self === undefined || this.#self < peerId) this.#startRound(peer);
    return true;
  }

  removePeer(peerId) {
    return this.#peers.delete(peerId);
  }

  /** Store a record of our own and gossip it to every peer. */
  publish(datasetName, record) {
    const dataset = this.#sets.get(datasetName);
    if (dataset === undefined) throw new TypeError('publish: unknown dataset');
    let bytes;
    try {
      bytes = canonicalBytes(record);
    } catch (err) {
      if (!(err instanceof CanonicalError)) throw err;
      return { accepted: false, reason: 'unencodable' };
    }
    if (bytes.length > this.#maxRecord) return { accepted: false, reason: 'too-large' };
    const result = dataset.offer(record);
    if (!result.accepted) return { accepted: false, reason: result.reason };
    this.stats.published += 1;
    this.#queueGossip(dataset, record, null);
    return { accepted: true };
  }

  /** Queue a record we hold for the next gossip to every peer (after a link-up). */
  push(datasetName, record) {
    const dataset = this.#sets.get(datasetName);
    if (dataset !== undefined) this.#queueGossip(dataset, record, null);
  }

  /** A GOSSIP, SYNC_DIGEST, SYNC_REQUEST or SYNC_DELTA from a peer; faults go to onError. */
  handlePacket(peerId, packet) {
    const handler = this.#handlerFor(packet.type);
    const peer = this.#peers.get(peerId);
    if (peer === undefined) return;
    try {
      const { header, body } = packet;
      if (!isPlainObject(header)) throw new SyncFault('bad-header', 'header is not an object');
      if (!(body instanceof Uint8Array) || body.length === 0) throw new SyncFault('bad-body', 'sync packets always carry a body');
      if (body.length > SyncWire.MAX_BODY) throw new SyncFault('bad-body', 'body is too large');
      handler.call(this, peer, header, body, packet.type);
    } catch (err) {
      if (!(err instanceof SyncFault)) throw err;
      this.stats.faults += 1;
      if (peer.out !== null) this.#abandon(peer);
      this.#onError?.(peer.id, err.reason, err.message);
    }
  }

  /** The periodic round; abandons rounds with no reply for roundTimeoutMs first. */
  tick() {
    const now = this.#now();
    const idle = [];
    for (const peer of this.#peers.values()) {
      if (peer.out !== null) {
        const quiet = now - peer.out.activeAt;
        if (quiet < 0 || quiet >= this.#roundTimeoutMs) this.#abandon(peer);
      }
      if (peer.out === null) idle.push(peer);
    }
    if (idle.length === 0) return null;
    const value = this.#rng();
    const peer = idle[value >= 0 ? Math.min(idle.length - 1, Math.floor(value * idle.length)) : 0];
    this.#startRound(peer);
    return peer.id;
  }

  flush() {
    this.#disarm();
    for (const peer of this.#peers.values()) if (peer.pendingCount > 0) this.#flushPeer(peer);
  }

  close() {
    this.#disarm();
    this.#peers.clear();
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
        throw new TypeError('handlePacket: not a sync packet type');
    }
  }

  #onRecords(peer, header, body, type) {
    fields(header, ['n', 'set']);
    const name = setName(header.set);
    const count = itemCount(header.n);
    const frames = splitFrames(body, count);
    if (type === PacketType.GOSSIP) this.stats.gossipIn += 1;
    else this.stats.deltasIn += 1;
    this.stats.recordsIn += count;
    const dataset = this.#sets.get(name);
    if (dataset === undefined) {
      this.stats.unknownSets += 1;
      return;
    }
    for (const frame of frames) {
      if (frame.length > this.#maxRecord) continue;
      const record = parseRecord(frame);
      if (!this.#originAllowed(record)) continue;
      if (!dataset.syncKnows(record) && !this.#spendBudget(peer)) continue;
      const result = dataset.offer(record, peer.id);
      if (result.accepted) {
        this.stats.accepted += 1;
        // A phone forwards nothing it receives: its one neighbour is where it came from.
        this.#queueGossip(dataset, record, peer.id);
      } else if (result.invalid) {
        this.stats.invalid += 1;
        throw new SyncFault('invalid-record', `${name}: ${result.reason}`);
      } else {
        this.stats.ignored += 1;
      }
    }
  }

  #onDigest(peer, header, body) {
    const summary = isPlainObject(header) && Object.hasOwn(header, 'sum');
    if (summary) fields(header, ['round', 'set', 'sum']);
    else fields(header, ['after', 'round', 'set', 'upto'], ['hint']);
    const name = setName(header.set);
    const round = roundId(header.round);
    if (summary && (typeof header.sum !== 'string' || !SUMMARY_PATTERN.test(header.sum))) {
      throw new SyncFault('bad-header', 'sum is not a SHA-256 in hex');
    }
    if (header.hint !== undefined && !isPlainObject(header.hint)) throw new SyncFault('bad-hint', 'hint is not an object');
    const entries = parseList(body, 'bad-digest');
    if (summary && entries.length > 0) throw new SyncFault('bad-digest', 'a summary carries an empty list');
    this.stats.digestsIn += 1;

    const now = this.#now();
    let inbound = peer.inbound;
    if (inbound !== null && round < inbound.round) return;
    if (inbound === null || round > inbound.round) {
      if (inbound !== null) {
        const elapsed = now - inbound.startedAt;
        if (elapsed >= 0 && elapsed < this.#minRoundIntervalMs) {
          this.stats.roundsRefused += 1;
          this.#decline(peer, name, round, 'round');
          return;
        }
      }
      inbound = { round, startedAt: now, pushed: new Map() };
      peer.inbound = inbound;
      this.stats.roundsServed += 1;
    }
    const dataset = this.#sets.get(name);
    if (dataset === undefined) {
      this.stats.unknownSets += 1;
      this.#decline(peer, name, round, 'set');
      return;
    }
    if (summary) {
      const same = dataset.syncSummary() === header.sum;
      if (same) this.stats.summaryMatches += 1;
      if (this.#transmit(peer, {
        type: PacketType.SYNC_REQUEST,
        header: same ? { next: null, round, set: name, stop: 'same' } : { next: null, round, set: name },
        body: canonicalBytes([]),
      })) this.stats.requestsOut += 1;
      return;
    }
    const after = header.after === null ? null : dataset.syncCursor(header.after);
    const upto = header.upto === null ? null : dataset.syncCursor(header.upto);
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
        if (wants.length >= this.#maxRecordsPerPacket || wantBytes + size > this.#listBytes) {
          complete = false;
          break;
        }
        wants.push(step.want);
        wantBytes += size;
      }
      next = step.cursor;
    }
    if (complete) next = null;
    if (batch.count > 0 && !this.#sendRecords(peer, PacketType.SYNC_DELTA, dataset, batch)) return;
    inbound.pushed.set(name, furthest(dataset, pushed, next ?? upto ?? END));
    if (this.#transmit(peer, { type: PacketType.SYNC_REQUEST, header: { next, round, set: name }, body: canonicalBytes(wants) })) {
      this.stats.requestsOut += 1;
    }
  }

  #onRequest(peer, header, body) {
    fields(header, ['next', 'round', 'set'], ['stop']);
    const name = setName(header.set);
    const round = roundId(header.round);
    const wants = parseList(body, 'bad-request');
    this.stats.requestsIn += 1;
    const lane = peer.out;
    if (lane === null || lane.round !== round || lane.page === null || this.#order[lane.set].name !== name) return;
    const dataset = this.#order[lane.set];
    const page = lane.page;
    if (header.stop !== undefined && (header.next !== null || wants.length > 0)) {
      throw new SyncFault('bad-header', 'a stop carries no continuation and no request');
    }
    if (header.stop === 'round') {
      peer.out = null;
      this.stats.roundsDeclined += 1;
      return;
    }
    if (page === SUMMARY) {
      if (header.stop === undefined && (header.next !== null || wants.length > 0)) {
        throw new SyncFault('bad-header', 'the answer to a summary carries no request');
      }
      if (header.stop !== undefined && header.stop !== 'same' && header.stop !== 'set') {
        throw new SyncFault('bad-header', 'unknown stop scope');
      }
      if (header.stop === 'same') this.stats.summariesSkipped += 1;
      lane.after = header.stop === undefined ? null : END;
      lane.page = null;
      lane.activeAt = this.#now();
      this.#advance(peer);
      return;
    }
    const batch = this.#batch();
    let resume;
    if (header.stop !== undefined) {
      if (header.stop !== 'set') throw new SyncFault('bad-header', 'unknown stop scope');
      resume = END;
    } else {
      const next = header.next === null ? null : dataset.syncCursor(header.next);
      if (next !== null) {
        if (page.after !== null && dataset.syncCompare(next, page.after) <= 0) throw new SyncFault('bad-cursor', 'continuation does not advance');
        if (page.upto !== null && dataset.syncCompare(next, page.upto) > 0) throw new SyncFault('bad-cursor', 'continuation is beyond the page');
      }
      resume = next ?? page.upto ?? END;
      let served = null;
      for (const step of dataset.syncServe(wants, page, next)) {
        const bytes = this.#encode(step.record);
        if (bytes !== null && !batch.add(bytes)) {
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
    const largest = this.#maxRecordsPerPacket;
    const consumed = resume === END ? page.entries.length : dataset.syncConsumed(page, resume);
    lane.pageSize = consumed >= page.entries.length ? Math.min(largest, lane.pageSize * 2) : Math.min(largest, Math.max(MIN_PAGE, consumed * 2));
    lane.after = resume;
    lane.page = null;
    lane.activeAt = this.#now();
    this.#advance(peer);
  }

  #startRound(peer) {
    this.#roundSeq += 1;
    peer.out = { round: this.#roundSeq, set: 0, summed: false, after: null, page: null, pageSize: this.#maxRecordsPerPacket, steps: 0, activeAt: this.#now() };
    this.stats.roundsStarted += 1;
    this.#advance(peer);
  }

  #abandon(peer) {
    peer.out = null;
    this.stats.roundsAbandoned += 1;
  }

  #decline(peer, name, round, scope) {
    this.#transmit(peer, { type: PacketType.SYNC_REQUEST, header: { next: null, round, set: name, stop: scope }, body: canonicalBytes([]) });
  }

  #advance(peer) {
    const lane = peer.out;
    if (lane.after === END) {
      lane.set += 1;
      lane.summed = false;
      lane.after = null;
      lane.pageSize = this.#maxRecordsPerPacket;
    }
    if (lane.set >= this.#order.length) {
      peer.out = null;
      this.stats.roundsCompleted += 1;
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
      this.stats.digestsOut += 1;
      lane.page = SUMMARY;
      return;
    }
    const page = dataset.syncPage(lane.after, { maxEntries: lane.pageSize, maxBytes: this.#listBytes });
    const header = { after: page.after, round: lane.round, set: dataset.name, upto: page.upto };
    if (Object.keys(page.hint).length > 0) header.hint = page.hint;
    if (!this.#transmit(peer, { type: PacketType.SYNC_DIGEST, header, body: canonicalBytes(page.entries) })) {
      this.#abandon(peer);
      return;
    }
    this.stats.digestsOut += 1;
    lane.page = page;
  }

  #originAllowed(record) {
    if (this.#allowOrigin === undefined || !isPlainObject(record) || typeof record.origin !== 'string') return true;
    try {
      return this.#allowOrigin(record.origin) === true;
    } catch {
      return false;
    }
  }

  #spendBudget(peer) {
    const budget = peer.budget;
    const now = this.#now();
    const since = now - budget.at;
    if (since > 0) budget.tokens = Math.min(this.#newKeysPerMinute, budget.tokens + (since * this.#newKeysPerMinute) / BUDGET_PERIOD_MS);
    budget.at = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  #queueGossip(dataset, record, exceptPeerId) {
    let queued = false;
    for (const peer of this.#peers.values()) {
      if (peer.id === exceptPeerId || peer.pendingCount >= this.#maxPendingPerPeer) continue;
      const list = peer.pending.get(dataset);
      if (list === undefined) peer.pending.set(dataset, [record]);
      else list.push(record);
      peer.pendingCount += 1;
      queued = true;
    }
    if (queued && this.#schedule !== undefined && this.#cancelFlush === null) {
      this.#cancelFlush = this.#schedule(() => {
        this.#cancelFlush = null;
        this.flush();
      }, this.#gossipBatchMs);
    }
  }

  #disarm() {
    if (this.#cancelFlush === null) return;
    const cancel = this.#cancelFlush;
    this.#cancelFlush = null;
    if (typeof cancel === 'function') cancel();
  }

  #flushPeer(peer) {
    const pending = peer.pending;
    peer.pending = new Map();
    peer.pendingCount = 0;
    for (const [dataset, records] of pending) {
      let batch = this.#batch();
      for (const record of records) {
        const bytes = this.#encode(record);
        if (bytes === null) continue;
        if (batch.add(bytes)) continue;
        if (!this.#sendRecords(peer, PacketType.GOSSIP, dataset, batch)) return;
        batch = this.#batch();
        batch.add(bytes);
      }
      if (batch.count > 0 && !this.#sendRecords(peer, PacketType.GOSSIP, dataset, batch)) return;
    }
  }

  #sendRecords(peer, type, dataset, batch) {
    const sent = this.#transmit(peer, { type, header: { n: batch.count, set: dataset.name }, body: batch.body() });
    if (sent) {
      if (type === PacketType.GOSSIP) this.stats.gossipOut += 1;
      else this.stats.deltasOut += 1;
      this.stats.recordsOut += batch.count;
    }
    return sent;
  }

  #transmit(peer, packet) {
    const size = PACKET_PREFIX_BYTES + canonicalBytes(packet.header).length + packet.body.length;
    if (size > this.#maxBytesPerPacket) return false;
    const sent = this.#send(peer.id, packet) === true;
    if (!sent) this.stats.sendFailures += 1;
    return sent;
  }

  #batch() {
    return new Batch(this.#maxRecordsPerPacket, this.#batchBytes);
  }

  #encode(record) {
    let bytes;
    try {
      bytes = canonicalBytes(record);
    } catch {
      return null;
    }
    return bytes.length > this.#maxRecord ? null : bytes;
  }
}

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

  add(encoded) {
    const size = FRAME_PREFIX + encoded.length;
    if (this.#frames.length >= this.#maxRecords) return false;
    if (this.#frames.length > 0 && this.#bytes + size > this.#maxBytes) return false;
    this.#frames.push(encoded);
    this.#bytes += size;
    return true;
  }

  body() {
    const out = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const frame of this.#frames) {
      const n = frame.length;
      out[offset] = n >>> 24;
      out[offset + 1] = (n >>> 16) & 255;
      out[offset + 2] = (n >>> 8) & 255;
      out[offset + 3] = n & 255;
      out.set(frame, offset + 4);
      offset += 4 + n;
    }
    return out;
  }
}

function furthest(dataset, previous, reached) {
  if (previous === undefined) return reached;
  if (previous === END || reached === END) return END;
  return dataset.syncCompare(previous, reached) >= 0 ? previous : reached;
}

function fields(header, required, optional = []) {
  for (const name of required) if (!Object.hasOwn(header, name)) throw new SyncFault('bad-header', 'header lacks a field');
  for (const name of Object.keys(header)) {
    if (!required.includes(name) && !optional.includes(name)) throw new SyncFault('bad-header', 'header has an unknown field');
  }
}

function setName(value) {
  if (typeof value !== 'string' || !SET_NAME_PATTERN.test(value)) throw new SyncFault('bad-header', 'dataset name is malformed');
  return value;
}

function roundId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new SyncFault('bad-header', 'round is not a positive integer');
  return value;
}

function itemCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SyncWire.MAX_ITEMS) throw new SyncFault('bad-header', 'record count is out of range');
  return value;
}

function splitFrames(body, count) {
  const frames = [];
  let offset = 0;
  for (let k = 0; k < count; k += 1) {
    if (body.length - offset < FRAME_PREFIX) throw new SyncFault('bad-body', 'record batch is truncated');
    const length = readU32(body, offset);
    offset += FRAME_PREFIX;
    if (length < 2 || length > SyncWire.MAX_RECORD) throw new SyncFault('bad-body', 'record length is out of range');
    if (length > body.length - offset) throw new SyncFault('bad-body', 'record batch is truncated');
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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
