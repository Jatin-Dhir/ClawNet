/**
 * The ClawNet node runtime (ARCHITECTURE.md 5.9, 6 and 7, with DESIGN.md section 15).
 *
 * `ClawNode` builds every module of layers 1 to 4, connects them with plain functions,
 * owns every timer, runs the service lifecycle and exposes the public API that the
 * control API, the CLI and the tests use.
 *
 * Three classes live here:
 *
 *   - `TimerSet`  the node's timers: every scheduled callback goes through it, so an
 *     exception in one is reported instead of crashing the process, and `stop()` cancels
 *     everything at once.
 *   - `Router`    the routing control plane: the link-state database kept in step with
 *     ClawSync's `lsa` dataset, this node's own LSA, shortest paths and the topology view.
 *     ARCHITECTURE.md placed it in `core/routing/forwarder.js`; it is here because that
 *     file belongs to another engineer and was delivered without it. It has no socket or
 *     timer of its own: clocks and `schedule` are injected, like every routing module.
 *   - `ClawNode`  the wiring, the lifecycle and the public API.
 *
 * Nothing in this file implements a wire protocol. Packets are parsed, checked and
 * answered by the modules below; the node only decides who is told about what.
 */

import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { checkNetworkId, formatNetworkIdFile, validateConfig } from './config.js';
import { Identity, shortId, verifyCard, verifyRecord } from './crypto/identity.js';
import { base64Decode, base64Encode, randomBytes } from './crypto/primitives.js';
import {
  BootstrapDiscovery,
  DialGovernor,
  MulticastDiscovery,
  PEER_DATASET,
  PeerExchange,
} from './discovery/index.js';
import { ClawNetError, ConfigError, ProtocolError, StateError, StoreError } from './errors.js';
import { EventBus } from './events.js';
import { ReliableMessenger } from './messaging/reliable.js';
import { AddressBook } from './peer/address-book.js';
import { DEFAULT_AGENT, PeerManager } from './peer/peer-manager.js';
import { Forwarder } from './routing/forwarder.js';
import { Lsdb } from './routing/lsdb.js';
import { MAX_LINK_COST } from './routing/metric.js';
import { computeRoutes } from './routing/spf.js';
import { NodeStorage } from './storage.js';
import { canonicalBytes } from './wire/canonical.js';
import { formatAddress, isNodeId, validateCast, validateLsa, validateReceipt } from './wire/schema.js';
import { Limits, PacketType, RecordType } from './wire/types.js';
import { DEFAULT_SYNC_LIMITS, SyncEngine } from '../sync/antientropy.js';
import { LogDataset, LwwDataset } from '../sync/datasets.js';
import { Keystore } from '../vault/keystore.js';
import { atomicCreateFile, atomicWriteFile, ensurePrivateDir } from '../vault/store.js';

/** The whole stop sequence must finish within this time; then sockets and timers are destroyed. */
export const STOP_TIMEOUT_MS = 5000;

/** Interval of the `traffic.sample` event. */
export const TRAFFIC_SAMPLE_MS = 500;

/** Capacity of the node's event ring buffer (ARCHITECTURE.md section 9). */
export const EVENT_BUS_CAPACITY = 5000;

/** Shape of a service name (ARCHITECTURE.md section 6). */
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Name of the LSA dataset (ARCHITECTURE.md 4.5). */
export const LSA_DATASET = 'lsa';

/** Datasets that a service may register; the node creates relay-only ones otherwise. */
export const SERVICE_DATASETS = Object.freeze(['cast', 'receipt']);

/** Most items listed in one event; longer lists are cut and flagged `truncated`. */
export const EVENT_LIST_MAX = 500;

/** Retention of the relay-only datasets (ARCHITECTURE.md 4.5). */
const CAST_PER_STREAM = 64;
const CAST_STREAMS = 1024;
const RECEIPT_ENTRIES = 20000;

/** Selectors of routed packets open to services (ARCHITECTURE.md section 6). */
const SERVICE_SELECTORS = Object.freeze(['data.transfer', 'probe', 'probe.expired']);

/** Kinds no service may register: the messenger and the node own them. */
const RESERVED_KINDS = Object.freeze(['ack', 'msg']);

const API_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);
const API_PATH_PATTERN = /^(?:\/(?:[a-z0-9][a-z0-9._-]{0,63}|:[a-zA-Z][a-zA-Z0-9]{0,31})){1,16}$/;
const API_CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;

const KEYSTORE_FILE = 'keystore.json';
const LOCK_FILE = 'lock';
const RUNTIME_FILE = 'runtime.json';
const SECRET_BYTES = 96;
const KEY_BYTES = 32;
const MAX_LOCK_BYTES = 64;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_ERROR_TEXT = 256;
const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const NOOP = () => {};

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new ConfigError(`${name} must be a function`);
}

function clampDelay(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.ceil(ms), MAX_TIMER_MS);
}

/** Error text for events and logs: short, single-line, never a stack. */
function errorText(error) {
  const text = typeof error?.message === 'string' ? error.message : String(error);
  return text.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_TEXT);
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : null;
}

/** Cut a list for an event (ARCHITECTURE.md section 9). */
function capList(list) {
  return list.length > EVENT_LIST_MAX ? { items: list.slice(0, EVENT_LIST_MAX), truncated: true } : { items: list, truncated: false };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

function capsOf(value) {
  if (value === null || typeof value !== 'object') return null;
  return { relay: value.relay === true, mailbox: value.mailbox === true, transit: value.transit === true };
}

function clampCost(cost) {
  if (!Number.isFinite(cost)) return MAX_LINK_COST;
  return Math.min(MAX_LINK_COST, Math.max(1, Math.ceil(cost)));
}

/**
 * The default logger: one JSON object per line on stderr (ARCHITECTURE.md section 1).
 *
 * @param {object} [options]
 * @param {'debug' | 'info' | 'warn' | 'error'} [options.level] least severe level written
 * @param {(line: string) => void} [options.write] where lines go; default stderr
 * @param {() => number} [options.now] clock for `ts`
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger({ level = 'info', write = (line) => process.stderr.write(line), now = Date.now } = {}) {
  if (!Object.hasOwn(LOG_LEVELS, level)) throw new ConfigError('level must be debug, info, warn or error');
  requireFunction(write, 'write');
  const threshold = LOG_LEVELS[level];
  const at = (name) => (msg, fields) => {
    if (LOG_LEVELS[name] < threshold) return;
    let line;
    try {
      line = JSON.stringify({ ts: now(), level: name, msg: String(msg), ...(fields ?? {}) });
    } catch {
      line = JSON.stringify({ ts: now(), level: name, msg: String(msg), fields: 'unserializable' });
    }
    write(`${line}\n`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Bind a logger to a module name. */
function bindLog(base, mod) {
  const at = (name) => (msg, fields) => {
    try {
      base[name]?.(msg, { mod, ...(fields ?? {}) });
    } catch {
      // A broken logger must not break the node.
    }
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

// ---------------------------------------------------------------------------------------
// TimerSet
// ---------------------------------------------------------------------------------------

/**
 * Every timer of a node. Callbacks that throw (or return a rejected promise) are reported
 * through `onError` instead of escaping, and `cancelAll()` stops everything for good.
 */
export class TimerSet {
  #onError;
  #handles = new Map();
  #closed = false;
  #nextId = 0;

  /**
   * @param {object} [options]
   * @param {(error: unknown, label: string) => void} [options.onError] told about a
   *   callback that threw
   * @throws {ConfigError} if onError is not a function
   */
  constructor({ onError } = {}) {
    if (onError !== undefined) requireFunction(onError, 'onError');
    this.#onError = onError ?? null;
  }

  /**
   * Run `fn` once after `ms` milliseconds.
   *
   * @param {() => unknown} fn
   * @param {number} ms clamped to 0 .. 2^31-1
   * @param {string} [label] names the timer in error reports
   * @returns {() => void} idempotent cancel; a no-op once cancelAll() has run
   * @throws {ConfigError} if fn is not a function
   */
  schedule(fn, ms, label = 'timer') {
    requireFunction(fn, 'fn');
    if (this.#closed) return NOOP;
    const id = ++this.#nextId;
    const handle = setTimeout(() => {
      this.#handles.delete(id);
      this.#run(fn, label);
    }, clampDelay(ms));
    this.#handles.set(id, handle);
    return () => {
      const pending = this.#handles.get(id);
      if (pending !== undefined) {
        clearTimeout(pending);
        this.#handles.delete(id);
      }
    };
  }

  /**
   * Run `fn` every `ms` milliseconds. The next run is scheduled after `fn` returns (or the
   * promise it returns settles), so slow work never overlaps itself.
   *
   * @param {() => unknown} fn
   * @param {number} ms at least 1
   * @param {string} [label]
   * @returns {() => void} idempotent cancel
   * @throws {ConfigError} if fn is not a function
   */
  every(fn, ms, label = 'timer') {
    requireFunction(fn, 'fn');
    const interval = Math.max(1, clampDelay(ms));
    let cancelled = false;
    let cancelNext = NOOP;
    const arm = () => {
      if (!cancelled) cancelNext = this.schedule(tick, interval, label);
    };
    const tick = () => {
      if (cancelled) return;
      let result;
      try {
        result = fn();
      } catch (error) {
        this.#report(error, label);
      }
      if (result !== null && typeof result?.then === 'function') {
        result.then(arm, (error) => {
          this.#report(error, label);
          arm();
        });
      } else {
        arm();
      }
    };
    arm();
    return () => {
      cancelled = true;
      cancelNext();
    };
  }

  /** Cancel every timer and refuse new ones from now on. */
  cancelAll() {
    this.#closed = true;
    for (const handle of this.#handles.values()) clearTimeout(handle);
    this.#handles.clear();
  }

  /** @returns {number} timers currently pending */
  get size() {
    return this.#handles.size;
  }

  #run(fn, label) {
    try {
      const result = fn();
      if (result !== null && typeof result?.then === 'function') {
        result.then(undefined, (error) => this.#report(error, label));
      }
    } catch (error) {
      this.#report(error, label);
    }
  }

  #report(error, label) {
    try {
      this.#onError?.(error, label);
    } catch {
      // The error reporter itself failed; nothing sensible is left to do.
    }
  }
}

// ---------------------------------------------------------------------------------------
// Router: the routing control plane
// ---------------------------------------------------------------------------------------

/**
 * @typedef {object} RouteView
 * @property {string} dst
 * @property {string} nextHop
 * @property {number} cost
 * @property {number} hops
 * @property {string[]} path   this node first, `dst` last
 */

/**
 * Keeps the link-state database in step with ClawSync's `lsa` dataset, originates this
 * node's LSA and computes routes (ARCHITECTURE.md 5.6, DESIGN.md 15.14 to 15.19).
 *
 * The effective next hop of a destination is the computed route's next hop if that
 * neighbour is linked, else the destination itself if it is linked (which covers the
 * moments after a link comes up and before both LSAs confirm it), else none.
 */
export class Router {
  #self;
  #identity;
  #caps;
  #state;
  #seqDoc;
  #links;
  #isLinked;
  #linkCaps;
  #addrsOf;
  #events;
  #now;
  #monoNow;
  #schedule;
  #log;
  #refreshMs;
  #maxAgeMs;
  #maxClockSkewMs;
  #spfDebounceMs;
  #originIntervalMs;
  #sweepMs;
  #lsdb;
  #dataset;
  #publish = null;
  #verified = new WeakSet();

  #routes = new Map();
  #effective = new Set();
  #rev = 0;
  #listeners = new Set();
  #advertised = new Map();
  #received = new Map();
  #expired = new Set();
  #topoNodes = new Map();
  #topoLinks = new Map();

  #lastOriginatedAt = null;
  #ownSeq = 0;
  #pendingReason = null;
  #cancelPending = null;
  #cancelRefresh = null;
  #cancelSweep = null;
  #cancelSpf = null;
  #seqsDirty = false;
  #running = false;
  #stats = {
    lsaOriginated: 0,
    lsaAccepted: 0,
    lsaRefused: 0,
    lsaExpired: 0,
    lsaSuperseded: 0,
    lsaEquivocations: 0,
    spfRuns: 0,
  };

  /**
   * @param {object} options
   * @param {Identity} options.identity this node
   * @param {{ relay: boolean, mailbox: boolean, transit: boolean }} options.caps advertised
   * @param {{ data: object, update: Function, flush: Function }} options.state the loaded
   *   `state.json` document; this class keeps its `lsaSeq`
   * @param {{ data: object, update: Function, flush: Function }} [options.seqDoc] loaded
   *   document `{ v: 1, seqs }` holding Lsdb#exportSeqs(); without it nothing persists
   * @param {() => Array<{ peer: string, cost: number }>} options.links the live links
   * @param {(id: string) => boolean} options.isLinked
   * @param {(id: string) => object | null} [options.linkCaps] caps a linked peer stated
   *   in its handshake
   * @param {(id: string) => string[]} [options.addrsOf] addresses from the peer record
   * @param {{ emit: Function }} options.events
   * @param {() => number} [options.now] wall clock
   * @param {() => number} [options.monoNow] monotonic clock
   * @param {(fn: () => void, ms: number) => () => void} options.schedule
   * @param {object} [options.log]
   * @param {object} options.timers `{ lsaRefreshMs, lsaMaxAgeMs, lsaTombstoneMs,
   *   lsaMinIntervalMs, spfDebounceMs }`
   * @param {number} options.maxClockSkewMs
   * @param {number} [options.maxOrigins]
   * @param {(origin: string) => boolean} [options.allowOrigin] origin policy (15.19)
   * @throws {ConfigError} for a missing option
   */
  constructor({
    identity,
    caps,
    state,
    seqDoc,
    links,
    isLinked,
    linkCaps = () => null,
    addrsOf = () => [],
    events,
    now = Date.now,
    monoNow = () => performance.now(),
    schedule,
    log,
    timers,
    maxClockSkewMs,
    maxOrigins = 10000,
    allowOrigin,
  } = {}) {
    if (!(identity instanceof Identity)) throw new ConfigError('identity must be an Identity');
    if (state === null || typeof state !== 'object' || typeof state.update !== 'function') {
      throw new ConfigError('state must be a loaded document');
    }
    for (const [name, fn] of Object.entries({ links, isLinked, linkCaps, addrsOf, now, monoNow, schedule })) {
      requireFunction(fn, name);
    }
    if (typeof events?.emit !== 'function') throw new ConfigError('events must be an EventBus');
    this.#self = identity.nodeId;
    this.#identity = identity;
    this.#caps = capsOf(caps);
    this.#state = state;
    this.#seqDoc = seqDoc ?? null;
    this.#links = links;
    this.#isLinked = isLinked;
    this.#linkCaps = linkCaps;
    this.#addrsOf = addrsOf;
    this.#events = events;
    this.#now = now;
    this.#monoNow = monoNow;
    this.#schedule = schedule;
    this.#log = log ?? null;
    this.#maxAgeMs = timers.lsaMaxAgeMs;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#spfDebounceMs = timers.spfDebounceMs;
    // DESIGN.md 15.17: at most one LSA per lsaMinIntervalMs; the refresh never comes
    // sooner than that either (config.js checks it stays below lsaMaxAgeMs).
    this.#originIntervalMs = Math.max(timers.spfDebounceMs, timers.lsaMinIntervalMs);
    this.#refreshMs = Math.max(timers.lsaRefreshMs, timers.lsaMinIntervalMs);
    this.#sweepMs = Math.max(100, Math.floor(timers.lsaMaxAgeMs / 10));

    this.#lsdb = new Lsdb({
      selfId: this.#self,
      validate: validateLsa,
      // The dataset's check already verified the signature of anything it passes on.
      verify: (lsa) => this.#verified.has(lsa) || verifyRecord(lsa, RecordType.LSA).ok,
      monoNow,
      wallNow: now,
      maxAgeMs: timers.lsaMaxAgeMs,
      maxClockSkewMs,
      tombstoneMs: timers.lsaTombstoneMs,
      maxOrigins,
      allowOrigin,
    });
    this.#lsdb.onChange(() => this.#scheduleSpf());
    this.#dataset = new LwwDataset({
      name: LSA_DATASET,
      key: (record) => record.origin,
      version: (record) => record.seq,
      check: (record) => this.#check(record),
      maxEntries: maxOrigins,
      onAccept: (record, info) => this.#onAccept(record, info),
      onEquivocation: ({ key, version }) => {
        this.#stats.lsaEquivocations += 1;
        this.#events.emit('lsa.equivocation', { origin: key, seq: version });
      },
    });
    this.#dataset.pin(this.#self);
    this.#restoreSeqs();
    const saved = this.#state.data?.lsaSeq;
    this.#ownSeq = Number.isSafeInteger(saved) && saved > 0 ? saved : 0;
  }

  /** @returns {LwwDataset} the `lsa` dataset, for the SyncEngine */
  get dataset() {
    return this.#dataset;
  }

  /** @returns {number} increases with every recomputation that changed something */
  get rev() {
    return this.#rev;
  }

  /**
   * Connect to ClawSync.
   *
   * @param {(record: object) => { accepted: boolean, reason?: string }} publish
   * @throws {StateError} if already attached
   */
  attach(publish) {
    requireFunction(publish, 'publish');
    if (this.#publish !== null) throw new StateError('already-attached: the router has a publisher');
    this.#publish = publish;
  }

  /** Originate the first LSA and arm the refresh and expiry sweeps. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#originate('start');
    this.#armRefresh();
    this.#armSweep();
  }

  /** Cancel every timer and persist the sequence table. Idempotent. */
  stop() {
    this.#running = false;
    for (const cancel of [this.#cancelPending, this.#cancelRefresh, this.#cancelSweep, this.#cancelSpf]) cancel?.();
    this.#cancelPending = null;
    this.#cancelRefresh = null;
    this.#cancelSweep = null;
    this.#cancelSpf = null;
    this.#saveSeqs(true);
  }

  /** A link came up: re-advertise and make the neighbour reachable at once. */
  linkUp() {
    this.#requestOrigination('link-up');
    this.#recompute();
  }

  /** A link went down: re-advertise and drop routes through it synchronously. */
  linkDown() {
    this.#requestOrigination('link-down');
    this.#recompute();
  }

  /** A link's cost moved enough to be re-advertised (decided by the peer manager). */
  linkCost() {
    this.#requestOrigination('cost');
  }

  /**
   * @param {string} id
   * @returns {number | null} the cost our current LSA advertises for that link
   */
  advertisedCost(id) {
    return this.#advertised.get(id) ?? null;
  }

  /**
   * @param {string} dst
   * @returns {string | null} the neighbour to hand packets for `dst` to
   */
  nextHop(dst) {
    const route = this.#routes.get(dst);
    if (route !== undefined && this.#isLinked(route.nextHop)) return route.nextHop;
    if (dst !== this.#self && this.#isLinked(dst)) return dst;
    return null;
  }

  /**
   * @param {string} dst
   * @returns {boolean}
   */
  isReachable(dst) {
    return this.nextHop(dst) !== null;
  }

  /**
   * @param {string} dst
   * @returns {RouteView | null}
   */
  route(dst) {
    const route = this.#routes.get(dst);
    if (route !== undefined && this.#isLinked(route.nextHop)) {
      return { dst, nextHop: route.nextHop, cost: route.cost, hops: route.hops, path: route.path };
    }
    if (dst !== this.#self && this.#isLinked(dst)) return this.#directRoute(dst);
    return null;
  }

  /** @returns {RouteView[]} every usable route, nearest first */
  routes() {
    const out = [];
    for (const dst of this.#routes.keys()) {
      const view = this.route(dst);
      if (view !== null) out.push(view);
    }
    for (const { peer } of this.#links()) {
      if (!this.#routes.has(peer) && peer !== this.#self) out.push(this.#directRoute(peer));
    }
    return out.sort((a, b) => a.cost - b.cost || a.hops - b.hops || (a.dst < b.dst ? -1 : 1));
  }

  /**
   * @param {string} id
   * @returns {{ relay: boolean, mailbox: boolean, transit: boolean } | null} from the
   *   node's LSA, else from its handshake
   */
  caps(id) {
    const fromLsa = this.#lsdb.caps(id);
    if (fromLsa !== undefined) return capsOf(fromLsa);
    return capsOf(this.#linkCaps(id));
  }

  /** @returns {string[]} every origin with a current LSA, this node included */
  nodeIds() {
    return this.#lsdb.all().map((lsa) => lsa.origin);
  }

  /**
   * @param {string} origin
   * @returns {object | null} the current LSA of that origin
   */
  lsaOf(origin) {
    return this.#lsdb.get(origin) ?? null;
  }

  /**
   * Subscribe to changes of the effective routing table.
   *
   * @param {(change: { rev: number, reachable: string[], unreachable: string[] }) => void} listener
   * @returns {() => void} idempotent cancel
   */
  onRoutesChanged(listener) {
    requireFunction(listener, 'listener');
    const subscription = { listener };
    this.#listeners.add(subscription);
    return () => {
      this.#listeners.delete(subscription);
    };
  }

  /**
   * What this node knows of the network (API.md 6.4): every node with a current LSA, this
   * node and every linked peer; every link that at least one LSA advertises.
   *
   * @returns {{ rev: number, self: string, nodes: object[], links: object[] }}
   */
  topology() {
    const mono = this.#monoNow();
    const ids = new Set([this.#self, ...this.nodeIds()]);
    for (const { peer } of this.#links()) ids.add(peer);
    const nodes = [];
    for (const id of ids) {
      const lsa = this.#lsdb.get(id) ?? null;
      const self = id === this.#self;
      const route = self ? null : this.route(id);
      const received = self ? this.#lastOriginatedAt : this.#received.get(id);
      nodes.push({
        id,
        shortId: shortId(id),
        self,
        linked: !self && this.#isLinked(id),
        caps: self ? this.#caps : this.caps(id),
        seq: lsa?.seq ?? null,
        ts: lsa?.ts ?? null,
        receivedAgoMs: lsa === null || received == null ? null : Math.max(0, Math.round(mono - received)),
        advertised: lsa?.links.length ?? 0,
        reachable: self || route !== null,
        nextHop: route?.nextHop ?? null,
        cost: self ? 0 : route?.cost ?? null,
        hops: self ? 0 : route?.hops ?? null,
        addrs: this.#safeAddrs(id),
      });
    }
    nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { rev: this.#rev, self: this.#self, nodes, links: [...this.#linkMap().values()] };
  }

  /** @returns {Record<string, number>} counters and gauges */
  stats() {
    let routes = 0;
    for (const route of this.#routes.values()) if (this.#isLinked(route.nextHop)) routes += 1;
    return { ...this.#stats, lsdbSize: this.#lsdb.size, routes, rev: this.#rev, reachable: this.#effective.size };
  }

  // --------------------------------------------------------------------- the dataset

  #check(record) {
    const shape = validateLsa(record);
    if (!shape.ok) return { ok: false, reason: 'invalid-lsa' };
    // DESIGN.md 15.15, judged on this node's clock and therefore soft (ARCHITECTURE 4.5).
    const wall = this.#now();
    if (record.seq < wall - (this.#maxAgeMs + this.#maxClockSkewMs)) return { ok: false, reason: 'too-old', soft: true };
    if (record.seq > wall + this.#maxClockSkewMs) return { ok: false, reason: 'too-new', soft: true };
    const verdict = verifyRecord(record, RecordType.LSA);
    if (!verdict.ok) return { ok: false, reason: 'bad-signature' };
    this.#verified.add(record);
    return { ok: true };
  }

  #onAccept(record, { from }) {
    // Our own publish comes back through the dataset without `from`: it is installed
    // by #originate already.
    if (from === undefined) return;
    let result;
    try {
      result = this.#lsdb.upsert(record);
    } catch (error) {
      this.#stats.lsaRefused += 1;
      this.#log?.warn('lsa upsert failed', { code: errorCode(error) });
      return;
    }
    if (result.accepted) {
      this.#stats.lsaAccepted += 1;
      this.#received.set(record.origin, this.#monoNow());
      this.#seqsDirty = true;
      this.#events.emit('lsa.accepted', { origin: record.origin, seq: record.seq, changed: result.changed, from });
      return;
    }
    if (result.reason === 'own-origin-newer') {
      // DESIGN.md 15.16: the network holds an LSA of ours at or above our sequence
      // (a restart that lost state.json, or a clone). Jump past it.
      this.#stats.lsaSuperseded += 1;
      this.#ownSeq = Math.max(this.#ownSeq, result.seq);
      this.#state.update((data) => {
        data.lsaSeq = Math.max(Number.isSafeInteger(data.lsaSeq) ? data.lsaSeq : 0, result.seq);
      });
      this.#requestOrigination('superseded');
      return;
    }
    if (result.reason !== 'own-origin') this.#stats.lsaRefused += 1;
  }

  // --------------------------------------------------------------------- origination

  #requestOrigination(reason) {
    if (!this.#running) return;
    if (this.#cancelPending !== null) return;
    const now = this.#monoNow();
    const due = this.#lastOriginatedAt === null ? now : this.#lastOriginatedAt + this.#originIntervalMs;
    if (now >= due) {
      this.#originate(reason);
      return;
    }
    this.#pendingReason = reason;
    this.#cancelPending = this.#schedule(() => {
      this.#cancelPending = null;
      const why = this.#pendingReason ?? reason;
      this.#pendingReason = null;
      if (this.#running) this.#originate(why);
    }, due - now);
  }

  #originate(reason) {
    const now = this.#now();
    const seq = Math.max(this.#ownSeq + 1, now, this.#lsdb.highestSeq(this.#self) + 1);
    let links = [];
    for (const { peer, cost } of this.#links()) {
      if (isNodeId(peer) && peer !== this.#self) links.push({ peer, cost: clampCost(cost) });
    }
    if (links.length > Limits.MAX_LSA_LINKS) {
      links.sort((a, b) => a.cost - b.cost || (a.peer < b.peer ? -1 : 1));
      links = links.slice(0, Limits.MAX_LSA_LINKS);
    }
    links.sort((a, b) => (a.peer < b.peer ? -1 : 1));
    const record = this.#identity.signRecord(RecordType.LSA, { seq, ts: now, links, caps: this.#caps });
    // The number is taken before the record leaves, so a failure below never reuses it.
    this.#ownSeq = seq;
    this.#state.update((data) => {
      data.lsaSeq = seq;
    });
    this.#lastOriginatedAt = this.#monoNow();
    this.#lsdb.setLocal(record);
    this.#advertised = new Map(links.map(({ peer, cost }) => [peer, cost]));
    this.#seqsDirty = true;
    if (this.#publish !== null) {
      const result = this.#publish(record);
      if (!result.accepted) this.#log?.warn('own LSA was not accepted by the dataset', { reason: result.reason });
    }
    this.#stats.lsaOriginated += 1;
    this.#events.emit('lsa.originated', { seq, links: links.length, reason });
  }

  #armRefresh() {
    if (!this.#running) return;
    this.#cancelRefresh = this.#schedule(() => {
      this.#cancelRefresh = null;
      this.#requestOrigination('refresh');
      this.#armRefresh();
    }, this.#refreshMs);
  }

  // --------------------------------------------------------------------- expiry

  #armSweep() {
    if (!this.#running) return;
    this.#cancelSweep = this.#schedule(() => {
      this.#cancelSweep = null;
      this.#sweep();
      this.#armSweep();
    }, this.#sweepMs);
  }

  #sweep() {
    const removed = this.#lsdb.expire();
    for (const origin of removed) {
      this.#stats.lsaExpired += 1;
      this.#received.delete(origin);
      this.#events.emit('lsa.expired', { origin });
      if (origin === this.#self) continue;
      // The dataset keeps a floor at that seq, as the database keeps its tombstone.
      this.#dataset.remove(origin);
      this.#expired.add(origin);
      this.#seqsDirty = true;
    }
    for (const origin of this.#expired) {
      if (this.#lsdb.highestSeq(origin) === 0) {
        this.#dataset.forget(origin);
        this.#expired.delete(origin);
      }
    }
    this.#saveSeqs(false);
  }

  #restoreSeqs() {
    const table = this.#seqDoc?.data?.seqs;
    if (!Array.isArray(table) || table.length === 0) return;
    try {
      this.#lsdb.restoreSeqs(table);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      this.#log?.warn('persisted LSA sequence table refused', { message: errorText(error) });
    }
  }

  #saveSeqs(force) {
    if (this.#seqDoc === null || (!force && !this.#seqsDirty)) return;
    this.#seqsDirty = false;
    try {
      const seqs = this.#lsdb.exportSeqs();
      this.#seqDoc.update((data) => {
        data.v = 1;
        data.seqs = seqs;
      });
    } catch (error) {
      this.#log?.warn('cannot persist the LSA sequence table', { code: errorCode(error) });
    }
  }

  // --------------------------------------------------------------------- routes

  #scheduleSpf() {
    if (this.#cancelSpf !== null || !this.#running) return;
    // Scheduled even with a zero debounce: the change arrives in the middle of a dataset
    // offer, and listeners must not run inside it.
    this.#cancelSpf = this.#schedule(() => {
      this.#cancelSpf = null;
      this.#recompute();
    }, this.#spfDebounceMs);
  }

  #recompute() {
    const graph = this.#lsdb.graph();
    // Our side of a link is only real while the link is: a dead neighbour leaves our
    // routes now, not when our next LSA is allowed out.
    const mine = graph.get(this.#self);
    if (mine !== undefined) {
      for (const peer of [...mine.keys()]) {
        if (!this.#isLinked(peer)) {
          mine.delete(peer);
          graph.get(peer)?.delete(this.#self);
        }
      }
    }
    const previous = this.#routes;
    this.#routes = computeRoutes({
      graph,
      selfId: this.#self,
      transit: (id) => this.#lsdb.caps(id)?.transit === true,
    });
    this.#stats.spfRuns += 1;

    const effective = this.#effectiveSet();
    const reachable = [...effective].filter((dst) => !this.#effective.has(dst)).sort();
    const unreachable = [...this.#effective].filter((dst) => !effective.has(dst)).sort();
    this.#effective = effective;
    let changed = 0;
    for (const dst of new Set([...previous.keys(), ...this.#routes.keys()])) {
      const before = previous.get(dst);
      const after = this.#routes.get(dst);
      if (before?.nextHop !== after?.nextHop || before?.cost !== after?.cost) changed += 1;
    }
    const topology = this.#topologyDiff();
    if (changed === 0 && reachable.length === 0 && unreachable.length === 0 && topology === null) return;

    this.#rev += 1;
    if (changed > 0 || reachable.length > 0 || unreachable.length > 0) {
      const up = capList(reachable);
      const down = capList(unreachable);
      this.#events.emit('routes.changed', {
        rev: this.#rev,
        total: effective.size,
        reachable: up.items,
        unreachable: down.items,
        changed,
        ...(up.truncated || down.truncated ? { truncated: true } : {}),
      });
    }
    if (topology !== null) this.#events.emit('topology.changed', { rev: this.#rev, ...topology });
    const change = { rev: this.#rev, reachable, unreachable };
    for (const { listener } of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#log?.warn('routes listener failed', { message: errorText(error) });
      }
    }
  }

  #effectiveSet() {
    const set = new Set();
    for (const [dst, route] of this.#routes) if (this.#isLinked(route.nextHop)) set.add(dst);
    for (const { peer } of this.#links()) if (peer !== this.#self) set.add(peer);
    return set;
  }

  #directRoute(dst) {
    const link = this.#links().find((entry) => entry.peer === dst);
    const cost = this.#advertised.get(dst) ?? clampCost(link?.cost ?? MAX_LINK_COST);
    return { dst, nextHop: dst, cost, hops: 1, path: [this.#self, dst] };
  }

  #safeAddrs(id) {
    try {
      const addrs = this.#addrsOf(id);
      return Array.isArray(addrs) ? [...addrs] : [];
    } catch {
      return [];
    }
  }

  /** Every pair at least one current LSA advertises, keyed "a|b" with a < b. */
  #linkMap() {
    const map = new Map();
    for (const lsa of this.#lsdb.all()) {
      for (const { peer, cost } of lsa.links) {
        const [a, b] = lsa.origin < peer ? [lsa.origin, peer] : [peer, lsa.origin];
        const key = `${a}|${b}`;
        let link = map.get(key);
        if (link === undefined) {
          link = { a, b, costAB: null, costBA: null, state: 'half' };
          map.set(key, link);
        }
        if (lsa.origin === a) link.costAB = cost;
        else link.costBA = cost;
        link.state = link.costAB !== null && link.costBA !== null ? 'confirmed' : 'half';
      }
    }
    return map;
  }

  /** The difference since the last call, for `topology.changed`; null when nothing moved. */
  #topologyDiff() {
    const nodes = new Map();
    for (const lsa of this.#lsdb.all()) nodes.set(lsa.origin, capsOf(this.#lsdb.caps(lsa.origin)));
    for (const { peer } of this.#links()) if (!nodes.has(peer)) nodes.set(peer, capsOf(this.#linkCaps(peer)));
    const links = this.#linkMap();

    const nodesAdded = [];
    const nodesUpdated = [];
    const nodesRemoved = [];
    for (const [id, caps] of nodes) {
      const key = JSON.stringify(caps);
      const before = this.#topoNodes.get(id);
      if (before === undefined) nodesAdded.push({ id, caps });
      else if (before !== key) nodesUpdated.push({ id, caps });
    }
    for (const id of this.#topoNodes.keys()) if (!nodes.has(id)) nodesRemoved.push(id);
    const linksAdded = [];
    const linksUpdated = [];
    const linksRemoved = [];
    for (const [key, link] of links) {
      const before = this.#topoLinks.get(key);
      const text = JSON.stringify(link);
      if (before === undefined) linksAdded.push(link);
      else if (before !== text) linksUpdated.push(link);
    }
    for (const key of this.#topoLinks.keys()) {
      if (!links.has(key)) {
        const [a, b] = key.split('|');
        linksRemoved.push({ a, b });
      }
    }
    this.#topoNodes = new Map([...nodes].map(([id, caps]) => [id, JSON.stringify(caps)]));
    this.#topoLinks = new Map([...links].map(([key, link]) => [key, JSON.stringify(link)]));

    const total = nodesAdded.length + nodesUpdated.length + nodesRemoved.length +
      linksAdded.length + linksUpdated.length + linksRemoved.length;
    if (total === 0) return null;
    if (total > EVENT_LIST_MAX) {
      return { full: true, nodesAdded: [], nodesUpdated: [], nodesRemoved: [], linksAdded: [], linksUpdated: [], linksRemoved: [] };
    }
    return { full: false, nodesAdded, nodesUpdated, nodesRemoved, linksAdded, linksUpdated, linksRemoved };
  }
}

// ---------------------------------------------------------------------------------------
// Service registration (ARCHITECTURE.md section 6)
// ---------------------------------------------------------------------------------------

/** A non-error result of an API route with a 2xx status other than 200. */
export class ApiReply {
  /**
   * @param {number} status 200..299
   * @param {unknown} body JSON value
   */
  constructor(status, body) {
    this.status = status;
    this.body = body;
    Object.freeze(this);
  }
}

function checkService(service) {
  if (service === null || typeof service !== 'object') throw new ConfigError('a service must be an object');
  if (typeof service.name !== 'string' || !SERVICE_NAME_PATTERN.test(service.name)) {
    throw new ConfigError('service name must match /^[a-z][a-z0-9-]{0,31}$/');
  }
  requireFunction(service.init, `service "${service.name}" init`);
  for (const hook of ['start', 'stop', 'stats']) {
    if (service[hook] !== undefined) requireFunction(service[hook], `service "${service.name}" ${hook}`);
  }
  const { requires = [] } = service;
  if (!Array.isArray(requires) || requires.some((name) => typeof name !== 'string' || !SERVICE_NAME_PATTERN.test(name))) {
    throw new ConfigError(`service "${service.name}" requires must be a list of service names`);
  }
}

/** Registration order, except that every service follows those it requires. */
function orderServices(services) {
  const byName = new Map(services.map((service) => [service.name, service]));
  for (const service of services) {
    for (const name of service.requires ?? []) {
      if (!byName.has(name)) throw new ConfigError(`service "${service.name}" requires missing service "${name}"`);
    }
  }
  const placed = new Set();
  const out = [];
  while (out.length < services.length) {
    const next = services.find((service) => !placed.has(service.name) && (service.requires ?? []).every((name) => placed.has(name)));
    if (next === undefined) throw new ConfigError('service requirements form a cycle');
    placed.add(next.name);
    out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// ClawNode
// ---------------------------------------------------------------------------------------

/**
 * A ClawNet node. See the file comment.
 */
export class ClawNode {
  #config;
  #dataDir;
  #passphrase;
  #now;
  #rng;
  #baseLog;
  #log;
  #boot;
  #events;
  #timers;
  #state = 'new';
  #services = [];
  #stopPromise = null;
  #startPromise = null;
  #startedAt = null;
  /** Services whose start() completed, in start order: only these are stopped. */
  #startedServices = [];

  #identity = null;
  #keystoreEncrypted = false;
  #storage = null;
  #stateDoc = null;
  #seqDoc = null;
  #book = null;
  #recordsDoc = null;
  #pex = null;
  #router = null;
  #forwarder = null;
  #messenger = null;
  #outboxLog = null;
  #seenLog = null;
  #peers = null;
  #governor = null;
  #bootstrap = null;
  #multicast = null;
  #sync = null;
  #listen = null;
  #lockPath = null;
  #runtimePath = null;
  #discoveryRunning = false;

  /** Registration state of the services. */
  #phase = 'closed';
  #live = false;
  #serviceDatasets = new Map();
  #kinds = new Set();
  #selectors = new Set();
  #apiRoutes = [];
  #apiKeys = new Set();
  #routeListeners = new Set();

  #trafficPrev = new Map();
  #counters = { syncPeerErrors: 0, internalErrors: 0 };

  /**
   * @param {object} options
   * @param {object} [options.config] full or partial configuration (validated here)
   * @param {string} options.dataDir the data directory
   * @param {string} [options.passphrase] encrypts a new keystore; unlocks an existing one
   * @param {object[]} [options.services] services (ARCHITECTURE.md section 6)
   * @param {() => number} [options.now] wall clock
   * @param {() => number} [options.rng] uniform in [0, 1), for jitter only
   * @param {{ debug: Function, info: Function, warn: Function, error: Function }} [options.logger]
   *   receives `(msg, fields)` with `fields.mod` naming the module; default: JSON lines on
   *   stderr at `config.log.level`
   * @throws {ConfigError} for an invalid option, configuration or service
   */
  constructor({ config = {}, dataDir, passphrase, services = [], now = Date.now, rng = Math.random, logger } = {}) {
    if (typeof dataDir !== 'string' || dataDir === '' || dataDir.includes('\0')) {
      throw new ConfigError('dataDir must be a non-empty path');
    }
    if (passphrase !== undefined && passphrase !== null && typeof passphrase !== 'string') {
      throw new ConfigError('passphrase must be a string');
    }
    requireFunction(now, 'now');
    requireFunction(rng, 'rng');
    if (!Array.isArray(services)) throw new ConfigError('services must be a list');
    this.#config = validateConfig(config);
    this.#dataDir = resolve(dataDir);
    this.#passphrase = passphrase ?? undefined;
    this.#now = now;
    this.#rng = rng;
    if (logger !== undefined) {
      for (const level of Object.keys(LOG_LEVELS)) requireFunction(logger?.[level], `logger.${level}`);
    }
    this.#baseLog = logger ?? createLogger({ level: this.#config.log.level, now });
    this.#log = bindLog(this.#baseLog, 'node');
    this.#boot = randomBytes(4).toString('hex');
    this.#events = new EventBus({ capacity: EVENT_BUS_CAPACITY, now });
    this.#timers = new TimerSet({ onError: (error, label) => this.#reportError(label, error) });
    for (const service of services) this.use(service);
  }

  /**
   * Add a service. Only before start().
   *
   * @param {object} service see ARCHITECTURE.md section 6
   * @returns {this}
   * @throws {StateError} after start()
   * @throws {ConfigError} for an invalid service or a name already used
   */
  use(service) {
    if (this.#state !== 'new') throw new StateError('not-new: services can only be added before start()');
    checkService(service);
    if (this.#services.some((other) => other.name === service.name)) {
      throw new ConfigError(`a service named "${service.name}" is already registered`);
    }
    this.#services.push(service);
    return this;
  }

  /** @returns {'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'} */
  get state() {
    return this.#state;
  }

  /** @returns {string} this node's NodeId */
  get id() {
    if (this.#identity === null) throw new StateError('not-started: the identity is loaded by start()');
    return this.#identity.nodeId;
  }

  /** @returns {string} 8 hex characters, new for every process start */
  get boot() {
    return this.#boot;
  }

  /** @returns {EventBus} */
  get events() {
    return this.#events;
  }

  /** @returns {object} the frozen validated configuration */
  get config() {
    return this.#config;
  }

  /** @returns {string} absolute data directory */
  get dataDir() {
    return this.#dataDir;
  }

  /** @returns {{ host: string, port: number } | null} the bound peer listener */
  get listenAddress() {
    return this.#listen === null ? null : { ...this.#listen };
  }

  // ===================================================================== lifecycle

  /**
   * Start the node (ARCHITECTURE.md 7.1). On failure every step already taken is undone,
   * the state becomes `failed` and the error is rethrown.
   *
   * @returns {Promise<void>}
   * @throws {StateError} if not in state `new`, or `locked: …` if another process uses
   *   the data directory
   * @throws {ConfigError} if the data directory belongs to another network, or a service
   *   is missing or cyclic in its requirements
   * @throws {AuthError} if the keystore cannot be unlocked
   */
  start() {
    if (this.#state !== 'new') {
      return Promise.reject(new StateError(`not-new: start() is legal once, the node is ${this.#state}`));
    }
    this.#state = 'starting';
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start() {
    try {
      await this.#startSequence();
    } catch (error) {
      await this.#shutdown({ reason: 'start-failed', quiet: true }).catch(NOOP);
      this.#state = 'failed';
      throw error;
    }
    this.#state = 'running';
    this.#events.emit('node.started', {
      nodeId: this.#identity.nodeId,
      boot: this.#boot,
      agent: DEFAULT_AGENT,
      networkId: this.#config.networkId,
      listen: this.#listenText(),
    });
    this.#log.info('node started', { listen: this.#listenText() });
  }

  /**
   * Stop the node (ARCHITECTURE.md 7.2). Idempotent; concurrent calls share one promise.
   * Every step is attempted; the first error is rethrown at the end.
   *
   * @param {{ reason?: string }} [options]
   * @returns {Promise<void>}
   */
  stop({ reason = 'requested' } = {}) {
    if (this.#stopPromise !== null) return this.#stopPromise;
    if (this.#state === 'starting') {
      // Let the start finish (or fail and undo itself), then stop what it built.
      this.#stopPromise = this.#startPromise.then(
        () => this.#shutdown({ reason: String(reason).slice(0, 64), quiet: false }),
        NOOP,
      );
      return this.#stopPromise;
    }
    if (this.#state === 'new' || this.#state === 'failed' || this.#state === 'stopped') {
      this.#state = this.#state === 'new' ? 'stopped' : this.#state;
      this.#stopPromise = Promise.resolve();
      return this.#stopPromise;
    }
    this.#stopPromise = this.#shutdown({ reason: String(reason).slice(0, 64), quiet: false });
    return this.#stopPromise;
  }

  async #startSequence() {
    const config = this.#config;
    const dir = this.#dataDir;

    // 1. Directory, lock, network.
    await ensurePrivateDir(dir);
    await this.#takeLock();
    const { recorded, file } = checkNetworkId({ dataDir: dir, networkId: config.networkId });
    if (recorded === null) await atomicWriteFile(file, formatNetworkIdFile(config.networkId));

    // 2. Keystore and identity.
    const storageKey = await this.#openKeystore();

    // 3. Storage and the node's own documents.
    try {
      this.#storage = new NodeStorage({
        dir,
        storageKey,
        now: this.#now,
        onRecovered: (info) => this.#events.emit('store.recovered', info),
      });
    } finally {
      storageKey.fill(0);
    }
    this.#stateDoc = this.#storage.doc('state', {
      defaults: { lsaSeq: 0, peerSeq: 0 },
      validate: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
        [value.lsaSeq ?? 0, value.peerSeq ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0),
      sealed: false,
    });
    await this.#stateDoc.load();
    this.#seqDoc = this.#storage.doc('lsdb-seqs', {
      defaults: { v: 1, seqs: [] },
      validate: (value) => value !== null && typeof value === 'object' && Array.isArray(value.seqs),
      sealed: false,
    });
    await this.#seqDoc.load();
    this.#book = new AddressBook({
      doc: this.#storage.doc('peers', { defaults: { v: 1, entries: [] }, sealed: false }),
      now: this.#now,
    });
    await this.#book.load();
    this.#recordsDoc = this.#storage.doc('peer-records', { defaults: { v: 1, records: [] }, sealed: false });
    await this.#recordsDoc.load();

    // 4. Modules, nothing started.
    await this.#constructModules();

    // 5. Services: init.
    this.#services = orderServices(this.#services);
    this.#phase = 'init';
    for (const service of this.#services) await service.init(this.#contextFor(service));
    this.#phase = 'closed';

    // 6. The sync engine with every dataset.
    this.#constructSync();
    this.#router.attach((record) => this.#sync.publish(LSA_DATASET, record));
    this.#pex.attach((record) => this.#sync.publish(PEER_DATASET, record));

    // 7. Our first LSA and peer record.
    this.#router.start();
    this.#pex.refresh();

    // 8. The listener.
    this.#listen = await this.#peers.start();

    // 9. Services: start; then runtime.json.
    this.#live = true;
    for (const service of this.#services) {
      if (service.start !== undefined) await service.start();
      this.#startedServices.push(service);
    }
    this.#startedAt = this.#now();
    this.#runtimePath = join(dir, RUNTIME_FILE);
    await atomicWriteFile(this.#runtimePath, `${JSON.stringify({
      pid: process.pid,
      boot: this.#boot,
      nodeId: this.#identity.nodeId,
      listen: this.#listenText(),
      api: this.service('api')?.url ?? null,
      startedAt: this.#startedAt,
    })}\n`);

    // 10. Discovery and the node's own timers.
    this.#discoveryRunning = true;
    this.#bootstrap.start();
    if (this.#multicast !== null) await this.#multicast.start();
    this.#timers.every(() => this.#sync.tick(), config.timers.syncIntervalMs, 'sync.tick');
    this.#timers.every(() => this.#trafficSample(), TRAFFIC_SAMPLE_MS, 'traffic.sample');
    this.#timers.every(() => this.#maintainDiscovery(), config.timers.redialMinMs, 'discovery');
  }

  async #takeLock() {
    const path = join(this.#dataDir, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await atomicCreateFile(path, `${process.pid}\n`);
        this.#lockPath = path;
        return;
      } catch (error) {
        if (!(error instanceof StateError)) throw error;
      }
      let holder = null;
      try {
        const text = (await readFile(path)).subarray(0, MAX_LOCK_BYTES).toString('latin1').trim();
        if (/^[1-9][0-9]{0,9}$/.test(text)) holder = Number(text);
      } catch {
        // Unreadable or gone meanwhile: treated as stale and retried once.
      }
      if (holder !== null && isProcessAlive(holder)) {
        throw new StateError(`locked: the data directory is in use by process ${holder}`);
      }
      await rm(path, { force: true });
    }
    throw new StateError('locked: the data directory lock could not be taken');
  }

  async #openKeystore() {
    const path = join(this.#dataDir, KEYSTORE_FILE);
    if (!(await Keystore.exists(path))) {
      const secret = Identity.generate().toSecret();
      const bytes = Buffer.concat([secret.signSeed, secret.linkPrivate, secret.e2ePrivate]);
      try {
        await Keystore.create(path, bytes, { passphrase: this.#passphrase });
      } finally {
        bytes.fill(0);
        for (const key of Object.values(secret)) key.fill(0);
      }
    }
    const { secret, storageKey } = await Keystore.open(path, { passphrase: this.#passphrase });
    try {
      if (secret.length !== SECRET_BYTES || storageKey.length !== KEY_BYTES) {
        throw new StoreError('keystore does not hold a node identity');
      }
      this.#identity = Identity.fromSecret({
        signSeed: secret.subarray(0, 32),
        linkPrivate: secret.subarray(32, 64),
        e2ePrivate: secret.subarray(64, 96),
      });
    } catch (error) {
      storageKey.fill(0);
      throw error;
    } finally {
      secret.fill(0);
    }
    this.#keystoreEncrypted = await Keystore.isEncrypted(path);
    return storageKey;
  }

  async #constructModules() {
    const config = this.#config;
    const { timers, limits, discovery, peers } = config;
    const identity = this.#identity;
    const self = identity.nodeId;
    const events = this.#events;
    const schedule = (fn, ms) => this.#timers.schedule(fn, ms, 'module');
    const monoNow = () => performance.now();
    const block = new Set(peers.block);
    const allow = new Set(peers.allow);
    const allowOrigin = (origin) => origin === self || (!block.has(origin) && (allow.size === 0 || allow.has(origin)));
    const dial = (address) => this.#peers.connect(address, { sticky: false });
    const isKnown = (id) => this.#peers.isLinked(id) || this.#peers.dialing().some((entry) => entry.id === id);

    this.#governor = new DialGovernor({
      monoNow,
      dialsPerSecond: limits.dialsPerSecond,
      backoffMinMs: timers.redialMinMs,
      backoffMaxMs: timers.redialMaxMs,
      jitter: timers.redialJitter,
      rng: this.#rng,
    });
    this.#pex = new PeerExchange({
      identity,
      caps: config.caps,
      ownAddresses: () => this.#ownAddresses(),
      isKnown,
      dial,
      governor: this.#governor,
      maxClockSkewMs: limits.maxClockSkewMs,
      pex: discovery.pex,
      allowLoopback: discovery.allowLoopback,
      allowOrigin,
      maxOrigins: limits.maxOrigins,
      doc: this.#recordsDoc,
      state: this.#stateDoc,
      events,
      now: this.#now,
      monoNow,
      rng: this.#rng,
      log: bindLog(this.#baseLog, 'pex'),
    });
    await this.#pex.load();

    this.#router = new Router({
      identity,
      caps: config.caps,
      state: this.#stateDoc,
      seqDoc: this.#seqDoc,
      links: () => (this.#peers === null ? [] : this.#peers.links()),
      isLinked: (id) => this.#peers !== null && this.#peers.isLinked(id),
      linkCaps: (id) => this.#peers?.get(id)?.caps ?? null,
      addrsOf: (id) => this.#pex.recordOf(id)?.addrs ?? [],
      events,
      now: this.#now,
      monoNow,
      schedule,
      log: bindLog(this.#baseLog, 'router'),
      timers,
      maxClockSkewMs: limits.maxClockSkewMs,
      maxOrigins: limits.maxOrigins,
      allowOrigin,
    });
    this.#router.onRoutesChanged((change) => this.#onRoutesChanged(change));

    this.#forwarder = new Forwarder({
      selfId: self,
      transit: config.caps.transit,
      nextHop: (dst) => this.#router.nextHop(dst),
      isNeighbour: (id) => this.#peers !== null && this.#peers.isLinked(id),
      send: (hop, packet) => this.#peers.send(hop, packet),
      events,
      monoNow,
      schedule,
      log: bindLog(this.#baseLog, 'forwarder'),
      transitHoldMs: timers.transitHoldMs,
      // 0 means "do not hold": the forwarder needs room for one, and a packet then
      // waits at most a millisecond.
      transitQueueMax: Math.max(1, limits.transitQueueMax),
      seenEntries: limits.seenCacheEntries,
      dedupeTtlMs: timers.forwardDedupeTtlMs,
    });

    this.#outboxLog = this.#storage.log('outbox');
    this.#seenLog = this.#storage.log('seen');
    await this.#outboxLog.open();
    await this.#seenLog.open();
    this.#messenger = new ReliableMessenger({
      identity,
      cardOf: (id) => this.#pex.cardOf(id) ?? this.#peers?.cardOf(id) ?? null,
      originate: (packet, options) => this.#forwarder.originate(packet, options),
      isReachable: (dst) => this.#router.isReachable(dst),
      routePath: (dst) => this.#router.route(dst)?.path ?? null,
      events,
      now: this.#now,
      monoNow,
      rng: this.#rng,
      schedule,
      log: bindLog(this.#baseLog, 'messenger'),
      index: this.#outboxLog,
      bodies: this.#storage.blobs('outbox'),
      seenLog: this.#seenLog,
      ttl: limits.ttl,
      messageLifetimeMs: limits.messageLifetimeMs,
      maxClockSkewMs: limits.maxClockSkewMs,
      retransmitMinMs: timers.retransmitMinMs,
      retransmitMaxMs: timers.retransmitMaxMs,
      retransmitJitter: timers.retransmitJitter,
      outboxMaxEntries: limits.outboxMaxEntries,
      outboxMaxBytes: limits.outboxMaxBytes,
      seenCacheEntries: limits.seenCacheEntries,
      maxInFlightPerDestination: limits.maxInFlightPerDestination,
    });
    await this.#messenger.open();
    this.#forwarder.onLocal('data.sealed', (packet, info) => this.#messenger.handleData(packet, info));

    this.#peers = new PeerManager({
      identity,
      config,
      events,
      addressBook: this.#book,
      now: this.#now,
      rng: this.#rng,
      log: bindLog(this.#baseLog, 'peers'),
      ownAddresses: () => this.#ownAddresses(),
      preferPeer: (id) => this.#router.caps(id)?.relay === true || this.#pex.recordOf(id)?.caps?.relay === true,
      advertisedCost: (id) => this.#router.advertisedCost(id),
      onLinkUp: (info) => this.#onLinkUp(info),
      onLinkDown: (info) => this.#onLinkDown(info),
      onLinkCost: () => this.#router.linkCost(),
      onPacket: (id, packet) => this.#onPacket(id, packet),
      onObserved: () => this.#pex.refresh(),
    });

    this.#bootstrap = new BootstrapDiscovery({
      addresses: discovery.bootstrap,
      dial,
      governor: this.#governor,
      isKnown,
      peerCount: () => this.#peerCount(),
      targetPeers: peers.target,
      events,
      log: bindLog(this.#baseLog, 'bootstrap'),
    });
    if (discovery.multicast.enabled) {
      this.#multicast = new MulticastDiscovery({
        identity,
        networkId: config.networkId,
        networkKey: config.networkKey === null ? null : base64Decode(config.networkKey, KEY_BYTES),
        group: discovery.multicast.group,
        port: discovery.multicast.port,
        iface: discovery.multicast.interface,
        listenPort: () => this.#listen?.port ?? null,
        intervalMs: timers.beaconIntervalMs,
        maxClockSkewMs: limits.maxClockSkewMs,
        beaconsPerSourcePerMin: limits.beaconsPerSourcePerMin,
        beaconsPerMin: limits.beaconsPerMin,
        allowLoopback: discovery.allowLoopback,
        isKnown,
        dial,
        governor: this.#governor,
        onCandidate: (candidate) => this.#pex.noteCard(candidate.card),
        events,
        now: this.#now,
        monoNow,
        rng: this.#rng,
        log: bindLog(this.#baseLog, 'multicast'),
      });
    }
  }

  #constructSync() {
    const { timers, limits, peers } = this.#config;
    const datasets = [this.#router.dataset, this.#pex.dataset];
    for (const name of SERVICE_DATASETS) {
      datasets.push(this.#serviceDatasets.get(name) ?? relayOnlyDataset(name));
    }
    const block = new Set(peers.block);
    const allow = new Set(peers.allow);
    const self = this.#identity.nodeId;
    this.#sync = new SyncEngine({
      datasets,
      send: (id, packet) => this.#peers.send(id, packet),
      monoNow: () => performance.now(),
      rng: this.#rng,
      limits: { ...DEFAULT_SYNC_LIMITS },
      gossipBatchMs: timers.gossipBatchMs,
      schedule: (fn, ms) => this.#timers.schedule(fn, ms, 'sync'),
      onError: (peer, reason, detail) => this.#onSyncError(peer, reason, detail),
      self,
      roundTimeoutMs: Math.min(10_000, Math.max(1000, 4 * timers.syncIntervalMs)),
      minRoundIntervalMs: Math.min(1000, Math.floor(timers.syncIntervalMs / 2)),
      newKeysPerMinute: limits.newOriginsPerPeerPerMin,
      allowOrigin: (origin) => origin === self || (!block.has(origin) && (allow.size === 0 || allow.has(origin))),
      holdDownMs: timers.lsaMinIntervalMs > 0 ? { [LSA_DATASET]: timers.lsaMinIntervalMs } : {},
    });
  }

  /**
   * The stop sequence, also used to undo a failed start. Each step runs even if an
   * earlier one failed; the first error is rethrown (unless `quiet`).
   */
  async #shutdown({ reason, quiet }) {
    const wasRunning = !quiet;
    this.#state = 'stopping';
    if (wasRunning) this.#events.emit('node.stopping', { reason });
    const deadline = performance.now() + STOP_TIMEOUT_MS;
    const errors = [];
    const step = async (where, work) => {
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new StateError(`stop-timeout: no time left for ${where}`);
        let cancel = NOOP;
        const timeout = new Promise((_, reject) => {
          const handle = setTimeout(() => reject(new StateError(`stop-timeout: ${where} took too long`)), remaining);
          cancel = () => clearTimeout(handle);
        });
        try {
          await Promise.race([Promise.resolve().then(work), timeout]);
        } finally {
          cancel();
        }
      } catch (error) {
        errors.push(error);
        if (!quiet) this.#reportError(`stop:${where}`, error);
      }
    };

    // 2. Discovery: no more dials or beacons.
    this.#discoveryRunning = false;
    if (this.#multicast !== null) await step('multicast', () => this.#multicast.stop());
    // 3. Services, in reverse order, while sending still works.
    for (const service of [...this.#startedServices].reverse()) {
      if (service.stop !== undefined) await step(`service:${service.name}`, () => service.stop());
    }
    this.#startedServices = [];
    this.#live = false;
    for (const subscription of this.#routeListeners) subscription.cancel();
    this.#routeListeners.clear();
    // 4. Push batched gossip, then close every link with BYE "shutdown".
    if (this.#sync !== null) await step('sync.flush', () => this.#sync.flush());
    if (this.#peers !== null) await step('peers', () => this.#peers.stop());
    // 5. Timers.
    this.#timers.cancelAll();
    this.#router?.stop();
    this.#sync?.close();
    this.#forwarder?.close();
    // 6. Stores: these run even when the deadline has passed.
    const flushStep = async (where, work) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
        if (!quiet) this.#reportError(`stop:${where}`, error);
      }
    };
    if (this.#messenger !== null) await flushStep('messenger', () => this.#messenger.close());
    if (this.#pex !== null) await flushStep('pex', () => this.#pex.flush());
    if (this.#book !== null) await flushStep('address-book', () => this.#book.flush());
    if (this.#storage !== null) await flushStep('storage', () => this.#storage.closeAll());
    // 7. Files that say the node is running.
    if (this.#runtimePath !== null) await flushStep('runtime', () => rm(this.#runtimePath, { force: true }));
    if (this.#lockPath !== null) await flushStep('lock', () => rm(this.#lockPath, { force: true }));
    this.#runtimePath = null;
    this.#lockPath = null;
    this.#state = 'stopped';
    if (wasRunning) {
      this.#events.emit('node.stopped', {});
      this.#log.info('node stopped', { reason });
    }
    if (errors.length > 0 && !quiet) throw errors[0];
  }

  // ===================================================================== wiring

  #onPacket(id, packet) {
    switch (packet.type) {
      case PacketType.GOSSIP:
      case PacketType.SYNC_DIGEST:
      case PacketType.SYNC_REQUEST:
      case PacketType.SYNC_DELTA:
        this.#sync.handlePacket(id, packet);
        return;
      case PacketType.DATA:
      case PacketType.PROBE:
        this.#forwarder.handle(id, packet);
        return;
      default:
        // The codec admits only known types; anything else here is a peer bug.
        throw new ProtocolError('unexpected packet type');
    }
  }

  #onLinkUp(info) {
    const card = this.#peers.cardOf(info.id);
    if (card !== null) this.#pex.noteCard(card);
    this.#router.linkUp(info.id);
    this.#sync.addPeer(info.id);
    this.#forwarder.flush();
  }

  #onLinkDown(info) {
    this.#sync.removePeer(info.id);
    this.#router.linkDown(info.id);
    if (this.#discoveryRunning && this.#peers.size === 0) this.#bootstrap.kick();
    if (this.#discoveryRunning) this.#timers.schedule(() => this.#maintainDiscovery(), 0, 'discovery');
  }

  #onRoutesChanged(change) {
    this.#forwarder.flush();
    this.#messenger.routesChanged({ reachable: change.reachable });
  }

  #onSyncError(peer, reason, detail) {
    this.#counters.syncPeerErrors += 1;
    this.#events.emit('sync.peer_error', { peer, reason: String(reason).slice(0, 64), detail: String(detail).slice(0, MAX_ERROR_TEXT) });
    this.#peers.penalize(peer, `sync: ${reason}`);
  }

  #maintainDiscovery() {
    if (!this.#discoveryRunning) return;
    const target = this.#config.peers.target;
    if (this.#peerCount() >= target) return;
    this.#bootstrap.maintain();
    const want = target - this.#peerCount();
    if (want > 0) this.#pex.maintain(want);
  }

  #peerCount() {
    return this.#peers.size + this.#peers.dialing().length;
  }

  /** ARCHITECTURE.md 4.6. */
  #ownAddresses() {
    if (this.#config.advertise.length > 0) return [...this.#config.advertise];
    const port = this.#listen?.port;
    if (this.#peers === null || !Number.isInteger(port) || port < 1) return [];
    const out = [];
    for (const ip of this.#peers.observedAddresses()) {
      try {
        out.push(formatAddress(ip, port));
      } catch {
        // An observed value that cannot form an address is not announced.
      }
    }
    return out;
  }

  #trafficSample() {
    // The peer manager does not report send-queue drain; retrying held packets here
    // bounds how long one waits for a link that had pushed back.
    this.#forwarder.flush();
    const forwarder = this.#forwarder.takeTrafficSample();
    const links = [];
    const seen = new Set();
    for (const peer of this.#peers.list()) {
      seen.add(peer.linkId);
      const before = this.#trafficPrev.get(peer.linkId) ?? { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
      const now = { packetsIn: peer.packetsIn, packetsOut: peer.packetsOut, bytesIn: peer.bytesIn, bytesOut: peer.bytesOut };
      this.#trafficPrev.set(peer.linkId, now);
      const delta = {
        peer: peer.id,
        packetsIn: Math.max(0, now.packetsIn - before.packetsIn),
        packetsOut: Math.max(0, now.packetsOut - before.packetsOut),
        bytesIn: Math.max(0, now.bytesIn - before.bytesIn),
        bytesOut: Math.max(0, now.bytesOut - before.bytesOut),
      };
      if (delta.packetsIn + delta.packetsOut + delta.bytesIn + delta.bytesOut > 0) links.push(delta);
    }
    for (const linkId of [...this.#trafficPrev.keys()]) if (!seen.has(linkId)) this.#trafficPrev.delete(linkId);
    const moved = forwarder.originated + forwarder.forwarded + forwarder.delivered + forwarder.queued + forwarder.dropped;
    if (links.length === 0 && moved === 0 && forwarder.suppressed === 0) return;
    const list = capList(links);
    this.#events.emit('traffic.sample', {
      intervalMs: TRAFFIC_SAMPLE_MS,
      links: list.items,
      forwarder: {
        originated: forwarder.originated,
        forwarded: forwarder.forwarded,
        delivered: forwarder.delivered,
        queued: forwarder.queued,
        dropped: forwarder.dropped,
      },
      suppressed: forwarder.suppressed,
      ...(list.truncated ? { truncated: true } : {}),
    });
  }

  #reportError(where, error) {
    this.#counters.internalErrors += 1;
    const data = { where: String(where).slice(0, 64), code: errorCode(error), message: errorText(error) };
    try {
      this.#events.emit('internal.error', data);
    } catch {
      // The bus refused the event; the log line below still records it.
    }
    this.#log.error('internal error', data);
  }

  #listenText() {
    if (this.#listen === null) return null;
    try {
      return formatAddress(this.#listen.host, this.#listen.port);
    } catch {
      return null;
    }
  }

  #requireRunning() {
    if (this.#state !== 'running') throw new StateError(`not-running: the node is ${this.#state}`);
  }

  // ===================================================================== services

  #contextFor(service) {
    const name = service.name;
    const node = this;
    const inInit = (what) => {
      if (this.#phase !== 'init') throw new StateError(`not-init: ${what} can only be registered during init`);
    };
    const live = (what) => {
      if (!this.#live) throw new StateError(`not-started: ${what} works from service start until stop`);
    };
    const identity = this.#identity;
    const storage = this.#storage.scope('services').scope(name);
    const log = bindLog(this.#baseLog, name);

    const messaging = Object.freeze({
      send: (dst, options) => {
        live('messaging.send');
        return node.#sendChecked(dst, options);
      },
      onKind: (kind, handler) => {
        inInit('messaging.onKind');
        if (RESERVED_KINDS.includes(kind)) throw new ConfigError(`kind "${kind}" is reserved`);
        requireFunction(handler, 'handler');
        if (this.#kinds.has(kind)) throw new StateError(`duplicate-handler: kind "${kind}" already has a handler`);
        // The messenger is open but no link exists before the listener opens (7.1), so
        // registering now cannot miss a message.
        const off = this.#messenger.onKind(kind, handler);
        this.#kinds.add(kind);
        return off;
      },
      pending: () => this.#messenger.pending(),
      get: (id) => this.#messenger.get(id),
      packetOf: (id) => this.#messenger.packetOf(id),
      setCustodian: (id, custodian, state) => this.#messenger.setCustodian(id, custodian, state),
    });
    const packets = Object.freeze({
      originate: (packet, options) => {
        live('packets.originate');
        return this.#forwarder.originate(packet, options);
      },
      onLocal: (selector, handler) => {
        inInit('packets.onLocal');
        if (!SERVICE_SELECTORS.includes(selector)) throw new ConfigError(`selector "${selector}" is not open to services`);
        requireFunction(handler, 'handler');
        if (this.#selectors.has(selector)) throw new StateError(`duplicate-handler: selector "${selector}" already has a handler`);
        this.#selectors.add(selector);
        this.#forwarder.onLocal(selector, handler);
      },
    });
    const sync = Object.freeze({
      addDataset: (dataset) => {
        inInit('sync.addDataset');
        if (dataset === null || typeof dataset !== 'object' || !SERVICE_DATASETS.includes(dataset.name)) {
          throw new ConfigError(`a service dataset must be named one of ${SERVICE_DATASETS.join(', ')}`);
        }
        if (this.#serviceDatasets.has(dataset.name)) {
          throw new StateError(`duplicate-dataset: "${dataset.name}" is already registered`);
        }
        this.#serviceDatasets.set(dataset.name, dataset);
      },
      publish: (datasetName, record) => {
        live('sync.publish');
        return this.#sync.publish(datasetName, record);
      },
      dataset: (datasetName) => {
        if (datasetName === LSA_DATASET) return this.#router.dataset;
        if (datasetName === PEER_DATASET) return this.#pex.dataset;
        return this.#serviceDatasets.get(datasetName) ?? null;
      },
    });
    const routing = Object.freeze({
      nextHop: (dst) => this.#router.nextHop(dst),
      isReachable: (dst) => this.#router.isReachable(dst),
      route: (dst) => this.#router.route(dst),
      routes: () => this.#router.routes(),
      caps: (id) => this.#router.caps(id),
      nodeIds: () => this.#router.nodeIds(),
      onRoutesChanged: (listener) => {
        requireFunction(listener, 'listener');
        const cancelRouter = this.#router.onRoutesChanged(listener);
        const subscription = {
          cancel: () => {
            cancelRouter();
            this.#routeListeners.delete(subscription);
          },
        };
        this.#routeListeners.add(subscription);
        return subscription.cancel;
      },
    });
    const api = Object.freeze({
      route: (method, path, handler, { summary } = {}) => {
        inInit('api.route');
        if (!API_METHODS.includes(method)) throw new ConfigError('method must be GET, POST or DELETE');
        if (typeof path !== 'string' || path.length > 256 || !API_PATH_PATTERN.test(path)) {
          throw new ConfigError('path must be /segment(/segment)*, a segment being [a-z0-9._-] or :param');
        }
        requireFunction(handler, 'handler');
        if (summary !== undefined && (typeof summary !== 'string' || summary.length > 200)) {
          throw new ConfigError('summary must be a string of at most 200 characters');
        }
        const key = `${method} ${path.replace(/:[a-zA-Z0-9]+/g, ':')}`;
        if (this.#apiKeys.has(key)) throw new StateError(`duplicate-route: ${method} ${path} is already registered`);
        this.#apiKeys.add(key);
        this.#apiRoutes.push(Object.freeze({ service: name, method, path, handler, summary: summary ?? null }));
      },
      reply: (status, body) => {
        if (!Number.isInteger(status) || status < 200 || status > 299) throw new ConfigError('reply status must be 2xx');
        return new ApiReply(status, body);
      },
      error: (status, code, message, details) => {
        if (!Number.isInteger(status) || status < 400 || status > 599) throw new ConfigError('error status must be 4xx or 5xx');
        if (typeof code !== 'string' || !API_CODE_PATTERN.test(code)) throw new ConfigError('error code must match /^[a-z][a-z_]{0,63}$/');
        const error = new ClawNetError('ERR_API', String(message ?? code).slice(0, MAX_ERROR_TEXT));
        error.status = status;
        error.apiCode = code;
        error.details = details ?? null;
        return error;
      },
      isReply: (value) => value instanceof ApiReply,
    });

    return Object.freeze({
      service: name,
      nodeId: identity.nodeId,
      boot: this.#boot,
      config: this.#config,
      identity: Object.freeze({
        nodeId: identity.nodeId,
        card: identity.card,
        signRecord: (type, fields) => identity.signRecord(type, fields),
        sign: (domain, bytes) => identity.sign(domain, bytes),
      }),
      events: this.#events,
      log,
      now: this.#now,
      rng: this.#rng,
      schedule: (fn, ms) => this.#timers.schedule(fn, ms, `service:${name}`),
      every: (fn, ms) => this.#timers.every(fn, ms, `service:${name}`),
      storage,
      messaging,
      packets,
      sync,
      routing,
      peers: Object.freeze({
        isLinked: (id) => this.#peers.isLinked(id),
        list: () => this.#peers.list(),
      }),
      directory: Object.freeze({
        cardOf: (id) => this.#pex.cardOf(id) ?? this.#peers.cardOf(id),
        e2eKeyOf: (id) => {
          const card = this.#pex.cardOf(id) ?? this.#peers.cardOf(id);
          if (card === null || !verifyCard(card).ok) return null;
          return base64Decode(card.e2e, KEY_BYTES);
        },
      }),
      api,
      node,
    });
  }

  async #sendChecked(dst, options = {}) {
    const limit = this.#config.limits.maxMessageBytes;
    const contentBytes = options?.content?.length ?? 0;
    let metaBytes = 0;
    if (options?.meta !== undefined) {
      try {
        metaBytes = canonicalBytes(options.meta).length;
      } catch (cause) {
        throw new ConfigError('meta must be canonical JSON data', { cause });
      }
    }
    if (contentBytes + metaBytes > limit) {
      throw new ConfigError(`message-too-large: meta and content exceed limits.maxMessageBytes (${limit})`);
    }
    return this.#messenger.send(dst, options);
  }

  // ===================================================================== public API

  /** @returns {object} the API.md 6.1 status document */
  status() {
    const running = this.#identity !== null;
    const now = this.#now();
    const lastSeq = this.#events.lastSeq;
    const peers = this.#peers;
    const messenger = running && this.#messenger !== null ? this.#messenger.stats() : null;
    return {
      nodeId: running ? this.#identity.nodeId : null,
      shortId: running ? shortId(this.#identity.nodeId) : null,
      agent: DEFAULT_AGENT,
      networkId: this.#config.networkId,
      state: this.#state,
      boot: this.#boot,
      startedAt: this.#startedAt,
      now,
      uptimeMs: this.#startedAt === null ? 0 : Math.max(0, now - this.#startedAt),
      listen: this.#listenText(),
      addresses: this.#ownAddresses(),
      caps: { ...this.#config.caps },
      peers: {
        linked: peers?.size ?? 0,
        dialing: peers?.dialing().length ?? 0,
        known: this.#book?.size ?? 0,
        target: this.#config.peers.target,
        max: this.#config.peers.max,
      },
      routing: {
        rev: this.#router?.rev ?? 0,
        nodes: this.#router?.nodeIds().length ?? 0,
        reachable: this.#router?.stats().reachable ?? 0,
        lsaSeq: this.#stateDoc?.data?.lsaSeq ?? 0,
      },
      messaging: {
        outbox: messenger?.outboxEntries ?? 0,
        outboxBytes: messenger?.outboxBytes ?? 0,
        waiting: messenger?.waiting ?? 0,
      },
      // The ring buffer holds the newest EVENT_BUS_CAPACITY events.
      events: { lastSeq, oldestSeq: lastSeq === 0 ? 0 : Math.max(1, lastSeq - EVENT_BUS_CAPACITY + 1) },
      services: this.#services.map((service) => service.name),
      asOf: { boot: this.#boot, seq: lastSeq },
    };
  }

  /** @returns {object} the API.md 6.2 identity document; never a private key */
  identityInfo() {
    if (this.#identity === null) throw new StateError('not-started: the identity is loaded by start()');
    const identity = this.#identity;
    return {
      nodeId: identity.nodeId,
      shortId: shortId(identity.nodeId),
      signPublicKey: base64Encode(identity.signPublicKey),
      card: { ...identity.card },
      keystoreEncrypted: this.#keystoreEncrypted,
      addresses: this.#ownAddresses(),
    };
  }

  /** @returns {object} the configuration with the network key redacted */
  configView() {
    const view = structuredClone(this.#config);
    if (view.networkKey !== null) view.networkKey = 'redacted';
    return view;
  }

  /** @returns {object[]} PeerInfo of every live link */
  listPeers() {
    return this.#peers?.list() ?? [];
  }

  /** @returns {object[]} DialInfo of every dial in flight */
  listDialing() {
    return this.#peers?.dialing() ?? [];
  }

  /** @returns {object[]} the address book */
  listKnownAddresses() {
    return this.#book?.entries() ?? [];
  }

  /**
   * Dial an address; it becomes sticky (redialed until disconnected).
   *
   * @param {string} addr "tcp://host:port"
   * @returns {Promise<object>} PeerInfo
   * @throws {StateError} if not running; {HandshakeError} with the reason the dial failed
   */
  async connect(addr) {
    this.#requireRunning();
    return this.#peers.connect(addr);
  }

  /**
   * Close the link to a node and forget its manually added addresses.
   *
   * @param {string} id
   * @returns {Promise<boolean>} whether a link existed
   */
  async disconnect(id) {
    this.#requireRunning();
    if (!isNodeId(id)) throw new ConfigError('id must be a NodeId');
    return this.#peers.disconnect(id);
  }

  /** @returns {object} the API.md 6.4 topology snapshot */
  topology() {
    if (this.#router === null) return { rev: 0, self: this.#identity?.nodeId ?? null, nodes: [], links: [] };
    return this.#router.topology();
  }

  /** @returns {object[]} every usable route, nearest first */
  routes() {
    return this.#router?.routes() ?? [];
  }

  /**
   * @param {string} id
   * @returns {{ node: object, lsa: object | null, peerRecord: object | null, route: object | null } | null}
   */
  nodeDetail(id) {
    if (this.#router === null || !isNodeId(id)) return null;
    const node = this.#router.topology().nodes.find((entry) => entry.id === id) ?? null;
    const peerRecord = this.#pex.recordOf(id);
    if (node === null && peerRecord === null) return null;
    return { node, lsa: this.#router.lsaOf(id), peerRecord, route: this.#router.route(id) };
  }

  /**
   * Send a sealed message (ReliableMessenger#send), within limits.maxMessageBytes.
   *
   * @param {string} dst
   * @param {{ kind: string, meta?: object, content?: Uint8Array, reliable?: boolean,
   *   lifetimeMs?: number, custody?: boolean }} options
   * @returns {Promise<{ id: string, state: 'sent' | 'waiting' | 'dropped' }>}
   * @throws {StateError} `not-running`, `unknown-destination`, `outbox-full`
   * @throws {ConfigError} for an invalid message
   */
  async send(dst, options) {
    this.#requireRunning();
    return this.#sendChecked(dst, options);
  }

  /** @returns {object[]} every unacknowledged reliable message, oldest first */
  outbox() {
    return this.#messenger?.pending() ?? [];
  }

  /** @returns {object} counters of every module, nested by module name */
  stats() {
    const services = {};
    for (const service of this.#services) {
      if (service.stats === undefined) continue;
      try {
        services[service.name] = service.stats();
      } catch (error) {
        services[service.name] = {};
        this.#log.warn('service stats failed', { service: service.name, message: errorText(error) });
      }
    }
    return {
      node: { ...this.#counters, timers: this.#timers.size },
      peers: this.#peers?.stats() ?? {},
      router: this.#router?.stats() ?? {},
      forwarder: this.#forwarder?.stats() ?? {},
      messaging: this.#messenger?.stats() ?? {},
      discovery: {
        pex: this.#pex?.stats() ?? {},
        bootstrap: this.#bootstrap?.stats() ?? {},
        multicast: this.#multicast?.stats() ?? {},
        governor: this.#governor?.stats() ?? {},
      },
      services,
    };
  }

  /** @returns {object} SyncEngine#stats() */
  syncStats() {
    return this.#sync?.stats() ?? {};
  }

  /**
   * @param {string} name
   * @returns {object | null} that service's `api`, or null
   */
  service(name) {
    return this.#services.find((service) => service.name === name)?.api ?? null;
  }

  /** @returns {Array<{ service, method, path, handler, summary }>} routes registered through ctx.api */
  apiRoutes() {
    return [...this.#apiRoutes];
  }
}

/**
 * A dataset of ARCHITECTURE.md 4.5 that no service registered: it stores and floods with
 * the default check of its record type (schema, then signature), so the node relays
 * correctly whatever services it runs.
 */
function relayOnlyDataset(name) {
  if (name === 'cast') {
    return new LogDataset({
      name,
      stream: (record) => `${record.chan}:${record.origin}`,
      index: (record) => record.n,
      check: (record) => checkRecord(record, validateCast, RecordType.CAST),
      maxPerStream: CAST_PER_STREAM,
      maxStreams: CAST_STREAMS,
    });
  }
  return new LwwDataset({
    name,
    key: (record) => `${record.origin}:${record.id}`,
    version: (record) => record.ts,
    check: (record) => checkRecord(record, validateReceipt, RecordType.RECEIPT),
    maxEntries: RECEIPT_ENTRIES,
  });
}

function checkRecord(record, validate, type) {
  if (!validate(record).ok) return { ok: false, reason: `invalid-${type}` };
  if (!verifyRecord(record, type).ok) return { ok: false, reason: 'bad-signature' };
  return { ok: true };
}
