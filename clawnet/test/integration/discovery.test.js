/**
 * Discovery between real ClawNodes over loopback TCP: one bootstrap address and peer
 * exchange are enough to find the rest of the network. Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNoteService, startCluster } from '../helpers/cluster.js';

test('discovery: a node given one bootstrap address learns of and links to the others through peer exchange', async (t) => {
  // 1 and 2 dial 0; with pex on they find each other too, and then have their target of
  // two peers, so every further link has to be made by the joiner.
  const cluster = await startCluster(t, {
    size: 3,
    topology: 'star',
    config: () => ({ discovery: { pex: true }, peers: { target: 2 } }),
    services: () => [createNoteService()],
  });
  await cluster.converged();
  await cluster.waitFor(() => cluster.nodes.every((node) => node.listPeers().length === 2), {
    message: 'nodes 1 and 2 linked through peer exchange',
  });
  assert.ok(cluster.events(1, 'discovery.candidate').some((e) => e.source === 'pex' && e.peer === cluster.ids[2]) ||
    cluster.events(2, 'discovery.candidate').some((e) => e.source === 'pex' && e.peer === cluster.ids[1]));

  const joiner = await cluster.addNode({
    discovery: { pex: true, bootstrap: [cluster.addressOf(0)] },
    peers: { target: 3 },
  });
  const node = cluster.nodes[joiner];
  const others = cluster.ids.slice(0, 3);
  await cluster.waitFor(() => {
    const linked = new Set(node.listPeers().map((peer) => peer.id));
    return others.every((id) => linked.has(id));
  }, { timeoutMs: 8000, message: 'the joiner linked to all three' });

  // It came in through the bootstrap address and found the rest in peer records.
  const dialing = cluster.events(joiner, 'peer.dialing');
  assert.ok(dialing.some((e) => e.addr === cluster.addressOf(0)));
  const candidates = cluster.events(joiner, 'discovery.candidate');
  assert.ok(candidates.some((e) => e.source === 'bootstrap' && e.addr === cluster.addressOf(0)));
  for (const i of [1, 2]) {
    assert.ok(candidates.some((e) => e.source === 'pex' && e.peer === cluster.ids[i] && e.addr === cluster.addressOf(i)), `pex candidate ${i}`);
  }
  for (const i of [1, 2]) {
    const record = node.nodeDetail(cluster.ids[i]).peerRecord;
    assert.deepEqual(record.addrs, [cluster.addressOf(i)]);
  }
  // Every link it made is one it chose to make: none of them was configured by the test.
  assert.deepEqual(node.listPeers().map((peer) => peer.direction).sort(), ['out', 'out', 'out']);
  assert.ok(cluster.events(joiner, 'peer.record').length >= 3);
});
