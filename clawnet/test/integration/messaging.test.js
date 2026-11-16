/**
 * End-to-end messages between real ClawNodes over loopback TCP: direct and multi-hop
 * delivery with acknowledgement, the offline queue across a sender restart, and
 * exactly-once delivery under retransmission and replay. Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodePacket } from '../../src/core/wire/codec.js';
import { createNoteService, startCluster } from '../helpers/cluster.js';

const notes = () => [createNoteService()];

test('a direct end-to-end message is delivered and acked, and the recorded wire bytes contain no plaintext', async (t) => {
  const cluster = await startCluster(t, { size: 2, topology: 'line', netem: true, services: notes });
  const [a, b] = cluster.nodes;
  await cluster.converged();
  const proxy = cluster.link(0, 1);
  const secret = 'CLAWNET-SECRET-direct-4f9b2c71d0e8';

  const acked = cluster.waitForEvent(0, 'message.acked');
  const { id, state } = await a.service('notes').send(cluster.ids[1], secret);
  assert.equal(state, 'sent');
  assert.match(id, /^[0-9a-f]{32}$/);
  const ack = await acked;
  assert.equal(ack.data.id, id);
  assert.equal(ack.data.dst, cluster.ids[1]);

  const received = b.service('notes').received;
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { id, from: cluster.ids[0], text: secret, prevHop: cluster.ids[0] });
  assert.equal(a.outbox().length, 0);
  assert.equal(b.stats().messaging.received, 1);

  // Both directions carried traffic, and none of it is readable.
  assert.ok(proxy.stats().bytesUp > 1000 && proxy.stats().bytesDown > 1000);
  for (const needle of [secret, cluster.ids[0], cluster.ids[1], a.identityInfo().card.e2e, 'clawnet-cluster']) {
    assert.equal(proxy.contains(needle), false, `found ${needle.slice(0, 20)} on the wire`);
  }
  assert.equal(proxy.contains(proxy.recorded('up').subarray(200, 240)), true);
});

test('multi-hop: in a line A-B-C, A\'s message reaches C through B, and B never sees the plaintext', async (t) => {
  const cluster = await startCluster(t, { size: 3, topology: 'line', netem: true, services: notes });
  const [a, b, c] = cluster.nodes;
  await cluster.converged();
  assert.deepEqual(a.routes().find((route) => route.dst === cluster.ids[2]).path, cluster.ids);

  const secret = 'CLAWNET-SECRET-multihop-8a1d7e3c55';
  const acked = cluster.waitForEvent(0, 'message.acked');
  const { id } = await a.service('notes').send(cluster.ids[2], secret);
  await acked;

  assert.deepEqual(c.service('notes').received.map((m) => [m.id, m.from, m.text, m.prevHop]), [[id, cluster.ids[0], secret, cluster.ids[1]]]);
  // B forwarded the message and the ack, and handled nothing itself.
  const forwarded = cluster.events(1, 'packet.forwarded');
  assert.ok(forwarded.some((event) => event.id === id && event.dst === cluster.ids[2] && event.from === cluster.ids[0]));
  assert.ok(forwarded.some((event) => event.dst === cluster.ids[0] && event.from === cluster.ids[2]));
  assert.equal(b.service('notes').received.length, 0);
  assert.equal(b.stats().messaging.received, 0);
  // Nothing B recorded and nothing on either of its links contains the text.
  const everythingB = JSON.stringify(b.events.recent());
  assert.equal(everythingB.includes(secret), false);
  for (const [i, j] of [[0, 1], [1, 2]]) {
    assert.equal(cluster.link(i, j).contains(secret), false);
    assert.ok(cluster.link(i, j).stats().bytesUp > 0);
  }
});

test('offline queue: a message for an unreachable node is queued, survives a restart of the sender, and is delivered when the destination returns', async (t) => {
  const cluster = await startCluster(t, { size: 2, topology: 'line', services: notes });
  const [, b] = cluster.nodes;
  await cluster.converged();
  // A knows B's card from B's peer record, which is persisted with A's peer records.
  await cluster.waitFor(() => cluster.nodes[0].nodeDetail(cluster.ids[1])?.peerRecord != null, { message: 'B\'s peer record at A' });

  await cluster.stopNode(1);
  await cluster.waitFor(() => cluster.nodes[0].listPeers().length === 0, { message: 'A sees B gone' });
  const secret = 'CLAWNET-SECRET-offline-2b6f0a9e41';
  const { id, state } = await cluster.nodes[0].service('notes').send(cluster.ids[1], secret);
  assert.equal(state, 'waiting');
  assert.deepEqual(cluster.nodes[0].outbox().map((entry) => entry.id), [id]);

  // The sender restarts while the destination is still down: the message stays queued.
  await cluster.restartNode(0);
  const a = cluster.nodes[0];
  assert.deepEqual(a.outbox().map((entry) => [entry.id, entry.dst, entry.kind]), [[id, cluster.ids[1], 'note']]);
  assert.equal(b.state, 'stopped');

  const acked = cluster.waitForEvent(0, 'message.acked', (data) => data.id === id, { timeoutMs: 8000 });
  await cluster.restartNode(1);
  await acked;
  const received = cluster.nodes[1].service('notes').received;
  assert.deepEqual(received.map((m) => [m.id, m.from, m.text]), [[id, cluster.ids[0], secret]]);
  assert.equal(a.outbox().length, 0);
});

test('duplicates: retransmissions and replayed packets are delivered exactly once', async (t) => {
  const cluster = await startCluster(t, {
    size: 2,
    topology: 'line',
    netem: true,
    services: notes,
    // Long enough a timeout that the link survives a second of lost acks.
    config: () => ({ timers: { peerTimeoutMs: 5000 } }),
  });
  const [a, b] = cluster.nodes;
  await cluster.converged();
  const proxy = cluster.link(0, 1);

  // Acks from B are lost: A retransmits the same id with a growing `try`.
  proxy.blackhole(true, { direction: 'down' });
  const { id } = await a.service('notes').send(cluster.ids[1], 'CLAWNET-dup-once');
  await cluster.waitFor(() => cluster.events(0, 'message.sent').filter((e) => e.id === id).length >= 3, { message: 'three transmissions' });
  const packet = await a.service('notes').packetOf(id);
  assert.notEqual(packet, null);
  proxy.heal();
  await cluster.waitFor(() => cluster.events(0, 'message.acked').some((e) => e.id === id), { timeoutMs: 8000, message: 'the ack' });

  assert.equal(b.service('notes').received.length, 1);
  assert.ok(cluster.events(1, 'message.duplicate').some((e) => e.id === id));
  const attempts = cluster.events(0, 'message.sent').filter((e) => e.id === id).map((e) => e.attempt);
  assert.ok(attempts.length >= 3 && attempts.every((n, k) => n === k + 1), `attempts ${attempts}`);

  // A replay of a captured packet, with the original and with a new `try`, is suppressed.
  await cluster.waitFor(() => a.listPeers().length === 1, { message: 'link back' });
  const decoded = decodePacket(packet);
  const duplicatesBefore = cluster.events(1, 'message.duplicate').length;
  for (const tryNo of [decoded.header.try, (decoded.header.try + 7) & 0xff]) {
    const result = a.service('notes').originate({ ...decoded, header: { ...decoded.header, try: tryNo } });
    assert.equal(result.ok, true);
  }
  await cluster.waitFor(() => cluster.events(1, 'message.duplicate').length >= duplicatesBefore + 2, { message: 'replays seen as duplicates' });
  assert.equal(b.service('notes').received.length, 1);
  assert.equal(b.stats().messaging.received, 1);
});
