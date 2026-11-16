import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';

import { Identity } from '../../src/core/crypto/identity.js';
import { ConfigError, HandshakeError, ProtocolError, StateError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { AddressBook, AddressSource } from '../../src/core/peer/address-book.js';
import { PeerManager } from '../../src/core/peer/peer-manager.js';
import { PacketType } from '../../src/core/wire/types.js';
import { JsonFile } from '../../src/vault/store.js';
import { createNetem } from '../helpers/netem.js';
import { tempDir } from '../helpers/tmp.js';

const FAST = {
  keepaliveMs: 100, peerTimeoutMs: 500, handshakeTimeoutMs: 1000,
  redialMinMs: 100, redialMaxMs: 800, redialJitter: 0.2,
};

function configWith(overrides = {}) {
  return {
    networkId: 'test-net',
    listen: { host: '127.0.0.1', port: 0 },
    api: { enabled: false },
    ...overrides,
    discovery: { multicast: { enabled: false }, pex: false, ...overrides.discovery },
    peers: { target: 0, max: 16, ...overrides.peers },
    timers: { ...FAST, ...overrides.timers },
    limits: { ...overrides.limits },
  };
}

async function startPeer(t, { config = {}, identity = Identity.generate(), start = true, ...extra } = {}) {
  const dir = await tempDir(t, 'pm');
  const events = new EventBus({ capacity: 5000 });
  const seen = [];
  events.on('*', event => seen.push(event));
  const book = new AddressBook({ doc: new JsonFile(join(dir, 'peers.json'), { defaults: { v: 1, entries: [] } }) });
  await book.load();
  const packets = [];
  const pm = new PeerManager({
    identity,
    config: configWith(config),
    events,
    addressBook: book,
    onPacket: (id, packet) => packets.push({ id, type: packet.type, header: packet.header, body: Buffer.from(packet.body) }),
    ...extra,
  });
  const peer = { pm, identity, id: identity.nodeId, events, seen, book, packets, addr: null };
  if (start) {
    const { port } = await pm.start();
    peer.addr = `tcp://127.0.0.1:${port}`;
  }
  t.after(() => pm.stop());
  return peer;
}

const of = (peer, type) => peer.seen.filter(e => e.type === type).map(e => e.data);

async function waitFor(predicate, { timeoutMs = 4000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('two managers link, see the right PeerInfo, exchange packets by NodeId, and stop() is seen as shutdown', async t => {
  const a = await startPeer(t, { agent: 'alpha/1' });
  const b = await startPeer(t, { config: { caps: { mailbox: true } } });
  const info = await a.pm.connect(b.addr);
  assert.equal(info.id, b.id);
  assert.equal(info.direction, 'out');
  assert.equal(info.addr, b.addr);
  assert.deepEqual(info.caps, { relay: true, mailbox: true, transit: true });
  assert.equal(info.sticky, true);
  await waitFor(() => b.pm.isLinked(a.id));
  const fromB = b.pm.get(a.id);
  assert.equal(fromB.direction, 'in');
  assert.equal(fromB.agent, 'alpha/1');
  assert.ok(fromB.cost >= 1);
  assert.deepEqual(a.pm.links().map(l => l.peer), [b.id]);
  assert.deepEqual(a.pm.cardOf(b.id), b.identity.card);
  assert.deepEqual(a.pm.observedAddresses(), ['127.0.0.1']);

  const [upA] = of(a, 'link.up');
  assert.deepEqual(Object.keys(upA).sort(), ['addr', 'agent', 'caps', 'cost', 'direction', 'linkId', 'peer', 'rttMs']);
  assert.equal(upA.peer, b.id);

  assert.equal(a.pm.send(b.id, { type: PacketType.GOSSIP, header: { hello: 'b' } }), true);
  assert.equal(b.pm.send(a.id, { type: PacketType.DATA, header: { hello: 'a' }, body: Buffer.from('xyz') }), true);
  assert.equal(a.pm.send(Identity.generate().nodeId, { type: PacketType.GOSSIP, header: {} }), false);
  await waitFor(() => a.packets.length === 1 && b.packets.length === 1);
  assert.deepEqual(b.packets[0], { id: a.id, type: PacketType.GOSSIP, header: { hello: 'b' }, body: Buffer.alloc(0) });
  assert.equal(a.packets[0].body.toString(), 'xyz');
  // Keepalives run: PING/PONG never reach onPacket, but RTT samples arrive.
  await waitFor(() => of(a, 'link.metric').some(m => typeof m.rttMs === 'number'));
  assert.equal(a.packets.length, 1);

  await a.pm.stop();
  await waitFor(() => of(b, 'link.down').length === 1);
  assert.deepEqual(
    { ...of(b, 'link.down')[0], durationMs: 0 },
    { peer: a.id, linkId: fromB.linkId, reason: 'shutdown', remote: true, durationMs: 0 },
  );
  assert.equal(of(a, 'link.down')[0].reason, 'shutdown');
  assert.equal(of(a, 'link.down')[0].remote, false);
  await assert.rejects(a.pm.connect(b.addr), err => err instanceof StateError && err.message.startsWith('not-running:'));
});

test('self, blocked, not-allowed and full are refused with their reasons and no link.up', async t => {
  const self = await startPeer(t);
  await assert.rejects(self.pm.connect(self.addr), err => err instanceof HandshakeError && err.reason === 'self');
  assert.equal(self.book.get(self.addr), null, 'our own address is forgotten');
  assert.equal(of(self, 'peer.refused')[0].reason, 'self');

  const a = await startPeer(t);
  const blocker = await startPeer(t, { config: { peers: { block: [a.id] } } });
  await assert.rejects(a.pm.connect(blocker.addr), err => err.reason === 'blocked' && err.peer === blocker.id);
  await waitFor(() => of(blocker, 'peer.refused').length === 1);
  assert.deepEqual(of(blocker, 'peer.refused')[0], { addr: of(blocker, 'peer.refused')[0].addr, peer: a.id, direction: 'in', reason: 'blocked' });
  assert.deepEqual(of(a, 'peer.refused').map(e => [e.direction, e.reason, e.peer]), [['out', 'blocked', blocker.id]]);

  const picky = await startPeer(t, { config: { peers: { allow: [Identity.generate().nodeId] } } });
  await assert.rejects(a.pm.connect(picky.addr), err => err.reason === 'not-allowed');

  const full = await startPeer(t, { config: { peers: { max: 1 } } });
  const c = await startPeer(t);
  await c.pm.connect(full.addr);
  await assert.rejects(a.pm.connect(full.addr), err => err.reason === 'full');
  // A full node's link to c is untouched.
  assert.equal(full.pm.size, 1);

  for (const peer of [a, blocker, picky, self]) assert.equal(of(peer, 'link.up').length, 0);
  assert.equal(of(full, 'link.up').length, 1);
  assert.throws(() => new PeerManager({ identity: a.identity }), ConfigError);
  await assert.rejects(a.pm.connect('not an address'), ConfigError);
});

test('simultaneous dials end with exactly one link, the same on both sides, and no link.down', async t => {
  for (let round = 0; round < 5; round += 1) {
    const a = await startPeer(t);
    const b = await startPeer(t);
    const [ra, rb] = await Promise.all([a.pm.connect(b.addr), b.pm.connect(a.addr)]);
    assert.equal(ra.id, b.id);
    assert.equal(rb.id, a.id);
    await sleep(150);
    assert.equal(a.pm.size, 1);
    assert.equal(b.pm.size, 1);
    // The one surviving link is the same TCP connection: opposite directions.
    assert.notEqual(a.pm.get(b.id).direction, b.pm.get(a.id).direction);
    assert.equal(of(a, 'link.down').length + of(b, 'link.down').length, 0, `round ${round}`);
    assert.equal(of(a, 'link.up').length, 1);
    assert.equal(of(b, 'link.up').length, 1);
    // No redial follows.
    assert.equal(of(a, 'peer.dialing').length, 1);
    assert.equal(of(b, 'peer.dialing').length, 1);
    // Traffic flows on it.
    a.pm.send(b.id, { type: PacketType.GOSSIP, header: { round } });
    await waitFor(() => b.packets.length === 1);
    await Promise.all([a.pm.stop(), b.pm.stop()]);
  }
});

test('a restarted node redials while the other still holds the old link: replaced', async t => {
  const identity = Identity.generate();
  const old = await startPeer(t, { identity });
  const b = await startPeer(t);
  await old.pm.connect(b.addr);
  await waitFor(() => b.pm.isLinked(identity.nodeId));
  const firstLinkId = b.pm.get(identity.nodeId).linkId;
  const restarted = await startPeer(t, { identity });
  await restarted.pm.connect(b.addr);
  await waitFor(() => b.pm.get(identity.nodeId)?.linkId !== firstLinkId);
  assert.equal(b.pm.size, 1);
  assert.equal(of(b, 'link.up').length, 1, 'replacing a link is not a new link');
  assert.equal(of(b, 'link.down').length, 0);
  // The old instance is told, and reports the loss once the handover window passes.
  await waitFor(() => of(old, 'link.down').length === 1, { timeoutMs: 3000 });
  assert.deepEqual([of(old, 'link.down')[0].reason, of(old, 'link.down')[0].remote], ['replaced', true]);
  await old.pm.stop();
});

test('keepalive RTT follows the path latency', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  const netem = await createNetem({ target: b.addr, latencyMs: 30 });
  t.after(() => netem.close());
  await a.pm.connect(netem.address);
  await waitFor(() => of(a, 'link.metric').filter(m => m.rttMs !== null).length >= 6, { timeoutMs: 4000 });
  const samples = of(a, 'link.metric').filter(m => m.rttMs !== null).map(m => m.rttMs);
  for (const rtt of samples) assert.ok(rtt >= 55, `rtt ${rtt}`);
  const { cost, srttMs } = a.pm.get(b.id);
  assert.ok(srttMs >= 55 && srttMs < 200, `srtt ${srttMs}`);
  assert.ok(cost >= 55 && cost < 200, `cost ${cost}`);
});

test('onLinkCost fires when the cost should be re-advertised', async t => {
  const costs = [];
  let advertised = null;
  const a = await startPeer(t, {
    advertisedCost: () => advertised,
    onLinkCost: (id, cost) => {
      costs.push([id, cost]);
      advertised = cost;
    },
  });
  const b = await startPeer(t);
  await a.pm.connect(b.addr);
  await waitFor(() => costs.length >= 1);
  assert.equal(costs[0][0], b.id);
  // With a stable loopback RTT the advertised cost does not churn.
  await sleep(400);
  assert.equal(costs.length, 1);
});

test('control traffic over budget is throttled, not disconnected, and all of it arrives', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t, { config: { limits: { peerPacketsPerSec: 200 } } });
  await a.pm.connect(b.addr);
  for (let i = 0; i < 400; i += 1) a.pm.send(b.id, { type: PacketType.GOSSIP, header: { i } });
  await waitFor(() => b.packets.length === 400, { timeoutMs: 5000 });
  assert.deepEqual(b.packets.map(p => p.header.i), [...Array(400).keys()]);
  assert.ok(of(b, 'link.throttled').length >= 1);
  assert.equal(of(b, 'link.throttled')[0].by, 'packets');
  assert.equal(b.pm.isLinked(a.id), true);
  assert.equal(of(b, 'link.down').length, 0);
  assert.ok(b.pm.stats().throttleEvents >= 1);
});

test('a handler throwing ProtocolError closes the link and blocks re-admission; a TypeError does not', async t => {
  let mode = 'type';
  const a = await startPeer(t);
  const b = await startPeer(t, {
    onPacket: () => {
      if (mode === 'type') throw new TypeError('handler bug');
      throw new ProtocolError('bad gossip');
    },
  });
  await a.pm.connect(b.addr);
  a.pm.send(b.id, { type: PacketType.GOSSIP, header: {} });
  await waitFor(() => of(b, 'internal.error').length === 1);
  assert.equal(of(b, 'internal.error')[0].where, 'peer-manager.onPacket');
  assert.equal(b.pm.isLinked(a.id), true);
  mode = 'protocol';
  a.pm.send(b.id, { type: PacketType.GOSSIP, header: {} });
  await waitFor(() => of(a, 'link.down').length === 1);
  assert.deepEqual([of(a, 'link.down')[0].reason, of(a, 'link.down')[0].remote], ['protocol', true]);
  assert.equal(of(b, 'link.down')[0].reason, 'protocol');
  await a.pm.disconnect(b.id);
  await assert.rejects(a.pm.connect(b.addr, { sticky: false }), err => err.reason === 'blocked');
  assert.equal(b.pm.stats().penalties, 1);
});

test('target maintenance dials bootstrap addresses up to the target, sticky addresses above it', async t => {
  const targets = await Promise.all([0, 1, 2].map(() => startPeer(t)));
  const a = await startPeer(t, { config: { peers: { target: 2 } }, start: false });
  for (const peer of targets) a.book.add(peer.addr, { source: AddressSource.BOOTSTRAP });
  await a.pm.start();
  await waitFor(() => a.pm.size === 2);
  await sleep(300);
  assert.equal(a.pm.size, 2);
  assert.equal(of(a, 'peer.dialing').length, 2);
  // A sticky (manual) address is dialed although the target is met.
  const extra = await startPeer(t);
  await a.pm.connect(extra.addr);
  assert.equal(a.pm.size, 3);
});

test('addresses learned from the network on loopback are not dialed unless allowLoopback', async t => {
  const target = await startPeer(t);
  const strict = await startPeer(t, { config: { peers: { target: 1 }, discovery: { pex: true } }, start: false });
  strict.book.add(target.addr, { source: AddressSource.PEX, id: target.id });
  await strict.pm.start();
  await sleep(300);
  assert.equal(of(strict, 'peer.dialing').length, 0);
  assert.equal(strict.pm.size, 0);

  const lax = await startPeer(t, {
    config: { peers: { target: 1 }, discovery: { pex: true, allowLoopback: true } },
    start: false,
  });
  lax.book.add(target.addr, { source: AddressSource.PEX, id: target.id });
  await lax.pm.start();
  await waitFor(() => lax.pm.size === 1);
  assert.equal(of(lax, 'peer.dialing')[0].source, 'pex');
});

test('a learned dial to a DNS name is refused when the name resolves to loopback; an operator dial is not', async t => {
  const target = await startPeer(t);
  const port = Number(target.addr.split(':').pop());
  const a = await startPeer(t);
  // "localhost" stands for any name an attacker points at an address of ours.
  await assert.rejects(a.pm.connect(`tcp://localhost:${port}`, { sticky: false, learned: true }), err => {
    assert.equal(err.reason, 'connect-failed');
    assert.equal(err.cause?.code, 'ERESTRICTED');
    return true;
  });
  assert.equal(a.pm.size, 0);
  const info = await a.pm.connect(`tcp://localhost:${port}`, { sticky: false });
  assert.equal(info.id, target.id);
  // With the test switch the same learned dial goes through.
  const lax = await startPeer(t, { config: { discovery: { allowLoopback: true } } });
  assert.equal((await lax.pm.connect(`tcp://localhost:${port}`, { sticky: false, learned: true })).id, target.id);
});

test('dials respect the global dials-per-second cap and one attempt in flight per IP', async t => {
  const a = await startPeer(t, { config: { limits: { dialsPerSecond: 2 } } });
  const closed = [];
  for (let i = 0; i < 5; i += 1) {
    const server = net.createServer();
    await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    closed.push(server.address().port);
    await new Promise(resolve => server.close(resolve));
  }
  let inFlight = 0;
  let maxInFlight = 0;
  a.events.on('peer.dialing', () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, a.pm.dialing().length);
  });
  const started = Date.now();
  const results = await Promise.allSettled(closed.map(port => a.pm.connect(`tcp://127.0.0.1:${port}`, { sticky: false })));
  const elapsed = Date.now() - started;
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.reason === 'connect-failed'));
  assert.equal(inFlight, 5);
  // Burst of 2, then 2 per second: the last of 5 dials starts no earlier than 1.5 s in.
  assert.ok(elapsed >= 1300, `elapsed ${elapsed}`);
  const dials = of(a, 'peer.dialing');
  assert.equal(dials.length, 5);
  const failures = of(a, 'peer.dial_failed');
  assert.ok(failures.every(f => f.reason === 'connect-failed' && f.retryInMs > 0));
  assert.ok(maxInFlight >= 1);
});

test('inbound handshakes are capped and silent connections time out', async t => {
  const b = await startPeer(t, { maxPendingInbound: 4, config: { timers: { handshakeTimeoutMs: 300 } } });
  const { port } = b.pm.listenAddress;
  const sockets = [];
  for (let i = 0; i < 10; i += 1) {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    sockets.push(socket);
  }
  t.after(() => sockets.forEach(s => s.destroy()));
  await waitFor(() => b.pm.stats().inboundRejected + b.pm.stats().handshakesIn === 10);
  assert.equal(b.pm.stats().handshakesIn, 4);
  assert.equal(b.pm.stats().inboundRejected, 6);
  await waitFor(() => b.pm.stats().pendingInbound === 0, { timeoutMs: 2000 });
  assert.equal(b.pm.size, 0);
});

test('disconnect(forget) stops redialing; a lost sticky link is redialed', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  await a.pm.connect(b.addr);
  // The far side drops the link: a redials it.
  await b.pm.disconnect(a.id, { reason: 'manual' });
  await waitFor(() => of(a, 'peer.dialing').length === 2, { timeoutMs: 3000 });
  await waitFor(() => a.pm.isLinked(b.id));
  assert.equal(of(a, 'link.down')[0].reason, 'manual');
  // Forgetting it stops that.
  assert.equal(await a.pm.disconnect(b.id), true);
  await sleep(400);
  assert.equal(of(a, 'peer.dialing').length, 2);
  assert.equal(a.pm.isLinked(b.id), false);
  assert.equal(await a.pm.disconnect(b.id), false);
});
