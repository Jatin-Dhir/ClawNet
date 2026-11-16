/**
 * `clawnet devnet`: a whole network on this machine, for development and demos.
 *
 * It starts N real node processes (`clawnet start`) on loopback, each with its own data
 * directory, identity and ports, and joins them in the topology asked for. Nothing here is
 * simulated, and nothing is reachable from another machine: every listener is bound to
 * 127.0.0.1.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile } from '../vault/store.js';
import { ApiClient, TOKEN_FILE } from './client.js';
import { CliError } from './errors.js';
import { initIdentity } from './lifecycle.js';

/** Network id of every devnet; its nodes never mix with a real network. */
export const DEVNET_NETWORK = 'clawnet-devnet';

/** The topologies `devnet` can build. */
export const TOPOLOGIES = Object.freeze(['line', 'ring', 'star', 'mesh']);

/** Most nodes one devnet may have. */
export const MAX_DEVNET_NODES = 32;

/**
 * Timers of a devnet node. Shorter than the defaults so that a network of a few nodes
 * converges in a second or two, and long enough not to flap on a busy laptop.
 */
export const DEVNET_TIMERS = Object.freeze({
  keepaliveMs: 2000,
  peerTimeoutMs: 8000,
  lsaRefreshMs: 15000,
  lsaMaxAgeMs: 60000,
  lsaMinIntervalMs: 250,
  spfDebounceMs: 20,
  syncIntervalMs: 3000,
  gossipBatchMs: 10,
  retransmitMinMs: 1000,
});

/** Path of `bin/clawnet.js`, which the children run. */
export const BIN_PATH = fileURLToPath(new URL('../../bin/clawnet.js', import.meta.url));

const READY_TIMEOUT_MS = 20_000;
const MESH_TIMEOUT_MS = 20_000;
const EXIT_GRACE_MS = 5000;
const KILL_GRACE_MS = 1000;
const LOG_TAIL_BYTES = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The links of a topology: `[i, j]` means node i dials node j, always with `j < i` so that
 * the node being dialed is already running.
 *
 * @param {string} topology one of TOPOLOGIES
 * @param {number} size
 * @returns {Array<[number, number]>}
 * @throws {CliError} for an unknown topology
 */
export function devnetEdges(topology, size) {
  if (!TOPOLOGIES.includes(topology)) throw new CliError(`unknown topology "${topology}"; use ${TOPOLOGIES.join(', ')}`);
  const edges = [];
  if (topology === 'line' || topology === 'ring') {
    for (let i = 1; i < size; i += 1) edges.push([i, i - 1]);
    if (topology === 'ring' && size > 2) edges.push([size - 1, 0]);
  } else if (topology === 'star') {
    for (let i = 1; i < size; i += 1) edges.push([i, 0]);
  } else {
    for (let i = 1; i < size; i += 1) for (let j = 0; j < i; j += 1) edges.push([i, j]);
  }
  return edges;
}

/** The environment of a child: the parent's, without any CLAWNET_* setting that would override the devnet's own. */
function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('CLAWNET_')));
}

async function tail(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text.slice(-LOG_TAIL_BYTES).trim();
  } catch {
    return '';
  }
}

/** Resolve with the `ready` line a `clawnet start` child prints, or reject if it exits first. */
function waitReady(child, logFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(async () => {
      done(reject, new CliError(`a devnet node did not become ready within ${timeoutMs} ms\n${await tail(logFile)}`));
    }, timeoutMs);
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message?.event === 'ready') done(resolve, message);
      } catch {
        // Only the ready line is JSON on standard output; anything else is ignored.
      }
    });
    child.once('exit', async (code) => {
      done(reject, new CliError(`a devnet node exited with code ${code} before it was ready\n${await tail(logFile)}`));
    });
    child.once('error', (error) => done(reject, new CliError(`cannot start a devnet node: ${error.message}`)));
  });
}

/**
 * Start a devnet.
 *
 * @param {object} options
 * @param {number} options.nodes how many nodes, 1 to MAX_DEVNET_NODES
 * @param {string} [options.baseDir] where the nodes' directories go (`node-0` ...); a
 *   temporary directory, removed by `stop()`, when omitted
 * @param {'line' | 'ring' | 'star' | 'mesh'} [options.topology] default `mesh`
 * @param {Record<string, string | undefined>} [options.env] parent environment
 * @param {number} [options.readyTimeoutMs]
 * @returns {Promise<{ baseDir: string, nodes: Array<{ index: number, nodeId: string, dataDir: string,
 *   listen: string, api: string, pid: number, console: string }>, exited: Promise<void>,
 *   stop: () => Promise<void> }>} `console` is the node's console URL with its token in the
 *   fragment; `exited` settles when every node process has ended; `stop()` stops them all
 * @throws {CliError} if a node cannot be started or the network does not form; nothing is
 *   left running in that case
 */
export async function startDevnet({
  nodes: count,
  baseDir,
  topology = 'mesh',
  env = process.env,
  readyTimeoutMs = READY_TIMEOUT_MS,
}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DEVNET_NODES) {
    throw new CliError(`--nodes must be a number from 1 to ${MAX_DEVNET_NODES}`);
  }
  const edges = devnetEdges(topology, count);
  const ownsBaseDir = baseDir === undefined;
  const root = ownsBaseDir ? await mkdtemp(join(tmpdir(), 'clawnet-devnet-')) : resolve(baseDir);
  await mkdir(root, { recursive: true });

  const children = [];
  const exits = [];
  const stop = async () => {
    await Promise.all(children.map((entry) => stopChild(entry)));
    if (ownsBaseDir) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  try {
    // Identities first: every node's allow list needs its neighbours' ids.
    const prepared = [];
    for (let i = 0; i < count; i += 1) {
      const dataDir = join(root, `node-${i}`);
      const { nodeId } = await initIdentity({ dataDir, networkId: DEVNET_NETWORK });
      prepared.push({ index: i, dataDir, nodeId });
    }
    const neighbours = prepared.map(() => new Set());
    for (const [i, j] of edges) {
      neighbours[i].add(j);
      neighbours[j].add(i);
    }
    for (const node of prepared) {
      const config = {
        networkId: DEVNET_NETWORK,
        listen: { host: '127.0.0.1', port: 0 },
        api: { host: '127.0.0.1', port: 0 },
        // Exactly the asked-for topology: with no multicast and no peer exchange a node
        // dials only its bootstrap addresses, and it stops looking once it has as many
        // links as neighbours. (`peers.allow` cannot shape the topology: it also filters
        // the origins of routing records, so a node would never learn of a node two hops
        // away. DESIGN.md section 15 item 19.)
        discovery: { multicast: { enabled: false }, pex: false, allowLoopback: true },
        peers: { target: neighbours[node.index].size },
        timers: { ...DEVNET_TIMERS },
      };
      await atomicWriteFile(join(node.dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    }

    // Start in order, each with the addresses of the lower-numbered neighbours it dials.
    const started = [];
    for (const node of prepared) {
      const bootstrap = edges.filter(([i]) => i === node.index).map(([, j]) => started[j].listen);
      const logFile = join(node.dataDir, 'node.log');
      const args = [BIN_PATH, 'start', '--data-dir', node.dataDir, '--no-multicast', ...bootstrap.flatMap((address) => ['--bootstrap', address])];
      const logFd = openSync(logFile, 'a');
      let child;
      try {
        child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', logFd], env: childEnv(env), windowsHide: true });
      } finally {
        closeSync(logFd);
      }
      const entry = { child, exited: new Promise((resolve) => child.once('exit', resolve)), done: false };
      entry.exited.then(() => {
        entry.done = true;
      });
      children.push(entry);
      exits.push(entry.exited);
      const ready = await waitReady(child, logFile, readyTimeoutMs);
      const token = (await readFile(join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
      entry.client = new ApiClient({ url: ready.api, token });
      started.push({
        index: node.index,
        nodeId: ready.nodeId,
        dataDir: node.dataDir,
        listen: ready.listen,
        api: ready.api,
        pid: child.pid,
        console: `${ready.api}/#token=${token}`,
        expected: neighbours[node.index].size,
        client: entry.client,
      });
    }

    await waitForNetwork(started, MESH_TIMEOUT_MS);
    return {
      baseDir: root,
      nodes: started.map(({ expected: _expected, client: _client, ...node }) => node),
      exited: Promise.all(exits).then(() => undefined),
      stop,
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/**
 * Wait until the network is usable, not merely linked: every node has linked to all of its
 * neighbours, has a route to every other node, and holds every other node's identity card
 * (without which it cannot seal a message to it).
 */
async function waitForNetwork(nodes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const ready = async () => {
    const statuses = await Promise.all(nodes.map((node) => node.client.request('GET', '/status')));
    if (!statuses.every((status, i) => status.peers.linked >= nodes[i].expected && status.routing.reachable >= nodes.length - 1)) return false;
    const known = await Promise.all(nodes.flatMap((node) => nodes
      .filter((other) => other !== node)
      .map((other) => node.client.request('GET', `/topology/nodes/${other.nodeId}`).then((detail) => detail.peerRecord !== null, () => false))));
    return known.every(Boolean);
  };
  while (!(await ready())) {
    if (Date.now() > deadline) throw new CliError(`the devnet did not form within ${timeoutMs} ms`);
    await sleep(100);
  }
}

/** Ask a child to stop through its API, then insist: terminate after the grace period, kill after another. */
async function stopChild(entry) {
  if (entry.done) return;
  // A child that never became ready has no API to ask: go straight to terminating it.
  if (entry.client !== undefined) await entry.client.request('POST', '/shutdown', {}).catch(() => {});
  const waitFor = async (ms) => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([entry.exited, timeout]);
    clearTimeout(timer);
    return entry.done;
  };
  if (await waitFor(entry.client === undefined ? 0 : EXIT_GRACE_MS)) return;
  entry.child.kill('SIGTERM');
  if (await waitFor(KILL_GRACE_MS)) return;
  entry.child.kill('SIGKILL');
  await waitFor(KILL_GRACE_MS);
}
