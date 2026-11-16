import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRoutes } from '../../src/core/routing/spf.js';
import { ConfigError } from '../../src/core/errors.js';

const always = () => true;

/**
 * Build a graph from `[u, v, costUV, costVU]` rows. `costVU` defaults to `costUV`;
 * passing `null` for it leaves the reverse direction out (a one-way claim).
 */
function buildGraph(rows, extraNodes = []) {
  const graph = new Map();
  const node = (id) => {
    if (!graph.has(id)) graph.set(id, new Map());
    return graph.get(id);
  };
  for (const id of extraNodes) node(id);
  for (const [u, v, costUV, costVU = costUV] of rows) {
    node(u).set(v, costUV);
    if (costVU === null) node(v);
    else node(v).set(u, costVU);
  }
  return graph;
}

/** Routes as a plain object keyed by destination, with the lazy `path` materialised. */
function plain(routes) {
  const out = {};
  for (const [dst, route] of routes) out[dst] = { ...route };
  return out;
}

/** The same graph with node and neighbor insertion order reversed. */
function reversed(graph) {
  const out = new Map();
  for (const [id, neighbors] of [...graph].reverse()) {
    out.set(id, new Map([...neighbors].reverse()));
  }
  return out;
}

test('line: every node is reached through the single neighbor, costs add up', () => {
  const graph = buildGraph([
    ['a', 'b', 3],
    ['b', 'c', 4],
    ['c', 'd', 5],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 3, hops: 1, path: ['a', 'b'] },
    c: { nextHop: 'b', cost: 7, hops: 2, path: ['a', 'b', 'c'] },
    d: { nextHop: 'b', cost: 12, hops: 3, path: ['a', 'b', 'c', 'd'] },
  });
  // From the middle the line splits in two directions.
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'c', transit: always })), {
    b: { nextHop: 'b', cost: 4, hops: 1, path: ['c', 'b'] },
    d: { nextHop: 'd', cost: 5, hops: 1, path: ['c', 'd'] },
    a: { nextHop: 'b', cost: 7, hops: 2, path: ['c', 'b', 'a'] },
  });
});

test('the result has no entry for the node itself', () => {
  const graph = buildGraph([['a', 'b', 1]]);
  const routes = computeRoutes({ graph, selfId: 'a', transit: always });
  assert.equal(routes.has('a'), false);
  assert.deepEqual([...routes.keys()], ['b']);
});

test('ring: traffic goes the short way round, and an exact tie picks the smaller next hop', () => {
  // a - b - c - d - e - a, all costs 1.
  const ring5 = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 1],
    ['c', 'd', 1],
    ['d', 'e', 1],
    ['e', 'a', 1],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph: ring5, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 1, hops: 1, path: ['a', 'b'] },
    e: { nextHop: 'e', cost: 1, hops: 1, path: ['a', 'e'] },
    c: { nextHop: 'b', cost: 2, hops: 2, path: ['a', 'b', 'c'] },
    d: { nextHop: 'e', cost: 2, hops: 2, path: ['a', 'e', 'd'] },
  });

  // In an even ring the opposite node is equally far both ways: 'b' < 'd' decides.
  const ring4 = buildGraph([
    ['a', 'd', 1],
    ['d', 'c', 1],
    ['c', 'b', 1],
    ['b', 'a', 1],
  ]);
  for (const graph of [ring4, reversed(ring4)]) {
    const routes = computeRoutes({ graph, selfId: 'a', transit: always });
    assert.deepEqual(
      { ...routes.get('c') },
      { nextHop: 'b', cost: 2, hops: 2, path: ['a', 'b', 'c'] },
    );
  }
});

test('star: leaves reach each other through the hub, the hub reaches leaves directly', () => {
  const graph = buildGraph([
    ['hub', 'w', 2],
    ['hub', 'x', 3],
    ['hub', 'y', 5],
    ['hub', 'z', 7],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'x', transit: always })), {
    hub: { nextHop: 'hub', cost: 3, hops: 1, path: ['x', 'hub'] },
    w: { nextHop: 'hub', cost: 5, hops: 2, path: ['x', 'hub', 'w'] },
    y: { nextHop: 'hub', cost: 8, hops: 2, path: ['x', 'hub', 'y'] },
    z: { nextHop: 'hub', cost: 10, hops: 2, path: ['x', 'hub', 'z'] },
  });
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'hub', transit: always })), {
    w: { nextHop: 'w', cost: 2, hops: 1, path: ['hub', 'w'] },
    x: { nextHop: 'x', cost: 3, hops: 1, path: ['hub', 'x'] },
    y: { nextHop: 'y', cost: 5, hops: 1, path: ['hub', 'y'] },
    z: { nextHop: 'z', cost: 7, hops: 1, path: ['hub', 'z'] },
  });
});

test('diamond with unequal costs: the cheaper branch wins even though it starts dearer', () => {
  //      b            a-b 1, b-d 10  -> 11 via b
  //    /   \          a-c 5, c-d 2   ->  7 via c
  //   a     d
  //    \   /
  //      c
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'd', 10],
    ['a', 'c', 5],
    ['c', 'd', 2],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 1, hops: 1, path: ['a', 'b'] },
    c: { nextHop: 'c', cost: 5, hops: 1, path: ['a', 'c'] },
    d: { nextHop: 'c', cost: 7, hops: 2, path: ['a', 'c', 'd'] },
  });
});

test('a direct link is not used when a detour is cheaper', () => {
  const graph = buildGraph([
    ['a', 'b', 100],
    ['a', 'c', 10],
    ['c', 'b', 20],
  ]);
  const routes = computeRoutes({ graph, selfId: 'a', transit: always });
  assert.deepEqual(
    { ...routes.get('b') },
    { nextHop: 'c', cost: 30, hops: 2, path: ['a', 'c', 'b'] },
  );
});

test('equal cost: fewer hops beats a smaller next-hop id', () => {
  // a-z-d costs 2+2 over two hops; a-b-c-d costs 1+1+2 over three.
  const graph = buildGraph([
    ['a', 'z', 2],
    ['z', 'd', 2],
    ['a', 'b', 1],
    ['b', 'c', 1],
    ['c', 'd', 2],
  ]);
  for (const g of [graph, reversed(graph)]) {
    const routes = computeRoutes({ graph: g, selfId: 'a', transit: always });
    assert.deepEqual(
      { ...routes.get('d') },
      { nextHop: 'z', cost: 4, hops: 2, path: ['a', 'z', 'd'] },
    );
  }
});

test('equal cost and hops: the smallest next hop wins and is inherited downstream', () => {
  // Two-hop paths to t through m, k or p all cost 2; u hangs off t.
  const graph = buildGraph([
    ['a', 'm', 1],
    ['a', 'k', 1],
    ['a', 'p', 1],
    ['m', 't', 1],
    ['k', 't', 1],
    ['p', 't', 1],
    ['t', 'u', 1],
  ]);
  for (const g of [graph, reversed(graph)]) {
    const routes = computeRoutes({ graph: g, selfId: 'a', transit: always });
    assert.deepEqual(
      { ...routes.get('t') },
      { nextHop: 'k', cost: 2, hops: 2, path: ['a', 'k', 't'] },
    );
    assert.deepEqual(
      { ...routes.get('u') },
      { nextHop: 'k', cost: 3, hops: 3, path: ['a', 'k', 't', 'u'] },
    );
  }
});

test('equal label through two predecessors: the path takes the smaller predecessor', () => {
  // Both a-b-x-t and a-b-y-t cost 3 with next hop b. The recorded path must not depend
  // on which one the graph happens to list first.
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'y', 1],
    ['b', 'x', 1],
    ['y', 't', 1],
    ['x', 't', 1],
  ]);
  for (const g of [graph, reversed(graph)]) {
    const routes = computeRoutes({ graph: g, selfId: 'a', transit: always });
    assert.deepEqual(
      { ...routes.get('t') },
      { nextHop: 'b', cost: 3, hops: 3, path: ['a', 'b', 'x', 't'] },
    );
  }

  // The rule is "smallest predecessor id", not "whichever predecessor was settled
  // first": here y (cost 2) is settled before x (cost 3), yet both reach t at cost 4.
  const uneven = buildGraph([
    ['a', 'f', 1],
    ['f', 'y', 1],
    ['f', 'x', 2],
    ['y', 't', 2],
    ['x', 't', 1],
  ]);
  for (const g of [uneven, reversed(uneven)]) {
    const routes = computeRoutes({ graph: g, selfId: 'a', transit: always });
    assert.deepEqual(
      { ...routes.get('t') },
      { nextHop: 'f', cost: 4, hops: 3, path: ['a', 'f', 'x', 't'] },
    );
  }
});

test('asymmetric costs: each direction is summed with its own costs', () => {
  // a->b is cheap, b->a is expensive; b has a cheap way back through c.
  const graph = buildGraph([
    ['a', 'b', 1, 100],
    ['b', 'c', 1, 50],
    ['c', 'a', 1, 60],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 1, hops: 1, path: ['a', 'b'] },
    c: { nextHop: 'b', cost: 2, hops: 2, path: ['a', 'b', 'c'] },
  });
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'b', transit: always })), {
    c: { nextHop: 'c', cost: 1, hops: 1, path: ['b', 'c'] },
    a: { nextHop: 'c', cost: 2, hops: 2, path: ['b', 'c', 'a'] },
  });
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'c', transit: always })), {
    a: { nextHop: 'a', cost: 1, hops: 1, path: ['c', 'a'] },
    b: { nextHop: 'a', cost: 2, hops: 2, path: ['c', 'a', 'b'] },
  });
});

test('a link only one endpoint claims is ignored in both directions', () => {
  // a claims a cheap link to c that c does not confirm; the real path is a-b-c.
  const graph = buildGraph([
    ['a', 'c', 1, null],
    ['a', 'b', 5],
    ['b', 'c', 5],
  ]);
  const fromA = computeRoutes({ graph, selfId: 'a', transit: always });
  assert.deepEqual(
    { ...fromA.get('c') },
    { nextHop: 'b', cost: 10, hops: 2, path: ['a', 'b', 'c'] },
  );
  const fromC = computeRoutes({ graph, selfId: 'c', transit: always });
  assert.deepEqual(
    { ...fromC.get('a') },
    { nextHop: 'b', cost: 10, hops: 2, path: ['c', 'b', 'a'] },
  );

  // With nothing else, a one-way claim reaches nobody, from either end.
  const lonely = buildGraph([['a', 'c', 1, null]]);
  assert.equal(computeRoutes({ graph: lonely, selfId: 'a', transit: always }).size, 0);
  assert.equal(computeRoutes({ graph: lonely, selfId: 'c', transit: always }).size, 0);
});

test('a neighbor that is not a node of the graph is ignored', () => {
  const graph = new Map([
    ['a', new Map([['ghost', 1], ['b', 2]])],
    ['b', new Map([['a', 2]])],
  ]);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 2, hops: 1, path: ['a', 'b'] },
  });
});

test('partition: nodes on the other side have no route', () => {
  const graph = buildGraph(
    [
      ['a', 'b', 1],
      ['c', 'd', 1],
    ],
    ['island'],
  );
  const routes = computeRoutes({ graph, selfId: 'a', transit: always });
  assert.deepEqual([...routes.keys()], ['b']);
  assert.equal(routes.get('c'), undefined);
  assert.equal(routes.get('island'), undefined);
  assert.equal(computeRoutes({ graph, selfId: 'island', transit: always }).size, 0);
});

test('a node missing from the graph has no routes', () => {
  const graph = buildGraph([['a', 'b', 1]]);
  assert.equal(computeRoutes({ graph, selfId: 'nobody', transit: always }).size, 0);
  assert.equal(computeRoutes({ graph: new Map(), selfId: 'a', transit: always }).size, 0);
});

test('a non-transit node is a destination but never an intermediate hop', () => {
  // The cheap way to c leads through b; the dear way goes round through d and e.
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 1],
    ['a', 'd', 10],
    ['d', 'e', 10],
    ['e', 'c', 10],
  ]);
  const open = computeRoutes({ graph, selfId: 'a', transit: always });
  assert.deepEqual({ ...open.get('c') }, { nextHop: 'b', cost: 2, hops: 2, path: ['a', 'b', 'c'] });

  const closed = computeRoutes({ graph, selfId: 'a', transit: (id) => id !== 'b' });
  assert.deepEqual(plain(closed), {
    b: { nextHop: 'b', cost: 1, hops: 1, path: ['a', 'b'] },
    d: { nextHop: 'd', cost: 10, hops: 1, path: ['a', 'd'] },
    e: { nextHop: 'd', cost: 20, hops: 2, path: ['a', 'd', 'e'] },
    c: { nextHop: 'd', cost: 30, hops: 3, path: ['a', 'd', 'e', 'c'] },
  });

  // If the non-transit node is the only way through, what lies behind it is unreachable.
  const line = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 1],
  ]);
  const cut = computeRoutes({ graph: line, selfId: 'a', transit: (id) => id !== 'b' });
  assert.deepEqual([...cut.keys()], ['b']);
});

test('the source routes its own traffic even if it does not offer transit itself', () => {
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 1],
  ]);
  const asked = [];
  const routes = computeRoutes({
    graph,
    selfId: 'a',
    transit: (id) => {
      asked.push(id);
      return id !== 'a';
    },
  });
  assert.deepEqual([...routes.keys()], ['b', 'c']);
  // The source is never asked, everyone else exactly once.
  assert.deepEqual(asked.sort(), ['b', 'c']);
});

test('only an explicit true from transit() allows forwarding', () => {
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 1],
  ]);
  for (const answer of [false, undefined, null, 0, 1, 'yes', {}]) {
    const routes = computeRoutes({ graph, selfId: 'a', transit: () => answer });
    assert.deepEqual([...routes.keys()], ['b'], String(answer));
  }
});

test('links with a cost that is not an integer >= 1 are not used, in either direction', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined, 2 ** 53]) {
    // a-b is broken in one direction only; a-c-b is the valid detour.
    const rows = [
      ['a', 'b', 1],
      ['a', 'c', 4],
      ['c', 'b', 4],
    ];
    const forward = buildGraph(rows);
    forward.get('a').set('b', bad);
    const backward = buildGraph(rows);
    backward.get('b').set('a', bad);
    for (const graph of [forward, backward]) {
      const routes = computeRoutes({ graph, selfId: 'a', transit: always });
      assert.deepEqual(
        { ...routes.get('b') },
        { nextHop: 'c', cost: 8, hops: 2, path: ['a', 'c', 'b'] },
        String(bad),
      );
    }
  }
});

test('a self-loop in the graph is harmless', () => {
  const graph = buildGraph([['a', 'b', 2]]);
  graph.get('a').set('a', 1);
  graph.get('b').set('b', 1);
  assert.deepEqual(plain(computeRoutes({ graph, selfId: 'a', transit: always })), {
    b: { nextHop: 'b', cost: 2, hops: 1, path: ['a', 'b'] },
  });
});

test('routes are listed nearest first, independent of how the graph was built', () => {
  const graph = buildGraph([
    ['a', 'f', 3],
    ['a', 'c', 1],
    ['a', 'e', 1],
    ['c', 'd', 1],
    ['e', 'b', 1],
    ['f', 'g', 1],
  ]);
  // (cost, hops, next hop, id): c and e at cost 1; then d (via c) before b (via e).
  const expected = ['c', 'e', 'd', 'b', 'f', 'g'];
  assert.deepEqual([...computeRoutes({ graph, selfId: 'a', transit: always }).keys()], expected);
  assert.deepEqual(
    [...computeRoutes({ graph: reversed(graph), selfId: 'a', transit: always }).keys()],
    expected,
  );
});

test('a route behaves like a plain object although its path is computed on access', () => {
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 2],
  ]);
  const route = computeRoutes({ graph, selfId: 'a', transit: always }).get('c');

  assert.deepEqual(Object.keys(route), ['nextHop', 'cost', 'hops', 'path']);
  assert.deepEqual(route, { nextHop: 'b', cost: 3, hops: 2, path: ['a', 'b', 'c'] });
  assert.equal(JSON.stringify(route), '{"nextHop":"b","cost":3,"hops":2,"path":["a","b","c"]}');
  assert.deepEqual(
    structuredClone(route),
    { nextHop: 'b', cost: 3, hops: 2, path: ['a', 'b', 'c'] },
  );

  // Each access hands out a fresh array, so a caller cannot corrupt later readers.
  const first = route.path;
  first.length = 0;
  first.push('tampered');
  assert.deepEqual(route.path, ['a', 'b', 'c']);
  assert.equal(route.path.length, route.hops + 1);
});

test('computeRoutes does not modify the graph it is given', () => {
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'c', 2, 9],
  ]);
  const before = JSON.stringify([...graph].map(([id, n]) => [id, [...n]]));
  computeRoutes({ graph, selfId: 'a', transit: always });
  assert.equal(JSON.stringify([...graph].map(([id, n]) => [id, [...n]])), before);
});

test('arguments of the wrong type are rejected', () => {
  const graph = buildGraph([['a', 'b', 1]]);
  const bad = [
    undefined,
    {},
    { graph: {}, selfId: 'a', transit: always },
    { graph: [['a', new Map()]], selfId: 'a', transit: always },
    { graph: null, selfId: 'a', transit: always },
    { graph, selfId: '', transit: always },
    { graph, selfId: 7, transit: always },
    { graph, transit: always },
    { graph, selfId: 'a' },
    { graph, selfId: 'a', transit: true },
    { graph: new Map([['a', { b: 1 }]]), selfId: 'a', transit: always },
    { graph: new Map([['a', new Map()], [7, new Map()]]), selfId: 'a', transit: always },
  ];
  for (const [i, options] of bad.entries()) {
    assert.throws(
      () => computeRoutes(options),
      (err) => err instanceof ConfigError && err.code === 'ERR_CONFIG',
      `case ${i}`,
    );
  }
});

test('a long chain is routed without storing a path per destination', () => {
  // 20000 nodes in a line: eager paths would be 200 million array slots.
  const count = 20000;
  const id = (i) => `n${String(i).padStart(5, '0')}`;
  const graph = new Map();
  for (let i = 0; i < count; i += 1) {
    const neighbors = new Map();
    if (i > 0) neighbors.set(id(i - 1), 2);
    if (i + 1 < count) neighbors.set(id(i + 1), 3);
    graph.set(id(i), neighbors);
  }
  const routes = computeRoutes({ graph, selfId: id(0), transit: always });
  assert.equal(routes.size, count - 1);
  const last = routes.get(id(count - 1));
  assert.equal(last.cost, 3 * (count - 1));
  assert.equal(last.hops, count - 1);
  assert.equal(last.nextHop, id(1));
  const path = last.path;
  assert.equal(path.length, count);
  assert.equal(path[0], id(0));
  assert.equal(path[12345], id(12345));
  assert.equal(path[count - 1], id(count - 1));
});

// --- randomized cross-check -----------------------------------------------------------

/** mulberry32: a tiny deterministic PRNG, so a failure can be reproduced from its seed. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(seed, { nodes, links, oneWay, maxCost, isolated, closedShare }) {
  const random = prng(seed);
  const pick = (n) => Math.floor(random() * n);
  const ids = [];
  for (let i = 0; i < nodes; i += 1) {
    // Ids that do not sort in creation order, so ties are not broken by accident.
    ids.push(`${pick(0xffffff).toString(36).padStart(5, '0')}-${i}`);
  }
  const graph = new Map(ids.map((id) => [id, new Map()]));
  const connected = nodes - isolated;
  for (let i = 0; i < links; i += 1) {
    const u = ids[pick(connected)];
    const v = ids[pick(connected)];
    if (u === v) continue;
    graph.get(u).set(v, 1 + pick(maxCost));
    graph.get(v).set(u, 1 + pick(maxCost));
  }
  for (let i = 0; i < oneWay; i += 1) {
    const u = ids[pick(nodes)];
    const v = ids[pick(nodes)];
    if (u === v || graph.get(v).has(u)) continue;
    // Very cheap, so that using one by mistake would change the answer.
    graph.get(u).set(v, 1);
  }
  const closed = new Set(ids.filter(() => random() < closedShare));
  return { graph, ids, closed };
}

/**
 * Straightforward O(V^2) Dijkstra over an adjacency matrix, with the same ranking of
 * paths: cost, then hops, then first-hop id. No heap, no index maps, no shared code.
 */
function referenceRoutes(graph, ids, selfId, closed) {
  const n = ids.length;
  const at = new Map(ids.map((id, i) => [id, i]));
  const weight = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const [u, neighbors] of graph) {
    for (const [v, cost] of neighbors) {
      // Only links confirmed in both directions exist.
      if (graph.get(v)?.has(u)) weight[at.get(u)][at.get(v)] = cost;
    }
  }
  const best = new Array(n).fill(null); // { cost, hops, first }
  const done = new Array(n).fill(false);
  const source = at.get(selfId);
  best[source] = { cost: 0, hops: 0, first: '' };
  const better = (x, y) =>
    y === null ||
    x.cost < y.cost ||
    (x.cost === y.cost && (x.hops < y.hops || (x.hops === y.hops && x.first < y.first)));

  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && best[i] !== null && (u === -1 || better(best[i], best[u]))) u = i;
    }
    if (u === -1) break;
    done[u] = true;
    if (u !== source && closed.has(ids[u])) continue;
    for (let v = 0; v < n; v += 1) {
      if (weight[u][v] === 0 || done[v]) continue;
      const candidate = {
        cost: best[u].cost + weight[u][v],
        hops: best[u].hops + 1,
        first: u === source ? ids[v] : best[u].first,
      };
      if (better(candidate, best[v])) best[v] = candidate;
    }
  }
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    if (i !== source && best[i] !== null) out.set(ids[i], best[i]);
  }
  return out;
}

/** Check a reported path against the graph itself, independently of any algorithm. */
function assertPathIsReal(graph, selfId, dst, route, closed) {
  const { path } = route;
  assert.equal(path[0], selfId);
  assert.equal(path[path.length - 1], dst);
  assert.equal(path.length, route.hops + 1);
  assert.equal(path[1], route.nextHop);
  assert.equal(new Set(path).size, path.length, 'path revisits a node');
  let cost = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const forward = graph.get(path[i]).get(path[i + 1]);
    assert.ok(Number.isInteger(forward), `no link ${path[i]} -> ${path[i + 1]}`);
    assert.ok(graph.get(path[i + 1]).has(path[i]), `unconfirmed link ${path[i]} -> ${path[i + 1]}`);
    cost += forward;
    if (i > 0) assert.ok(!closed.has(path[i]), `non-transit node ${path[i]} used as a hop`);
  }
  assert.equal(cost, route.cost);
}

test('2000-node random graph agrees with a straightforward O(V^2) Dijkstra', () => {
  const seed = 0xc1a70001;
  const { graph, ids, closed } = randomGraph(seed, {
    nodes: 2000,
    links: 5000,
    oneWay: 600,
    maxCost: 6, // small costs make ties common, which is where implementations diverge
    isolated: 20,
    closedShare: 0.1,
  });
  const transit = (id) => !closed.has(id);

  let multiHop = 0;
  let unreachable = 0;
  for (const selfId of [ids[0], ids[777], ids[1500]]) {
    const routes = computeRoutes({ graph, selfId, transit });
    const expected = referenceRoutes(graph, ids, selfId, closed);

    assert.equal(routes.size, expected.size, `seed ${seed}: reachable set differs`);
    for (const [dst, want] of expected) {
      const got = routes.get(dst);
      assert.ok(got, `seed ${seed}: no route to ${dst}`);
      assert.equal(got.cost, want.cost, `seed ${seed}: cost to ${dst}`);
      assert.equal(got.hops, want.hops, `seed ${seed}: hops to ${dst}`);
      assert.equal(got.nextHop, want.first, `seed ${seed}: next hop to ${dst}`);
      assertPathIsReal(graph, selfId, dst, got, closed);
      if (got.hops > 1) multiHop += 1;
    }
    unreachable += ids.length - 1 - routes.size;
  }
  // Guard against a degenerate graph that would make the comparison above trivial.
  assert.ok(multiHop > 3000, `only ${multiHop} multi-hop routes`);
  assert.ok(unreachable >= 60, `only ${unreachable} unreachable destinations`);
  assert.ok(closed.size > 100, `only ${closed.size} non-transit nodes`);
});

test('random graphs: every node computes the same result whatever the insertion order', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { graph, ids, closed } = randomGraph(seed, {
      nodes: 120,
      links: 300,
      oneWay: 40,
      maxCost: 3,
      isolated: 3,
      closedShare: 0.15,
    });
    const transit = (id) => !closed.has(id);
    const shuffled = reversed(graph);
    for (const selfId of [ids[0], ids[60], ids[119]]) {
      const a = computeRoutes({ graph, selfId, transit });
      const b = computeRoutes({ graph: shuffled, selfId, transit });
      // Entries in order, so this also compares the iteration order of the two maps.
      const listed = (routes) => [...routes].map(([dst, route]) => [dst, { ...route }]);
      assert.deepEqual(listed(a), listed(b), `seed ${seed}`);
      const expected = referenceRoutes(graph, ids, selfId, closed);
      assert.equal(a.size, expected.size, `seed ${seed}`);
      for (const [dst, want] of expected) {
        const got = a.get(dst);
        assert.deepEqual(
          [got.cost, got.hops, got.nextHop],
          [want.cost, want.hops, want.first],
          `seed ${seed}: ${selfId} -> ${dst}`,
        );
      }
    }
  }
});

test('random graphs: hop-by-hop forwarding along next hops delivers at the computed cost', () => {
  // The property the tie-break exists for: if every node forwards to ITS next hop, the
  // packet follows a loop-free path and pays exactly the cost the source computed.
  const { graph, ids } = randomGraph(42, {
    nodes: 150,
    links: 420,
    oneWay: 30,
    maxCost: 3,
    isolated: 2,
    closedShare: 0,
  });
  const tables = new Map(
    ids.map((id) => [id, computeRoutes({ graph, selfId: id, transit: always })]),
  );
  let checked = 0;
  for (const src of ids.slice(0, 40)) {
    for (const [dst, route] of tables.get(src)) {
      let at = src;
      let paid = 0;
      let steps = 0;
      while (at !== dst) {
        const next = tables.get(at).get(dst).nextHop;
        paid += graph.get(at).get(next);
        at = next;
        steps += 1;
        assert.ok(steps <= ids.length, `forwarding loop from ${src} to ${dst}`);
      }
      assert.equal(paid, route.cost, `${src} -> ${dst}`);
      assert.equal(steps, route.hops, `${src} -> ${dst}`);
      checked += 1;
    }
  }
  assert.ok(checked > 4000, `only ${checked} source/destination pairs checked`);
});

test('regression: Route.path is the path packets take when every node forwards to its own next hop', () => {
  // Review finding (routing, low): with "smallest predecessor" as the tie-break, a
  // reported a>b>m>q>t while b, applying "smallest next hop", forwarded via k, so packets
  // went a>b>k>z>t. Ranking equal paths by their whole node sequence makes the two agree.
  const graph = buildGraph([
    ['a', 'b', 1],
    ['b', 'm', 1],
    ['m', 'q', 1],
    ['q', 't', 1],
    ['b', 'k', 1],
    ['k', 'z', 1],
    ['z', 't', 1],
  ]);
  for (const g of [graph, reversed(graph)]) {
    const fromA = computeRoutes({ graph: g, selfId: 'a', transit: always });
    const fromB = computeRoutes({ graph: g, selfId: 'b', transit: always });
    assert.deepEqual(fromA.get('t').path, ['a', 'b', 'k', 'z', 't']);
    assert.equal(fromB.get('t').nextHop, 'k');
  }

  // The same property over tie-heavy random graphs with non-transit nodes, where the
  // review counted 1.1 % of routes disagreeing: walk the per-node tables and compare.
  let compared = 0;
  for (const seed of [7, 8, 9]) {
    const { graph: g, ids, closed } = randomGraph(seed, {
      nodes: 90,
      links: 260,
      oneWay: 20,
      maxCost: 3,
      isolated: 2,
      closedShare: 0.25,
    });
    const transit = (id) => !closed.has(id);
    const tables = new Map(ids.map((id) => [id, computeRoutes({ graph: g, selfId: id, transit })]));
    for (const src of ids) {
      for (const [dst, route] of tables.get(src)) {
        const walked = [src];
        let at = src;
        while (at !== dst) {
          at = tables.get(at).get(dst).nextHop;
          walked.push(at);
          assert.ok(walked.length <= ids.length, `seed ${seed}: forwarding loop ${src} -> ${dst}`);
        }
        assert.deepEqual(route.path, walked, `seed ${seed}: ${src} -> ${dst}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 10_000, `only ${compared} routes compared`);
});
