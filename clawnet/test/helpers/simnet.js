/**
 * In-memory network of SyncEngines for tests.
 *
 * A SimNet holds nodes (each a real SyncEngine with its own datasets) and links between
 * them. Nothing is mocked inside the engines: the simulator only replaces the transport,
 * the clock and the timer, which are exactly the things the engine takes by injection.
 *
 * Model:
 *
 *   - A link is two directed FIFO queues. Order is preserved per direction, as on a TCP
 *     link; which queue delivers next is chosen by a seeded PRNG, so a run is fully
 *     determined by its seed and reproduces exactly.
 *   - Every packet crosses the real wire codec: it is encoded with core/wire/codec.js
 *     when sent (so a packet that breaks the header or packet limit fails the test at
 *     the point of sending) and the receiver gets the decoded copy, never the sender's
 *     objects.
 *   - Time is virtual. It advances by `latencyMs` per delivered packet and jumps to the
 *     next timer when the network is idle, so the engines' batch timers fire in a
 *     realistic rhythm without any real waiting. Nothing here touches real timers or
 *     sockets; there is nothing to leak.
 *   - Faults: cut() and link() take links down and up (queued packets of a cut link are
 *     discarded, as when a connection dies); setLoss() drops packets at random, like a
 *     link that dies mid-flight and comes back.
 *
 * Typical use:
 *
 *   const net = new SimNet({ seed: 7, datasets: id => [makeDataset(id)] });
 *   t.after(() => net.close());
 *   net.addNode('a'); net.addNode('b');
 *   net.link('a', 'b');
 *   net.node('a').engine.publish('kv', record);
 *   net.run();                       // until no packet and no timer is left
 *   net.rounds(2);                   // two sync intervals: tick every engine, then run
 *   assert.ok(net.agree('kv'));
 *
 * A *puppet* is a node without an engine, driven by the test: it records what it
 * receives and sends whatever the test gives it. Use it to play a hostile peer.
 */

import { decodePacket, encodePacket } from '../../src/core/wire/codec.js';
import { PACKET_TYPE_NAMES } from '../../src/core/wire/types.js';
import { SyncEngine } from '../../src/sync/antientropy.js';

/**
 * @typedef {object} SimNode
 * @property {string} id
 * @property {SyncEngine} engine
 * @property {Record<string, object>} sets  the node's datasets by name
 * @property {Array<{ peer: string, reason: string, detail: string }>} faults  everything
 *   the engine reported through onError, in order
 */

/**
 * @typedef {object} SimPuppet
 * @property {string} id
 * @property {Array<{ from: string, packet: object }>} inbox  packets received, in order
 * @property {(to: string, packet: object) => boolean} send  hand a packet to the network
 * @property {(type?: number) => object[]} take  remove and return the received packets,
 *   or only those of one packet type
 */

/**
 * @typedef {object} SimEvent
 * @property {string} from
 * @property {string} to
 * @property {{ type: number, header: object, body: Buffer }} packet  the packet as the
 *   receiver will see it; do not modify
 * @property {number} bytes  encoded size of the packet
 * @property {boolean} lost  whether the loss model dropped it
 */

/**
 * Small, fast, seedable PRNG (mulberry32). For reproducible tests only.
 *
 * @param {number} seed  any integer; only the low 32 bits are used
 * @returns {() => number} uniform values in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Edges of a random connected graph: a random spanning tree plus extra random edges.
 *
 * @param {string[]} ids         node ids, at least one
 * @param {number} extraEdges    edges to add beyond the spanning tree; capped at what a
 *   simple graph on these nodes can hold
 * @param {() => number} random  uniform values in [0, 1)
 * @returns {Array<[string, string]>} undirected edges, no duplicates, no self-loops
 */
export function randomConnectedGraph(ids, extraEdges, random) {
  const edges = [];
  const seen = new Set();
  const add = (a, b) => {
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (a === b || seen.has(key)) return false;
    seen.add(key);
    edges.push([a, b]);
    return true;
  };
  for (let i = 1; i < ids.length; i += 1) {
    add(ids[i], ids[Math.floor(random() * i)]);
  }
  const capacity = (ids.length * (ids.length - 1)) / 2;
  const target = Math.min(capacity, edges.length + extraEdges);
  while (edges.length < target) {
    add(ids[Math.floor(random() * ids.length)], ids[Math.floor(random() * ids.length)]);
  }
  return edges;
}

export class SimNet {
  #random;
  #now = 1_000_000;
  #latencyMs;
  #syncIntervalMs;
  #queueLimit;
  #makeDatasets;
  #engineOptions;
  /** id -> SimNode | SimPuppet */
  #members = new Map();
  /** from -> Map<to, { from, to, queue: SimEvent[], counters }> */
  #links = new Map();
  /** Directed links with a non-empty queue. */
  #busy = [];
  #timers = [];
  #timerSeq = 0;
  #lossRate = 0;
  #lossMatch = null;
  #taps = new Set();
  #counters = newCounters();

  /**
   * @param {object} [options]
   * @param {number} [options.seed=1]  seed of the PRNG that orders deliveries, decides
   *   losses and feeds the engines' `rng`
   * @param {(nodeId: string) => object[]} [options.datasets]  builds the datasets of a
   *   node; required unless every addNode() call passes its own
   * @param {object} [options.engine]  SyncEngine options applied to every node (limits,
   *   gossipBatchMs, roundTimeoutMs, ...). `send`, `monoNow`, `rng`, `schedule` and `onError`
   *   are supplied by the simulator; `self` defaults to the node id.
   * @param {number} [options.syncIntervalMs=20000]  virtual time between tick() calls
   * @param {number} [options.latencyMs=1]  virtual time one packet delivery takes
   * @param {number} [options.queueLimit=Infinity]  packets a directed link holds before
   *   send() returns false, to exercise back-pressure
   */
  constructor({
    seed = 1,
    datasets,
    engine = {},
    syncIntervalMs = 20_000,
    latencyMs = 1,
    queueLimit = Infinity,
  } = {}) {
    this.#random = mulberry32(seed);
    this.#makeDatasets = datasets;
    this.#engineOptions = engine;
    this.#syncIntervalMs = syncIntervalMs;
    this.#latencyMs = latencyMs;
    this.#queueLimit = queueLimit;
  }

  /** @returns {number} the virtual time in milliseconds */
  now() {
    return this.#now;
  }

  /** @returns {number} the next value of the simulator's PRNG, uniform in [0, 1) */
  random() {
    return this.#random();
  }

  /**
   * Add a node with a real SyncEngine. It starts with no links.
   *
   * @param {string} id
   * @param {object} [options]
   * @param {object[]} [options.datasets]  this node's datasets, instead of the factory's
   * @param {object} [options.engine]  SyncEngine options for this node only
   * @returns {SimNode}
   */
  addNode(id, { datasets, engine = {} } = {}) {
    this.#assertFree(id);
    const list = datasets ?? this.#makeDatasets(id);
    const node = { id, engine: null, sets: {}, faults: [] };
    for (const dataset of list) node.sets[dataset.name] = dataset;
    node.engine = new SyncEngine({
      self: id,
      ...this.#engineOptions,
      ...engine,
      datasets: list,
      send: (to, packet) => this.#transmit(id, to, packet),
      monoNow: () => this.#now,
      rng: this.#random,
      schedule: (fn, ms) => this.#schedule(fn, ms),
      onError: (peer, reason, detail) => node.faults.push({ peer, reason, detail }),
    });
    this.#members.set(id, node);
    return node;
  }

  /**
   * Add a node without an engine, driven by the test.
   *
   * @param {string} id
   * @returns {SimPuppet}
   */
  addPuppet(id) {
    this.#assertFree(id);
    const puppet = {
      id,
      inbox: [],
      send: (to, packet) => this.#transmit(id, to, packet),
      take: type => {
        const taken = [];
        const kept = [];
        for (const item of puppet.inbox) {
          if (type === undefined || item.packet.type === type) taken.push(item.packet);
          else kept.push(item);
        }
        puppet.inbox = kept;
        return taken;
      },
    };
    this.#members.set(id, puppet);
    return puppet;
  }

  /**
   * @param {string} id
   * @returns {SimNode | SimPuppet}
   */
  node(id) {
    const member = this.#members.get(id);
    if (member === undefined) throw new Error(`simnet: no node "${id}"`);
    return member;
  }

  /** @returns {SimNode[]} every node that has an engine, in the order they were added */
  nodes() {
    return [...this.#members.values()].filter(member => member.engine !== undefined);
  }

  /**
   * Bring a link up. Both engines are told through addPeer(), `a` first. A link that is
   * already up is left alone.
   *
   * @param {string} a
   * @param {string} b
   */
  link(a, b) {
    const first = this.node(a);
    const second = this.node(b);
    if (a === b) throw new Error('simnet: a node cannot link to itself');
    if (this.linked(a, b)) return;
    this.#open(a, b);
    this.#open(b, a);
    first.engine?.addPeer(b);
    second.engine?.addPeer(a);
  }

  /**
   * Take a link down. Packets still queued on it are discarded and both engines are told
   * through removePeer(). A link that is not up is left alone.
   *
   * @param {string} a
   * @param {string} b
   */
  cut(a, b) {
    if (!this.linked(a, b)) return;
    this.#close(a, b);
    this.#close(b, a);
    this.node(a).engine?.removePeer(b);
    this.node(b).engine?.removePeer(a);
  }

  /**
   * Cut every link between two groups of nodes.
   *
   * @param {string[]} groupA
   * @param {string[]} groupB
   * @returns {Array<[string, string]>} the links that were cut, to pass to link() later
   */
  cutBetween(groupA, groupB) {
    const cut = [];
    for (const a of groupA) {
      for (const b of groupB) {
        if (!this.linked(a, b)) continue;
        this.cut(a, b);
        cut.push([a, b]);
      }
    }
    return cut;
  }

  /**
   * @param {string} a
   * @param {string} b
   * @returns {boolean} whether the link between `a` and `b` is up
   */
  linked(a, b) {
    return this.#links.get(a)?.has(b) === true;
  }

  /**
   * Drop packets at random. A dropped packet still counts as sent for the sender (send()
   * returns true), as with a connection that dies after the write.
   *
   * @param {number} rate  probability in [0, 1]; 0 turns loss off
   * @param {(event: SimEvent) => boolean} [match]  restrict loss to matching packets
   */
  setLoss(rate, match) {
    this.#lossRate = rate;
    this.#lossMatch = match ?? null;
  }

  /**
   * Observe every packet handed to the network, at the moment it is sent.
   *
   * @param {(event: SimEvent) => void} observer
   * @returns {() => void} call to stop observing
   */
  tap(observer) {
    this.#taps.add(observer);
    return () => this.#taps.delete(observer);
  }

  /**
   * Do one thing: fire a due timer, else deliver one packet, else jump to the next
   * timer and fire it.
   *
   * @returns {boolean} false if there was nothing to do: the network is quiescent
   */
  step() {
    if (this.#fireDue()) return true;
    if (this.#busy.length > 0) {
      this.#deliver();
      return true;
    }
    if (this.#timers.length === 0) return false;
    this.#now = Math.max(this.#now, this.#earliest().at);
    return this.#fireDue();
  }

  /**
   * Run until the network is quiescent: no packet queued, no timer pending.
   *
   * @param {object} [options]
   * @param {number} [options.maxSteps=2000000]  fail instead of spinning for ever
   * @returns {number} steps taken
   */
  run({ maxSteps = 2_000_000 } = {}) {
    let steps = 0;
    while (this.step()) {
      steps += 1;
      if (steps > maxSteps) throw new Error(`simnet: not quiescent after ${maxSteps} steps`);
    }
    return steps;
  }

  /**
   * One sync interval passes: advance the clock by `syncIntervalMs` and call tick() on
   * every engine, in the order the nodes were added. Does not deliver anything; follow
   * with run().
   */
  tick() {
    this.#now += this.#syncIntervalMs;
    for (const node of this.nodes()) node.engine.tick();
  }

  /**
   * Let `count` sync intervals pass, running the network to quiescence after each.
   *
   * @param {number} count
   */
  rounds(count) {
    for (let i = 0; i < count; i += 1) {
      this.tick();
      this.run();
    }
  }

  /**
   * @param {string} setName
   * @returns {boolean} whether every node that runs the dataset has the same digest()
   */
  agree(setName) {
    let reference = null;
    for (const node of this.nodes()) {
      const dataset = node.sets[setName];
      if (dataset === undefined) continue;
      const digest = JSON.stringify(dataset.digest());
      if (reference === null) reference = digest;
      else if (digest !== reference) return false;
    }
    return true;
  }

  /**
   * @returns {{ sent: number, delivered: number, lost: number, cut: number, refused: number,
   *   bytes: number, byType: Record<string, { sent: number, delivered: number, lost: number,
   *   bytes: number }> }}  a snapshot of the network counters since the start or the last
   *   resetCounters(). `sent` includes packets that were then lost or cut; `refused`
   *   counts send() calls that returned false; `byType` is keyed by packet type name.
   */
  counters() {
    return snapshot(this.#counters);
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {{ sent: number, delivered: number, lost: number, bytes: number }} counters
   *   of one directed link since it last came up
   */
  linkCounters(from, to) {
    const link = this.#links.get(from)?.get(to);
    if (link === undefined) throw new Error(`simnet: no link ${from} -> ${to}`);
    return { ...link.counters };
  }

  /** Zero the network counters (not the per-link ones). */
  resetCounters() {
    this.#counters = newCounters();
  }

  /** Close every engine and discard queued packets and timers. */
  close() {
    for (const node of this.nodes()) node.engine.close();
    this.#links.clear();
    this.#busy = [];
    this.#timers = [];
  }

  #assertFree(id) {
    if (typeof id !== 'string' || id === '') throw new Error('simnet: node id must be a string');
    if (this.#members.has(id)) throw new Error(`simnet: node "${id}" exists already`);
  }

  #open(from, to) {
    let outgoing = this.#links.get(from);
    if (outgoing === undefined) {
      outgoing = new Map();
      this.#links.set(from, outgoing);
    }
    outgoing.set(to, {
      from,
      to,
      queue: [],
      counters: { sent: 0, delivered: 0, lost: 0, bytes: 0 },
    });
  }

  #close(from, to) {
    const outgoing = this.#links.get(from);
    const link = outgoing.get(to);
    outgoing.delete(to);
    this.#counters.cut += link.queue.length;
    link.queue.length = 0;
    const at = this.#busy.indexOf(link);
    if (at !== -1) this.#busy.splice(at, 1);
  }

  #transmit(from, to, packet) {
    const link = this.#links.get(from)?.get(to);
    if (link === undefined || link.queue.length >= this.#queueLimit) {
      this.#counters.refused += 1;
      return false;
    }
    // Encoding enforces the header and packet limits; decoding gives the receiver its
    // own copy, as a real link would.
    const bytes = encodePacket(packet);
    const event = { from, to, packet: decodePacket(bytes), bytes: bytes.length, lost: false };
    if (this.#lossRate > 0 && (this.#lossMatch === null || this.#lossMatch(event))) {
      event.lost = this.#random() < this.#lossRate;
    }

    const byType = typeCounters(this.#counters, packet.type);
    this.#counters.sent += 1;
    this.#counters.bytes += event.bytes;
    byType.sent += 1;
    byType.bytes += event.bytes;
    link.counters.sent += 1;
    link.counters.bytes += event.bytes;
    if (event.lost) {
      this.#counters.lost += 1;
      byType.lost += 1;
      link.counters.lost += 1;
    }
    for (const observer of this.#taps) observer(event);

    if (!event.lost) {
      link.queue.push(event);
      if (link.queue.length === 1) this.#busy.push(link);
    }
    return true;
  }

  #deliver() {
    const at = Math.floor(this.#random() * this.#busy.length);
    const link = this.#busy[at];
    const event = link.queue.shift();
    if (link.queue.length === 0) this.#busy.splice(at, 1);

    this.#now += this.#latencyMs;
    this.#counters.delivered += 1;
    typeCounters(this.#counters, event.packet.type).delivered += 1;
    link.counters.delivered += 1;

    const target = this.#members.get(event.to);
    if (target.engine !== undefined) target.engine.handlePacket(event.from, event.packet);
    else target.inbox.push({ from: event.from, packet: event.packet });
  }

  #schedule(fn, ms) {
    const timer = { at: this.#now + ms, seq: this.#timerSeq, fn };
    this.#timerSeq += 1;
    this.#timers.push(timer);
    return () => {
      const at = this.#timers.indexOf(timer);
      if (at !== -1) this.#timers.splice(at, 1);
    };
  }

  #earliest() {
    let best = this.#timers[0];
    for (const timer of this.#timers) {
      if (timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) best = timer;
    }
    return best;
  }

  /** Fire the earliest timer if it is due. */
  #fireDue() {
    if (this.#timers.length === 0) return false;
    const timer = this.#earliest();
    if (timer.at > this.#now) return false;
    this.#timers.splice(this.#timers.indexOf(timer), 1);
    timer.fn();
    return true;
  }
}

function newCounters() {
  return { sent: 0, delivered: 0, lost: 0, cut: 0, refused: 0, bytes: 0, byType: {} };
}

function typeCounters(counters, type) {
  const name = PACKET_TYPE_NAMES[type] ?? String(type);
  let entry = counters.byType[name];
  if (entry === undefined) {
    entry = { sent: 0, delivered: 0, lost: 0, bytes: 0 };
    counters.byType[name] = entry;
  }
  return entry;
}

function snapshot(counters) {
  const byType = {};
  for (const [name, entry] of Object.entries(counters.byType)) byType[name] = { ...entry };
  return { ...counters, byType };
}
