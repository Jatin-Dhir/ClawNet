/**
 * LAN discovery by multicast beacons (DESIGN.md section 8, item 1, and section 15,
 * item 23).
 *
 * Every `intervalMs` the node sends a signed beacon (bytes in `beacon.js`) to the
 * multicast group; every beacon received from another node on the same network becomes a
 * dial candidate at the datagram's source address and the beacon's port.
 *
 * What a datagram has to get through, in this order, each step cheaper than the next:
 *
 *   1. size, at most BEACON_MAX_BYTES;
 *   2. the rate limits, per source address and overall (`limits.beaconsPerSourcePerMin`,
 *      `limits.beaconsPerMin`), before the datagram is even parsed;
 *   3. canonical form and shape;
 *   4. the network id, our own origin, the clock-skew window, and "already connected or
 *      in backoff" (`isKnown`): such beacons are ignored;
 *   5. the address policy for the source address (loopback, link-local and so on are
 *      refused unless `discovery.allowLoopback` is set);
 *   6. cryptography: the MAC when the network has a key, then the beacon signature, then
 *      the identity card.
 *
 * The module opens no TCP connection. A beacon that passes becomes a *candidate*
 * `{ id, addr, card, source: "multicast" }`: it is handed to `onCandidate` (the node uses
 * it to remember the card), announced as a `discovery.candidate` event the first time,
 * and passed to `dial(addr, { id, source: "multicast" })` through the shared
 * `DialGovernor`, which applies the per-IP and global dial budgets.
 *
 * The socket is the only I/O here. It is created by `createSocket`, which defaults to a
 * `dgram` UDP4 socket with `reuseAddr`; tests pass a fake with the subset of the
 * `dgram.Socket` interface used below (`on`, `once`, `bind`, `address`, `addMembership`,
 * `setMulticastTTL`, `setMulticastLoopback`, `setMulticastInterface`, `send`, `close`).
 * A socket error (no multicast route, permission, a failed send) is counted, reported
 * once as `discovery.error` and disables multicast for the rest of the process; it never
 * fails the node.
 *
 * Platform note: the socket binds to `iface` when it is set and to the wildcard address
 * otherwise, as `discovery.multicast.interface` says. Linux delivers group-addressed
 * datagrams only to sockets bound to the wildcard or the group address, so on Linux leave
 * `interface` unset. This was only exercised on Windows loopback.
 */

import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';

import { deriveBeaconKey } from '../crypto/envelope.js';
import { ConfigError } from '../errors.js';
import { formatAddress } from '../wire/schema.js';
import { checkLearnedAddress } from './address-policy.js';
import { BEACON_MAX_BYTES, authenticateBeacon, encodeBeacon, parseBeacon } from './beacon.js';
import { BoundedSet, KeyedTokenBuckets, TokenBucket } from './rate-limit.js';

export { BEACON_MAX_BYTES };

/** Sources the per-source limiter tracks at once. */
export const MAX_BEACON_SOURCES = 4096;

/** Candidates remembered so that a beacon repeated every few seconds is announced once. */
const SEEN_CANDIDATES = 1024;

/** Spread of the beacon interval, a fraction either side, so that nodes drift apart. */
const INTERVAL_JITTER = 0.1;

/** Reasons a datagram is dropped, each a counter in `stats()`. */
const DROP_COUNTERS = Object.freeze({
  oversize: 'dropOversize',
  'not-canonical': 'dropNotCanonical',
  'bad-shape': 'dropBadShape',
  'wrong-network': 'dropWrongNetwork',
  own: 'dropOwn',
  stale: 'dropStale',
  known: 'dropKnown',
  address: 'dropAddress',
  'no-mac': 'dropNoMac',
  'unexpected-mac': 'dropUnexpectedMac',
  'bad-mac': 'dropBadMac',
  'bad-signature': 'dropBadSignature',
  'bad-card': 'dropBadCard',
});

/**
 * @typedef {object} Candidate
 * @property {string} id      NodeId that sent the beacon
 * @property {string} addr    `tcp://<source ip>:<beacon port>`
 * @property {object} card    the sender's identity card, verified
 * @property {"multicast"} source
 */

export class MulticastDiscovery {
  #identity;
  #networkId;
  #beaconKey;
  #group;
  #configuredPort;
  #iface;
  #listenPort;
  #intervalMs;
  #maxClockSkewMs;
  #allowLoopback;
  #isKnown;
  #dial;
  #governor;
  #onCandidate;
  #events;
  #now;
  #monoNow;
  #rng;
  #createSocket;
  #schedule;
  #log;
  #perSource;
  #overall;
  #seen = new BoundedSet(SEEN_CANDIDATES);
  #socket = null;
  #boundPort = null;
  #cancelTimer = null;
  #state = 'new';
  #stats = {
    datagramsIn: 0,
    rateLimitedSource: 0,
    rateLimitedGlobal: 0,
    rateTableFull: 0,
    dropMalformed: 0,
    dropOversize: 0,
    dropNotCanonical: 0,
    dropBadShape: 0,
    dropWrongNetwork: 0,
    dropOwn: 0,
    dropStale: 0,
    dropKnown: 0,
    dropAddress: 0,
    dropNoMac: 0,
    dropUnexpectedMac: 0,
    dropBadMac: 0,
    dropBadSignature: 0,
    dropBadCard: 0,
    candidates: 0,
    dialsStarted: 0,
    dialsDenied: 0,
    dialsOk: 0,
    dialsFailed: 0,
    beaconsSent: 0,
    socketErrors: 0,
    disabled: 0,
  };

  /**
   * @param {object} options
   * @param {import('../crypto/identity.js').Identity} options.identity this node
   * @param {string} options.networkId        `config.networkId`
   * @param {Uint8Array | null} [options.networkKey] the 32-byte network key, or null for
   *   an open network; beacons then carry and require a MAC
   * @param {string} options.group            IPv4 multicast group (`discovery.multicast.group`)
   * @param {number} options.port             UDP port; 0 lets the OS choose (tests)
   * @param {string | null} [options.iface]   local IPv4 address to bind and send from, or
   *   null for the wildcard address and the OS's choice of interface
   * @param {() => (number | null)} options.listenPort the TCP port peers should dial;
   *   null while the node is not listening, when no beacon is sent
   * @param {number} options.intervalMs       `timers.beaconIntervalMs`
   * @param {number} options.maxClockSkewMs   `limits.maxClockSkewMs`
   * @param {number} options.beaconsPerSourcePerMin `limits.beaconsPerSourcePerMin`
   * @param {number} options.beaconsPerMin    `limits.beaconsPerMin`
   * @param {boolean} [options.allowLoopback=false] `discovery.allowLoopback`
   * @param {(id: string) => boolean} options.isKnown the peer manager's answer to "is this
   *   node linked, being dialed or in dial backoff?"; such beacons are ignored. An
   *   exception counts as true.
   * @param {(address: string, hint: object) => unknown} options.dial the peer manager's
   *   dial function (see `dial-governor.js`)
   * @param {import('./dial-governor.js').DialGovernor} options.governor shared dial budget
   * @param {(candidate: Candidate) => void} [options.onCandidate] called for every
   *   authenticated beacon, before the dial; must not throw (an exception is logged)
   * @param {{ emit: (type: string, data?: unknown) => unknown }} [options.events]
   * @param {() => number} [options.now] wall clock, milliseconds; default `Date.now`
   * @param {() => number} [options.monoNow] monotonic clock for rate limits; default
   *   `performance.now`
   * @param {() => number} [options.rng] uniform in [0, 1); default `Math.random`
   * @param {() => object} [options.createSocket] default: a `dgram` udp4 socket
   * @param {(fn: () => void, ms: number) => (() => void)} [options.schedule] one-shot
   *   timer returning a cancel function; default `setTimeout`, unreferenced
   * @param {object} [options.log] `{ debug, info, warn, error }(msg, fields)`
   * @param {number} [options.maxSources] most source addresses tracked by the rate limiter
   * @throws {ConfigError} if an option is missing or out of range
   */
  constructor({
    identity,
    networkId,
    networkKey = null,
    group,
    port,
    iface = null,
    listenPort,
    intervalMs,
    maxClockSkewMs,
    beaconsPerSourcePerMin,
    beaconsPerMin,
    allowLoopback = false,
    isKnown,
    dial,
    governor,
    onCandidate,
    events,
    now = Date.now,
    monoNow = () => performance.now(),
    rng = Math.random,
    createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
    schedule = defaultSchedule,
    log,
    maxSources = MAX_BEACON_SOURCES,
  } = {}) {
    if (identity === null || typeof identity !== 'object' || typeof identity.signRecord !== 'function') {
      throw new ConfigError('multicast: identity is required');
    }
    if (typeof networkId !== 'string' || networkId === '') throw new ConfigError('multicast: networkId is required');
    if (typeof group !== 'string' || group === '') throw new ConfigError('multicast: group is required');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('multicast: port must be 0..65535');
    if (iface !== null && typeof iface !== 'string') throw new ConfigError('multicast: iface must be a string or null');
    for (const [label, fn] of [
      ['listenPort', listenPort], ['isKnown', isKnown], ['dial', dial], ['now', now],
      ['monoNow', monoNow], ['rng', rng], ['createSocket', createSocket], ['schedule', schedule],
    ]) {
      if (typeof fn !== 'function') throw new ConfigError(`multicast: ${label} must be a function`);
    }
    if (governor === null || typeof governor !== 'object' || typeof governor.attempt !== 'function') {
      throw new ConfigError('multicast: governor is required');
    }
    for (const [label, value] of [
      ['intervalMs', intervalMs], ['maxClockSkewMs', maxClockSkewMs],
      ['beaconsPerSourcePerMin', beaconsPerSourcePerMin], ['beaconsPerMin', beaconsPerMin],
    ]) {
      if (!Number.isInteger(value) || value < 1) throw new ConfigError(`multicast: ${label} must be a positive integer`);
    }
    if (beaconsPerSourcePerMin > beaconsPerMin) {
      throw new ConfigError('multicast: beaconsPerSourcePerMin must not exceed beaconsPerMin');
    }
    this.#identity = identity;
    this.#networkId = networkId;
    // Derived once; throws CryptoError (a bad local value) if the key is not 32 bytes.
    this.#beaconKey = networkKey === null ? null : deriveBeaconKey(networkKey);
    this.#group = group;
    this.#configuredPort = port;
    this.#iface = iface;
    this.#listenPort = listenPort;
    this.#intervalMs = intervalMs;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#allowLoopback = allowLoopback === true;
    this.#isKnown = isKnown;
    this.#dial = dial;
    this.#governor = governor;
    this.#onCandidate = onCandidate;
    this.#events = events;
    this.#now = now;
    this.#monoNow = monoNow;
    this.#rng = rng;
    this.#createSocket = createSocket;
    this.#schedule = schedule;
    this.#log = log;
    this.#perSource = new KeyedTokenBuckets({
      capacity: beaconsPerSourcePerMin,
      perSecond: beaconsPerSourcePerMin / 60,
      maxKeys: maxSources,
    });
    this.#overall = new TokenBucket({ capacity: beaconsPerMin, perSecond: beaconsPerMin / 60 });
  }

  /** @returns {number | null} the UDP port the socket is bound to, once started */
  get port() {
    return this.#boundPort;
  }

  /**
   * Open the socket, join the group and start announcing.
   *
   * @returns {Promise<boolean>} true if multicast is running; false if the socket could
   *   not be set up, in which case multicast is disabled and `discovery.error` has been
   *   emitted. Never rejects because of the network.
   */
  async start() {
    if (this.#state !== 'new') return this.#state === 'running';
    this.#state = 'starting';
    let socket;
    try {
      socket = this.#createSocket();
      this.#socket = socket;
      // An 'error' with no listener would crash the process, so a handler is there for
      // the socket's whole life. While binding, the error rejects the promise below
      // instead, so one failure is not counted twice.
      socket.on('error', err => {
        if (this.#state !== 'starting') this.#fail(err);
      });
      socket.on('message', (message, rinfo) => this.#onDatagram(message, rinfo));
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        const done = () => {
          socket.removeListener?.('error', reject);
          resolve();
        };
        const address = this.#iface ?? undefined;
        socket.bind({ port: this.#configuredPort, address, exclusive: false }, done);
      });
      this.#boundPort = socket.address().port;
      socket.setMulticastTTL(1);
      socket.setMulticastLoopback(true);
      if (this.#iface !== null) socket.setMulticastInterface(this.#iface);
      socket.addMembership(this.#group, this.#iface ?? undefined);
    } catch (err) {
      this.#fail(err);
      return false;
    }
    if (this.#state !== 'starting') return false;
    this.#state = 'running';
    this.announce();
    this.#arm();
    return this.#state === 'running';
  }

  /**
   * Stop announcing and close the socket. Safe to call in any state and more than once.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    const wasRunning = this.#state !== 'stopped';
    this.#state = 'stopped';
    this.#disarm();
    const socket = this.#socket;
    this.#socket = null;
    if (!wasRunning || socket === null) return;
    await new Promise(resolve => {
      try {
        socket.close(resolve);
      } catch {
        // Already closed.
        resolve();
      }
    });
  }

  /**
   * Send one beacon now, in addition to the periodic ones. The node may call it when its
   * listen port or network changes.
   *
   * @returns {boolean} whether a beacon was handed to the socket
   */
  announce() {
    if (this.#state !== 'running' || this.#socket === null) return false;
    const tcpPort = this.#listenPort();
    if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) return false;
    let bytes;
    try {
      bytes = encodeBeacon({
        identity: this.#identity,
        networkId: this.#networkId,
        port: tcpPort,
        ts: this.#now(),
        beaconKey: this.#beaconKey,
      });
      this.#socket.send(bytes, this.#boundPort, this.#group, err => {
        if (err) this.#fail(err);
      });
    } catch (err) {
      this.#fail(err);
      return false;
    }
    this.#stats.beaconsSent += 1;
    return true;
  }

  /** @returns {object} counters, all non-negative integers */
  stats() {
    return { ...this.#stats };
  }

  #arm() {
    if (this.#state !== 'running') return;
    const spread = 1 + INTERVAL_JITTER * (2 * this.#rng() - 1);
    const delay = Math.max(1, Math.round(this.#intervalMs * spread));
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = null;
      this.announce();
      this.#arm();
    }, delay);
  }

  #disarm() {
    const cancel = this.#cancelTimer;
    this.#cancelTimer = null;
    if (typeof cancel === 'function') cancel();
  }

  /** Disable multicast after a socket error: counted, reported once, never thrown. */
  #fail(err) {
    this.#stats.socketErrors += 1;
    if (this.#state === 'stopped' || this.#state === 'failed') return;
    this.#state = 'failed';
    this.#stats.disabled = 1;
    this.#disarm();
    const socket = this.#socket;
    this.#socket = null;
    const message = typeof err?.message === 'string' ? err.message.slice(0, 200) : 'socket error';
    this.#log?.warn?.('multicast discovery disabled', { error: message, code: err?.code });
    this.#events?.emit('discovery.error', { source: 'multicast', message });
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Not open: nothing to release.
      }
    }
  }

  #drop(reason) {
    this.#stats[DROP_COUNTERS[reason]] += 1;
  }

  #onDatagram(message, rinfo) {
    this.#stats.datagramsIn += 1;
    if (this.#state !== 'running') return;
    if (!(message instanceof Uint8Array) || typeof rinfo?.address !== 'string') {
      this.#stats.dropMalformed += 1;
      return;
    }
    if (message.length > BEACON_MAX_BYTES) return this.#drop('oversize');

    // Before anything is parsed, let alone verified.
    const now = this.#monoNow();
    const source = this.#perSource.take(rinfo.address, now);
    if (source === 'limited') {
      this.#stats.rateLimitedSource += 1;
      return;
    }
    if (source === 'table-full') {
      this.#stats.rateTableFull += 1;
      return;
    }
    if (!this.#overall.take(now)) {
      this.#stats.rateLimitedGlobal += 1;
      return;
    }

    const parsed = parseBeacon(message);
    if (!parsed.ok) return this.#drop(parsed.reason);
    const beacon = parsed.beacon;
    if (beacon.net !== this.#networkId) return this.#drop('wrong-network');
    if (beacon.origin === this.#identity.nodeId) return this.#drop('own');
    if (Math.abs(beacon.ts - this.#now()) > this.#maxClockSkewMs) return this.#drop('stale');
    if (this.#knows(beacon.origin)) return this.#drop('known');

    let addr;
    try {
      addr = formatAddress(rinfo.address, beacon.port);
    } catch {
      return this.#drop('address');
    }
    if (!checkLearnedAddress(addr, { allowLoopback: this.#allowLoopback }).ok) {
      return this.#drop('address');
    }

    const verdict = authenticateBeacon(beacon, this.#beaconKey);
    if (!verdict.ok) return this.#drop(verdict.reason);

    this.#candidate({ id: beacon.origin, addr, card: beacon.card, source: 'multicast' });
  }

  #knows(id) {
    try {
      return this.#isKnown(id) === true;
    } catch (err) {
      this.#log?.warn?.('isKnown threw', { error: String(err?.message).slice(0, 200) });
      return true;
    }
  }

  #candidate(candidate) {
    this.#stats.candidates += 1;
    try {
      this.#onCandidate?.(candidate);
    } catch (err) {
      this.#log?.warn?.('onCandidate threw', { error: String(err?.message).slice(0, 200) });
    }
    if (this.#seen.add(`${candidate.addr} ${candidate.id}`)) {
      this.#events?.emit('discovery.candidate', {
        addr: candidate.addr,
        peer: candidate.id,
        source: candidate.source,
      });
    }
    const result = this.#governor.attempt(
      candidate.addr,
      { id: candidate.id, source: candidate.source },
      this.#dial,
    );
    if (!result.started) {
      this.#stats.dialsDenied += 1;
      return;
    }
    this.#stats.dialsStarted += 1;
    result.done.then(outcome => {
      this.#stats[outcome.ok ? 'dialsOk' : 'dialsFailed'] += 1;
    });
  }
}

/** One-shot timer that does not keep the process alive. */
function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
