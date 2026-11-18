/**
 * Interoperability of the browser node (web/core) with real engine nodes.
 *
 * The phone side here is the exact code the web app runs in a browser, run under Node.js
 * with Node's built-in WebSocket client; the computers are real ClawNodes with the
 * WebSocket transport switched on. Everything crosses real sockets on 127.0.0.1. This is
 * what "wire compatible" means in practice: links, sync, routing and sealed messages in
 * both directions, through one computer and through two.
 *
 * What it does not show: that a phone's browser behaves the same way. That needs a real
 * phone (docs/REVIEW.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createDiagService } from '../../src/core/diag/diag.js';
import { createStorage } from '../../web/core/storage.js';
import { PhoneNode } from '../../web/core/node.js';
import { CLUSTER_NETWORK, startCluster } from '../helpers/cluster.js';

const PHONE_TIMERS = {
  keepaliveMs: 200,
  peerTimeoutMs: 1500,
  handshakeTimeoutMs: 3000,
  lsaRefreshMs: 1000,
  lsaMinIntervalMs: 50,
  lsaMaxAgeMs: 3500,
  syncIntervalMs: 300,
  redialMinMs: 100,
  redialMaxMs: 1000,
};

const withWebSocket = (extra = {}) => () => ({
  websocket: { enabled: true, host: '127.0.0.1', port: 0 },
  ...extra,
});

function makePhone(t, { networkId = CLUSTER_NETWORK, networkKey = null, storage = createStorage(new Map()) } = {}) {
  const phone = new PhoneNode({ storage, timers: PHONE_TIMERS });
  if (phone.identity === null) phone.createIdentity({ networkId, networkKey });
  t.after(() => phone.stop());
  return phone;
}

function wsUrl(node) {
  return `ws://127.0.0.1:${node.websocketAddress.port}/`;
}

async function until(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a phone links to a computer over WebSocket and they message each other both ways', async (t) => {
  const cluster = await startCluster(t, { size: 1, config: withWebSocket() });
  const pc = cluster.nodes[0];
  const phone = makePhone(t);
  const phoneId = phone.identity.nodeId;
  phone.start(wsUrl(pc));
  await until(() => phone.status().state === 'linked', 'the phone to link');
  assert.equal(phone.status().peer.id, cluster.ids[0]);

  // The computer sees an ordinary peer, labelled as a WebSocket link, that will not carry
  // anyone else's traffic.
  const peer = pc.listPeers().find((p) => p.id === phoneId);
  assert.ok(peer !== undefined, 'the computer lists the phone as a peer');
  assert.equal(peer.transport, 'ws');
  assert.equal(peer.direction, 'in');
  assert.deepEqual(peer.caps, { relay: false, mailbox: false, transit: false });
  assert.deepEqual(peer.listen, []);
  const linkUp = cluster.events(0, 'link.up').find((e) => e.peer === phoneId);
  assert.equal(linkUp.transport, 'ws');

  // Its signed LSA and peer record reach the computer, and the link is confirmed both ways.
  await until(() => pc.topology().links.some((l) => (l.a === phoneId || l.b === phoneId) && l.state === 'confirmed'), 'a confirmed link in the computer\'s topology');
  const asSeen = pc.topology().nodes.find((n) => n.id === phoneId);
  assert.equal(asSeen.caps.transit, false);
  await until(() => pc.nodeDetail(phoneId)?.peerRecord != null, 'the peer record of the phone on the computer');
  assert.equal(pc.nodeDetail(phoneId).peerRecord.card.e2e, phone.identity.card.e2e);
  assert.deepEqual(pc.nodeDetail(phoneId).peerRecord.addrs, [], 'a phone announces no address');

  // Phone to computer.
  const sent = phone.sendText(cluster.ids[0], 'hello from the phone');
  await until(() => pc.conversation(phoneId).items.some((m) => m.text === 'hello from the phone'), 'the computer to receive the phone\'s message');
  await until(() => phone.messages(cluster.ids[0]).find((m) => m.id === sent.id)?.state === 'delivered', 'the computer\'s ack to reach the phone');

  // Computer to phone.
  const reply = await pc.sendMessage(phoneId, 'hello phone, from the computer');
  await until(() => phone.messages(cluster.ids[0]).some((m) => m.direction === 'in' && m.text === 'hello phone, from the computer'), 'the phone to receive the computer\'s message');
  await until(() => pc.outbox().every((entry) => entry.id !== reply.id), 'the phone\'s ack to reach the computer');
  const incoming = phone.messages(cluster.ids[0]).find((m) => m.direction === 'in');
  assert.equal(incoming.peer, cluster.ids[0]);

  // A long message crosses as several Noise records and arrives intact.
  const long = 'x'.repeat(16000);
  phone.sendText(cluster.ids[0], long);
  await until(() => pc.conversation(phoneId).items.some((m) => m.text === long), 'the long message');
});

test('a phone reaches a second computer through the first, in both directions', async (t) => {
  const cluster = await startCluster(t, { size: 2, config: (i) => (i === 0 ? withWebSocket()() : {}) });
  await cluster.connect(1, 0);
  const phone = makePhone(t);
  const phoneId = phone.identity.nodeId;
  phone.start(wsUrl(cluster.nodes[0]));
  await until(() => phone.status().state === 'linked', 'the phone to link');
  // The far computer's LSA and card reach the phone through sync with the near one.
  await until(() => phone.nodes().some((n) => n.id === cluster.ids[1] && n.reachable && n.canMessage), 'the far computer to be reachable from the phone');
  const far = phone.nodes().find((n) => n.id === cluster.ids[1]);
  assert.equal(far.linked, false);

  const out = phone.sendText(cluster.ids[1], 'two hops from a phone');
  await until(() => cluster.nodes[1].conversation(phoneId).items.some((m) => m.text === 'two hops from a phone'), 'the far computer to receive it');
  await until(() => phone.messages(cluster.ids[1]).find((m) => m.id === out.id)?.state === 'delivered', 'the far computer\'s ack');

  // And back: the far computer routes to the phone through the near one (the phone is not
  // a transit node, but it is a destination).
  await until(() => cluster.nodes[1].routes().some((r) => r.dst === phoneId && r.nextHop === cluster.ids[0]), 'a route to the phone on the far computer');
  await cluster.nodes[1].sendMessage(phoneId, 'two hops to a phone');
  await until(() => phone.messages(cluster.ids[1]).some((m) => m.direction === 'in' && m.text === 'two hops to a phone'), 'the phone to receive it');
});

test('on a private network the right key links, a wrong key does not, and the phone learns nothing', async (t) => {
  const key = randomBytes(32).toString('base64');
  const cluster = await startCluster(t, { size: 1, config: withWebSocket({ networkKey: key }) });
  const good = makePhone(t, { networkKey: key });
  good.start(wsUrl(cluster.nodes[0]));
  await until(() => good.status().state === 'linked', 'the phone with the key to link');

  const bad = makePhone(t, { networkKey: randomBytes(32).toString('base64') });
  bad.start(wsUrl(cluster.nodes[0]));
  await until(() => bad.status().state === 'offline', 'the phone with a wrong key to fail');
  assert.equal(bad.status().reason, 'closed');
  assert.equal(bad.status().peer, null);
  assert.deepEqual(bad.nodes(), [], 'nothing about the network reached it');

  const none = makePhone(t);
  none.start(wsUrl(cluster.nodes[0]));
  await until(() => none.status().state === 'offline', 'the phone without a key to fail');
  assert.equal(cluster.nodes[0].listPeers().length, 1, 'only the phone with the key is linked');
});

test('the computer\'s admission policy applies to phones: a blocked phone is refused', async (t) => {
  const storage = createStorage(new Map());
  const probe = new PhoneNode({ storage, timers: PHONE_TIMERS });
  probe.createIdentity({ networkId: CLUSTER_NETWORK });
  const blockedId = probe.identity.nodeId;
  const cluster = await startCluster(t, { size: 1, config: withWebSocket({ peers: { target: 0, block: [blockedId] } }) });
  const phone = makePhone(t, { storage });
  assert.equal(phone.identity.nodeId, blockedId, 'the identity survives in storage');
  phone.start(wsUrl(cluster.nodes[0]));
  await until(() => phone.status().state === 'offline', 'the refusal');
  assert.equal(phone.status().reason, 'blocked');
  assert.equal(cluster.nodes[0].listPeers().length, 0);
});

test('a phone on another network is refused, and one that leaves is dropped and can come back', async (t) => {
  const cluster = await startCluster(t, { size: 1, config: withWebSocket() });
  const stranger = makePhone(t, { networkId: 'some-other-net' });
  stranger.start(wsUrl(cluster.nodes[0]));
  await until(() => stranger.status().state === 'offline', 'the network mismatch');
  assert.ok(['closed', 'noise'].includes(stranger.status().reason), stranger.status().reason);

  const phone = makePhone(t);
  const url = wsUrl(cluster.nodes[0]);
  phone.start(url);
  await until(() => phone.status().state === 'linked', 'the first link');
  phone.stop();
  await until(() => cluster.nodes[0].listPeers().length === 0, 'the computer to drop the link');
  const down = cluster.events(0, 'link.down').find((e) => e.peer === phone.identity.nodeId);
  assert.equal(down.reason, 'shutdown');
  phone.start(url);
  await until(() => phone.status().state === 'linked', 'the second link');
  // A message queued while offline is delivered after the phone links again.
  phone.stop();
  const queued = phone.sendText(cluster.ids[0], 'written while offline');
  assert.equal(queued.state, 'queued');
  phone.start(url);
  await until(() => cluster.nodes[0].conversation(phone.identity.nodeId).items.some((m) => m.text === 'written while offline'), 'the queued message');
});

test('the computer can ping the phone: the phone answers probes like a node', async (t) => {
  const cluster = await startCluster(t, { size: 1, config: withWebSocket(), services: () => [createDiagService()] });
  const phone = makePhone(t);
  phone.start(wsUrl(cluster.nodes[0]));
  await until(() => phone.status().state === 'linked', 'the phone to link');
  // The phone needs the computer's card to seal its answer; it has it from the handshake.
  const result = await cluster.nodes[0].service('diag').ping(phone.identity.nodeId, { count: 2, intervalMs: 50, timeoutMs: 3000 });
  assert.ok(result.received >= 1, JSON.stringify(result));
});
