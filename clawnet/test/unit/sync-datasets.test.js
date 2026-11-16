import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LogDataset,
  LwwDataset,
  MAX_INDEX,
  MAX_RANGES,
  MAX_RECORD,
  RECORD_OVERHEAD,
  SyncFault,
  isKey,
  recordHash,
} from '../../src/sync/datasets.js';
import { ConfigError, ProtocolError, StateError } from '../../src/core/errors.js';

const PAGE_LIMITS = { maxEntries: 1000, maxBytes: 1 << 20 };

/** A check that counts its calls and refuses records flagged `bad` (hard) or `soft`. */
function countingCheck(calls) {
  return record => {
    calls.check += 1;
    if (record.bad) return { ok: false, reason: 'bad-signature' };
    if (record.soft) return { ok: false, reason: 'expired', soft: true };
    return { ok: true };
  };
}

function lww(overrides = {}) {
  const calls = { check: 0, accepted: [] };
  const dataset = new LwwDataset({
    name: 'kv',
    key: record => record.k,
    version: record => record.v,
    check: countingCheck(calls),
    maxEntries: 100,
    onAccept: (record, info) => calls.accepted.push([record.k, record.v, info.isNew, info.from]),
    ...overrides,
  });
  return { dataset, calls };
}

function log(overrides = {}) {
  const calls = { check: 0, accepted: [] };
  const dataset = new LogDataset({
    name: 'log',
    stream: record => record.s,
    index: record => record.n,
    check: countingCheck(calls),
    maxPerStream: 1000,
    maxStreams: 100,
    onAccept: (record, info) => calls.accepted.push([record.s, record.n, info.isNew, info.from]),
    ...overrides,
  });
  return { dataset, calls };
}

const kv = (k, v, extra = {}) => ({ k, v, ...extra });
/** The digest entry of a record: key, version and the first 8 bytes of its hash. */
const rec = (k, v, extra = {}) => [k, v, recordHash(kv(k, v, extra)).slice(0, 16)];
/** digest() without the hashes, for tests about which versions are held. */
const seqs = dataset => dataset.digest().map(([k, v]) => [k, v]);
const entry = (s, n, extra = {}) => ({ s, n, ...extra });

function fill(dataset, stream, from, to) {
  for (let n = from; n <= to; n += 1) {
    assert.equal(dataset.offer(entry(stream, n)).accepted, true, `${stream}#${n}`);
  }
}

/** Assert that `fn` throws a SyncFault with the given stable reason. */
function assertFault(fn, reason) {
  assert.throws(fn, err => {
    assert.ok(err instanceof SyncFault, `expected a SyncFault, got ${err}`);
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, 'ERR_PROTOCOL');
    assert.equal(err.reason, reason);
    return true;
  });
}

const steps = iterable => [...iterable];

// ---------------------------------------------------------------------------------------
// LwwDataset
// ---------------------------------------------------------------------------------------

test('lww: constructor rejects missing and out-of-range options', () => {
  const good = {
    name: 'kv',
    key: r => r.k,
    version: r => r.v,
    check: () => ({ ok: true }),
    maxEntries: 1,
  };
  assert.doesNotThrow(() => new LwwDataset(good));
  const bad = [
    { name: undefined },
    { name: 'Has-Upper' },
    { name: '' },
    { name: 'x'.repeat(33) },
    { key: 'k' },
    { version: null },
    { check: undefined },
    { maxEntries: 0 },
    { maxEntries: 1.5 },
    { maxEntries: Infinity },
    { onAccept: 'nope' },
  ];
  for (const override of bad) {
    assert.throws(() => new LwwDataset({ ...good, ...override }), ConfigError, JSON.stringify(override));
  }
  assert.throws(() => new LwwDataset(), ConfigError);
});

test('lww: the higher version wins and the very same record again is a duplicate', () => {
  const { dataset, calls } = lww();
  const first = kv('a', 5, { note: 'first' });

  assert.deepEqual(dataset.offer(first, 'peer-1'), { accepted: true, isNew: true });
  assert.deepEqual(dataset.offer(kv('a', 5, { note: 'first' })), { accepted: false, reason: 'duplicate' });
  assert.equal(dataset.get('a'), first);
  assert.deepEqual(dataset.offer(kv('a', 4)), { accepted: false, reason: 'stale' });
  assert.equal(dataset.get('a'), first);

  const newer = kv('a', 6);
  assert.deepEqual(dataset.offer(newer, 'peer-2'), { accepted: true, isNew: false });
  assert.equal(dataset.get('a'), newer);
  assert.equal(dataset.size, 1);
  assert.equal(dataset.has('a'), true);
  assert.equal(dataset.has('b'), false);
  assert.equal(dataset.get('b'), undefined);

  assert.deepEqual(calls.accepted, [
    ['a', 5, true, 'peer-1'],
    ['a', 6, false, 'peer-2'],
  ]);
});

test('lww: check runs only for records that would change the dataset', () => {
  const { dataset, calls } = lww();
  dataset.offer(kv('a', 5));
  assert.equal(calls.check, 1);
  dataset.offer(kv('a', 5));
  dataset.offer(kv('a', 1));
  dataset.offer(kv('a', 0, { bad: true }));
  assert.equal(calls.check, 1, 'old and duplicate records must not reach check');
  dataset.offer(kv('a', 6));
  assert.equal(calls.check, 2);
});

test('lww: records failing check are not stored; hard failures are marked invalid', () => {
  const { dataset, calls } = lww();
  assert.deepEqual(dataset.offer(kv('a', 1, { bad: true })), {
    accepted: false,
    reason: 'bad-signature',
    invalid: true,
  });
  assert.deepEqual(dataset.offer(kv('a', 1, { soft: true })), { accepted: false, reason: 'expired' });
  assert.equal(dataset.size, 0);
  assert.deepEqual(calls.accepted, []);
  // The refused versions left no trace: the same version is still acceptable.
  assert.equal(dataset.offer(kv('a', 1)).accepted, true);
});

test('lww: a check that throws or answers anything but { ok: true } refuses the record', () => {
  const answers = [
    () => {
      throw new Error('boom');
    },
    () => true,
    () => undefined,
    () => null,
    () => ({ ok: 1 }),
    () => ({ ok: 'true' }),
    () => ({}),
  ];
  const expected = ['check-threw', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected'];
  answers.forEach((check, i) => {
    const { dataset } = lww({ check });
    assert.deepEqual(dataset.offer(kv('a', 1)), { accepted: false, reason: expected[i], invalid: true });
    assert.equal(dataset.size, 0);
  });
});

test('lww: malformed records, keys and versions are invalid and never reach check', () => {
  const { dataset, calls } = lww();
  for (const record of [null, undefined, 7, 'text', [], [kv('a', 1)], new Map(), new Date(0)]) {
    assert.deepEqual(dataset.offer(record), { accepted: false, reason: 'malformed', invalid: true });
  }
  const badKeys = ['', 'has space', 'x'.repeat(129), `caf${String.fromCodePoint(0xe9)}`, 'tab\tkey', 5, null, undefined, {}];
  for (const k of badKeys) {
    assert.deepEqual(dataset.offer({ k, v: 1 }), { accepted: false, reason: 'bad-key', invalid: true });
  }
  for (const v of [-1, 1.5, 2 ** 53, NaN, Infinity, '1', null, undefined]) {
    assert.deepEqual(dataset.offer({ k: 'a', v }), { accepted: false, reason: 'bad-version', invalid: true });
  }
  assert.equal(calls.check, 0);
  assert.equal(dataset.size, 0);

  const throwing = lww({
    key: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(throwing.dataset.offer(kv('a', 1)), { accepted: false, reason: 'malformed', invalid: true });

  // The boundaries themselves are fine.
  assert.equal(dataset.offer({ k: 'x'.repeat(128), v: 0 }).accepted, true);
  assert.equal(dataset.offer({ k: '~!', v: Number.MAX_SAFE_INTEGER }).accepted, true);
});

test('lww: isKey accepts printable ASCII without spaces, 1..128 characters', () => {
  assert.equal(isKey('a'), true);
  assert.equal(isKey('chan/origin:7'), true);
  assert.equal(isKey('x'.repeat(128)), true);
  assert.equal(isKey(''), false);
  assert.equal(isKey(' '), false);
  assert.equal(isKey('x'.repeat(129)), false);
  assert.equal(isKey('a\nb'), false);
  assert.equal(isKey(String.fromCodePoint(0x7f)), false);
  assert.equal(isKey(String.fromCodePoint(0x1f600)), false);
  assert.equal(isKey(12), false);
});

test('lww: digest and values are ascending by key whatever the insertion order', () => {
  const { dataset } = lww();
  for (const [k, v] of [['m', 3], ['b', 9], ['z', 1], ['a', 4], ['b2', 2]]) dataset.offer(kv(k, v));
  assert.deepEqual(seqs(dataset), [['a', 4], ['b', 9], ['b2', 2], ['m', 3], ['z', 1]]);
  assert.deepEqual(dataset.values().map(r => r.k), ['a', 'b', 'b2', 'm', 'z']);
});

test('lww: diff reports what each side is missing', () => {
  const { dataset } = lww();
  for (const [k, v] of [['a', 5], ['b', 5], ['c', 5], ['e', 5]]) dataset.offer(kv(k, v));

  const remote = [rec('a', 5), rec('b', 7), rec('c', 2), rec('d', 1), rec('f', 9)];
  const { missingHere, missingThere } = dataset.diff(remote);
  assert.deepEqual(missingHere, ['b', 'd', 'f']);
  assert.deepEqual(missingThere, [dataset.get('c'), dataset.get('e')]);

  assert.deepEqual(dataset.diff([]), { missingHere: [], missingThere: dataset.values() });
  assert.deepEqual(dataset.diff(dataset.digest()), { missingHere: [], missingThere: [] });
});

test('lww: diff rejects malformed digests', () => {
  const { dataset } = lww();
  dataset.offer(kv('a', 1));
  const bad = [
    'nope',
    { a: 1 },
    [rec('b', 1), rec('a', 1)],
    [rec('a', 1), rec('a', 2)],
    [['a']],
    [['a', 1]],
    [['a', 1, 1, 1]],
    [['a', 1, 0]],
    [['a', 1, 'abc']],
    [['a', 1, '0123456789ABCDEF']],
    [['a', 1, '0123456789abcdef0']],
    [['a', -1, '0123456789abcdef']],
    [['a', 1.5, '0123456789abcdef']],
    [['has space', 1, '0123456789abcdef']],
    [[5, 1, '0123456789abcdef']],
    ['a'],
    [null],
  ];
  for (const digest of bad) assertFault(() => dataset.diff(digest), 'bad-digest');
});

test('lww: at capacity the lowest version is evicted, ties by lowest key', () => {
  const { dataset, calls } = lww({ maxEntries: 3 });
  for (const [k, v] of [['a', 5], ['b', 3], ['c', 3]]) dataset.offer(kv(k, v));

  // d(4) beats the lowest version (3); of b and c the lower key goes.
  assert.deepEqual(dataset.offer(kv('d', 4)), { accepted: true, isNew: true });
  assert.deepEqual(seqs(dataset), [['a', 5], ['c', 3], ['d', 4]]);

  // e(3) does not beat the lowest version now held (c at 3): refused before check.
  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(kv('e', 3)), { accepted: false, reason: 'full' });
  assert.deepEqual(dataset.offer(kv('e', 1)), { accepted: false, reason: 'full' });
  assert.equal(calls.check, checksBefore);
  assert.deepEqual(seqs(dataset), [['a', 5], ['c', 3], ['d', 4]]);

  // Updating a key that is held needs no room.
  assert.deepEqual(dataset.offer(kv('c', 9)), { accepted: true, isNew: false });
  assert.deepEqual(dataset.offer(kv('e', 5)), { accepted: true, isNew: true });
  assert.deepEqual(seqs(dataset), [['a', 5], ['c', 9], ['e', 5]]);
  assert.equal(dataset.size, 3);
  // An evicted key leaves no floor behind.
  assert.equal(dataset.floorOf('d'), undefined);
});

test('lww: pinned keys are never evicted and are always admitted', () => {
  const { dataset } = lww({ maxEntries: 3 });
  dataset.pin('low');
  for (const [k, v] of [['low', 1], ['mid', 5], ['top', 9]]) dataset.offer(kv(k, v));
  assert.equal(dataset.isPinned('low'), true);

  // The lowest version overall is pinned, so the lowest unpinned one (mid) goes.
  assert.equal(dataset.offer(kv('new', 6)).accepted, true);
  assert.deepEqual(seqs(dataset), [['low', 1], ['new', 6], ['top', 9]]);

  // A pinned key gets in with any version, at the cost of the lowest unpinned record.
  dataset.pin('vip');
  assert.equal(dataset.offer(kv('vip', 0)).accepted, true);
  assert.deepEqual(seqs(dataset), [['low', 1], ['top', 9], ['vip', 0]]);

  // Unpinned, 'vip' is the next to go.
  assert.equal(dataset.unpin('vip'), true);
  assert.equal(dataset.unpin('vip'), false);
  assert.equal(dataset.offer(kv('x', 2)).accepted, true);
  assert.deepEqual(seqs(dataset), [['low', 1], ['top', 9], ['x', 2]]);
});

test('lww: with every record pinned nothing new is admitted', () => {
  const { dataset } = lww({ maxEntries: 2 });
  dataset.pin('a');
  dataset.pin('b');
  dataset.offer(kv('a', 1));
  dataset.offer(kv('b', 1));
  assert.deepEqual(dataset.offer(kv('c', 999)), { accepted: false, reason: 'full' });
  assert.deepEqual(seqs(dataset), [['a', 1], ['b', 1]]);
  assert.equal(dataset.syncPage(null, PAGE_LIMITS).hint.min, Number.MAX_SAFE_INTEGER);

  dataset.pin('a');
  assert.throws(() => dataset.pin('c'), StateError);
  assert.throws(() => dataset.pin('has space'), ConfigError);
  assert.throws(() => dataset.pin(7), ConfigError);
});

test('lww: remove leaves a floor so the removed version cannot come back', () => {
  const { dataset, calls } = lww();
  dataset.offer(kv('a', 5));
  dataset.offer(kv('b', 1));

  assert.equal(dataset.remove('a'), true);
  assert.equal(dataset.remove('a'), false);
  assert.equal(dataset.remove('never'), false);
  assert.equal(dataset.get('a'), undefined);
  assert.equal(dataset.size, 1);
  assert.equal(dataset.floorOf('a'), 5);
  assert.deepEqual(seqs(dataset), [['b', 1]]);

  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(kv('a', 5)), { accepted: false, reason: 'removed' });
  assert.deepEqual(dataset.offer(kv('a', 2)), { accepted: false, reason: 'removed' });
  assert.equal(calls.check, checksBefore);

  // The removed version is neither requested from a peer that still has it ...
  assert.deepEqual(dataset.diff([rec('a', 5), rec('b', 1)]), { missingHere: [], missingThere: [] });
  // ... but a newer one is, and is accepted, which clears the floor.
  assert.deepEqual(dataset.diff([rec('a', 6), rec('b', 1)]).missingHere, ['a']);
  assert.deepEqual(dataset.offer(kv('a', 6)), { accepted: true, isNew: true });
  assert.equal(dataset.floorOf('a'), undefined);
  assert.deepEqual(seqs(dataset), [['a', 6], ['b', 1]]);
});

test('lww: forget drops a floor, and floors are bounded by maxEntries', () => {
  const { dataset } = lww({ maxEntries: 2 });
  dataset.offer(kv('a', 5));
  dataset.remove('a');
  assert.equal(dataset.forget('a'), true);
  assert.equal(dataset.forget('a'), false);
  assert.equal(dataset.offer(kv('a', 5)).accepted, true);

  // Three removals with room for two floors: the oldest floor is forgotten.
  dataset.remove('a');
  dataset.offer(kv('b', 1));
  dataset.remove('b');
  dataset.offer(kv('c', 1));
  dataset.remove('c');
  assert.equal(dataset.floorOf('a'), undefined);
  assert.equal(dataset.floorOf('b'), 1);
  assert.equal(dataset.floorOf('c'), 1);
  assert.deepEqual(dataset.syncPage(null, PAGE_LIMITS).entries, [['b', 1, 1], ['c', 1, 1]]);
});

test('lww: syncPage pages the digest by entry count and by bytes', () => {
  const { dataset } = lww();
  for (let i = 0; i < 10; i += 1) dataset.offer(kv(`k${i}`, i));

  const first = dataset.syncPage(null, { maxEntries: 4, maxBytes: 1 << 20 });
  assert.deepEqual(first, {
    after: null,
    upto: 'k3',
    entries: [rec('k0', 0), rec('k1', 1), rec('k2', 2), rec('k3', 3)],
    hint: {},
  });
  const second = dataset.syncPage('k3', { maxEntries: 4, maxBytes: 1 << 20 });
  assert.deepEqual(second.entries.map(e => e[0]), ['k4', 'k5', 'k6', 'k7']);
  assert.equal(second.upto, 'k7');
  const third = dataset.syncPage('k7', { maxEntries: 4, maxBytes: 1 << 20 });
  assert.deepEqual(third.entries, [rec('k8', 8), rec('k9', 9)]);
  assert.equal(third.upto, null);
  assert.deepEqual(dataset.syncPage('k9', { maxEntries: 4, maxBytes: 1 << 20 }), {
    after: 'k9',
    upto: null,
    entries: [],
    hint: {},
  });

  // ["k0",0,"0123456789abcdef"], is 28 bytes; 60 bytes hold two entries plus the brackets.
  const small = dataset.syncPage(null, { maxEntries: 100, maxBytes: 60 });
  assert.deepEqual(small.entries, [rec('k0', 0), rec('k1', 1)]);
  assert.equal(small.upto, 'k1');
  // However small the budget, a page carries one entry, so paging always advances.
  const tiny = dataset.syncPage('k1', { maxEntries: 100, maxBytes: 1 });
  assert.deepEqual(tiny.entries, [rec('k2', 2)]);
  assert.equal(tiny.upto, 'k2');
});

test('lww: syncPage lists floors as tombstones and advertises the capacity watermark', () => {
  const { dataset } = lww({ maxEntries: 3 });
  dataset.offer(kv('a', 4));
  dataset.offer(kv('b', 7));
  dataset.remove('a');
  assert.deepEqual(dataset.syncPage(null, PAGE_LIMITS), {
    after: null,
    upto: null,
    entries: [['a', 4, 1], rec('b', 7)],
    hint: {},
  });

  dataset.offer(kv('c', 2));
  dataset.offer(kv('d', 9));
  // Full: three records. The lowest unpinned version is the watermark.
  assert.deepEqual(dataset.syncPage(null, PAGE_LIMITS).hint, { min: 2 });
  dataset.pin('c');
  assert.deepEqual(dataset.syncPage(null, PAGE_LIMITS).hint, { min: 7 });
});

test('lww: syncReconcile yields pushes and wants in key order inside the page only', () => {
  const { dataset } = lww();
  for (const [k, v] of [['a', 1], ['c', 5], ['e', 5], ['g', 5], ['i', 5], ['z', 1]]) {
    dataset.offer(kv(k, v));
  }
  const page = {
    after: 'b',
    upto: 'h',
    entries: [rec('c', 9), rec('d', 1), rec('e', 2), rec('g', 5)],
    hint: {},
  };
  assert.deepEqual(steps(dataset.syncReconcile(page)), [
    { cursor: 'c', want: 'c' },
    { cursor: 'd', want: 'd' },
    { cursor: 'e', push: dataset.get('e') },
  ]);

  // The last page of a digest is open-ended: our keys beyond the entries are pushed.
  const open = { after: 'h', upto: null, entries: [], hint: {} };
  assert.deepEqual(steps(dataset.syncReconcile(open)), [
    { cursor: 'i', push: dataset.get('i') },
    { cursor: 'z', push: dataset.get('z') },
  ]);

  // pushAfter suppresses pushes at or before a cursor; push: false suppresses them all.
  const all = { after: null, upto: null, entries: [rec('c', 9)], hint: {} };
  assert.deepEqual(
    steps(dataset.syncReconcile(all, { pushAfter: 'g' })).map(s => s.cursor),
    ['c', 'i', 'z'],
  );
  assert.deepEqual(steps(dataset.syncReconcile(all, { push: false })), [{ cursor: 'c', want: 'c' }]);
});

test('lww: syncReconcile honours tombstones and the capacity watermark of the peer', () => {
  const { dataset } = lww();
  for (const [k, v] of [['a', 5], ['b', 5], ['c', 5], ['d', 2]]) dataset.offer(kv(k, v));

  // The peer removed a@5 (we hold the same: nothing), b@3 (ours is newer: push) and
  // x@9 (we never ask for a tombstone).
  const tombstones = {
    after: null,
    upto: 'c',
    entries: [['a', 5, 1], ['b', 3, 1], rec('c', 5)],
    hint: {},
  };
  assert.deepEqual(steps(dataset.syncReconcile(tombstones)), [{ cursor: 'b', push: dataset.get('b') }]);
  const unknownTombstone = { after: 'w', upto: null, entries: [['x', 9, 1]], hint: {} };
  assert.deepEqual(steps(dataset.syncReconcile(unknownTombstone)), []);

  // A full peer: keys it lacks are pushed only above its watermark; a key it holds in
  // an older version is updated regardless.
  const full = { after: null, upto: null, entries: [rec('d', 1)], hint: { min: 4 } };
  assert.deepEqual(
    steps(dataset.syncReconcile(full)).map(s => [s.cursor, s.push?.v]),
    [['a', 5], ['b', 5], ['c', 5], ['d', 2]],
  );
  const fuller = { after: null, upto: null, entries: [rec('d', 1)], hint: { min: 5 } };
  assert.deepEqual(steps(dataset.syncReconcile(fuller)).map(s => s.cursor), ['d']);
});

test('lww: at capacity syncReconcile asks only for records that would win a place', () => {
  const { dataset } = lww({ maxEntries: 2 });
  dataset.offer(kv('m', 5));
  dataset.offer(kv('n', 8));
  dataset.pin('p');
  const page = {
    after: null,
    upto: null,
    entries: [rec('a', 5), rec('b', 6), rec('m', 9), rec('p', 1), rec('q', 4)],
    hint: {},
  };
  // a@5 does not beat the lowest version held (5); b@6 does; m is an update; p is pinned.
  assert.deepEqual(steps(dataset.syncReconcile(page, { push: false })).map(s => s.want), ['b', 'm', 'p']);
});

test('lww: syncReconcile rejects malformed pages', () => {
  const { dataset } = lww();
  const page = overrides => ({ after: null, upto: null, entries: [], hint: {}, ...overrides });

  assertFault(() => dataset.syncReconcile(page({ entries: 'x' })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ entries: [rec('b', 1), rec('a', 1)] })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ after: 'c', entries: [rec('c', 1)] })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ after: 'c', entries: [rec('b', 1)] })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ upto: 'c', entries: [rec('d', 1)] })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ entries: [['a', 1, 2]] })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ entries: [['a', 1]] })), 'bad-digest');
  assert.doesNotThrow(() => dataset.syncReconcile(page({ after: 'b', upto: 'd', entries: [rec('c', 1)] })));

  assertFault(() => dataset.syncReconcile(page({ after: 'has space' })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ upto: 7 })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ after: 'b', upto: 'b' })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ after: 'c', upto: 'b' })), 'bad-cursor');

  assertFault(() => dataset.syncReconcile(page({ hint: null })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: [] })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { min: -1 } })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { min: '4' } })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { other: 1 } })), 'bad-hint');
});

test('lww: syncServe answers only for keys the page advertised', () => {
  const { dataset } = lww();
  for (const [k, v] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]]) dataset.offer(kv(k, v));
  dataset.remove('c');
  const page = dataset.syncPage(null, PAGE_LIMITS);
  assert.deepEqual(page.entries, [rec('a', 1), rec('b', 2), ['c', 3, 1], rec('d', 4)]);

  assert.deepEqual(steps(dataset.syncServe(['a', 'd'], page)), [
    { cursor: 'a', record: dataset.get('a') },
    { cursor: 'd', record: dataset.get('d') },
  ]);
  assert.deepEqual(steps(dataset.syncServe([], page)), []);

  // A record removed after the page went out is skipped, not an error.
  const removed = dataset.get('b');
  dataset.remove('b');
  assert.deepEqual(steps(dataset.syncServe(['a', 'b'], page)).map(s => s.cursor), ['a']);
  dataset.forget('b');
  dataset.offer(removed);

  assertFault(() => dataset.syncServe('a', page), 'bad-request');
  assertFault(() => dataset.syncServe([7], page), 'bad-request');
  assertFault(() => dataset.syncServe(['has space'], page), 'bad-request');
  assertFault(() => dataset.syncServe(['b', 'a'], page), 'bad-request');
  assertFault(() => dataset.syncServe(['a', 'a'], page), 'bad-request');
  assertFault(() => dataset.syncServe(['zz'], page), 'bad-range');
  assertFault(() => dataset.syncServe(['aa'], page), 'bad-range');
  assertFault(() => dataset.syncServe(['c'], page), 'bad-range');
  assertFault(() => dataset.syncServe(['a', 'd'], page, 'b'), 'bad-range');
  assert.deepEqual(steps(dataset.syncServe(['a', 'b'], page, 'b')).map(s => s.cursor), ['a', 'b']);
});

test('lww: cursors are keys, ordered as strings', () => {
  const { dataset } = lww();
  assert.equal(dataset.syncCursor('abc'), 'abc');
  for (const value of [null, 5, '', 'has space', ['a'], {}]) {
    assertFault(() => dataset.syncCursor(value), 'bad-cursor');
  }
  assert.ok(dataset.syncCompare('a', 'b') < 0);
  assert.ok(dataset.syncCompare('b', 'a') > 0);
  assert.equal(dataset.syncCompare('a', 'a'), 0);
  // Byte order, not locale order.
  assert.ok(dataset.syncCompare('Z', 'a') < 0);

  const page = { after: null, upto: null, entries: [['b', 1], ['d', 1], ['f', 1]], hint: {} };
  assert.equal(dataset.syncConsumed(page, 'a'), 0);
  assert.equal(dataset.syncConsumed(page, 'b'), 1);
  assert.equal(dataset.syncConsumed(page, 'e'), 2);
  assert.equal(dataset.syncConsumed(page, 'z'), 3);
});

// ---------------------------------------------------------------------------------------
// LogDataset
// ---------------------------------------------------------------------------------------

test('log: constructor rejects missing and out-of-range options', () => {
  const good = {
    name: 'log',
    stream: r => r.s,
    index: r => r.n,
    check: () => ({ ok: true }),
    maxPerStream: 1,
    maxStreams: 1,
  };
  assert.doesNotThrow(() => new LogDataset(good));
  const bad = [
    { name: 'bad name' },
    { stream: undefined },
    { index: 3 },
    { check: null },
    { maxPerStream: 0 },
    { maxPerStream: 2.5 },
    { maxStreams: 0 },
    { maxStreams: -1 },
    { onAccept: {} },
  ];
  for (const override of bad) {
    assert.throws(() => new LogDataset({ ...good, ...override }), ConfigError, JSON.stringify(override));
  }
  assert.throws(() => new LogDataset(), ConfigError);
});

test('log: indices arrive in any order and the high-water mark follows the contiguous prefix', () => {
  const { dataset, calls } = log();
  assert.deepEqual(dataset.offer(entry('s', 1), 'peer-1'), { accepted: true, isNew: true });
  dataset.offer(entry('s', 2));
  assert.deepEqual(dataset.digest(), [['s', 0, 2]]);
  assert.equal(dataset.highOf('s'), 2);

  dataset.offer(entry('s', 5));
  dataset.offer(entry('s', 6));
  dataset.offer(entry('s', 9));
  assert.deepEqual(dataset.digest(), [['s', 0, 2, [[5, 6], [9, 9]]]]);
  assert.equal(dataset.highOf('s'), 2);
  assert.equal(dataset.topOf('s'), 9);

  dataset.offer(entry('s', 4));
  assert.deepEqual(dataset.digest(), [['s', 0, 2, [[4, 6], [9, 9]]]]);
  dataset.offer(entry('s', 3));
  assert.deepEqual(dataset.digest(), [['s', 0, 6, [[9, 9]]]]);
  dataset.offer(entry('s', 8));
  dataset.offer(entry('s', 7));
  assert.deepEqual(dataset.digest(), [['s', 0, 9]]);

  assert.equal(dataset.size, 9);
  assert.equal(dataset.streamCount, 1);
  assert.deepEqual(calls.accepted[0], ['s', 1, true, 'peer-1']);
  assert.equal(calls.accepted.length, 9);
});

test('log: duplicates, invalid records and soft refusals are not stored', () => {
  const { dataset, calls } = log();
  dataset.offer(entry('s', 1));
  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(entry('s', 1, { other: true })), { accepted: false, reason: 'duplicate' });
  assert.equal(calls.check, checksBefore, 'a duplicate must not reach check');

  assert.deepEqual(dataset.offer(entry('s', 2, { bad: true })), {
    accepted: false,
    reason: 'bad-signature',
    invalid: true,
  });
  assert.deepEqual(dataset.offer(entry('s', 2, { soft: true })), { accepted: false, reason: 'expired' });
  assert.equal(dataset.get('s', 2), undefined);

  for (const record of [null, 3, 'x', [], new Map()]) {
    assert.deepEqual(dataset.offer(record), { accepted: false, reason: 'malformed', invalid: true });
  }
  for (const s of ['', 'has space', 'x'.repeat(129), 7, null]) {
    assert.deepEqual(dataset.offer({ s, n: 1 }), { accepted: false, reason: 'bad-stream', invalid: true });
  }
  for (const n of [0, -1, 1.5, 2 ** 53, NaN, '1', null]) {
    assert.deepEqual(dataset.offer({ s: 's', n }), { accepted: false, reason: 'bad-index', invalid: true });
  }
  assert.equal(dataset.size, 1);
  assert.deepEqual(dataset.digest(), [['s', 0, 1]]);
});

test('log: retention keeps the newest maxPerStream indices and records a floor', () => {
  const { dataset, calls } = log({ maxPerStream: 5 });
  fill(dataset, 's', 1, 5);
  assert.equal(dataset.floorOf('s'), 0);
  assert.equal(dataset.size, 5);

  dataset.offer(entry('s', 6));
  assert.equal(dataset.floorOf('s'), 1);
  assert.equal(dataset.get('s', 1), undefined);
  assert.equal(dataset.size, 5);
  assert.deepEqual(dataset.digest(), [['s', 1, 6]]);

  // A pruned index is refused before check, for good.
  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(entry('s', 1)), { accepted: false, reason: 'pruned' });
  assert.equal(calls.check, checksBefore);

  // A jump ahead moves the window: everything below it goes at once.
  dataset.offer(entry('s', 20));
  assert.equal(dataset.floorOf('s'), 15);
  assert.equal(dataset.size, 1);
  assert.deepEqual(dataset.digest(), [['s', 15, 15, [[20, 20]]]]);
  assert.deepEqual(dataset.offer(entry('s', 15)), { accepted: false, reason: 'pruned' });

  // Filling the window below the newest index never moves the floor.
  for (const n of [19, 17, 16, 18]) assert.equal(dataset.offer(entry('s', n)).accepted, true);
  assert.deepEqual(dataset.digest(), [['s', 15, 20]]);
  assert.equal(dataset.size, 5);
});

test('log: out-of-order indices that fall below the window are pruned with it', () => {
  const { dataset } = log({ maxPerStream: 4 });
  for (const n of [1, 2, 5, 7, 9]) dataset.offer(entry('s', n));
  // top 9, window (5, 9]: 1, 2 and 5 are gone, 7 and 9 remain above the mark.
  assert.deepEqual(dataset.digest(), [['s', 5, 5, [[7, 7], [9, 9]]]]);
  assert.equal(dataset.size, 2);
  assert.equal(dataset.get('s', 5), undefined);
  dataset.offer(entry('s', 6));
  assert.deepEqual(dataset.digest(), [['s', 5, 7, [[9, 9]]]]);
});

test('log: streams beyond maxStreams are refused until one is dropped', () => {
  const { dataset, calls } = log({ maxStreams: 2 });
  fill(dataset, 'a', 1, 3);
  fill(dataset, 'b', 1, 2);
  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(entry('c', 1)), { accepted: false, reason: 'streams-full' });
  assert.equal(calls.check, checksBefore);
  assert.deepEqual(dataset.streams(), ['a', 'b']);
  assert.equal(dataset.syncPage(null, PAGE_LIMITS).hint.full, true);

  assert.equal(dataset.dropStream('a'), true);
  assert.equal(dataset.dropStream('a'), false);
  assert.equal(dataset.size, 2);
  assert.equal(dataset.floorOf('a'), undefined);
  assert.equal(dataset.offer(entry('c', 1)).accepted, true);
  assert.deepEqual(dataset.streams(), ['b', 'c']);
  assert.equal(dataset.streamCount, 2);
});

test('log: raiseFloor prunes, only ever rises, and can pre-empt a stream', () => {
  const { dataset } = log({ maxStreams: 2 });
  fill(dataset, 's', 1, 10);
  dataset.offer(entry('s', 14));

  dataset.raiseFloor('s', 4);
  assert.deepEqual(dataset.digest(), [['s', 4, 10, [[14, 14]]]]);
  assert.equal(dataset.size, 7);
  dataset.raiseFloor('s', 2);
  assert.equal(dataset.floorOf('s'), 4);

  // Past the contiguous part: the out-of-order record at 14 survives, 12 does not exist.
  dataset.raiseFloor('s', 12);
  assert.deepEqual(dataset.digest(), [['s', 12, 12, [[14, 14]]]]);
  assert.equal(dataset.size, 1);
  dataset.offer(entry('s', 13));
  assert.deepEqual(dataset.digest(), [['s', 12, 14]]);

  // Past everything.
  dataset.raiseFloor('s', 50);
  assert.deepEqual(dataset.digest(), [['s', 50, 50]]);
  assert.equal(dataset.size, 0);
  assert.equal(dataset.topOf('s'), 50);
  assert.deepEqual(dataset.offer(entry('s', 50)), { accepted: false, reason: 'pruned' });
  assert.equal(dataset.offer(entry('s', 51)).accepted, true);

  // A stream we have not seen yet can be given a floor in advance.
  dataset.raiseFloor('later', 7);
  assert.deepEqual(dataset.offer(entry('later', 7)), { accepted: false, reason: 'pruned' });
  assert.equal(dataset.offer(entry('later', 8)).accepted, true);

  assert.throws(() => dataset.raiseFloor('third', 1), StateError);
  assert.throws(() => dataset.raiseFloor('has space', 1), ConfigError);
  assert.throws(() => dataset.raiseFloor('s', -1), ConfigError);
  assert.throws(() => dataset.raiseFloor('s', 1.5), ConfigError);
});

test('log: get and range read held records only', () => {
  const { dataset } = log();
  fill(dataset, 's', 1, 4);
  dataset.offer(entry('s', 7));
  dataset.offer(entry('s', 9));

  assert.deepEqual(dataset.get('s', 3), entry('s', 3));
  assert.equal(dataset.get('s', 5), undefined);
  assert.equal(dataset.get('nope', 1), undefined);

  assert.deepEqual(dataset.range('s', 3, 8).map(r => r.n), [3, 4, 7]);
  assert.deepEqual(dataset.range('s', 1, MAX_INDEX).map(r => r.n), [1, 2, 3, 4, 7, 9]);
  assert.deepEqual(dataset.range('s', -5, 2).map(r => r.n), [1, 2]);
  assert.deepEqual(dataset.range('s', 5, 6), []);
  assert.deepEqual(dataset.range('s', 8, 3), []);
  assert.deepEqual(dataset.range('nope', 1, 10), []);
  assert.deepEqual(dataset.range('s', 1.5, 3), []);
  assert.deepEqual(dataset.range('s', 1, '3'), []);
});

/** A stream holding only the even indices 2..2*count: `count` separate ranges. */
function fillSparse(dataset, stream, count) {
  for (let n = 2; n <= 2 * count; n += 2) {
    assert.equal(dataset.offer(entry(stream, n)).accepted, true, `${stream}#${n}`);
  }
}

const evens = (from, to) => {
  const ranges = [];
  for (let n = from; n <= to; n += 2) ranges.push([n, n]);
  return ranges;
};

test('log: digest lists every out-of-order range, however many there are', () => {
  const count = 2 * MAX_RANGES + 8;
  const { dataset } = log();
  fillSparse(dataset, 's', count);
  assert.deepEqual(dataset.digest(), [['s', 0, 0, evens(2, 2 * count)]]);

  // A complete digest is not a wire page: diff takes it whole, and two datasets with
  // different contents never have equal digests.
  const other = log().dataset;
  fillSparse(other, 's', count);
  assert.deepEqual(other.diff(dataset.digest()), { want: [], have: [], truncated: false });
  other.offer(entry('s', 2 * count + 2));
  assert.notDeepEqual(other.digest(), dataset.digest());
  assert.deepEqual(dataset.diff(other.digest()).want, [['s', 2 * count + 2, 2 * count + 2]]);
});

test('log: a stream with more than MAX_RANGES ranges is paged inside the stream', () => {
  const count = 2 * MAX_RANGES + 8;
  const top = 2 * count;
  const { dataset } = log();
  fill(dataset, 'r', 1, 3);
  fillSparse(dataset, 's', count);
  fill(dataset, 't', 1, 2);

  // The page ends with the sparse stream, at the end of the last range it lists, and
  // names the stream's newest index so the receiver knows where the window will be.
  const first = dataset.syncPage(null, PAGE_LIMITS);
  assert.deepEqual(first.entries, [
    ['r', 0, 3],
    ['s', 0, 0, evens(2, 2 * MAX_RANGES), top],
  ]);
  assert.deepEqual(first.upto, ['s', 2 * MAX_RANGES]);

  // The next page restarts there and lists only what lies above.
  const second = dataset.syncPage(first.upto, PAGE_LIMITS);
  assert.deepEqual(second.after, ['s', 2 * MAX_RANGES]);
  assert.deepEqual(second.entries, [['s', 0, 0, evens(2 * MAX_RANGES + 2, 4 * MAX_RANGES), top]]);
  assert.deepEqual(second.upto, ['s', 4 * MAX_RANGES]);

  // The last page of the stream is an ordinary one: it carries on with the next stream.
  const third = dataset.syncPage(second.upto, PAGE_LIMITS);
  assert.deepEqual(third.entries, [
    ['s', 0, 0, evens(4 * MAX_RANGES + 2, top)],
    ['t', 0, 2],
  ]);
  assert.equal(third.upto, null);

  // Every page is accepted by a peer, and three of them carry the whole stream across.
  const peer = log().dataset;
  for (const page of [first, second, third]) {
    for (const step of steps(peer.syncReconcile(page))) {
      assert.ok(step.want !== undefined, 'an empty peer has nothing to push');
      const [stream, from, to] = step.want;
      for (const record of dataset.range(stream, from, to)) peer.offer(record);
    }
  }
  assert.deepEqual(peer.digest(), dataset.digest());

  // A cursor that falls inside a range lists the rest of that range only.
  const dense = log().dataset;
  fill(dense, 'd', 1, 2);
  for (const n of [5, 6, 7, 8, 11]) dense.offer(entry('d', n));
  assert.deepEqual(dense.syncPage(['d', 6], PAGE_LIMITS).entries, [['d', 0, 2, [[7, 8], [11, 11]]]]);
  assert.deepEqual(dense.syncPage(['d', 8], PAGE_LIMITS).entries, [['d', 0, 2, [[11, 11]]]]);
  assert.deepEqual(dense.syncPage(['d', 11], PAGE_LIMITS).entries, [['d', 0, 2]]);
  assert.deepEqual(dense.syncPage(['d', 1], PAGE_LIMITS).entries, [['d', 0, 2, [[5, 8], [11, 11]]]]);
});

test('log: a page that ends inside a stream is reconciled up to its end only', () => {
  const { dataset } = log();
  for (const n of [1, 2, 3, 6, 9, 20, 21, 30]) dataset.offer(entry('s', n));
  fill(dataset, 't', 1, 2);

  // The peer says what it holds in s up to 12; what lies beyond is the next page's job.
  const page = {
    after: null,
    upto: ['s', 12],
    entries: [['s', 0, 1, [[4, 4], [8, 9], [12, 12]], 40]],
    hint: { win: MAX_INDEX },
  };
  assert.deepEqual(
    steps(dataset.syncReconcile(page)).map(s => (s.want ? ['want', s.want[1], s.want[2]] : ['push', s.push.n])),
    [['push', 2], ['push', 3], ['want', 4, 4], ['push', 6], ['want', 8, 8], ['want', 12, 12]],
  );
  // Nothing of stream t, which lies after the page, and nothing above 12.
  assert.ok(steps(dataset.syncReconcile(page)).every(s => s.cursor[0] === 's' && s.cursor[1] <= 12));

  // The continuation covers the rest: above 12 in s, then t.
  const rest = {
    after: ['s', 12],
    upto: null,
    entries: [['s', 0, 1, [[21, 22], [40, 40]]]],
    hint: { win: MAX_INDEX },
  };
  assert.deepEqual(
    steps(dataset.syncReconcile(rest)).map(s => (s.want ? ['want', s.want[1], s.want[2]] : ['push', s.push.s, s.push.n])),
    [['push', 's', 20], ['want', 22, 22], ['push', 's', 30], ['want', 40, 40], ['push', 't', 1], ['push', 't', 2]],
  );

  // The newest index a truncated entry names sets the retention window: with room for
  // 5 and the peer at 40, nothing at or below 35 is worth asking for.
  const small = log({ maxPerStream: 5 }).dataset;
  assert.deepEqual(steps(small.syncReconcile(page)), []);
  const near = { ...page, entries: [['s', 0, 1, [[4, 4], [8, 9], [12, 12]], 14]] };
  assert.deepEqual(steps(small.syncReconcile(near)).map(s => s.want), [['s', 12, 12]]);

  // A range that runs past the end of the page is cut there, not rejected.
  const over = { after: null, upto: ['s', 5], entries: [['s', 0, 0, [[4, 9]]]], hint: { win: MAX_INDEX } };
  assert.deepEqual(
    steps(log().dataset.syncReconcile(over)).map(s => s.want),
    [['s', 4, 5]],
  );
});

test('log: diff names the ranges we lack and the records the remote lacks', () => {
  const { dataset } = log();
  fill(dataset, 's1', 1, 5);
  fill(dataset, 's2', 1, 3);
  dataset.offer(entry('s2', 7));
  dataset.offer(entry('s2', 8));
  fill(dataset, 's4', 1, 2);

  const remote = [
    ['s1', 0, 8],
    ['s2', 0, 5, [[10, 12]]],
    ['s3', 0, 2],
  ];
  const { want, have, truncated } = dataset.diff(remote);
  assert.deepEqual(want, [
    ['s1', 6, 8],
    ['s2', 4, 5],
    ['s2', 10, 12],
    ['s3', 1, 2],
  ]);
  assert.deepEqual(have.map(r => [r.s, r.n]), [['s2', 7], ['s2', 8], ['s4', 1], ['s4', 2]]);
  assert.equal(truncated, false);

  assert.deepEqual(dataset.diff(dataset.digest()), { want: [], have: [], truncated: false });
});

test('log: diff interleaves wanted ranges and held records by index', () => {
  const { dataset } = log();
  for (const n of [1, 2, 6, 7, 12]) dataset.offer(entry('s', n));
  // The remote holds 3..4 and 9..10 and nothing else.
  const page = { after: null, upto: null, entries: [['s', 2, 4, [[9, 10]]]], hint: { win: MAX_INDEX } };
  assert.deepEqual(
    steps(dataset.syncReconcile(page)).map(s => (s.want ? ['want', ...s.want.slice(1), s.cursor[1]] : ['push', s.push.n, s.cursor[1]])),
    [
      ['want', 3, 4, 4],
      ['push', 6, 6],
      ['push', 7, 7],
      ['want', 9, 10, 10],
      ['push', 12, 12],
    ],
  );
});

test('log: floors are respected in both directions of a diff', () => {
  const { dataset } = log();
  fill(dataset, 's', 1, 10);

  // The remote pruned everything up to 6 and holds nothing above: offer 7..10 only.
  assert.deepEqual(dataset.diff([['s', 6, 6]]).have.map(r => r.n), [7, 8, 9, 10]);
  assert.deepEqual(dataset.diff([['s', 6, 6]]).want, []);
  // The remote pruned past everything we hold: nothing to offer, nothing to ask.
  assert.deepEqual(dataset.diff([['s', 30, 30]]), { want: [], have: [], truncated: false });

  // Our own floor: what we pruned is never asked for again.
  const pruned = log().dataset;
  pruned.raiseFloor('s', 5);
  assert.deepEqual(pruned.diff([['s', 0, 10]]).want, [['s', 6, 10]]);
  pruned.raiseFloor('s', 10);
  assert.deepEqual(pruned.diff([['s', 0, 10]]).want, []);
});

test('log: diff asks only for what the retention window will keep', () => {
  const { dataset } = log({ maxPerStream: 5 });
  assert.deepEqual(dataset.diff([['s', 0, 100]]).want, [['s', 96, 100]]);
  assert.deepEqual(dataset.diff([['s', 0, 3]]).want, [['s', 1, 3]]);

  fill(dataset, 's', 1, 3);
  // The remote's out-of-order top decides the window, not its contiguous mark.
  assert.deepEqual(dataset.diff([['s', 0, 4, [[40, 41]]]]).want, [['s', 40, 41]]);
  // diff() does not know the remote's window, so it offers what the remote lacks ...
  assert.deepEqual(dataset.diff([['s', 0, 2, [[40, 41]]]]).have, [entry('s', 3)]);
  // ... while a page that carries the window (5: the remote keeps 37..41) gets nothing.
  const page = { after: null, upto: null, entries: [['s', 0, 2, [[40, 41]]]], hint: { win: 5 } };
  assert.deepEqual(steps(dataset.syncReconcile(page)), [{ cursor: ['s', 41], want: ['s', 40, 41] }]);
});

test('log: diff caps the records it returns and says so', () => {
  const { dataset } = log();
  fill(dataset, 's', 1, 50);
  const capped = dataset.diff([], { maxHave: 20 });
  assert.equal(capped.have.length, 20);
  assert.deepEqual(capped.have.map(r => r.n), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(capped.truncated, true);
  assert.equal(dataset.diff([]).have.length, 50);
  assert.equal(dataset.diff([]).truncated, false);
});

test('log: at stream capacity diff does not ask for streams it cannot track', () => {
  const { dataset } = log({ maxStreams: 2 });
  fill(dataset, 'b', 1, 2);
  const remote = [['a', 0, 3], ['b', 0, 4], ['c', 0, 3], ['d', 0, 3]];
  // One slot is free: the first unknown stream gets it, the others are left alone.
  assert.deepEqual(dataset.diff(remote).want, [['a', 1, 3], ['b', 3, 4]]);
  fill(dataset, 'a', 1, 3);
  assert.deepEqual(dataset.diff(remote).want, [['b', 3, 4]]);
});

test('log: diff rejects malformed digests', () => {
  const { dataset } = log();
  const bad = [
    'nope',
    [['b', 0, 1], ['a', 0, 1]],
    [['a', 0, 1], ['a', 0, 2]],
    [['a', 0]],
    [['a', 0, 1, [], 5]],
    [['a', 2, 1]],
    [['a', -1, 1]],
    [['a', 0, 1.5]],
    [['has space', 0, 1]],
    [['a', 0, 1, []]],
    [['a', 0, 1, 'x']],
    [['a', 0, 1, [[2, 3]]]],
    [['a', 0, 1, [[5, 4]]]],
    [['a', 0, 1, [[3, 4], [5, 6]]]],
    [['a', 0, 1, [[3, 4], [3, 9]]]],
    [['a', 0, 1, [[3]]]],
    [['a', 0, 1, [[3, 2 ** 53]]]],
    [null],
  ];
  for (const digest of bad) assertFault(() => dataset.diff(digest), 'bad-digest');

  // A complete digest lists every range, however many: digest() itself produces such
  // entries, and diff(digest()) must work. The MAX_RANGES cap is a limit of wire pages
  // (a page that would exceed it ends inside the stream instead), so syncReconcile
  // still refuses the same entry.
  const many = [['a', 0, 1, Array.from({ length: MAX_RANGES + 1 }, (_, i) => [3 + 2 * i, 3 + 2 * i])]];
  // Index 1 (the contiguous part) and each of the 33 ranges.
  assert.equal(dataset.diff(many).want.length, 1 + MAX_RANGES + 1);
  assertFault(
    () => dataset.syncReconcile({ after: null, upto: null, entries: many, hint: { win: 10 } }),
    'bad-digest',
  );
});

test('log: syncPage pages by stream and restarts inside a stream from a cursor', () => {
  const { dataset } = log({ maxPerStream: 50, maxStreams: 4 });
  for (const stream of ['a', 'b', 'c', 'd']) fill(dataset, stream, 1, 3);

  const first = dataset.syncPage(null, { maxEntries: 2, maxBytes: 1 << 20 });
  assert.deepEqual(first, {
    after: null,
    upto: ['b', MAX_INDEX],
    entries: [['a', 0, 3], ['b', 0, 3]],
    hint: { win: 50, full: true },
  });
  // A whole-stream cursor starts with the next stream ...
  const second = dataset.syncPage(['b', MAX_INDEX], { maxEntries: 2, maxBytes: 1 << 20 });
  assert.deepEqual(second.entries, [['c', 0, 3], ['d', 0, 3]]);
  assert.equal(second.upto, null);
  // ... a cursor inside a stream starts with that stream again.
  const inside = dataset.syncPage(['b', 2], { maxEntries: 1, maxBytes: 1 << 20 });
  assert.deepEqual(inside.entries, [['b', 0, 3]]);
  assert.deepEqual(inside.upto, ['b', MAX_INDEX]);
  // A cursor between streams starts with the next one that exists.
  assert.deepEqual(dataset.syncPage(['bb', 4], PAGE_LIMITS).entries, [['c', 0, 3], ['d', 0, 3]]);

  // ["a",0,3], is 10 bytes: a 25-byte budget holds two entries.
  assert.equal(dataset.syncPage(null, { maxEntries: 100, maxBytes: 25 }).entries.length, 2);
  assert.equal(dataset.syncPage(null, { maxEntries: 100, maxBytes: 1 }).entries.length, 1);

  dataset.dropStream('d');
  assert.deepEqual(dataset.syncPage(null, PAGE_LIMITS).hint, { win: 50 });
});

test('log: syncReconcile only looks above a cursor inside a stream', () => {
  const { dataset } = log();
  fill(dataset, 'a', 1, 9);
  fill(dataset, 'b', 1, 6);
  fill(dataset, 'c', 1, 2);

  // The peer holds a:1..3 and b:1..10; the exchange already covered b up to 7.
  const page = {
    after: ['b', 7],
    upto: null,
    entries: [['b', 0, 10]],
    hint: { win: MAX_INDEX },
  };
  assert.deepEqual(steps(dataset.syncReconcile(page)), [
    { cursor: ['b', 10], want: ['b', 8, 10] },
    { cursor: ['c', 1], push: dataset.get('c', 1) },
    { cursor: ['c', 2], push: dataset.get('c', 2) },
  ]);

  // The same restriction applies to pushes.
  const pushes = { after: ['a', 6], upto: ['a', MAX_INDEX], entries: [['a', 0, 3]], hint: { win: MAX_INDEX } };
  assert.deepEqual(steps(dataset.syncReconcile(pushes)).map(s => s.cursor), [['a', 7], ['a', 8], ['a', 9]]);

  // pushAfter: nothing at or before the cursor is pushed again, wants are unaffected.
  const whole = { after: null, upto: null, entries: [['b', 0, 10]], hint: { win: MAX_INDEX } };
  assert.deepEqual(
    steps(dataset.syncReconcile(whole, { pushAfter: ['a', 7] })).map(s => s.cursor),
    [['a', 8], ['a', 9], ['b', 10], ['c', 1], ['c', 2]],
  );
  assert.deepEqual(
    steps(dataset.syncReconcile(whole, { pushAfter: ['c', MAX_INDEX] })).map(s => s.cursor),
    [['b', 10]],
  );
  assert.deepEqual(steps(dataset.syncReconcile(whole, { push: false })).map(s => s.cursor), [['b', 10]]);
});

test('log: syncReconcile pushes only what the peer says it can keep', () => {
  const { dataset } = log();
  fill(dataset, 'a', 1, 10);
  fill(dataset, 'b', 1, 4);

  // A window of 3: of our ten records the peer keeps the last three.
  const narrow = { after: null, upto: null, entries: [], hint: { win: 3 } };
  assert.deepEqual(
    steps(dataset.syncReconcile(narrow)).map(s => s.cursor),
    [['a', 8], ['a', 9], ['a', 10], ['b', 2], ['b', 3], ['b', 4]],
  );

  // A peer that cannot track another stream gets nothing for streams it did not list,
  // and still gets what it lacks in the streams it did.
  const full = { after: null, upto: null, entries: [['b', 0, 2]], hint: { win: 100, full: true } };
  assert.deepEqual(steps(dataset.syncReconcile(full)).map(s => s.cursor), [['b', 3], ['b', 4]]);
});

test('log: syncReconcile rejects malformed pages', () => {
  const { dataset } = log();
  const page = overrides => ({ after: null, upto: null, entries: [], hint: { win: 10 }, ...overrides });

  assertFault(() => dataset.syncReconcile(page({ entries: {} })), 'bad-digest');
  assertFault(() => dataset.syncReconcile(page({ after: ['c', 4], entries: [['b', 0, 1]] })), 'bad-digest');
  assertFault(
    () => dataset.syncReconcile(page({ after: ['b', MAX_INDEX], entries: [['b', 0, 1]] })),
    'bad-digest',
  );
  assertFault(
    () => dataset.syncReconcile(page({ upto: ['b', MAX_INDEX], entries: [['c', 0, 1]] })),
    'bad-digest',
  );
  assert.doesNotThrow(() => dataset.syncReconcile(page({ after: ['b', 4], entries: [['b', 0, 9]] })));

  assertFault(() => dataset.syncReconcile(page({ after: 'b' })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ after: ['b'] })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ after: ['b', -1] })), 'bad-cursor');
  // A page may end inside a stream (after MAX_RANGES ranges); a malformed end may not.
  assert.doesNotThrow(() => dataset.syncReconcile(page({ upto: ['b', 5] })));
  assertFault(() => dataset.syncReconcile(page({ upto: ['b', 5.5] })), 'bad-cursor');
  assertFault(() => dataset.syncReconcile(page({ upto: ['b', 5, 1] })), 'bad-cursor');
  assertFault(
    () => dataset.syncReconcile(page({ after: ['c', 1], upto: ['b', MAX_INDEX] })),
    'bad-cursor',
  );

  assertFault(() => dataset.syncReconcile(page({ hint: {} })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { win: 0 } })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { win: 10, full: false } })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: { win: 10, extra: 1 } })), 'bad-hint');
  assertFault(() => dataset.syncReconcile(page({ hint: 'x' })), 'bad-hint');
});

test('log: syncServe answers only for ranges the page advertised, however large they claim to be', () => {
  const { dataset } = log();
  fill(dataset, 'a', 1, 6);
  dataset.offer(entry('a', 9));
  fill(dataset, 'b', 1, 3);
  dataset.raiseFloor('b', 1);
  const page = dataset.syncPage(null, PAGE_LIMITS);
  assert.deepEqual(page.entries, [['a', 0, 6, [[9, 9]]], ['b', 1, 3]]);

  assert.deepEqual(steps(dataset.syncServe([['a', 5, 9], ['b', 2, 3]], page)), [
    { cursor: ['a', 5], record: dataset.get('a', 5) },
    { cursor: ['a', 6], record: dataset.get('a', 6) },
    { cursor: ['a', 9], record: dataset.get('a', 9) },
    { cursor: ['b', 2], record: dataset.get('b', 2) },
    { cursor: ['b', 3], record: dataset.get('b', 3) },
  ]);
  assert.deepEqual(steps(dataset.syncServe([], page)), []);

  // Ranges beyond what was advertised are a violation, not a reason to scan.
  assertFault(() => dataset.syncServe([['a', 1, MAX_INDEX]], page), 'bad-range');
  assertFault(() => dataset.syncServe([['a', 1, 10]], page), 'bad-range');
  assertFault(() => dataset.syncServe([['b', 1, 3]], page), 'bad-range');
  assertFault(() => dataset.syncServe([['zz', 1, 2]], page), 'bad-range');
  assertFault(() => dataset.syncServe([['a', 1, 2], ['b', 2, 3]], page, ['a', MAX_INDEX]), 'bad-range');
  assertFault(() => dataset.syncServe([['a', 1, 6]], page, ['a', 5]), 'bad-range');
  assert.deepEqual(
    steps(dataset.syncServe([['a', 1, 5]], page, ['a', 5])).map(s => s.cursor[1]),
    [1, 2, 3, 4, 5],
  );

  assertFault(() => dataset.syncServe({}, page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 1]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 0, 2]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 3, 2]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 1, 2.5]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 1, 2 ** 53]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['has space', 1, 2]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['b', 2, 3], ['a', 1, 2]], page), 'bad-request');
  assertFault(() => dataset.syncServe([['a', 1, 3], ['a', 3, 5]], page), 'bad-request');
  assertFault(() => dataset.syncServe(['a'], page), 'bad-request');

  // A page that restarted inside a stream does not serve what lies before its cursor.
  const inside = dataset.syncPage(['a', 4], PAGE_LIMITS);
  assertFault(() => dataset.syncServe([['a', 4, 6]], inside), 'bad-range');
  assert.deepEqual(steps(dataset.syncServe([['a', 5, 6]], inside)).map(s => s.cursor[1]), [5, 6]);

  // Records pruned after the page went out are skipped.
  dataset.raiseFloor('a', 5);
  assert.deepEqual(steps(dataset.syncServe([['a', 1, 9]], page)).map(s => s.cursor[1]), [6, 9]);
  dataset.dropStream('b');
  assert.deepEqual(steps(dataset.syncServe([['b', 2, 3]], page)), []);
});

test('log: cursors are [stream, index] pairs ordered by stream, then index', () => {
  const { dataset } = log();
  assert.deepEqual(dataset.syncCursor(['s', 4]), ['s', 4]);
  assert.deepEqual(dataset.syncCursor(['s', 0]), ['s', 0]);
  assert.deepEqual(dataset.syncCursor(['s', MAX_INDEX]), ['s', MAX_INDEX]);
  for (const value of [null, 's', ['s'], ['s', 1, 2], ['s', -1], ['s', 1.5], ['s', 2 ** 53], ['', 1], [1, 1], {}]) {
    assertFault(() => dataset.syncCursor(value), 'bad-cursor');
  }
  assert.ok(dataset.syncCompare(['a', 9], ['b', 1]) < 0);
  assert.ok(dataset.syncCompare(['b', 1], ['a', 9]) > 0);
  assert.ok(dataset.syncCompare(['a', 1], ['a', 2]) < 0);
  assert.ok(dataset.syncCompare(['a', 2], ['a', 1]) > 0);
  assert.equal(dataset.syncCompare(['a', 2], ['a', 2]), 0);

  const page = { after: null, upto: null, entries: [['b', 0, 5], ['d', 0, 5]], hint: { win: 9 } };
  assert.equal(dataset.syncConsumed(page, ['a', MAX_INDEX]), 0);
  assert.equal(dataset.syncConsumed(page, ['b', 3]), 0);
  assert.equal(dataset.syncConsumed(page, ['b', MAX_INDEX]), 1);
  assert.equal(dataset.syncConsumed(page, ['c', 1]), 1);
  assert.equal(dataset.syncConsumed(page, ['d', MAX_INDEX]), 2);
  assert.equal(dataset.syncConsumed(page, ['z', 0]), 2);
});

test('log: two datasets reconcile to the same contents through diff alone', () => {
  const left = log({ maxPerStream: 8 }).dataset;
  const right = log({ maxPerStream: 8 }).dataset;
  for (const n of [1, 2, 3, 7, 12]) left.offer(entry('x', n));
  for (const n of [2, 4, 5, 6, 13, 14]) right.offer(entry('x', n));
  fill(left, 'only-left', 1, 3);
  fill(right, 'only-right', 5, 6);

  // One push-pull exchange in each direction, as the engine performs it.
  for (const [from, to] of [[left, right], [right, left]]) {
    const { want, have } = to.diff(from.digest());
    for (const record of have) from.offer(record);
    for (const [stream, first, last] of want) {
      for (const record of from.range(stream, first, last)) to.offer(record);
    }
  }
  assert.deepEqual(left.digest(), right.digest());
  // top is 14 and the window is 8: both keep what exists in 7..14.
  assert.deepEqual(left.digest(), [
    ['only-left', 0, 3],
    ['only-right', 0, 0, [[5, 6]]],
    ['x', 6, 7, [[12, 14]]],
  ]);
  assert.deepEqual(left.diff(right.digest()), { want: [], have: [], truncated: false });
});

// ---------------------------------------------------------------------------------------
// DESIGN.md section 15
// ---------------------------------------------------------------------------------------

/** Two records of key `k` with version `v`, ordered by hash: [lower, higher]. */
function tie(k, v) {
  const one = kv(k, v, { note: 'one' });
  const two = kv(k, v, { note: 'two' });
  return recordHash(one) < recordHash(two) ? [one, two] : [two, one];
}

test('15.14: lww records are totally ordered; at equal version the greater hash wins and counts as accepted', () => {
  const events = [];
  const { dataset, calls } = lww({ onEquivocation: e => events.push(e) });
  const [lower, higher] = tie('a', 5);

  assert.deepEqual(dataset.offer(lower, 'p1'), { accepted: true, isNew: true });
  assert.deepEqual(dataset.digest(), [['a', 5, recordHash(lower).slice(0, 16)]]);
  // The greater hash is accepted (so the engine floods it on) and replaces the record.
  assert.deepEqual(dataset.offer(higher, 'p2'), { accepted: true, isNew: false });
  assert.equal(dataset.get('a'), higher);
  assert.deepEqual(calls.accepted.at(-1), ['a', 5, false, 'p2']);
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0] }, { key: 'a', version: 5, kept: higher, rejected: lower });

  // The loser again is stale without a check; the winner again is a duplicate.
  const checks = calls.check;
  assert.deepEqual(dataset.offer({ ...lower }), { accepted: false, reason: 'stale' });
  assert.deepEqual(dataset.offer({ ...higher }), { accepted: false, reason: 'duplicate' });
  assert.equal(calls.check, checks);
  assert.equal(events.length, 1, 'reported once per key and version');

  // Arriving the other way round gives the same result everywhere.
  const other = lww({ onEquivocation: e => events.push(e) });
  assert.equal(other.dataset.offer(higher).accepted, true);
  assert.deepEqual(other.dataset.offer(lower), { accepted: false, reason: 'stale' });
  assert.equal(other.dataset.get('a'), higher);
  assert.equal(events.length, 2);
  assert.equal(events[1].kept, higher);

  // A newer version starts the tie-break of the key afresh.
  assert.equal(dataset.offer(kv('a', 6)).accepted, true);
  const [lower7] = tie('a', 7);
  assert.equal(dataset.offer(lower7).accepted, true);
});

test('15.14: a tie is checked before it counts: a forged tie is invalid and reports nothing', () => {
  const events = [];
  const { dataset } = lww({ onEquivocation: e => events.push(e) });
  const [lower, higher] = tie('a', 5);
  dataset.offer(lower);
  assert.deepEqual(dataset.offer({ ...higher, bad: true }), {
    accepted: false,
    reason: 'bad-signature',
    invalid: true,
  });
  assert.equal(dataset.get('a'), lower);
  assert.deepEqual(events, []);
  // A record that is not canonical-JSON data has no hash and cannot take part.
  assert.deepEqual(dataset.offer(kv('a', 5, { x: 1.5 })), { accepted: false, reason: 'malformed', invalid: true });
  assert.deepEqual(dataset.offer(kv('b', 1, { x: 1.5 })), { accepted: false, reason: 'malformed', invalid: true });
});

test('15.14: reconcile compares (version, hash): ties move towards the greater hash', () => {
  const [lower, higher] = tie('a', 5);
  const low = lww().dataset;
  const high = lww().dataset;
  low.offer(lower);
  high.offer(higher);
  // Each side sees the other's digest: the low side wants, the high side pushes.
  assert.deepEqual(low.diff(high.digest()), { missingHere: ['a'], missingThere: [] });
  assert.deepEqual(high.diff(low.digest()), { missingHere: [], missingThere: [higher] });
  // Equal (version, hash): nothing to do.
  assert.deepEqual(high.diff(high.digest()), { missingHere: [], missingThere: [] });
});

test('15.19: lww eviction prefers keys of low priority; priorityChanged() rereads it', () => {
  const rank = new Map([['attached', 1]]);
  const { dataset, calls } = lww({ maxEntries: 2, priority: k => rank.get(k) ?? 0 });
  dataset.offer(kv('attached', 1));
  dataset.offer(kv('loose', 9));
  // An unattached newcomer with a higher version beats the unattached record ...
  assert.equal(dataset.offer(kv('other', 10)).accepted, true);
  assert.deepEqual(seqs(dataset), [['attached', 1], ['other', 10]]);
  // ... but never displaces the attached one, whatever its version.
  const checks = calls.check;
  assert.deepEqual(dataset.offer(kv('zzz', 5)), { accepted: false, reason: 'full' });
  assert.equal(calls.check, checks);
  // An attached newcomer beats any unattached record, even with a low version.
  rank.set('new', 1);
  dataset.priorityChanged();
  assert.equal(dataset.offer(kv('new', 0)).accepted, true);
  assert.deepEqual(seqs(dataset), [['attached', 1], ['new', 0]]);
  // Between attached keys the version decides, as without priorities.
  rank.set('peer', 1);
  dataset.priorityChanged();
  assert.deepEqual(dataset.offer(kv('peer', 0)), { accepted: false, reason: 'full' });
  assert.equal(dataset.offer(kv('peer', 2)).accepted, true);
  assert.deepEqual(seqs(dataset), [['attached', 1], ['peer', 2]]);
  // A priority function that throws counts as 0.
  const odd = lww({
    maxEntries: 1,
    priority: () => {
      throw new Error('no');
    },
  }).dataset;
  odd.offer(kv('a', 1));
  assert.equal(odd.offer(kv('b', 2)).accepted, true);
});

test('lww: syncKnows, syncKey and syncSummary', () => {
  const { dataset } = lww();
  dataset.offer(kv('a', 1));
  dataset.offer(kv('b', 2));
  dataset.remove('b');
  assert.equal(dataset.syncKnows(kv('a', 9)), true);
  assert.equal(dataset.syncKnows(kv('b', 9)), true, 'a removed key is known');
  assert.equal(dataset.syncKnows(kv('c', 1)), false);
  assert.equal(dataset.syncKnows({ k: 'has space', v: 1 }), true, 'malformed: let offer() say so');
  assert.equal(dataset.syncKey(kv('a', 1)), 'a');
  assert.equal(dataset.syncKey(null), null);

  // The summary is the hash of the whole digest, tombstones included, and follows changes.
  const twin = lww().dataset;
  twin.offer(kv('a', 1));
  assert.notEqual(twin.syncSummary(), dataset.syncSummary());
  twin.offer(kv('b', 2));
  twin.remove('b');
  assert.equal(twin.syncSummary(), dataset.syncSummary());
  assert.match(dataset.syncSummary(), /^[0-9a-f]{64}$/);
  const before = dataset.syncSummary();
  dataset.forget('b');
  assert.notEqual(dataset.syncSummary(), before);
  dataset.offer(kv('c', 1));
  assert.notEqual(dataset.syncSummary(), twin.syncSummary());
});

test('15.16: a peer delivering our own stream at or above what we knew is reported', () => {
  const events = [];
  const { dataset } = log({ ownStream: s => s === 'mine', onSelfNewer: e => events.push(e) });
  // Our own publishes (no `from`) are never reported.
  assert.deepEqual(dataset.offer(entry('mine', 1)), { accepted: true, isNew: true });
  assert.deepEqual(dataset.offer(entry('mine', 2)), { accepted: true, isNew: true });
  // From a peer: a gap below our newest index is just filled in ...
  dataset.offer(entry('mine', 4));
  assert.deepEqual(dataset.offer(entry('mine', 3), 'peer'), { accepted: true, isNew: true });
  // ... at or above it, the record is ours from before a restart: jump past it.
  const ahead = entry('mine', 9);
  assert.deepEqual(dataset.offer(ahead, 'peer'), { accepted: true, isNew: true, selfNewer: 9 });
  assert.deepEqual(events.map(e => ({ ...e })), [{ stream: 'mine', index: 9, record: ahead }]);
  // Someone else's stream is not ours, and a duplicate is not reported again.
  assert.deepEqual(dataset.offer(entry('theirs', 50), 'peer'), { accepted: true, isNew: true });
  assert.deepEqual(dataset.offer(ahead, 'peer'), { accepted: false, reason: 'duplicate' });
  assert.equal(events.length, 1);
  // A stream of ours we know nothing of (fresh data directory) is reported from its first record.
  const fresh = log({ ownStream: () => true }).dataset;
  assert.equal(fresh.offer(entry('mine', 1), 'peer').selfNewer, 1);
});

test('15.19: log streams beyond maxStreams displace a stream of lower priority', () => {
  const rank = new Map([['keep', 2], ['vip', 3]]);
  const { dataset } = log({ maxStreams: 2, priority: s => rank.get(s) ?? 0 });
  fill(dataset, 'keep', 1, 2);
  fill(dataset, 'loose', 1, 3);
  assert.deepEqual(dataset.offer(entry('other', 1)), { accepted: false, reason: 'streams-full' });
  assert.deepEqual(dataset.offer(entry('vip', 1)), { accepted: true, isNew: true });
  assert.deepEqual(dataset.streams(), ['keep', 'vip']);
  assert.equal(dataset.size, 3);
  // Reconcile asks for a stream that would win a place, not for one that would not.
  const page = { after: null, upto: null, entries: [['a', 0, 2], ['top', 0, 1]], hint: { win: 10 } };
  assert.deepEqual(steps(dataset.syncReconcile(page, { push: false })), []);
  rank.set('top', 9);
  dataset.priorityChanged();
  assert.deepEqual(steps(dataset.syncReconcile(page, { push: false })).map(s => s.want), [['top', 1, 1]]);
});

test('log: syncKnows and syncSummary', () => {
  const { dataset } = log();
  fill(dataset, 's', 1, 3);
  assert.equal(dataset.syncKnows(entry('s', 99)), true);
  assert.equal(dataset.syncKnows(entry('t', 1)), false);
  assert.equal(dataset.syncKnows({ s: 't', n: 0 }), true, 'malformed: let offer() say so');
  assert.equal(typeof dataset.syncKey, 'undefined', 'a log has no hold-down key');

  const twin = log().dataset;
  fill(twin, 's', 1, 2);
  assert.notEqual(twin.syncSummary(), dataset.syncSummary());
  twin.offer(entry('s', 3));
  assert.equal(twin.syncSummary(), dataset.syncSummary());
  twin.raiseFloor('s', 1);
  assert.notEqual(twin.syncSummary(), dataset.syncSummary());
  dataset.raiseFloor('s', 1);
  assert.equal(twin.syncSummary(), dataset.syncSummary());
  dataset.dropStream('s');
  assert.notEqual(twin.syncSummary(), dataset.syncSummary());
});

// ---------------------------------------------------------------------------------------
// DESIGN.md 15.7: a record that cannot fit in a sync packet is refused when it is offered.
// ---------------------------------------------------------------------------------------

test('the largest record leaves room for the packet prefix, a batch header and a frame length', () => {
  assert.equal(MAX_RECORD, 64 * 1024 - RECORD_OVERHEAD);
  assert.equal(RECORD_OVERHEAD, 4 + 64 + 4);
});

test('lww: a record over MAX_RECORD is refused as too-large, before the check runs', () => {
  const { dataset, calls } = lww();
  const edge = kv('edge', 1, { pad: '' });
  const baseSize = Buffer.byteLength(JSON.stringify(edge));
  const atLimit = kv('edge', 1, { pad: 'x'.repeat(MAX_RECORD - baseSize) });
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), MAX_RECORD);
  assert.deepEqual(dataset.offer(atLimit), { accepted: true, isNew: true });

  const over = kv('over', 1, { pad: 'x'.repeat(MAX_RECORD - baseSize + 1) });
  const checksBefore = calls.check;
  assert.deepEqual(dataset.offer(over), { accepted: false, reason: 'too-large', invalid: true });
  assert.equal(calls.check, checksBefore, 'no signature work for a record that cannot be passed on');
  assert.equal(dataset.has('over'), false);

  // An oversize replacement of a held key, at a higher version or at an equal one.
  const newer = kv('edge', 2, { pad: 'x'.repeat(MAX_RECORD) });
  assert.equal(dataset.offer(newer).reason, 'too-large');
  const tie = kv('edge', 1, { pad: 'y'.repeat(MAX_RECORD) });
  assert.equal(dataset.offer(tie).reason, 'too-large');
  assert.deepEqual(dataset.get('edge'), atLimit);
  // Old news is still old news, whatever its size.
  assert.equal(dataset.offer(kv('edge', 0, { pad: 'z'.repeat(MAX_RECORD) })).reason, 'stale');
});

test('log: a record over MAX_RECORD is refused as too-large, before the check runs', () => {
  const { dataset, calls } = log();
  const baseSize = Buffer.byteLength(JSON.stringify(entry('s', 1, { pad: '' })));
  const atLimit = entry('s', 1, { pad: 'x'.repeat(MAX_RECORD - baseSize) });
  assert.deepEqual(dataset.offer(atLimit), { accepted: true, isNew: true });
  const checksBefore = calls.check;
  const over = entry('s', 2, { pad: 'x'.repeat(MAX_RECORD - baseSize + 1) });
  assert.deepEqual(dataset.offer(over), { accepted: false, reason: 'too-large', invalid: true });
  assert.equal(calls.check, checksBefore);
  assert.equal(dataset.get('s', 2), undefined);
  assert.equal(dataset.size, 1);
});
