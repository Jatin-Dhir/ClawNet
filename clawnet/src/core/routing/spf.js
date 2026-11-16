/**
 * Shortest-path-first route computation (DESIGN.md section 7).
 *
 * Dijkstra over the confirmed link-state graph, from this node to every other node.
 *
 * Forwarding is hop by hop: each node on a path looks up its own next hop. That only
 * delivers packets if every node, given the same graph, picks the same path, so ties
 * are not left to iteration order. A path is ranked by
 *
 *     (total cost, number of hops, the ids of its nodes in order)
 *
 * compared left to right, the node ids as a sequence, and the smallest wins. Under this
 * order the best path from a to t, cut at any node n on it, leaves the best path from n
 * to t: a better one from n would give a better one from a. So the next hop is the
 * smallest among the equally good ones at every node, and the path reported here is
 * the path a packet really takes when each node forwards to its own next hop.
 *
 * It is computed in two steps, because a whole node sequence is not a label Dijkstra
 * can compare in constant time:
 *
 *   1. Dijkstra on the label (cost, hops, id of the first hop). Extending two paths by
 *      the same link keeps their order and never makes a path rank lower than its
 *      prefix, which is the property Dijkstra needs to be exact for such an ordering.
 *      This settles each route's cost, hop count and next hop.
 *   2. Predecessors, one hop count at a time. Every best path to a node with h hops
 *      arrives over a "tight" link from a node with h - 1 hops (one whose label plus
 *      the link gives exactly the node's label), and all such paths have the same
 *      length, so the smallest sequence is the one whose predecessor has the smallest
 *      sequence. The nodes of each hop count are put in the order of their paths, and
 *      each claims the nodes it has a tight link to that no earlier one has claimed.
 *
 * The graph describes other nodes and is built from their advertisements, so nothing in
 * it is taken on trust: a link is used only if both directions are present with a valid
 * cost, and the work is O((V + E) log V) with O(V) memory whatever the graph looks like.
 */

import { ConfigError } from '../errors.js';

/**
 * A computed route.
 *
 * @typedef {object} Route
 * @property {string} nextHop   neighbor to hand packets for this destination to
 * @property {number} cost      sum of the directional link costs along the path
 * @property {number} hops      number of links on the path (1 for a direct neighbor)
 * @property {string[]} path    node ids from selfId to the destination, both included.
 *   This is the path a packet takes hop by hop, provided every node on it computes its
 *   routes from the same graph and the same transit answers: `path[i + 1]` is the next
 *   hop that `path[i]` itself computes for this destination. While nodes disagree
 *   about the topology (an LSA still in flight) the real path can differ.
 *   Computed on access and returned as a new array each time: storing every path would
 *   cost O(V * path length) memory, which a long chain of nodes turns into O(V^2).
 */

/**
 * Compute the best route from `selfId` to every reachable node.
 *
 * @param {object} options
 * @param {Map<string, Map<string, number>>} options.graph  adjacency: node id -> (neighbor
 *   id -> cost of the link in that direction). A link u-v is used only if both u->v and
 *   v->u are present with costs that are integers >= 1; anything else is treated as no
 *   link. This is what `Lsdb#graph()` returns, and the check is repeated here so that a
 *   one-way claim can never carry traffic even if a caller builds the graph itself.
 * @param {string} options.selfId  the node routes are computed from
 * @param {(nodeId: string) => boolean} options.transit  whether a node forwards traffic
 *   for others. A node for which this does not return exactly `true` is still reachable
 *   as a destination but is never an intermediate hop. Called at most once per node and
 *   never for selfId.
 * @returns {Map<string, Route>} destination id -> route, without an entry for selfId.
 *   Unreachable nodes have no entry. Iteration order is nearest first (by cost, then
 *   hops, then next hop, then destination id) and does not depend on the insertion order
 *   of the graph.
 * @throws {ConfigError} if an argument has the wrong type
 */
export function computeRoutes({ graph, selfId, transit } = {}) {
  if (!(graph instanceof Map)) {
    throw new ConfigError('graph must be a Map');
  }
  if (typeof selfId !== 'string' || selfId === '') {
    throw new ConfigError('selfId must be a non-empty string');
  }
  if (typeof transit !== 'function') {
    throw new ConfigError('transit must be a function');
  }

  // Work on dense integer indices: labels live in typed arrays and the heap holds ints.
  const ids = [];
  const adjacency = [];
  const indexOf = new Map();
  for (const [id, neighbors] of graph) {
    if (typeof id !== 'string' || !(neighbors instanceof Map)) {
      throw new ConfigError('graph must map node id strings to Maps of neighbor costs');
    }
    indexOf.set(id, ids.length);
    ids.push(id);
    adjacency.push(neighbors);
  }

  const routes = new Map();
  const self = indexOf.get(selfId);
  if (self === undefined) return routes;

  const count = ids.length;
  const cost = new Float64Array(count).fill(Infinity);
  const hops = new Uint32Array(count);
  const first = new Int32Array(count).fill(-1); // first hop on the best path so far
  const prev = new Int32Array(count).fill(-1); // predecessor on the best path, set in step 2
  const settled = new Uint8Array(count);
  const relay = new Uint8Array(count); // 1 if the node may be an intermediate hop
  const reached = new Int32Array(count); // settled nodes, in the order they were settled
  let reachedCount = 0;
  let maxHops = 0;

  /** Heap order: the label triple, then the node id so that pop order is total. */
  const before = (a, b) => {
    if (cost[a] !== cost[b]) return cost[a] < cost[b];
    if (hops[a] !== hops[b]) return hops[a] < hops[b];
    if (first[a] !== first[b]) return ids[first[a]] < ids[first[b]];
    return ids[a] < ids[b];
  };
  const heap = new IndexedHeap(count, before);

  /** Whether the given label beats v's current label. */
  const improves = (newCost, newHops, newFirst, v) => {
    if (newCost !== cost[v]) return newCost < cost[v];
    if (newHops !== hops[v]) return newHops < hops[v];
    return newFirst !== first[v] && ids[newFirst] < ids[first[v]];
  };

  cost[self] = 0;
  first[self] = self;
  heap.push(self);

  while (heap.size > 0) {
    const u = heap.pop();
    settled[u] = 1;
    reached[reachedCount] = u;
    reachedCount += 1;
    if (hops[u] > maxHops) maxHops = hops[u];

    if (u !== self) {
      routes.set(ids[u], makeRoute(ids, prev, u, ids[first[u]], cost[u], hops[u]));
      // A non-transit node is a valid destination but a dead end for everyone else.
      if (transit(ids[u]) !== true) continue;
    }
    relay[u] = 1;

    for (const [peerId, weight] of adjacency[u]) {
      const v = indexOf.get(peerId);
      if (v === undefined || v === u || settled[v] === 1) continue;
      if (!isUsableCost(weight) || !isUsableCost(adjacency[v].get(ids[u]))) continue;

      const newCost = cost[u] + weight;
      // Not reachable with costs in the protocol range; keeps the sums exact regardless.
      if (newCost > Number.MAX_SAFE_INTEGER) continue;
      const newHops = hops[u] + 1;
      const newFirst = u === self ? v : first[u];

      if (!improves(newCost, newHops, newFirst, v)) continue;
      cost[v] = newCost;
      hops[v] = newHops;
      first[v] = newFirst;
      heap.pushOrRaise(v);
    }
  }

  // Step 2. Group the reached nodes by hop count (a counting sort), then walk the
  // groups outwards. `rank` is a node's position among the nodes of its hop count when
  // those are ordered by their paths.
  const start = new Uint32Array(maxHops + 2);
  for (let i = 0; i < reachedCount; i += 1) start[hops[reached[i]] + 1] += 1;
  for (let h = 0; h <= maxHops; h += 1) start[h + 1] += start[h];
  const next = start.slice();
  const byHops = new Int32Array(reachedCount);
  for (let i = 0; i < reachedCount; i += 1) {
    const node = reached[i];
    byHops[next[hops[node]]] = node;
    next[hops[node]] += 1;
  }

  const rank = new Uint32Array(count);
  // Paths of equal length are ordered by the paths of their predecessors, and under
  // the same predecessor by the last node.
  const byPath = (a, b) => {
    if (prev[a] !== prev[b]) return rank[prev[a]] - rank[prev[b]];
    return ids[a] < ids[b] ? -1 : 1;
  };

  for (let h = 0; h <= maxHops; h += 1) {
    // Every node of this group has its predecessor by now: the previous group set it.
    const group = byHops.subarray(start[h], start[h + 1]);
    if (group.length > 1) group.sort(byPath);
    for (let i = 0; i < group.length; i += 1) {
      const u = group[i];
      rank[u] = i;
      if (relay[u] !== 1) continue;
      for (const [peerId, weight] of adjacency[u]) {
        const v = indexOf.get(peerId);
        // Only an unclaimed node one hop further out can take u as its predecessor,
        // and only over a usable link that gives exactly its cost.
        if (v === undefined || hops[v] !== h + 1 || prev[v] !== -1) continue;
        if (!isUsableCost(weight) || cost[u] + weight !== cost[v]) continue;
        if (!isUsableCost(adjacency[v].get(ids[u]))) continue;
        prev[v] = u;
      }
    }
  }
  return routes;
}

function isUsableCost(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Build a route whose `path` is traced from the predecessor array on demand. The
 * property is an own, enumerable accessor, so the route still spreads, serializes and
 * compares like the plain object `{ nextHop, cost, hops, path }`.
 */
function makeRoute(ids, prev, node, nextHop, cost, hops) {
  const route = { nextHop, cost, hops };
  Object.defineProperty(route, 'path', {
    enumerable: true,
    get() {
      const path = new Array(hops + 1);
      let at = node;
      for (let i = hops; i >= 0; i -= 1) {
        path[i] = ids[at];
        at = prev[at];
      }
      return path;
    },
  });
  return route;
}

/**
 * Binary min-heap of node indices with decrease-key. Each node is in the heap at most
 * once, so the heap never holds more than V entries no matter how many links there are.
 */
class IndexedHeap {
  #items;
  #position;
  #before;
  #size = 0;

  /**
   * @param {number} capacity number of distinct node indices
   * @param {(a: number, b: number) => boolean} before true if a must be popped before b
   */
  constructor(capacity, before) {
    this.#items = new Int32Array(capacity);
    this.#position = new Int32Array(capacity).fill(-1);
    this.#before = before;
  }

  get size() {
    return this.#size;
  }

  push(node) {
    this.#position[node] = this.#size;
    this.#items[this.#size] = node;
    this.#size += 1;
    this.#siftUp(this.#position[node]);
  }

  /** Insert the node, or restore heap order after its label got smaller. */
  pushOrRaise(node) {
    if (this.#position[node] === -1) this.push(node);
    else this.#siftUp(this.#position[node]);
  }

  pop() {
    const items = this.#items;
    const top = items[0];
    this.#size -= 1;
    this.#position[top] = -1;
    if (this.#size > 0) {
      const last = items[this.#size];
      items[0] = last;
      this.#position[last] = 0;
      this.#siftDown(0);
    }
    return top;
  }

  #siftUp(start) {
    const items = this.#items;
    const position = this.#position;
    const node = items[start];
    let at = start;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.#before(node, items[parent])) break;
      items[at] = items[parent];
      position[items[at]] = at;
      at = parent;
    }
    items[at] = node;
    position[node] = at;
  }

  #siftDown(start) {
    const items = this.#items;
    const position = this.#position;
    const size = this.#size;
    const node = items[start];
    let at = start;
    for (;;) {
      let child = 2 * at + 1;
      if (child >= size) break;
      if (child + 1 < size && this.#before(items[child + 1], items[child])) child += 1;
      if (!this.#before(items[child], node)) break;
      items[at] = items[child];
      position[items[at]] = at;
      at = child;
    }
    items[at] = node;
    position[node] = at;
  }
}
