/**
 * A cluster of real ClawNodes on loopback TCP, for integration tests (ARCHITECTURE.md
 * 10.2). Every node has its own temporary data directory and identity; links exist only
 * where the test makes them, directly or through a netem proxy. Everything runs on one
 * machine.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClawNode } from '../../src/core/node.js';
import { createNetem } from './netem.js';
import { removeDir } from './tmp.js';

/** Short timers so that tests run the real code paths in milliseconds. */
export const FAST_TIMERS = Object.freeze({
  keepaliveMs: 200,
  peerTimeoutMs: 800,
  handshakeTimeoutMs: 2000,
  redialMinMs: 100,
  redialMaxMs: 1000,
  redialJitter: 0.2,
  lsaRefreshMs: 1000,
  lsaMaxAgeMs: 3500,
  lsaTombstoneMs: 60000,
  // Must stay below lsaMaxAgeMs or validateConfig refuses the configuration.
  lsaMinIntervalMs: 50,
  spfDebounceMs: 10,
  syncIntervalMs: 300,
  gossipBatchMs: 5,
  retransmitMinMs: 200,
  retransmitMaxMs: 2000,
  transitHoldMs: 2000,
  beaconIntervalMs: 200,
});

/** The network the cluster's nodes belong to unless a test says otherwise. */
export const CLUSTER_NETWORK = 'clawnet-cluster';

/** A logger that drops everything; tests read events, not log lines. */
export const SILENT_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge `layer` over `base`: objects key by key, everything else replaced.
 *
 * @param {object} base
 * @param {object} [layer]
 * @returns {object} a new object
 */
export function mergeConfig(base, layer) {
  if (!isPlainObject(layer)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(layer)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * The defaults of 10.2: loopback listener on port 0, no API, no multicast, no pex, no
 * bootstrap, fast timers. `allowLoopback` is on so that a test that turns pex on can
 * dial what it learns over loopback.
 *
 * @returns {object} partial configuration
 */
export function clusterConfig() {
  return {
    networkId: CLUSTER_NETWORK,
    listen: { host: '127.0.0.1', port: 0 },
    api: { enabled: false, host: '127.0.0.1', port: 0 },
    discovery: { multicast: { enabled: false }, pex: false, bootstrap: [], allowLoopback: true },
    peers: { target: 0 },
    timers: { ...FAST_TIMERS },
  };
}

/**
 * A service that receives sealed messages of one kind and lets the test send them,
 * fetch the encoded packet of an outbox entry, and inject routed packets. It records
 * every handler call, so a test can see whether the messenger delivered twice.
 *
 * @param {{ name?: string, kind?: string }} [options]
 * @returns {object} a Service (ARCHITECTURE.md section 6)
 */
export function createNoteService({ name = 'notes', kind = 'note' } = {}) {
  const received = [];
  let ctx = null;
  const context = () => {
    if (ctx === null) throw new Error('the note service is not running');
    return ctx;
  };
  return {
    name,
    init(serviceContext) {
      ctx = serviceContext;
      serviceContext.messaging.onKind(kind, (message) => {
        received.push({
          id: message.id,
          from: message.from,
          text: Buffer.from(message.content).toString('utf8'),
          prevHop: message.prevHop,
        });
      });
    },
    stop() {
      ctx = null;
    },
    stats() {
      return { received: received.length };
    },
    api: {
      received,
      send: (dst, text, options = {}) => context().messaging.send(dst, { kind, content: Buffer.from(text, 'utf8'), ...options }),
      packetOf: (id) => context().messaging.packetOf(id),
      originate: (packet) => context().packets.originate(packet),
      context,
    },
  };
}

function edgesOf(topology, size) {
  if (Array.isArray(topology)) return topology.map(([i, j]) => [i, j]);
  const edges = [];
  if (topology === 'line' || topology === 'ring') {
    for (let i = 0; i + 1 < size; i += 1) edges.push([i, i + 1]);
    if (topology === 'ring' && size > 2) edges.push([size - 1, 0]);
  } else if (topology === 'star') {
    for (let i = 1; i < size; i += 1) edges.push([i, 0]);
  } else if (topology === 'mesh') {
    for (let i = 0; i < size; i += 1) for (let j = i + 1; j < size; j += 1) edges.push([i, j]);
  } else if (topology !== 'none') {
    throw new Error(`unknown topology ${topology}`);
  }
  return edges;
}

/**
 * Start a cluster and register its closing with the test.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} options
 * @param {number} options.size
 * @param {'none' | 'line' | 'ring' | 'star' | 'mesh' | Array<[number, number]>} [options.topology]
 *   for each edge [i, j], node i dials node j
 * @param {boolean} [options.netem] every edge through its own proxy
 * @param {(i: number) => object} [options.config] partial config merged over the defaults
 * @param {(i: number) => object[]} [options.services] services of node i
 * @param {boolean} [options.start] start the nodes and make the edges (default true)
 * @returns {Promise<Cluster>}
 */
export async function startCluster(t, { size, topology = 'none', netem = false, config, services, start = true } = {}) {
  const cluster = new Cluster({ config, services });
  t.after(() => cluster.close());
  for (let i = 0; i < size; i += 1) await cluster.addNode(undefined, { start: false });
  if (start) {
    await Promise.all(cluster.nodes.map((_, i) => cluster.startNode(i)));
    for (const [i, j] of edgesOf(topology, size)) await cluster.connect(i, j, { netem });
  }
  return cluster;
}

export class Cluster {
  /** @type {ClawNode[]} */
  nodes = [];
  /** @type {string[]} */
  ids = [];
  /** @type {string[]} */
  dirs = [];
  #configs = [];
  #services;
  #baseConfig;
  #running = [];
  /** @type {Array<{ i: number, j: number, proxy: object | null, cut: boolean }>} */
  #edges = [];
  #closed = false;

  /**
   * @param {{ config?: (i: number) => object, services?: (i: number) => object[] }} [options]
   */
  constructor({ config, services } = {}) {
    this.#baseConfig = config ?? (() => ({}));
    this.#services = services ?? (() => []);
  }

  /**
   * Create a node with a fresh directory and start it (unless `start: false`).
   *
   * @param {object} [overrides] partial config merged last
   * @param {{ start?: boolean }} [options]
   * @returns {Promise<number>} its index
   */
  async addNode(overrides, { start = true } = {}) {
    const i = this.nodes.length;
    const dir = await mkdtemp(join(tmpdir(), 'clawnet-cluster-'));
    this.dirs.push(dir);
    this.#configs.push(mergeConfig(mergeConfig(clusterConfig(), this.#baseConfig(i)), overrides));
    this.nodes.push(this.#makeNode(i));
    this.ids.push(null);
    this.#running.push(false);
    if (start) await this.startNode(i);
    return i;
  }

  /**
   * Start node i (a node that was created with `start: false`).
   *
   * @param {number} i
   */
  async startNode(i) {
    await this.nodes[i].start();
    this.ids[i] = this.nodes[i].id;
    this.#running[i] = true;
  }

  /**
   * @param {number} i
   * @returns {boolean}
   */
  isRunning(i) {
    return this.#running[i] === true;
  }

  /**
   * @param {number} i
   * @returns {string} the node's direct listener address
   */
  addressOf(i) {
    return `tcp://127.0.0.1:${this.nodes[i].listenAddress.port}`;
  }

  /**
   * @param {number} i
   * @param {number} j
   * @returns {object | null} the proxy on the edge between i and j, if any
   */
  link(i, j) {
    return this.#edge(i, j)?.proxy ?? null;
  }

  /**
   * Node i dials node j, directly or through a new proxy.
   *
   * @param {number} i
   * @param {number} j
   * @param {{ netem?: boolean }} [options]
   * @returns {Promise<object | null>} the proxy, if one was made
   */
  async connect(i, j, { netem = false } = {}) {
    let proxy = null;
    if (netem) {
      proxy = await createNetem({ target: { host: '127.0.0.1', port: this.nodes[j].listenAddress.port } });
    }
    const edge = { i, j, proxy, cut: false };
    this.#edges.push(edge);
    await this.nodes[i].connect(proxy === null ? this.addressOf(j) : proxy.address);
    return proxy;
  }

  /**
   * Close the link between i and j for good (no redial).
   *
   * @param {number} i
   * @param {number} j
   */
  async disconnect(i, j) {
    const edge = this.#edge(i, j);
    if (edge !== undefined) {
      this.#edges.splice(this.#edges.indexOf(edge), 1);
    }
    await this.nodes[i].disconnect(this.ids[j]);
    await this.nodes[j].disconnect(this.ids[i]);
    await edge?.proxy?.close();
  }

  /**
   * Cut every proxied edge between the two groups.
   *
   * @param {number[]} groupA
   * @param {number[]} groupB
   * @throws {Error} if a crossing edge has no proxy
   */
  partition(groupA, groupB) {
    const a = new Set(groupA);
    const b = new Set(groupB);
    for (const edge of this.#edges) {
      const crosses = (a.has(edge.i) && b.has(edge.j)) || (b.has(edge.i) && a.has(edge.j));
      if (!crosses) continue;
      if (edge.proxy === null) throw new Error(`edge ${edge.i}-${edge.j} crosses the partition but has no proxy`);
      edge.proxy.cut();
      edge.cut = true;
    }
  }

  /** Heal every proxy: accept connections again and stop blackholing. */
  heal() {
    for (const edge of this.#edges) {
      edge.proxy?.heal();
      edge.cut = false;
    }
  }

  /**
   * @param {number} i
   */
  async stopNode(i) {
    this.#running[i] = false;
    await this.nodes[i].stop();
  }

  /**
   * Start node i again on its data directory (same identity, new port), re-create the
   * proxies in front of it and redial its edges to running nodes.
   *
   * @param {number} i
   * @returns {Promise<ClawNode>}
   */
  async restartNode(i) {
    if (this.#running[i]) await this.stopNode(i);
    const previousId = this.ids[i];
    this.nodes[i] = this.#makeNode(i);
    await this.startNode(i);
    if (previousId !== null && this.ids[i] !== previousId) throw new Error('a restarted node changed its identity');
    for (const edge of this.#edges) {
      if (edge.j === i && edge.proxy !== null) {
        await edge.proxy.close();
        edge.proxy = await createNetem({ target: { host: '127.0.0.1', port: this.nodes[i].listenAddress.port } });
        if (edge.cut) edge.proxy.cut();
      }
      if ((edge.i !== i && edge.j !== i) || edge.cut) continue;
      if (!this.#running[edge.i] || !this.#running[edge.j]) continue;
      await this.nodes[edge.i].connect(edge.proxy === null ? this.addressOf(edge.j) : edge.proxy.address);
    }
    return this.nodes[i];
  }

  /**
   * @param {number} i
   * @param {string} type
   * @returns {unknown[]} the data of every event of that type still in node i's buffer
   */
  events(i, type) {
    return this.nodes[i].events.recent({ types: [type] }).map((event) => event.data);
  }

  /**
   * Poll until `predicate` holds.
   *
   * @param {() => boolean | Promise<boolean>} predicate
   * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [options]
   * @throws {Error} naming `message` and every node's status on timeout
   */
  async waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, message = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) {
        const status = this.nodes.map((node, i) => {
          const s = node.status();
          return `#${i} ${s.shortId} ${s.state} linked=${s.peers.linked} nodes=${s.routing.nodes} reachable=${s.routing.reachable} outbox=${s.messaging.outbox}`;
        });
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}\n${status.join('\n')}`);
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Wait for the next event of a type on node i.
   *
   * @param {number} i
   * @param {string} type
   * @param {(data: unknown) => boolean} [predicate]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<object>} the BusEvent
   */
  waitForEvent(i, type, predicate = () => true, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${type} on node ${i}`));
      }, timeoutMs);
      off = this.nodes[i].events.on(type, (event) => {
        if (!predicate(event.data)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  /**
   * Send a note from node `from` to node `to` (both running the note service) and wait
   * for its acknowledgement.
   *
   * @param {number} from
   * @param {number} to
   * @param {string} text
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<string>} the message id
   */
  async deliver(from, to, text, { timeoutMs = 6000 } = {}) {
    const acked = [];
    const off = this.nodes[from].events.on('message.acked', (event) => acked.push(event.data.id));
    try {
      const { id } = await this.nodes[from].service('notes').send(this.ids[to], text);
      await this.waitFor(() => acked.includes(id), { timeoutMs, message: `the ack of a message from ${from} to ${to}` });
      return id;
    } finally {
      off();
    }
  }

  /**
   * Wait until every running node has a route to every running node it is connected to
   * through running nodes and uncut edges, with the direct links confirmed by both LSAs
   * and the peer record of every reachable node held, and no route to any other node.
   *
   * @param {{ timeoutMs?: number }} [options]
   */
  async converged({ timeoutMs = 5000 } = {}) {
    await this.waitFor(() => this.#isConverged(), { timeoutMs, message: 'routing convergence' });
  }

  /** Stop every node, close every proxy, remove every directory. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.nodes.map((node) => node.stop()));
    await Promise.allSettled(this.#edges.map((edge) => edge.proxy?.close()));
    await Promise.allSettled(this.dirs.map((dir) => removeDir(dir)));
  }

  #makeNode(i) {
    return new ClawNode({
      config: this.#configs[i],
      dataDir: this.dirs[i],
      services: this.#services(i),
      logger: SILENT_LOGGER,
    });
  }

  #edge(i, j) {
    return this.#edges.find((edge) => (edge.i === i && edge.j === j) || (edge.i === j && edge.j === i));
  }

  #isConverged() {
    const live = this.nodes.map((_, i) => i).filter((i) => this.#running[i]);
    const adjacent = new Map(live.map((i) => [i, new Set()]));
    for (const edge of this.#edges) {
      if (edge.cut || !this.#running[edge.i] || !this.#running[edge.j]) continue;
      adjacent.get(edge.i).add(edge.j);
      adjacent.get(edge.j).add(edge.i);
    }
    const component = new Map();
    for (const start of live) {
      if (component.has(start)) continue;
      const queue = [start];
      component.set(start, start);
      while (queue.length > 0) {
        const at = queue.shift();
        for (const next of adjacent.get(at)) {
          if (!component.has(next)) {
            component.set(next, start);
            queue.push(next);
          }
        }
      }
    }
    for (const i of live) {
      const routes = new Set(this.nodes[i].routes().map((route) => route.dst));
      const topology = this.nodes[i].topology();
      const confirmed = new Set(topology.links.filter((link) => link.state === 'confirmed').map((link) => `${link.a}|${link.b}`));
      for (const j of live) {
        if (j === i) continue;
        const should = component.get(i) === component.get(j);
        if (routes.has(this.ids[j]) !== should) return false;
        // The card directory too: a node can seal to j only once it holds j's peer record.
        if (should && this.nodes[i].nodeDetail(this.ids[j])?.peerRecord == null) return false;
      }
      for (const j of adjacent.get(i)) {
        const [a, b] = this.ids[i] < this.ids[j] ? [this.ids[i], this.ids[j]] : [this.ids[j], this.ids[i]];
        if (!confirmed.has(`${a}|${b}`)) return false;
      }
    }
    return true;
  }
}
