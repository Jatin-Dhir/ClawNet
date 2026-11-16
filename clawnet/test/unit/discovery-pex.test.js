import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Identity, verifyCard, verifyRecord } from '../../src/core/crypto/identity.js';
import { DialGovernor } from '../../src/core/discovery/dial-governor.js';
import { PEER_DATASET, PeerExchange } from '../../src/core/discovery/pex.js';
import { ConfigError, HandshakeError, StateError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { decodePacket, encodePacket } from '../../src/core/wire/codec.js';
import { validatePeerRecord } from '../../src/core/wire/schema.js';
import { Limits } from '../../src/core/wire/types.js';
import { SyncEngine } from '../../src/sync/antientropy.js';
import { recordHash } from '../../src/sync/datasets.js';
import { JsonFile } from '../../src/vault/store.js';
import { tempDir } from '../helpers/tmp.js';

const NOW = 1_700_000_000_000;
const CAPS = { relay: true, mailbox: false, transit: true };
const settle = () => new Promise(resolve => setImmediate(resolve));
const memoryDoc = data => ({
  data,
  update(mutator) {
    mutator(this.data);
  },
  async flush() {},
});

/** A foreign node's peer record, signed by its identity. */
function recordFor(identity, { seq = 1, ts = NOW, addrs = [], caps = CAPS } = {}) {
  return identity.signRecord('peer', { seq, ts, addrs, caps, card: identity.card });
}

/** A PeerExchange with a controllable clock, dial and peer manager. */
function setup(options = {}) {
  const identity = options.identity ?? Identity.generate();
  const clock = { wall: NOW, mono: 5000 };
  const dials = [];
  const known = new Set();
  const events = new EventBus({ now: () => clock.wall });
  const own = { addrs: ['tcp://203.0.113.200:47470'] };
  const governor =
    options.governor ?? new DialGovernor({ monoNow: () => clock.mono, rng: () => 0.5, dialsPerSecond: 1000 });
  const state = options.state ?? memoryDoc({ lsaSeq: 0, peerSeq: 0 });
  const doc = options.doc ?? memoryDoc({ v: 1, records: [] });
  const behaviour = options.behaviour ?? (() => 'ok');
  const pex = new PeerExchange({
    identity,
    caps: CAPS,
    ownAddresses: () => own.addrs,
    isKnown: id => known.has(id),
    dial: (address, hint) => {
      dials.push({ address, hint });
      return behaviour(address) === 'fail'
        ? Promise.reject(new HandshakeError('timeout', 'no answer'))
        : Promise.resolve({ id: hint.id });
    },
    governor,
    maxClockSkewMs: 300_000,
    doc,
    state,
    events,
    now: () => clock.wall,
    monoNow: () => clock.mono,
    rng: () => 0,
    ...options.pex,
  });
  return { pex, identity, clock, dials, known, events, own, governor, state, doc };
}

/** Attach a publisher that stores into the node's own dataset, as the SyncEngine would. */
function attachLocal(node) {
  const published = [];
  node.pex.attach(record => {
    published.push(record);
    return node.pex.dataset.offer(record);
  });
  return published;
}

const eventsOf = (node, type) => node.events.recent({ types: [type] }).map(e => e.data);

// ---------------------------------------------------------------------------------------
// Our own record
// ---------------------------------------------------------------------------------------

test('our record is a valid signed peer record with our addresses, caps and card', () => {
  const node = setup();
  const published = attachLocal(node);
  assert.equal(node.pex.refresh(), true);
  assert.equal(published.length, 1);
  const [record] = published;
  assert.deepEqual(Object.keys(record).sort(), ['addrs', 'caps', 'card', 'origin', 'seq', 'sig', 'ts', 'type']);
  assert.equal(record.type, 'peer');
  assert.equal(record.origin, node.identity.nodeId);
  assert.deepEqual(record.addrs, ['tcp://203.0.113.200:47470']);
  assert.deepEqual(record.caps, CAPS);
  assert.deepEqual(record.card, node.identity.card);
  assert.equal(record.ts, NOW);
  assert.equal(validatePeerRecord(record).ok, true);
  assert.equal(verifyRecord(record, 'peer').ok, true);
  assert.equal(verifyCard(record.card).ok, true);
  assert.equal(PEER_DATASET, 'peer');
  assert.equal(node.pex.dataset.name, 'peer');
  assert.deepEqual(node.pex.recordOf(node.identity.nodeId), record);
  assert.deepEqual(node.pex.cardOf(node.identity.nodeId), node.identity.card);
});

test('seq is the larger of the stored sequence plus one and the clock, and it is persisted', () => {
  const node = setup({ state: memoryDoc({ lsaSeq: 0, peerSeq: NOW + 5000 }) });
  const published = attachLocal(node);
  node.pex.refresh();
  assert.equal(published[0].seq, NOW + 5001, 'the stored sequence is ahead of the clock');
  assert.equal(node.state.data.peerSeq, NOW + 5001);

  node.clock.wall = NOW + 60_000;
  node.own.addrs = ['tcp://203.0.113.201:47470'];
  assert.equal(node.pex.refresh(), true);
  assert.equal(published[1].seq, NOW + 60_000, 'the clock is ahead');
  assert.equal(node.state.data.peerSeq, NOW + 60_000);

  // Two changes within one millisecond still get increasing numbers.
  node.own.addrs = ['tcp://203.0.113.202:47470'];
  node.pex.refresh();
  assert.equal(published[2].seq, NOW + 60_001);
});

test('refresh publishes only when the announced addresses or capabilities changed', () => {
  const node = setup();
  const published = attachLocal(node);
  assert.equal(node.pex.refresh(), true);
  assert.equal(node.pex.refresh(), false, 'nothing changed');
  assert.equal(node.pex.refresh(), false);
  assert.equal(published.length, 1);
  node.own.addrs = [...node.own.addrs, 'tcp://198.51.100.7:47470'];
  assert.equal(node.pex.refresh(), true);
  assert.equal(published.length, 2);
  assert.ok(published[1].seq > published[0].seq);
  node.own.addrs = [];
  assert.equal(node.pex.refresh(), true, 'an empty address list is announced too: the card is what matters');
  assert.deepEqual(published[2].addrs, []);
  assert.equal(node.pex.stats().published, 3);
});

test('announced addresses are valid, distinct and at most 16', () => {
  const node = setup();
  const published = attachLocal(node);
  const valid = Array.from({ length: 20 }, (_, k) => `tcp://203.0.113.${k + 1}:47470`);
  node.own.addrs = ['http://203.0.113.1:1', '', 5, null, valid[0], valid[0], ...valid];
  node.pex.refresh();
  assert.deepEqual(published[0].addrs, valid.slice(0, Limits.MAX_PEER_ADDRS));
  // A failing ownAddresses is an empty list, not a crash.
  node.own.addrs = 'nope';
  node.pex.refresh();
  assert.deepEqual(published[1].addrs, []);
});

test('refresh does nothing before attach, and attach is once only', () => {
  const node = setup();
  assert.equal(node.pex.refresh(), false);
  assert.throws(() => node.pex.attach('nope'), ConfigError);
  node.pex.attach(() => ({ accepted: true }));
  assert.throws(() => node.pex.attach(() => ({ accepted: true })), StateError);
});

test('a refused publish is reported and retried at the next refresh', () => {
  const node = setup();
  let accept = false;
  node.pex.attach(record => (accept ? node.pex.dataset.offer(record) : { accepted: false, reason: 'full' }));
  assert.equal(node.pex.refresh(), false);
  assert.equal(node.pex.stats().publishRefused, 1);
  assert.equal(node.pex.recordOf(node.identity.nodeId), null);
  accept = true;
  assert.equal(node.pex.refresh(), true, 'nothing was published yet, so it publishes now');
  assert.ok(node.pex.recordOf(node.identity.nodeId));
});

test('our own record is pinned: eviction never removes it', () => {
  const node = setup({ pex: { maxOrigins: 3 } });
  attachLocal(node);
  node.pex.refresh();
  for (let k = 0; k < 6; k += 1) {
    const other = Identity.generate();
    assert.equal(node.pex.dataset.offer(recordFor(other, { seq: NOW + k })).accepted, true);
  }
  assert.equal(node.pex.dataset.size, 3);
  assert.ok(node.pex.recordOf(node.identity.nodeId));
});

// ---------------------------------------------------------------------------------------
// The check function: hard and soft failures
// ---------------------------------------------------------------------------------------

test('a valid record is accepted, announced as an event and its addresses are kept', async () => {
  const node = setup();
  const peer = Identity.generate();
  const record = recordFor(peer, { seq: 7, addrs: ['tcp://203.0.113.50:47470'], caps: { relay: false, mailbox: true, transit: true } });
  assert.deepEqual(node.pex.dataset.offer(record, 'relay-peer'), { accepted: true, isNew: true });
  assert.deepEqual(eventsOf(node, 'peer.record'), [
    {
      peer: peer.nodeId,
      seq: 7,
      addrs: ['tcp://203.0.113.50:47470'],
      caps: { relay: false, mailbox: true, transit: true },
    },
  ]);
  assert.deepEqual(node.pex.recordOf(peer.nodeId), record);
  assert.deepEqual(node.pex.cardOf(peer.nodeId), peer.card, 'the card directory');
  assert.equal(node.pex.recordOf('x'), null);
  assert.equal(node.pex.cardOf('x'), null);

  // A newer record replaces it; an older one does not.
  const newer = recordFor(peer, { seq: 8, addrs: ['tcp://203.0.113.51:47470'] });
  assert.deepEqual(node.pex.dataset.offer(newer), { accepted: true, isNew: false });
  assert.equal(node.pex.dataset.offer(record).accepted, false);
  assert.equal(node.pex.dataset.offer(record).reason, 'stale');
  assert.deepEqual(node.pex.recordOf(peer.nodeId), newer);
  assert.equal(eventsOf(node, 'peer.record').length, 2);
  await settle();
});

test('records that fail the schema, the signature or the card are hard failures', () => {
  const node = setup();
  const peer = Identity.generate();
  const mallory = Identity.generate();
  const good = recordFor(peer, { seq: 3, addrs: ['tcp://203.0.113.50:1'] });
  const hard = (record, reason) => {
    const result = node.pex.dataset.offer(record);
    assert.equal(result.accepted, false, reason);
    assert.equal(result.invalid, true, `${reason} is hard`);
    assert.equal(result.reason, reason);
  };
  // forged signature: addresses changed after signing
  hard({ ...good, addrs: ['tcp://203.0.113.66:1'] }, 'bad-signature');
  // signature of another key
  hard({ ...good, sig: recordFor(mallory, { seq: 3 }).sig }, 'bad-signature');
  // a card that belongs to another node
  hard({ ...good, card: mallory.card }, 'bad-shape');
  // a record whose own signature is valid but whose card does not verify
  const damaged = { ...peer.card, sig: Buffer.alloc(64, 4).toString('base64') };
  hard(peer.signRecord('peer', { seq: 3, ts: NOW, addrs: [], caps: CAPS, card: damaged }), 'bad-card');
  // shape
  hard({ ...good, addrs: ['tcp://203.0.113.50:0'] }, 'bad-shape');
  hard({ ...good, extra: 1 }, 'bad-shape');
  hard({ ...good, caps: { relay: true } }, 'bad-shape');
  hard({ ...good, type: 'beacon' }, 'bad-shape');
  hard(recordFor(peer, { seq: 3, addrs: Array.from({ length: 17 }, (_, k) => `tcp://203.0.113.${k + 1}:1`) }), 'bad-shape');
  hard({ ...good, seq: 1.5 }, 'bad-version');
  assert.equal(node.pex.dataset.size, 0);
});

test('a timestamp ahead of our clock is a soft failure: not stored, not blamed on the sender', () => {
  const node = setup();
  const peer = Identity.generate();
  const skew = 300_000;
  const edge = node.pex.dataset.offer(recordFor(peer, { seq: 1, ts: NOW + skew }));
  assert.equal(edge.accepted, true, 'exactly at the limit is fine');
  const future = node.pex.dataset.offer(recordFor(peer, { seq: 2, ts: NOW + skew + 1 }));
  assert.deepEqual(future, { accepted: false, reason: 'future' });
  assert.equal(future.invalid, undefined);
  assert.equal(node.pex.recordOf(peer.nodeId).seq, 1);
  // The same record is fine once our clock has caught up.
  node.clock.wall += 1;
  assert.equal(node.pex.dataset.offer(recordFor(peer, { seq: 2, ts: NOW + skew + 1 })).accepted, true);
});

test('origins refused by allowOrigin are neither stored nor dialed, softly', () => {
  const blocked = Identity.generate();
  const fine = Identity.generate();
  const node = setup({ pex: { allowOrigin: id => id !== blocked.nodeId } });
  const refused = node.pex.dataset.offer(recordFor(blocked, { addrs: ['tcp://203.0.113.9:1'] }));
  assert.deepEqual(refused, { accepted: false, reason: 'origin-refused' });
  assert.equal(node.pex.dataset.offer(recordFor(fine, { addrs: ['tcp://203.0.113.10:1'] })).accepted, true);
  assert.equal(node.pex.dataset.size, 1);

  const throwing = setup({
    pex: {
      allowOrigin: () => {
        throw new Error('policy bug');
      },
    },
  });
  assert.equal(throwing.pex.dataset.offer(recordFor(fine)).reason, 'origin-refused', 'fail closed');
});

test('two valid records of one version are reported as equivocation', () => {
  const node = setup();
  const peer = Identity.generate();
  const a = recordFor(peer, { seq: 4, addrs: ['tcp://203.0.113.1:1'] });
  const b = recordFor(peer, { seq: 4, addrs: ['tcp://203.0.113.2:1'] });
  node.pex.dataset.offer(a);
  node.pex.dataset.offer(b);
  assert.deepEqual(eventsOf(node, 'peer.equivocation'), [{ peer: peer.nodeId, seq: 4 }]);
  assert.equal(node.pex.stats().equivocations, 1);
});

// ---------------------------------------------------------------------------------------
// The self-originated rule and cloned identities
// ---------------------------------------------------------------------------------------

test('a network copy of our record with a higher seq makes us publish again, higher still', async () => {
  const node = setup();
  const published = attachLocal(node);
  node.pex.refresh();
  const mine = published[0];
  assert.equal(node.pex.stats().selfBumps, 0, 'our own publication is not mistaken for a foreign copy');

  // A record of our origin we do not know: we restarted and lost track, or a clone.
  const foreign = recordFor(node.identity, { seq: mine.seq + 10, addrs: ['tcp://198.51.100.99:47470'] });
  assert.equal(node.pex.dataset.offer(foreign, 'some-peer').accepted, true);
  await settle();

  assert.equal(published.length, 2);
  assert.equal(published[1].seq, mine.seq + 11);
  assert.deepEqual(published[1].addrs, ['tcp://203.0.113.200:47470'], 'with our own addresses, not the foreign ones');
  assert.deepEqual(node.pex.recordOf(node.identity.nodeId), published[1]);
  assert.equal(node.state.data.peerSeq, mine.seq + 11);
  assert.equal(node.pex.stats().selfBumps, 1);
  // Stable afterwards: nothing more is published.
  await settle();
  assert.equal(published.length, 2);
});

test('an equal seq with a greater hash is also answered by jumping past it', async () => {
  // A fixed identity makes our own record, and so the hash the rival has to beat, the same
  // on every run. The rival is then found by varying the port, which stays a valid address
  // for all 65535 candidates, and the search fails loudly instead of quietly looping.
  const identity = Identity.fromSecret({
    signSeed: Buffer.alloc(32, 7),
    linkPrivate: Buffer.alloc(32, 8),
    e2ePrivate: Buffer.alloc(32, 9),
  });
  const node = setup({ identity });
  const published = attachLocal(node);
  node.pex.refresh();
  const mine = published[0];
  let rival = null;
  for (let port = 1; rival === null && port <= 65535; port += 1) {
    const candidate = recordFor(node.identity, { seq: mine.seq, addrs: [`tcp://198.51.100.1:${port}`] });
    if (recordHash(candidate) > recordHash(mine)) rival = candidate;
  }
  assert.notEqual(rival, null, 'a record with a greater hash exists among the candidates');
  assert.equal(rival.seq, mine.seq, 'the tie is on seq alone');
  assert.equal(node.pex.dataset.offer(rival, 'some-peer').accepted, true, 'the greater hash wins the tie');
  await settle();
  assert.equal(published.length, 2);
  assert.equal(published[1].seq, mine.seq + 1);
});

test('a persistent second node with our identity is reported as a suspected clone', async () => {
  const node = setup();
  attachLocal(node);
  node.pex.refresh();
  const bump = async () => {
    const top = node.pex.recordOf(node.identity.nodeId).seq;
    node.pex.dataset.offer(recordFor(node.identity, { seq: top + 5, addrs: ['tcp://198.51.100.1:1'] }));
    await settle();
  };
  await bump();
  await bump();
  assert.deepEqual(eventsOf(node, 'discovery.clone_suspected'), []);
  await bump();
  const reports = eventsOf(node, 'discovery.clone_suspected');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].peer, node.identity.nodeId);
  assert.equal(reports[0].bumps, 3);
  // Reported once per window.
  await bump();
  assert.equal(eventsOf(node, 'discovery.clone_suspected').length, 1);
  // After the window the count starts again.
  node.clock.mono += 11 * 60_000;
  await bump();
  await bump();
  assert.equal(eventsOf(node, 'discovery.clone_suspected').length, 1);
  await bump();
  assert.equal(eventsOf(node, 'discovery.clone_suspected').length, 2);
});

// ---------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------

test('records and the sequence number survive a restart, and are verified when loaded', async t => {
  const dir = await tempDir(t, 'pex');
  const docPath = join(dir, 'peer-records.json');
  const statePath = join(dir, 'state.json');
  const openFiles = async () => {
    const doc = new JsonFile(docPath, { defaults: { v: 1, records: [] } });
    const state = new JsonFile(statePath, { defaults: { lsaSeq: 0, peerSeq: 0 } });
    await doc.load();
    await state.load();
    return { doc, state };
  };

  const identity = Identity.generate();
  const peers = [Identity.generate(), Identity.generate(), Identity.generate()];
  const first = setup({ identity, ...(await openFiles()) });
  first.clock.wall = NOW + 1_000_000;
  const published = attachLocal(first);
  first.pex.refresh();
  for (const [k, peer] of peers.entries()) {
    first.pex.dataset.offer(recordFor(peer, { seq: k + 1, addrs: [`tcp://203.0.113.${k + 1}:47470`] }));
  }
  await first.pex.flush();
  const onDisk = JSON.parse(await readFile(docPath, 'utf8'));
  assert.equal(onDisk.v, 1);
  assert.equal(onDisk.records.length, 3, 'our own record is not in the file');
  assert.equal(onDisk.records.some(r => r.origin === identity.nodeId), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).peerSeq, published[0].seq);

  // Restart, with a clock that is behind: the sequence still goes up.
  const second = setup({ identity, ...(await openFiles()) });
  assert.equal(await second.pex.load(), 3);
  assert.equal(second.pex.stats().loadRejected, 0);
  for (const peer of peers) assert.ok(second.pex.recordOf(peer.nodeId), 'record loaded');
  assert.equal(eventsOf(second, 'peer.record').length, 0, 'loading is quiet');
  const again = attachLocal(second);
  second.pex.refresh();
  assert.equal(again[0].seq, published[0].seq + 1);

  // A file that was tampered with: one record altered, plus garbage entries.
  const edited = JSON.parse(await readFile(docPath, 'utf8'));
  edited.records[1] = { ...edited.records[1], addrs: ['tcp://203.0.113.99:1'] };
  edited.records.push(null, 'text', {}, 7);
  await writeFile(docPath, JSON.stringify(edited));
  const third = setup({ identity, ...(await openFiles()) });
  assert.equal(await third.pex.load(), 2);
  assert.equal(third.pex.stats().loadRejected, 5);
  assert.equal(third.pex.dataset.size, 2);
});

test('a persisted record of our own origin is taken as a foreign copy, so the sequence goes past it', async () => {
  const identity = Identity.generate();
  const stale = recordFor(identity, { seq: NOW + 500_000, addrs: [] });
  const node = setup({ identity, doc: memoryDoc({ v: 1, records: [stale] }), state: memoryDoc({ lsaSeq: 0, peerSeq: 0 }) });
  assert.equal(await node.pex.load(), 1);
  const published = attachLocal(node);
  assert.equal(node.pex.refresh(), true);
  assert.equal(published[0].seq, stale.seq + 1);
  await settle();
  assert.equal(published.length, 1, 'no second publication');
});

test('load tolerates a missing or malformed document and is bounded by maxOrigins', async () => {
  const peers = Array.from({ length: 6 }, () => Identity.generate());
  for (const data of [undefined, null, { v: 1 }, { v: 1, records: 'no' }, { v: 1, records: {} }]) {
    const node = setup({ doc: memoryDoc(data) });
    assert.equal(await node.pex.load(), 0);
  }
  const node = setup({
    doc: memoryDoc({ v: 1, records: peers.map((p, k) => recordFor(p, { seq: k + 1 })) }),
    pex: { maxOrigins: 4 },
  });
  assert.equal(await node.pex.load(), 4, 'no more than maxOrigins records are even looked at');
  assert.equal(node.pex.dataset.size, 4);
  // Our own record still finds room afterwards, at the expense of another.
  attachLocal(node);
  assert.equal(node.pex.refresh(), true);
  assert.equal(node.pex.dataset.size, 4);
  assert.ok(node.pex.recordOf(node.identity.nodeId));
  const bare = setup({ pex: { doc: undefined }, doc: null });
  assert.equal(await bare.pex.load(), 0);
  await bare.pex.flush();
});

// ---------------------------------------------------------------------------------------
// The card directory
// ---------------------------------------------------------------------------------------

test('noteCard keeps verified cards, ignores forged ones and our own, and is bounded', () => {
  const node = setup({ pex: { maxOrigins: 3 } });
  const peers = [Identity.generate(), Identity.generate(), Identity.generate(), Identity.generate()];
  assert.equal(node.pex.noteCard(peers[0].card), true);
  assert.deepEqual(node.pex.cardOf(peers[0].nodeId), peers[0].card);
  assert.equal(node.pex.noteCard({ ...peers[1].card, sig: peers[0].card.sig }), false, 'forged');
  assert.equal(node.pex.noteCard(null), false);
  assert.equal(node.pex.noteCard({}), false);
  assert.equal(node.pex.noteCard(node.identity.card), false, 'our own card');
  assert.equal(node.pex.cardOf(peers[1].nodeId), null);
  assert.equal(node.pex.stats().cardsRejected, 4);

  node.pex.noteCard(peers[1].card);
  node.pex.noteCard(peers[2].card);
  node.pex.noteCard(peers[0].card); // refreshed: now the most recent
  node.pex.noteCard(peers[3].card);
  assert.equal(node.pex.stats().cards, 3);
  assert.equal(node.pex.cardOf(peers[1].nodeId), null, 'the least recently noted card was dropped');
  assert.deepEqual(node.pex.cardOf(peers[0].nodeId), peers[0].card);
});

test('cardOf prefers a card noted from a handshake and falls back to the record', () => {
  const node = setup();
  const peer = Identity.generate();
  node.pex.noteCard(peer.card);
  node.pex.dataset.offer(recordFor(peer));
  assert.deepEqual(node.pex.cardOf(peer.nodeId), peer.card);
  const other = Identity.generate();
  node.pex.dataset.offer(recordFor(other));
  assert.deepEqual(node.pex.cardOf(other.nodeId), other.card, 'from the record alone');
});

// ---------------------------------------------------------------------------------------
// Choosing dial candidates
// ---------------------------------------------------------------------------------------

/** Offer one record per node, each announcing `tcp://203.0.113.<base + k>:47470`. */
function offerNodes(node, count, { base = 20, relay = () => true, addrs } = {}) {
  const peers = Array.from({ length: count }, () => Identity.generate());
  peers.forEach((peer, k) => {
    const list = addrs?.(k) ?? [`tcp://203.0.113.${base + k}:47470`];
    node.pex.dataset.offer(recordFor(peer, { addrs: list, caps: { relay: relay(k), mailbox: false, transit: true } }));
  });
  return peers;
}

test('maintain dials nodes from the records, naming who it expects, and prefers relays', async () => {
  const node = setup();
  const peers = offerNodes(node, 6, { relay: k => k % 2 === 0 });
  const relays = new Set(peers.filter((_, k) => k % 2 === 0).map(p => p.nodeId));
  assert.equal(node.pex.maintain(2), 2);
  assert.equal(node.dials.length, 2);
  for (const { address, hint } of node.dials) {
    assert.equal(hint.source, 'pex');
    assert.ok(relays.has(hint.id), 'relays first');
    assert.match(address, /^tcp:\/\/203\.0\.113\.\d+:47470$/);
  }
  await settle();
  assert.equal(node.pex.stats().dialsOk, 2);
  assert.equal(node.pex.maintain(0), 0);
  assert.equal(node.pex.maintain(-3), 0);
  assert.equal(node.pex.maintain(Number.NaN), 0);

  const wide = setup();
  offerNodes(wide, 5, { relay: k => k < 3 });
  assert.equal(wide.pex.maintain(10), 5, 'as many as there are');
  assert.equal(new Set(wide.dials.map(d => d.hint.id)).size, 5);
});

test('nodes the peer manager knows, our own origin and refused origins are not dialed', () => {
  const blocked = Identity.generate();
  const node = setup({ pex: { allowOrigin: id => id !== blocked.nodeId } });
  attachLocal(node);
  node.pex.refresh();
  const peers = offerNodes(node, 4);
  node.pex.dataset.offer(recordFor(blocked, { addrs: ['tcp://203.0.113.90:1'] }), 'x');
  node.known.add(peers[0].nodeId);
  node.known.add(peers[1].nodeId);
  assert.equal(node.pex.maintain(10), 2);
  assert.deepEqual(new Set(node.dials.map(d => d.hint.id)), new Set([peers[2].nodeId, peers[3].nodeId]));
});

test('an isKnown that throws means nobody is dialed', () => {
  const node = setup({
    pex: {
      isKnown: () => {
        throw new Error('peer manager is down');
      },
    },
  });
  offerNodes(node, 3);
  assert.equal(node.pex.maintain(3), 0);
});

test('the address policy: learned loopback, unspecified, multicast and link-local addresses are never dialed', () => {
  const node = setup();
  const refused = [
    'tcp://127.0.0.1:47470',
    'tcp://[::1]:47470',
    'tcp://0.0.0.0:47470',
    'tcp://224.0.0.1:47470',
    'tcp://169.254.7.7:47470',
    'tcp://[fe80::1]:47470',
    'tcp://localhost:47470',
    'tcp://[::ffff:127.0.0.1]:47470',
  ];
  offerNodes(node, refused.length, { addrs: k => [refused[k]] });
  assert.equal(node.pex.maintain(20), 0);
  assert.equal(node.dials.length, 0);
  assert.equal(node.pex.stats().refusedAddresses, refused.length);
});

test('with allowLoopback the same addresses are dialed', () => {
  const node = setup({ pex: { allowLoopback: true } });
  offerNodes(node, 2, { addrs: k => [k === 0 ? 'tcp://127.0.0.1:47470' : 'tcp://[::1]:47471'] });
  assert.equal(node.pex.maintain(5), 2);
  assert.deepEqual(new Set(node.dials.map(d => d.address)), new Set(['tcp://127.0.0.1:47470', 'tcp://[::1]:47471']));
});

test('a node with several addresses is dialed at the first one the policy and the budget allow', () => {
  const node = setup();
  const [peer] = offerNodes(node, 1, {
    addrs: () => ['tcp://127.0.0.1:1', 'tcp://203.0.113.60:47470', 'tcp://203.0.113.61:47470'],
  });
  // The second address is busy: another dial is already running to that IP.
  const busy = node.governor.attempt('tcp://203.0.113.60:9', { id: null, source: 'bootstrap' }, () => new Promise(() => {}));
  assert.equal(busy.started, true);
  assert.equal(node.pex.maintain(1), 1);
  assert.deepEqual(node.dials[0], { address: 'tcp://203.0.113.61:47470', hint: { id: peer.nodeId, source: 'pex' } });
});

test('many NodeIds that claim one address share one dial budget', async () => {
  const node = setup({ behaviour: () => 'fail' });
  offerNodes(node, 12, { addrs: () => ['tcp://203.0.113.77:47470'] });
  assert.equal(node.pex.maintain(12), 1, 'one attempt in flight per IP');
  assert.equal(node.dials.length, 1);
  assert.equal(node.pex.stats().dialsDenied, 11);
  await settle();
  // The failure backs the IP off for all twelve identities at once.
  assert.equal(node.pex.maintain(12), 0);
  assert.equal(node.dials.length, 1);
  node.clock.mono += 999;
  assert.equal(node.pex.maintain(12), 0);
  node.clock.mono += 1;
  assert.equal(node.pex.maintain(12), 1, 'after the backoff, one more try');
});

test('the global dial rate stops a pass', () => {
  const governor = new DialGovernor({ monoNow: () => 5000, rng: () => 0.5, dialsPerSecond: 2 });
  const node = setup({ governor });
  offerNodes(node, 10);
  assert.equal(node.pex.maintain(10), 2);
  assert.equal(node.pex.stats().dialsDenied, 1, 'it stopped at the first refusal for rate');
});

test('with pex disabled records are kept and relayed but nothing is dialed', () => {
  const node = setup({ pex: { pex: false } });
  const peers = offerNodes(node, 3);
  assert.equal(node.pex.maintain(5), 0);
  assert.equal(node.dials.length, 0);
  assert.equal(node.pex.dataset.size, 3);
  assert.deepEqual(node.pex.cardOf(peers[0].nodeId), peers[0].card);
});

test('each (address, node) pair is announced as a candidate once, however often it is chosen', async () => {
  const node = setup();
  const [peer] = offerNodes(node, 1);
  node.pex.maintain(1);
  await settle();
  node.pex.maintain(1);
  await settle();
  assert.equal(node.dials.length, 2);
  assert.deepEqual(eventsOf(node, 'discovery.candidate'), [
    { addr: 'tcp://203.0.113.20:47470', peer: peer.nodeId, source: 'pex' },
  ]);
});

test('maintain scans a bounded part of a large directory', () => {
  const node = setup({ pex: { maxOrigins: 5000 } });
  // 3000 records, none usable: the scan must still end.
  offerNodes(node, 3000, { addrs: () => ['tcp://127.0.0.1:1'] });
  const started = performance.now();
  assert.equal(node.pex.maintain(8), 0);
  assert.ok(node.pex.stats().candidatesConsidered <= 2048, 'at most MAX_SCAN records looked at');
  assert.ok(performance.now() - started < 2000);
});

// ---------------------------------------------------------------------------------------
// Through ClawSync: records spread, and are used
// ---------------------------------------------------------------------------------------

/** Nodes with real SyncEngines wired to each other through the real packet codec. */
function syncNetwork(count) {
  const queue = [];
  const nodes = [];
  const faults = [];
  for (let k = 0; k < count; k += 1) {
    const node = setup();
    node.own.addrs = [`tcp://203.0.113.${100 + k}:47470`];
    node.engine = new SyncEngine({
      datasets: [node.pex.dataset],
      send: (peer, packet) => {
        queue.push({ from: node.identity.nodeId, to: peer, packet: decodePacket(encodePacket(packet)) });
        return true;
      },
      monoNow: () => node.clock.mono,
      rng: () => 0,
      self: node.identity.nodeId,
      onError: (peer, reason, detail) => faults.push({ peer, reason, detail }),
    });
    node.pex.attach(record => node.engine.publish(PEER_DATASET, record));
    nodes.push(node);
  }
  const byId = new Map(nodes.map(node => [node.identity.nodeId, node]));
  return {
    nodes,
    faults,
    link(a, b) {
      a.engine.addPeer(b.identity.nodeId);
      b.engine.addPeer(a.identity.nodeId);
    },
    run() {
      for (let guard = 0; guard < 10_000; guard += 1) {
        for (const node of nodes) node.engine.flush();
        const message = queue.shift();
        if (message === undefined) {
          if (nodes.every(node => node.engine.stats().pending === 0)) return;
          continue;
        }
        byId.get(message.to).engine.handlePacket(message.from, message.packet);
      }
      throw new Error('the network did not settle');
    },
  };
}

test('peer records spread through ClawSync and the far node becomes a dial candidate', () => {
  const net = syncNetwork(3);
  const [a, b, c] = net.nodes;
  for (const node of net.nodes) assert.equal(node.pex.refresh(), true);
  net.link(a, b);
  net.link(b, c);
  net.run();

  assert.deepEqual(net.faults, []);
  for (const node of net.nodes) assert.equal(node.pex.dataset.size, 3, 'every node holds every record');
  // a never talked to c, yet it has c's record and card: it can seal to c and dial it.
  assert.deepEqual(a.pex.recordOf(c.identity.nodeId).addrs, ['tcp://203.0.113.102:47470']);
  assert.deepEqual(a.pex.cardOf(c.identity.nodeId), c.identity.card);

  a.known.add(b.identity.nodeId);
  assert.equal(a.pex.maintain(1), 1);
  assert.deepEqual(a.dials, [{ address: 'tcp://203.0.113.102:47470', hint: { id: c.identity.nodeId, source: 'pex' } }]);

  // A change of address spreads as a newer record.
  c.own.addrs = ['tcp://203.0.113.150:47470'];
  assert.equal(c.pex.refresh(), true);
  net.run();
  assert.deepEqual(a.pex.recordOf(c.identity.nodeId).addrs, ['tcp://203.0.113.150:47470']);
});

test('a node that joins later learns the records by anti-entropy and a forged record does not spread', () => {
  const net = syncNetwork(3);
  const [a, b, c] = net.nodes;
  a.pex.refresh();
  b.pex.refresh();
  net.link(a, b);
  net.run();
  // c joins b afterwards.
  c.pex.refresh();
  net.link(b, c);
  net.run();
  assert.equal(c.pex.dataset.size, 3);
  assert.equal(a.pex.dataset.size, 3);

  // b is handed a forged record by a hostile peer: it is refused and reported.
  const victim = Identity.generate();
  const forged = { ...recordFor(victim, { seq: 1, addrs: ['tcp://203.0.113.5:1'] }), addrs: ['tcp://203.0.113.6:1'] };
  b.engine.handlePacket(a.identity.nodeId, {
    type: 16,
    header: { n: 1, set: PEER_DATASET },
    body: (() => {
      const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(forged).sort(([x], [y]) => (x < y ? -1 : 1)))));
      const frame = Buffer.alloc(4 + bytes.length);
      frame.writeUInt32BE(bytes.length, 0);
      bytes.copy(frame, 4);
      return frame;
    })(),
  });
  assert.equal(net.faults.length, 1);
  assert.equal(net.faults[0].reason, 'invalid-record');
  assert.equal(b.pex.recordOf(victim.nodeId), null);
});

test('peer records fit comfortably in a sync packet, even with the most addresses', () => {
  const node = setup();
  const published = attachLocal(node);
  node.own.addrs = Array.from({ length: 16 }, (_, k) => `tcp://${'a'.repeat(60)}${k}.example.com:47470`);
  node.pex.refresh();
  assert.equal(published[0].addrs.length, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(published[0])) < Limits.MAX_SYNC_PACKET / 8);
});

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

test('constructor options are validated', () => {
  const node = setup();
  const base = {
    identity: node.identity,
    caps: CAPS,
    ownAddresses: () => [],
    isKnown: () => false,
    dial: () => Promise.resolve(),
    governor: new DialGovernor(),
    maxClockSkewMs: 1000,
  };
  assert.doesNotThrow(() => new PeerExchange(base));
  const bad = [
    { identity: null },
    { caps: { relay: true } },
    { caps: null },
    { ownAddresses: null },
    { isKnown: 'no' },
    { dial: undefined },
    { governor: undefined },
    { maxClockSkewMs: -1 },
    { maxClockSkewMs: 1.5 },
    { maxOrigins: 1 },
    { allowOrigin: 'yes' },
    { now: 5 },
  ];
  for (const override of bad) {
    assert.throws(() => new PeerExchange({ ...base, ...override }), ConfigError, JSON.stringify(Object.keys(override)));
  }
  assert.throws(() => new PeerExchange(), ConfigError);
});
