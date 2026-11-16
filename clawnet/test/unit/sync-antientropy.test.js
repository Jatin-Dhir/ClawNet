import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import {
  DEFAULT_SYNC_LIMITS,
  SyncEngine,
  SyncWire,
  decodeRecords,
  encodeRecords,
} from '../../src/sync/antientropy.js';
import { LogDataset, LwwDataset, MAX_INDEX, SyncFault, recordHash } from '../../src/sync/datasets.js';
import { CanonicalError, ConfigError, StateError, WireError } from '../../src/core/errors.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { decodePacket, encodePacket } from '../../src/core/wire/codec.js';
import { Domain, Limits, PacketType } from '../../src/core/wire/types.js';
import { SimNet, mulberry32, randomConnectedGraph } from '../helpers/simnet.js';

// ---------------------------------------------------------------------------------------
// Signed test records, built the way DESIGN.md section 3 signs records: Ed25519 over
// utf8("clawnet/1/record/" + type) || 0x00 || canonical-json(record without "sig").
// The origin is the raw public key (base64url), so a record is checked from itself alone
// and a relaying peer cannot forge one.
// ---------------------------------------------------------------------------------------

function signingInput(body) {
  return Buffer.concat([
    Buffer.from(`${Domain.RECORD_PREFIX}${body.type}`, 'utf8'),
    Buffer.from([0]),
    canonicalBytes(body),
  ]);
}

function makeAuthor() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const origin = publicKey.export({ format: 'jwk' }).x;
  const signed = body => {
    const record = { ...body, origin };
    return { ...record, sig: sign(null, signingInput(record), privateKey).toString('base64') };
  };
  return {
    origin,
    kv: (name, seq, val = '') => signed({ type: 'kv', name, seq, val }),
    cast: (chan, n, body = '') => signed({ type: 'cast', chan, n, body }),
  };
}

const publicKeys = new Map();

function verifyRecord(record, type) {
  const { sig, ...body } = record;
  if (body.type !== type) return { ok: false, reason: 'wrong-type' };
  if (typeof sig !== 'string' || typeof body.origin !== 'string') {
    return { ok: false, reason: 'unsigned' };
  }
  try {
    let key = publicKeys.get(body.origin);
    if (key === undefined) {
      key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: body.origin }, format: 'jwk' });
      publicKeys.set(body.origin, key);
    }
    if (verify(null, signingInput(body), key, Buffer.from(sig, 'base64'))) return { ok: true };
  } catch {
    // Not a key, or not canonical-JSON data: not a valid record.
  }
  return { ok: false, reason: 'bad-signature' };
}

const kvKey = record => `${record.origin}/${record.name}`;
const castStream = record => `${record.chan}/${record.origin}`;

function kvSet(options = {}) {
  return new LwwDataset({
    name: 'kv',
    key: kvKey,
    version: record => record.seq,
    check: record => verifyRecord(record, 'kv'),
    maxEntries: 100_000,
    ...options,
  });
}

function castSet(options = {}) {
  return new LogDataset({
    name: 'cast',
    stream: castStream,
    index: record => record.n,
    check: record => verifyRecord(record, 'cast'),
    maxPerStream: 100_000,
    maxStreams: 10_000,
    ...options,
  });
}

const alice = makeAuthor();
const bob = makeAuthor();
const carol = makeAuthor();

// ---------------------------------------------------------------------------------------
// Packet builders and a single-engine harness for tests that drive one engine by hand.
// ---------------------------------------------------------------------------------------

const gossip = (set, records) => ({
  type: PacketType.GOSSIP,
  header: { n: records.length, set },
  body: encodeRecords(records),
});

const delta = (set, records) => ({ ...gossip(set, records), type: PacketType.SYNC_DELTA });

const digest = (set, round, entries, { after = null, upto = null, hint } = {}) => ({
  type: PacketType.SYNC_DIGEST,
  header: hint === undefined ? { after, round, set, upto } : { after, hint, round, set, upto },
  body: canonicalBytes(entries),
});

const request = (set, round, wants, { next = null, stop } = {}) => ({
  type: PacketType.SYNC_REQUEST,
  header: stop === undefined ? { next, round, set } : { next, round, set, stop },
  body: canonicalBytes(wants),
});

const listOf = packet => JSON.parse(packet.body.toString('utf8'));
const recordsOf = packet => decodeRecords(packet.body, packet.header.n);

/**
 * One engine with a recording transport. Every packet the engine sends goes through the
 * real codec, so a packet that breaks a wire limit fails the test where it is sent.
 */
function harness(options = {}) {
  const state = { now: 1_000_000, sendOk: true };
  const sent = [];
  const faults = [];
  const kv = options.kv ?? kvSet();
  const cast = options.cast ?? castSet();
  const { kv: _kv, cast: _cast, ...engineOptions } = options;
  const engine = new SyncEngine({
    datasets: [kv, cast],
    send: (peer, packet) => {
      if (!state.sendOk) return false;
      sent.push({ peer, packet: decodePacket(encodePacket(packet)) });
      return true;
    },
    monoNow: () => state.now,
    rng: () => 0,
    onError: (peer, reason, detail) => faults.push({ peer, reason, detail }),
    ...engineOptions,
  });
  return {
    engine,
    kv,
    cast,
    sent,
    faults,
    state,
    /** Remove and return the packets sent so far, optionally only those to one peer. */
    take(peer) {
      const taken = [];
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (peer === undefined || sent[i].peer === peer) taken.unshift(sent.splice(i, 1)[0].packet);
      }
      return taken;
    },
  };
}

/** Let the engine's link-up round with `peer` run to its end against an empty peer. */
function finishRound(h, peer) {
  for (;;) {
    const [page] = h.take(peer).filter(packet => packet.type === PacketType.SYNC_DIGEST);
    if (page === undefined) return;
    h.engine.handlePacket(peer, request(page.header.set, page.header.round, [], { stop: 'set' }));
  }
}

/**
 * The next packet sent to `peer`. A dataset summary that comes first is answered with
 * "go on" (a request without stop), as a peer whose dataset differs would answer it.
 */
function nextPage(h, peer) {
  let [packet] = h.take(peer);
  while (packet?.type === PacketType.SYNC_DIGEST && packet.header.sum !== undefined) {
    h.engine.handlePacket(peer, request(packet.header.set, packet.header.round, []));
    [packet] = h.take(peer);
  }
  return packet;
}

/** A well-formed hash for digest entries of keys that do not exist anywhere. */
const H0 = '0123456789abcdef';

const typeName = type => Object.keys(PacketType).find(name => PacketType[name] === type);

// ---------------------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------------------

test('two nodes converge on link-up and then through gossip', t => {
  const net = new SimNet({ seed: 11, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');

  const profileA = alice.kv('profile', 1, 'alice v1');
  const castsA = [1, 2, 3].map(n => alice.cast('news', n, `a${n}`));
  const profileB = bob.kv('profile', 4, 'bob v4');
  const castsB = [1, 2].map(n => bob.cast('news', n, `b${n}`));
  assert.deepEqual(a.engine.publish('kv', profileA), { accepted: true });
  for (const cast of castsA) assert.deepEqual(a.engine.publish('cast', cast), { accepted: true });
  assert.deepEqual(b.engine.publish('kv', profileB), { accepted: true });
  for (const cast of castsB) assert.deepEqual(b.engine.publish('cast', cast), { accepted: true });

  net.link('a', 'b');
  net.run();

  for (const node of [a, b]) {
    assert.deepEqual(node.sets.kv.get(kvKey(profileA)), profileA);
    assert.deepEqual(node.sets.kv.get(kvKey(profileB)), profileB);
    assert.deepEqual(node.sets.cast.range(castStream(castsA[0]), 1, 10), castsA);
    assert.deepEqual(node.sets.cast.range(castStream(castsB[0]), 1, 10), castsB);
    assert.equal(node.sets.kv.size, 2);
    assert.equal(node.sets.cast.size, 5);
    assert.deepEqual(node.faults, []);
  }
  assert.ok(net.agree('kv'));
  assert.ok(net.agree('cast'));

  // One push-pull round did it: the smaller id started it, the other served it, and
  // nothing was sent twice.
  const afterLinkUp = net.counters();
  assert.equal(a.engine.stats().roundsStarted, 1);
  assert.equal(a.engine.stats().roundsCompleted, 1);
  assert.equal(b.engine.stats().roundsStarted, 0);
  assert.equal(b.engine.stats().roundsServed, 1);
  assert.equal(a.engine.stats().accepted, 3);
  assert.equal(b.engine.stats().accepted, 4);
  assert.equal(a.engine.stats().ignored + b.engine.stats().ignored, 0);
  assert.equal(afterLinkUp.byType.GOSSIP, undefined);
  // Per dataset a summary (they differ) and one page, each answered by one request.
  assert.equal(afterLinkUp.byType.SYNC_DIGEST.sent, 4);
  assert.equal(afterLinkUp.byType.SYNC_REQUEST.sent, 4);
  assert.equal(a.engine.stats().summariesOut, 2);
  assert.equal(a.engine.stats().summariesSkipped, 0);

  // From here on a new record travels as gossip: one packet, no sync traffic.
  net.resetCounters();
  const update = bob.kv('profile', 5, 'bob v5');
  const cast = bob.cast('news', 3, 'b3');
  b.engine.publish('kv', update);
  b.engine.publish('cast', cast);
  net.run();
  assert.deepEqual(a.sets.kv.get(kvKey(update)), update);
  assert.deepEqual(a.sets.cast.get(castStream(cast), 3), cast);
  assert.deepEqual(Object.keys(net.counters().byType), ['GOSSIP']);
  assert.equal(net.counters().byType.GOSSIP.sent, 2, 'one packet per dataset');
  assert.ok(net.agree('kv') && net.agree('cast'));
  assert.equal(a.engine.stats().activeRounds + b.engine.stats().activeRounds, 0);
});

test('without `self` both ends start a link-up round and still converge', t => {
  const net = new SimNet({ seed: 5, datasets: () => [kvSet(), castSet()], engine: { self: undefined } });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');
  for (let i = 0; i < 40; i += 1) a.engine.publish('kv', alice.kv(`a${i}`, 1));
  for (let i = 0; i < 40; i += 1) b.engine.publish('kv', bob.kv(`b${i}`, 1));
  for (let n = 1; n <= 30; n += 1) a.engine.publish('cast', alice.cast('c', n));
  net.link('a', 'b');
  net.run();

  assert.equal(a.engine.stats().roundsStarted, 1);
  assert.equal(b.engine.stats().roundsStarted, 1);
  assert.equal(a.engine.stats().roundsCompleted, 1);
  assert.equal(b.engine.stats().roundsCompleted, 1);
  assert.equal(a.sets.kv.size, 80);
  assert.equal(b.sets.kv.size, 80);
  assert.equal(b.sets.cast.size, 30);
  assert.ok(net.agree('kv') && net.agree('cast'));
  assert.deepEqual([...a.faults, ...b.faults], []);
});

test('20 nodes: one publish reaches every node, crossing each directed link at most once', t => {
  const net = new SimNet({ seed: 2024, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const ids = Array.from({ length: 20 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  for (const id of ids) net.addNode(id);
  const edges = randomConnectedGraph(ids, 15, () => net.random());
  assert.equal(edges.length, 19 + 15);
  for (const [a, b] of edges) net.link(a, b);
  net.run();
  for (const node of net.nodes()) assert.equal(node.engine.stats().activeRounds, 0);

  // Count, per directed link, how often each record is carried.
  const carried = new Map();
  net.tap(event => {
    assert.equal(event.packet.type, PacketType.GOSSIP, 'only gossip should flow');
    for (const record of recordsOf(event.packet)) {
      const id = `${event.from}>${event.to} ${record.type}:${record.sig}`;
      carried.set(id, (carried.get(id) ?? 0) + 1);
    }
  });

  const record = alice.kv('announcement', 1, 'hello, mesh');
  const cast = bob.cast('news', 1, 'first');
  net.resetCounters();
  net.node('n07').engine.publish('kv', record);
  net.node('n13').engine.publish('cast', cast);
  net.run();

  for (const node of net.nodes()) {
    assert.deepEqual(node.sets.kv.get(kvKey(record)), record, node.id);
    assert.deepEqual(node.sets.cast.get(castStream(cast), 1), cast, node.id);
    assert.deepEqual(node.faults, []);
  }
  for (const [id, count] of carried) assert.equal(count, 1, `${id} carried ${count} times`);
  // Every node forwards a record once, to all its peers but the one it came from; the
  // publisher has no source. Over the graph: 2E - (N - 1) transmissions per record.
  const perRecord = 2 * edges.length - (ids.length - 1);
  assert.equal(carried.size, 2 * perRecord);
  let accepted = 0;
  let ignored = 0;
  for (const node of net.nodes()) {
    accepted += node.engine.stats().accepted;
    ignored += node.engine.stats().ignored;
  }
  assert.equal(accepted, 2 * (ids.length - 1), 'each node accepts each record exactly once');
  assert.equal(ignored, 2 * (perRecord - (ids.length - 1)), 'every other arrival is a duplicate');

  // A newer version floods the same way; the superseded one is gone everywhere.
  const newer = alice.kv('announcement', 2, 'hello again');
  net.node('n19').engine.publish('kv', newer);
  net.run();
  for (const node of net.nodes()) assert.deepEqual(node.sets.kv.get(kvKey(record)), newer);
  for (const [id, count] of carried) assert.equal(count, 1, `${id} carried ${count} times`);
  assert.equal(carried.size, 3 * perRecord);
});

test('duplicate and stale records are accepted once and never forwarded again', () => {
  const h = harness();
  for (const peer of ['p1', 'p2', 'p3']) {
    h.engine.addPeer(peer);
    finishRound(h, peer);
  }
  const v1 = alice.kv('doc', 1);
  const v2 = alice.kv('doc', 2);
  const v3 = alice.kv('doc', 3);

  h.engine.handlePacket('p1', gossip('kv', [v2]));
  h.engine.flush();
  const first = h.sent.splice(0);
  assert.deepEqual(first.map(s => s.peer).sort(), ['p2', 'p3'], 'not back to the sender');
  for (const { packet } of first) {
    assert.equal(packet.type, PacketType.GOSSIP);
    assert.deepEqual(packet.header, { n: 1, set: 'kv' });
    assert.deepEqual(recordsOf(packet), [v2]);
  }

  // The same record from another peer, an older version, and both again in one packet.
  h.engine.handlePacket('p2', gossip('kv', [v2]));
  h.engine.handlePacket('p3', gossip('kv', [v1]));
  h.engine.handlePacket('p3', delta('kv', [v1, v2]));
  h.engine.flush();
  assert.deepEqual(h.sent, [], 'old and duplicate records must stop here');
  assert.deepEqual(h.kv.get(kvKey(v2)), v2);

  // The log dataset behaves the same.
  const cast = bob.cast('news', 4);
  h.engine.handlePacket('p2', gossip('cast', [cast]));
  h.engine.flush();
  assert.deepEqual(h.sent.splice(0).map(s => s.peer).sort(), ['p1', 'p3']);
  h.engine.handlePacket('p1', gossip('cast', [cast]));
  h.engine.handlePacket('p3', gossip('cast', [cast]));
  h.engine.flush();
  assert.deepEqual(h.sent, []);

  // A newer version is new again.
  h.engine.handlePacket('p2', gossip('kv', [v3]));
  h.engine.flush();
  assert.deepEqual(h.sent.splice(0).map(s => s.peer).sort(), ['p1', 'p3']);

  const stats = h.engine.stats();
  assert.equal(stats.accepted, 3);
  assert.equal(stats.ignored, 6);
  assert.equal(stats.invalid, 0);
  assert.deepEqual(h.faults, []);
});

test('a partition with divergent writes on both sides heals to full convergence', t => {
  const net = new SimNet({ seed: 77, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const left = ['l0', 'l1', 'l2', 'l3'];
  const right = ['r0', 'r1', 'r2', 'r3'];
  for (const id of [...left, ...right]) net.addNode(id);
  for (const side of [left, right]) {
    for (const [a, b] of randomConnectedGraph(side, 2, () => net.random())) net.link(a, b);
  }
  net.link('l0', 'r0');
  net.link('l2', 'r3');
  net.link('l3', 'r1');

  const shared = alice.kv('shared', 1, 'before');
  net.node('l1').engine.publish('kv', shared);
  for (let n = 1; n <= 3; n += 1) net.node('r2').engine.publish('cast', alice.cast('news', n));
  net.run();
  assert.ok(net.agree('kv') && net.agree('cast'));
  assert.equal(net.node('r3').sets.kv.size, 1);

  const cutLinks = net.cutBetween(left, right);
  assert.equal(cutLinks.length, 3);

  // Both sides keep writing: the same key with different versions, keys of their own,
  // one stream extended on both sides (with a gap nobody has), and new streams.
  const leftWins = alice.kv('shared', 2, 'left');
  const rightWins = alice.kv('shared', 3, 'right');
  const leftOnly = Array.from({ length: 25 }, (_, i) => bob.kv(`left-${i}`, 1));
  const rightOnly = Array.from({ length: 35 }, (_, i) => carol.kv(`right-${i}`, 1));
  net.node('l0').engine.publish('kv', leftWins);
  net.node('r1').engine.publish('kv', rightWins);
  leftOnly.forEach((record, i) => net.node(left[i % 4]).engine.publish('kv', record));
  rightOnly.forEach((record, i) => net.node(right[i % 4]).engine.publish('kv', record));
  for (const n of [4, 5, 6]) net.node('l3').engine.publish('cast', alice.cast('news', n));
  net.node('r0').engine.publish('cast', alice.cast('news', 8));
  for (let n = 1; n <= 12; n += 1) net.node('l2').engine.publish('cast', bob.cast('ops', n));
  for (let n = 1; n <= 9; n += 1) net.node('r2').engine.publish('cast', carol.cast('ops', n));
  net.run();
  net.rounds(2);

  // Each side agrees with itself and differs from the other.
  for (const id of left) {
    assert.deepEqual(net.node(id).sets.kv.get(kvKey(shared)), leftWins);
    assert.equal(net.node(id).sets.kv.size, 26);
    assert.equal(net.node(id).sets.cast.size, 3 + 3 + 12);
  }
  for (const id of right) {
    assert.deepEqual(net.node(id).sets.kv.get(kvKey(shared)), rightWins);
    assert.equal(net.node(id).sets.kv.size, 36);
    assert.equal(net.node(id).sets.cast.size, 3 + 1 + 9);
  }
  assert.equal(net.agree('kv'), false);
  assert.equal(net.agree('cast'), false);

  // A single link comes back. Its link-up round reconciles the two endpoints and gossip
  // carries what each learned through its own side: no periodic round is needed.
  net.link(...cutLinks[1]);
  net.run();

  assert.ok(net.agree('kv'), 'LWW dataset converged');
  assert.ok(net.agree('cast'), 'log dataset converged');
  const newsStream = castStream(alice.cast('news', 1));
  for (const node of net.nodes()) {
    assert.deepEqual(node.sets.kv.get(kvKey(shared)), rightWins, 'the higher version wins everywhere');
    assert.equal(node.sets.kv.size, 1 + 25 + 35);
    for (const record of [...leftOnly, ...rightOnly]) {
      assert.deepEqual(node.sets.kv.get(kvKey(record)), record);
    }
    assert.deepEqual(node.sets.cast.digest().find(e => e[0] === newsStream), [newsStream, 0, 6, [[8, 8]]]);
    assert.equal(node.sets.cast.range(castStream(bob.cast('ops', 1)), 1, 99).length, 12);
    assert.equal(node.sets.cast.range(castStream(carol.cast('ops', 1)), 1, 99).length, 9);
    assert.equal(node.sets.cast.size, 7 + 12 + 9);
    assert.deepEqual(node.faults, []);
  }

  // The remaining links and further rounds find nothing left to move.
  net.resetCounters();
  net.link(...cutLinks[0]);
  net.link(...cutLinks[2]);
  net.run();
  net.rounds(3);
  const quiet = net.counters();
  assert.equal(quiet.byType.GOSSIP, undefined);
  assert.equal(quiet.byType.SYNC_DELTA, undefined);
  assert.ok(quiet.byType.SYNC_DIGEST.sent > 0);
  assert.ok(net.agree('kv') && net.agree('cast'));
});

test('a full resync of thousands of records is paginated under the packet limits', t => {
  const limits = {
    maxRecordsPerPacket: 50,
    maxBytesPerPacket: Limits.MAX_SYNC_PACKET,
    maxPendingPerPeer: 100,
  };
  const net = new SimNet({ seed: 9, datasets: () => [kvSet(), castSet()], engine: { limits } });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');

  // a: 3000 small records, 40 records of about 20 KiB (so the byte limit bites before
  // the record limit does), and two long log streams.
  for (let i = 0; i < 3000; i += 1) a.engine.publish('kv', alice.kv(`k${String(i).padStart(4, '0')}`, 1));
  for (let i = 0; i < 40; i += 1) a.engine.publish('kv', alice.kv(`big${i}`, 1, 'x'.repeat(20_000)));
  for (let n = 1; n <= 700; n += 1) a.engine.publish('cast', alice.cast('long', n));
  for (let n = 1; n <= 500; n += 1) a.engine.publish('cast', alice.cast('other', n));
  // b: 1500 records of its own, interleaved with a's by key, and a log stream.
  for (let i = 0; i < 1500; i += 1) b.engine.publish('kv', bob.kv(`k${String(i).padStart(4, '0')}`, 1));
  for (let n = 1; n <= 600; n += 1) b.engine.publish('cast', bob.cast('long', n));

  const seen = { [PacketType.SYNC_DIGEST]: 0, [PacketType.SYNC_REQUEST]: 0, [PacketType.SYNC_DELTA]: 0 };
  let largestBody = 0;
  let largestBatch = 0;
  net.tap(({ packet }) => {
    seen[packet.type] += 1;
    largestBody = Math.max(largestBody, packet.body.length);
    const wireSize = encodePacket(packet).length;
    assert.ok(wireSize <= limits.maxBytesPerPacket, `${typeName(packet.type)} is ${wireSize} bytes`);
    if (packet.type === PacketType.SYNC_DELTA) {
      assert.ok(packet.header.n <= limits.maxRecordsPerPacket);
      largestBatch = Math.max(largestBatch, packet.header.n);
    } else {
      assert.ok(listOf(packet).length <= limits.maxRecordsPerPacket);
    }
  });

  net.link('a', 'b');
  net.run();

  assert.equal(a.sets.kv.size, 4540);
  assert.equal(b.sets.kv.size, 4540);
  assert.equal(a.sets.cast.size, 1800);
  assert.equal(b.sets.cast.size, 1800);
  assert.ok(net.agree('kv') && net.agree('cast'));
  assert.deepEqual([...a.faults, ...b.faults], []);

  // One round, many packets, every record sent exactly once.
  assert.equal(a.engine.stats().roundsStarted, 1);
  assert.equal(a.engine.stats().roundsCompleted, 1);
  assert.equal(a.engine.stats().roundsAbandoned, 0);
  assert.equal(a.engine.stats().recordsOut, 3040 + 1200);
  assert.equal(b.engine.stats().recordsOut, 1500 + 600);
  assert.equal(a.engine.stats().accepted, 2100);
  assert.equal(b.engine.stats().accepted, 4240);
  assert.equal(a.engine.stats().ignored + b.engine.stats().ignored, 0);
  assert.equal(largestBatch, 50);
  assert.ok(seen[PacketType.SYNC_DELTA] >= Math.ceil(6340 / 50), `only ${seen[PacketType.SYNC_DELTA]} deltas`);
  assert.equal(seen[PacketType.SYNC_DIGEST], seen[PacketType.SYNC_REQUEST], 'stop-and-wait');
  // The big records forced byte-limited batches of three (3 * 20 KiB < 64 KiB < 4 * 20 KiB),
  // and no packet, header included, went over the limit (checked in the tap above).
  assert.ok(largestBody > 60_000, `largest body was ${largestBody}`);

  const big = alice.kv('big7', 1, 'x'.repeat(20_000));
  assert.equal(b.sets.kv.get(kvKey(big)).val.length, 20_000);
  assert.deepEqual(b.sets.cast.digest(), a.sets.cast.digest());
});

test('lost gossip is repaired by anti-entropy alone', t => {
  const net = new SimNet({ seed: 31, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const ids = ['n0', 'n1', 'n2', 'n3', 'n4'];
  for (const id of ids) net.addNode(id);
  for (let i = 1; i < ids.length; i += 1) net.link(ids[i - 1], ids[i]);
  net.run();

  // Every gossip packet is lost, for the whole test.
  net.setLoss(1, event => event.packet.type === PacketType.GOSSIP);
  const records = Array.from({ length: 6 }, (_, i) => alice.kv(`r${i}`, 1));
  for (const record of records) net.node('n0').engine.publish('kv', record);
  for (let n = 1; n <= 4; n += 1) net.node('n4').engine.publish('cast', bob.cast('news', n));
  net.run();
  for (const id of ids.slice(1)) assert.equal(net.node(id).sets.kv.size, 0, `${id} got gossip`);
  assert.equal(net.node('n0').sets.cast.size, 0);
  assert.ok(net.counters().byType.GOSSIP.lost > 0);

  let intervals = 0;
  while (!(net.agree('kv') && net.agree('cast')) && intervals < 30) {
    net.rounds(1);
    intervals += 1;
  }
  assert.ok(net.agree('kv') && net.agree('cast'), `not converged after ${intervals} intervals`);
  for (const node of net.nodes()) {
    assert.equal(node.sets.kv.size, 6);
    assert.equal(node.sets.cast.size, 4);
    for (const record of records) assert.deepEqual(node.sets.kv.get(kvKey(record)), record);
    assert.deepEqual(node.faults, []);
  }
  const counters = net.counters();
  assert.equal(counters.byType.GOSSIP.delivered, 0);
  assert.equal(counters.byType.GOSSIP.lost, counters.byType.GOSSIP.sent);
  assert.ok(counters.byType.SYNC_DELTA.delivered > 0);
});

test('rounds interrupted by packet loss are abandoned and later ones finish the job', t => {
  const net = new SimNet({
    seed: 4,
    datasets: () => [kvSet(), castSet()],
    engine: { limits: { ...DEFAULT_SYNC_LIMITS, maxRecordsPerPacket: 20 } },
  });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');
  for (let i = 0; i < 300; i += 1) a.engine.publish('kv', alice.kv(`a${i}`, 1));
  for (let i = 0; i < 300; i += 1) b.engine.publish('kv', bob.kv(`b${i}`, 1));
  for (let n = 1; n <= 200; n += 1) a.engine.publish('cast', alice.cast('c', n));

  // A third of all packets vanish, sync packets included, so rounds stall midway.
  net.setLoss(0.34);
  net.link('a', 'b');
  net.run();
  net.rounds(6);
  assert.ok(net.counters().lost > 0);
  assert.ok(a.engine.stats().roundsAbandoned + b.engine.stats().roundsAbandoned > 0);

  net.setLoss(0);
  net.rounds(3);
  assert.equal(a.sets.kv.size, 600);
  assert.equal(b.sets.kv.size, 600);
  assert.equal(b.sets.cast.size, 200);
  assert.ok(net.agree('kv') && net.agree('cast'));
  assert.equal(a.engine.stats().activeRounds + b.engine.stats().activeRounds, 0);
  assert.deepEqual([...a.faults, ...b.faults], []);
});

// ---------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------

/** Tap that records every record carried and every non-empty request, per receiver. */
function traffic(net) {
  const log = { records: {}, wants: {} };
  net.tap(({ to, packet }) => {
    if (packet.type === PacketType.GOSSIP || packet.type === PacketType.SYNC_DELTA) {
      log.records[to] = (log.records[to] ?? 0) + packet.header.n;
    } else if (packet.type === PacketType.SYNC_REQUEST) {
      log.wants[to] = (log.wants[to] ?? 0) + listOf(packet).length;
    }
  });
  return log;
}

test('retention floors: pruned log entries are neither requested nor offered again', t => {
  const net = new SimNet({ seed: 21, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const big = net.addNode('big', { datasets: [kvSet(), castSet({ maxPerStream: 500 })] });
  const small = net.addNode('small', { datasets: [kvSet(), castSet({ maxPerStream: 5 })] });
  const stream = castStream(alice.cast('news', 1));
  for (let n = 1; n <= 40; n += 1) big.engine.publish('cast', alice.cast('news', n));

  const log = traffic(net);
  net.link('big', 'small');
  net.run();

  // The small node keeps the newest five and was sent exactly those.
  assert.deepEqual(small.sets.cast.digest(), [[stream, 35, 40]]);
  assert.deepEqual(big.sets.cast.digest(), [[stream, 0, 40]]);
  assert.equal(log.records.small, 5, 'only what the small window keeps should travel');
  assert.equal(log.records.big, undefined);

  // Any number of further rounds, started from either side, move nothing and ask for
  // nothing: the floor answers for the pruned indices.
  log.records = {};
  log.wants = {};
  net.rounds(5);
  assert.deepEqual(log.records, {});
  assert.deepEqual(log.wants, { big: 0, small: 0 });
  assert.ok(big.engine.stats().roundsCompleted >= 5);
  assert.ok(small.engine.stats().roundsCompleted >= 5);
  assert.deepEqual(small.sets.cast.digest(), [[stream, 35, 40]]);

  // New entries still flow, and move the window.
  big.engine.publish('cast', alice.cast('news', 41));
  big.engine.publish('cast', alice.cast('news', 42));
  net.run();
  assert.deepEqual(small.sets.cast.digest(), [[stream, 37, 42]]);
  assert.equal(log.records.small, 2);

  // The other direction: the small node's stream is offered whole to the big one.
  for (let n = 1; n <= 9; n += 1) small.engine.publish('cast', bob.cast('news', n));
  net.run();
  net.rounds(2);
  const bobStream = castStream(bob.cast('news', 1));
  assert.deepEqual(small.sets.cast.digest().find(e => e[0] === bobStream), [bobStream, 4, 9]);
  // Gossip delivered all nine as they were published; the big node keeps them.
  assert.deepEqual(big.sets.cast.digest().find(e => e[0] === bobStream), [bobStream, 0, 9]);
  log.records = {};
  log.wants = {};
  net.rounds(3);
  assert.deepEqual(log.records, {});
  assert.deepEqual(log.wants, { big: 0, small: 0 });
  assert.deepEqual([...big.faults, ...small.faults], []);
});

test('retention floors: a removed LWW record does not flow back, a newer version does', t => {
  const net = new SimNet({ seed: 8, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');
  const doc = alice.kv('doc', 3);
  const other = alice.kv('other', 1);
  a.engine.publish('kv', doc);
  a.engine.publish('kv', other);
  net.link('a', 'b');
  net.run();
  assert.deepEqual(b.sets.kv.get(kvKey(doc)), doc);

  assert.equal(b.sets.kv.remove(kvKey(doc)), true);
  const log = traffic(net);
  net.rounds(5);
  assert.deepEqual(log.records, {}, 'the removed record must not be sent again');
  assert.deepEqual(log.wants, { a: 0, b: 0 }, 'and must not be asked for');
  assert.equal(b.sets.kv.get(kvKey(doc)), undefined);
  assert.deepEqual(a.sets.kv.get(kvKey(doc)), doc, 'the other node keeps its copy');
  assert.equal(b.sets.kv.floorOf(kvKey(doc)), 3);

  const newer = alice.kv('doc', 4);
  a.engine.publish('kv', newer);
  net.run();
  assert.deepEqual(b.sets.kv.get(kvKey(doc)), newer);
  assert.equal(b.sets.kv.floorOf(kvKey(doc)), undefined);
  assert.deepEqual([...a.faults, ...b.faults], []);
});

test('a node at capacity keeps the highest versions and is not offered the rest again', t => {
  const net = new SimNet({ seed: 14, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const big = net.addNode('big');
  const small = net.addNode('small', {
    datasets: [kvSet({ maxEntries: 10 }), castSet({ maxStreams: 2 })],
  });
  for (let i = 1; i <= 50; i += 1) big.engine.publish('kv', alice.kv(`k${i}`, i));
  for (const chan of ['c1', 'c2', 'c3', 'c4']) {
    for (let n = 1; n <= 3; n += 1) big.engine.publish('cast', alice.cast(chan, n));
  }
  net.link('big', 'small');
  net.run();
  net.rounds(2);

  // The ten highest versions, and two of the four streams.
  assert.deepEqual(
    small.sets.kv.values().map(r => r.seq).sort((x, y) => x - y),
    [41, 42, 43, 44, 45, 46, 47, 48, 49, 50],
  );
  assert.equal(small.sets.cast.streamCount, 2);
  assert.equal(small.sets.cast.size, 6);
  assert.equal(big.sets.kv.size, 50);

  const log = traffic(net);
  net.rounds(5);
  assert.deepEqual(log.records, {}, 'what the small node cannot hold must not be re-sent');
  assert.deepEqual(log.wants, { big: 0, small: 0 });
  assert.deepEqual([...big.faults, ...small.faults], []);
});

// ---------------------------------------------------------------------------------------
// Hostile peers
// ---------------------------------------------------------------------------------------

test('hostile: invalid records are dropped, reported and never forwarded', () => {
  const h = harness();
  for (const peer of ['evil', 'p2', 'p3']) {
    h.engine.addPeer(peer);
    finishRound(h, peer);
  }
  const good = alice.kv('good', 1);
  const forged = { ...alice.kv('forged', 1), sig: bob.kv('forged', 1).sig };
  const tampered = { ...alice.kv('tampered', 1, 'original'), val: 'changed' };
  const afterBad = alice.kv('after', 1);

  h.engine.handlePacket('evil', gossip('kv', [good, forged, afterBad]));
  assert.deepEqual(h.faults, [{ peer: 'evil', reason: 'invalid-record', detail: 'kv: bad-signature' }]);
  assert.deepEqual(h.kv.get(kvKey(good)), good, 'records before the bad one were valid and stay');
  assert.equal(h.kv.get(kvKey(forged)), undefined);
  assert.equal(h.kv.get(kvKey(afterBad)), undefined, 'the rest of the packet is not processed');

  h.engine.handlePacket('evil', delta('kv', [tampered]));
  h.engine.handlePacket('evil', gossip('cast', [alice.kv('wrong-set', 1)]));
  h.engine.handlePacket('evil', gossip('kv', [{ type: 'kv', origin: alice.origin, name: 'unsigned', seq: 1 }]));
  h.engine.handlePacket('evil', gossip('kv', [{ type: 'kv', name: 'no-version', origin: 'x' }]));
  assert.deepEqual(h.faults.slice(1).map(f => [f.reason, f.detail]), [
    ['invalid-record', 'kv: bad-signature'],
    ['invalid-record', 'cast: bad-index'],
    ['invalid-record', 'kv: unsigned'],
    ['invalid-record', 'kv: bad-version'],
  ]);
  assert.equal(h.kv.size, 1);
  assert.equal(h.cast.size, 0);

  h.engine.flush();
  const forwarded = h.sent.splice(0);
  assert.deepEqual(forwarded.map(s => s.peer).sort(), ['p2', 'p3']);
  for (const { packet } of forwarded) assert.deepEqual(recordsOf(packet), [good]);
  assert.equal(h.engine.stats().invalid, 5);
  assert.equal(h.engine.stats().faults, 5);
  assert.equal(h.engine.stats().accepted, 1);
});

test('hostile: malformed record batches are reported and nothing in them is stored', () => {
  const h = harness();
  h.engine.addPeer('evil');
  h.take();
  const good = alice.kv('good', 1);
  const frame = bytes => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length);
    return Buffer.concat([prefix, bytes]);
  };
  const goodFrame = frame(canonicalBytes(good));
  const packet = (header, body) => ({ type: PacketType.GOSSIP, header, body });
  const hugeLength = Buffer.alloc(8);
  hugeLength.writeUInt32BE(0xffffffff);

  const cases = [
    ['bad-body', packet({ n: 2, set: 'kv' }, goodFrame)],
    ['bad-body', packet({ n: 1, set: 'kv' }, Buffer.concat([goodFrame, goodFrame]))],
    ['bad-body', packet({ n: 1, set: 'kv' }, goodFrame.subarray(0, goodFrame.length - 1))],
    ['bad-body', packet({ n: 1, set: 'kv' }, Buffer.from([0, 0]))],
    ['bad-body', packet({ n: 1, set: 'kv' }, hugeLength)],
    ['bad-body', packet({ n: 1, set: 'kv' }, frame(Buffer.from('1')))],
    ['bad-body', packet({ n: 1, set: 'kv' }, frame(Buffer.alloc(SyncWire.MAX_RECORD + 1, 0x20)))],
    ['bad-body', packet({ n: 1, set: 'kv' }, Buffer.alloc(0))],
    ['bad-body', packet({ n: 1, set: 'kv' }, undefined)],
    ['bad-body', packet({ n: 1, set: 'kv' }, 'not bytes')],
    ['bad-header', packet({ n: 0, set: 'kv' }, goodFrame)],
    ['bad-header', packet({ n: SyncWire.MAX_ITEMS + 1, set: 'kv' }, goodFrame)],
    ['bad-header', packet({ n: 1.5, set: 'kv' }, goodFrame)],
    ['bad-header', packet({ n: '1', set: 'kv' }, goodFrame)],
    ['bad-header', packet({ set: 'kv' }, goodFrame)],
    ['bad-header', packet({ n: 1 }, goodFrame)],
    ['bad-header', packet({ n: 1, set: 'kv', extra: true }, goodFrame)],
    ['bad-header', packet({ n: 1, set: 'KV' }, goodFrame)],
    ['bad-header', packet({ n: 1, set: 7 }, goodFrame)],
    ['bad-header', packet([], goodFrame)],
    ['bad-header', packet(null, goodFrame)],
    ['bad-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('{"b":1,"a":2}')))],
    ['bad-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('{ "a": 1 }')))],
    ['bad-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('{"a":1.5}')))],
    ['bad-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('{"a":')))],
    ['bad-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])))],
    ['invalid-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('[1]')))],
    ['invalid-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('"x"')))],
    ['invalid-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('null')))],
    ['invalid-record', packet({ n: 1, set: 'kv' }, frame(Buffer.from('{}')))],
  ];
  for (const [reason, hostile] of cases) {
    h.faults.length = 0;
    h.engine.handlePacket('evil', hostile);
    assert.equal(h.faults.length, 1, `${reason}: ${JSON.stringify(hostile.header)}`);
    assert.equal(h.faults[0].reason, reason, h.faults[0].detail);
    assert.equal(h.faults[0].peer, 'evil');
  }
  assert.equal(h.kv.size, 0);
  assert.deepEqual(h.sent, [], 'a malformed packet is never answered');

  // A good record in front of a broken frame is not stored either: framing is checked
  // before any record is looked at.
  h.engine.handlePacket('evil', packet({ n: 2, set: 'kv' }, Buffer.concat([goodFrame, Buffer.from([0, 0, 0])])));
  assert.equal(h.kv.size, 0);

  // The same packet, well-formed, is accepted: the harness itself is sound.
  h.faults.length = 0;
  h.engine.handlePacket('evil', packet({ n: 1, set: 'kv' }, goodFrame));
  assert.deepEqual(h.faults, []);
  assert.deepEqual(h.kv.get(kvKey(good)), good);
});

test('hostile: garbage digests are reported and answered with nothing', () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) h.engine.publish('kv', alice.kv(`k${i}`, 1));
  for (let n = 1; n <= 5; n += 1) h.engine.publish('cast', alice.cast('news', n));
  h.engine.addPeer('evil');
  h.take();
  const raw = (header, body) => ({ type: PacketType.SYNC_DIGEST, header, body });
  const header = { after: null, round: 1, set: 'kv', upto: null };
  const tooMany = Array.from({ length: SyncWire.MAX_ITEMS + 1 }, (_, i) => [`k${String(i).padStart(5, '0')}`, 1, H0]);
  const sum = (extra = {}) => raw({ round: 1, set: 'kv', sum: 'a'.repeat(64), ...extra }, canonicalBytes([]));
  const stream = castStream(alice.cast('news', 1));

  const cases = [
    ['bad-digest', raw(header, Buffer.from('not json'))],
    ['bad-digest', raw(header, Buffer.from('{}'))],
    ['bad-digest', raw(header, Buffer.from('[ ]'))],
    ['bad-digest', raw(header, Buffer.from([0xff, 0xfe]))],
    ['bad-digest', raw(header, canonicalBytes(tooMany))],
    ['bad-digest', digest('kv', 1, [['b', 1, H0], ['a', 1, H0]])],
    ['bad-digest', digest('kv', 1, [['a', 1, H0], ['a', 1, H0]])],
    ['bad-digest', digest('kv', 1, [['a', -1, H0]])],
    ['bad-digest', digest('kv', 1, [['a', 1, 7]])],
    ['bad-digest', digest('kv', 1, [['a', 1]])],
    ['bad-digest', digest('kv', 1, [['a', 1, H0.toUpperCase()]])],
    ['bad-digest', digest('kv', 1, [[null, 1, H0]])],
    ['bad-digest', digest('kv', 1, ['a'])],
    ['bad-digest', digest('kv', 1, [['a', 1, H0]], { after: 'b' })],
    ['bad-digest', digest('kv', 1, [['z', 1, H0]], { upto: 'b' })],
    ['bad-digest', raw({ round: 1, set: 'kv', sum: 'a'.repeat(64) }, canonicalBytes([['a', 1, H0]]))],
    ['bad-header', sum({ sum: 'A'.repeat(64) })],
    ['bad-header', sum({ sum: 'a'.repeat(63) })],
    ['bad-header', sum({ sum: 7 })],
    ['bad-header', sum({ after: null })],
    ['bad-header', sum({ hint: {} })],
    ['bad-digest', digest('cast', 1, [[stream, 5, 2]], { hint: { win: 10 } })],
    ['bad-digest', digest('cast', 1, [[stream, 0, 2, [[3, 4]]]], { hint: { win: 10 } })],
    ['bad-digest', digest('cast', 1, [['b', 0, 1], ['a', 0, 1]], { hint: { win: 10 } })],
    ['bad-cursor', digest('kv', 1, [], { after: 7 })],
    ['bad-cursor', digest('kv', 1, [], { after: 'has space' })],
    ['bad-cursor', digest('kv', 1, [], { after: 'b', upto: 'a' })],
    ['bad-cursor', digest('kv', 1, [], { upto: ['a', 1] })],
    ['bad-cursor', digest('cast', 1, [], { after: 'a', hint: { win: 10 } })],
    // A log page may end inside a stream (['a', 5] is valid); a malformed end may not.
    ['bad-cursor', digest('cast', 1, [], { upto: ['a', 5.5], hint: { win: 10 } })],
    ['bad-cursor', digest('cast', 1, [], { upto: ['a', 5, 1], hint: { win: 10 } })],
    ['bad-cursor', digest('cast', 1, [], { after: ['a', -1], hint: { win: 10 } })],
    ['bad-hint', digest('cast', 1, [])],
    ['bad-hint', digest('cast', 1, [], { hint: { win: 0 } })],
    ['bad-hint', digest('cast', 1, [], { hint: { win: 5, full: 1 } })],
    ['bad-hint', digest('kv', 1, [], { hint: { min: -1 } })],
    ['bad-hint', digest('kv', 1, [], { hint: { win: 5 } })],
    ['bad-hint', digest('kv', 1, [], { hint: 'x' })],
    ['bad-hint', digest('kv', 1, [], { hint: [] })],
    ['bad-header', raw({ round: 1, set: 'kv', upto: null }, canonicalBytes([]))],
    ['bad-header', raw({ ...header, extra: 1 }, canonicalBytes([]))],
    ['bad-header', raw({ ...header, round: 0 }, canonicalBytes([]))],
    ['bad-header', raw({ ...header, round: 1.5 }, canonicalBytes([]))],
    ['bad-header', raw({ ...header, round: '1' }, canonicalBytes([]))],
    ['bad-header', raw({ ...header, set: 'bad name' }, canonicalBytes([]))],
    ['bad-body', raw(header, Buffer.alloc(0))],
  ];
  for (const [reason, hostile] of cases) {
    h.faults.length = 0;
    h.engine.handlePacket('evil', hostile);
    assert.equal(h.faults.length, 1, `${reason}: ${JSON.stringify(hostile.header)}`);
    assert.equal(h.faults[0].reason, reason, h.faults[0].detail);
  }
  assert.deepEqual(h.sent, [], 'a garbage digest gets no records and no request');
  assert.equal(h.engine.stats().faults, cases.length);

  // A digest at the size limit is fine, and is answered.
  const atLimit = Array.from({ length: SyncWire.MAX_ITEMS }, (_, i) => [`k${String(i).padStart(5, '0')}`, 1, H0]);
  h.faults.length = 0;
  h.engine.handlePacket('evil', digest('kv', 1, atLimit));
  assert.deepEqual(h.faults, []);
  assert.equal(h.take().filter(p => p.type === PacketType.SYNC_REQUEST).length, 1);
});

test('hostile: requests for unadvertised or absurd ranges are reported and served nothing', () => {
  const h = harness();
  for (let i = 0; i < 6; i += 1) h.engine.publish('kv', alice.kv(`k${i}`, 1));
  for (let n = 1; n <= 20; n += 1) h.engine.publish('cast', alice.cast('news', n));
  const stream = castStream(alice.cast('news', 1));
  const keys = h.kv.digest().map(e => e[0]);

  /** Start a fresh round with a new puppet peer and walk it to the page of `set`. */
  let peers = 0;
  const openRound = set => {
    peers += 1;
    const peer = `evil${peers}`;
    h.engine.addPeer(peer);
    let page = nextPage(h, peer);
    if (set === 'cast') {
      h.engine.handlePacket(peer, request('kv', page.header.round, []));
      page = nextPage(h, peer);
    }
    assert.equal(page.type, PacketType.SYNC_DIGEST);
    assert.equal(page.header.set, set);
    return { peer, round: page.header.round, page };
  };

  const castCases = [
    ['bad-range', [[stream, 1, MAX_INDEX]]],
    ['bad-range', [[stream, 1, 21]]],
    ['bad-range', [[stream, 1, 1_000_000_000]]],
    ['bad-range', [['other/stream', 1, 5]]],
    ['bad-request', [[stream, 0, 5]]],
    ['bad-request', [[stream, 5, 1]]],
    ['bad-request', Buffer.from(`[["${stream}",1,9007199254740992]]`)],
    ['bad-request', Buffer.from('[["s",1,2]')],
    ['bad-request', Buffer.from('{"want":"all"}')],
    ['bad-request', [[stream, 1]]],
    ['bad-request', [[stream, 5, 9], [stream, 1, 3]]],
    ['bad-request', [[stream, 1, 5], [stream, 5, 9]]],
    ['bad-request', ['everything']],
    ['bad-request', Array.from({ length: SyncWire.MAX_ITEMS + 1 }, (_, i) => [stream, i + 1, i + 1])],
  ];
  for (const [reason, wants] of castCases) {
    const { peer, round } = openRound('cast');
    h.faults.length = 0;
    // A Buffer is a raw body, for requests that canonical JSON cannot even express.
    const reply = request('cast', round, Buffer.isBuffer(wants) ? [] : wants);
    if (Buffer.isBuffer(wants)) reply.body = wants;
    h.engine.handlePacket(peer, reply);
    assert.deepEqual(h.faults.map(f => [f.peer, f.reason]), [[peer, reason]], reply.body.toString().slice(0, 60));
    assert.deepEqual(h.take(peer), [], 'nothing is served and the round does not continue');
  }
  const kvCases = [
    ['bad-range', ['never/advertised']],
    ['bad-request', [keys[1], keys[0]]],
    ['bad-request', [keys[0], keys[0]]],
    ['bad-request', [7]],
    ['bad-request', [[keys[0], 1]]],
  ];
  for (const [reason, wants] of kvCases) {
    const { peer, round } = openRound('kv');
    h.faults.length = 0;
    h.engine.handlePacket(peer, request('kv', round, wants));
    assert.deepEqual(h.faults.map(f => [f.peer, f.reason]), [[peer, reason]]);
    assert.deepEqual(h.take(peer), []);
  }
  assert.equal(h.engine.stats().roundsAbandoned, castCases.length + kvCases.length);
  assert.equal(h.engine.stats().activeRounds, 0);
  assert.equal(h.engine.stats().deltasOut, 0);

  // A request inside what was advertised is served, and the round moves on.
  const { peer, round } = openRound('cast');
  h.faults.length = 0;
  h.engine.handlePacket(peer, request('cast', round, [[stream, 3, 5], [stream, 19, 20]]));
  assert.deepEqual(h.faults, []);
  const [served] = h.take(peer);
  assert.equal(served.type, PacketType.SYNC_DELTA);
  assert.deepEqual(recordsOf(served).map(r => r.n), [3, 4, 5, 19, 20]);
  assert.equal(h.engine.stats().roundsCompleted, 1);
});

test('hostile: a continuation that does not advance or leaves the page is reported', () => {
  const h = harness({ limits: { ...DEFAULT_SYNC_LIMITS, maxRecordsPerPacket: 4 } });
  for (let i = 0; i < 10; i += 1) h.engine.publish('kv', alice.kv(`k${i}`, 1));
  const keys = h.kv.digest().map(e => e[0]);
  let peers = 0;
  const secondPage = () => {
    peers += 1;
    const peer = `evil${peers}`;
    h.engine.addPeer(peer);
    const first = nextPage(h, peer);
    assert.deepEqual(listOf(first).map(e => e[0]), keys.slice(0, 4));
    h.engine.handlePacket(peer, request('kv', first.header.round, []));
    const second = nextPage(h, peer);
    assert.equal(second.header.after, keys[3]);
    assert.equal(second.header.upto, keys[7]);
    return { peer, round: second.header.round };
  };

  for (const next of [keys[3], keys[0], keys[8], 'has space', 12, ['a', 1]]) {
    const { peer, round } = secondPage();
    h.faults.length = 0;
    h.engine.handlePacket(peer, request('kv', round, [], { next }));
    assert.deepEqual(h.faults.map(f => f.reason), ['bad-cursor'], `next = ${JSON.stringify(next)}`);
    assert.deepEqual(h.take(peer), []);
  }
  // A stop must not smuggle a continuation or a request; an unknown scope is refused.
  for (const reply of [
    request('kv', 0, [], { stop: 'set', next: keys[5] }),
    request('kv', 0, [keys[5]], { stop: 'set' }),
    request('kv', 0, [], { stop: 'everything' }),
  ]) {
    const { peer, round } = secondPage();
    h.faults.length = 0;
    h.engine.handlePacket(peer, { ...reply, header: { ...reply.header, round } });
    assert.deepEqual(h.faults.map(f => f.reason), ['bad-header']);
    assert.deepEqual(h.take(peer), []);
  }
  assert.equal(h.engine.stats().activeRounds, 0);

  // A continuation inside the page is honoured: the next page starts right after it.
  const { peer, round } = secondPage();
  h.engine.handlePacket(peer, request('kv', round, [], { next: keys[5] }));
  const [third] = h.take(peer);
  assert.equal(third.header.after, keys[5]);
  assert.deepEqual(listOf(third).map(e => e[0]), keys.slice(6, 10));
});

test('hostile: replaying a digest cannot make a node send its records twice in one round', () => {
  const h = harness();
  for (let i = 0; i < 30; i += 1) h.engine.publish('kv', alice.kv(`k${i}`, 1));
  for (let n = 1; n <= 30; n += 1) h.engine.publish('cast', alice.cast('news', n));
  h.engine.addPeer('evil');
  h.take();
  const empty = set => digest(set, 1, [], set === 'cast' ? { hint: { win: 1000 } } : {});

  // "I have nothing": the node sends everything, once.
  h.engine.handlePacket('evil', empty('kv'));
  h.engine.handlePacket('evil', empty('cast'));
  let out = h.take();
  assert.deepEqual(out.map(p => typeName(p.type)), ['SYNC_DELTA', 'SYNC_REQUEST', 'SYNC_DELTA', 'SYNC_REQUEST']);
  assert.equal(out[0].header.n + out[2].header.n, 60);

  // Asking again within the same round yields no records, however often.
  for (let i = 0; i < 20; i += 1) {
    h.engine.handlePacket('evil', empty('kv'));
    h.engine.handlePacket('evil', empty('cast'));
    h.engine.handlePacket('evil', digest('kv', 1, [], { after: '!' }));
  }
  out = h.take();
  assert.equal(out.length, 60);
  assert.ok(out.every(p => p.type === PacketType.SYNC_REQUEST));
  assert.equal(h.engine.stats().recordsOut, 60);

  // A new round straight away is declined ...
  h.engine.handlePacket('evil', { ...empty('kv'), header: { ...empty('kv').header, round: 2 } });
  out = h.take();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].header, { next: null, round: 2, set: 'kv', stop: 'round' });
  assert.deepEqual(listOf(out[0]), []);
  assert.equal(h.engine.stats().roundsRefused, 1);
  // ... a stale one is ignored ...
  h.engine.handlePacket('evil', { ...empty('kv'), header: { ...empty('kv').header, round: 1 } });
  assert.equal(h.take().length, 1, 'round 1 is still the current round and still answers');
  // ... and once the interval has passed a new round is served again.
  h.state.now += 1_000;
  h.engine.handlePacket('evil', { ...empty('kv'), header: { ...empty('kv').header, round: 2 } });
  out = h.take();
  assert.deepEqual(out.map(p => typeName(p.type)), ['SYNC_DELTA', 'SYNC_REQUEST']);
  assert.equal(out[0].header.n, 30);
  h.engine.handlePacket('evil', empty('kv'));
  assert.deepEqual(h.take(), [], 'round 1 is over');
  assert.equal(h.engine.stats().staleDigests, 1);
  assert.deepEqual(h.faults, []);
});

test('hostile: a peer that inches through a round gets small pages and a bounded number of them', () => {
  const h = harness({
    limits: { ...DEFAULT_SYNC_LIMITS, maxRecordsPerPacket: 64 },
    maxRoundSteps: 12,
  });
  for (let i = 0; i < 200; i += 1) h.engine.publish('kv', alice.kv(`k${String(i).padStart(3, '0')}`, 1));
  h.engine.addPeer('evil');

  // Acknowledge one entry per page and ask for nothing.
  const sizes = [];
  for (;;) {
    const page = nextPage(h, 'evil');
    if (page === undefined) break;
    const entries = listOf(page);
    sizes.push(entries.length);
    h.engine.handlePacket('evil', request('kv', page.header.round, [], { next: entries[0][0] }));
  }
  assert.equal(sizes.length, 11, 'the round ends at maxRoundSteps: the summary and 11 pages');
  assert.equal(sizes[0], 64);
  assert.deepEqual(sizes.slice(1), Array(10).fill(8), 'pages shrink to the minimum at once');
  assert.equal(h.engine.stats().roundsAbandoned, 1);
  assert.equal(h.engine.stats().activeRounds, 0);
  assert.deepEqual(h.faults, []);

  // A peer that takes whole pages gets full-size pages back.
  h.engine.addPeer('honest');
  const honest = [];
  for (;;) {
    const page = nextPage(h, 'honest');
    if (page === undefined || page.header.set !== 'kv') break;
    honest.push(listOf(page).length);
    h.engine.handlePacket('honest', request('kv', page.header.round, []));
  }
  assert.deepEqual(honest, [64, 64, 64, 8]);
});

test('hostile: the gossip queue per peer is bounded', () => {
  const h = harness({ limits: { ...DEFAULT_SYNC_LIMITS, maxPendingPerPeer: 10 } });
  h.engine.addPeer('slow');
  h.engine.addPeer('source');
  h.take();
  const records = Array.from({ length: 25 }, (_, i) => alice.kv(`k${i}`, 1));
  h.engine.handlePacket('source', gossip('kv', records));
  assert.equal(h.engine.stats().accepted, 25);
  assert.equal(h.engine.stats().pending, 10);
  assert.equal(h.engine.stats().gossipDropped, 15);

  h.engine.flush();
  const out = h.take();
  assert.equal(out.length, 1);
  assert.deepEqual(recordsOf(out[0]), records.slice(0, 10));
  assert.equal(h.engine.stats().pending, 0);
  // Everything was stored; what gossip dropped is what anti-entropy is for.
  assert.equal(h.kv.size, 25);
});

// ---------------------------------------------------------------------------------------
// Engine behaviour
// ---------------------------------------------------------------------------------------

test('constructor rejects missing and out-of-range options', () => {
  const good = () => ({ datasets: [kvSet(), castSet()], send: () => true, monoNow: () => 0 });
  assert.doesNotThrow(() => new SyncEngine(good()));
  const bad = [
    { datasets: undefined },
    { datasets: [] },
    { datasets: [null] },
    { datasets: [{ name: 'kv' }] },
    { datasets: [{ ...Object.fromEntries(['offer', 'syncPage'].map(m => [m, () => {}])), name: 'kv' }] },
    { datasets: [kvSet(), kvSet()] },
    { send: undefined },
    { monoNow: 5 },
    { monoNow: undefined, now: () => 0 },
    { rng: null },
    { schedule: 'soon' },
    { onError: 1 },
    { self: '' },
    { self: 5 },
    { limits: null },
    { limits: { maxRecordsPerPacket: 0 } },
    { limits: { maxRecordsPerPacket: SyncWire.MAX_ITEMS + 1 } },
    { limits: { maxBytesPerPacket: SyncWire.MIN_PACKET - 1 } },
    { limits: { maxBytesPerPacket: SyncWire.MAX_PACKET + 1 } },
    { limits: { maxBytesPerPacket: SyncWire.MAX_BODY } },
    { limits: { maxBytesPerPacket: 100_000.5 } },
    { limits: { maxPendingPerPeer: 0 } },
    { limits: { maxPendingPerPeer: 1.5 } },
    { gossipBatchMs: -1 },
    { roundTimeoutMs: 0 },
    { minRoundIntervalMs: -1 },
    { maxRoundSteps: 0 },
    { newKeysPerMinute: 0 },
    { newKeysPerMinute: 1.5 },
    { allowOrigin: 'everyone' },
    { holdDownMs: null },
    { holdDownMs: [5000] },
    { holdDownMs: { nope: 5000 } },
    { holdDownMs: { cast: 5000 } },
    { holdDownMs: { kv: 0 } },
    { holdDownMs: { kv: 2.5 } },
  ];
  for (const override of bad) {
    assert.throws(() => new SyncEngine({ ...good(), ...override }), ConfigError, Object.keys(override)[0]);
  }
  assert.throws(() => new SyncEngine(), ConfigError);
  assert.doesNotThrow(() => new SyncEngine({ ...good(), holdDownMs: { kv: 5000 }, newKeysPerMinute: 1 }));
  assert.doesNotThrow(
    () =>
      new SyncEngine({
        ...good(),
        limits: { maxRecordsPerPacket: SyncWire.MAX_ITEMS, maxBytesPerPacket: SyncWire.MAX_PACKET },
      }),
  );
  assert.doesNotThrow(
    () => new SyncEngine({ ...good(), limits: { maxBytesPerPacket: SyncWire.MIN_PACKET } }),
  );
  // The receiver's bound stays what DESIGN.md 15.7 calls the parser's hard bound ...
  assert.ok(4 + Limits.MAX_HEADER + SyncWire.MAX_BODY <= Limits.MAX_PACKET);
  // ... while the engine sends 64 KiB at most, by default and by configuration.
  assert.equal(DEFAULT_SYNC_LIMITS.maxBytesPerPacket, Limits.MAX_SYNC_PACKET);
  assert.equal(SyncWire.MAX_PACKET, Limits.MAX_SYNC_PACKET);
  // A record of MAX_RECORD bytes, alone in a batch with the longest header, fills a
  // packet exactly.
  const longest = { n: SyncWire.MAX_ITEMS, set: 'x'.repeat(32) };
  assert.ok(canonicalBytes(longest).length <= 64);
  assert.equal(4 + 64 + 4 + SyncWire.MAX_RECORD, Limits.MAX_SYNC_PACKET);
});

test('publish validates, stores and queues; it refuses what cannot travel', () => {
  const h = harness();
  h.engine.addPeer('p1');
  h.take();

  assert.throws(() => h.engine.publish('nope', alice.kv('a', 1)), StateError);
  assert.deepEqual(h.engine.publish('kv', { ...alice.kv('a', 1), extra: 1.5 }), {
    accepted: false,
    reason: 'unencodable',
  });
  const huge = alice.kv('huge', 1, 'x'.repeat(SyncWire.MAX_RECORD));
  assert.deepEqual(h.engine.publish('kv', huge), { accepted: false, reason: 'too-large' });
  assert.equal(h.kv.size, 0);
  assert.deepEqual(h.engine.publish('kv', { ...alice.kv('a', 1), sig: 'AAAA' }), {
    accepted: false,
    reason: 'bad-signature',
  });
  assert.equal(h.kv.size, 0);
  assert.equal(h.engine.stats().pending, 0);

  const record = alice.kv('a', 2);
  assert.deepEqual(h.engine.publish('kv', record), { accepted: true });
  assert.deepEqual(h.engine.publish('kv', record), { accepted: false, reason: 'duplicate' });
  assert.deepEqual(h.engine.publish('kv', alice.kv('a', 1)), { accepted: false, reason: 'stale' });
  assert.equal(h.engine.stats().published, 1);
  assert.equal(h.engine.stats().pending, 1);
  assert.deepEqual(h.sent, [], 'nothing leaves before the batch is flushed');
  h.engine.flush();
  assert.deepEqual(recordsOf(h.take()[0]), [record]);
});

test('gossip is batched per dataset and split at the packet limits', () => {
  const h = harness({ limits: { ...DEFAULT_SYNC_LIMITS, maxRecordsPerPacket: 4 } });
  h.engine.addPeer('p1');
  h.engine.addPeer('p2');
  h.take();
  const kvRecords = Array.from({ length: 9 }, (_, i) => alice.kv(`k${i}`, 1));
  const casts = [1, 2].map(n => alice.cast('news', n));
  for (const record of kvRecords) h.engine.publish('kv', record);
  for (const record of casts) h.engine.publish('cast', record);
  h.engine.flush();

  for (const peer of ['p1', 'p2']) {
    const out = h.take(peer);
    assert.deepEqual(out.map(p => [typeName(p.type), p.header.set, p.header.n]), [
      ['GOSSIP', 'kv', 4],
      ['GOSSIP', 'kv', 4],
      ['GOSSIP', 'kv', 1],
      ['GOSSIP', 'cast', 2],
    ]);
    assert.deepEqual(out.slice(0, 3).flatMap(recordsOf), kvRecords, 'publish order is kept');
    assert.deepEqual(recordsOf(out[3]), casts);
  }
  h.engine.flush();
  assert.deepEqual(h.sent, [], 'a flush with nothing queued sends nothing');
});

test('the batch timer is armed once per batch and cancelled by flush and close', () => {
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const h = harness({ schedule, gossipBatchMs: 40 });
  h.engine.addPeer('p1');
  h.take();

  h.engine.publish('kv', alice.kv('a', 1));
  h.engine.publish('kv', alice.kv('b', 1));
  assert.equal(timers.length, 1, 'one timer for the whole batch');
  assert.equal(timers[0].ms, 40);
  assert.deepEqual(h.sent, []);
  timers[0].fn();
  assert.equal(h.take()[0].header.n, 2);

  // The next batch arms a new timer; an explicit flush cancels it.
  h.engine.publish('kv', alice.kv('c', 1));
  assert.equal(timers.length, 2);
  h.engine.flush();
  assert.equal(timers[1].cancelled, true);
  assert.equal(h.take().length, 1);

  // close() cancels a pending timer and drops the queue with the peers.
  h.engine.publish('kv', alice.kv('d', 1));
  assert.equal(timers.length, 3);
  h.engine.close();
  assert.equal(timers[2].cancelled, true);
  assert.equal(h.engine.stats().peers, 0);
  assert.equal(h.engine.stats().pending, 0);

  // With nobody to send to, nothing is queued and no timer is armed.
  h.engine.publish('kv', alice.kv('e', 1));
  assert.equal(timers.length, 3);
});

test('addPeer starts a round at once; with `self` only the smaller id does', () => {
  const h = harness();
  assert.equal(h.engine.addPeer('p1'), true);
  assert.equal(h.engine.addPeer('p1'), false, 'a known peer is left alone');
  const out = h.take();
  assert.equal(out.length, 1);
  assert.equal(out[0].type, PacketType.SYNC_DIGEST);
  // A round opens each dataset with the hash of its whole digest.
  assert.deepEqual(out[0].header, { round: 1, set: 'kv', sum: h.kv.syncSummary() });
  assert.deepEqual(listOf(out[0]), []);
  for (const bad of ['', 5, null, undefined]) assert.throws(() => h.engine.addPeer(bad), ConfigError);

  const m = harness({ self: 'm' });
  m.engine.addPeer('z');
  assert.equal(m.take().length, 1, 'm < z: we start');
  m.engine.addPeer('a');
  assert.deepEqual(m.take(), [], 'a < m: the peer starts');
  assert.equal(m.engine.stats().roundsStarted, 1);
  // The quiet side still syncs with that peer when its turn comes.
  finishRound(m, 'z');
  m.state.now += 20_000;
  assert.equal(m.engine.tick(), 'z');
});

test('removePeer drops the peer, its queued gossip and its round', () => {
  const h = harness();
  h.engine.addPeer('p1');
  h.engine.addPeer('p2');
  const [page] = h.take('p1');
  h.take();
  h.engine.publish('kv', alice.kv('a', 1));
  assert.equal(h.engine.stats().pending, 2);

  assert.equal(h.engine.removePeer('p1'), true);
  assert.equal(h.engine.removePeer('p1'), false);
  assert.equal(h.engine.stats().peers, 1);
  assert.equal(h.engine.stats().pending, 1);
  h.engine.flush();
  assert.deepEqual(h.sent.map(s => s.peer), ['p2']);
  h.take();

  // A late reply from the removed peer is dropped without a fault and without an answer.
  h.engine.handlePacket('p1', request('kv', page.header.round, []));
  h.engine.handlePacket('p1', gossip('kv', [alice.kv('late', 1)]));
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.faults, []);
  assert.equal(h.engine.stats().strayPackets, 2);
  assert.equal(h.kv.size, 1);
});

test('handlePacket rejects packets that are not sync packets as a caller error', () => {
  const h = harness();
  h.engine.addPeer('p1');
  h.take();
  for (const packet of [null, undefined, 'packet', 7]) {
    assert.throws(() => h.engine.handlePacket('p1', packet), StateError);
  }
  for (const type of [PacketType.PING, PacketType.DATA, 99, undefined]) {
    assert.throws(() => h.engine.handlePacket('p1', { type, header: {}, body: Buffer.from('[]') }), StateError);
  }
  assert.deepEqual(h.faults, []);

  // A packet as the codec decodes it (with `flags`, body as a view) is accepted.
  const record = alice.kv('a', 1);
  h.engine.handlePacket('p1', decodePacket(encodePacket(gossip('kv', [record]))));
  assert.deepEqual(h.kv.get(kvKey(record)), record);
  // So is a body that is a plain Uint8Array over a larger buffer.
  const other = alice.kv('b', 1);
  const padded = Buffer.concat([Buffer.alloc(3), encodeRecords([other]), Buffer.alloc(5)]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 3, padded.length - 8);
  h.engine.handlePacket('p1', { type: PacketType.GOSSIP, header: { n: 1, set: 'kv' }, body: view });
  assert.deepEqual(h.kv.get(kvKey(other)), other);
  assert.deepEqual(h.faults, []);
});

test('tick picks an idle peer with the injected rng and abandons rounds that went quiet', () => {
  let random = 0;
  const h = harness({ rng: () => random, roundTimeoutMs: 5_000 });
  assert.equal(h.engine.tick(), null, 'no peers, nothing to do');
  for (const peer of ['p1', 'p2', 'p3']) {
    h.engine.addPeer(peer);
    finishRound(h, peer);
  }
  assert.equal(h.engine.stats().roundsCompleted, 3);

  random = 0.5;
  assert.equal(h.engine.tick(), 'p2');
  random = 0.99;
  assert.equal(h.engine.tick(), 'p3');
  random = 0.99;
  assert.equal(h.engine.tick(), 'p1', 'p2 and p3 are busy: p1 is the only idle peer');
  assert.equal(h.engine.tick(), null, 'every peer has a round in progress');
  assert.equal(h.engine.stats().activeRounds, 3);
  assert.equal(h.take().length, 3);

  // Nobody answers. Before the timeout the rounds stay; after it they are abandoned and
  // one peer gets a fresh round.
  h.state.now += 4_999;
  assert.equal(h.engine.tick(), null);
  h.state.now += 1;
  random = 0;
  assert.equal(h.engine.tick(), 'p1');
  assert.equal(h.engine.stats().roundsAbandoned, 3);
  assert.equal(h.engine.stats().activeRounds, 1);
  const [page] = h.take('p1');
  assert.equal(page.header.round, 7);

  // A reply to the abandoned round is stale; a reply to the new one is not.
  h.engine.handlePacket('p1', request('kv', 6, []));
  assert.equal(h.engine.stats().staleReplies, 1);
  assert.deepEqual(h.take(), []);
  h.engine.handlePacket('p1', request('kv', 7, [], { stop: 'same' }));
  assert.equal(h.take('p1')[0].header.set, 'cast');

  // A broken random source cannot index outside the list.
  for (const value of [NaN, -3, 7, Infinity]) {
    random = value;
    h.state.now += 10_000;
    assert.ok(['p1', 'p2', 'p3'].includes(h.engine.tick()), `rng returned ${value}`);
  }
  assert.deepEqual(h.faults, []);
});

test('a failed send abandons the round and drops the gossip, without throwing', () => {
  const h = harness();
  h.state.sendOk = false;
  h.engine.addPeer('p1');
  assert.equal(h.engine.stats().roundsStarted, 1);
  assert.equal(h.engine.stats().roundsAbandoned, 1);
  assert.equal(h.engine.stats().activeRounds, 0);

  for (let i = 0; i < 3; i += 1) h.engine.publish('kv', alice.kv(`k${i}`, 1));
  h.engine.flush();
  assert.equal(h.engine.stats().gossipDropped, 3);
  assert.equal(h.engine.stats().pending, 0);
  assert.equal(h.engine.stats().sendFailures, 2);

  // As responder: if the records cannot be sent, no request is sent either, so the
  // peer's round stalls instead of skipping what it did not receive.
  h.engine.handlePacket('p1', digest('kv', 1, []));
  assert.equal(h.engine.stats().sendFailures, 3);
  assert.equal(h.engine.stats().requestsOut, 0);
  h.state.sendOk = true;
  h.engine.handlePacket('p1', digest('kv', 1, []));
  const out = h.take();
  assert.deepEqual(out.map(p => typeName(p.type)), ['SYNC_DELTA', 'SYNC_REQUEST']);
  assert.equal(out[0].header.n, 3, 'the failed attempt did not count as sent');

  // As initiator answering a request.
  h.state.now += 20_000;
  assert.equal(h.engine.tick(), 'p1');
  const page = nextPage(h, 'p1');
  h.state.sendOk = false;
  h.engine.handlePacket('p1', request('kv', page.header.round, [listOf(page)[0][0]]));
  assert.equal(h.engine.stats().activeRounds, 0);
  assert.equal(h.engine.stats().roundsAbandoned, 2);
  assert.deepEqual(h.faults, []);
});

test('datasets the peer does not run are skipped, not treated as an error', t => {
  const h = harness();
  h.engine.addPeer('p1');
  h.take();
  const unknown = alice.kv('a', 1);
  h.engine.handlePacket('p1', gossip('elsewhere', [unknown]));
  h.engine.handlePacket('p1', digest('elsewhere', 1, []));
  assert.deepEqual(h.faults, []);
  assert.equal(h.engine.stats().unknownSets, 2);
  assert.equal(h.kv.size, 0);
  const out = h.take();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].header, { next: null, round: 1, set: 'elsewhere', stop: 'set' });

  // End to end: a node with two datasets and a node with one converge on the shared one.
  const net = new SimNet({ seed: 3, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const both = net.addNode('a');
  const kvOnly = net.addNode('b', { datasets: [kvSet()] });
  both.engine.publish('kv', alice.kv('x', 1));
  for (let n = 1; n <= 3; n += 1) both.engine.publish('cast', alice.cast('news', n));
  kvOnly.engine.publish('kv', bob.kv('y', 1));
  net.link('a', 'b');
  net.run();
  both.engine.publish('cast', alice.cast('news', 4));
  net.run();
  net.rounds(2);
  assert.ok(net.agree('kv'));
  assert.equal(kvOnly.sets.kv.size, 2);
  assert.equal(both.sets.cast.size, 4);
  assert.ok(both.engine.stats().roundsCompleted >= 3);
  assert.equal(both.engine.stats().roundsAbandoned, 0);
  assert.ok(kvOnly.engine.stats().unknownSets > 0);
  assert.deepEqual([...both.faults, ...kvOnly.faults], []);
});

test('a peer that declines a round ends it without a fault', () => {
  const h = harness();
  h.engine.addPeer('p1');
  const [page] = h.take();
  h.engine.handlePacket('p1', request('kv', page.header.round, [], { stop: 'round' }));
  assert.equal(h.engine.stats().roundsDeclined, 1);
  assert.equal(h.engine.stats().activeRounds, 0);
  assert.deepEqual(h.take(), []);
  assert.deepEqual(h.faults, []);
});

test('records stored behind the engine that cannot travel are skipped, not sent', () => {
  const lenient = new LwwDataset({
    name: 'kv',
    key: record => record.k,
    version: record => record.v,
    check: () => ({ ok: true }),
    maxEntries: 100,
  });
  const lenientLog = new LogDataset({
    name: 'cast',
    stream: record => record.s,
    index: record => record.n,
    check: () => ({ ok: true }),
    maxPerStream: 100,
    maxStreams: 100,
  });
  const h = harness({ kv: lenient, cast: lenientLog });
  // An LWW record must be canonical-JSON data (its hash orders it); a log record need not.
  assert.equal(lenient.offer({ k: 'float', v: 1, value: 1.5 }).accepted, false);
  // The datasets themselves refuse what could never be sent (DESIGN.md 15.7).
  assert.deepEqual(lenient.offer({ k: 'huge', v: 1, value: 'x'.repeat(SyncWire.MAX_RECORD) }), {
    accepted: false,
    reason: 'too-large',
    invalid: true,
  });
  lenient.offer({ k: 'ok', v: 1 });
  lenientLog.offer({ s: 's', n: 1, value: 1.5 });
  lenientLog.offer({ s: 's', n: 2 });
  h.engine.addPeer('p1');
  h.take();

  h.engine.handlePacket('p1', digest('kv', 1, []));
  h.engine.handlePacket('p1', digest('cast', 1, [], { hint: { win: 10 } }));
  const out = h.take();
  assert.deepEqual(out.map(p => typeName(p.type)), ['SYNC_DELTA', 'SYNC_REQUEST', 'SYNC_DELTA', 'SYNC_REQUEST']);
  assert.deepEqual(recordsOf(out[0]), [{ k: 'ok', v: 1 }]);
  assert.deepEqual(recordsOf(out[2]), [{ s: 's', n: 2 }]);
  assert.equal(out[1].header.next, null);
  assert.equal(h.engine.stats().unsendable, 1);
  assert.deepEqual(h.faults, []);
});

test('record batches round-trip, and the codec helpers reject what the wire forbids', () => {
  const records = [alice.kv('a', 1), alice.cast('news', 1, `snow ${String.fromCodePoint(0x2603)}`), { z: [1, 2], a: null }];
  const body = encodeRecords(records);
  assert.deepEqual(decodeRecords(body, 3), records);
  // Layout: u32be length, then the record as canonical JSON.
  const first = canonicalBytes(records[0]);
  assert.equal(body.readUInt32BE(0), first.length);
  assert.deepEqual(body.subarray(4, 4 + first.length), first);
  assert.equal(body.length, records.reduce((sum, r) => sum + 4 + canonicalBytes(r).length, 0));

  assert.throws(() => encodeRecords([]), WireError);
  assert.throws(() => encodeRecords('x'), WireError);
  assert.throws(() => encodeRecords(Array(SyncWire.MAX_ITEMS + 1).fill({ a: 1 })), WireError);
  assert.throws(() => encodeRecords([{ a: 'x'.repeat(SyncWire.MAX_RECORD) }]), WireError);
  assert.throws(() => encodeRecords([{ a: 1.5 }]), CanonicalError);
  assert.throws(() => encodeRecords(Array(20).fill({ a: 'x'.repeat(60_000) })), WireError);

  const fault = (fn, reason) =>
    assert.throws(fn, err => err instanceof SyncFault && err.code === 'ERR_PROTOCOL' && err.reason === reason);
  fault(() => decodeRecords(body, 2), 'bad-body');
  fault(() => decodeRecords(body, 4), 'bad-body');
  fault(() => decodeRecords(body, 0), 'bad-header');
  fault(() => decodeRecords(body, SyncWire.MAX_ITEMS + 1), 'bad-header');
  fault(() => decodeRecords('text', 1), 'bad-body');
  fault(() => decodeRecords(Buffer.from([0, 0, 0, 3, 0x7b, 0x20, 0x7d]), 1), 'bad-record');
});

// ---------------------------------------------------------------------------------------
// The simulator itself
// ---------------------------------------------------------------------------------------

test('simnet: a run is determined by its seed', () => {
  const trace = seed => {
    const net = new SimNet({ seed, datasets: () => [kvSet(), castSet()] });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const id of ids) net.addNode(id);
    const events = [];
    net.tap(event => events.push(`${event.from}>${event.to}:${typeName(event.packet.type)}:${event.bytes}`));
    for (const [x, y] of randomConnectedGraph(ids, 4, () => net.random())) net.link(x, y);
    net.setLoss(0.2);
    for (let i = 0; i < 10; i += 1) net.node(ids[i % 6]).engine.publish('kv', alice.kv(`k${i}`, 1));
    net.run();
    net.rounds(2);
    const result = { events, now: net.now(), counters: net.counters() };
    net.close();
    return result;
  };
  const first = trace(42);
  assert.deepEqual(trace(42), first);
  assert.notDeepEqual(trace(43).events, first.events);
  assert.ok(first.events.length > 20);
  assert.ok(first.counters.lost > 0);
  assert.equal(first.counters.sent, first.events.length);
});

test('simnet: links, cuts, loss, back-pressure and puppets behave as documented', t => {
  const net = new SimNet({ seed: 1, datasets: () => [kvSet(), castSet()], queueLimit: 3 });
  t.after(() => net.close());
  const a = net.addNode('a');
  const puppet = net.addPuppet('p');
  assert.throws(() => net.addNode('a'), /exists already/);
  assert.throws(() => net.node('zz'), /no node/);
  assert.throws(() => net.link('a', 'a'), /itself/);
  assert.equal(net.linked('a', 'p'), false);
  assert.equal(puppet.send('a', gossip('kv', [alice.kv('x', 1)])), false, 'no link, no send');
  assert.equal(net.counters().refused, 1);

  net.link('a', 'p');
  net.link('a', 'p');
  assert.equal(net.linked('a', 'p') && net.linked('p', 'a'), true);
  assert.deepEqual(net.nodes().map(node => node.id), ['a'], 'a puppet is not an engine node');
  assert.equal(net.run(), 1);
  // The engine's link-up digest reached the puppet through the real codec.
  assert.equal(puppet.inbox.length, 1);
  assert.equal(puppet.inbox[0].from, 'a');
  assert.equal(puppet.inbox[0].packet.type, PacketType.SYNC_DIGEST);
  assert.equal(puppet.inbox[0].packet.flags, 0);
  assert.deepEqual(puppet.take(PacketType.GOSSIP), []);
  assert.equal(puppet.take(PacketType.SYNC_DIGEST).length, 1);
  assert.deepEqual(puppet.inbox, []);

  // Back-pressure: the fourth packet does not fit the queue.
  const records = Array.from({ length: 5 }, (_, i) => alice.kv(`k${i}`, 1));
  const results = records.map(record => puppet.send('a', gossip('kv', [record])));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(net.linkCounters('p', 'a').sent, 3);

  // A cut discards what is queued and tells the engine; packets in flight never arrive.
  net.cut('a', 'p');
  net.cut('a', 'p');
  assert.equal(net.counters().cut, 3);
  assert.equal(a.engine.stats().peers, 0);
  assert.equal(net.run(), 0);
  assert.equal(a.sets.kv.size, 0);
  assert.throws(() => net.linkCounters('p', 'a'), /no link/);

  // Loss applies only to matching packets and is counted.
  net.link('a', 'p');
  net.run();
  puppet.take();
  net.resetCounters();
  net.setLoss(1, event => event.from === 'p');
  assert.equal(puppet.send('a', gossip('kv', [records[0]])), true, 'a lost packet still looks sent');
  net.setLoss(0);
  assert.equal(puppet.send('a', gossip('kv', [records[1]])), true);
  net.run();
  assert.deepEqual(a.sets.kv.values(), [records[1]]);
  const counters = net.counters();
  assert.deepEqual(counters.byType.GOSSIP, { sent: 2, delivered: 1, lost: 1, bytes: counters.byType.GOSSIP.bytes });
  assert.equal(counters.lost, 1);

  // A packet that breaks a wire limit fails at the point of sending.
  assert.throws(
    () => puppet.send('a', { type: PacketType.GOSSIP, header: { pad: 'x'.repeat(Limits.MAX_HEADER) }, body: Buffer.from('x') }),
    WireError,
  );
  assert.throws(() => puppet.send('a', { type: 250, header: {}, body: Buffer.from('x') }), WireError);
});

test('simnet: virtual time drives the batch timer and the sync interval', t => {
  const net = new SimNet({ seed: 2, datasets: () => [kvSet(), castSet()], latencyMs: 2, syncIntervalMs: 5_000 });
  t.after(() => net.close());
  const a = net.addNode('a', { engine: { gossipBatchMs: 30 } });
  net.addNode('b');
  net.link('a', 'b');
  net.run();
  const start = net.now();

  a.engine.publish('kv', alice.kv('x', 1));
  assert.equal(a.engine.stats().pending, 1);
  assert.equal(net.step(), true, 'idle network: jump to the batch timer');
  assert.equal(net.now(), start + 30);
  assert.equal(a.engine.stats().pending, 0);
  assert.equal(net.step(), true, 'deliver the gossip packet');
  assert.equal(net.now(), start + 32);
  assert.equal(net.step(), false, 'quiescent');
  assert.equal(net.node('b').sets.kv.size, 1);

  net.tick();
  assert.equal(net.now(), start + 32 + 5_000);
  assert.equal(a.engine.stats().activeRounds, 1);
  net.run();
  assert.equal(a.engine.stats().activeRounds, 0);
  assert.throws(() => {
    a.engine.publish('kv', alice.kv('y', 1));
    net.run({ maxSteps: 1 });
  }, /not quiescent/);

  // mulberry32 is a fixed function of its seed.
  const random = mulberry32(123);
  const values = [random(), random(), random()];
  assert.deepEqual(values, [mulberry32(123)(), values[1], values[2]]);
  assert.ok(values.every(v => v >= 0 && v < 1));
  assert.equal(new Set(values).size, 3);
  // A graph on n nodes is connected with n - 1 + extra edges, capped at the complete graph.
  assert.equal(randomConnectedGraph(['a', 'b', 'c'], 99, mulberry32(1)).length, 3);
  assert.deepEqual(randomConnectedGraph(['a'], 5, mulberry32(1)), []);
});

// ---------------------------------------------------------------------------------------
// DESIGN.md section 15
// ---------------------------------------------------------------------------------------

test('15.20: a round between converged nodes exchanges one summary per dataset and nothing else', t => {
  // Rounds may follow each other at once here, to look at one round in isolation.
  const net = new SimNet({ seed: 61, datasets: () => [kvSet(), castSet()], engine: { minRoundIntervalMs: 0 } });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');
  for (let i = 0; i < 50; i += 1) a.engine.publish('kv', alice.kv(`k${i}`, 1));
  for (let n = 1; n <= 20; n += 1) b.engine.publish('cast', bob.cast('news', n));
  net.link('a', 'b');
  net.run();
  assert.ok(net.agree('kv') && net.agree('cast'));

  net.resetCounters();
  const before = a.engine.stats();
  const packets = [];
  net.tap(({ packet }) => packets.push(packet));
  net.rounds(1);
  // Both nodes start a periodic round: two summaries each, two "same" answers each.
  assert.equal(packets.length, 8);
  for (const packet of packets) {
    assert.deepEqual(listOf(packet), [], `${typeName(packet.type)} carries an empty list`);
    if (packet.type === PacketType.SYNC_DIGEST) assert.match(packet.header.sum, /^[0-9a-f]{64}$/);
    else assert.equal(packet.header.stop, 'same');
  }
  const after = a.engine.stats();
  assert.equal(after.summariesSkipped - before.summariesSkipped, 2);
  assert.equal(after.summaryMatches - before.summaryMatches, 2);
  assert.equal(after.roundsCompleted - before.roundsCompleted, 1);

  // One difference in one dataset: only that dataset is paged.
  a.sets.kv.offer(alice.kv('quiet', 1)); // stored behind the engine: no gossip
  net.resetCounters();
  const digests = [];
  net.tap(({ from, packet }) => {
    if (from === 'a' && packet.type === PacketType.SYNC_DIGEST) digests.push(packet.header);
  });
  a.engine.tick();
  net.run();
  assert.deepEqual(
    digests.map(header => [header.set, header.sum === undefined ? 'page' : 'summary']),
    [['kv', 'summary'], ['kv', 'page'], ['cast', 'summary']],
  );
  assert.ok(net.agree('kv'));
  assert.deepEqual([...a.faults, ...b.faults], []);
});

test('15.20: a summary answer must be a plain "go on" or "same"; "same" only answers a summary', () => {
  const h = harness();
  h.engine.addPeer('p1');
  const [summary] = h.take('p1');
  const round = summary.header.round;
  h.engine.handlePacket('p1', request('kv', round, [], { next: 'k' }));
  assert.deepEqual(h.faults.map(f => f.reason), ['bad-header']);
  h.faults.length = 0;

  h.engine.addPeer('p2');
  const [other] = h.take('p2');
  h.engine.handlePacket('p2', request('kv', other.header.round, ['k']));
  assert.deepEqual(h.faults.map(f => f.reason), ['bad-header']);
  h.faults.length = 0;

  h.engine.addPeer('p3');
  const page = nextPage(h, 'p3');
  assert.equal(page.header.sum, undefined);
  h.engine.handlePacket('p3', request('kv', page.header.round, [], { stop: 'same' }));
  assert.deepEqual(h.faults.map(f => f.reason), ['bad-header']);
  assert.equal(h.engine.stats().activeRounds, 0);
});

test('15.19: a peer introduces at most newKeysPerMinute unknown keys, refused before any signature check', () => {
  let checks = 0;
  const kv = kvSet({
    check: record => {
      checks += 1;
      return verifyRecord(record, 'kv');
    },
  });
  const h = harness({ kv, newKeysPerMinute: 3 });
  h.engine.addPeer('p1');
  h.engine.addPeer('p2');
  h.take();

  const fresh = Array.from({ length: 5 }, (_, i) => alice.kv(`n${i}`, 1));
  h.engine.handlePacket('p1', gossip('kv', fresh));
  assert.equal(h.kv.size, 3);
  assert.equal(checks, 3, 'records over budget cost no verification');
  assert.equal(h.engine.stats().overBudget, 2);
  assert.deepEqual(h.faults, [], 'an honest relay of a burst is not a violation');

  // Updates of known keys are not charged; another peer has a budget of its own.
  h.engine.handlePacket('p1', gossip('kv', [alice.kv('n0', 2), alice.kv('n1', 2)]));
  assert.equal(h.engine.stats().overBudget, 2);
  h.engine.handlePacket('p2', gossip('kv', [fresh[3]]));
  assert.equal(h.kv.size, 4);

  // The budget refills continuously: 20 s is a third of a minute, one key.
  h.state.now += 20_000;
  h.engine.handlePacket('p1', gossip('kv', [fresh[4], alice.kv('n9', 1)]));
  assert.equal(h.kv.size, 5);
  assert.equal(h.engine.stats().overBudget, 3);
  // A clock that steps back refills nothing.
  h.state.now -= 60_000;
  h.engine.handlePacket('p1', gossip('kv', [alice.kv('n9', 1)]));
  assert.equal(h.engine.stats().overBudget, 4);
});

test('15.19: records of refused origins are dropped before any signature check, without a fault', () => {
  let checks = 0;
  const kv = kvSet({
    check: record => {
      checks += 1;
      return verifyRecord(record, 'kv');
    },
  });
  const blocked = new Set([bob.origin]);
  const h = harness({ kv, allowOrigin: origin => !blocked.has(origin) });
  for (const peer of ['p1', 'p2']) {
    h.engine.addPeer(peer);
    finishRound(h, peer);
  }
  h.engine.handlePacket('p1', gossip('kv', [bob.kv('x', 1), alice.kv('y', 1), bob.cast('c', 1)]));
  assert.equal(h.kv.size, 1);
  assert.equal(checks, 1);
  assert.equal(h.engine.stats().refusedOrigin, 2);
  assert.deepEqual(h.faults, []);
  h.engine.flush();
  for (const packet of h.take('p2')) {
    assert.ok(recordsOf(packet).every(record => record.origin !== bob.origin), 'never forwarded');
  }
  // A policy that throws refuses; records without a string origin are left to the dataset.
  const strict = harness({
    allowOrigin: () => {
      throw new Error('policy store down');
    },
  });
  strict.engine.addPeer('p1');
  strict.take();
  strict.engine.handlePacket('p1', gossip('kv', [alice.kv('z', 1)]));
  assert.equal(strict.kv.size, 0);
  strict.engine.handlePacket('p1', gossip('kv', [{ type: 'kv', name: 'no-origin', seq: 1 }]));
  assert.deepEqual(strict.faults.map(f => f.detail), ['kv: unsigned'], 'it reached the dataset');
});

test('15.17: a hold-down floods at most one record per key per interval and never loses the newest', () => {
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const h = harness({ schedule, gossipBatchMs: 10, holdDownMs: { kv: 5_000 } });
  for (const peer of ['p1', 'p2']) {
    h.engine.addPeer(peer);
    finishRound(h, peer);
  }
  const flushGossip = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled && timer.ms === 10) timer.fn();
    return h.take('p2').flatMap(recordsOf);
  };

  const v1 = alice.kv('lsa', 1);
  const v2 = alice.kv('lsa', 2);
  const v3 = alice.kv('lsa', 3);
  h.engine.handlePacket('p1', gossip('kv', [v1]));
  assert.deepEqual(flushGossip(), [v1], 'the first one goes out at once');

  // Two newer versions within the interval: both stored at once, neither flooded yet.
  h.state.now += 1_000;
  h.engine.handlePacket('p1', gossip('kv', [v2]));
  h.state.now += 1_000;
  h.engine.publish('kv', v3);
  assert.deepEqual(h.kv.get(kvKey(v3)), v3);
  assert.deepEqual(flushGossip(), []);
  assert.equal(h.engine.stats().held, 1);
  // Another key is not held back by this one.
  const other = alice.kv('other', 1);
  h.engine.handlePacket('p1', gossip('kv', [other]));
  assert.deepEqual(flushGossip(), [other]);

  // The interval ends: the newest goes out, once; the superseded one never does.
  h.state.now += 3_000;
  h.engine.tick();
  assert.deepEqual(h.take('p2').filter(p => p.type === PacketType.GOSSIP).length, 0);
  assert.deepEqual(flushGossip(), [v3]);
  assert.equal(h.engine.stats().held, 0);
  assert.equal(h.engine.stats().heldDown, 2);
  assert.equal(h.engine.stats().heldReleased, 1);

  // Quiet for a whole interval: the next record goes out at once again.
  h.state.now += 10_000;
  h.engine.tick();
  h.take();
  h.engine.handlePacket('p1', gossip('kv', [alice.kv('lsa', 4)]));
  assert.deepEqual(flushGossip().map(r => r.seq), [4]);
});

test('15.17: hold-down timers fire on their own and the simulator stays deterministic', t => {
  const run = () => {
    const net = new SimNet({
      seed: 99,
      datasets: () => [kvSet(), castSet()],
      engine: { holdDownMs: { kv: 5_000 } },
    });
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) net.addNode(id);
    for (let i = 1; i < ids.length; i += 1) net.link(ids[i - 1], ids[i]);
    net.run();
    const floods = [];
    net.tap(({ from, to, packet }) => {
      if (packet.type !== PacketType.GOSSIP) return;
      for (const record of recordsOf(packet)) floods.push({ link: `${from}>${to}`, seq: record.seq, at: net.now() });
    });
    // Ten versions in quick succession at one end of the chain.
    for (let seq = 1; seq <= 10; seq += 1) {
      net.node('a').engine.publish('kv', alice.kv('lsa', seq));
      net.step();
    }
    net.run();
    return { net, floods };
  };
  const first = run();
  t.after(() => first.net.close());
  for (const node of first.net.nodes()) assert.equal(node.sets.kv.get(kvKey(alice.kv('lsa', 1))).seq, 10);
  // Per link: increasing versions, at least one interval apart, ending with the newest.
  for (const link of ['a>b', 'b>c', 'c>d']) {
    const sent = first.floods.filter(f => f.link === link);
    assert.equal(sent.at(-1).seq, 10, link);
    for (let i = 1; i < sent.length; i += 1) {
      assert.ok(sent[i].seq > sent[i - 1].seq, link);
      assert.ok(sent[i].at - sent[i - 1].at >= 5_000, `${link}: floods ${sent[i].at - sent[i - 1].at} ms apart`);
    }
    assert.ok(sent.length < 10, `${link}: ${sent.length} floods for 10 versions`);
  }
  const second = run();
  t.after(() => second.net.close());
  assert.deepEqual(second.floods, first.floods);
});

test('15.14: two valid records with one version converge on the greater hash everywhere', t => {
  const net = new SimNet({ seed: 17, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const id of ids) net.addNode(id);
  for (let i = 1; i < ids.length; i += 1) net.link(ids[i - 1], ids[i]);
  net.run();

  // The same origin signs two different records with one version (a cloned identity),
  // published at both ends of the chain at once.
  const one = alice.kv('doc', 7, 'one');
  const two = alice.kv('doc', 7, 'two');
  const winner = recordHash(one) > recordHash(two) ? one : two;
  net.node('a').engine.publish('kv', one);
  net.node('e').engine.publish('kv', two);
  net.run();
  for (const node of net.nodes()) assert.deepEqual(node.sets.kv.get(kvKey(one)), winner, node.id);
  assert.ok(net.agree('kv'));
  assert.deepEqual(net.nodes().flatMap(node => node.faults), []);
});

// ---------------------------------------------------------------------------------------
// DESIGN.md 15.7: sync packets stay within Limits.MAX_SYNC_PACKET.
// ---------------------------------------------------------------------------------------

/** A kv record whose canonical form is exactly `size` bytes. */
function kvOfSize(author, name, seq, size) {
  const probe = canonicalBytes(author.kv(name, seq, '')).length;
  const record = author.kv(name, seq, 'x'.repeat(size - probe));
  assert.equal(canonicalBytes(record).length, size);
  return record;
}

test('a record of exactly the largest size travels in one packet within the limit', () => {
  const h = harness();
  h.engine.addPeer('p1');
  h.take();
  const edge = kvOfSize(alice, 'edge', 1, SyncWire.MAX_RECORD);
  assert.deepEqual(h.engine.publish('kv', edge), { accepted: true });
  h.engine.flush();
  const [packet] = h.take();
  assert.equal(packet.type, PacketType.GOSSIP);
  assert.deepEqual(recordsOf(packet), [edge]);
  // The batch header is 18 bytes here, well inside the 64 reserved for the longest.
  const wireSize = encodePacket(packet).length;
  assert.ok(wireSize <= Limits.MAX_SYNC_PACKET && wireSize > Limits.MAX_SYNC_PACKET - 64);
  assert.equal(h.engine.stats().oversize, 0);

  const over = kvOfSize(alice, 'over', 1, SyncWire.MAX_RECORD + 1);
  assert.deepEqual(h.engine.publish('kv', over), { accepted: false, reason: 'too-large' });
  assert.equal(h.kv.has(kvKey(over)), false);
});

test('a packet-size limit lower than the default drops what does not fit, and sends nothing larger', () => {
  const limit = 16 * 1024;
  const small = harness({ limits: { ...DEFAULT_SYNC_LIMITS, maxBytesPerPacket: limit } });
  small.engine.addPeer('p1');
  small.take();

  const fits = kvOfSize(alice, 'fits', 1, limit - 72);
  const tooBig = kvOfSize(alice, 'big', 1, limit - 71);
  assert.deepEqual(small.engine.publish('kv', tooBig), { accepted: false, reason: 'too-large' });
  assert.deepEqual(small.engine.publish('kv', fits), { accepted: true });
  small.engine.flush();
  const sentSize = encodePacket(small.take()[0]).length;
  assert.ok(sentSize <= limit && sentSize > limit - 72);

  // A peer with a larger packet size relays a record to us that we could not pass on:
  // not stored, not forwarded, not reported.
  const large = kvOfSize(bob, 'large', 1, limit);
  small.engine.addPeer('p2');
  small.take();
  small.engine.handlePacket('p1', gossip('kv', [large]));
  assert.equal(small.kv.has(kvKey(large)), false);
  assert.equal(small.engine.stats().tooLarge, 1);
  assert.deepEqual(small.faults, []);
  small.engine.flush();
  assert.deepEqual(small.take(), []);
});

test('no packet exceeds the limit while large records are gossiped and synchronised', t => {
  const net = new SimNet({ seed: 21, datasets: () => [kvSet(), castSet()] });
  t.after(() => net.close());
  const a = net.addNode('a');
  const b = net.addNode('b');
  const c = net.addNode('c');
  let largest = 0;
  let count = 0;
  net.tap(({ packet }) => {
    const size = encodePacket(packet).length;
    largest = Math.max(largest, size);
    count += 1;
    assert.ok(size <= Limits.MAX_SYNC_PACKET, `${typeName(packet.type)} is ${size} bytes`);
  });
  net.link('a', 'b');
  net.link('b', 'c');
  net.run();
  // Records of 20 to 60 KiB: one or two to a packet, and never more than fits.
  for (let i = 0; i < 12; i += 1) {
    const size = 20_000 + ((i * 3_700) % 40_000);
    assert.equal(a.engine.publish('kv', kvOfSize(alice, `big${i}`, 1, size)).accepted, true);
  }
  for (let i = 0; i < 40; i += 1) assert.equal(c.engine.publish('kv', alice.kv(`c${i}`, 1, 'y'.repeat(9_000))).accepted, true);
  net.run();
  net.rounds(3);
  assert.ok(net.agree('kv'));
  assert.equal(a.sets.kv.size, 52);
  assert.equal(b.sets.kv.size, 52);
  assert.ok(count > 0 && largest > 40_000, 'the scenario did send big packets');
  assert.equal(a.engine.stats().oversize + b.engine.stats().oversize + c.engine.stats().oversize, 0);
});

test('digest pages and request lists respect the limit even for heavily fragmented streams', () => {
  const limit = SyncWire.MIN_PACKET;
  const cast = castSet();
  // 60 streams with the longest allowed id, each holding 40 isolated indices: every
  // digest entry lists the maximum number of ranges.
  for (let s = 0; s < 60; s += 1) {
    const chan = `${String(s).padStart(3, '0')}${'"'.repeat(60)}`;
    for (let n = 1; n <= 80; n += 2) {
      const record = alice.cast(chan, n);
      assert.equal(cast.offer(record).accepted, true);
    }
  }
  const h = harness({ cast, limits: { ...DEFAULT_SYNC_LIMITS, maxBytesPerPacket: limit } });
  h.engine.addPeer('p1');
  // Walk the whole round against a peer that wants nothing and check every packet.
  let pages = 0;
  let out = h.take();
  for (;;) {
    for (const packet of out) assert.ok(encodePacket(packet).length <= limit);
    const sent = out.find(p => p.type === PacketType.SYNC_DIGEST);
    if (sent === undefined) break;
    const isSummary = sent.header.sum !== undefined;
    if (!isSummary && sent.header.set === 'cast') pages += 1;
    h.engine.handlePacket('p1', request(sent.header.set, sent.header.round, []));
    out = h.take();
  }
  assert.ok(pages > 1, 'the cast dataset needed several pages');
  assert.equal(h.engine.stats().oversize, 0);
  assert.deepEqual(h.faults, []);
});
