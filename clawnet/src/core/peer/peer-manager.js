/**
 * The peer manager (ARCHITECTURE.md 5.4, amended by DESIGN.md 15.5 to 15.8 and 15.22).
 *
 * Owns every link: dials and accepts, applies admission policy and duplicate-link
 * resolution, runs keepalive and RTT measurement, enforces per-link receive budgets, and
 * redials with backoff. Everything above it sends and receives packets by NodeId and
 * never sees a socket.
 *
 * Decisions taken here, each from the design section named:
 *
 *   - Duplicate links (15.5). At most one link per NodeId is active. When a second one
 *     completes, the two 32-byte identity public keys are compared as unsigned bytes. If
 *     the links were initiated from opposite sides and their handshakes began within one
 *     handshake timeout of each other, the link initiated by the node with the smaller key
 *     is kept and the other is closed with BYE "duplicate". Otherwise the newer link
 *     replaces the older (BYE "replaced"). Both ends apply the same rule to the same pair.
 *     When the rule already rejects a link during its handshake, the link is refused with
 *     reason "duplicate" before it ever comes up.
 *   - Liveness (15.6). Any authenticated record received proves the peer is alive. A PING
 *     carries a fresh random nonce that the PONG must echo, so a peer cannot answer a ping
 *     it has not seen and the round-trip time cannot be faked low. Samples feed the link's
 *     LinkMetric (core/routing/metric.js).
 *   - Budgets (15.8). Control packets (everything link-local) and routed packets (DATA and
 *     PROBE) are charged to separate token buckets from config.limits. A routed packet
 *     over budget is dropped and counted; the neighbour is never disconnected for it, as
 *     it may only be relaying someone else's flood. Control traffic over budget pauses
 *     reading from the link until the bucket refills (TCP then pushes back on the sender);
 *     it never disconnects either. Breaking a hard limit of the codec does.
 *   - Dial policy (15.22). Dials are budgeted by IP address, not by NodeId: one attempt in
 *     flight per IP, a failure backoff per IP shared by every NodeId that claims it, a
 *     global dials-per-second cap (config.limits.dialsPerSecond) and at most
 *     MAX_CONCURRENT_DIALS in flight. Addresses learned from the network (beacons, peer
 *     records, handshakes) that are loopback, unspecified, multicast or link-local are
 *     never dialed unless config.discovery.allowLoopback; addresses the operator gave
 *     (bootstrap, connect) always are. A DNS name is keyed by its lower-cased text.
 *   - Redial: jittered exponential backoff from timers.redialMinMs to timers.redialMaxMs.
 */

import { performance } from 'node:perf_hooks';

import { Identity, nodeIdToPublicKey } from '../crypto/identity.js';
import { base64Decode, randomBytes } from '../crypto/primitives.js';
import { validateConfig } from '../config.js';
import { ClawNetError, ConfigError, HandshakeError, StateError } from '../errors.js';
import { LinkMetric } from '../routing/metric.js';
import { establishChannel, SendPriority } from '../transport/secure-channel.js';
import { dialTcp, isRestrictedIp, listenTcp, normalizeIp } from '../transport/tcp.js';
import { formatAddress, isIpLiteral, parseAddress, validateAddress, validatePingHeader } from '../wire/schema.js';
import { isRoutedType, Limits, PacketType } from '../wire/types.js';
import { AddressBook, AddressSource } from './address-book.js';

/** Most outbound dials in flight at once. */
export const MAX_CONCURRENT_DIALS = 4;

/** Most inbound handshakes in progress at once. */
export const MAX_PENDING_INBOUND = 32;

/** Most inbound handshakes in progress from one IP address. */
export const MAX_PENDING_PER_IP = 4;

/** Most NodeIds in the penalty box. */
export const MAX_PENALTY_BOX = 1024;

/** Most IP addresses with remembered dial backoff. */
export const MAX_IP_BACKOFF_ENTRIES = 4096;

/** Agent string announced in handshakes unless the owner gives another. */
export const DEFAULT_AGENT = 'clawnet/0.1.0';

/** `link.throttled` is emitted at most once per this interval per link. */
export const THROTTLE_EVENT_INTERVAL_MS = 1000;

/** Reasons with which a node refuses a link (`peer.refused`). */
const REFUSALS = new Set(['self', 'blocked', 'not-allowed', 'full']);

/** Dial failures that say something about the IP address rather than about one node. */
const IP_FAILURES = new Set([
  'connect-failed', 'connect-timeout', 'handshake-timeout', 'closed', 'noise', 'bad-payload',
  'version', 'network-mismatch', 'key-mismatch', 'bad-card', 'clock-skew', 'protocol', 'refused',
]);

/** Error codes from onPacket that mean the peer broke the protocol. */
const PROTOCOL_CODES = new Set(['ERR_PROTOCOL', 'ERR_WIRE', 'ERR_CANONICAL']);

const NONCE_BYTES = 8;

/**
 * @typedef {object} PeerInfo
 * @property {string} id
 * @property {string} linkId
 * @property {"in" | "out"} direction
 * @property {string} addr          remote address ("tcp://host:port")
 * @property {string} agent
 * @property {{ relay: boolean, mailbox: boolean, transit: boolean }} caps
 * @property {string[]} listen      addresses the peer announced
 * @property {number} since          ms
 * @property {number | null} rttMs   last keepalive round trip
 * @property {number | null} srttMs  smoothed round trip
 * @property {number} cost
 * @property {number} misses
 * @property {number} lastRxAt       ms of the last authenticated record received
 * @property {number} packetsIn
 * @property {number} packetsOut
 * @property {number} bytesIn        ciphertext bytes
 * @property {number} bytesOut
 * @property {number} queuedBytes
 * @property {boolean} throttled
 * @property {boolean} sticky
 * @property {number} dataDropped    routed packets dropped over the DATA budget
 * @property {number} rekeysIn
 * @property {number} rekeysOut
 */

/** A token bucket. Time is performance.now() milliseconds. */
class Bucket {
  #rate;
  #burst;
  #tokens;
  #last;

  constructor(perSecond, burst) {
    this.#rate = perSecond / 1000;
    this.#burst = burst;
    this.#tokens = burst;
    this.#last = performance.now();
  }

  #refill() {
    const now = performance.now();
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#last) * this.#rate);
    this.#last = now;
  }

  /** Charge unconditionally. @returns {number} tokens left, possibly negative */
  charge(n) {
    this.#refill();
    this.#tokens -= n;
    return this.#tokens;
  }

  /** @returns {boolean} whether `n` tokens are available now */
  has(n) {
    this.#refill();
    return this.#tokens >= n;
  }

  take(n) {
    this.#tokens -= n;
  }

  /** @returns {number} ms until the bucket is non-negative again */
  msUntilNonNegative() {
    this.#refill();
    return this.#tokens >= 0 ? 0 : Math.ceil(-this.#tokens / this.#rate);
  }
}

export class PeerManager {
  #identity;
  #config;
  #events;
  #book;
  #now;
  #rng;
  #log;
  #ownAddresses;
  #preferPeer;
  #advertisedCost;
  #onLinkUp;
  #onLinkDown;
  #onLinkCost;
  #onPacket;
  #onObserved;
  #agent;
  #networkKey;
  #rekeyInterval;
  #maxQueueBytes;
  #maxControlBytes;
  #maxDials;
  #maxPendingInbound;
  #maxPendingPerIp;
  #block;
  #allow;
  #selfKey;

  #state = 'new';
  #listener = null;
  /** @type {Map<string, object>} active link per NodeId */
  #links = new Map();
  /** every link not yet closed, active or not */
  #allLinks = new Set();
  /** @type {Map<string, { info: object, promise: Promise<object>, controller: AbortController }>} by address */
  #dials = new Map();
  #ipBusy = new Set();
  /** @type {Map<string, { fails: number, until: number }>} performance.now() deadlines */
  #ipBackoff = new Map();
  #pendingInbound = new Set();
  #pendingPerIp = new Map();
  /** @type {Map<string, number>} NodeId -> performance.now() until */
  #penalty = new Map();
  #observed = [];
  #dialTokens;
  #timers = new Set();
  #maintenanceTimer = null;
  #maintenanceAt = Infinity;
  /** @type {Map<string, { link: object, info: object, timer: object }>} */
  #handover = new Map();
  /** @type {Map<string, Set<() => void>>} */
  #linkWaiters = new Map();
  #linkCounter = 0;

  #stats = {
    dialsStarted: 0, dialsFailed: 0, handshakesIn: 0, handshakesRefused: 0,
    inboundRejected: 0, linksOpened: 0, linksClosed: 0, duplicatesResolved: 0,
    penalties: 0, packetsIn: 0, packetsOut: 0, throttleEvents: 0, sendRefused: 0,
    dataDropped: 0,
  };

  /**
   * @param {object} options
   * @param {Identity} options.identity
   * @param {object} options.config        a configuration accepted by validateConfig
   * @param {import('../events.js').EventBus} options.events
   * @param {AddressBook} options.addressBook loaded
   * @param {() => number} [options.now]     wall clock, ms; default Date.now
   * @param {() => number} [options.rng]     uniform in [0, 1); default Math.random
   * @param {{ debug: Function, info: Function, warn: Function, error: Function }} [options.log]
   * @param {() => string[]} [options.ownAddresses] addresses to announce (ARCHITECTURE.md 4.6)
   * @param {(id: string) => boolean} [options.preferPeer] dial preference
   * @param {(id: string) => number | null} [options.advertisedCost] cost in our current LSA
   * @param {(peer: PeerInfo) => void} [options.onLinkUp]
   * @param {(peer: PeerInfo, why: { reason: string, remote: boolean }) => void} [options.onLinkDown]
   * @param {(id: string, cost: number) => void} [options.onLinkCost]
   * @param {(id: string, packet: object) => void} [options.onPacket] every packet but PING,
   *   PONG and BYE; throwing a ClawNetError with code ERR_PROTOCOL, ERR_WIRE or
   *   ERR_CANONICAL penalizes the peer
   * @param {() => void} [options.onObserved] the set of observed own addresses changed
   * @param {string} [options.agent]          default DEFAULT_AGENT
   * @param {number} [options.rekeyInterval]  records per direction between rekeys
   * @param {number} [options.maxQueueBytes]  per-link ack and data send queue bound
   * @param {number} [options.maxControlBytes] per-link control send queue bound
   * @param {number} [options.maxConcurrentDials] default MAX_CONCURRENT_DIALS
   * @param {number} [options.maxPendingInbound]  default MAX_PENDING_INBOUND
   * @param {number} [options.maxPendingPerIp]    default MAX_PENDING_PER_IP
   * @throws {ConfigError} on invalid options
   */
  constructor({
    identity, config, events, addressBook, now = Date.now, rng = Math.random, log,
    ownAddresses = () => [], preferPeer = () => false, advertisedCost = () => null,
    onLinkUp = () => {}, onLinkDown = () => {}, onLinkCost = () => {}, onPacket = () => {},
    onObserved = () => {}, agent = DEFAULT_AGENT, rekeyInterval, maxQueueBytes, maxControlBytes,
    maxConcurrentDials = MAX_CONCURRENT_DIALS, maxPendingInbound = MAX_PENDING_INBOUND,
    maxPendingPerIp = MAX_PENDING_PER_IP,
  } = {}) {
    if (!(identity instanceof Identity)) throw new ConfigError('identity must be an Identity');
    if (events === null || typeof events !== 'object' || typeof events.emit !== 'function') {
      throw new ConfigError('events must be an EventBus');
    }
    if (!(addressBook instanceof AddressBook)) throw new ConfigError('addressBook must be an AddressBook');
    for (const [name, fn] of Object.entries({
      now, rng, ownAddresses, preferPeer, advertisedCost, onLinkUp, onLinkDown, onLinkCost, onPacket, onObserved,
    })) {
      if (typeof fn !== 'function') throw new ConfigError(`${name} must be a function`);
    }
    for (const [name, value] of Object.entries({ maxConcurrentDials, maxPendingInbound, maxPendingPerIp })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
    }
    this.#identity = identity;
    this.#config = validateConfig(config);
    this.#events = events;
    this.#book = addressBook;
    this.#now = now;
    this.#rng = rng;
    this.#log = log ?? null;
    this.#ownAddresses = ownAddresses;
    this.#preferPeer = preferPeer;
    this.#advertisedCost = advertisedCost;
    this.#onLinkUp = onLinkUp;
    this.#onLinkDown = onLinkDown;
    this.#onLinkCost = onLinkCost;
    this.#onPacket = onPacket;
    this.#onObserved = onObserved;
    this.#agent = agent;
    this.#networkKey = this.#config.networkKey === null ? null : base64Decode(this.#config.networkKey, 32);
    this.#rekeyInterval = rekeyInterval;
    this.#maxQueueBytes = maxQueueBytes;
    this.#maxControlBytes = maxControlBytes;
    this.#maxDials = maxConcurrentDials;
    this.#maxPendingInbound = maxPendingInbound;
    this.#maxPendingPerIp = maxPendingPerIp;
    this.#block = new Set(this.#config.peers.block);
    this.#allow = new Set(this.#config.peers.allow);
    this.#selfKey = nodeIdToPublicKey(identity.nodeId);
    const rate = this.#config.limits.dialsPerSecond;
    this.#dialTokens = new Bucket(rate, Math.max(1, rate));
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Open the listener and start maintenance (dialing).
   *
   * @returns {Promise<{ host: string, port: number }>} the bound listen address
   * @throws {StateError} if already started, or "listen-failed: ..." if binding fails
   */
  async start() {
    if (this.#state !== 'new') throw new StateError('already-started: the peer manager can be started once');
    this.#state = 'starting';
    try {
      this.#listener = await listenTcp({
        host: this.#config.listen.host,
        port: this.#config.listen.port,
        onSocket: socket => this.#onSocket(socket),
        onError: err => this.#internalError('listener', err),
      });
    } catch (err) {
      this.#state = 'stopped';
      throw err;
    }
    this.#state = 'running';
    this.#scheduleMaintenance(0);
    return { ...this.#listener.address };
  }

  /**
   * Close every link with BYE "shutdown", stop dialing and accepting, cancel every timer.
   * Idempotent.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.#state === 'stopped' || this.#state === 'stopping') return;
    this.#state = 'stopping';
    if (this.#maintenanceTimer !== null) clearTimeout(this.#maintenanceTimer);
    this.#maintenanceTimer = null;
    const closing = [];
    if (this.#listener !== null) closing.push(this.#listener.close());
    for (const dial of this.#dials.values()) dial.controller.abort();
    for (const socket of this.#pendingInbound) socket.destroy();
    for (const { link, info, timer } of this.#handover.values()) {
      this.#cancel(timer);
      this.#finalizeDown(link, info);
    }
    this.#handover.clear();
    for (const link of [...this.#allLinks]) closing.push(link.channel.close('shutdown'));
    await Promise.allSettled(closing);
    await Promise.allSettled([...this.#dials.values()].map(d => d.promise));
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const waiters of this.#linkWaiters.values()) for (const wake of waiters) wake();
    this.#linkWaiters.clear();
    this.#state = 'stopped';
  }

  /** @returns {{ host: string, port: number } | null} the bound listener address */
  get listenAddress() {
    return this.#listener === null ? null : { ...this.#listener.address };
  }

  // ------------------------------------------------------------------ public API

  /**
   * Dial an address now and resolve when linked to whoever answers.
   *
   * @param {string} addr "tcp://host:port"
   * @param {{ sticky?: boolean }} [options] sticky (default): remember the address as
   *   `manual` and keep redialing it until disconnect(id, { forget: true })
   * @returns {Promise<PeerInfo>} also when the handshake ends in "duplicate" because a
   *   link to that node already exists
   * @throws {ConfigError} for an invalid address
   * @throws {StateError} "not-running: ..." or "peer-limit: ..."
   * @throws {HandshakeError} with the reason the dial failed
   */
  async connect(addr, { sticky = true } = {}) {
    if (!validateAddress(addr).ok) throw new ConfigError('address must be "tcp://host:port"');
    if (this.#state !== 'running') throw new StateError('not-running: the peer manager is not running');
    if (this.#links.size >= this.#config.peers.max) {
      throw new StateError(`peer-limit: already linked to ${this.#links.size} peers`);
    }
    const known = this.#book.get(addr)?.id;
    if (known != null && this.#links.has(known)) return this.#info(this.#links.get(known));
    if (sticky) this.#book.add(addr, { source: AddressSource.MANUAL });
    const pending = this.#dials.get(addr);
    try {
      const link = await (pending?.promise ?? this.#dial(addr, { source: AddressSource.MANUAL, explicit: true }));
      const active = this.#links.get(link.id);
      if (active === undefined) throw new HandshakeError('closed', 'link closed right after it was established');
      return this.#info(active);
    } catch (err) {
      if (err instanceof HandshakeError && err.reason === 'duplicate' && typeof err.peer === 'string') {
        const link = await this.#waitForLink(err.peer, this.#config.timers.handshakeTimeoutMs);
        if (link !== null) return this.#info(link);
      }
      throw err;
    }
  }

  /**
   * Close the link to a node.
   *
   * @param {string} id
   * @param {{ reason?: string, forget?: boolean }} [options] `forget` (default true) also
   *   drops the node's `manual` addresses, so it is not redialed
   * @returns {Promise<boolean>} whether a link existed
   */
  async disconnect(id, { reason = 'manual', forget = true } = {}) {
    if (forget) this.#book.setAddressesFor(id, [], AddressSource.MANUAL);
    const link = this.#links.get(id);
    if (link === undefined) return false;
    if (forget) link.noRedial = true;
    await link.channel.close(reason);
    return true;
  }

  /**
   * Close the link to `id` with BYE "protocol" and refuse it (inbound and dialing) for
   * timers.redialMaxMs.
   *
   * @param {string} id
   * @param {string} why for the log only
   */
  penalize(id, why) {
    this.#addPenalty(id);
    this.#log?.warn('peer penalized', { peer: id, why: String(why).slice(0, 200) });
    const link = this.#links.get(id);
    if (link !== undefined) link.channel.close('protocol');
  }

  /**
   * Queue a packet for a linked node.
   *
   * @param {string} id
   * @param {object | Uint8Array} packet a Packet or an encoded packet
   * @param {{ priority?: "control" | "ack" | "data" }} [options] default: control for
   *   link-local types, data for routed types
   * @returns {boolean} false if not linked or the link's queue for that class is full
   * @throws {import('../errors.js').WireError} for a packet that is not sendable
   */
  send(id, packet, { priority } = {}) {
    const link = this.#links.get(id);
    if (link === undefined) {
      this.#stats.sendRefused += 1;
      return false;
    }
    const ok = link.channel.send(packet, { priority });
    if (ok) {
      link.packetsOut += 1;
      this.#stats.packetsOut += 1;
    } else {
      this.#stats.sendRefused += 1;
    }
    return ok;
  }

  /** @param {string} id @returns {boolean} */
  isLinked(id) {
    return this.#links.has(id);
  }

  /** @param {string} id @returns {PeerInfo | null} */
  get(id) {
    const link = this.#links.get(id);
    return link === undefined ? null : this.#info(link);
  }

  /** @returns {PeerInfo[]} */
  list() {
    return [...this.#links.values()].map(link => this.#info(link));
  }

  /** @returns {Array<{ addr: string, id: string | null, source: string, since: number, attempt: number }>} */
  dialing() {
    return [...this.#dials.values()].map(d => ({ ...d.info }));
  }

  /** @returns {Array<{ peer: string, cost: number }>} the active links and their costs */
  links() {
    return [...this.#links.values()].map(link => ({ peer: link.id, cost: link.metric.cost }));
  }

  /** @param {string} id @returns {object | null} the identity card of a linked node */
  cardOf(id) {
    return this.#links.get(id)?.channel.remoteCard ?? null;
  }

  /** @returns {string[]} up to 4 most recent distinct IPs that peers reported seeing us at */
  observedAddresses() {
    return [...this.#observed];
  }

  /** @returns {number} number of active links */
  get size() {
    return this.#links.size;
  }

  /** @returns {Record<string, number>} counters and gauges */
  stats() {
    let bytesIn = 0;
    let bytesOut = 0;
    for (const link of this.#links.values()) {
      const s = link.channel.stats();
      bytesIn += s.bytesIn;
      bytesOut += s.bytesOut;
    }
    return {
      ...this.#stats,
      links: this.#links.size,
      dialing: this.#dials.size,
      pendingInbound: this.#pendingInbound.size,
      penaltyBox: this.#penalty.size,
      bytesIn,
      bytesOut,
    };
  }

  // ------------------------------------------------------------------ admission

  #authorize({ id }, { direction, startedAt }) {
    if (this.#state !== 'running') return 'shutdown';
    if (id === this.#identity.nodeId) return 'self';
    if (this.#block.has(id) || this.#isPenalized(id)) return 'blocked';
    if (this.#allow.size > 0 && !this.#allow.has(id)) return 'not-allowed';
    const existing = this.#links.get(id);
    if (existing === undefined) {
      if (direction === 'in' && this.#links.size >= this.#config.peers.max) return 'full';
      return null;
    }
    const verdict = this.#duplicateVerdict(existing, { direction, startedAt });
    return verdict.keepNew ? null : 'duplicate';
  }

  /**
   * DESIGN.md 15.5: which of two links to one node stays.
   *
   * @returns {{ keepNew: boolean, reason: "duplicate" | "replaced" }}
   */
  #duplicateVerdict(existing, candidate) {
    const opposite = existing.direction !== candidate.direction;
    const close = Math.abs(existing.startedAt - candidate.startedAt) <= this.#config.timers.handshakeTimeoutMs;
    if (opposite && close) {
      const peerKey = nodeIdToPublicKey(existing.id);
      const selfSmaller = Buffer.compare(this.#selfKey, peerKey) < 0;
      // The link initiated by the node with the smaller key wins.
      const candidateInitiatedBySelf = candidate.direction === 'out';
      return { keepNew: candidateInitiatedBySelf === selfSmaller, reason: 'duplicate' };
    }
    return { keepNew: true, reason: 'replaced' };
  }

  #isPenalized(id) {
    const until = this.#penalty.get(id);
    if (until === undefined) return false;
    if (until <= performance.now()) {
      this.#penalty.delete(id);
      return false;
    }
    return true;
  }

  #addPenalty(id) {
    if (this.#isPenalized(id)) return;
    if (this.#penalty.size >= MAX_PENALTY_BOX) {
      let soonest = null;
      for (const [key, until] of this.#penalty) if (soonest === null || until < this.#penalty.get(soonest)) soonest = key;
      this.#penalty.delete(soonest);
    }
    this.#penalty.set(id, performance.now() + this.#config.timers.redialMaxMs);
    this.#stats.penalties += 1;
  }

  #channelOptions(stream, initiator, authorize) {
    return {
      stream,
      initiator,
      identity: this.#identity,
      networkId: this.#config.networkId,
      networkKey: this.#networkKey,
      buildLocal: () => this.#buildLocal(),
      authorize,
      now: this.#now,
      handshakeTimeoutMs: this.#config.timers.handshakeTimeoutMs,
      maxClockSkewMs: this.#config.limits.maxClockSkewMs,
      maxQueueBytes: this.#maxQueueBytes,
      maxControlBytes: this.#maxControlBytes,
      rekeyInterval: this.#rekeyInterval,
    };
  }

  #buildLocal() {
    let listen = [];
    try {
      listen = this.#ownAddresses().filter(a => validateAddress(a).ok).slice(0, Limits.MAX_PEER_ADDRS);
    } catch (err) {
      this.#internalError('ownAddresses', err);
    }
    const { relay, mailbox, transit } = this.#config.caps;
    return { agent: this.#agent, caps: { relay, mailbox, transit }, listen };
  }

  // ------------------------------------------------------------------ inbound

  #onSocket(socket) {
    const ip = normalizeIp(socket.remoteAddress);
    const fromIp = this.#pendingPerIp.get(ip) ?? 0;
    if (
      this.#state !== 'running' ||
      this.#pendingInbound.size >= this.#maxPendingInbound ||
      fromIp >= this.#maxPendingPerIp
    ) {
      this.#stats.inboundRejected += 1;
      socket.destroy();
      return;
    }
    this.#pendingInbound.add(socket);
    this.#pendingPerIp.set(ip, fromIp + 1);
    this.#stats.handshakesIn += 1;
    const startedAt = performance.now();
    const addr = socketAddress(ip, socket.remotePort);
    establishChannel(this.#channelOptions(socket, false, ctx => this.#authorize(ctx, { direction: 'in', startedAt })))
      .then(channel => this.#adopt(channel, { direction: 'in', addr, dialedAddr: null, startedAt }))
      .catch(err => {
        const reason = err instanceof HandshakeError ? err.reason : 'internal';
        if (REFUSALS.has(reason)) {
          this.#stats.handshakesRefused += 1;
          this.#emit('peer.refused', { addr, peer: err.peer ?? null, direction: 'in', reason });
        }
        if (!(err instanceof HandshakeError)) this.#internalError('inbound-handshake', err);
      })
      .finally(() => {
        this.#pendingInbound.delete(socket);
        const left = (this.#pendingPerIp.get(ip) ?? 1) - 1;
        if (left <= 0) this.#pendingPerIp.delete(ip);
        else this.#pendingPerIp.set(ip, left);
      });
  }

  // ------------------------------------------------------------------ outbound

  #dial(addr, { source, explicit }) {
    const controller = new AbortController();
    const entry = this.#book.get(addr);
    const info = { addr, id: entry?.id ?? null, source, since: this.#now(), attempt: (entry?.fails ?? 0) + 1 };
    const record = { info, controller, promise: null };
    // Aborting also ends a handshake already under way on the dialed socket.
    controller.signal.addEventListener('abort', () => record.socket?.destroy(), { once: true });
    record.promise = this.#runDial(addr, record, { explicit, entry }).finally(() => {
      if (this.#dials.get(addr) === record) this.#dials.delete(addr);
      this.#scheduleMaintenance(0);
    });
    this.#dials.set(addr, record);
    // connect() observes the outcome; maintenance dials only log it.
    if (!explicit) record.promise.catch(() => {});
    return record.promise;
  }

  async #runDial(addr, record, { explicit, entry }) {
    const { host, port } = parseAddress(addr);
    const ip = ipKey(host);
    if (explicit) await this.#waitForDialSlot(ip, record.controller.signal);
    // Maintenance dials were admitted by #canStartDial in this same synchronous run.
    this.#ipBusy.add(ip);
    try {
      const isStatic = explicit || (entry?.sources ?? []).some(s => s === AddressSource.MANUAL || s === AddressSource.BOOTSTRAP);
      this.#stats.dialsStarted += 1;
      this.#emit('peer.dialing', { addr, peer: record.info.id, source: record.info.source, attempt: record.info.attempt });
      const startedAt = performance.now();
      let channel;
      try {
        const socket = await dialTcp({
          host,
          port,
          timeoutMs: this.#config.timers.handshakeTimeoutMs,
          signal: record.controller.signal,
          allowRestricted: isStatic || this.#config.discovery.allowLoopback,
        });
        record.socket = socket;
        if (record.controller.signal.aborted) {
          socket.destroy();
          throw new HandshakeError('closed', 'dial aborted');
        }
        channel = await establishChannel(
          this.#channelOptions(socket, true, ctx => this.#authorize(ctx, { direction: 'out', startedAt })),
        );
      } catch (err) {
        this.#dialFailed(addr, ip, err, record.info);
        throw err;
      }
      this.#ipBackoff.delete(ip);
      // Bound even if this link loses a duplicate tie-break, so the address is not redialed.
      this.#book.bind(addr, channel.remoteId);
      const link = this.#adopt(channel, { direction: 'out', addr, dialedAddr: addr, startedAt });
      if (link === null) throw new HandshakeError('shutdown', 'stopping');
      return link;
    } finally {
      this.#ipBusy.delete(ip);
    }
  }

  /** Explicit dials wait for their IP to be free and for the global dial budget. */
  async #waitForDialSlot(ip, signal) {
    for (;;) {
      if (signal.aborted || this.#state !== 'running') throw new HandshakeError('closed', 'dial aborted');
      if (!this.#ipBusy.has(ip) && this.#dialTokens.has(1)) {
        // Taken in the same synchronous run as the check, so two waiters cannot both pass.
        this.#dialTokens.take(1);
        this.#ipBusy.add(ip);
        return;
      }
      const wait = this.#dialTokens.has(1) ? 10 : Math.ceil(1000 / this.#config.limits.dialsPerSecond);
      await new Promise(resolve => this.#later(resolve, wait, 'dial-wait'));
    }
  }

  #dialFailed(addr, ip, err, info) {
    const reason = err instanceof HandshakeError ? err.reason : 'connect-failed';
    if (!(err instanceof HandshakeError)) this.#internalError('dial', err);
    const peer = typeof err?.peer === 'string' ? err.peer : info.id;
    // Whoever answered, the address is now known to be theirs; without this a sticky
    // address refused as "duplicate" would look unlinked and be dialed again at once.
    if (typeof err?.peer === 'string' && reason !== 'self') this.#book.bind(addr, err.peer);
    if (reason === 'duplicate' || this.#state !== 'running') return;
    this.#stats.dialsFailed += 1;
    if (reason === 'self') this.#book.markSelf(addr);
    if (REFUSALS.has(reason)) {
      this.#stats.handshakesRefused += 1;
      this.#emit('peer.refused', { addr, peer, direction: 'out', reason });
    }
    const fails = this.#book.markFailure(addr, reason);
    let ipFails = 0;
    if (IP_FAILURES.has(reason)) {
      const state = this.#ipBackoff.get(ip) ?? { fails: 0, until: 0 };
      state.fails += 1;
      ipFails = state.fails;
      this.#ipBackoff.delete(ip);
      if (this.#ipBackoff.size >= MAX_IP_BACKOFF_ENTRIES) {
        this.#ipBackoff.delete(this.#ipBackoff.keys().next().value);
      }
      this.#ipBackoff.set(ip, state);
    }
    const timers = this.#config.timers;
    let delay;
    if (reason === 'full') delay = timers.redialMaxMs;
    else if (reason === 'blocked' || reason === 'not-allowed') delay = 10 * timers.redialMaxMs;
    else delay = this.#backoff(Math.max(fails, ipFails, 1));
    if (ipFails > 0) this.#ipBackoff.get(ip).until = performance.now() + delay;
    this.#book.defer(addr, this.#now() + delay);
    this.#emit('peer.dial_failed', { addr, peer, reason, retryInMs: reason === 'self' ? null : delay });
  }

  #backoff(fails) {
    const { redialMinMs, redialMaxMs, redialJitter } = this.#config.timers;
    const base = Math.min(redialMaxMs, redialMinMs * 2 ** Math.min(fails - 1, 30));
    return Math.max(1, Math.round(base * (1 + redialJitter * (2 * this.#rng() - 1))));
  }

  #waitForLink(id, timeoutMs) {
    const existing = this.#links.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise(resolve => {
      let waiters = this.#linkWaiters.get(id);
      if (waiters === undefined) {
        waiters = new Set();
        this.#linkWaiters.set(id, waiters);
      }
      const wake = () => {
        this.#cancel(timer);
        waiters.delete(wake);
        if (waiters.size === 0 && this.#linkWaiters.get(id) === waiters) this.#linkWaiters.delete(id);
        resolve(this.#links.get(id) ?? null);
      };
      const timer = this.#later(wake, timeoutMs, 'link-wait');
      waiters.add(wake);
    });
  }

  // ------------------------------------------------------------------ maintenance

  #scheduleMaintenance(ms) {
    if (this.#state !== 'running') return;
    const at = performance.now() + ms;
    if (this.#maintenanceTimer !== null && this.#maintenanceAt <= at) return;
    if (this.#maintenanceTimer !== null) clearTimeout(this.#maintenanceTimer);
    this.#maintenanceAt = at;
    this.#maintenanceTimer = setTimeout(() => {
      this.#maintenanceTimer = null;
      this.#maintenanceAt = Infinity;
      try {
        this.#maintain();
      } catch (err) {
        this.#internalError('maintenance', err);
      }
    }, Math.max(0, ms));
  }

  #maintain() {
    if (this.#state !== 'running') return;
    const { peers, timers, discovery } = this.#config;
    // A node in its handover window still has a link with us that the peer is finishing.
    const busyIds = new Set([
      ...this.#links.keys(),
      ...this.#handover.keys(),
      ...[...this.#dials.values()].map(d => d.info.id).filter(Boolean),
    ]);
    const filter = entry => this.#dialable(entry);
    if (this.#links.size < peers.max) {
      const sticky = this.#book.candidates({ sources: [AddressSource.MANUAL], exclude: busyIds, filter });
      for (const entry of sticky) {
        if (!this.#canStartDial(entry.addr)) break;
        this.#dial(entry.addr, { source: AddressSource.MANUAL, explicit: false });
        if (entry.id !== null) busyIds.add(entry.id);
      }
      const sources = [AddressSource.BOOTSTRAP, AddressSource.MULTICAST];
      if (discovery.pex) sources.push(AddressSource.PEX, AddressSource.HANDSHAKE);
      while (this.#links.size + this.#dials.size < Math.min(peers.target, peers.max)) {
        const [entry] = this.#book.candidates({
          sources,
          exclude: busyIds,
          filter,
          prefer: id => this.#safePrefer(id),
          limit: 1,
        });
        if (entry === undefined || !this.#canStartDial(entry.addr)) break;
        this.#dial(entry.addr, { source: entry.sources.find(s => sources.includes(s)), explicit: false });
        if (entry.id !== null) busyIds.add(entry.id);
      }
    }
    this.#scheduleMaintenance(this.#nextMaintenanceIn(timers.redialMinMs));
  }

  /** Whether a candidate may be dialed now (DESIGN.md 15.22). */
  #dialable(entry) {
    if (this.#dials.has(entry.addr)) return false;
    if (entry.id !== null && this.#isPenalized(entry.id)) return false;
    const parsed = parseAddress(entry.addr);
    if (parsed === null) return false;
    const ip = ipKey(parsed.host);
    if (this.#ipBusy.has(ip)) return false;
    const backoff = this.#ipBackoff.get(ip);
    if (backoff !== undefined && backoff.until > performance.now()) return false;
    const isStatic = entry.sources.includes(AddressSource.MANUAL) || entry.sources.includes(AddressSource.BOOTSTRAP);
    if (!isStatic && !this.#config.discovery.allowLoopback && isIpLiteral(parsed.host) && isRestrictedIp(parsed.host)) {
      return false;
    }
    return true;
  }

  #canStartDial(addr) {
    if (this.#dials.size >= this.#maxDials) return false;
    const parsed = parseAddress(addr);
    if (parsed === null || this.#ipBusy.has(ipKey(parsed.host))) return false;
    if (!this.#dialTokens.has(1)) return false;
    this.#dialTokens.take(1);
    return true;
  }

  #nextMaintenanceIn(cap) {
    const now = this.#now();
    let next = cap;
    for (const entry of this.#book.entries()) {
      if (entry.nextAttemptAt > now) next = Math.min(next, entry.nextAttemptAt - now);
    }
    const mono = performance.now();
    for (const { until } of this.#ipBackoff.values()) {
      if (until > mono) next = Math.min(next, until - mono);
    }
    return Math.max(1, Math.ceil(next));
  }

  #safePrefer(id) {
    try {
      return this.#preferPeer(id) === true;
    } catch (err) {
      this.#internalError('preferPeer', err);
      return false;
    }
  }

  // ------------------------------------------------------------------ links

  /** @returns {object | null} the link now active for that node, or null when stopping */
  #adopt(channel, { direction, addr, dialedAddr, startedAt }) {
    if (this.#state !== 'running') {
      channel.close('shutdown');
      return null;
    }
    const id = channel.remoteId;
    const payload = channel.remotePayload;
    const control = this.#config.limits;
    const link = {
      id,
      linkId: String(++this.#linkCounter),
      channel,
      direction,
      addr,
      dialedAddr,
      startedAt,
      since: this.#now(),
      sinceMono: performance.now(),
      metric: new LinkMetric(),
      lastRttMs: null,
      ping: null,
      keepaliveTimer: null,
      throttleTimer: null,
      throttled: false,
      // When our own throttle last let go: silence before it was ours, not the peer's.
      resumedAt: 0,
      lastThrottleEventAt: -Infinity,
      ctrlPackets: new Bucket(control.peerPacketsPerSec, control.peerPacketsPerSec),
      ctrlBytes: new Bucket(control.peerBytesPerSec, Math.max(control.peerBytesPerSec, 2 * Limits.MAX_PACKET)),
      dataPackets: new Bucket(control.dataPacketsPerSec, control.dataPacketsPerSec),
      dataBytes: new Bucket(control.dataBytesPerSec, Math.max(control.dataBytesPerSec, Limits.MAX_ROUTED_PACKET)),
      packetsIn: 0,
      packetsOut: 0,
      dataDropped: 0,
      active: false,
      noRedial: false,
      stable: false,
      penalized: false,
    };
    this.#allLinks.add(link);
    this.#stats.linksOpened += 1;
    channel.onPacket = (packet, size) => this.#onChannelPacket(link, packet, size);
    channel.onClose = info => this.#onLinkClosed(link, info);

    let replacement = false;
    const existing = this.#links.get(id);
    if (existing !== undefined) {
      const verdict = this.#duplicateVerdict(existing, link);
      this.#stats.duplicatesResolved += 1;
      if (!verdict.keepNew) {
        channel.close(verdict.reason);
        return existing;
      }
      existing.active = false;
      existing.channel.close(verdict.reason);
      replacement = true;
    }
    const handover = this.#handover.get(id);
    if (handover !== undefined) {
      this.#cancel(handover.timer);
      this.#handover.delete(id);
      replacement = true;
    }
    link.active = true;
    this.#links.set(id, link);
    try {
      link.metric.sample(channel.handshakeRttMs);
    } catch {
      // A clock anomaly leaves the link unmeasured; keepalives will measure it.
    }
    if (dialedAddr !== null) this.#book.markReached(dialedAddr, id);
    this.#book.setAddressesFor(id, payload.listen, AddressSource.HANDSHAKE);
    this.#noteObserved(payload.observed);
    channel.start();
    this.#armKeepalive(link, Math.floor(this.#rng() * this.#config.timers.keepaliveMs));

    const info = this.#info(link);
    if (!replacement) {
      this.#callback('onLinkUp', () => this.#onLinkUp(info));
      this.#emit('link.up', {
        peer: id, linkId: link.linkId, direction, addr, agent: payload.agent, caps: payload.caps,
        rttMs: link.metric.srtt, cost: link.metric.cost,
      });
    }
    const waiters = this.#linkWaiters.get(id);
    if (waiters !== undefined) for (const wake of [...waiters]) wake();
    return link;
  }

  #noteObserved(ip) {
    if (typeof ip !== 'string') return;
    const before = this.#observed.join(',');
    this.#observed = [ip, ...this.#observed.filter(x => x !== ip)].slice(0, 4);
    if (this.#observed.join(',') !== before) this.#callback('onObserved', () => this.#onObserved());
  }

  #onLinkClosed(link, { reason, remote }) {
    this.#cancel(link.keepaliveTimer);
    this.#cancel(link.throttleTimer);
    this.#allLinks.delete(link);
    this.#stats.linksClosed += 1;
    if (!remote && reason === 'protocol' && !link.penalized) {
      link.penalized = true;
      this.#addPenalty(link.id);
    }
    if (!link.active) return;
    link.active = false;
    this.#links.delete(link.id);
    const info = { reason, remote };
    if (remote && (reason === 'duplicate' || reason === 'replaced') && this.#state === 'running') {
      // The peer kept another link to us that may still be finishing its handshake here:
      // wait for it before reporting the node as gone.
      const timer = this.#later(() => {
        this.#handover.delete(link.id);
        this.#finalizeDown(link, info);
      }, this.#config.timers.handshakeTimeoutMs, 'handover');
      this.#handover.set(link.id, { link, info, timer });
      return;
    }
    this.#finalizeDown(link, info);
  }

  #finalizeDown(link, { reason, remote }) {
    const durationMs = Math.max(0, Math.round(performance.now() - link.sinceMono));
    const peerInfo = this.#info(link);
    this.#emit('link.down', { peer: link.id, linkId: link.linkId, reason, remote, durationMs });
    this.#callback('onLinkDown', () => this.#onLinkDown(peerInfo, { reason, remote }));
    if (this.#state !== 'running' || link.noRedial) return;
    if (link.dialedAddr !== null && this.#book.get(link.dialedAddr) !== null) {
      if (durationMs >= this.#config.timers.peerTimeoutMs) this.#book.markSuccess(link.dialedAddr, link.id);
      const fails = this.#book.markFailure(link.dialedAddr, reason);
      if (fails > 0) this.#book.defer(link.dialedAddr, this.#now() + this.#backoff(fails));
    }
    this.#scheduleMaintenance(0);
  }

  // ------------------------------------------------------------------ keepalive

  #armKeepalive(link, ms) {
    link.keepaliveTimer = this.#later(() => this.#keepalive(link), ms, 'keepalive');
  }

  #keepalive(link) {
    if (!link.active || link.channel.closed) return;
    const { keepaliveMs, peerTimeoutMs } = this.#config.timers;
    const now = performance.now();
    // While we throttle a link we do not read it, so its silence and its unanswered PING
    // are ours, not the peer's: rate limits never disconnect (DESIGN.md 15.8). Our own
    // PINGs keep going out, which is what tells the peer that we are alive.
    const throttled = link.throttled;
    if (!throttled && now - Math.max(link.channel.lastRecordAt, link.resumedAt) >= peerTimeoutMs) {
      link.channel.close('timeout');
      return;
    }
    if (!link.stable && now - link.sinceMono >= peerTimeoutMs && link.dialedAddr !== null) {
      // The link has proved stable: its address starts the next backoff from scratch.
      link.stable = true;
      this.#book.markSuccess(link.dialedAddr, link.id);
    }
    if (link.ping !== null && !throttled) {
      link.metric.miss();
      link.ping = null;
      this.#reportMetric(link, null);
    }
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    if (link.channel.send({ type: PacketType.PING, header: { n: nonce } }, { priority: SendPriority.CONTROL })) {
      link.ping = { nonce, sentAt: now };
    }
    this.#armKeepalive(link, keepaliveMs);
  }

  #reportMetric(link, rttMs) {
    const { metric } = link;
    this.#emit('link.metric', { peer: link.id, rttMs, srttMs: metric.srtt, cost: metric.cost, misses: metric.misses });
    let advertised = null;
    try {
      advertised = this.#advertisedCost(link.id);
      if (metric.shouldAdvertise(advertised)) {
        this.#callback('onLinkCost', () => this.#onLinkCost(link.id, metric.cost));
      }
    } catch (err) {
      this.#internalError('advertisedCost', err);
    }
  }

  // ------------------------------------------------------------------ receiving

  #onChannelPacket(link, packet, size) {
    link.packetsIn += 1;
    this.#stats.packetsIn += 1;
    if (isRoutedType(packet.type)) {
      // DESIGN.md 15.8: a separate budget; over it the packet is dropped, never the link.
      if (!link.dataPackets.has(1) || !link.dataBytes.has(size)) {
        link.dataDropped += 1;
        this.#stats.dataDropped += 1;
        return;
      }
      link.dataPackets.take(1);
      link.dataBytes.take(size);
    } else {
      const packets = link.ctrlPackets.charge(1);
      const bytes = link.ctrlBytes.charge(size);
      if (packets < 0 || bytes < 0) this.#throttle(link, packets < 0 ? 'packets' : 'bytes');
    }
    if (packet.type === PacketType.PING) {
      if (!validatePingHeader(packet.header).ok || packet.body.length !== 0) {
        this.#penalizeLink(link, 'malformed PING');
        return;
      }
      link.channel.send({ type: PacketType.PONG, header: { n: packet.header.n } }, { priority: SendPriority.CONTROL });
      return;
    }
    if (packet.type === PacketType.PONG) {
      if (!validatePingHeader(packet.header).ok || packet.body.length !== 0) {
        this.#penalizeLink(link, 'malformed PONG');
        return;
      }
      if (link.ping !== null && link.ping.nonce === packet.header.n) {
        const rtt = performance.now() - link.ping.sentAt;
        link.ping = null;
        link.metric.sample(rtt);
        link.lastRttMs = rtt;
        this.#reportMetric(link, rtt);
      }
      return;
    }
    try {
      this.#onPacket(link.id, packet);
    } catch (err) {
      if (err instanceof ClawNetError && PROTOCOL_CODES.has(err.code)) {
        this.#penalizeLink(link, err.message);
      } else {
        this.#internalError('onPacket', err);
      }
    }
  }

  /** Penalize the node behind the link a violation arrived on, and close that link. */
  #penalizeLink(link, why) {
    if (link.penalized) return;
    link.penalized = true;
    this.#addPenalty(link.id);
    this.#log?.warn('peer penalized', { peer: link.id, why: String(why).slice(0, 200) });
    link.channel.close('protocol');
  }

  #throttle(link, by) {
    if (link.throttled) return;
    link.throttled = true;
    link.channel.pauseReading();
    this.#stats.throttleEvents += 1;
    const now = performance.now();
    if (now - link.lastThrottleEventAt >= THROTTLE_EVENT_INTERVAL_MS) {
      link.lastThrottleEventAt = now;
      this.#emit('link.throttled', { peer: link.id, by });
    }
    const resume = () => {
      const wait = Math.max(link.ctrlPackets.msUntilNonNegative(), link.ctrlBytes.msUntilNonNegative());
      if (wait > 0) {
        link.throttleTimer = this.#later(resume, wait, 'throttle');
        return;
      }
      link.throttled = false;
      link.resumedAt = performance.now();
      link.channel.resumeReading();
    };
    link.throttleTimer = this.#later(resume, Math.max(1, Math.max(
      link.ctrlPackets.msUntilNonNegative(), link.ctrlBytes.msUntilNonNegative(),
    )), 'throttle');
  }

  // ------------------------------------------------------------------ helpers

  #info(link) {
    const s = link.channel.stats();
    const payload = link.channel.remotePayload;
    const idleMs = performance.now() - link.channel.lastRecordAt;
    return {
      id: link.id,
      linkId: link.linkId,
      direction: link.direction,
      addr: link.addr,
      agent: payload.agent,
      caps: { ...payload.caps },
      listen: [...payload.listen],
      since: link.since,
      rttMs: link.lastRttMs,
      srttMs: link.metric.srtt,
      cost: link.metric.cost,
      misses: link.metric.misses,
      lastRxAt: Math.round(this.#now() - idleMs),
      packetsIn: link.packetsIn,
      packetsOut: link.packetsOut,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      queuedBytes: s.queuedBytes,
      throttled: link.throttled,
      sticky: link.dialedAddr !== null && (this.#book.get(link.dialedAddr)?.sources.includes(AddressSource.MANUAL) ?? false),
      dataDropped: link.dataDropped,
      rekeysIn: s.rekeysIn,
      rekeysOut: s.rekeysOut,
    };
  }

  /** setTimeout that is cancelled at stop() and reports exceptions instead of throwing. */
  #later(fn, ms, where) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      try {
        fn();
      } catch (err) {
        this.#internalError(where, err);
      }
    }, ms);
    this.#timers.add(timer);
    return timer;
  }

  #cancel(timer) {
    if (timer === null || timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(timer);
  }

  #callback(where, fn) {
    try {
      fn();
    } catch (err) {
      this.#internalError(where, err);
    }
  }

  #emit(type, data) {
    try {
      this.#events.emit(type, data);
    } catch (err) {
      this.#log?.error('event not emitted', { type, message: err?.message });
    }
  }

  #internalError(where, err) {
    this.#log?.error('internal error', { where, message: err?.message });
    this.#emit('internal.error', {
      where: `peer-manager.${where}`,
      code: typeof err?.code === 'string' ? err.code : null,
      message: String(err?.message ?? err).slice(0, 500),
    });
  }
}

/** Key for per-IP dial budgets: the normalized IP, or the lower-cased DNS name. */
function ipKey(host) {
  return isIpLiteral(host) ? normalizeIp(host) : `dns:${host.toLowerCase()}`;
}

function socketAddress(ip, port) {
  try {
    return formatAddress(ip, port);
  } catch {
    return 'tcp://0.0.0.0:1';
  }
}
