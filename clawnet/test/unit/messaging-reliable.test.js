import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  MAX_META_BYTES,
  MAX_SEALED_CONTENT,
  ReliableMessenger,
  ROUTE_JITTER_MS,
} from '../../src/core/messaging/reliable.js';
import { NodeStorage } from '../../src/core/storage.js';
import { EventBus } from '../../src/core/events.js';
import { ConfigError, StateError } from '../../src/core/errors.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { openMessage, sealMessage } from '../../src/core/crypto/envelope.js';
import { base64Decode } from '../../src/core/crypto/primitives.js';
import { decodePacket, encodePacket } from '../../src/core/wire/codec.js';
import { tempDir } from '../helpers/tmp.js';

const T0 = 1_700_000_000_000;
const hex = () => randomBytes(16).toString('hex');
const text = (value) => Buffer.from(value);

/**
 * A world of messengers joined by a fake network on a fake clock. The network can drop,
 * duplicate and delay every packet; time only moves when a test advances it.
 */
class World {
  wall = T0;
  mono = 5_000;
  rngValue = 0.5;
  timers = [];
  nodes = new Map();
  cards = new Map();
  activity = 0;
  log = [];
  down = new Set();
  backpressure = new Set();
  rule = () => [0];

  now = () => this.wall;

  monoNow = () => this.mono;

  rng = () => this.rngValue;

  schedule = (fn, ms) => {
    const timer = { at: this.mono + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  liveTimers() {
    return this.timers.filter((timer) => timer.live).length;
  }

  reachable(from, to) {
    return this.nodes.has(to) && !this.down.has(`${from}>${to}`);
  }

  originateFor(from) {
    return (packet) => {
      this.activity += 1;
      const to = packet.header.dst;
      if (!this.reachable(from, to)) return { ok: false, reason: 'no-route' };
      if (this.backpressure.has(`${from}>${to}`)) return { ok: false, reason: 'backpressure' };
      const wire = decodePacket(encodePacket(packet));
      const record = { t: this.wall, from, to, header: { ...wire.header }, body: Buffer.from(wire.body) };
      this.log.push(record);
      for (const delay of this.rule(record)) {
        if (delay === 0) this.deliver(record);
        else this.schedule(() => this.deliver(record), delay);
      }
      return { ok: true, nextHop: to };
    };
  }

  deliver(record, header = {}, from = record.from) {
    const node = this.nodes.get(record.to);
    if (node === undefined) return Promise.resolve();
    return node.messenger.handleData(
      { header: { ...record.header, ...header }, body: Buffer.from(record.body) },
      { from },
    );
  }

  packetsFrom(from) {
    return this.log.filter((record) => record.from === from.id);
  }

  async advance(ms) {
    const target = this.mono + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.wall += Math.max(0, due.at - this.mono);
      this.mono = Math.max(this.mono, due.at);
      due.live = false;
      due.fn();
      await this.settle();
    }
    this.wall += target - this.mono;
    this.mono = target;
    await this.settle();
  }

  /** Wait until nothing is happening: every background task done and no new activity. */
  async settle() {
    for (let quiet = 0; quiet < 2;) {
      const before = this.activity;
      await Promise.all([...this.nodes.values()].map((node) => node.messenger.settled()));
      await new Promise((resolve) => setImmediate(resolve));
      quiet = this.activity === before ? quiet + 1 : 0;
    }
  }
}

class TestNode {
  constructor(world, t, { name, config = {} }) {
    this.world = world;
    this.t = t;
    this.name = name;
    this.identity = Identity.generate();
    this.id = this.identity.nodeId;
    this.key = randomBytes(32);
    this.config = config;
    this.inbox = [];
    this.warnings = [];
    this.onMessage = (message) => {
      this.inbox.push(message);
    };
    world.cards.set(this.id, this.identity.card);
  }

  async start(extra = {}) {
    this.dir ??= await tempDir(this.t, this.name);
    this.storage = new NodeStorage({ dir: this.dir, storageKey: this.key });
    const index = this.storage.log('outbox');
    const seenLog = this.storage.log('seen');
    this.bodies = this.storage.blobs('outbox');
    await index.open();
    await seenLog.open();
    this.bus = new EventBus({ capacity: 5000 });
    this.events = [];
    this.bus.on('*', (event) => {
      this.world.activity += 1;
      this.events.push(event);
    });
    this.messenger = new ReliableMessenger({
      identity: this.identity,
      cardOf: (id) => this.world.cards.get(id) ?? null,
      originate: this.world.originateFor(this.id),
      isReachable: (dst) => this.world.reachable(this.id, dst),
      events: this.bus,
      now: this.world.now,
      monoNow: this.world.monoNow,
      rng: this.world.rng,
      schedule: this.world.schedule,
      log: { warn: (message, fields) => this.warnings.push({ message, fields }), debug: () => {} },
      index,
      seenLog,
      bodies: this.bodies,
      ...this.config,
      ...extra,
    });
    this.messenger.onKind('msg', (message) => this.onMessage(message));
    await this.messenger.open();
    this.world.nodes.set(this.id, this);
    return this;
  }

  async stop() {
    await this.messenger.close();
    await this.storage.closeAll();
    this.world.nodes.delete(this.id);
  }

  async restart(extra) {
    await this.stop();
    return this.start(extra);
  }

  send(to, options = {}) {
    return this.messenger.send(to.id, { kind: 'msg', content: text('hello'), ...options });
  }

  ev(type) {
    return this.events.filter((event) => event.type === type).map((event) => event.data);
  }
}

async function setup(t, { a = {}, b = {}, names = ['a', 'b'] } = {}) {
  const world = new World();
  const A = new TestNode(world, t, { name: names[0], config: a });
  const B = new TestNode(world, t, { name: names[1], config: b });
  await A.start();
  await B.start();
  t.after(async () => {
    for (const node of [A, B]) {
      await node.messenger.close().catch(() => {});
      await node.storage.closeAll().catch(() => {});
    }
  });
  return { world, A, B };
}

/** A message from `from` to `to` sealed by hand, for tests that play the attacker. */
function craft({ from, to, id = hex(), meta = { kind: 'msg', ack: true }, content = text('x'), now = T0, header = {} }) {
  const body = sealMessage({
    sender: from,
    recipientE2eKey: base64Decode(to.card.e2e, 32),
    dst: to.nodeId,
    id,
    meta,
    content,
    now,
  });
  return { header: { id, dst: to.nodeId, ttl: 16, try: 0, ...header }, body };
}

test('a reliable message is delivered once, acknowledged, and the outbox empties', async (t) => {
  const { world, A, B } = await setup(t);
  const result = await A.send(B, { content: text('hi there') });
  assert.equal(result.state, 'sent');
  assert.match(result.id, /^[0-9a-f]{32}$/);
  await world.settle();

  assert.equal(B.inbox.length, 1);
  const message = B.inbox[0];
  assert.equal(message.id, result.id);
  assert.equal(message.from, A.id);
  assert.equal(message.kind, 'msg');
  assert.equal(message.content.toString(), 'hi there');
  assert.equal(message.prevHop, A.id);
  assert.equal(message.viaCustody, null);
  assert.equal(message.meta.ack, true);
  assert.equal(message.card.id, A.id);
  assert.equal(message.ts, T0);
  assert.equal(message.receivedAt, T0);

  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  assert.equal(A.messenger.get(result.id), null);
  assert.deepEqual(A.ev('message.queued'), [{ id: result.id, dst: B.id, kind: 'msg', bytes: A.ev('message.queued')[0].bytes }]);
  assert.deepEqual(A.ev('message.sent'), [{ id: result.id, dst: B.id, kind: 'msg', attempt: 1, nextHop: B.id }]);
  assert.deepEqual(A.ev('message.acked'), [{ id: result.id, dst: B.id, kind: 'msg', attempts: 1, elapsedMs: 0 }]);
  assert.deepEqual(B.ev('message.received'), [
    { id: result.id, from: A.id, kind: 'msg', bytes: 8, prevHop: A.id, viaCustody: null },
  ]);
  assert.equal(world.packetsFrom(A).length, 1);
  assert.equal(world.packetsFrom(B).length, 1, 'one ack');
  assert.equal(A.messenger.stats().acked, 1);
  assert.equal(B.messenger.stats().received, 1);
  assert.equal(B.messenger.stats().seenEntries, 1);
  assert.deepEqual(A.warnings, []);
  assert.deepEqual(B.warnings, []);
  assert.equal(world.liveTimers(), 0, 'nothing is left scheduled');
});

test('lost data packet and lost ack: retransmission with increasing try, one delivery, re-ack', async (t) => {
  const { world, A, B } = await setup(t);
  let toB = 0;
  let toA = 0;
  world.rule = (record) => {
    if (record.from === A.id) return toB++ === 0 ? [] : [0];
    return toA++ === 0 ? [] : [0];
  };
  const { id } = await A.send(B);
  await world.settle();
  assert.equal(B.inbox.length, 0, 'the first data packet was lost');

  await world.advance(2_000);
  assert.equal(B.inbox.length, 1, 'delivered by the first retransmission');
  assert.equal(A.messenger.pending().length, 1, 'but its ack was lost');

  await world.advance(4_000);
  assert.equal(B.inbox.length, 1, 'the handler ran once');
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(world.packetsFrom(A).map((r) => r.header.try), [0, 1, 2]);
  assert.deepEqual(world.packetsFrom(A).map((r) => r.header.id), [id, id, id]);
  assert.equal(B.messenger.stats().duplicates, 1);
  assert.equal(B.ev('message.duplicate').length, 1);
  assert.equal(A.ev('message.sent').map((e) => e.attempt).join(), '1,2,3');
  assert.equal(A.ev('message.acked')[0].attempts, 3);
  assert.equal(A.messenger.stats().retransmits, 2);
});

test('a duplicate is re-acknowledged at most once per half retransmit interval', async (t) => {
  const { world, A, B } = await setup(t);
  let toB = 0;
  world.rule = (record) => {
    if (record.from === B.id) return [];
    return toB++ === 0 ? [0, 10, 20] : [0];
  };
  await A.send(B);
  await world.advance(50);
  assert.equal(B.inbox.length, 1);
  assert.equal(B.messenger.stats().duplicates, 2);
  assert.equal(world.packetsFrom(B).length, 2, 'the ack plus one re-ack; the third copy is inside the gate');
  const original = world.packetsFrom(A)[0];

  await world.advance(1_500);
  await world.deliver(original);
  assert.equal(world.packetsFrom(B).length, 3, 'a copy after the gate interval is acknowledged again');
  assert.equal(B.inbox.length, 1);
});

test('backoff follows min(max, 2 s * 2^(n-1)) with jitter, and the counter is the attempt number', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  await A.send(B);
  await world.advance(5_000_000);
  const times = world.packetsFrom(A).map((r) => r.t - T0);
  assert.ok(times.length >= 14, `got ${times.length} attempts`);
  let expected = 0;
  for (let n = 1; n < 14; n += 1) {
    expected += Math.min(900_000, 2_000 * 2 ** (n - 1));
    assert.equal(times[n], expected, `attempt ${n + 1}`);
  }
  assert.deepEqual(world.packetsFrom(A).slice(0, 5).map((r) => r.header.try), [0, 1, 2, 3, 4]);
  const entry = A.messenger.pending()[0];
  assert.equal(entry.state, 'backoff');
  assert.equal(entry.attempts, times.length);
  assert.ok(entry.nextAttemptAt > world.wall);
});

test('jitter stays within 0.9 to 1.1 of the nominal delay', async (t) => {
  for (const [rngValue, lowest, highest] of [[0, 1_800, 1_800], [0.999999, 2_199, 2_200]]) {
    const { world, A, B } = await setup(t);
    world.rule = () => [];
    world.rngValue = rngValue;
    await A.send(B);
    await world.advance(lowest - 1);
    assert.equal(world.packetsFrom(A).length, 1, 'not before the lowest delay');
    await world.advance(highest - lowest + 1);
    assert.equal(world.packetsFrom(A).length, 2, 'by the highest delay');
  }
});

test('try wraps modulo 256', async (t) => {
  const { world, A, B } = await setup(t, { a: { retransmitMinMs: 10, retransmitMaxMs: 10 } });
  world.rule = () => [];
  await A.send(B);
  await world.advance(3_000);
  const tries = world.packetsFrom(A).map((r) => r.header.try);
  assert.ok(tries.length > 290, `got ${tries.length} attempts`);
  tries.forEach((value, i) => assert.equal(value, i & 0xff));
  assert.equal(tries[255], 255);
  assert.equal(tries[256], 0);
  assert.equal(tries[257], 1);
});

test('no route: the message waits without consuming an attempt; a route triggers floor plus jitter', async (t) => {
  const { world, A, B } = await setup(t);
  world.down.add(`${A.id}>${B.id}`);
  const result = await A.send(B);
  assert.equal(result.state, 'waiting');
  assert.deepEqual(A.ev('message.waiting'), [{ id: result.id, dst: B.id, kind: 'msg' }]);
  assert.equal(A.messenger.pending()[0].state, 'waiting');
  assert.equal(A.messenger.pending()[0].nextAttemptAt, null);
  assert.equal(A.messenger.pending()[0].attempts, 0);
  await world.advance(600_000);
  assert.equal(world.log.length, 0);
  assert.equal(A.ev('message.waiting').length, 1, 'emitted on the transition only');
  assert.equal(world.liveTimers(), 1, 'only the expiry deadline is pending');

  world.down.clear();
  A.messenger.routesChanged({ reachable: [B.id] });
  await world.advance(ROUTE_JITTER_MS / 2 - 1);
  assert.equal(world.log.length, 0, 'not immediately: jitter first');
  await world.advance(1);
  assert.equal(world.packetsFrom(A).length, 1);
  assert.equal(B.inbox.length, 1);
  assert.equal(world.packetsFrom(A)[0].header.try, 0, 'the first transmission is try 0');
});

test('a route appearing does not beat the backoff floor and never delays a sooner attempt', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  await A.send(B);
  assert.equal(world.packetsFrom(A).length, 1);
  await world.advance(500);
  A.messenger.routesChanged({ reachable: [B.id] });
  await world.advance(1_499);
  assert.equal(world.packetsFrom(A).length, 1, 'the scheduled attempt (t+2000) was kept, not delayed');
  await world.advance(1);
  assert.equal(world.packetsFrom(A).length, 2);

  // Attempt 2 was at t+2000 and the next is due at t+6000. A route event at t+2100 may
  // bring it forward, but not before the floor (t+4000) and not by more than the jitter.
  await world.advance(100);
  A.messenger.routesChanged({ reachable: [B.id] });
  await world.advance(1_899);
  assert.equal(world.packetsFrom(A).length, 2, 'still before the floor');
  await world.advance(1_001);
  assert.equal(world.packetsFrom(A).length, 3, 'sent at floor plus jitter (t+5000)');
  assert.equal(world.packetsFrom(A)[2].t - T0, 5_000);
});

test('route changes for other destinations or with junk are ignored', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  await A.send(B);
  A.messenger.routesChanged({ reachable: [hex(), 5, null] });
  A.messenger.routesChanged({ reachable: 'x' });
  A.messenger.routesChanged();
  await world.advance(1_000);
  assert.equal(world.packetsFrom(A).length, 1);
});

test('at most four unacknowledged messages are in flight per destination', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = (record) => (record.from === B.id ? [] : [0]);
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push(await A.send(B, { content: text(`m${i}`) }));
  assert.deepEqual(results.map((r) => r.state), ['sent', 'sent', 'sent', 'sent', 'waiting', 'waiting']);
  assert.equal(world.packetsFrom(A).length, 4);
  assert.equal(B.inbox.length, 4);
  assert.deepEqual(A.messenger.pending().map((e) => e.state), ['backoff', 'backoff', 'backoff', 'backoff', 'waiting', 'waiting']);

  world.rule = () => [0];
  await world.advance(2_000);
  assert.equal(B.inbox.length, 6, 'acks freed the slots and the rest went at once');
  assert.deepEqual(B.inbox.map((m) => m.content.toString()), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.deepEqual(A.messenger.pending(), []);
});

test('the in-flight limit is per destination', async (t) => {
  const { world, A, B } = await setup(t);
  const C = await new TestNode(world, t, { name: 'c' }).start();
  world.rule = () => [];
  for (let i = 0; i < 5; i += 1) await A.send(B);
  for (let i = 0; i < 5; i += 1) await A.send(C);
  assert.equal(world.packetsFrom(A).filter((r) => r.to === B.id).length, 4);
  assert.equal(world.packetsFrom(A).filter((r) => r.to === C.id).length, 4);
  await C.messenger.close();
  await C.storage.closeAll();
});

test('a message expires at the configured lifetime, and a per-message lifetime is honoured', async (t) => {
  const config = { messageLifetimeMs: 10_000 };
  const { world, A, B } = await setup(t, { a: config, b: config });
  world.rule = () => [];
  const long = await A.send(B);
  const short = await A.send(B, { lifetimeMs: 4_000 });
  assert.equal(A.messenger.get(short.id).expiresAt, T0 + 4_000);
  assert.equal(A.messenger.get(long.id).expiresAt, T0 + 10_000);

  await world.advance(3_999);
  assert.equal(A.messenger.pending().length, 2);
  await world.advance(1);
  assert.deepEqual(A.ev('message.expired'), [{ id: short.id, dst: B.id, kind: 'msg' }]);
  assert.deepEqual(A.messenger.pending().map((e) => e.id), [long.id]);
  await world.advance(6_000);
  assert.deepEqual(A.ev('message.expired').map((e) => e.id), [short.id, long.id]);
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  assert.equal(A.messenger.stats().expired, 2);
  assert.equal(world.liveTimers(), 0);

  await A.restart();
  assert.deepEqual(A.messenger.pending(), [], 'the removals were persisted');
  assert.equal(A.warnings.length, 0);
});

test('an entry that expired while the node was down is dropped at open, body included', async (t) => {
  const config = { messageLifetimeMs: 10_000 };
  const { world, A, B } = await setup(t, { a: config, b: config });
  world.rule = () => [];
  const { id } = await A.send(B);
  await A.stop();
  world.wall += 11_000;
  world.mono += 11_000;
  await A.start();
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(A.ev('message.expired'), [{ id, dst: B.id, kind: 'msg' }]);
  assert.deepEqual(await A.bodies.keys(), []);
});

test('restart in the middle of a retransmission schedule: the message is still sent, delivered once', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const { id } = await A.send(B);
  await world.advance(5_000);
  assert.equal(world.packetsFrom(A).length, 2, 'attempts at 0 and 2 s so far; the third is due at 6 s');
  const before = world.packetsFrom(A).length;

  await A.restart();
  const entry = A.messenger.get(id);
  assert.ok(entry, 'the entry survived');
  assert.equal(entry.attempts, 0, 'the schedule starts over');
  assert.equal(entry.state, 'backoff');
  assert.ok(entry.nextAttemptAt >= world.wall && entry.nextAttemptAt <= world.wall + 2_000);

  world.rule = () => [0];
  await world.advance(2_000);
  assert.equal(world.packetsFrom(A).length, before + 1);
  assert.equal(B.inbox.length, 1);
  assert.equal(B.inbox[0].id, id);
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  assert.equal(A.warnings.length, 0);
});

test('restarts spread the first attempts and respect the in-flight limit', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  for (let i = 0; i < 7; i += 1) await A.send(B);
  await A.restart();
  assert.equal(A.messenger.pending().length, 7);
  assert.deepEqual(A.messenger.pending().map((e) => e.state), ['backoff', 'backoff', 'backoff', 'backoff', 'waiting', 'waiting', 'waiting']);
  const before = world.log.length;
  world.rngValue = 0.999;
  await world.advance(2_000);
  assert.equal(world.log.length - before, 4);
});

test('restart of the receiver: delivered ids stay suppressed, the duplicate is re-acked', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = (record) => (record.from === B.id ? [] : [0]);
  const { id } = await A.send(B);
  assert.equal(B.inbox.length, 1);
  assert.equal(A.messenger.pending().length, 1, 'the ack was lost');

  await B.restart();
  assert.equal(B.messenger.stats().seenEntries, 1, 'the seen cache was reloaded');
  world.rule = () => [0];
  await world.advance(2_000);
  assert.equal(B.inbox.length, 1, 'not delivered a second time');
  assert.equal(B.messenger.stats().duplicates, 1);
  assert.deepEqual(A.messenger.pending(), [], 'but acknowledged');
  assert.deepEqual(world.packetsFrom(A).map((r) => r.header.id), [id, id]);
});

test('open repairs the stores: torn tails, an orphan blob, an entry without its blob', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const keep = await A.send(B, { content: text('keep') });
  const lose = await A.send(B, { content: text('lose') });
  await A.stop();
  await rm(join(A.dir, 'outbox', lose.id));
  await appendFile(join(A.dir, 'outbox.log'), '{"b":"AAAA');
  await appendFile(join(A.dir, 'seen.log'), '{"b":"AAAA');
  const orphan = new NodeStorage({ dir: A.dir, storageKey: A.key });
  await orphan.blobs('outbox').put('f'.repeat(32), text('orphan'));

  await A.start();
  assert.deepEqual(A.messenger.pending().map((e) => e.id), [keep.id]);
  assert.deepEqual(A.ev('message.cancelled'), [{ id: lose.id, dst: B.id, kind: 'msg' }]);
  assert.deepEqual(await A.bodies.keys(), [keep.id]);
  assert.equal(A.messenger.stats().cancelled, 1);
  await A.restart();
  assert.deepEqual(A.messenger.pending().map((e) => e.id), [keep.id], 'the drop was persisted');
});

test('open skips invalid index records, counts them, and compacts a log full of dead records', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const live = await A.send(B);
  await A.stop();
  const store = new NodeStorage({ dir: A.dir, storageKey: A.key });
  const index = store.log('outbox');
  await index.open();
  for (let i = 0; i < 600; i += 1) {
    const id = hex();
    await index.append({
      op: 'add', id, dst: B.id, kind: 'msg', createdAt: T0, expiresAt: T0 + 5, bytes: 9, custody: true,
    });
    await index.append({ op: 'del', id, why: 'acked' });
  }
  await index.append({ op: 'zzz' });
  await index.append({ op: 'add', id: 'bad' });
  await index.append({ op: 'cust', id: live.id, custodian: 'not-a-node', state: null });
  await index.append({ op: 'del', id: 5, why: 'acked' });
  await index.flush();
  await store.closeAll();

  await A.start();
  assert.equal(A.messenger.stats().outboxCorrupt, 4);
  assert.deepEqual(A.messenger.pending().map((e) => e.id), [live.id]);
  await A.stop();

  const reread = new NodeStorage({ dir: A.dir, storageKey: A.key }).log('outbox');
  await reread.open();
  const records = [];
  for await (const record of reread.read()) records.push(record);
  await reread.close();
  assert.equal(records.length, 1);
  assert.equal(records[0].op, 'add');
  assert.equal(records[0].id, live.id);
});

test('an ack from a node other than the destination does not remove the entry', async (t) => {
  const { world, A, B } = await setup(t);
  const E = Identity.generate();
  world.rule = () => [];
  const { id } = await A.send(B);

  const forged = craft({ from: E, to: A.identity, meta: { kind: 'ack', id }, now: world.wall });
  await A.messenger.handleData(forged, { from: B.id });
  assert.equal(A.messenger.pending().length, 1, 'authenticated, but not by the destination');
  assert.equal(A.messenger.stats().ackMismatch, 1);

  const genuine = craft({ from: B.identity, to: A.identity, meta: { kind: 'ack', id }, now: world.wall });
  await A.messenger.handleData(genuine, { from: B.id });
  assert.deepEqual(A.messenger.pending(), []);
  assert.equal(A.messenger.stats().acked, 1);

  // A replay of the genuine ack, and an ack for something that is not in the outbox.
  await A.messenger.handleData(genuine, { from: E.nodeId });
  assert.equal(A.messenger.stats().duplicates, 1);
  const stray = craft({ from: B.identity, to: A.identity, meta: { kind: 'ack', id: hex() }, now: world.wall });
  await A.messenger.handleData(stray, { from: B.id });
  assert.equal(A.messenger.stats().ackUnknown, 1);
  assert.equal(A.messenger.stats().acked, 1);
});

test('an ack for one message cannot remove another, and a message body cannot pose as an ack', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const first = await A.send(B);
  const second = await A.send(B);
  const ack = craft({ from: B.identity, to: A.identity, meta: { kind: 'ack', id: first.id }, now: world.wall });
  await A.messenger.handleData(ack, { from: B.id });
  assert.deepEqual(A.messenger.pending().map((e) => e.id), [second.id]);
  // A `msg` that merely carries an `id` field is not an ack.
  const lookalike = craft({ from: B.identity, to: A.identity, meta: { kind: 'msg', ack: false, id: second.id }, now: world.wall });
  await A.messenger.handleData(lookalike, { from: B.id });
  assert.equal(A.messenger.pending().length, 1);
});

test('forged packets are dropped as auth failures and do not poison the seen cache', async (t) => {
  const { world, A, B } = await setup(t);
  const C = Identity.generate();
  world.rule = () => [];
  const { id } = await A.send(B);
  const genuine = world.packetsFrom(A)[0];
  const pristine = () => ({ header: { ...genuine.header }, body: Buffer.from(genuine.body) });

  for (const position of [0, 1, 4, 20, 100, genuine.body.length >> 1, genuine.body.length - 1]) {
    const packet = pristine();
    packet.body[position] ^= 0x01;
    await B.messenger.handleData(packet, { from: A.id });
  }
  const stolen = craft({ from: A.identity, to: C, id: hex(), now: world.wall });
  await B.messenger.handleData({ header: { ...stolen.header, dst: B.id }, body: stolen.body }, { from: A.id });
  const relabelled = pristine();
  relabelled.header.id = hex();
  await B.messenger.handleData(relabelled, { from: A.id });
  const stale = craft({ from: A.identity, to: B.identity, now: world.wall - 604_800_000 - 1 });
  await B.messenger.handleData(stale, { from: A.id });
  const future = craft({ from: A.identity, to: B.identity, now: world.wall + 300_001 });
  await B.messenger.handleData(future, { from: A.id });
  const truncated = pristine();
  truncated.body = truncated.body.subarray(0, truncated.body.length - 1);
  await B.messenger.handleData(truncated, { from: A.id });

  assert.equal(B.inbox.length, 0);
  assert.equal(B.messenger.stats().authFailures, 7 + 5);
  assert.equal(B.messenger.stats().seenEntries, 0);
  assert.equal(world.packetsFrom(B).length, 0, 'no ack for forgeries');
  assert.ok(B.ev('packet.dropped').every((e) => e.reason === 'auth' && e.dst === B.id && e.from === A.id));

  await B.messenger.handleData(pristine(), { from: A.id });
  assert.equal(B.inbox.length, 1, 'the genuine packet with the same id is still delivered');
  assert.equal(B.inbox[0].id, id);
});

test('anyone who saw an id cannot burn it: the cache is keyed by sender and id', async (t) => {
  const { world, A, B } = await setup(t);
  const E = Identity.generate();
  world.rule = () => [];
  const { id } = await A.send(B, { content: text('genuine') });
  const genuine = world.packetsFrom(A)[0];
  const burn = craft({ from: E, to: B.identity, id, content: text('evil'), now: world.wall });
  await B.messenger.handleData(burn, { from: E.nodeId });
  await B.messenger.handleData({ header: { ...genuine.header }, body: Buffer.from(genuine.body) }, { from: A.id });
  assert.deepEqual(B.inbox.map((m) => [m.from === E.nodeId ? 'E' : 'A', m.content.toString()]), [
    ['E', 'evil'],
    ['A', 'genuine'],
  ]);
  assert.equal(B.messenger.stats().duplicates, 0);
});

test('a ts at the skew limit is accepted, one past it is not; the entry lives until ts + lifetime + skew', async (t) => {
  const config = { messageLifetimeMs: 60_000, maxClockSkewMs: 5_000 };
  const { world, A, B } = await setup(t, { a: config, b: config });
  world.rule = () => [];
  const tooFar = craft({ from: A.identity, to: B.identity, now: world.wall + 5_001 });
  await B.messenger.handleData(tooFar, { from: A.id });
  assert.equal(B.inbox.length, 0);
  assert.equal(B.messenger.stats().authFailures, 1);

  const ahead = craft({ from: A.identity, to: B.identity, now: world.wall + 5_000 });
  await B.messenger.handleData(ahead, { from: A.id });
  assert.equal(B.inbox.length, 1);
  assert.equal(B.inbox[0].ts, world.wall + 5_000);

  await world.advance(69_999);
  assert.equal(B.messenger.stats().seenEntries, 1, 'still protected at ts + lifetime + skew - 1');
  await B.messenger.handleData(ahead, { from: A.id });
  assert.equal(B.inbox.length, 1, 'a replay inside the window is a duplicate');
  assert.equal(B.messenger.stats().duplicates, 1);
  await world.advance(2);
  assert.equal(B.messenger.stats().seenEntries, 0);
  await B.messenger.handleData(ahead, { from: A.id });
  assert.equal(B.inbox.length, 1, 'after that the message is too old to be accepted at all');
  assert.equal(B.messenger.stats().authFailures, 2);
});

test('a replay after the lifetime is rejected as stale; a replay inside it is suppressed after a restart', async (t) => {
  const config = { messageLifetimeMs: 60_000, maxClockSkewMs: 5_000 };
  const { world, A, B } = await setup(t, { a: config, b: config });
  world.rule = (record) => (record.from === B.id ? [] : [0]);
  await A.send(B);
  const captured = world.packetsFrom(A)[0];
  await world.advance(30_000);
  await B.restart();
  await B.messenger.handleData({ header: { ...captured.header }, body: Buffer.from(captured.body) }, { from: A.id });
  assert.equal(B.inbox.length, 1, 'the persisted seen entry suppressed the replay');
  assert.equal(B.messenger.stats().duplicates, 1);
  await world.advance(40_000);
  await B.messenger.handleData({ header: { ...captured.header }, body: Buffer.from(captured.body) }, { from: A.id });
  assert.equal(B.inbox.length, 1);
  assert.equal(B.messenger.stats().authFailures, 1);
});

test('expired seen entries are dropped at open and the log is rewritten', async (t) => {
  const config = { messageLifetimeMs: 60_000, maxClockSkewMs: 5_000 };
  const { world, A, B } = await setup(t, { a: config, b: config });
  for (let i = 0; i < 6; i += 1) await A.send(B);
  await world.settle();
  assert.equal(B.inbox.length, 6);
  await B.stop();
  world.wall += 70_001;
  world.mono += 70_001;
  await B.start();
  assert.equal(B.messenger.stats().seenEntries, 0);
  await B.stop();
  const log = new NodeStorage({ dir: B.dir, storageKey: B.key }).log('seen');
  await log.open();
  const records = [];
  for await (const record of log.read()) records.push(record);
  await log.close();
  assert.deepEqual(records, []);
});

test('the seen cache is bounded', async (t) => {
  const { world, A, B } = await setup(t, { b: { seenCacheEntries: 3 } });
  for (let i = 0; i < 5; i += 1) await A.send(B);
  await world.settle();
  assert.equal(B.inbox.length, 5);
  assert.equal(B.messenger.stats().seenEntries, 3);
  await B.restart();
  assert.equal(B.messenger.stats().seenEntries, 3);
});

test('a handler that rejects is retried on the next retransmission; nothing was recorded or acked', async (t) => {
  const { world, A, B } = await setup(t);
  let calls = 0;
  B.onMessage = (message) => {
    calls += 1;
    if (calls === 1) throw new Error('secret plaintext must not leak');
    B.inbox.push(message);
  };
  const { id } = await A.send(B);
  assert.equal(B.inbox.length, 0);
  assert.equal(B.messenger.stats().handlerErrors, 1);
  assert.equal(B.messenger.stats().seenEntries, 0);
  assert.equal(A.messenger.pending().length, 1);
  const error = B.ev('message.handler_error');
  assert.deepEqual(error, [{ id, from: A.id, kind: 'msg', message: 'Error' }]);
  assert.equal(world.packetsFrom(B).length, 0);

  await world.advance(2_000);
  assert.equal(B.inbox.length, 1);
  assert.equal(calls, 2);
  assert.deepEqual(A.messenger.pending(), []);
  assert.equal(B.ev('message.received').length, 1);
});

test('an async handler is awaited before the id is recorded and the ack is sent', async (t) => {
  const { world, A, B } = await setup(t);
  let release;
  B.onMessage = (message) => new Promise((resolve) => {
    release = () => {
      B.inbox.push(message);
      resolve();
    };
  });
  await A.send(B);
  assert.equal(B.messenger.stats().inboundInFlight, 1);
  assert.equal(world.packetsFrom(B).length, 0, 'no ack while the handler runs');
  release();
  await world.settle();
  assert.equal(B.messenger.stats().inboundInFlight, 0);
  assert.equal(world.packetsFrom(B).length, 1);
  assert.deepEqual(A.messenger.pending(), []);
});

test('a message of a kind nobody handles is acknowledged and reported', async (t) => {
  const { world, A, B } = await setup(t);
  const { id } = await A.send(B, { kind: 'zzz-test' });
  await world.settle();
  assert.deepEqual(B.ev('message.unhandled'), [{ id, from: A.id, kind: 'zzz-test' }]);
  assert.deepEqual(A.messenger.pending(), []);
  assert.equal(B.messenger.stats().unhandled, 1);
  assert.equal(B.messenger.stats().received, 1);
});

test('inbound limits: too many handlers running means busy, not recorded, retried later', async (t) => {
  const { world, A, B } = await setup(t, { b: { maxInbound: 1 } });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  B.onMessage = async (message) => {
    await gate;
    B.inbox.push(message);
  };
  await A.send(B, { content: text('one') });
  await A.send(B, { content: text('two') });
  assert.equal(B.messenger.stats().busy, 1);
  assert.equal(B.messenger.stats().inboundInFlight, 1);
  release();
  await world.settle();
  assert.equal(B.inbox.length, 1);
  await world.advance(2_000);
  assert.deepEqual(B.inbox.map((m) => m.content.toString()), ['one', 'two']);
  assert.deepEqual(A.messenger.pending(), []);
});

test('a byte-identical retransmission is recognised without opening it again', async (t) => {
  let opens = 0;
  const counting = (args) => {
    opens += 1;
    return openMessage(args);
  };
  const { world, A, B } = await setup(t, { b: { openMessage: counting } });
  world.rule = (record) => (record.from === B.id ? [] : [0]);
  await A.send(B);
  assert.equal(opens, 1);
  await world.advance(2_000);
  await world.advance(4_000);
  assert.equal(world.packetsFrom(A).length, 3);
  assert.equal(opens, 1, 'two retransmissions, no further public-key work');
  assert.equal(B.messenger.stats().duplicates, 2);
  assert.equal(B.inbox.length, 1);
});

test('the previous hop and the custodian reach the handler and the event', async (t) => {
  const { world, A, B } = await setup(t);
  const mailbox = Identity.generate().nodeId;
  const relay = Identity.generate().nodeId;
  world.rule = () => [];
  const { id } = await A.send(B);
  const packet = world.packetsFrom(A)[0];
  await B.messenger.handleData({ header: { ...packet.header, cust: mailbox }, body: Buffer.from(packet.body) }, { from: relay });
  assert.equal(B.inbox[0].prevHop, relay);
  assert.equal(B.inbox[0].viaCustody, mailbox);
  assert.deepEqual(B.ev('message.received'), [
    { id, from: A.id, kind: 'msg', bytes: 5, prevHop: relay, viaCustody: mailbox },
  ]);
});

test('inbound meta is validated: bad kind, bad ack flag and oversize meta are dropped unrecorded', async (t) => {
  const { A, B } = await setup(t);
  const bad = [
    { kind: 'BAD KIND' },
    { kind: 'msg', ack: 'yes' },
    { kind: 'msg' },
    { kind: 'msg', ack: true, extra: 1 },
    { kind: 'ack' },
    { kind: 'ack', id: 'short' },
    { kind: 'other-kind', ack: 1 },
    { kind: 'other-kind', filler: 'y'.repeat(MAX_META_BYTES) },
  ];
  for (const meta of bad) {
    await B.messenger.handleData(craft({ from: A.identity, to: B.identity, meta }), { from: A.id });
  }
  assert.equal(B.inbox.length, 0);
  assert.equal(B.messenger.stats().malformed, bad.length);
  assert.equal(B.messenger.stats().seenEntries, 0);
  assert.equal(B.messenger.stats().authFailures, 0);
});

test('hostile input to handleData never throws and is counted', async (t) => {
  const { A, B } = await setup(t);
  const good = craft({ from: A.identity, to: B.identity });
  const weird = [
    undefined, null, 5, 'x', [], {}, { header: null }, { header: {}, body: Buffer.from([1]) },
    { header: { ...good.header, extra: 1 }, body: good.body },
    { header: { ...good.header, dst: A.id }, body: good.body },
    { header: good.header, body: 'text' },
    { header: good.header, body: Buffer.alloc(0) },
    { header: { ...good.header, id: 'ZZ' }, body: good.body },
  ];
  for (const packet of weird) {
    await assert.doesNotReject(() => B.messenger.handleData(packet, { from: A.id }));
  }
  await assert.doesNotReject(() => B.messenger.handleData(good));
  await assert.doesNotReject(() => B.messenger.handleData(good, { from: 5 }));
  assert.equal(B.messenger.stats().malformed, weird.length);
  assert.equal(B.inbox.length, 1);
});

test('a flood of undecryptable packets is cheap and its events are rate-capped', async (t) => {
  const { A, B } = await setup(t);
  for (let i = 0; i < 200; i += 1) {
    const body = Buffer.concat([Buffer.from([1]), randomBytes(150 + (i % 50))]);
    await B.messenger.handleData({ header: { id: hex(), dst: B.id, ttl: 16, try: 0 }, body }, { from: A.id });
  }
  assert.equal(B.messenger.stats().authFailures, 200);
  assert.equal(B.ev('packet.dropped').length, 50);
  assert.equal(B.messenger.stats().authEventsSuppressed, 150);
  assert.equal(B.messenger.stats().seenEntries, 0);
});

test('send validates its arguments', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const stranger = Identity.generate();
  const unknown = await A.messenger.send(stranger.nodeId, { kind: 'msg' }).catch((error) => error);
  assert.ok(unknown instanceof StateError);
  assert.match(unknown.message, /^unknown-destination: /);
  world.cards.set(stranger.nodeId, B.identity.card);
  const wrongCard = await A.messenger.send(stranger.nodeId, { kind: 'msg' }).catch((error) => error);
  assert.match(wrongCard.message, /^unknown-destination: /, 'a card for another node is not accepted');
  world.cards.set(stranger.nodeId, { ...stranger.card, sig: B.identity.card.sig });
  assert.match((await A.messenger.send(stranger.nodeId, { kind: 'msg' }).catch((e) => e)).message, /^unknown-destination: /);

  const cases = [
    [A.id, { kind: 'msg' }],
    ['nope', { kind: 'msg' }],
    [B.id, {}],
    [B.id, { kind: 'ack' }],
    [B.id, { kind: 'Bad Kind' }],
    [B.id, { kind: 'msg', meta: { kind: 'x' } }],
    [B.id, { kind: 'msg', meta: { card: 1 } }],
    [B.id, { kind: 'msg', meta: { ts: 1 } }],
    [B.id, { kind: 'msg', meta: { hs: 'x' } }],
    [B.id, { kind: 'msg', meta: { ack: true } }],
    [B.id, { kind: 'msg', meta: [] }],
    [B.id, { kind: 'msg', meta: { pi: 3.14 } }],
    [B.id, { kind: 'msg', meta: JSON.parse('{"__proto__": 1}') }],
    [B.id, { kind: 'msg', meta: { big: 'y'.repeat(MAX_META_BYTES) } }],
    [B.id, { kind: 'msg', content: 'not bytes' }],
    [B.id, { kind: 'msg', content: Buffer.alloc(MAX_SEALED_CONTENT + 1) }],
    [B.id, { kind: 'msg', content: Buffer.alloc(200_000) }],
    [B.id, { kind: 'msg', reliable: 'yes' }],
    [B.id, { kind: 'msg', custody: 1 }],
    [B.id, { kind: 'msg', lifetimeMs: 0 }],
    [B.id, { kind: 'msg', lifetimeMs: 1.5 }],
    [B.id, { kind: 'msg', lifetimeMs: 604_800_001 }],
  ];
  for (const [dst, options] of cases) {
    await assert.rejects(A.messenger.send(dst, options), ConfigError, JSON.stringify(options).slice(0, 80));
  }
  const tooBig = await A.messenger.send(B.id, { kind: 'msg', content: Buffer.alloc(200_000) }).catch((e) => e);
  assert.match(tooBig.message, /^message-too-large/);
  const bigMeta = await A.messenger.send(B.id, { kind: 'msg', meta: { big: 'y'.repeat(MAX_META_BYTES) } }).catch((e) => e);
  assert.match(bigMeta.message, /^meta-too-large/);
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  assert.equal(world.log.length, 0);
});

test('a message of the largest size that fits one packet goes through', async (t) => {
  const { world, A, B } = await setup(t);
  let size = 130_000;
  let sent = null;
  while (sent === null && size > 100_000) {
    sent = await A.send(B, { content: Buffer.alloc(size, 7) }).catch(() => null);
    size -= 1_000;
  }
  assert.ok(sent, 'something near the limit fits');
  await world.settle();
  assert.equal(B.inbox.length, 1);
  assert.equal(B.inbox[0].content.length, size + 1_000);
});

test('the outbox is bounded by entries and by bytes', async (t) => {
  const { world, A, B } = await setup(t, { a: { outboxMaxEntries: 2 } });
  world.rule = () => [];
  await A.send(B);
  await A.send(B);
  const full = await A.send(B).catch((error) => error);
  assert.ok(full instanceof StateError);
  assert.match(full.message, /^outbox-full: /);
  assert.equal((await A.bodies.keys()).length, 2);
  assert.equal(A.messenger.stats().outboxEntries, 2);

  const small = await setup(t, { a: { outboxMaxBytes: 1_000 }, names: ['c', 'd'] });
  small.world.rule = () => [];
  await small.A.send(small.B);
  const second = await small.A.send(small.B).catch((error) => error);
  assert.match(second.message, /^outbox-full: /);
  assert.equal((await small.A.bodies.keys()).length, 1);
});

test('concurrent sends cannot overshoot the outbox bound', async (t) => {
  const { world, A, B } = await setup(t, { a: { outboxMaxEntries: 3 } });
  world.rule = () => [];
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => A.send(B)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(A.messenger.pending().length, 3);
  assert.equal((await A.bodies.keys()).length, 3);
});

test('an unreliable message is sent once and nothing is stored', async (t) => {
  const { world, A, B } = await setup(t);
  const seen = [];
  B.messenger.onKind('probe-reply', (message) => {
    seen.push(message);
  });
  const sent = await A.messenger.send(B.id, { kind: 'probe-reply', meta: { n: 3 }, reliable: false });
  assert.equal(sent.state, 'sent');
  await world.settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.n, 3);
  assert.equal(Object.hasOwn(seen[0].meta, 'ack'), false);
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  assert.equal(world.packetsFrom(B).length, 0, 'no ack was asked for');

  await A.messenger.send(B.id, { kind: 'msg', reliable: false });
  await world.settle();
  assert.equal(B.inbox[0].meta.ack, false, 'a msg always carries its ack flag');
  assert.equal(world.packetsFrom(B).length, 0);

  world.down.add(`${A.id}>${B.id}`);
  const dropped = await A.messenger.send(B.id, { kind: 'probe-reply', reliable: false });
  assert.equal(dropped.state, 'dropped');
  await world.advance(100_000);
  assert.equal(world.log.length, 2);
});

test('back-pressure is retried after a quarter of the floor and is not an attempt', async (t) => {
  const { world, A, B } = await setup(t);
  world.backpressure.add(`${A.id}>${B.id}`);
  const result = await A.send(B);
  assert.equal(result.state, 'waiting');
  const entry = A.messenger.pending()[0];
  assert.equal(entry.attempts, 0);
  assert.equal(entry.nextAttemptAt, world.wall + 500);
  await world.advance(500);
  assert.equal(A.messenger.pending()[0].attempts, 0);
  assert.equal(A.ev('message.sent').length, 0);
  world.backpressure.clear();
  await world.advance(500);
  assert.equal(B.inbox.length, 1);
  assert.equal(A.ev('message.sent')[0].attempt, 1);
});

test('an originate that throws is counted as an attempt, not a hot loop', async (t) => {
  const world = new World();
  let calls = 0;
  const A = await new TestNode(world, t, { name: 'a' }).start({
    originate: () => {
      calls += 1;
      throw new Error('forwarder bug');
    },
  });
  const B = await new TestNode(world, t, { name: 'b' }).start();
  t.after(async () => {
    await A.messenger.close();
    await B.messenger.close();
    await A.storage.closeAll();
    await B.storage.closeAll();
  });
  await A.send(B);
  assert.equal(calls, 1);
  await world.advance(1_999);
  assert.equal(calls, 1);
  await world.advance(1);
  assert.equal(calls, 2);
  await world.advance(4_000);
  assert.equal(calls, 3, 'the delay doubles: it backs off like any other attempt');
  assert.equal(A.messenger.stats().originateErrors, 3);
  assert.equal(A.ev('message.sent').length, 0, 'nothing was sent, so nothing is reported as sent');
  assert.equal(A.messenger.pending().length, 1);
});

test('cancel removes the entry, announces it and deletes the body', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const { id } = await A.send(B);
  assert.equal(A.messenger.cancel(hex()), false);
  assert.equal(A.messenger.cancel(id), true);
  assert.equal(A.messenger.cancel(id), false);
  await world.settle();
  assert.deepEqual(A.ev('message.cancelled'), [{ id, dst: B.id, kind: 'msg' }]);
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(await A.bodies.keys(), []);
  await world.advance(10_000);
  assert.equal(world.packetsFrom(A).length, 1, 'no further retransmission');
  await A.restart();
  assert.deepEqual(A.messenger.pending(), []);
});

test('custody state is persisted; packetOf returns the packet as last transmitted', async (t) => {
  const { world, A, B } = await setup(t);
  const mailbox = Identity.generate().nodeId;
  world.rule = () => [];
  const { id } = await A.send(B);
  const first = decodePacket(await A.messenger.packetOf(id));
  assert.equal(first.header.try, 0);
  await world.advance(2_000);
  const second = decodePacket(await A.messenger.packetOf(id));
  assert.equal(second.header.try, 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(await A.messenger.packetOf(hex()), null);

  A.messenger.setCustodian(id, mailbox, 'accepted');
  A.messenger.setCustodian(hex(), mailbox, 'accepted');
  assert.equal(A.messenger.get(id).custodian, mailbox);
  assert.equal(A.messenger.get(id).custodyState, 'accepted');
  assert.equal(A.messenger.get(id).custody, true);
  assert.throws(() => A.messenger.setCustodian(id, 'nope', 'accepted'), ConfigError);
  assert.throws(() => A.messenger.setCustodian(id, mailbox, 'maybe'), ConfigError);
  await A.restart();
  assert.equal(A.messenger.get(id).custodian, mailbox);
  assert.equal(A.messenger.get(id).custodyState, 'accepted');
  A.messenger.setCustodian(id, null, null);
  await A.restart();
  assert.equal(A.messenger.get(id).custodian, null);
});

test('a message can be sent without custody; the flag is kept', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  const { id } = await A.send(B, { custody: false });
  assert.equal(A.messenger.get(id).custody, false);
  await A.restart();
  assert.equal(A.messenger.get(id).custody, false);
});

test('close stops everything and refuses further sends; open cannot be repeated', async (t) => {
  const { world, A, B } = await setup(t);
  world.rule = () => [];
  await A.send(B);
  assert.equal(world.liveTimers() > 0, true);
  await A.messenger.close();
  await A.messenger.close();
  assert.equal(world.liveTimers(), 0);
  await assert.rejects(A.send(B), StateError);
  await assert.rejects(A.messenger.open(), StateError);
  const before = world.log.length;
  A.messenger.routesChanged({ reachable: [B.id] });
  await world.advance(100_000);
  assert.equal(world.log.length, before);
  await A.messenger.handleData(craft({ from: B.identity, to: A.identity }), { from: B.id });
  assert.equal(A.inbox.length, 0);
});

test('a messenger that is not open refuses to send and ignores packets', async (t) => {
  const { world, A, B } = await setup(t);
  const dir = await tempDir(t, 'closed');
  const storage = new NodeStorage({ dir, storageKey: randomBytes(32) });
  const index = storage.log('outbox');
  const seenLog = storage.log('seen');
  await index.open();
  await seenLog.open();
  const messenger = new ReliableMessenger({
    identity: A.identity,
    cardOf: () => B.identity.card,
    originate: () => ({ ok: true, nextHop: B.id }),
    now: world.now,
    monoNow: world.monoNow,
    schedule: world.schedule,
    index,
    seenLog,
    bodies: storage.blobs('outbox'),
  });
  await assert.rejects(messenger.send(B.id, { kind: 'msg' }), StateError);
  await messenger.handleData(craft({ from: B.identity, to: A.identity }), { from: B.id });
  assert.equal(messenger.stats().received, 0);
  await messenger.close();
  await storage.closeAll();
});

test('onKind: one handler per kind, validated, removable', async (t) => {
  const { A } = await setup(t);
  const handler = () => {};
  const off = A.messenger.onKind('file-offer', handler);
  assert.throws(() => A.messenger.onKind('file-offer', handler), ConfigError);
  assert.throws(() => A.messenger.onKind('ack', handler), ConfigError);
  assert.throws(() => A.messenger.onKind('Bad', handler), ConfigError);
  assert.throws(() => A.messenger.onKind('fine', 5), ConfigError);
  off();
  off();
  A.messenger.onKind('file-offer', handler);
});

test('the constructor rejects missing and malformed options', async (t) => {
  const { world, A } = await setup(t);
  const good = {
    identity: A.identity,
    cardOf: () => null,
    originate: () => ({ ok: false, reason: 'no-route' }),
    schedule: () => () => {},
    index: { read() {}, append() {}, rewrite() {}, flush() {} },
    seenLog: { read() {}, append() {}, rewrite() {}, flush() {} },
    bodies: { put() {}, get() {}, delete() {}, keys() {} },
    now: world.now,
    monoNow: world.monoNow,
  };
  assert.doesNotThrow(() => new ReliableMessenger(good));
  const bad = [
    { identity: undefined }, { identity: { nodeId: 'x', card: {} } }, { cardOf: 5 }, { originate: undefined },
    { schedule: undefined }, { index: {} }, { seenLog: null }, { bodies: { put() {} } },
    { isReachable: 5 }, { routePath: 5 }, { events: {} }, { ttl: 0 }, { ttl: 33 },
    { messageLifetimeMs: 0 }, { maxClockSkewMs: -1 }, { retransmitMinMs: 0 },
    { retransmitMinMs: 100, retransmitMaxMs: 50 }, { retransmitJitter: 1 }, { retransmitJitter: -0.1 },
    { outboxMaxEntries: 0 }, { outboxMaxBytes: 0 }, { seenCacheEntries: 0 },
    { maxInFlightPerDestination: 0 }, { maxPacketBytes: 0 }, { maxInbound: 0 }, { rng: 5 },
    { sealMessage: 5 }, { openMessage: 5 },
  ];
  for (const override of bad) {
    assert.throws(() => new ReliableMessenger({ ...good, ...override }), ConfigError, JSON.stringify(Object.keys(override)));
  }
  assert.throws(() => new ReliableMessenger(), ConfigError);
});

test('loss, duplication and reordering: every message arrives exactly once and every outbox drains', async (t) => {
  const { world, A, B } = await setup(t);
  let seed = 20240607;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  world.rngValue = 0.5;
  world.rule = () => {
    if (random() < 0.35) return [];
    const copies = random() < 0.25 ? 2 : 1;
    return Array.from({ length: copies }, () => (random() < 0.4 ? Math.floor(100 + random() * 3_000) : 0));
  };
  const sentIds = { A: new Set(), B: new Set() };
  for (let i = 0; i < 24; i += 1) {
    sentIds.A.add((await A.send(B, { content: text(`a${i}`) })).id);
    if (i % 2 === 0) sentIds.B.add((await B.send(A, { content: text(`b${i}`) })).id);
  }
  for (let round = 0; round < 400; round += 1) {
    if (A.messenger.pending().length === 0 && B.messenger.pending().length === 0) break;
    await world.advance(30_000);
  }
  assert.deepEqual(A.messenger.pending(), []);
  assert.deepEqual(B.messenger.pending(), []);
  assert.equal(B.inbox.length, sentIds.A.size);
  assert.equal(A.inbox.length, sentIds.B.size);
  assert.deepEqual(new Set(B.inbox.map((m) => m.id)), sentIds.A);
  assert.deepEqual(new Set(A.inbox.map((m) => m.id)), sentIds.B);
  assert.equal(new Set(B.inbox.map((m) => m.id)).size, B.inbox.length, 'no id was delivered twice');
  assert.ok(B.messenger.stats().duplicates + A.messenger.stats().duplicates > 0, 'the network really duplicated');
  assert.deepEqual(await A.bodies.keys(), []);
  assert.deepEqual(await B.bodies.keys(), []);
  assert.deepEqual(A.warnings, []);
  assert.deepEqual(B.warnings, []);
});

test('stats are flat non-negative integers', async (t) => {
  const { world, A, B } = await setup(t);
  await A.send(B);
  await world.settle();
  for (const node of [A, B]) {
    for (const [name, value] of Object.entries(node.messenger.stats())) {
      assert.ok(Number.isInteger(value) && value >= 0, `${name} = ${value}`);
    }
  }
});
