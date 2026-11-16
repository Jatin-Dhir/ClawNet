/**
 * The ClawNode lifecycle over loopback TCP: independent nodes and their data directories,
 * authentication of links, and restart on the same directory. Everything runs on one
 * machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import { ClawNode } from '../../src/core/node.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { HandshakeState } from '../../src/core/crypto/noise.js';
import { ConfigError, HandshakeError, StateError } from '../../src/core/errors.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { decodePacket } from '../../src/core/wire/codec.js';
import { NODE_ID_PATTERN } from '../../src/core/wire/types.js';
import { CLUSTER_NETWORK, SILENT_LOGGER, clusterConfig, createNoteService, startCluster } from '../helpers/cluster.js';

const exists = (path) => stat(path).then(() => true, () => false);

// ------------------------------------------------------------- raw Noise peers (no node)

const PROLOGUE = Buffer.concat([Buffer.from('clawnet/1'), Buffer.from([0]), Buffer.from(CLUSTER_NETWORK)]);
const CAPS = { relay: true, mailbox: false, transit: true };

const frameOf = (message) => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(message.length);
  return Buffer.concat([prefix, message]);
};

const payloadOf = (identity, card) => ({
  v: 1, card, net: CLUSTER_NETWORK, agent: 'raw/1', caps: CAPS, listen: [], observed: null, ts: Date.now(),
});

/** Reads Noise handshake messages (u16be length || message) from a socket. */
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
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.on('close', () => waiters.splice(0).forEach((waiter) => waiter.reject(new Error('closed'))));
  return () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    wake();
  });
}

/** A card whose e2e key was swapped after signing: its signature no longer verifies. */
const forgedCard = (identity) => ({ ...identity.card, e2e: Identity.generate().card.e2e });

// ------------------------------------------------------------------------------- tests

test('several independent nodes start, each with its own identity and data directory', async (t) => {
  const cluster = await startCluster(t, { size: 3 });
  const { nodes, ids, dirs } = cluster;
  assert.equal(new Set(ids).size, 3);
  assert.equal(new Set(dirs).size, 3);
  assert.equal(new Set(nodes.map((node) => node.listenAddress.port)).size, 3);
  for (let i = 0; i < 3; i += 1) {
    const node = nodes[i];
    assert.match(ids[i], NODE_ID_PATTERN);
    assert.equal(node.state, 'running');
    assert.equal(node.identityInfo().nodeId, ids[i]);
    assert.equal(node.identityInfo().keystoreEncrypted, false);
    assert.equal(await readFile(join(dirs[i], 'network-id'), 'utf8'), `${CLUSTER_NETWORK}\n`);
    assert.ok(await exists(join(dirs[i], 'keystore.json')));
    assert.equal((await readFile(join(dirs[i], 'lock'), 'utf8')).trim(), String(process.pid));
    const runtime = JSON.parse(await readFile(join(dirs[i], 'runtime.json'), 'utf8'));
    assert.deepEqual(runtime, {
      pid: process.pid,
      boot: node.boot,
      nodeId: ids[i],
      listen: cluster.addressOf(i),
      api: null,
      startedAt: runtime.startedAt,
    });
    const status = node.status();
    assert.equal(status.peers.linked, 0);
    assert.equal(status.routing.nodes, 1);
    assert.equal(status.listen, cluster.addressOf(i));
    assert.equal(cluster.events(i, 'node.started')[0].nodeId, ids[i]);
    // Its own LSA and peer record exist from the start.
    assert.equal(node.topology().nodes.length, 1);
    assert.ok(node.nodeDetail(ids[i]).peerRecord !== null);
  }

  // A second node on a directory in use is refused and changes nothing.
  const intruder = new ClawNode({ config: clusterConfig(), dataDir: dirs[0], logger: SILENT_LOGGER });
  await assert.rejects(intruder.start(), (error) => error instanceof StateError && error.message.startsWith('locked:'));
  assert.equal(intruder.state, 'failed');
  assert.equal((await readFile(join(dirs[0], 'lock'), 'utf8')).trim(), String(process.pid));
  assert.equal(nodes[0].state, 'running');

  // A clean stop removes the runtime files; a second stop is harmless.
  await cluster.stopNode(2);
  await nodes[2].stop();
  assert.equal(nodes[2].state, 'stopped');
  assert.equal(await exists(join(dirs[2], 'runtime.json')), false);
  assert.equal(await exists(join(dirs[2], 'lock')), false);
  assert.deepEqual(nodes[2].events.recent({ types: ['node.stopping', 'node.stopped'] }).map((e) => e.type), ['node.stopping', 'node.stopped']);

  // The directory belongs to its network.
  const elsewhere = new ClawNode({ config: { ...clusterConfig(), networkId: 'another-net' }, dataDir: dirs[2], logger: SILENT_LOGGER });
  await assert.rejects(elsewhere.start(), (error) => error instanceof ConfigError && error.path === 'networkId');
  assert.equal(await exists(join(dirs[2], 'lock')), false);
});

test('authentication: wrong network key, forged card and blocked id are refused', async (t) => {
  const cluster = await startCluster(t, { size: 1 });
  const keyed = await cluster.addNode({ networkKey: Buffer.alloc(32, 1).toString('base64') });
  const otherKey = await cluster.addNode({ networkKey: Buffer.alloc(32, 2).toString('base64') });
  const blocker = await cluster.addNode({ peers: { block: [cluster.ids[0]] } });
  const { nodes } = cluster;
  const isHandshake = (reasons) => (error) => error instanceof HandshakeError && reasons.includes(error.reason);

  // Wrong or missing network key: the responder drops the first message unanswered, so
  // the initiator sees the connection close (or, racing the close, a message that does not
  // decrypt). Either way nothing about the responder is learned.
  for (const [from, to] of [[otherKey, keyed], [0, keyed], [keyed, 0]]) {
    await assert.rejects(nodes[from].connect(cluster.addressOf(to)), isHandshake(['closed', 'noise']));
  }

  // A responder whose card does not verify.
  const impostor = Identity.generate();
  const fake = net.createServer((socket) => {
    socket.on('error', () => {});
    const next = messageReader(socket);
    const hs = new HandshakeState({ pattern: 'XX', initiator: false, prologue: PROLOGUE, s: impostor.linkKeyPair });
    next().then((first) => {
      hs.readMessage(first);
      socket.write(frameOf(hs.writeMessage(canonicalBytes(payloadOf(impostor, forgedCard(impostor))))));
    }, () => {});
  });
  await new Promise((resolve) => fake.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));
  await assert.rejects(nodes[0].connect(`tcp://127.0.0.1:${fake.address().port}`), isHandshake(['bad-card']));

  // An initiator whose card does not verify is dropped by the node.
  const socket = net.connect({ host: '127.0.0.1', port: nodes[0].listenAddress.port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once('connect', resolve));
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const next = messageReader(socket);
  const hs = new HandshakeState({ pattern: 'XX', initiator: true, prologue: PROLOGUE, s: impostor.linkKeyPair });
  socket.write(frameOf(hs.writeMessage(Buffer.alloc(0))));
  hs.readMessage(await next());
  socket.write(frameOf(hs.writeMessage(canonicalBytes(payloadOf(impostor, forgedCard(impostor))))));
  await closed;

  // A blocked id is refused in both directions.
  await assert.rejects(nodes[0].connect(cluster.addressOf(blocker)), isHandshake(['blocked']));
  await cluster.waitFor(() => cluster.events(blocker, 'peer.refused').length >= 1, { message: 'peer.refused at the blocker' });
  assert.deepEqual(cluster.events(blocker, 'peer.refused').map((e) => [e.peer, e.reason]), [[cluster.ids[0], 'blocked']]);
  await assert.rejects(nodes[blocker].connect(cluster.addressOf(0)), isHandshake(['blocked']));

  // None of it ever produced a link, a route or a card.
  for (let i = 0; i < nodes.length; i += 1) {
    assert.equal(cluster.events(i, 'link.up').length, 0, `link.up on node ${i}`);
    assert.deepEqual(nodes[i].routes(), []);
  }
  assert.equal(nodes[0].nodeDetail(impostor.nodeId), null);
});

test('services: requirements order init, start and stop; registration is open only during init', async (t) => {
  const log = [];
  let late = null;
  const make = (name, requires, extra = {}) => ({
    name,
    requires,
    init(ctx) {
      log.push(`init:${name}`);
      assert.equal(ctx.nodeId, ctx.identity.card.id);
      assert.throws(() => ctx.sync.publish('cast', {}), (error) => error instanceof StateError && error.message.startsWith('not-started:'));
      extra.init?.(ctx);
      late = ctx;
    },
    start() {
      log.push(`start:${name}`);
    },
    stop() {
      log.push(`stop:${name}`);
    },
    stats: () => ({ calls: log.length }),
    api: { name },
  });
  const routes = make('routes', ['base'], {
    init(ctx) {
      ctx.api.route('GET', '/things/:id', async () => ctx.api.reply(201, { ok: true }), { summary: 'a thing' });
      assert.throws(() => ctx.api.route('GET', '/things/:other', () => null), (error) => error instanceof StateError);
      assert.throws(() => ctx.api.route('PUT', '/things', () => null), ConfigError);
      assert.throws(() => ctx.messaging.onKind('msg', () => {}), ConfigError);
      ctx.messaging.onKind('thing', () => {});
      assert.throws(() => ctx.messaging.onKind('thing', () => {}), (error) => error instanceof StateError);
      assert.throws(() => ctx.packets.onLocal('data.sealed', () => {}), ConfigError);
      assert.throws(() => ctx.sync.addDataset({ name: 'lsa' }), ConfigError);
    },
  });
  const cluster = await startCluster(t, { size: 1, services: () => [routes, make('base', [])] });
  const node = cluster.nodes[0];
  assert.deepEqual(log, ['init:base', 'init:routes', 'start:base', 'start:routes']);
  assert.deepEqual(node.status().services, ['base', 'routes']);
  assert.deepEqual(node.service('routes'), { name: 'routes' });
  assert.equal(node.service('missing'), null);
  const [route] = node.apiRoutes();
  assert.deepEqual([route.service, route.method, route.path, route.summary], ['routes', 'GET', '/things/:id', 'a thing']);
  const reply = await route.handler({ params: { id: 'x' } });
  assert.equal(late.api.isReply(reply), true);
  assert.equal(reply.status, 201);
  assert.ok(node.stats().services.routes.calls >= 4);
  // After init, nothing can be registered any more; publishing works now.
  assert.throws(() => late.messaging.onKind('other', () => {}), (error) => error instanceof StateError && error.message.startsWith('not-init:'));
  assert.deepEqual(late.sync.publish('receipt', { type: 'receipt' }).accepted, false);

  await cluster.stopNode(0);
  assert.deepEqual(log.slice(4), ['stop:routes', 'stop:base']);

  // A missing requirement fails the start and leaves the directory free.
  const broken = new ClawNode({
    config: clusterConfig(),
    dataDir: cluster.dirs[0],
    services: [make('lonely', ['absent'])],
    logger: SILENT_LOGGER,
  });
  await assert.rejects(broken.start(), (error) => error instanceof ConfigError && /absent/.test(error.message));
  assert.equal(broken.state, 'failed');
  assert.equal(await exists(join(cluster.dirs[0], 'lock')), false);
});

test('restart: a node restarted on the same data directory keeps its identity, advertises a higher sequence, and still rejects a replay of a message it accepted before the restart', async (t) => {
  const cluster = await startCluster(t, { size: 2, topology: 'line', services: () => [createNoteService()] });
  await cluster.converged();
  const { ids, dirs } = cluster;
  const keystore = await readFile(join(dirs[1], 'keystore.json'));

  // A message queued while B is down, so that its sealed packet can be read from A's outbox.
  await cluster.stopNode(1);
  await cluster.waitFor(() => cluster.nodes[0].listPeers().length === 0, { message: 'A sees B gone' });
  const { id, state } = await cluster.nodes[0].service('notes').send(ids[1], 'accepted once, before the restart');
  assert.equal(state, 'waiting');
  const packet = await cluster.nodes[0].service('notes').packetOf(id);
  assert.notEqual(packet, null);

  const acked = cluster.waitForEvent(0, 'message.acked', (data) => data.id === id, { timeoutMs: 8000 });
  await cluster.restartNode(1);
  await acked;
  assert.deepEqual(cluster.nodes[1].service('notes').received.map((m) => m.id), [id]);
  await cluster.converged();
  const seqBefore = cluster.nodes[0].nodeDetail(ids[1]).lsa.seq;
  const savedBefore = JSON.parse(await readFile(join(dirs[1], 'state.json'), 'utf8')).lsaSeq;
  assert.ok(savedBefore >= seqBefore);

  // Restart B again: same keys, a higher LSA sequence, and the id is still remembered.
  await cluster.restartNode(1);
  const b = cluster.nodes[1];
  assert.equal(b.id, ids[1]);
  assert.deepEqual(await readFile(join(dirs[1], 'keystore.json')), keystore);
  await cluster.converged();
  await cluster.waitFor(() => (cluster.nodes[0].nodeDetail(ids[1])?.lsa?.seq ?? 0) > seqBefore, {
    message: 'A holds a newer LSA of B',
  });
  assert.ok(b.status().routing.lsaSeq > savedBefore);

  const duplicate = cluster.waitForEvent(1, 'message.duplicate', (data) => data.id === id);
  const decoded = decodePacket(packet);
  assert.equal(cluster.nodes[0].service('notes').originate(decoded).ok, true);
  await duplicate;
  assert.deepEqual(b.service('notes').received, []);
  assert.equal(b.stats().messaging.received, 0);
  assert.ok(b.stats().messaging.duplicates >= 1);
});
