import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DIGEST_HASH_CHARS, Lsdb, LsaReject } from '../../src/core/routing/lsdb.js';
import { computeRoutes } from '../../src/core/routing/spf.js';
import { ConfigError, StateError, StoreError } from '../../src/core/errors.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';

/** SHA-256 of a record's canonical form, hex: what the total order compares. */
const hashOf = (record) => createHash('sha256').update(canonicalBytes(record)).digest('hex');

const MAX_AGE = 210;
const TOMBSTONE = 5000;
/** A skew allowance so large that no test sequence number is out of date or ahead. */
const FRESHNESS_OFF = Number.MAX_SAFE_INTEGER;

/** The fake signature scheme: a "signature" is valid if it names the origin and seq. */
const sigFor = (origin, seq) => `sig:${origin}:${seq}`;

/**
 * Build an LSA as a plain object. `links` is `{ peer: cost }`.
 * `ts` is deliberately nonsense: the database must never look at it.
 */
function lsa(origin, seq, links = {}, caps = {}, extra = {}) {
  return {
    type: 'lsa',
    origin,
    seq,
    ts: -12345,
    links: Object.entries(links).map(([peer, cost]) => ({ peer, cost })),
    caps,
    sig: sigFor(origin, seq),
    ...extra,
  };
}

/**
 * A database on a hand-driven clock with fake, call-counting validate and verify.
 * `calls.validate` / `calls.verify` are how the tests prove the order of checks.
 */
function setup(options = {}) {
  const clock = { t: 100_000 };
  const calls = { validate: 0, verify: 0 };
  const db = new Lsdb({
    selfId: 'self',
    validate: (candidate) => {
      calls.validate += 1;
      if (candidate === null || typeof candidate !== 'object') {
        return { ok: false, reason: 'not-object' };
      }
      if (candidate.type !== 'lsa') return { ok: false, reason: 'bad-type' };
      return { ok: true };
    },
    verify: (candidate) => {
      calls.verify += 1;
      return candidate.sig === sigFor(candidate.origin, candidate.seq);
    },
    monoNow: () => clock.t,
    // Most tests use small sequence numbers; freshness has tests of its own below.
    wallNow: () => 0,
    maxClockSkewMs: FRESHNESS_OFF,
    maxAgeMs: MAX_AGE,
    tombstoneMs: TOMBSTONE,
    ...options,
  });
  return { db, clock, calls };
}

/** digest() without the hashes, for tests about which sequence numbers are held. */
const seqsOf = (db) => db.digest().map(([origin, seq]) => [origin, seq]);

/** graph() as nested plain objects, for deepEqual. */
function plainGraph(db) {
  const out = {};
  for (const [id, neighbors] of db.graph()) out[id] = Object.fromEntries(neighbors);
  return out;
}

test('a valid new LSA is accepted, stored and reported as a change', () => {
  const { db, calls } = setup();
  const first = lsa('a', 10, { b: 3 }, { transit: true });
  assert.deepEqual(db.upsert(first), { accepted: true, changed: true });

  assert.equal(db.size, 1);
  assert.equal(db.has('a'), true);
  assert.equal(db.has('b'), false);
  // The very object is kept, so it can be gossiped on with its signature intact.
  assert.equal(db.get('a'), first);
  assert.equal(db.get('b'), undefined);
  assert.deepEqual(db.all(), [first]);
  assert.deepEqual(seqsOf(db), [['a', 10]]);
  assert.equal(db.highestSeq('a'), 10);
  assert.equal(db.highestSeq('never-seen'), 0);
  assert.deepEqual(calls, { validate: 1, verify: 1 });
});

test('a higher seq with the same links and caps is a pure refresh: accepted, not changed', () => {
  const { db } = setup();
  db.upsert(lsa('a', 10, { b: 3, c: 4 }, { transit: true, mailbox: false }));

  // Same content; link order and caps key order differ, which must not count.
  const refresh = lsa('a', 11, { c: 4, b: 3 }, { mailbox: false, transit: true });
  assert.deepEqual(db.upsert(refresh), { accepted: true, changed: false });
  assert.equal(db.get('a'), refresh);
  assert.deepEqual(seqsOf(db), [['a', 11]]);
});

test('changed is true when a cost, the set of links, or the caps differ', () => {
  const variants = [
    ['cost changed', lsa('a', 11, { b: 4, c: 4 }, { transit: true })],
    ['link removed', lsa('a', 11, { b: 3 }, { transit: true })],
    ['link added', lsa('a', 11, { b: 3, c: 4, d: 1 }, { transit: true })],
    ['link replaced', lsa('a', 11, { b: 3, d: 4 }, { transit: true })],
    ['cap flipped', lsa('a', 11, { b: 3, c: 4 }, { transit: false })],
    ['cap added', lsa('a', 11, { b: 3, c: 4 }, { transit: true, mailbox: true })],
    ['cap removed', lsa('a', 11, { b: 3, c: 4 }, {})],
    ['nested cap changed', lsa('a', 11, { b: 3, c: 4 }, { transit: true, x: { y: [1, 2] } })],
  ];
  for (const [name, next] of variants) {
    const { db } = setup();
    db.upsert(lsa('a', 10, { b: 3, c: 4 }, { transit: true }));
    assert.deepEqual(db.upsert(next), { accepted: true, changed: true }, name);
  }
});

test('an LSA without caps is treated as having none', () => {
  const { db } = setup();
  const bare = lsa('a', 10, { b: 1 });
  delete bare.caps;
  assert.deepEqual(db.upsert(bare), { accepted: true, changed: true });
  assert.deepEqual(db.caps('a'), {});
  assert.deepEqual(db.upsert(lsa('a', 11, { b: 1 }, {})), { accepted: true, changed: false });
});

test('seq must be strictly greater: replays are refused before any signature check', () => {
  const { db, calls } = setup();
  const current = lsa('a', 10, { b: 3 });
  db.upsert(current);
  assert.equal(calls.verify, 1);

  for (const seq of [9, 1]) {
    // A different, validly signed body: still refused, and without verifying it.
    const replay = lsa('a', seq, { z: 9 });
    assert.deepEqual(db.upsert(replay), { accepted: false, changed: false, reason: 'stale' });
  }
  // The very LSA again (a gossip duplicate) is recognised by its hash, also unverified.
  assert.deepEqual(db.upsert({ ...current }), { accepted: false, changed: false, reason: 'stale' });
  assert.equal(calls.verify, 1, 'stale LSAs must not cost a signature verification');
  assert.equal(calls.validate, 4);
  assert.equal(db.get('a'), current);
  assert.equal(db.highestSeq('a'), 10);
  assert.equal(LsaReject.STALE, 'stale');
});

test('an LSA that fails validate is refused with its reason, before any other check', () => {
  const { db, calls } = setup();
  assert.deepEqual(db.upsert({ ...lsa('a', 10), type: 'peer' }), {
    accepted: false,
    changed: false,
    reason: 'bad-type',
  });
  assert.deepEqual(db.upsert(null), { accepted: false, changed: false, reason: 'not-object' });
  assert.deepEqual(db.upsert('lsa'), { accepted: false, changed: false, reason: 'not-object' });
  assert.equal(calls.verify, 0);
  assert.equal(db.size, 0);
});

test('validate must return an object with ok === true; anything else refuses the LSA', () => {
  const verdicts = [undefined, null, true, 1, 'ok', {}, [], { ok: 1 }, { ok: 'true' }];
  verdicts.push({ ok: false });
  for (const verdict of verdicts) {
    const { db, calls } = setup({ validate: () => verdict });
    assert.deepEqual(
      db.upsert(lsa('a', 10)),
      { accepted: false, changed: false, reason: 'invalid' },
      JSON.stringify(verdict),
    );
    assert.equal(calls.verify, 0);
    assert.equal(db.size, 0);
  }
  // A reason that is not a usable string is replaced, not passed through.
  for (const reason of ['', 5, null, {}]) {
    const { db } = setup({ validate: () => ({ ok: false, reason }) });
    assert.equal(db.upsert(lsa('a', 10)).reason, 'invalid');
  }
});

test('a validate that throws refuses the LSA and hands back the exception', () => {
  const boom = new Error('schema exploded');
  const { db, calls } = setup({
    validate: () => {
      throw boom;
    },
  });
  assert.deepEqual(db.upsert(lsa('a', 10)), {
    accepted: false,
    changed: false,
    reason: 'invalid',
    cause: boom,
  });
  assert.equal(calls.verify, 0);
  assert.equal(db.size, 0);
});

test('a bad signature is refused and does not poison the highest seq', () => {
  const { db, calls } = setup();
  db.upsert(lsa('a', 10, { b: 1 }));

  // The attack: a forged LSA with a huge seq. If it counted as "seen", the real
  // origin could never advertise again.
  const forged = lsa('a', Number.MAX_SAFE_INTEGER, { evil: 1 }, {}, { sig: 'forged' });
  assert.deepEqual(db.upsert(forged), { accepted: false, changed: false, reason: 'bad-signature' });
  assert.equal(calls.verify, 2);
  assert.equal(db.highestSeq('a'), 10);
  assert.deepEqual(seqsOf(db), [['a', 10]]);

  assert.deepEqual(db.upsert(lsa('a', 11, { b: 1 })), { accepted: true, changed: false });

  // Same for an origin that is not known yet.
  const unknown = lsa('n', 500, {}, {}, { sig: 'forged' });
  assert.equal(db.upsert(unknown).reason, 'bad-signature');
  assert.equal(db.has('n'), false);
  assert.equal(db.highestSeq('n'), 0);
  assert.deepEqual(db.upsert(lsa('n', 1)), { accepted: true, changed: true });
});

test('verify must return exactly true; a throwing verify counts as a failed signature', () => {
  for (const answer of [false, undefined, null, 1, 'true', {}]) {
    const { db } = setup({ verify: () => answer });
    assert.deepEqual(
      db.upsert(lsa('a', 10)),
      { accepted: false, changed: false, reason: 'bad-signature' },
      String(answer),
    );
    assert.equal(db.size, 0);
  }
  const boom = new Error('bad base64');
  const { db } = setup({
    verify: () => {
      throw boom;
    },
  });
  assert.deepEqual(db.upsert(lsa('a', 10)), {
    accepted: false,
    changed: false,
    reason: 'bad-signature',
    cause: boom,
  });
  assert.equal(db.size, 0);
});

test('structurally broken LSAs are refused even if validate lets them through', () => {
  const link = (peer, cost) => ({ peer, cost });
  const tooMany = {};
  for (let i = 0; i < 257; i += 1) tooMany[`p${i}`] = 1;
  const cyclic = {};
  cyclic.self = cyclic;
  let deep = {};
  for (let i = 0; i < 40; i += 1) deep = { d: deep };

  const broken = [
    ['array instead of object', Object.assign([], { type: 'lsa' })],
    ['origin missing', { ...lsa('a', 10), origin: undefined }],
    ['origin empty', lsa('', 10)],
    ['origin not a string', { ...lsa('a', 10), origin: 7 }],
    ['seq zero', lsa('a', 0)],
    ['seq negative', lsa('a', -5)],
    ['seq float', lsa('a', 10.5)],
    ['seq string', lsa('a', '10')],
    ['seq unsafe', lsa('a', 2 ** 53)],
    ['seq NaN', lsa('a', NaN)],
    ['links missing', { ...lsa('a', 10), links: undefined }],
    ['links object', { ...lsa('a', 10), links: { b: 1 } }],
    ['links too many', lsa('a', 10, tooMany)],
    ['link null', { ...lsa('a', 10), links: [null] }],
    ['link string', { ...lsa('a', 10), links: ['b'] }],
    ['link peer missing', { ...lsa('a', 10), links: [{ cost: 1 }] }],
    ['link peer empty', { ...lsa('a', 10), links: [{ peer: '', cost: 1 }] }],
    ['link peer number', { ...lsa('a', 10), links: [{ peer: 5, cost: 1 }] }],
    ['link to itself', lsa('a', 10, { a: 1 })],
    ['duplicate peer', { ...lsa('a', 10), links: [link('b', 1), link('b', 2)] }],
    ['duplicate peer, same cost', { ...lsa('a', 10), links: [link('b', 1), link('b', 1)] }],
    ['cost zero', lsa('a', 10, { b: 0 })],
    ['cost negative', lsa('a', 10, { b: -1 })],
    ['cost float', lsa('a', 10, { b: 1.5 })],
    ['cost too large', lsa('a', 10, { b: 65536 })],
    ['cost string', lsa('a', 10, { b: '1' })],
    ['cost missing', { ...lsa('a', 10), links: [{ peer: 'b' }] }],
    ['caps null', lsa('a', 10, {}, null)],
    ['caps array', lsa('a', 10, {}, ['transit'])],
    ['caps string', lsa('a', 10, {}, 'transit')],
    ['caps with a float', lsa('a', 10, {}, { load: 0.5 })],
    ['caps with undefined', lsa('a', 10, {}, { transit: undefined })],
    ['caps cyclic', lsa('a', 10, {}, cyclic)],
    ['caps too deep', lsa('a', 10, {}, deep)],
  ];
  const { db, calls } = setup();
  for (const [name, candidate] of broken) {
    assert.deepEqual(
      db.upsert(candidate),
      { accepted: false, changed: false, reason: 'malformed' },
      name,
    );
  }
  assert.equal(calls.verify, 0, 'malformed LSAs must not reach the signature check');
  assert.equal(db.size, 0);

  // The limits themselves are inclusive.
  const atLimit = {};
  for (let i = 0; i < 256; i += 1) atLimit[`p${i}`] = 65535;
  assert.deepEqual(db.upsert(lsa('a', 10, atLimit)), { accepted: true, changed: true });
});

test('maxLinks is configurable', () => {
  const { db } = setup({ maxLinks: 2 });
  assert.equal(db.upsert(lsa('a', 1, { b: 1, c: 1, d: 1 })).reason, 'malformed');
  assert.equal(db.upsert(lsa('a', 1, { b: 1, c: 1 })).accepted, true);
});

test('setLocal installs our own LSA without verifying it', () => {
  const { db, calls } = setup();
  const own = lsa('self', 50, { a: 2 }, { transit: true }, { sig: 'never-checked' });
  assert.deepEqual(db.setLocal(own), { accepted: true, changed: true });
  assert.equal(calls.verify, 0);
  assert.equal(db.get('self'), own);
  assert.equal(db.highestSeq('self'), 50);
  assert.deepEqual(seqsOf(db), [['self', 50]]);

  assert.deepEqual(db.setLocal(lsa('self', 51, { a: 2 }, { transit: true })), {
    accepted: true,
    changed: false,
  });
  assert.deepEqual(db.setLocal(lsa('self', 52, { a: 9 }, { transit: true })), {
    accepted: true,
    changed: true,
  });
  assert.equal(calls.verify, 0);
});

test('setLocal rejects a foreign origin, a malformed LSA and a seq that does not advance', () => {
  const { db } = setup();
  db.setLocal(lsa('self', 50));

  assert.throws(() => db.setLocal(lsa('a', 60)), ConfigError);
  assert.throws(() => db.setLocal({ ...lsa('self', 60), type: 'peer' }), /bad-type/);
  assert.throws(() => db.setLocal({ ...lsa('self', 60), type: 'peer' }), ConfigError);
  assert.throws(() => db.setLocal(lsa('self', 60, { self: 1 })), ConfigError);
  assert.throws(() => db.setLocal(lsa('self', 0)), ConfigError);
  assert.throws(() => db.setLocal(null), ConfigError);

  for (const seq of [50, 49]) {
    assert.throws(
      () => db.setLocal(lsa('self', seq)),
      (err) => err instanceof StateError && err.code === 'ERR_STATE',
    );
  }
  assert.equal(db.highestSeq('self'), 50);
  assert.equal(db.has('a'), false);

  const cause = new Error('schema exploded');
  const throwing = setup({
    validate: () => {
      throw cause;
    },
  }).db;
  assert.throws(
    () => throwing.setLocal(lsa('self', 1)),
    (err) => err instanceof ConfigError && err.cause === cause,
  );
});

test('a network copy of our own LSA is never installed', () => {
  const { db, calls } = setup();
  const own = lsa('self', 50, { a: 2 });
  db.setLocal(own);

  // Older than what we advertise: an echo. No signature check, nothing to do.
  assert.deepEqual(db.upsert(lsa('self', 49, { x: 1 })), {
    accepted: false,
    changed: false,
    reason: 'own-origin',
  });
  // Our current LSA coming back (same seq, same signature): also an echo.
  const echo = { ...own };
  assert.deepEqual(db.upsert(echo), { accepted: false, changed: false, reason: 'own-origin' });
  assert.equal(calls.verify, 0);

  // Newer and genuinely ours, e.g. from before a restart: tell the caller its seq.
  assert.deepEqual(db.upsert(lsa('self', 70, { x: 1 })), {
    accepted: false,
    changed: false,
    reason: 'own-origin-newer',
    seq: 70,
  });
  assert.equal(calls.verify, 1);

  // Same seq but a different signature: a conflicting LSA of ours is out there.
  const conflicting = lsa('self', 50, { x: 1 });
  conflicting.sig = 'other';
  const { db: lenient } = setup({ verify: () => true });
  lenient.setLocal(own);
  assert.deepEqual(lenient.upsert(conflicting), {
    accepted: false,
    changed: false,
    reason: 'own-origin-newer',
    seq: 50,
  });

  // Whatever arrived, the database still holds exactly the LSA we installed.
  assert.equal(db.get('self'), own);
  assert.equal(db.highestSeq('self'), 50);
  assert.equal(db.size, 1);
  assert.equal(lenient.get('self'), own);

  // The caller reacts by moving past the reported seq.
  assert.deepEqual(db.setLocal(lsa('self', 71, { a: 2 })), { accepted: true, changed: false });
});

test('a forged "newer" copy of our own LSA cannot push our sequence number', () => {
  const { db, calls } = setup();
  db.setLocal(lsa('self', 50));
  const forged = lsa('self', Number.MAX_SAFE_INTEGER, {}, {}, { sig: 'forged' });
  assert.deepEqual(db.upsert(forged), { accepted: false, changed: false, reason: 'bad-signature' });
  assert.equal(calls.verify, 1);
  assert.equal(db.highestSeq('self'), 50);

  // A same-seq copy whose signature merely differs is verified too, not trusted.
  const sameSeq = lsa('self', 50, {}, {}, { sig: 'forged' });
  assert.equal(db.upsert(sameSeq).reason, 'bad-signature');
});

test('our own LSA from the network before setLocal is reported as newer once verified', () => {
  const { db } = setup();
  assert.deepEqual(db.upsert(lsa('self', 33, { a: 1 })), {
    accepted: false,
    changed: false,
    reason: 'own-origin-newer',
    seq: 33,
  });
  assert.equal(db.size, 0);
  assert.equal(db.has('self'), false);
  // Not installed, so it does not count as seen either; the caller decides the next seq.
  assert.equal(db.highestSeq('self'), 0);
  assert.equal(db.upsert({ ...lsa('self', 33), type: 'peer' }).reason, 'bad-type');
  assert.equal(db.upsert(lsa('self', 0)).reason, 'malformed');
});

test('LSAs expire maxAgeMs after local receipt, whatever their ts says', () => {
  const { db, clock } = setup();
  db.upsert(lsa('a', 10, {}, {}, { ts: Number.MAX_SAFE_INTEGER }));
  clock.t += 100;
  db.upsert(lsa('b', 10, {}, {}, { ts: 0 }));

  clock.t += MAX_AGE - 101; // a is 209 ms old
  assert.deepEqual(db.expire(), []);
  assert.equal(db.size, 2);

  clock.t += 1; // a is 210 ms old, b is 110
  assert.deepEqual(db.expire(), ['a']);
  assert.equal(db.has('a'), false);
  assert.equal(db.get('a'), undefined);
  assert.equal(db.caps('a'), undefined);
  assert.deepEqual(seqsOf(db), [['b', 10]]);

  clock.t += 100;
  assert.deepEqual(db.expire(), ['b']);
  assert.equal(db.size, 0);
  assert.deepEqual(db.expire(), []);
});

test('a refresh restarts the age, and our own LSA ages like any other', () => {
  const { db, clock } = setup();
  db.upsert(lsa('a', 10));
  db.setLocal(lsa('self', 10));
  clock.t += 200;
  db.upsert(lsa('a', 11)); // refreshed at +200
  clock.t += 10; // self is 210 ms old, a is 10
  assert.deepEqual(db.expire(), ['self']);
  clock.t += 199;
  assert.deepEqual(db.expire(), []);
  clock.t += 1;
  assert.deepEqual(db.expire(), ['a']);

  // A refused LSA does not refresh anything.
  const again = setup();
  again.db.upsert(lsa('a', 10));
  again.clock.t += 200;
  assert.equal(again.db.upsert(lsa('a', 10)).reason, 'stale');
  assert.equal(again.db.upsert(lsa('a', 99, {}, {}, { sig: 'forged' })).reason, 'bad-signature');
  again.clock.t += 10;
  assert.deepEqual(again.db.expire(), ['a']);
});

test('the highest seq outlives the LSA: an expired LSA cannot be replayed back in', () => {
  const { db, clock, calls } = setup();
  const original = lsa('a', 10, { b: 1 });
  db.upsert(original);
  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['a']);
  assert.equal(db.highestSeq('a'), 10);
  assert.equal(calls.verify, 1);

  assert.deepEqual(db.upsert(original), { accepted: false, changed: false, reason: 'stale' });
  assert.deepEqual(db.upsert(lsa('a', 9)), { accepted: false, changed: false, reason: 'stale' });
  assert.equal(calls.verify, 1, 'a replay against a tombstone must not cost a verification');
  assert.equal(db.has('a'), false);

  // The origin itself comes back with a higher seq: accepted, and a change again.
  assert.deepEqual(db.upsert(lsa('a', 11, { b: 1 })), { accepted: true, changed: true });
  assert.equal(db.highestSeq('a'), 11);
});

test('a tombstone is forgotten tombstoneMs after the LSA expired', () => {
  const { db, clock } = setup();
  const original = lsa('a', 10);
  db.upsert(original);
  clock.t += MAX_AGE;
  db.expire();

  clock.t += TOMBSTONE - 1;
  assert.equal(db.highestSeq('a'), 10);
  assert.equal(db.upsert(original).reason, 'stale');

  // Exactly at the limit it is gone, even if expire() has not run since.
  clock.t += 1;
  assert.equal(db.highestSeq('a'), 0);
  assert.deepEqual(db.upsert(original), { accepted: true, changed: true });

  // And expire() prunes tombstones on its own as well.
  const other = setup();
  other.db.upsert(lsa('a', 10));
  other.clock.t += MAX_AGE;
  other.db.expire();
  other.db.upsert(lsa('keepalive', 1));
  other.clock.t += TOMBSTONE;
  assert.deepEqual(other.db.expire(), ['keepalive']);
  other.clock.t -= TOMBSTONE; // even with the clock wound back, the tombstone is gone
  assert.equal(other.db.highestSeq('a'), 0);
});

test('our own tombstone keeps setLocal from reusing a sequence number', () => {
  const { db, clock } = setup();
  db.setLocal(lsa('self', 50));
  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['self']);
  assert.equal(db.highestSeq('self'), 50);
  assert.throws(() => db.setLocal(lsa('self', 50)), StateError);
  assert.equal(db.upsert(lsa('self', 49)).reason, 'own-origin');
  assert.equal(db.upsert(lsa('self', 50)).reason, 'own-origin-newer');
  assert.deepEqual(db.setLocal(lsa('self', 51)), { accepted: true, changed: true });
});

test('the tombstone map is bounded by maxOrigins, oldest evicted first', () => {
  const { db, clock } = setup({ maxOrigins: 4 });
  // Three waves of three origins (the fourth slot is reserved for our own LSA).
  const waves = [
    ['a1', 'a2', 'a3'],
    ['b1', 'b2', 'b3'],
    ['c1', 'c2', 'c3'],
  ];
  for (const wave of waves) {
    for (const origin of wave) assert.equal(db.upsert(lsa(origin, 7)).accepted, true);
    clock.t += MAX_AGE;
    assert.deepEqual(db.expire(), wave);
  }
  // Nine tombstones were created, four may remain: the newest ones.
  const remembered = waves.flat().filter((origin) => db.highestSeq(origin) === 7);
  assert.deepEqual(remembered, ['b3', 'c1', 'c2', 'c3']);
  assert.equal(db.highestSeq('a1'), 0);
  assert.equal(db.upsert(lsa('c1', 7)).reason, 'stale');
  // The documented price of the bound: an evicted origin's old LSA is accepted again.
  assert.equal(db.upsert(lsa('a1', 7)).accepted, true);
});

test('an origin that came back and expired again is the newest tombstone, not the oldest', () => {
  const { db, clock } = setup({ maxOrigins: 3 }); // two foreign LSAs, three tombstones
  let seqOfA = 1;
  const keepAlive = () => db.upsert(lsa('a', (seqOfA += 1)));
  const liveAndDie = (origin) => {
    assert.equal(db.upsert(lsa(origin, 1)).accepted, true);
    clock.t += 100;
    keepAlive();
    clock.t += 110;
    assert.deepEqual(db.expire(), [origin]);
  };

  db.upsert(lsa('a', 1));
  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['a']); // first tombstone of a
  keepAlive(); // a is back; its tombstone must be gone, not just shadowed
  liveAndDie('b');
  liveAndDie('c');

  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['a']); // tombstones, oldest first: b, c, a
  const lastSeqOfA = seqOfA;

  assert.equal(db.upsert(lsa('d', 1)).accepted, true);
  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['d']); // four tombstones, three allowed: b is dropped

  assert.equal(db.highestSeq('b'), 0);
  assert.equal(db.highestSeq('c'), 1);
  assert.equal(db.highestSeq('a'), lastSeqOfA);
  assert.equal(db.highestSeq('d'), 1);
});

test('the database holds at most maxOrigins LSAs with one slot reserved for our own', () => {
  const { db, clock, calls } = setup({ maxOrigins: 3 });
  assert.equal(db.upsert(lsa('a', 1)).accepted, true);
  assert.equal(db.upsert(lsa('b', 1)).accepted, true);

  const verifiedBefore = calls.verify;
  const refusal = { accepted: false, changed: false, reason: 'lsdb-full' };
  assert.deepEqual(db.upsert(lsa('c', 1)), refusal);
  assert.equal(calls.verify, verifiedBefore, 'a full database must not verify what it will refuse');
  assert.equal(db.highestSeq('c'), 0);

  // Known origins are still refreshed, and our own LSA still fits.
  assert.equal(db.upsert(lsa('a', 2)).accepted, true);
  assert.equal(db.setLocal(lsa('self', 1)).accepted, true);
  assert.equal(db.size, 3);
  assert.equal(db.upsert(lsa('c', 1)).reason, 'lsdb-full');

  // Room appears when an entry expires.
  clock.t += 100;
  db.upsert(lsa('a', 3));
  db.setLocal(lsa('self', 2));
  clock.t += 110; // b is 210 ms old
  assert.deepEqual(db.expire(), ['b']);
  assert.equal(db.upsert(lsa('c', 1)).accepted, true);
  assert.equal(db.size, 3);

  // A flood of distinct origins cannot grow it.
  for (let i = 0; i < 1000; i += 1) db.upsert(lsa(`flood${i}`, 1));
  assert.equal(db.size, 3);
  assert.deepEqual(seqsOf(db).map(([origin]) => origin).sort(), ['a', 'c', 'self']);
});

test('graph contains only links that both endpoints advertise, at the larger cost', () => {
  // DESIGN.md section 15, item 18: a node cannot attract traffic by understating its
  // own side of a link, because the other side's figure counts too.
  const { db } = setup();
  db.setLocal(lsa('self', 1, { a: 5, b: 7, ghost: 1 }));
  db.upsert(lsa('a', 1, { self: 6, b: 2 }));
  db.upsert(lsa('b', 1, { a: 3 })); // b does not list self: the self-b link is one-sided
  db.upsert(lsa('loner', 1, { a: 1 })); // a does not list loner

  assert.deepEqual(plainGraph(db), {
    self: { a: 6 },
    a: { self: 6, b: 3 },
    b: { a: 3 },
    loner: {},
  });

  // b confirms the link: it appears in both directions at the larger of the two costs.
  db.upsert(lsa('b', 2, { a: 3, self: 8 }));
  assert.deepEqual(plainGraph(db), {
    self: { a: 6, b: 8 },
    a: { self: 6, b: 3 },
    b: { a: 3, self: 8 },
    loner: {},
  });

  // a withdraws its link to b: gone in both directions although b still lists it.
  db.upsert(lsa('a', 2, { self: 6 }));
  assert.deepEqual(plainGraph(db), {
    self: { a: 6, b: 8 },
    a: { self: 6 },
    b: { self: 8 },
    loner: {},
  });

  // Understating one's own side gains nothing: a claims 1, self still says 5.
  db.upsert(lsa('a', 3, { self: 1 }));
  assert.equal(db.graph().get('a').get('self'), 5);
  assert.equal(db.graph().get('self').get('a'), 5);
});

test('a link disappears from the graph when one endpoint expires', () => {
  const { db, clock } = setup();
  db.upsert(lsa('a', 1, { b: 1 }));
  clock.t += 100;
  db.upsert(lsa('b', 1, { a: 1 }));
  assert.deepEqual(plainGraph(db), { a: { b: 1 }, b: { a: 1 } });

  clock.t += 110;
  assert.deepEqual(db.expire(), ['a']);
  assert.deepEqual(plainGraph(db), { b: {} });
});

test('graph returns maps the caller owns; changing them does not reach the database', () => {
  const { db } = setup();
  db.upsert(lsa('a', 1, { b: 1 }));
  db.upsert(lsa('b', 1, { a: 1 }));
  const graph = db.graph();
  assert.ok(graph instanceof Map);
  assert.ok(graph.get('a') instanceof Map);
  graph.get('a').set('b', 999);
  graph.get('a').set('x', 1);
  graph.delete('b');
  assert.deepEqual(plainGraph(db), { a: { b: 1 }, b: { a: 1 } });
});

test('mutating an LSA object after it was accepted cannot change the graph or the caps', () => {
  const { db } = setup();
  const a = lsa('a', 1, { b: 1 }, { transit: true, nested: { level: 1 } });
  db.upsert(a);
  db.upsert(lsa('b', 1, { a: 1 }));

  a.links[0].cost = 60000;
  a.links.push({ peer: 'c', cost: 1 });
  a.caps.transit = false;
  a.caps.nested.level = 2;

  assert.deepEqual(plainGraph(db), { a: { b: 1 }, b: { a: 1 } });
  assert.deepEqual(db.caps('a'), { transit: true, nested: { level: 1 } });
});

test('caps returns a frozen copy, or undefined for an unknown node', () => {
  const { db } = setup();
  db.upsert(lsa('a', 1, {}, { transit: false, tags: ['x'], nested: { n: 1 } }));
  const caps = db.caps('a');
  assert.deepEqual(caps, { transit: false, tags: ['x'], nested: { n: 1 } });
  assert.ok(Object.isFrozen(caps));
  assert.ok(Object.isFrozen(caps.tags));
  assert.ok(Object.isFrozen(caps.nested));
  assert.throws(() => {
    caps.transit = true;
  }, TypeError);
  assert.equal(db.caps('a').transit, false);
  assert.equal(db.caps('unknown'), undefined);

  db.upsert(lsa('a', 2, {}, { transit: true }));
  assert.deepEqual(db.caps('a'), { transit: true });
});

test('onChange fires synchronously, after the mutation, and only for topology changes', () => {
  const { db, clock } = setup();
  const seen = [];
  db.onChange((change) => {
    // The database is already updated when the listener runs.
    seen.push({ type: change.type, origins: [...change.origins], digest: seqsOf(db) });
  });

  db.upsert(lsa('a', 1, { b: 1 }));
  assert.deepEqual(seen, [{ type: 'upsert', origins: ['a'], digest: [['a', 1]] }]);

  // Refresh, stale, forged and malformed LSAs are not topology changes.
  db.upsert(lsa('a', 2, { b: 1 }));
  db.upsert(lsa('a', 1, { z: 1 }));
  db.upsert(lsa('a', 9, { z: 1 }, {}, { sig: 'forged' }));
  db.upsert(lsa('a', 9, { a: 1 }));
  db.upsert(lsa('self', 9));
  assert.equal(seen.length, 1);

  db.upsert(lsa('a', 3, { b: 2 }));
  assert.deepEqual(seen[1], { type: 'upsert', origins: ['a'], digest: [['a', 3]] });

  db.setLocal(lsa('self', 1));
  assert.deepEqual(seen[2], { type: 'local', origins: ['self'], digest: [['a', 3], ['self', 1]] });
  db.setLocal(lsa('self', 2));
  assert.equal(seen.length, 3);

  // expire() with nothing to remove is silent; a removal is one event for all origins.
  assert.deepEqual(db.expire(), []);
  assert.equal(seen.length, 3);
  clock.t += MAX_AGE;
  assert.deepEqual(db.expire(), ['a', 'self']);
  assert.deepEqual(seen[3], { type: 'expire', origins: ['a', 'self'], digest: [] });
  assert.equal(seen.length, 4);
});

test('the change event is frozen and unsubscribe stops delivery', () => {
  const { db } = setup();
  const first = [];
  const second = [];
  const offFirst = db.onChange((change) => first.push(change));
  db.onChange((change) => second.push(change));

  db.upsert(lsa('a', 1));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0], second[0]);
  assert.ok(Object.isFrozen(first[0]));
  assert.ok(Object.isFrozen(first[0].origins));

  offFirst();
  offFirst(); // idempotent
  db.upsert(lsa('b', 1));
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);

  assert.throws(() => db.onChange('not a function'), ConfigError);
  assert.throws(() => db.onChange(), ConfigError);
});

test('the same function subscribed twice is called twice and unsubscribed separately', () => {
  const { db } = setup();
  let count = 0;
  const listener = () => {
    count += 1;
  };
  const offA = db.onChange(listener);
  db.onChange(listener);
  db.upsert(lsa('a', 1));
  assert.equal(count, 2);
  offA();
  db.upsert(lsa('b', 1));
  assert.equal(count, 3);
});

test('a throwing listener does not starve the others, and the change still takes effect', () => {
  const { db } = setup();
  const boom = new Error('listener bug');
  let later = 0;
  db.onChange(() => {
    throw boom;
  });
  db.onChange(() => {
    throw new Error('second failure is not the one reported');
  });
  db.onChange(() => {
    later += 1;
  });

  assert.throws(() => db.upsert(lsa('a', 1)), (err) => err === boom);
  assert.equal(later, 1);
  assert.equal(db.has('a'), true);
  assert.equal(db.highestSeq('a'), 1);
});

test('a listener may unsubscribe or mutate the database while being notified', () => {
  const { db } = setup();
  const order = [];
  const off = db.onChange((change) => {
    order.push(`once:${change.origins[0]}`);
    off();
  });
  db.onChange((change) => {
    order.push(`always:${change.origins[0]}`);
    // Re-entrant mutation: install a second origin from inside the notification.
    if (change.origins[0] === 'a') db.upsert(lsa('b', 1));
  });
  db.upsert(lsa('a', 1));
  assert.deepEqual(order, ['once:a', 'always:a', 'always:b']);
  assert.deepEqual(seqsOf(db), [['a', 1], ['b', 1]]);
});

test('a listener subscribed during a notification first hears the next change', () => {
  const { db } = setup();
  const late = [];
  let subscribed = false;
  db.onChange(() => {
    if (subscribed) return;
    subscribed = true;
    db.onChange((change) => late.push(change.origins[0]));
  });
  db.upsert(lsa('a', 1));
  assert.deepEqual(late, [], 'the in-flight change must not reach a listener added during it');
  db.upsert(lsa('b', 1));
  assert.deepEqual(late, ['b']);
});

test('a clock that steps backwards does not keep a dead LSA alive', () => {
  const { db, clock } = setup();
  db.upsert(lsa('a', 1));
  clock.t -= 50_000; // e.g. the wall clock was corrected
  assert.deepEqual(db.expire(), []);
  clock.t += MAX_AGE - 1;
  assert.deepEqual(db.expire(), []);
  clock.t += 1;
  assert.deepEqual(db.expire(), ['a']);
});

test('a clock that does not return a finite number is an error', () => {
  for (const value of [NaN, Infinity, undefined, '5']) {
    const { db } = setup({ monoNow: () => value });
    assert.throws(
      () => db.upsert(lsa('a', 1)),
      (err) => err instanceof StateError && err.code === 'ERR_STATE',
    );
    assert.throws(() => db.expire(), StateError);
    assert.throws(() => db.highestSeq('a'), StateError);
    assert.equal(db.size, 0);
  }
});

test('constructor rejects missing or out-of-range options', () => {
  const good = {
    selfId: 'self',
    validate: () => ({ ok: true }),
    verify: () => true,
    monoNow: () => 0,
    wallNow: () => 0,
    maxClockSkewMs: 0,
    maxAgeMs: 210,
    tombstoneMs: 1000,
  };
  assert.doesNotThrow(() => new Lsdb(good));
  const bad = [
    { selfId: '' },
    { selfId: 5 },
    { selfId: undefined },
    { validate: undefined },
    { validate: {} },
    { verify: undefined },
    { verify: true },
    { monoNow: undefined },
    { wallNow: undefined },
    { wallNow: 0 },
    { maxClockSkewMs: undefined },
    { maxClockSkewMs: -1 },
    { maxClockSkewMs: Infinity },
    { priority: 1 },
    { allowOrigin: true },
    { onEquivocation: {} },
    { monoNow: 0 },
    { maxAgeMs: undefined },
    { maxAgeMs: 0 },
    { maxAgeMs: -1 },
    { maxAgeMs: Infinity },
    { maxAgeMs: '210' },
    { tombstoneMs: undefined },
    { tombstoneMs: 0 },
    { tombstoneMs: NaN },
    { maxOrigins: 0 },
    { maxOrigins: 1.5 },
    { maxOrigins: '10' },
    { maxLinks: -1 },
    { maxLinks: 2.5 },
  ];
  for (const override of bad) {
    assert.throws(
      () => new Lsdb({ ...good, ...override }),
      (err) => err instanceof ConfigError && err.code === 'ERR_CONFIG',
      JSON.stringify(override),
    );
  }
  assert.throws(() => new Lsdb(), ConfigError);
});

test('the reject reasons are the documented stable strings', () => {
  assert.deepEqual(LsaReject, {
    INVALID: 'invalid',
    MALFORMED: 'malformed',
    STALE: 'stale',
    OWN_ORIGIN: 'own-origin',
    OWN_ORIGIN_NEWER: 'own-origin-newer',
    FULL: 'lsdb-full',
    BAD_SIGNATURE: 'bad-signature',
    TOO_OLD: 'too-old',
    TOO_NEW: 'too-new',
    REFUSED_ORIGIN: 'origin-refused',
  });
  assert.ok(Object.isFrozen(LsaReject));
});

test('database and SPF together: routes follow LSAs as they arrive, change and expire', () => {
  const { db, clock } = setup();
  const routes = () =>
    computeRoutes({
      graph: db.graph(),
      selfId: 'self',
      transit: (id) => db.caps(id)?.transit !== false,
    });
  const summary = () =>
    Object.fromEntries([...routes()].map(([dst, r]) => [dst, `${r.path.join('>')} = ${r.cost}`]));

  // self - a - c  and  self - b - c, the way through a being cheaper.
  db.setLocal(lsa('self', 1, { a: 1, b: 5 }));
  db.upsert(lsa('a', 1, { self: 1, c: 1 }));
  db.upsert(lsa('b', 1, { self: 5, c: 5 }));
  assert.deepEqual(summary(), { a: 'self>a = 1', b: 'self>b = 5' }, 'c has not advertised yet');

  db.upsert(lsa('c', 1, { a: 1, b: 5 }));
  assert.deepEqual(summary(), { a: 'self>a = 1', c: 'self>a>c = 2', b: 'self>b = 5' });

  // a stops offering transit: c is now reached the dear way.
  db.upsert(lsa('a', 2, { self: 1, c: 1 }, { transit: false }));
  assert.deepEqual(summary(), { a: 'self>a = 1', b: 'self>b = 5', c: 'self>b>c = 10' });

  // b goes silent while everyone else keeps refreshing: c becomes unreachable.
  clock.t += 150;
  db.setLocal(lsa('self', 2, { a: 1, b: 5 }));
  db.upsert(lsa('a', 3, { self: 1, c: 1 }, { transit: false }));
  db.upsert(lsa('c', 2, { a: 1, b: 5 }));
  clock.t += 60;
  assert.deepEqual(db.expire(), ['b']);
  assert.deepEqual(summary(), { a: 'self>a = 1' });
});

// ---------------------------------------------------------------------------------------
// DESIGN.md section 15
// ---------------------------------------------------------------------------------------

/** Two LSAs of `origin` with one seq, ordered by hash: [lower, higher]. */
function tiedPair(origin, seq) {
  const one = lsa(origin, seq, { x: 1 });
  const two = lsa(origin, seq, { y: 2 });
  return hashOf(one) < hashOf(two) ? [one, two] : [two, one];
}

test('15.14: at equal seq the greater hash wins, is accepted again, and equivocation is reported once', () => {
  const reports = [];
  const { db, calls } = setup({ onEquivocation: (event) => reports.push(event) });
  const [lower, higher] = tiedPair('a', 10);

  assert.deepEqual(db.upsert(lower), { accepted: true, changed: true });
  assert.deepEqual(db.digest(), [['a', 10, hashOf(lower).slice(0, DIGEST_HASH_CHARS)]]);
  assert.equal(DIGEST_HASH_CHARS, 16);

  // The greater hash replaces it and is accepted, which is what makes the caller flood it.
  assert.deepEqual(db.upsert(higher), { accepted: true, changed: true });
  assert.equal(db.get('a'), higher);
  assert.deepEqual(db.digest(), [['a', 10, hashOf(higher).slice(0, 16)]]);
  assert.equal(reports.length, 1);
  assert.deepEqual({ ...reports[0] }, { origin: 'a', seq: 10, kept: higher, rejected: lower });
  assert.ok(Object.isFrozen(reports[0]));
  const verified = calls.verify;

  // The loser coming back is stale, and once equivocation is known it costs no signature
  // check; the winner coming back is a plain duplicate.
  assert.equal(db.upsert({ ...lower }).reason, 'stale');
  assert.equal(db.upsert({ ...higher }).reason, 'stale');
  assert.equal(calls.verify, verified);
  assert.equal(reports.length, 1);
});

test('15.14: the order is the same whichever record arrives first', () => {
  const [lower, higher] = tiedPair('a', 10);
  for (const order of [[lower, higher], [higher, lower]]) {
    const reports = [];
    const { db } = setup({ onEquivocation: (event) => reports.push(event.kept) });
    for (const record of order) db.upsert(record);
    assert.equal(db.get('a'), higher);
    assert.deepEqual(reports, [higher]);
  }
});

test('15.14: a forged tie is refused by its signature and is not reported', () => {
  const reports = [];
  const { db } = setup({ onEquivocation: (event) => reports.push(event) });
  const [lower, higher] = tiedPair('a', 10);
  db.upsert(lower);
  assert.equal(db.upsert({ ...higher, sig: 'forged' }).reason, 'bad-signature');
  assert.equal(db.upsert({ ...lower, links: [{ peer: 'q', cost: 1 }], sig: 'forged' }).reason, 'bad-signature');
  assert.equal(db.get('a'), lower);
  assert.deepEqual(reports, []);
});

test('15.14: a tie against a tombstone is stale: an expired origin is not revived at its old number', () => {
  const { db, clock } = setup();
  const [lower, higher] = tiedPair('a', 10);
  db.upsert(lower);
  clock.t += MAX_AGE;
  db.expire();
  assert.equal(db.upsert(higher).reason, 'stale');
  assert.equal(db.upsert(lsa('a', 11)).accepted, true);
});

test('15.15: an LSA whose seq is too far behind or ahead of the wall clock is refused before its signature', () => {
  const wall = { t: 1_700_000_000_000 };
  const skew = 30_000;
  const { db, calls } = setup({ wallNow: () => wall.t, maxClockSkewMs: skew });
  const oldest = wall.t - (MAX_AGE + skew);
  const newest = wall.t + skew;

  assert.deepEqual(db.upsert(lsa('a', oldest - 1)), { accepted: false, changed: false, reason: 'too-old' });
  assert.deepEqual(db.upsert(lsa('b', newest + 1)), { accepted: false, changed: false, reason: 'too-new' });
  assert.equal(calls.verify, 0);
  assert.equal(db.upsert(lsa('a', oldest)).accepted, true);
  assert.equal(db.upsert(lsa('b', newest)).accepted, true);

  // The replay attack the rule exists for: a former neighbour keeps re-sending a's last
  // LSA after a has left. Once the wall clock has moved on it is refused everywhere,
  // including at nodes that never saw it (no tombstone needed).
  const replay = lsa('c', wall.t);
  const fresh = setup({ wallNow: () => wall.t, maxClockSkewMs: skew });
  assert.equal(fresh.db.upsert(replay).accepted, true);
  wall.t += MAX_AGE + skew + 1;
  const later = setup({ wallNow: () => wall.t, maxClockSkewMs: skew });
  assert.equal(later.db.upsert(replay).reason, 'too-old');

  // Our own LSAs are made with our own clock; setLocal does not second-guess them.
  assert.equal(db.setLocal(lsa('self', 1)).accepted, true);
  // A wall clock that is not a number is an error, not a silent pass.
  const broken = setup({ wallNow: () => NaN, maxClockSkewMs: skew });
  assert.throws(() => broken.db.upsert(lsa('a', 5)), StateError);
});

test('15.15: the highest-seq memory survives a restart through exportSeqs/restoreSeqs', () => {
  const wall = { t: 1_700_000_000_000 };
  const first = setup({ wallNow: () => wall.t });
  first.db.upsert(lsa('a', 10));
  first.db.upsert(lsa('b', 20));
  first.db.setLocal(lsa('self', 30));
  first.clock.t += MAX_AGE;
  first.db.upsert(lsa('b', 21)); // b stays current, a expires
  first.db.setLocal(lsa('self', 31));
  assert.deepEqual(first.db.expire(), ['a']);
  wall.t += MAX_AGE + 40;
  first.clock.t += 40;

  const table = first.db.exportSeqs();
  assert.deepEqual(table, [
    ['a', 10, wall.t - 40],
    ['b', 21, wall.t],
    ['self', 31, wall.t],
  ]);

  // The process restarts 1000 ms later with a fresh monotonic clock.
  wall.t += 1000;
  const second = setup({ wallNow: () => wall.t });
  second.clock.t = 7;
  assert.equal(second.db.restoreSeqs(JSON.parse(JSON.stringify(table))), 3);
  assert.equal(second.db.highestSeq('a'), 10);
  assert.equal(second.db.upsert(lsa('a', 10)).reason, 'stale');
  assert.equal(second.db.upsert(lsa('b', 21)).reason, 'stale');
  assert.throws(() => second.db.setLocal(lsa('self', 31)), StateError);
  assert.equal(second.db.upsert(lsa('b', 22)).accepted, true);
  assert.equal(second.db.size, 1);

  // Each number is remembered tombstoneMs from its stamp: a's runs out first.
  second.clock.t += TOMBSTONE - 1040 - 1;
  assert.equal(second.db.highestSeq('a'), 10);
  second.clock.t += 1;
  assert.equal(second.db.highestSeq('a'), 0);
  assert.equal(second.db.highestSeq('self'), 31);

  // A restore never lowers what is known, and stale rows are skipped.
  const third = setup({ wallNow: () => wall.t });
  third.db.upsert(lsa('b', 50));
  assert.equal(third.db.restoreSeqs([['b', 21, wall.t], ['z', 5, wall.t - TOMBSTONE]]), 0);
  assert.equal(third.db.highestSeq('b'), 50);
  assert.equal(third.db.highestSeq('z'), 0);
});

test('15.15: restoreSeqs refuses a malformed table as a whole and bounds what it keeps', () => {
  const { db } = setup({ wallNow: () => 5000, maxOrigins: 3 });
  const bad = [
    null,
    {},
    'x',
    [null],
    [['a', 1]],
    [['a', 1, 5000, 0]],
    [['', 1, 5000]],
    [[7, 1, 5000]],
    [['x'.repeat(257), 1, 5000]],
    [['a', 0, 5000]],
    [['a', 1.5, 5000]],
    [['a', '1', 5000]],
    [['a', 1, NaN]],
    [['a', 1, 4999.5]],
    [['a', 1, 5000], ['a', 2, 5000]],
  ];
  for (const table of bad) {
    assert.throws(() => db.restoreSeqs(table), StoreError, JSON.stringify(table));
  }
  assert.equal(db.highestSeq('a'), 0);

  // Five rows, three slots: the newest stamps win; a stamp from the future counts as now.
  const table = [
    ['a', 1, 4000],
    ['b', 1, 4100],
    ['c', 1, 4200],
    ['d', 1, 4300],
    ['e', 1, 999_999],
  ];
  assert.equal(db.restoreSeqs(table), 5);
  const kept = ['a', 'b', 'c', 'd', 'e'].filter((origin) => db.highestSeq(origin) === 1);
  assert.deepEqual(kept, ['c', 'd', 'e']);
});

test('15.16: a valid network copy of our own origin at or above our seq is reported so we can jump past it', () => {
  const { db } = setup();
  db.setLocal(lsa('self', 50, { a: 1 }));
  const [lower, higher] = tiedPair('self', 50);
  // Same seq, different content: both directions of the tie are a conflict to supersede.
  assert.deepEqual(db.upsert(lower), { accepted: false, changed: false, reason: 'own-origin-newer', seq: 50 });
  assert.deepEqual(db.upsert(higher), { accepted: false, changed: false, reason: 'own-origin-newer', seq: 50 });
  assert.equal(db.upsert(lsa('self', 51)).seq, 51);
  assert.equal(db.highestSeq('self'), 50);
  assert.equal(db.setLocal(lsa('self', 52, { a: 1 })).accepted, true);
});

test('15.19: refused origins are dropped before any signature work', () => {
  const blocked = new Set(['evil']);
  const { db, calls } = setup({ allowOrigin: (origin) => !blocked.has(origin) });
  assert.deepEqual(db.upsert(lsa('evil', 1)), { accepted: false, changed: false, reason: 'origin-refused' });
  assert.equal(calls.verify, 0);
  assert.equal(db.upsert(lsa('good', 1)).accepted, true);
  // The policy is not applied to our own origin, and a policy that throws refuses.
  assert.equal(db.setLocal(lsa('self', 1)).accepted, true);
  const boom = new Error('policy store down');
  const { db: strict } = setup({
    allowOrigin: () => {
      throw boom;
    },
  });
  assert.deepEqual(strict.upsert(lsa('a', 1)), {
    accepted: false,
    changed: false,
    reason: 'origin-refused',
    cause: boom,
  });
  // Anything but true refuses.
  for (const answer of [1, 'yes', undefined]) {
    assert.equal(setup({ allowOrigin: () => answer }).db.upsert(lsa('a', 1)).reason, 'origin-refused');
  }
});

test('15.19: a full table evicts an origin not attached to our graph for one that is', () => {
  const changes = [];
  const { db, calls } = setup({ maxOrigins: 4 });
  db.onChange((change) => changes.push([change.type, ...change.origins]));
  db.setLocal(lsa('self', 1, { a: 1 }));
  db.upsert(lsa('a', 1, { self: 1, b: 1 }));
  db.upsert(lsa('island', 1, { far: 1 }));
  db.upsert(lsa('stray', 1));
  assert.equal(db.size, 4);
  changes.length = 0;

  // An unattached newcomer does not displace anything.
  const verified = calls.verify;
  assert.equal(db.upsert(lsa('nobody', 1)).reason, 'lsdb-full');
  assert.equal(calls.verify, verified, 'a refused newcomer costs no signature check');

  // b is attached (a lists it and it lists a): it displaces the smallest unattached id.
  assert.deepEqual(db.upsert(lsa('b', 1, { a: 1 })), { accepted: true, changed: true });
  assert.deepEqual(changes, [['upsert', 'b', 'island']]);
  assert.equal(db.has('island'), false);
  assert.equal(db.highestSeq('island'), 1, 'the evicted origin is remembered');
  assert.equal(db.upsert(lsa('island', 1)).reason, 'stale');

  // c is attached through b; stray goes. Now everything held is attached: nobody gets in.
  db.upsert(lsa('b', 2, { a: 1, c: 1 }));
  assert.equal(db.upsert(lsa('c', 1, { b: 1 })).accepted, true);
  assert.equal(db.has('stray'), false);
  assert.equal(db.upsert(lsa('d', 1, { c: 1 })).reason, 'lsdb-full');
  assert.deepEqual(seqsOf(db).map(([origin]) => origin).sort(), ['a', 'b', 'c', 'self']);
});

test('15.19: an injected priority function decides eviction; priorityChanged() rereads it', () => {
  const rank = new Map([['a', 5], ['b', 3], ['c', 4]]);
  const { db } = setup({ maxOrigins: 3, priority: (origin) => rank.get(origin) ?? 0 });
  db.upsert(lsa('a', 1));
  db.upsert(lsa('b', 1));
  assert.equal(db.upsert(lsa('x', 1)).reason, 'lsdb-full'); // 0 is not above b's 3
  assert.equal(db.upsert(lsa('c', 1)).accepted, true); // 4 beats b's 3
  assert.equal(db.has('b'), false);
  assert.equal(db.upsert(lsa('x', 1)).reason, 'lsdb-full'); // the choice is now c(4)

  rank.set('a', 1);
  rank.set('x', 2);
  assert.equal(db.upsert(lsa('x', 1)).reason, 'lsdb-full', 'the cached choice still says c(4)');
  db.priorityChanged();
  assert.equal(db.upsert(lsa('x', 1)).accepted, true);
  assert.equal(db.has('a'), false);

  // A priority function that throws or answers nonsense counts as 0.
  const odd = setup({
    maxOrigins: 2,
    priority: (origin) => {
      if (origin === 'boom') throw new Error('no');
      return origin === 'nan' ? NaN : 1;
    },
  }).db;
  odd.upsert(lsa('boom', 1));
  assert.equal(odd.upsert(lsa('fine', 1)).accepted, true);
  assert.equal(odd.has('boom'), false);
});

test('regression: expiring a full database next to a full tombstone map is linear', () => {
  // Review finding (routing, low): trimming tombstones with keys().next() per removal was
  // quadratic in V8 (1-2 s for one expire() at 50 000 origins; the old loop re-created in
  // a probe took 7 / 125 / 451 / 120 ms for these four waves). Four waves fill the
  // database and expire it whole; no later wave may cost much more than the first, which
  // has no tombstones to trim.
  const maxOrigins = 20_000;
  const { db, clock } = setup({ maxOrigins, verify: () => true, tombstoneMs: 1e12 });
  const timings = [];
  for (let wave = 0; wave < 4; wave += 1) {
    for (let i = 0; i < maxOrigins - 1; i += 1) db.upsert(lsa(`w${wave}-${i}`, 1));
    clock.t += MAX_AGE;
    const started = process.hrtime.bigint();
    assert.equal(db.expire().length, maxOrigins - 1);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const worst = Math.max(...timings.slice(1));
  assert.ok(worst < timings[0] * 4 + 40, `expire() took ${timings.map(Math.round).join(' / ')} ms`);
});
