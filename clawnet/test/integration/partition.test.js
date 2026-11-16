/**
 * A partition between two groups of real ClawNodes over loopback TCP, and its healing
 * (ARCHITECTURE.md 11.7). Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNoteService, startCluster } from '../helpers/cluster.js';

/** Two triangles, 0-1-2 and 3-4-5, joined by the edge 2-3. */
const TWO_TRIANGLES = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [2, 3]];
const WEST = [0, 1, 2];
const EAST = [3, 4, 5];

/** The (origin, seq) pairs of every current LSA a node holds, sorted. */
function lsdbOf(node) {
  return node.topology().nodes
    .filter((entry) => entry.seq !== null)
    .map((entry) => `${entry.id}:${entry.seq}`)
    .sort();
}

test('partition and heal: both halves keep working, messages queued across the cut are delivered after it heals, and the link-state databases converge', async (t) => {
  const cluster = await startCluster(t, {
    size: 6,
    topology: TWO_TRIANGLES,
    netem: true,
    services: () => [createNoteService()],
  });
  await cluster.converged({ timeoutMs: 8000 });
  const { nodes, ids } = cluster;

  cluster.partition(WEST, EAST);
  // Each side drops its routes to the other.
  await cluster.converged({ timeoutMs: 8000 });
  for (const i of WEST) {
    const reachable = new Set(nodes[i].routes().map((route) => route.dst));
    assert.deepEqual(EAST.filter((j) => reachable.has(ids[j])), []);
  }

  // Both halves still work.
  await cluster.deliver(0, 1, 'west side still talks');
  await cluster.deliver(5, 4, 'east side still talks');

  // Messages across the cut wait in their senders' outboxes.
  const westToEast = await nodes[0].service('notes').send(ids[4], 'across the cut, west to east');
  const eastToWest = await nodes[5].service('notes').send(ids[1], 'across the cut, east to west');
  assert.equal(westToEast.state, 'waiting');
  assert.equal(eastToWest.state, 'waiting');
  assert.deepEqual(nodes[0].outbox().map((entry) => entry.id), [westToEast.id]);

  const acked = [];
  for (const i of [0, 5]) nodes[i].events.on('message.acked', (event) => acked.push(event.data.id));
  cluster.heal();
  await cluster.converged({ timeoutMs: 8000 });
  await cluster.waitFor(() => acked.includes(westToEast.id) && acked.includes(eastToWest.id), {
    timeoutMs: 8000,
    message: 'both queued messages acknowledged',
  });
  assert.deepEqual(nodes[4].service('notes').received.map((m) => [m.id, m.from, m.text]), [
    [cluster.events(5, 'message.acked')[0].id, ids[5], 'east side still talks'],
    [westToEast.id, ids[0], 'across the cut, west to east'],
  ]);
  assert.deepEqual(nodes[1].service('notes').received.map((m) => [m.from, m.text]), [
    [ids[0], 'west side still talks'],
    [ids[5], 'across the cut, east to west'],
  ]);
  assert.equal(nodes[0].outbox().length, 0);
  assert.equal(nodes[5].outbox().length, 0);

  // Every node ends up holding the same LSAs, one per node.
  await cluster.waitFor(() => {
    const views = nodes.map(lsdbOf);
    return views.every((view) => view.length === 6 && view.join() === views[0].join());
  }, { timeoutMs: 8000, message: 'identical link-state databases' });
  // Messages sent before the cut, during it and after it were each delivered once.
  for (const i of [1, 4]) {
    const seenIds = nodes[i].service('notes').received.map((m) => m.id);
    assert.equal(new Set(seenIds).size, seenIds.length);
  }
});
