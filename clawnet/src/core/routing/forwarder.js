/**
 * The data plane of routing (ARCHITECTURE.md 5.6, as amended by DESIGN.md 15.11 and 15.13).
 *
 * `Forwarder` decides, for every routed packet (DATA and PROBE), whether to deliver it to
 * a local handler, forward it, hold it for a while or drop it, and says why when it drops.
 *
 * What it guarantees:
 *
 *   - Nothing here can be made to use unbounded memory or CPU by a peer. Duplicate
 *     suppression, the transit queue (by count, bytes and previous hop) and the event
 *     stream are all bounded, and a packet that is not for this node is hashed only after
 *     a size check.
 *   - Duplicate suppression keys on SHA-256(dst || id || try || cust || body) for 60
 *     seconds, not on the header. A header-only key would let one packet cancel every later
 *     retransmission, and would let anyone who saw an id burn it with a junk body.
 *   - A destination that is a live direct neighbour is sent to directly, whatever the
 *     shortest-path computation says.
 *   - Packets this node sends or forwards stay within `Limits.MAX_ROUTED_PACKET`.
 *
 * There are no sockets and no timers of its own: the node injects `send`, `nextHop`,
 * `isNeighbour`, a monotonic clock and a `schedule` function, so the unit tests run the
 * real code with fakes. Intervals and expiry use the monotonic clock only (DESIGN.md 15.21).
 *
 * Errors: a packet from a peer that breaks the protocol makes `handle` throw ProtocolError
 * so the peer manager can penalize the sender. Everything that is merely undeliverable is a
 * counted drop, never an exception.
 */

import { ConfigError, ProtocolError, StateError } from '../errors.js';
import { isValidNodeId } from '../crypto/identity.js';
import { sha256 } from '../crypto/primitives.js';
import { SeenCache } from '../messaging/dedupe.js';
import { canonicalBytes } from '../wire/canonical.js';
import { PACKET_PREFIX_BYTES } from '../wire/codec.js';
import { validateDataHeader, validateProbeHeader } from '../wire/schema.js';
import { Limits, PacketType, SealScheme } from '../wire/types.js';

/** Default bound on the bytes held in the transit queue. */
export const TRANSIT_MAX_BYTES = 32 * 1024 * 1024;

/** Default cap on `packet.*` events per second; the excess is counted, not emitted. */
export const PACKET_EVENTS_PER_SEC = 200;

/** Default lifetime of a forwarding duplicate-suppression entry (DESIGN.md 15.11). */
export const FORWARD_DEDUPE_TTL_MS = 60_000;

/** Every reason `packet.dropped` and `stats().dropped_<reason>` can carry from this module. */
export const DropReason = Object.freeze({
  TTL: 'ttl',
  DUPLICATE: 'duplicate',
  NO_TRANSIT: 'no-transit',
  TRANSIT_FULL: 'transit-full',
  HOLD_EXPIRED: 'hold-expired',
  MALFORMED: 'malformed',
  NO_HANDLER: 'no-handler',
  OVERSIZE: 'oversize',
});

/** The selectors `onLocal` accepts. */
export const LOCAL_SELECTORS = Object.freeze([
  'data.sealed',
  'data.transfer',
  'probe',
  'probe.expired',
]);

const DROP_REASONS = Object.freeze(Object.values(DropReason));
const EMPTY = Buffer.alloc(0);
const SEPARATOR = Buffer.from([0]);
const DATA_TAG = Buffer.from('d', 'utf8');
const PROBE_TAG = Buffer.from('p', 'utf8');
const MAX_PATH_NODES = Limits.MAX_TTL + 1;

/**
 * @typedef {object} RoutedPacket
 * @property {number} type    PacketType.DATA or PacketType.PROBE
 * @property {Record<string, unknown>} header
 * @property {Uint8Array} [body]
 */

/**
 * The per-packet decisions of a node that relays routed packets: deliver, forward, hold or
 * drop. See the file comment for what it guarantees.
 */
export class Forwarder {
  #selfId;
  #transit;
  #nextHop;
  #isNeighbour;
  #send;
  #events;
  #monoNow;
  #schedule;
  #log;
  #holdMs;
  #queueMax;
  #queueMaxBytes;
  #perPeerMax;
  #maxPacket;
  #seen;
  #handlers = new Map();

  /** Held packets, oldest first; deadlines therefore ascend. */
  #queue = [];
  #queueCount = 0;
  #queueBytes = 0;
  #queuedFrom = new Map();
  #flushing = false;
  #timerAt = null;
  #cancelTimer = null;
  #closed = false;

  #eventRate;
  #eventTokens;
  #eventClock;

  #counters = {
    originated: 0,
    forwarded: 0,
    delivered: 0,
    queued: 0,
    suppressed: 0,
    handlerErrors: 0,
    sendErrors: 0,
    originateNoRoute: 0,
    originateBackpressure: 0,
  };
  #dropped = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0]));
  #sampled = null;

  /**
   * @param {object} options
   * @param {string} options.selfId this node's id
   * @param {boolean | (() => boolean)} [options.transit] whether this node relays for
   *   others (`caps.transit`); a function is read for every packet. Default true.
   * @param {(dst: string) => string | null} options.nextHop the neighbour to send to for a
   *   destination, or null when there is no route
   * @param {(id: string) => boolean} [options.isNeighbour] whether `id` is a live direct
   *   neighbour; such a destination is sent to directly, whatever `nextHop` says
   *   (DESIGN.md 15.13). Default: nobody is.
   * @param {(neighbour: string, packet: RoutedPacket) => boolean} options.send hand a packet
   *   to the link of a neighbour; true when it was accepted, false when the link cannot
   *   take it now (back-pressure)
   * @param {{ emit: (type: string, data?: unknown) => unknown }} [options.events] the
   *   node's event bus
   * @param {() => number} [options.monoNow] monotonic clock in ms (default
   *   `performance.now`); hold deadlines and duplicate lifetimes are measured on it
   * @param {(fn: () => void, ms: number) => () => void} options.schedule arm a one-shot
   *   timer; returns an idempotent cancel function
   * @param {{ debug?: Function, warn?: Function }} [options.log]
   * @param {number} [options.transitHoldMs] how long a packet without a route is held
   *   (default 30000)
   * @param {number} [options.transitQueueMax] most packets held (default 1000)
   * @param {number} [options.transitQueueMaxBytes] most bytes held (default TRANSIT_MAX_BYTES)
   * @param {number} [options.seenEntries] duplicate-suppression capacity (default 100000)
   * @param {number} [options.dedupeTtlMs] duplicate-suppression lifetime (default 60000)
   * @param {number} [options.packetEventsPerSec] cap on `packet.*` events (default 200)
   * @param {number} [options.maxRoutedPacket] largest packet sent or forwarded, in bytes
   *   (default Limits.MAX_ROUTED_PACKET)
   * @throws {ConfigError} for a missing or malformed option
   */
  constructor({
    selfId,
    transit = true,
    nextHop,
    isNeighbour = () => false,
    send,
    events,
    monoNow = () => performance.now(),
    schedule,
    log,
    transitHoldMs = 30_000,
    transitQueueMax = 1_000,
    transitQueueMaxBytes = TRANSIT_MAX_BYTES,
    seenEntries = 100_000,
    dedupeTtlMs = FORWARD_DEDUPE_TTL_MS,
    packetEventsPerSec = PACKET_EVENTS_PER_SEC,
    maxRoutedPacket = Limits.MAX_ROUTED_PACKET,
  } = {}) {
    if (!isValidNodeId(selfId)) throw new ConfigError('selfId must be a NodeId');
    requireFunction(nextHop, 'nextHop');
    requireFunction(isNeighbour, 'isNeighbour');
    requireFunction(send, 'send');
    requireFunction(monoNow, 'monoNow');
    requireFunction(schedule, 'schedule');
    if (typeof transit !== 'boolean' && typeof transit !== 'function') {
      throw new ConfigError('transit must be a boolean or a function');
    }
    if (events !== undefined && typeof events?.emit !== 'function') {
      throw new ConfigError('events must have an emit function');
    }
    requirePositive(transitHoldMs, 'transitHoldMs');
    requirePositive(transitQueueMax, 'transitQueueMax');
    requirePositive(transitQueueMaxBytes, 'transitQueueMaxBytes');
    requirePositive(packetEventsPerSec, 'packetEventsPerSec');
    requirePositive(maxRoutedPacket, 'maxRoutedPacket');
    this.#selfId = selfId;
    this.#transit = transit;
    this.#nextHop = nextHop;
    this.#isNeighbour = isNeighbour;
    this.#send = send;
    this.#events = events ?? null;
    this.#monoNow = monoNow;
    this.#schedule = schedule;
    this.#log = log ?? null;
    this.#holdMs = transitHoldMs;
    this.#queueMax = transitQueueMax;
    this.#queueMaxBytes = transitQueueMaxBytes;
    // One neighbour that floods us with packets we cannot route must not fill the queue.
    this.#perPeerMax = Math.max(1, Math.floor(transitQueueMax / 4));
    this.#maxPacket = maxRoutedPacket;
    this.#seen = new SeenCache({ maxEntries: seenEntries, ttlMs: dedupeTtlMs, monoNow });
    this.#eventRate = packetEventsPerSec;
    this.#eventTokens = packetEventsPerSec;
    this.#eventClock = monoNow();
    this.#sampled = this.#sampleBase();
  }

  /**
   * Register the handler for packets addressed to this node.
   *
   * `data.sealed` (DATA body scheme 1) and `data.transfer` (scheme 2) are called as
   * `handler(packet, { from })`; `probe` likewise; `probe.expired` is called the same way
   * for a probe whose hop limit ran out at this node. A handler that throws is contained
   * and counted. A second registration replaces the first; `null` removes it.
   *
   * @param {'data.sealed' | 'data.transfer' | 'probe' | 'probe.expired'} selector
   * @param {((packet: RoutedPacket, info: { from: string }) => unknown) | null} handler
   * @returns {void}
   * @throws {ConfigError} for an unknown selector or a handler that is not a function
   */
  onLocal(selector, handler) {
    if (!LOCAL_SELECTORS.includes(selector)) {
      throw new ConfigError(`unknown local selector; expected one of ${LOCAL_SELECTORS.join(', ')}`);
    }
    if (handler !== null) requireFunction(handler, 'handler');
    if (handler === null) this.#handlers.delete(selector);
    else this.#handlers.set(selector, handler);
  }

  /**
   * Handle a routed packet received from a neighbour.
   *
   * In order: validate; deliver if it is for this node; drop oversize; drop a duplicate;
   * drop when the hop limit is used up; drop when this node does not relay; forward;
   * otherwise hold it in the transit queue (no route, the route points back at the sender,
   * or the link is busy).
   *
   * @param {string} from the neighbour the packet arrived from
   * @param {RoutedPacket} packet as decoded by `decodePacket`
   * @returns {void}
   * @throws {ProtocolError} if the header is invalid, a probe has a body or a hop count
   *   above its start value, or the packet type is not routed: the sender broke the protocol
   * @throws {ConfigError} if `from` is not a NodeId (a caller bug)
   * @throws {StateError} after `close()`
   */
  handle(from, packet) {
    this.#requireOpen();
    if (!isValidNodeId(from)) throw new ConfigError('from must be a NodeId');
    const { type, header, body } = parsePacket(packet);

    if (header.dst === this.#selfId) {
      this.#deliver(from, type, header, body);
      return;
    }
    // Cheap bound before any hashing: no honest node sends or forwards more than this.
    if (body.length > this.#maxPacket) {
      this.#drop(DropReason.OVERSIZE, type, header, from);
      return;
    }
    if (!this.#seen.add(forwardKey(type, header, body))) {
      this.#drop(DropReason.DUPLICATE, type, header, from);
      return;
    }
    const ttl = header.ttl - 1;
    if (ttl < 1) {
      if (type === PacketType.PROBE) this.#callLocal('probe.expired', { type, header, body }, from);
      this.#drop(DropReason.TTL, type, header, from);
      return;
    }
    const allowed = typeof this.#transit === 'function' ? this.#transit() : this.#transit;
    if (allowed !== true) {
      this.#drop(DropReason.NO_TRANSIT, type, header, from);
      return;
    }

    const out = { type, header: { ...header, ttl }, body };
    const bytes = packetSize(out);
    if (bytes > this.#maxPacket) {
      this.#drop(DropReason.OVERSIZE, type, header, from);
      return;
    }
    const hop = this.#route(header.dst);
    if (hop === null) {
      this.#enqueue({ from, out, bytes }, 'no-route');
    } else if (hop === from) {
      this.#enqueue({ from, out, bytes }, 'split-horizon');
    } else if (this.#trySend(hop, out)) {
      this.#forwarded(from, hop, out, bytes);
    } else {
      this.#enqueue({ from, out, bytes }, 'backpressure');
    }
  }

  /**
   * Send a packet this node created. Never queues: the caller (the reliable messenger, the
   * diagnostics) has its own retry logic.
   *
   * @param {RoutedPacket} packet
   * @param {{ path?: string[] | null }} [options] `path`: the route this node predicts,
   *   itself first, reported in the `packet.sent` event
   * @returns {{ ok: true, nextHop: string } | { ok: false, reason: 'no-route' | 'backpressure' | 'oversize' }}
   * @throws {ConfigError} if the header is invalid (a caller bug)
   * @throws {StateError} `self-destination` if the packet is addressed to this node, or the
   *   forwarder is closed
   */
  originate(packet, { path } = {}) {
    this.#requireOpen();
    let parsed;
    try {
      parsed = parsePacket(packet);
    } catch (cause) {
      if (cause instanceof ProtocolError) {
        throw new ConfigError(`cannot originate: ${cause.message}`, { cause });
      }
      throw cause;
    }
    const { type, header, body } = parsed;
    if (header.dst === this.#selfId) {
      throw new StateError('self-destination: a packet cannot be addressed to this node');
    }
    const bytes = packetSize(parsed);
    if (bytes > this.#maxPacket) {
      this.#drop(DropReason.OVERSIZE, type, header, null);
      return { ok: false, reason: 'oversize' };
    }
    const hop = this.#route(header.dst);
    if (hop === null) {
      this.#counters.originateNoRoute += 1;
      return { ok: false, reason: 'no-route' };
    }
    // Recorded before sending, so a copy that loops back to us is dropped as a duplicate.
    this.#seen.add(forwardKey(type, header, body));
    if (!this.#trySend(hop, parsed)) {
      this.#counters.originateBackpressure += 1;
      return { ok: false, reason: 'backpressure' };
    }
    this.#counters.originated += 1;
    if (!isTransferPacket(type, body)) {
      this.#emit('packet.sent', {
        id: header.id,
        type: typeName(type),
        dst: header.dst,
        nextHop: hop,
        try: type === PacketType.DATA ? header.try : null,
        bytes,
        path: Array.isArray(path) && isNodeIdList(path) ? path : null,
      });
    }
    return { ok: true, nextHop: hop };
  }

  /**
   * Try the transit queue again, oldest first. The node calls this when routes change, a
   * link comes up or a link's send queue drains. A packet whose hold time has passed is
   * dropped (`hold-expired`) instead. Order is kept per next hop: once a neighbour has
   * refused a packet in this pass, later packets for it wait too.
   *
   * @returns {void}
   */
  flush() {
    if (this.#closed || this.#queue.length === 0 || this.#flushing) return;
    this.#flushing = true;
    try {
      const batch = this.#queue;
      this.#queue = [];
      const now = this.#monoNow();
      const refused = new Set();
      const kept = [];
      for (const entry of batch) {
        if (entry.deadline <= now) {
          this.#release(entry);
          this.#drop(DropReason.HOLD_EXPIRED, entry.out.type, entry.out.header, entry.from);
          continue;
        }
        const hop = this.#route(entry.out.header.dst);
        if (hop === null || hop === entry.from || refused.has(hop)) {
          kept.push(entry);
        } else if (this.#trySend(hop, entry.out)) {
          this.#release(entry);
          this.#forwarded(entry.from, hop, entry.out, entry.bytes);
        } else {
          refused.add(hop);
          kept.push(entry);
        }
      }
      // Anything queued from inside a send or an event listener arrived after these.
      this.#queue = kept.concat(this.#queue);
    } finally {
      this.#flushing = false;
    }
    this.#arm();
  }

  /**
   * Counters since the previous call, for the `traffic.sample` event.
   *
   * @returns {{ originated: number, forwarded: number, delivered: number, queued: number,
   *   dropped: number, suppressed: number }}
   */
  takeTrafficSample() {
    const now = this.#sampleBase();
    const delta = {};
    for (const key of Object.keys(now)) delta[key] = now[key] - this.#sampled[key];
    this.#sampled = now;
    return delta;
  }

  /**
   * @returns {Record<string, number>} flat non-negative integers: `originated`, `forwarded`,
   *   `delivered`, `queued`, `suppressed`, `handlerErrors`, `sendErrors`,
   *   `originateNoRoute`, `originateBackpressure`, `transitQueueLen`, `transitQueueBytes`,
   *   `seenEntries`, `dropped` (all reasons) and one `dropped_<reason>` per reason
   */
  stats() {
    const stats = {
      ...this.#counters,
      transitQueueLen: this.#queueCount,
      transitQueueBytes: this.#queueBytes,
      seenEntries: this.#seen.size,
      dropped: this.#droppedTotal(),
    };
    for (const reason of DROP_REASONS) stats[`dropped_${reason}`] = this.#dropped[reason];
    return stats;
  }

  /**
   * Stop: cancel the hold timer and forget the queue. Idempotent.
   *
   * @returns {void}
   */
  close() {
    this.#closed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#timerAt = null;
    this.#queue = [];
    this.#queueCount = 0;
    this.#queueBytes = 0;
    this.#queuedFrom.clear();
  }

  #requireOpen() {
    if (this.#closed) throw new StateError('closed: the forwarder has been closed');
  }

  /** The neighbour to send to: a live direct neighbour first, otherwise the route. */
  #route(dst) {
    let hop;
    try {
      hop = this.#isNeighbour(dst) === true ? dst : this.#nextHop(dst);
    } catch (error) {
      this.#log?.warn?.('route lookup failed', { code: error?.code ?? null });
      return null;
    }
    return typeof hop === 'string' && hop !== this.#selfId && isValidNodeId(hop) ? hop : null;
  }

  #trySend(hop, packet) {
    try {
      return this.#send(hop, packet) === true;
    } catch (error) {
      // A link that closes between the lookup and the send: hold the packet instead.
      this.#counters.sendErrors += 1;
      this.#log?.warn?.('send failed', { code: error?.code ?? null });
      return false;
    }
  }

  #deliver(from, type, header, body) {
    const packet = { type, header, body };
    let selector = 'probe';
    if (type === PacketType.DATA) {
      if (body.length === 0) return this.#drop(DropReason.MALFORMED, type, header, from);
      if (body[0] === SealScheme.NOISE_X) selector = 'data.sealed';
      else if (body[0] === SealScheme.TRANSFER) selector = 'data.transfer';
      else return this.#drop(DropReason.MALFORMED, type, header, from);
    }
    if (!this.#handlers.has(selector)) {
      return this.#drop(DropReason.NO_HANDLER, type, header, from);
    }
    this.#counters.delivered += 1;
    if (!isTransferPacket(type, body)) {
      this.#emit('packet.delivered', {
        id: header.id,
        type: typeName(type),
        from,
        bytes: packetSize(packet),
      });
    }
    return this.#callLocal(selector, packet, from);
  }

  #callLocal(selector, packet, from) {
    const handler = this.#handlers.get(selector);
    if (handler === undefined) return undefined;
    const failed = (error) => {
      this.#counters.handlerErrors += 1;
      this.#log?.warn?.('local handler failed', { selector, code: error?.code ?? null });
    };
    try {
      const result = handler(packet, { from });
      if (typeof result?.then === 'function') result.then(undefined, failed);
    } catch (error) {
      failed(error);
    }
    return undefined;
  }

  #forwarded(from, hop, out, bytes) {
    this.#counters.forwarded += 1;
    this.#emit('packet.forwarded', {
      id: out.header.id,
      type: typeName(out.type),
      dst: out.header.dst,
      from,
      nextHop: hop,
      ttl: out.header.ttl,
      bytes,
    });
  }

  /** Account for a drop and report it. */
  #drop(reason, type, header, from) {
    this.#dropped[reason] += 1;
    this.#emit('packet.dropped', {
      id: header.id,
      type: typeName(type),
      dst: header.dst,
      from,
      reason,
    });
  }

  #enqueue(entry, reason) {
    const fromCount = this.#queuedFrom.get(entry.from) ?? 0;
    if (
      this.#queueCount >= this.#queueMax ||
      this.#queueBytes + entry.bytes > this.#queueMaxBytes ||
      fromCount >= this.#perPeerMax
    ) {
      this.#drop(DropReason.TRANSIT_FULL, entry.out.type, entry.out.header, entry.from);
      return;
    }
    entry.deadline = this.#monoNow() + this.#holdMs;
    this.#queue.push(entry);
    this.#queueCount += 1;
    this.#queueBytes += entry.bytes;
    this.#queuedFrom.set(entry.from, fromCount + 1);
    this.#counters.queued += 1;
    this.#emit('packet.queued', {
      id: entry.out.header.id,
      type: typeName(entry.out.type),
      dst: entry.out.header.dst,
      from: entry.from,
      reason,
      queued: this.#queueCount,
    });
    this.#arm();
  }

  /** Remove an entry's share from the byte and per-peer accounting. */
  #release(entry) {
    this.#queueCount -= 1;
    this.#queueBytes -= entry.bytes;
    const left = (this.#queuedFrom.get(entry.from) ?? 1) - 1;
    if (left <= 0) this.#queuedFrom.delete(entry.from);
    else this.#queuedFrom.set(entry.from, left);
  }

  /** Keep exactly one timer armed, for the oldest held packet's deadline. */
  #arm() {
    if (this.#closed) return;
    if (this.#queue.length === 0) {
      this.#cancelTimer?.();
      this.#cancelTimer = null;
      this.#timerAt = null;
      return;
    }
    const deadline = this.#queue[0].deadline;
    if (this.#timerAt === deadline) return;
    this.#cancelTimer?.();
    this.#timerAt = deadline;
    const wait = Math.max(0, Math.ceil(deadline - this.#monoNow()));
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = null;
      this.#timerAt = null;
      this.#expire();
    }, wait);
  }

  /** Drop every held packet whose time is up. */
  #expire() {
    if (this.#closed) return;
    const now = this.#monoNow();
    if (!this.#flushing) {
      const kept = [];
      for (const entry of this.#queue) {
        if (entry.deadline <= now) {
          this.#release(entry);
          this.#drop(DropReason.HOLD_EXPIRED, entry.out.type, entry.out.header, entry.from);
        } else {
          kept.push(entry);
        }
      }
      this.#queue = kept;
    }
    this.#arm();
  }

  /** One token bucket for every `packet.*` event; the excess is only counted. */
  #emit(type, data) {
    if (this.#events === null) return;
    const now = this.#monoNow();
    const elapsed = Math.max(0, now - this.#eventClock);
    this.#eventClock = now;
    this.#eventTokens = Math.min(this.#eventRate, this.#eventTokens + (elapsed * this.#eventRate) / 1000);
    if (this.#eventTokens < 1) {
      this.#counters.suppressed += 1;
      return;
    }
    this.#eventTokens -= 1;
    try {
      this.#events.emit(type, data);
    } catch (error) {
      this.#log?.warn?.('event emit failed', { type, code: error?.code ?? null });
    }
  }

  #droppedTotal() {
    let total = 0;
    for (const reason of DROP_REASONS) total += this.#dropped[reason];
    return total;
  }

  #sampleBase() {
    return {
      originated: this.#counters.originated,
      forwarded: this.#counters.forwarded,
      delivered: this.#counters.delivered,
      queued: this.#counters.queued,
      dropped: this.#droppedTotal(),
      suppressed: this.#counters.suppressed,
    };
  }
}

/**
 * Validate a routed packet and return a private copy of its header, so that what was
 * checked is what is used.
 *
 * @throws {ProtocolError}
 */
function parsePacket(packet) {
  if (packet === null || typeof packet !== 'object') {
    throw new ProtocolError('routed packet is not an object');
  }
  const { type } = packet;
  const body = packet.body ?? EMPTY;
  if (!(body instanceof Uint8Array)) throw new ProtocolError('routed packet body is not bytes');
  if (type !== PacketType.DATA && type !== PacketType.PROBE) {
    throw new ProtocolError('packet type is not routed');
  }
  if (packet.header === null || typeof packet.header !== 'object') {
    throw new ProtocolError('routed packet header is not an object');
  }
  const header = { ...packet.header };
  const verdict = type === PacketType.DATA ? validateDataHeader(header) : validateProbeHeader(header);
  if (!verdict.ok) throw new ProtocolError(`invalid routed packet header: ${verdict.reason}`);
  // The validator treats an undefined value as absent; canonical JSON would refuse it later.
  if (Object.values(header).includes(undefined)) {
    throw new ProtocolError('routed packet header has an undefined field');
  }
  if (type === PacketType.PROBE && body.length > 0) {
    throw new ProtocolError('a probe carries no body');
  }
  return { type, header, body };
}

/**
 * The duplicate-suppression key (DESIGN.md 15.11): SHA-256 over every field that makes two
 * transmissions the same transmission. `cust` is included so a mailbox that retransmits
 * with its own counter does not collide with the originator's packet. A probe has no body;
 * `n` stands in for the part of its header that does not change from hop to hop.
 */
function forwardKey(type, header, body) {
  const text = (value) => Buffer.from(String(value ?? ''), 'utf8');
  if (type === PacketType.PROBE) {
    return sha256(
      PROBE_TAG, text(header.dst), SEPARATOR, text(header.id), SEPARATOR,
      text(header.rsvp), SEPARATOR, text(header.n),
    ).toString('hex');
  }
  return sha256(
    DATA_TAG, text(header.dst), SEPARATOR, text(header.id), SEPARATOR,
    Buffer.from([header.try]), SEPARATOR, text(header.cust), SEPARATOR, body,
  ).toString('hex');
}

/** Encoded size of a packet: prefix, canonical header and body. */
function packetSize({ header, body }) {
  return PACKET_PREFIX_BYTES + canonicalBytes(header).length + body.length;
}

/** File chunks would drown the event stream; `traffic.sample` reports them instead. */
function isTransferPacket(type, body) {
  return type === PacketType.DATA && body.length > 0 && body[0] === SealScheme.TRANSFER;
}

function typeName(type) {
  return type === PacketType.PROBE ? 'probe' : 'data';
}

function isNodeIdList(list) {
  return list.length <= MAX_PATH_NODES && list.every((id) => isValidNodeId(id));
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new ConfigError(`${name} must be a function`);
}

function requirePositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a number > 0`);
  }
}
