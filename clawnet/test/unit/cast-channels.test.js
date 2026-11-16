/**
 * ClawCast over a simulated network of real SyncEngines (test/helpers/simnet.js): real
 * identities, real signatures, real encryption and real sealed storage; only the transport
 * and the clock are simulated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { CHANNEL_NAME_PATTERN, MAX_STREAMS_PER_ORIGIN, RATE_WINDOW_MS, createCastService } from '../../src/cast/channels.js';
import { castEncrypt, channelWireId } from '../../src/core/crypto/envelope.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { base64Encode } from '../../src/core/crypto/primitives.js';
import { ClawNetError, ConfigError, StateError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { NodeStorage } from '../../src/core/storage.js';
import { Limits } from '../../src/core/wire/types.js';
import { SimNet } from '../helpers/simnet.js';
import { tempDir } from '../helpers/tmp.js';

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const MINUTE = 60_000;
/** The virtual time a SimNet starts at; record timestamps are chosen relative to it. */
const SIM_START = 1_000_000;

/** A fake ServiceContext (ARCHITECTURE.md section 6) over a SimNet node. */
function makeContext({ net, identity, storage, limits, events, routes, everys }) {
  const id = identity.nodeId;
  const datasets = [];
  return {
    datasets,
    context: {
      service: 'cast',
      nodeId: id,
      boot: '00000000',
      config: { limits, timers: { retransmitMaxMs: 2000 } },
      identity: {
        nodeId: id,
        card: identity.card,
        signRecord: (type, fields) => identity.signRecord(type, fields),
        sign: (domain, bytes) => identity.sign(domain, bytes),
      },
      events,
      log: SILENT,
      now: () => net.now(),
      rng: Math.random,
      schedule: () => () => {},
      every: (fn, ms) => {
        everys.push({ fn, ms });
        return () => {};
      },
      storage,
      sync: {
        addDataset: (dataset) => datasets.push(dataset),
        publish: (name, record) => net.node(id).engine.publish(name, record),
        dataset: (name) => datasets.find((dataset) => dataset.name === name) ?? null,
      },
      api: {
        route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
        reply: (status, body) => ({ replied: true, status, body }),
        error: (status, code, message, details) => Object.assign(new ClawNetError('ERR_API', message), { status, apiCode: code, details: details ?? null }),
      },
    },
  };
}

const DEFAULT_LIMITS = Object.freeze({
  castPerOriginPerMin: 60,
  maxClockSkewMs: 300_000,
  messageLifetimeMs: 7 * 24 * 3_600_000,
});

/**
 * Build a node: identity, sealed storage, a cast service initialised over a fake context,
 * and a SimNet node running its dataset.
 */
async function addCastNode(t, net, { identity = Identity.generate(), dir, storageKey = randomBytes(32), limits = {}, options = {} } = {}) {
  const directory = dir ?? (await tempDir(t, 'cast'));
  const storage = new NodeStorage({ dir: directory, storageKey });
  const events = new EventBus({ capacity: 2000, now: () => net.now() });
  const routes = new Map();
  const everys = [];
  const service = createCastService(options);
  const { context, datasets } = makeContext({
    net,
    identity,
    storage,
    limits: { ...DEFAULT_LIMITS, ...limits },
    events,
    routes,
    everys,
  });
  await service.init(context);
  service.start();
  const simNode = net.addNode(identity.nodeId, { datasets });
  t.after(() => storage.closeAll().catch(() => {}));
  const dataset = datasets[0];
  return {
    id: identity.nodeId,
    identity,
    service,
    api: service.api,
    dataset,
    events,
    routes,
    dir: directory,
    storageKey,
    sweep: () => everys[0].fn(),
    faults: simNode.faults,
    messages: () => events.recent({ types: ['cast.message'] }).map((event) => event.data.message),
    async restart(newNet) {
      await service.stop();
      await storage.closeAll();
      return addCastNode(t, newNet, { identity, dir: directory, storageKey, limits, options });
    },
  };
}

/** A line of nodes joined to one channel. */
async function line(t, count, { net = new SimNet({ seed: 3, datasets: () => [] }), limits, options, join = true } = {}) {
  t.after(() => net.close());
  const nodes = [];
  for (let i = 0; i < count; i += 1) nodes.push(await addCastNode(t, net, { limits, options }));
  for (let i = 0; i + 1 < count; i += 1) net.link(nodes[i].id, nodes[i + 1].id);
  if (join) for (const node of nodes) await node.api.join('ops');
  return { net, nodes };
}

/** A cast record signed by an identity that is not running a service. */
function castRecord(identity, { chan, n, ts, text = 'hello', enc = false, salt, body }) {
  const fields = { chan, n, ts, enc, body: body ?? base64Encode(Buffer.from(text)) };
  if (salt !== undefined) fields.salt = base64Encode(salt);
  return identity.signRecord('cast', fields);
}

/** A keyed cast made the way a member makes it, but signed by `identity`. */
function keyedRecord(identity, { key, chan, n, ts, text }) {
  const { salt, ciphertext } = castEncrypt({
    channelKey: key,
    fields: { type: 'cast', origin: identity.nodeId, chan, n, ts, enc: true },
    plaintext: Buffer.from(text),
  });
  return castRecord(identity, { chan, n, ts, enc: true, salt, body: base64Encode(ciphertext) });
}

const texts = (page) => page.items.map((item) => item.text);

test('a cast reaches every node, is surfaced exactly once, and keeps its sender order; a node that has not joined relays without surfacing', async (t) => {
  const { net, nodes } = await line(t, 4, { join: false });
  const [a, b, c, d] = nodes;
  for (const node of [a, b, c]) await node.api.join('ops');
  for (let i = 1; i <= 5; i += 1) {
    const message = await a.api.publish('ops', `cast ${i}`);
    assert.equal(message.n, i);
    assert.equal(message.mine, true);
  }
  net.run();
  for (const node of [a, b, c]) {
    const history = node.api.history('ops');
    assert.deepEqual(texts(history).reverse(), ['cast 1', 'cast 2', 'cast 3', 'cast 4', 'cast 5'], node.id);
    assert.deepEqual(history.items.map((item) => item.n).reverse(), [1, 2, 3, 4, 5]);
    assert.equal(history.items[0].origin, a.id);
    assert.equal(history.items[0].mine, node === a);
    assert.equal(node.messages().length, 5, 'one cast.message event per cast');
    assert.deepEqual(node.api.list().map((channel) => [channel.name, channel.messages, channel.encrypted]), [['ops', 5, false]]);
  }
  // The fourth node relays: it holds the stream, surfaced nothing, and has no channel.
  assert.equal(d.dataset.topOf(`${channelWireId('ops')}:${a.id}`), 5);
  assert.deepEqual(d.api.list(), []);
  assert.equal(d.messages().length, 0);
  assert.equal(d.service.stats().surfaced, 0);
  assert.equal(d.service.stats().received, 5);
  assert.ok(nodes.every((node) => node.faults.length === 0));
});

test('out-of-order arrival surfaces every cast once; duplicates change nothing', async (t) => {
  const { net, nodes: [a] } = await line(t, 1);
  const author = Identity.generate();
  const chan = channelWireId('ops');
  const ts = net.now();
  for (const n of [3, 1, 2]) {
    assert.deepEqual(a.dataset.offer(castRecord(author, { chan, n, ts: ts + n, text: `n${n}` }), 'peer'), { accepted: true, isNew: true });
  }
  const again = a.dataset.offer(castRecord(author, { chan, n: 2, ts: ts + 2, text: 'n2' }), 'peer');
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
  const history = a.api.history('ops');
  assert.deepEqual(history.items.map((item) => item.n).reverse(), [3, 1, 2], 'local arrival order');
  const seqs = history.items.map((item) => item.seq).reverse();
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, 3);
  assert.equal(a.messages().length, 3);
});

test('keyed channel: members read it, others cannot, a non-member still relays, and a re-signed ciphertext opens for nobody', async (t) => {
  const { net, nodes } = await line(t, 5, { join: false });
  const [a, b, relay, c, d] = nodes;
  const key = randomBytes(32);
  await a.api.join('ops', { key });
  await b.api.join('ops', { key });
  await c.api.join('ops'); // same name, no key: another channel
  await d.api.join('ops', { key: randomBytes(32) }); // same name, another key: another channel
  const chan = channelWireId('ops', key);
  assert.notEqual(chan, channelWireId('ops'));
  assert.equal(a.api.list()[0].chan, chan);
  assert.equal(a.api.list()[0].encrypted, true);

  const sent = await a.api.publish('ops', 'meet at the old mill');
  net.run();
  assert.equal(sent.chan, chan);
  assert.deepEqual(texts(b.api.history('ops')), ['meet at the old mill']);
  // The relay and the two lookalike channels hold the record but read nothing.
  for (const node of [relay, c, d]) {
    assert.equal(node.dataset.topOf(`${chan}:${a.id}`), 1, 'relayed');
    assert.equal(node.service.stats().surfaced, 0);
    assert.equal(node.messages().length, 0);
  }
  assert.equal(c.api.history('ops').items.length, 0);
  assert.equal(d.api.history('ops').items.length, 0);
  // The stored record is ciphertext.
  const stored = a.dataset.get(`${chan}:${a.id}`, 1);
  assert.equal(stored.enc, true);
  assert.equal(Buffer.from(stored.body, 'base64').includes('old mill'), false);

  // Records of the keyed chan that a member cannot open are accepted (they are validly
  // signed, so they are relayed) but never surfaced.
  const intruder = Identity.generate();
  const ts = net.now();
  const plaintext = castRecord(intruder, { chan, n: 1, ts, text: 'forged plaintext' });
  const garbage = castRecord(intruder, { chan, n: 2, ts, enc: true, salt: randomBytes(32), body: base64Encode(randomBytes(40)) });
  // A member's ciphertext, salt and counter copied into a record signed by someone else.
  const copied = castRecord(intruder, { chan, n: 3, ts: stored.ts, enc: true, salt: Buffer.from(stored.salt, 'base64'), body: stored.body });
  const verbatim = castRecord(intruder, { chan, n: 4, ts: stored.ts, enc: true, salt: Buffer.from(stored.salt, 'base64'), body: stored.body });
  for (const record of [plaintext, garbage, copied, verbatim]) {
    assert.equal(b.dataset.offer(record, 'peer').accepted, true);
  }
  assert.deepEqual(texts(b.api.history('ops')), ['meet at the old mill']);
  assert.equal(b.service.stats().undecryptable, 4);
  assert.ok(b.events.recent({ types: ['cast.rejected'] }).length >= 1);
  // And the same ciphertext re-signed by a different member's name still fails: the origin is bound.
  const [first] = b.events.recent({ types: ['cast.rejected'] });
  assert.equal(first.data.reason, 'undecryptable');
});

test('a keyed record made by a member under its own name is read; a plaintext record in a keyed channel is not', async (t) => {
  const { net, nodes: [a] } = await line(t, 1, { join: false });
  const key = randomBytes(32);
  await a.api.join('ops', { key });
  const member = Identity.generate();
  const chan = channelWireId('ops', key);
  const ts = net.now();
  assert.equal(a.dataset.offer(keyedRecord(member, { key, chan, n: 1, ts, text: 'from another member' }), 'peer').accepted, true);
  assert.equal(a.dataset.offer(castRecord(member, { chan, n: 2, ts, text: 'plain' }), 'peer').accepted, true);
  assert.deepEqual(texts(a.api.history('ops')), ['from another member']);
  assert.equal(a.api.history('ops').items[0].origin, member.nodeId);
});

test('text that is not valid UTF-8 is counted and not surfaced', async (t) => {
  const { net, nodes: [a] } = await line(t, 1);
  const author = Identity.generate();
  const record = castRecord(author, { chan: channelWireId('ops'), n: 1, ts: net.now(), body: base64Encode(Buffer.from([0xff, 0xfe, 0x41])) });
  assert.equal(a.dataset.offer(record, 'peer').accepted, true);
  assert.equal(a.api.history('ops').items.length, 0);
  assert.equal(a.service.stats().undecryptable, 1);
});

test('forged signatures and schema violations are hard failures; over-rate, future, expired and the 17th stream are soft', async (t) => {
  const { net, nodes: [a, b, c] } = await line(t, 3);
  const author = Identity.generate();
  const chan = channelWireId('ops');
  const now = net.now();

  const forged = { ...castRecord(author, { chan, n: 1, ts: now }), ts: now + 1 };
  assert.deepEqual(pick(a.dataset.offer(forged, 'peer')), { accepted: false, invalid: true, reason: 'bad-signature' });
  const badSchema = { ...castRecord(author, { chan, n: 1, ts: now }), extra: 1 };
  assert.deepEqual(pick(a.dataset.offer(badSchema, 'peer')), { accepted: false, invalid: true, reason: 'invalid-cast' });
  const shortChan = { ...castRecord(author, { chan, n: 1, ts: now }), chan: 'abc' };
  assert.equal(a.dataset.offer(shortChan, 'peer').invalid, true);
  assert.equal(a.dataset.offer({ type: 'cast' }, 'peer').invalid, true);

  // Soft refusals: well formed and correctly signed, but not wanted here and now.
  const future = castRecord(author, { chan, n: 1, ts: now + DEFAULT_LIMITS.maxClockSkewMs + 1 });
  assert.deepEqual(pick(a.dataset.offer(future, 'peer')), { accepted: false, invalid: undefined, reason: 'future' });
  // The simulated clock starts at a thousand seconds, so a timestamp of zero is old for a short lifetime.
  const short = await line(t, 1, { limits: { messageLifetimeMs: 1000 } });
  const old = castRecord(author, { chan, n: 1, ts: 0 });
  assert.deepEqual(pick(short.nodes[0].dataset.offer(old, 'peer')), { accepted: false, invalid: undefined, reason: 'expired' });
  assert.equal(a.dataset.get(`${chan}:${author.nodeId}`, 1), undefined, 'neither was stored');

  // A soft refusal is not forwarded either, and nobody is blamed for it.
  assert.deepEqual(net.node(b.id).engine.publish('cast', future), { accepted: false, reason: 'future' });
  net.run();
  assert.equal(c.dataset.get(`${chan}:${author.nodeId}`, 1), undefined);
  for (const node of [a, b, c]) assert.deepEqual(node.faults, []);

  // The 17th stream of one origin is refused; the first sixteen are not.
  const many = Identity.generate();
  for (let i = 0; i < MAX_STREAMS_PER_ORIGIN; i += 1) {
    const result = a.dataset.offer(castRecord(many, { chan: channelWireId(`room-${i}`), n: 1, ts: now }), 'peer');
    assert.equal(result.accepted, true, `stream ${i}`);
  }
  const seventeenth = a.dataset.offer(castRecord(many, { chan: channelWireId('room-16'), n: 1, ts: now }), 'peer');
  assert.deepEqual(pick(seventeenth), { accepted: false, invalid: undefined, reason: 'streams' });
  assert.equal(a.service.stats().streamRejected, 1);
  // Another record of an open stream is still fine.
  assert.equal(a.dataset.offer(castRecord(many, { chan: channelWireId('room-0'), n: 2, ts: now }), 'peer').accepted, true);
  // And another origin is unaffected.
  assert.equal(a.dataset.offer(castRecord(Identity.generate(), { chan: channelWireId('room-16'), n: 1, ts: now }), 'peer').accepted, true);
});

function pick({ accepted, invalid, reason }) {
  return { accepted, invalid, reason };
}

test('the rate limit is a function of signed content: an honest backlog passes in any order, whatever the arrival time', async (t) => {
  const limits = { castPerOriginPerMin: 5 };
  const author = Identity.generate();
  const chan = channelWireId('ops');
  // Five a minute, exactly: ts(n) - ts(n - 5) is one window.
  const start = SIM_START - 400_000;
  const honest = Array.from({ length: 30 }, (_, i) => castRecord(author, { chan, n: i + 1, ts: start + (i * RATE_WINDOW_MS) / 5, text: `n${i + 1}` }));
  const shuffled = [...honest].sort((x, y) => ((x.n * 7919) % 31) - ((y.n * 7919) % 31));
  for (const [name, order] of [['ascending', honest], ['descending', [...honest].reverse()], ['shuffled', shuffled]]) {
    const net = new SimNet({ seed: 5, datasets: () => [] });
    t.after(() => net.close());
    const node = await addCastNode(t, net, { limits });
    await node.api.join('ops');
    // All at one instant: a token bucket filled at arrival time would refuse most of them.
    for (const record of order) node.dataset.offer(record, 'peer');
    // Anything refused for a neighbour that had not arrived yet is offered again, as anti-entropy does.
    for (const record of order) node.dataset.offer(record, 'peer');
    const held = honest.filter((record) => node.dataset.get(`${chan}:${author.nodeId}`, record.n) !== undefined).length;
    assert.equal(held, 30, `${name}: every honest cast is held`);
    if (name !== 'shuffled') assert.equal(node.service.stats().rateRejected, 0, `${name}: nothing was refused`);
    assert.equal(node.api.history('ops', { limit: 500 }).items.length, 30, `${name}: all surfaced`);
  }
});

test('the rate limit refuses a hostile origin: spacing against the record K before and K after, and a jump bound', async (t) => {
  const limits = { castPerOriginPerMin: 5 };
  const author = Identity.generate();
  const chan = channelWireId('ops');
  const stream = `${chan}:${author.nodeId}`;
  const net = new SimNet({ seed: 6, datasets: () => [] });
  t.after(() => net.close());
  const node = await addCastNode(t, net, { limits });
  const t0 = 100_000;
  const offer = (n, ts) => pick(node.dataset.offer(castRecord(author, { chan, n, ts }), 'peer'));
  for (let n = 1; n <= 5; n += 1) assert.equal(offer(n, t0 + n).accepted, true, `n ${n} <= K needs no predecessor`);
  // Record 6 against record 1: too soon, then a minute later.
  assert.deepEqual(offer(6, t0 + 10_000), { accepted: false, invalid: undefined, reason: 'rate' });
  assert.equal(offer(6, t0 + 1 + RATE_WINDOW_MS).accepted, true);
  // A jump of more than K past the newest index is a gap, not a flood: it can arrive later.
  assert.deepEqual(offer(12, t0 + 5 * RATE_WINDOW_MS), { accepted: false, invalid: undefined, reason: 'gap' });
  assert.equal(offer(11, t0 + 2 * RATE_WINDOW_MS).accepted, false, '11 is within K of 6 but too close to 6 in time');
  assert.equal(offer(11, t0 + 1 + 2 * RATE_WINDOW_MS).accepted, true);
  assert.equal(offer(7, t0 + 2 + RATE_WINDOW_MS).accepted, true);
  // The rule reaches back j steps: 13 is two steps from 3, so it needs two windows after it.
  assert.deepEqual(offer(13, t0 + 2 + 2 * RATE_WINDOW_MS), { accepted: false, invalid: undefined, reason: 'rate' });
  assert.equal(offer(13, t0 + 3 + 2 * RATE_WINDOW_MS).accepted, true);
  // The successor rule: 8 may not be closer to the held 13 than a window.
  assert.deepEqual(offer(8, t0 + 4 + RATE_WINDOW_MS), { accepted: false, invalid: undefined, reason: 'rate' }, 'ts(13) - ts(8) is under a window');
  assert.equal(node.service.stats().rateRejected, 5);
  assert.equal(node.dataset.get(stream, 8), undefined);

  // The same flood in reverse, every cast stamped alike, gets in exactly K, like one in order:
  // members of a residue class of the counter modulo K that are j steps apart need j minutes.
  const flooder = Identity.generate();
  const floodStream = `${chan}:${flooder.nodeId}`;
  for (let n = 40; n >= 1; n -= 1) node.dataset.offer(castRecord(flooder, { chan, n, ts: t0 }), 'peer');
  let held = 0;
  for (let n = 1; n <= 40; n += 1) if (node.dataset.get(floodStream, n) !== undefined) held += 1;
  assert.equal(held, 5, 'a reverse flood');
  // In order too.
  const ordered = Identity.generate();
  for (let n = 1; n <= 40; n += 1) node.dataset.offer(castRecord(ordered, { chan, n, ts: t0 }), 'peer');
  held = 0;
  for (let n = 1; n <= 40; n += 1) if (node.dataset.get(`${chan}:${ordered.nodeId}`, n) !== undefined) held += 1;
  assert.equal(held, 5);
});

test('a rate of zero refuses every cast, local and remote', async (t) => {
  const { nodes: [a] } = await line(t, 1, { limits: { castPerOriginPerMin: 0 } });
  await assert.rejects(() => a.api.publish('ops', 'x'), (error) => error instanceof StateError && error.message.startsWith('rate-limited:'));
  const result = a.dataset.offer(castRecord(Identity.generate(), { chan: channelWireId('ops'), n: 1, ts: SIM_START }), 'peer');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'rate');
});

test('local publishing is held to the rate: K in any minute, with the time to wait, across channels', async (t) => {
  const net = new SimNet({ seed: 7, datasets: () => [], syncIntervalMs: MINUTE / 2 });
  const { nodes: [a] } = await line(t, 1, { net, limits: { castPerOriginPerMin: 3 }, join: false });
  await a.api.join('ops');
  await a.api.join('other');
  await a.api.publish('ops', 'one');
  net.tick();
  await a.api.publish('other', 'two');
  await a.api.publish('ops', 'three');
  await assert.rejects(
    () => a.api.publish('ops', 'four'),
    (error) => {
      assert.ok(error instanceof StateError);
      assert.match(error.message, /^rate-limited: /);
      assert.ok(error.retryInMs > 0 && error.retryInMs <= MINUTE, `retryInMs ${error.retryInMs}`);
      return true;
    },
  );
  net.tick();
  assert.equal((await a.api.publish('ops', 'four')).n, 3, 'a refused publish did not use a counter value');
  assert.equal(a.service.stats().published, 4);
});

test('partition, casts on both sides, heal: both sides hold the union, with a limit that a token bucket would have broken', async (t) => {
  const net = new SimNet({ seed: 8, datasets: () => [], syncIntervalMs: MINUTE });
  const { nodes } = await line(t, 4, { net, limits: { castPerOriginPerMin: 5 } });
  const [a, b, c, d] = nodes;
  net.cutBetween([a.id, b.id], [c.id, d.id]);
  for (let batch = 0; batch < 6; batch += 1) {
    for (let i = 0; i < 5; i += 1) {
      await a.api.publish('ops', `west ${batch * 5 + i}`);
      await d.api.publish('ops', `east ${batch * 5 + i}`);
    }
    net.tick();
    net.run();
  }
  assert.equal(b.api.history('ops', { limit: 500 }).items.length, 30, 'b saw only the west');
  assert.equal(c.api.history('ops', { limit: 500 }).items.length, 30, 'c saw only the east');
  net.link(b.id, c.id);
  net.rounds(8);
  for (const node of nodes) {
    const items = node.api.history('ops', { limit: 500 }).items;
    assert.equal(items.length, 60, `${node.id} holds both sides`);
    assert.equal(items.filter((item) => item.origin === a.id).length, 30);
    assert.equal(items.filter((item) => item.origin === d.id).length, 30);
    assert.equal(new Set(items.map((item) => `${item.origin}:${item.n}`)).size, 60, 'no duplicates');
    assert.equal(node.service.stats().rateRejected, 0);
    assert.deepEqual(node.faults, []);
  }
  assert.ok(net.agree('cast'));
});

test('the counter of a stream survives a restart and never repeats; a lost document is covered by what the network still holds', async (t) => {
  const net = new SimNet({ seed: 9, datasets: () => [] });
  t.after(() => net.close());
  const a = await addCastNode(t, net);
  const b = await addCastNode(t, net);
  net.link(a.id, b.id);
  await a.api.join('ops');
  await b.api.join('ops');
  await a.api.publish('ops', 'one');
  await a.api.publish('ops', 'two');
  net.run();

  // Restart with the same storage: nextN comes back, history comes back.
  const net2 = new SimNet({ seed: 10, datasets: () => [] });
  t.after(() => net2.close());
  const a2 = await a.restart(net2);
  assert.deepEqual(a2.api.list().map((channel) => [channel.name, channel.messages]), [['ops', 2]]);
  assert.deepEqual(texts(a2.api.history('ops')).reverse(), ['one', 'two']);
  assert.equal((await a2.api.publish('ops', 'three')).n, 3, 'the counter continues');
  assert.equal((await a2.api.publish('ops', 'four')).seq, 4, 'and so does the local order of history');

  // Now the document is gone: a node with the same identity, empty storage, and a
  // neighbour that still holds its records. After one sync it moves its counter past them.
  const net3 = new SimNet({ seed: 11, datasets: () => [] });
  t.after(() => net3.close());
  const holder = await addCastNode(t, net3);
  const amnesiac = await addCastNode(t, net3, { identity: a.identity });
  for (const record of b.dataset.range(`${channelWireId('ops')}:${a.id}`, 1, 100)) holder.dataset.offer(record, 'peer');
  net3.link(holder.id, amnesiac.id);
  await amnesiac.api.join('ops');
  net3.rounds(2);
  assert.equal(amnesiac.dataset.topOf(`${channelWireId('ops')}:${a.id}`), 2, 'our own records came back from the network');
  assert.equal((await amnesiac.api.publish('ops', 'after the loss')).n, 3);
});

test('join backfills from the dataset, leave removes the history, history pages and is bounded', async (t) => {
  const { net, nodes: [a, b] } = await line(t, 2, { options: { historyPerChannel: 5 }, join: false });
  await a.api.join('ops');
  for (let i = 1; i <= 8; i += 1) await a.api.publish('ops', `m${i}`);
  net.run();
  // b has not joined, yet holds the stream; joining surfaces it, newest 5 kept.
  assert.equal(b.dataset.topOf(`${channelWireId('ops')}:${a.id}`), 8);
  const info = await b.api.join('ops');
  assert.equal(info.messages, 5);
  assert.equal(info.lastMessageAt, a.dataset.get(`${channelWireId('ops')}:${a.id}`, 8).ts);
  assert.deepEqual(texts(b.api.history('ops', { limit: 10 })), ['m8', 'm7', 'm6', 'm5', 'm4']);
  // Joining again is a no-op.
  assert.deepEqual(await b.api.join('ops'), info);
  assert.equal(b.events.recent({ types: ['cast.joined'] }).length, 1);

  const first = b.api.history('ops', { limit: 2 });
  assert.deepEqual(texts(first), ['m8', 'm7']);
  assert.ok(Number.isInteger(first.nextBefore));
  const second = b.api.history('ops', { limit: 2, before: first.nextBefore });
  assert.deepEqual(texts(second), ['m6', 'm5']);
  const third = b.api.history('ops', { limit: 2, before: second.nextBefore });
  assert.deepEqual(texts(third), ['m4']);
  assert.equal(third.nextBefore, null);

  assert.equal(await b.api.leave('ops'), true);
  assert.deepEqual(b.api.list(), []);
  assert.throws(() => b.api.history('ops'), (error) => error instanceof StateError && error.message.startsWith('not-joined:'));
  await assert.rejects(() => b.api.leave('ops'), /^StateError: not-joined:/);
  assert.equal(b.events.recent({ types: ['cast.left'] }).length, 1);
  // The node still relays the channel, and joining again finds it.
  assert.equal(b.dataset.topOf(`${channelWireId('ops')}:${a.id}`), 8);
  assert.equal((await b.api.join('ops')).messages, 5);
});

test('history survives a restart and stays bounded; leaving is remembered', async (t) => {
  const net = new SimNet({ seed: 12, datasets: () => [] });
  t.after(() => net.close());
  const a = await addCastNode(t, net, { options: { historyPerChannel: 3 } });
  await a.api.join('ops');
  await a.api.join('gone');
  for (let i = 1; i <= 5; i += 1) await a.api.publish('ops', `m${i}`);
  await a.api.publish('gone', 'bye');
  await a.api.leave('gone');
  const net2 = new SimNet({ seed: 13, datasets: () => [] });
  t.after(() => net2.close());
  const a2 = await a.restart(net2);
  assert.deepEqual(a2.api.list().map((channel) => channel.name), ['ops']);
  assert.deepEqual(texts(a2.api.history('ops')), ['m5', 'm4', 'm3']);
  assert.equal(a2.service.stats().historyEntries, 3);
});

test('a joined keyed channel keeps its key across a restart and still reads', async (t) => {
  const net = new SimNet({ seed: 14, datasets: () => [] });
  t.after(() => net.close());
  const a = await addCastNode(t, net);
  const key = randomBytes(32);
  await a.api.join('ops', { key });
  await a.api.publish('ops', 'sealed at rest');
  const net2 = new SimNet({ seed: 15, datasets: () => [] });
  t.after(() => net2.close());
  const a2 = await a.restart(net2);
  assert.equal(a2.api.list()[0].encrypted, true);
  assert.equal((await a2.api.publish('ops', 'second')).n, 2);
  const member = Identity.generate();
  const chan = channelWireId('ops', key);
  assert.equal(a2.dataset.offer(keyedRecord(member, { key, chan, n: 1, ts: SIM_START, text: 'read after restart' }), 'peer').accepted, true);
  assert.ok(texts(a2.api.history('ops')).includes('read after restart'));
});

test('streams whose newest record expired are dropped by the sweep and not admitted again', async (t) => {
  const net = new SimNet({ seed: 16, datasets: () => [], syncIntervalMs: 100_000 });
  t.after(() => net.close());
  const a = await addCastNode(t, net, { limits: { messageLifetimeMs: 150_000 } });
  const quiet = Identity.generate();
  const live = Identity.generate();
  const chan = channelWireId('ops');
  assert.equal(a.dataset.offer(castRecord(quiet, { chan, n: 1, ts: net.now() }), 'peer').accepted, true);
  net.tick();
  assert.equal(a.dataset.offer(castRecord(live, { chan, n: 1, ts: net.now() }), 'peer').accepted, true);
  net.tick();
  a.sweep();
  assert.equal(a.dataset.topOf(`${chan}:${quiet.nodeId}`), undefined, 'the quiet stream is gone');
  assert.equal(a.dataset.topOf(`${chan}:${live.nodeId}`), 1, 'the live one stays');
  // The slot is free again, and the expired record is not taken back.
  const again = a.dataset.offer(castRecord(quiet, { chan, n: 1, ts: net.now() - 200_000 }), 'peer');
  assert.deepEqual(pick(again), { accepted: false, invalid: undefined, reason: 'expired' });
});

test('events: joined, message and left; rejections are reported at most once a second', async (t) => {
  const { net, nodes: [a] } = await line(t, 1, { limits: { castPerOriginPerMin: 2 } });
  assert.deepEqual(a.events.recent({ types: ['cast.joined'] }).map((event) => event.data), [{ name: 'ops', chan: channelWireId('ops'), encrypted: false }]);
  const author = Identity.generate();
  const chan = channelWireId('ops');
  const ts = net.now();
  a.dataset.offer(castRecord(author, { chan, n: 1, ts }), 'peer');
  a.dataset.offer(castRecord(author, { chan, n: 2, ts }), 'peer');
  for (let n = 3; n <= 20; n += 1) a.dataset.offer(castRecord(author, { chan, n, ts }), 'peer');
  assert.equal(a.events.recent({ types: ['cast.message'] }).length, 2);
  assert.ok(a.service.stats().rateRejected >= 1);
  assert.equal(a.events.recent({ types: ['cast.rejected'] }).length, 1, 'one report in the same second');
  const [rejected] = a.events.recent({ types: ['cast.rejected'] });
  assert.deepEqual(Object.keys(rejected.data).sort(), ['chan', 'origin', 'reason']);
});

test('bad arguments are refused with the right errors', async (t) => {
  const { nodes: [a] } = await line(t, 1);
  for (const name of ['', 'Ops', '-x', 'a b', 'a/b', 'x'.repeat(65), 7, null]) {
    assert.throws(() => a.api.join(name), ConfigError, String(name));
  }
  assert.ok(CHANNEL_NAME_PATTERN.test('ops.team-1_a'));
  assert.throws(() => a.api.join('keyed', { key: Buffer.alloc(31) }), ConfigError);
  assert.throws(() => a.api.join('keyed', { key: 'abc' }), ConfigError);
  await a.api.join('keyed', { key: randomBytes(32) });
  await assert.rejects(() => a.api.join('keyed'), /^StateError: already-joined:/);
  await assert.rejects(() => a.api.join('keyed', { key: randomBytes(32) }), /^StateError: already-joined:/);
  for (const text of ['', 'x'.repeat(Limits.MAX_CAST_BODY + 1), '\ud800', 5, undefined]) {
    assert.throws(() => a.api.publish('ops', text), ConfigError, String(text).slice(0, 10));
  }
  await assert.rejects(() => a.api.publish('absent', 'x'), /^StateError: not-joined:/);
  assert.equal((await a.api.publish('ops', 'x'.repeat(Limits.MAX_CAST_BODY))).text.length, Limits.MAX_CAST_BODY);
  for (const options of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { before: 0 }, { before: 'x' }]) {
    assert.throws(() => a.api.history('ops', options), ConfigError, JSON.stringify(options));
  }
  for (const options of [{ maxPerStream: 0 }, { maxStreams: -1 }, { historyPerChannel: 1.5 }]) {
    assert.throws(() => createCastService(options), ConfigError);
  }
});

test('the API routes validate input and map errors as API.md asks', async (t) => {
  const { nodes: [a] } = await line(t, 1, { limits: { castPerOriginPerMin: 2 }, join: false });
  const call = async (method, path, { params = {}, query = {}, body = null } = {}) => a.routes.get(`${method} ${path}`)({ params, query, body, signal: null });
  const fails = async (work) => work().then(() => assert.fail('expected an error'), (error) => error);
  assert.deepEqual([...a.routes.keys()].sort(), [
    'DELETE /channels/:name',
    'GET /channels',
    'GET /channels/:name/messages',
    'POST /channels',
    'POST /channels/:name/messages',
  ]);

  assert.deepEqual(await call('GET', '/channels'), { channels: [] });
  for (const body of [null, [], { name: 'Bad' }, { name: 'ok', key: 'short' }, { name: 'ok', key: 5 }, { name: 'ok', extra: 1 }, {}]) {
    const error = await fails(() => call('POST', '/channels', { body }));
    assert.equal(error.status, 400, JSON.stringify(body));
    assert.equal(error.apiCode, 'invalid_request');
  }
  const key = base64Encode(randomBytes(32));
  const created = await call('POST', '/channels', { body: { name: 'ops', key } });
  assert.equal(created.replied, true);
  assert.equal(created.status, 201);
  assert.equal(created.body.channel.encrypted, true);
  assert.equal(JSON.stringify(created).includes(key), false, 'the key is never returned');
  const again = await call('POST', '/channels', { body: { name: 'ops', key } });
  assert.equal(again.replied, undefined, '200 when already joined with the same key');
  assert.equal(again.channel.name, 'ops');
  const conflict = await fails(() => call('POST', '/channels', { body: { name: 'ops' } }));
  assert.match(conflict.message, /^already-joined:/);
  assert.ok(conflict instanceof StateError);

  const published = await call('POST', '/channels/:name/messages', { params: { name: 'ops' }, body: { text: 'hello' } });
  assert.equal(published.status, 202);
  assert.equal(published.body.message.text, 'hello');
  assert.equal(published.body.message.mine, true);
  for (const body of [null, {}, { text: 5 }, { text: 'x', more: 1 }]) {
    const error = await fails(() => call('POST', '/channels/:name/messages', { params: { name: 'ops' }, body }));
    assert.equal(error.apiCode, 'invalid_request');
  }
  const notJoined = await fails(() => call('POST', '/channels/:name/messages', { params: { name: 'nope' }, body: { text: 'x' } }));
  assert.match(notJoined.message, /^not-joined:/);
  await call('POST', '/channels/:name/messages', { params: { name: 'ops' }, body: { text: 'two' } });
  const limited = await fails(() => call('POST', '/channels/:name/messages', { params: { name: 'ops' }, body: { text: 'three' } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.apiCode, 'rate_limited');
  assert.ok(limited.details.retryInMs > 0);

  const page = await call('GET', '/channels/:name/messages', { params: { name: 'ops' }, query: { limit: '1' } });
  assert.equal(page.channel, 'ops');
  assert.deepEqual(page.items.map((item) => item.text), ['two']);
  assert.ok(Number.isInteger(page.nextBefore));
  for (const query of [{ limit: 'x' }, { limit: '-1' }, { before: '1.5' }, { limit: '0' }]) {
    const error = await fails(() => call('GET', '/channels/:name/messages', { params: { name: 'ops' }, query }));
    assert.ok(error.apiCode === 'invalid_request' || error instanceof ConfigError, JSON.stringify(query));
  }
  assert.deepEqual(await call('DELETE', '/channels/:name', { params: { name: 'ops' } }), { left: true });
  const gone = await fails(() => call('DELETE', '/channels/:name', { params: { name: 'ops' } }));
  assert.match(gone.message, /^not-joined:/);
});
