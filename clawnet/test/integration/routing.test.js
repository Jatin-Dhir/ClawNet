/**
 * Routing between real ClawNodes over loopback TCP: rerouting around a node that
 * disappears, redialing a cut link, and moving traffic away from a link that got slow.
 * Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNoteService, startCluster } from '../helpers/cluster.js';

const notes = () => [createNoteService()];

/** A diamond: 0 reaches 3 through 1 or through 2. */
const DIAMOND = [[0, 1], [0, 2], [1, 3], [2, 3]];

test('a node disappears: in a diamond, the route moves to the surviving path and delivery continues', async (t) => {
  const cluster = await startCluster(t, { size: 4, topology: DIAMOND, services: notes });
  await cluster.converged();
  const [a] = cluster.nodes;
  const d = cluster.ids[3];
  assert.equal(a.routes().find((route) => route.dst === d).hops, 2);

  // The two paths cost about the same, so measured costs may tip the choice either way:
  // the node that dies is the one that actually carried the first message.
  const before = await cluster.deliver(0, 3, 'before the failure');
  const carriers = [1, 2].filter((i) => cluster.events(i, 'packet.forwarded').some((e) => e.id === before));
  assert.equal(carriers.length, 1);
  const [via] = carriers;
  const other = via === 1 ? 2 : 1;

  await cluster.stopNode(via);
  // Until D's new LSA arrives, the stopped node may still look reachable through D.
  await cluster.waitFor(() => a.routes().find((route) => route.dst === d)?.nextHop === cluster.ids[other] &&
    !a.routes().some((route) => route.dst === cluster.ids[via]), {
    message: 'the route through the surviving node',
  });
  assert.ok(cluster.events(0, 'routes.changed').some((e) => e.unreachable.includes(cluster.ids[via])));

  const after = await cluster.deliver(0, 3, 'after the failure');
  assert.ok(cluster.events(other, 'packet.forwarded').some((e) => e.id === after));
  assert.deepEqual(cluster.nodes[3].service('notes').received.map((m) => m.text), ['before the failure', 'after the failure']);
});

test('a cut link is redialed and traffic resumes', async (t) => {
  const cluster = await startCluster(t, { size: 2, topology: 'line', netem: true, services: notes });
  await cluster.converged();
  const proxy = cluster.link(0, 1);
  await cluster.deliver(0, 1, 'before the cut');

  const downA = cluster.waitForEvent(0, 'link.down');
  const downB = cluster.waitForEvent(1, 'link.down');
  proxy.cut();
  assert.equal((await downA).data.peer, cluster.ids[1]);
  assert.equal((await downB).data.peer, cluster.ids[0]);
  assert.equal(cluster.nodes[0].routes().length, 0);
  // While cut, redials reach the proxy and are dropped.
  await cluster.waitFor(() => cluster.events(0, 'peer.dial_failed').length > 0, { message: 'a failed redial' });

  const up = cluster.waitForEvent(0, 'link.up', (data) => data.peer === cluster.ids[1], { timeoutMs: 6000 });
  proxy.heal();
  await up;
  await cluster.converged();
  await cluster.deliver(0, 1, 'after the cut');
  assert.deepEqual(cluster.nodes[1].service('notes').received.map((m) => m.text), ['before the cut', 'after the cut']);
  assert.ok(cluster.events(0, 'peer.dialing').filter((e) => e.addr === proxy.address).length >= 2);
});

test('adaptive routing: adding latency to a link moves traffic to the lower-cost path', async (t) => {
  const cluster = await startCluster(t, { size: 4, topology: DIAMOND, netem: true, services: notes });
  await cluster.converged();
  const [a] = cluster.nodes;
  const d = cluster.ids[3];
  // Traffic in use goes through `via`.
  const first = await cluster.deliver(0, 3, 'over whichever path');
  const via = [1, 2].find((i) => cluster.events(i, 'packet.forwarded').some((e) => e.id === first));
  const other = via === 1 ? 2 : 1;
  /** Cost of a link as routing uses it: the larger of what its two ends advertise. */
  const costOf = (x, y) => {
    const link = a.topology().links.find((l) => [l.a, l.b].includes(cluster.ids[x]) && [l.a, l.b].includes(cluster.ids[y]));
    return link === undefined ? null : Math.max(link.costAB, link.costBA);
  };

  // 40 ms each way on that edge: its round trip, and so its cost, grows by about 80.
  cluster.link(0, via).setLatency(40);
  await cluster.waitFor(() => costOf(0, via) > costOf(0, other) + costOf(other, 3) &&
    a.routes().find((route) => route.dst === d)?.nextHop === cluster.ids[other], {
    timeoutMs: 8000,
    message: 'the slow link to be advertised and the route to move to the faster path',
  });
  const route = a.routes().find((r) => r.dst === d);
  assert.deepEqual(route.path, [cluster.ids[0], cluster.ids[other], d]);
  assert.ok(costOf(0, via) + costOf(via, 3) > route.cost, `old path ${costOf(0, via) + costOf(via, 3)} new ${route.cost}`);

  const id = await cluster.deliver(0, 3, 'over the fast path');
  assert.ok(cluster.events(other, 'packet.forwarded').some((e) => e.id === id));
  assert.equal(cluster.events(via, 'packet.forwarded').some((e) => e.id === id), false);
});
