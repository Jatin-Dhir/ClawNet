/**
 * Links between real PeerManagers over loopback TCP, some through the netem proxy.
 * Everything here runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';

import { Identity } from '../../src/core/crypto/identity.js';
import { HandshakeState } from '../../src/core/crypto/noise.js';
import { HandshakeError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { AddressBook } from '../../src/core/peer/address-book.js';
import { PeerManager } from '../../src/core/peer/peer-manager.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { PacketType } from '../../src/core/wire/types.js';
import { JsonFile } from '../../src/vault/store.js';
import { createNetem } from '../helpers/netem.js';
import { tempDir } from '../helpers/tmp.js';

const NET = 'links-net';
const FAST = {
  keepaliveMs: 100, peerTimeoutMs: 500, handshakeTimeoutMs: 1000,
  redialMinMs: 100, redialMaxMs: 800, redialJitter: 0.2,
};
const CAPS = { relay: true, mailbox: false, transit: true };

function configWith(overrides = {}) {
  return {
    networkId: NET,
    listen: { host: '127.0.0.1', port: 0 },
    api: { enabled: false },
    ...overrides,
    discovery: { multicast: { enabled: false }, pex: false, ...overrides.discovery },
    peers: { target: 0, max: 16, ...overrides.peers },
    timers: { ...FAST, ...overrides.timers },
    limits: { ...overrides.limits },
  };
}

async function startPeer(t, { config = {}, identity = Identity.generate(), ...extra } = {}) {
  const dir = await tempDir(t, 'links');
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
  const { port } = await pm.start();
  t.after(() => pm.stop());
  return { pm, identity, id: identity.nodeId, seen, book, packets, addr: `tcp://127.0.0.1:${port}`, port };
}

const of = (peer, type) => peer.seen.filter(e => e.type === type);
const data = (peer, type) => of(peer, type).map(e => e.data);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 4000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await sleep(5);
  }
}

// ---------------------------------------------------------------------- raw Noise peers

const prologue = Buffer.concat([Buffer.from('clawnet/1'), Buffer.from([0]), Buffer.from(NET)]);
const frameOf = message => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(message.length);
  return Buffer.concat([prefix, message]);
};
const payloadOf = (identity, overrides = {}) => ({
  v: 1, card: identity.card, net: NET, agent: 'raw/1', caps: CAPS, listen: [], observed: null, ts: Date.now(), ...overrides,
});

function messageReader(socket) {
  let buffered = Buffer.alloc(0);
  const waiters = [];
  const wake = () => {
    while (waiters.length > 0 && buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
      const length = buffered.readUInt16BE(0);
      const message = Buffer.from(buffered.subarray(2, 2 + length));
      buffered = buffered.subarray(2 + length);
      waiters.shift().resolve(message);
    }
  };
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.on('close', () => waiters.splice(0).forEach(w => w.reject(new Error('closed'))));
  return () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    wake();
  });
}

/** Connect to a node, complete the handshake honestly as `identity`, return the ciphers. */
async function rawInitiator(t, port, identity) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  const next = messageReader(socket);
  const hs = new HandshakeState({ pattern: 'XX', initiator: true, prologue, s: identity.linkKeyPair });
  socket.write(frameOf(hs.writeMessage(Buffer.alloc(0))));
  hs.readMessage(await next());
  socket.write(frameOf(hs.writeMessage(canonicalBytes(payloadOf(identity)))));
  const { tx, rx } = hs.split();
  const confirmation = rx.decryptWithAd(Buffer.alloc(0), await next());
  const send = plaintext => socket.write(frameOf(tx.encryptWithAd(Buffer.alloc(0), plaintext)));
  const receive = async () => rx.decryptWithAd(Buffer.alloc(0), await next());
  return { socket, send, receive, confirmation };
}

const frameBytes = (type, headerText, body = Buffer.alloc(0)) => {
  const header = Buffer.from(headerText);
  const packet = Buffer.alloc(4 + header.length + body.length);
  packet[0] = type;
  packet.writeUInt16BE(header.length, 2);
  header.copy(packet, 4);
  body.copy(packet, 4 + header.length);
  const frame = Buffer.alloc(4 + packet.length);
  frame.writeUInt32BE(packet.length);
  packet.copy(frame, 4);
  return frame;
};

// ---------------------------------------------------------------------- tests

test('two peers link through netem, exchange packets both ways, and no plaintext crosses the wire', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  const netem = await createNetem({ target: b.addr });
  t.after(() => netem.close());
  const info = await a.pm.connect(netem.address);
  assert.equal(info.id, b.id);
  await waitFor(() => b.pm.isLinked(a.id));
  const marker = 'CLAWNET-PLAINTEXT-MARKER-7f3a9c';
  for (let i = 0; i < 20; i += 1) {
    assert.ok(a.pm.send(b.id, { type: PacketType.DATA, header: { i }, body: Buffer.from(`${marker} a->b ${i}`) }));
    assert.ok(b.pm.send(a.id, { type: PacketType.GOSSIP, header: { note: marker }, body: Buffer.from(`${marker} b->a ${i}`) }));
  }
  await waitFor(() => a.packets.length === 20 && b.packets.length === 20);
  assert.deepEqual(b.packets.map(p => p.header.i), [...Array(20).keys()]);
  assert.ok(a.packets.every(p => p.id === b.id && p.body.toString().startsWith(marker)));
  assert.ok(netem.stats().bytesUp > 1000 && netem.stats().bytesDown > 1000);
  for (const needle of [marker, a.id, b.id, a.identity.card.sig, b.identity.card.e2e, `"net":"${NET}"`]) {
    assert.equal(netem.contains(needle), false, `found ${needle} on the wire`);
  }
  // The recording does see the traffic, so the absence above means something.
  assert.equal(netem.contains(netem.recorded('up').subarray(100, 140)), true);
});

test('wrong network id, wrong network key, tampered card, blocklisted id and self-dial are refused', async t => {
  const a = await startPeer(t);
  // Every dial here is one-shot. A dial made with the default `sticky: true` is remembered
  // and redialed by the peer manager's maintenance pass after `redialMinMs`, so on a loaded
  // machine a second, correct `noise` failure for the first address would land among the
  // reasons asserted below.

  const elsewhere = await startPeer(t, { config: { networkId: 'other-net' } });
  await assert.rejects(a.pm.connect(elsewhere.addr, { sticky: false }), err => err instanceof HandshakeError && err.reason === 'noise');

  const keyed = await startPeer(t, { config: { networkKey: Buffer.alloc(32, 1).toString('base64') } });
  const otherKey = await startPeer(t, { config: { networkKey: Buffer.alloc(32, 2).toString('base64') } });
  // The responder drops a non-member at message 1, so the initiator only sees the close.
  await assert.rejects(otherKey.pm.connect(keyed.addr, { sticky: false }), err => err.reason === 'closed');
  await assert.rejects(a.pm.connect(keyed.addr, { sticky: false }), err => err.reason === 'closed');

  // A responder whose card does not verify: the e2e key was swapped after signing.
  const fake = net.createServer(socket => {
    socket.on('error', () => {});
    const next = messageReader(socket);
    const hs = new HandshakeState({ pattern: 'XX', initiator: false, prologue, s: elsewhere.identity.linkKeyPair });
    next().then(first => {
      hs.readMessage(first);
      const card = { ...elsewhere.identity.card, e2e: Identity.generate().card.e2e };
      socket.write(frameOf(hs.writeMessage(canonicalBytes(payloadOf(elsewhere.identity, { card })))));
    }, () => {});
  });
  await new Promise(resolve => fake.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => fake.close());
  const fakeAddr = `tcp://127.0.0.1:${fake.address().port}`;
  await assert.rejects(a.pm.connect(fakeAddr, { sticky: false }), err => err.reason === 'bad-card');

  const blocker = await startPeer(t, { config: { peers: { block: [a.id] } } });
  await assert.rejects(a.pm.connect(blocker.addr, { sticky: false }), err => err.reason === 'blocked');
  await waitFor(() => data(blocker, 'peer.refused').length === 1);
  assert.equal(data(blocker, 'peer.refused')[0].reason, 'blocked');

  await assert.rejects(a.pm.connect(a.addr, { sticky: false }), err => err.reason === 'self');

  const reasons = data(a, 'peer.dial_failed').map(e => e.reason);
  assert.deepEqual(reasons, ['noise', 'closed', 'bad-card', 'blocked', 'self']);
  for (const peer of [a, elsewhere, keyed, otherKey, blocker]) assert.equal(of(peer, 'link.up').length, 0);
});

test('a cut link is noticed at once and redialed with growing backoff until healed', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  const netem = await createNetem({ target: b.addr });
  t.after(() => netem.close());
  await a.pm.connect(netem.address);
  await waitFor(() => b.pm.isLinked(a.id));
  const cutAt = Date.now();
  netem.cut();
  await waitFor(() => data(a, 'link.down').length === 1 && data(b, 'link.down').length === 1);
  assert.ok(Date.now() - cutAt < 300, 'noticed without waiting for the keepalive');
  assert.ok(['socket', 'eof'].includes(data(a, 'link.down')[0].reason));
  assert.equal(data(a, 'link.down')[0].remote, true);

  await waitFor(() => of(a, 'peer.dialing').length >= 5, { timeoutMs: 5000, message: 'redials' });
  const times = of(a, 'peer.dialing').slice(1).map(e => e.ts);
  const gaps = times.slice(1).map((ts, i) => ts - times[i]);
  // Each failed redial doubles the delay (jitter 20 %): roughly 200, 400, 800 ms.
  assert.ok(gaps[1] > gaps[0] * 1.2, `gaps ${gaps}`);
  assert.ok(gaps[2] > gaps[1] * 1.2 || gaps[2] >= 600, `gaps ${gaps}`);
  assert.ok(data(a, 'peer.dial_failed').every(f => f.retryInMs >= 80 && f.retryInMs <= 960));
  assert.equal(a.pm.isLinked(b.id), false);

  netem.heal();
  await waitFor(() => a.pm.isLinked(b.id), { timeoutMs: 3000, message: 'relink after heal' });
  assert.equal(data(a, 'link.up').length, 2);
});

test('a blackholed link misses keepalives and is closed with "timeout"', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  const netem = await createNetem({ target: b.addr });
  t.after(() => netem.close());
  await a.pm.connect(netem.address, { sticky: false });
  await waitFor(() => b.pm.isLinked(a.id));
  netem.blackhole(true);
  const start = Date.now();
  await waitFor(() => data(a, 'link.down').length === 1 && data(b, 'link.down').length === 1, { timeoutMs: 3000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= FAST.peerTimeoutMs - 50 && elapsed <= FAST.peerTimeoutMs + 2 * FAST.keepaliveMs + 200, `elapsed ${elapsed}`);
  // Whichever side's keepalive fires first closes with "timeout"; netem then tears the
  // proxied connection down, so the other side sees either its own timeout or the end.
  const downs = [data(a, 'link.down')[0], data(b, 'link.down')[0]];
  assert.ok(downs.some(d => d.reason === 'timeout' && d.remote === false), JSON.stringify(downs));
  for (const d of downs) assert.ok(['timeout', 'eof', 'socket'].includes(d.reason), JSON.stringify(d));
  const misses = [...data(a, 'link.metric'), ...data(b, 'link.metric')];
  assert.ok(misses.some(m => m.rttMs === null && m.misses >= 1), 'misses were counted');
  assert.ok(netem.stats().droppedUp > 0);
});

test('simultaneous dials end with exactly one link', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t);
  await Promise.all([a.pm.connect(b.addr), b.pm.connect(a.addr)]);
  await sleep(200);
  assert.equal(a.pm.size, 1);
  assert.equal(b.pm.size, 1);
  assert.notEqual(a.pm.get(b.id).direction, b.pm.get(a.id).direction);
  assert.equal(data(a, 'link.down').length + data(b, 'link.down').length, 0);
  a.pm.send(b.id, { type: PacketType.GOSSIP, header: { ok: true } });
  b.pm.send(a.id, { type: PacketType.GOSSIP, header: { ok: true } });
  await waitFor(() => a.packets.length === 1 && b.packets.length === 1);
});

test('rekeying happens on a live link and traffic continues across it', async t => {
  const a = await startPeer(t, { rekeyInterval: 4 });
  const b = await startPeer(t, { rekeyInterval: 4 });
  await a.pm.connect(b.addr);
  await waitFor(() => b.pm.isLinked(a.id));
  for (let i = 0; i < 120; i += 1) {
    a.pm.send(b.id, { type: PacketType.GOSSIP, header: { i } });
    b.pm.send(a.id, { type: PacketType.DATA, header: { i }, body: Buffer.alloc(i) });
    await tick();
    await tick();
  }
  await waitFor(() => a.packets.length === 120 && b.packets.length === 120);
  assert.deepEqual(b.packets.map(p => p.header.i), [...Array(120).keys()]);
  const infoA = a.pm.get(b.id);
  const infoB = b.pm.get(a.id);
  assert.ok(infoA.rekeysOut >= 25 && infoA.rekeysIn >= 25, `a: ${infoA.rekeysOut}/${infoA.rekeysIn}`);
  assert.ok(infoB.rekeysOut >= 25 && infoB.rekeysIn >= 25);
  // Keepalives keep working after many rekeys.
  const before = data(a, 'link.metric').filter(m => m.rttMs !== null).length;
  await waitFor(() => data(a, 'link.metric').filter(m => m.rttMs !== null).length > before + 1);
});

test('DATA beyond the budget is dropped without disconnecting while control traffic still flows', async t => {
  const a = await startPeer(t);
  const b = await startPeer(t, { config: { limits: { dataPacketsPerSec: 20 } } });
  await a.pm.connect(b.addr);
  await waitFor(() => b.pm.isLinked(a.id));
  for (let i = 0; i < 300; i += 1) a.pm.send(a.pm.list()[0].id, { type: PacketType.DATA, header: { i }, body: Buffer.alloc(200) });
  for (let i = 0; i < 50; i += 1) a.pm.send(b.id, { type: PacketType.GOSSIP, header: { c: i } });
  await waitFor(() => b.packets.filter(p => p.type === PacketType.GOSSIP).length === 50);
  await sleep(200);
  const delivered = b.packets.filter(p => p.type === PacketType.DATA).length;
  const info = b.pm.get(a.id);
  assert.ok(delivered >= 20 && delivered < 60, `delivered ${delivered}`);
  assert.equal(info.dataDropped, 300 - delivered);
  assert.equal(b.pm.stats().dataDropped, 300 - delivered);
  assert.equal(b.pm.isLinked(a.id), true);
  assert.equal(data(a, 'link.down').length + data(b, 'link.down').length, 0);
  // The budget refills: DATA flows again later, and keepalives never stopped.
  await sleep(300);
  a.pm.send(b.id, { type: PacketType.DATA, header: { late: true } });
  await waitFor(() => b.packets.some(p => p.header.late === true));
  assert.ok(data(b, 'link.metric').some(m => m.rttMs !== null));
});

test('malformed frames and packets close the link with "protocol" and the peer is refused afterwards', async t => {
  const b = await startPeer(t);
  const cases = {
    'zero-length frame': Buffer.from([0, 0, 0, 0]),
    'unknown packet type': frameBytes(77, '{}'),
    'non-canonical header': frameBytes(PacketType.GOSSIP, '{"b":1,"a":2}'),
    'malformed PING': frameBytes(PacketType.PING, '{"n":5}'),
    'PING with a body': frameBytes(PacketType.PING, '{"n":"0011223344556677"}', Buffer.from('x')),
  };
  for (const [name, plaintext] of Object.entries(cases)) {
    const mallory = Identity.generate();
    const raw = await rawInitiator(t, b.port, mallory);
    assert.ok(raw.confirmation.length > 0);
    await waitFor(() => b.pm.isLinked(mallory.nodeId), { message: `${name}: link` });
    raw.send(plaintext);
    await waitFor(() => data(b, 'link.down').some(d => d.peer === mallory.nodeId), { message: `${name}: close` });
    const down = data(b, 'link.down').find(d => d.peer === mallory.nodeId);
    assert.deepEqual([down.reason, down.remote], ['protocol', false], name);
    // The node says why before it hangs up.
    const bye = await raw.receive();
    assert.ok(bye.includes(Buffer.from('{"reason":"protocol"}')), name);
    // And refuses the same identity for the penalty period.
    const again = await rawInitiator(t, b.port, mallory).then(r => r.confirmation, err => err);
    assert.ok(Buffer.isBuffer(again) && again.includes(Buffer.from('{"reason":"blocked"}')), `${name}: readmitted`);
  }
  assert.equal(b.pm.stats().penalties, Object.keys(cases).length);
  assert.equal(b.pm.size, 0);
});
