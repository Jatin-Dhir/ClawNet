/**
 * The web core's ClawSync (web/core/sync.js and web/core/lww.js) against the engine's
 * (src/sync/antientropy.js and src/sync/datasets.js): every packet crosses as bytes, encoded
 * by one implementation's codec and decoded by the other's, and both must end up holding
 * the same records, whichever side starts the rounds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SyncEngine as EngineSync } from '../../src/sync/antientropy.js';
import { LwwDataset as EngineLww } from '../../src/sync/datasets.js';
import * as engineCodec from '../../src/core/wire/codec.js';
import { PacketType } from '../../src/core/wire/types.js';
import * as webCodec from '../../web/core/codec.js';
import { LwwDataset as WebLww } from '../../web/core/lww.js';
import { SyncEngine as WebSync } from '../../web/core/sync.js';

const record = (origin, seq, extra = '') => ({ type: 'peer', origin, seq, note: `${origin}#${seq}${extra}` });

function datasetOptions(name, sink) {
  return {
    name,
    key: (r) => r.origin,
    version: (r) => r.seq,
    check: (r) => (typeof r.note === 'string' ? { ok: true } : { ok: false, reason: 'bad' }),
    maxEntries: 5000,
    onAccept: (r) => sink?.push(r),
  };
}

/** Two sync engines, A (engine) and B (web), joined by an asynchronous byte pipe. */
function pair({ aId = 'node-a', bId = 'node-b', setNames = ['lsa', 'peer'], bSets = setNames } = {}) {
  const errors = [];
  const inFlight = { count: 0 };
  const deliver = (fn) => {
    inFlight.count += 1;
    setImmediate(() => {
      inFlight.count -= 1;
      fn();
    });
  };
  const aSets = setNames.map((name) => new EngineLww(datasetOptions(name)));
  const bDatasets = bSets.map((name) => new WebLww(datasetOptions(name)));
  // Each side's send() refers to the other; the calls only happen once both exist.
  const now = () => performance.now();
  const a = new EngineSync({
    datasets: aSets,
    monoNow: now,
    self: aId,
    minRoundIntervalMs: 0,
    send: (peer, packet) => {
      const bytes = engineCodec.encodePacket(packet);
      deliver(() => b.handlePacket(aId, webCodec.decodePacket(new Uint8Array(bytes))));
      return true;
    },
    onError: (peer, reason, detail) => errors.push(['engine', reason, detail]),
  });
  const b = new WebSync({
    datasets: bDatasets,
    monoNow: now,
    self: bId,
    minRoundIntervalMs: 0,
    send: (peer, packet) => {
      const bytes = webCodec.encodePacket(packet);
      deliver(() => a.handlePacket(bId, engineCodec.decodePacket(Buffer.from(bytes))));
      return true;
    },
    onError: (peer, reason, detail) => errors.push(['web', reason, detail]),
  });
  const settle = async () => {
    for (let i = 0; i < 10000 && inFlight.count > 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inFlight.count, 0, 'the exchange stops');
  };
  return { a, b, aSets, bSets: bDatasets, errors, settle, aId, bId };
}

const digestOf = (dataset) => dataset.values().map((r) => [r.origin, r.seq, r.note]);

test('an empty web dataset learns everything from the engine, and the engine learns its records back', async () => {
  const { a, b, aSets, bSets, errors, settle, aId, bId } = pair();
  for (let i = 0; i < 700; i += 1) aSets[0].offer(record(`origin-${String(i).padStart(4, '0')}`, 1 + (i % 7)));
  for (let i = 0; i < 40; i += 1) aSets[1].offer(record(`peer-${i}`, 5));
  bSets[1].offer(record('peer-web-only', 9));
  bSets[1].offer(record('peer-3', 6)); // newer than the engine's
  bSets[1].offer(record('peer-4', 2)); // older than the engine's
  a.addPeer(bId);
  b.addPeer(aId);
  await settle();
  a.tick();
  await settle();
  b.tick();
  await settle();
  assert.deepEqual(errors, []);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(digestOf(bSets[i]), digestOf(aSets[i]), `dataset ${i}`);
    assert.equal(bSets[i].syncSummary(), aSets[i].syncSummary(), 'the same summary for the same contents');
  }
  assert.equal(aSets[1].get('peer-3').seq, 6);
  assert.equal(bSets[1].get('peer-4').seq, 5);
  assert.ok(aSets[1].has('peer-web-only'));
});

test('rounds started from the web side converge too, and repeated rounds cost only summaries', async () => {
  // The web side has the smaller id, so it starts the link-up round.
  const { a, b, aSets, bSets, errors, settle, aId, bId } = pair({ aId: 'zz-engine', bId: 'aa-web' });
  for (let i = 0; i < 300; i += 1) aSets[0].offer(record(`k${i}`, i + 1));
  for (let i = 0; i < 300; i += 1) bSets[0].offer(record(`k${i + 150}`, 1000 + i));
  b.addPeer(aId);
  a.addPeer(bId);
  await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(digestOf(bSets[0]), digestOf(aSets[0]));
  assert.equal(bSets[0].size, 450);
  const before = b.stats.digestsOut;
  b.tick();
  await settle();
  assert.equal(b.stats.digestsOut - before, 2, 'one summary per dataset when nothing differs');
  assert.ok(a.stats().summaryMatches >= 2, 'the engine found both summaries equal to its own');
});

test('gossip of a published record reaches the engine; the engine\'s gossip reaches the web side', async () => {
  const { a, b, aSets, bSets, errors, settle, aId, bId } = pair();
  a.addPeer(bId);
  b.addPeer(aId);
  await settle();
  assert.equal(b.publish('lsa', record('phone', 123)).accepted, true);
  b.flush();
  await settle();
  assert.equal(aSets[0].get('phone').seq, 123);
  assert.equal(a.publish('peer', record('computer', 7)).accepted, true);
  a.flush();
  await settle();
  assert.equal(bSets[1].get('computer').seq, 7);
  assert.deepEqual(errors, []);
});

test('a dataset the web side does not run is declined, not blamed', async () => {
  const { a, b, aSets, bSets, errors, settle, aId, bId } = pair({ setNames: ['lsa', 'peer', 'cast'], bSets: ['lsa', 'peer'] });
  aSets[2].offer(record('c1', 1));
  aSets[0].offer(record('l1', 1));
  a.addPeer(bId);
  b.addPeer(aId);
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(bSets[0].get('l1').seq, 1);
  assert.ok(b.stats.unknownSets >= 1);
  assert.ok(a.stats().roundsCompleted >= 1);
});

test('a malformed record from the engine side is reported as invalid-record', async () => {
  const { a, b, errors, settle, aId, bId } = pair();
  a.addPeer(bId);
  b.addPeer(aId);
  await settle();
  const body = engineCodec.encodePacket({ type: PacketType.GOSSIP, header: { n: 1, set: 'lsa' }, body: (() => {
    const json = Buffer.from(JSON.stringify({ origin: 'x', seq: 1 }));
    const out = Buffer.alloc(4 + json.length);
    out.writeUInt32BE(json.length, 0);
    json.copy(out, 4);
    return out;
  })() });
  b.handlePacket(aId, webCodec.decodePacket(new Uint8Array(body)));
  assert.deepEqual(errors.map((e) => e.slice(0, 2)), [['web', 'invalid-record']]);
  // Broken framing and headers are faults as well.
  b.handlePacket(aId, { type: PacketType.GOSSIP, header: { n: 2, set: 'lsa' }, body: new Uint8Array([0, 0, 0, 2, 123, 125]) });
  b.handlePacket(aId, { type: PacketType.SYNC_DIGEST, header: { round: 0, set: 'lsa', sum: 'x' }, body: new Uint8Array([91, 93]) });
  assert.deepEqual(errors.slice(1).map((e) => e[1]), ['bad-body', 'bad-header']);
});
