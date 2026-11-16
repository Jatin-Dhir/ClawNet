import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SeenCache, DEFAULT_MAX_KEY_LENGTH } from '../../src/core/messaging/dedupe.js';
import { ConfigError, StateError, StoreError } from '../../src/core/errors.js';

/** A cache on a hand-driven clock. `clock.t` is the current time in milliseconds. */
function setup(options = {}) {
  const clock = { t: 1_000_000 };
  const cache = new SeenCache({ maxEntries: 100, ttlMs: 1000, monoNow: () => clock.t, wallNow: () => clock.t, ...options });
  return { cache, clock };
}

const keysOf = (cache) => cache.snapshot().map(([key]) => key);

test('add reports whether the key was new and has finds it afterwards', () => {
  const { cache } = setup();
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size, 0);

  assert.equal(cache.add('a'), true);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.add('a'), false);
  assert.equal(cache.add('b'), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('c'), false);
});

test('keys are compared exactly: (id, try) pairs differing in one character are distinct', () => {
  const { cache } = setup();
  const id = '00112233445566778899aabbccddeeff';
  assert.equal(cache.add(`${id}:0`), true);
  assert.equal(cache.add(`${id}:1`), true);
  assert.equal(cache.add(`${id}:0`), false);
  assert.equal(cache.has(`${id}:2`), false);
  assert.equal(cache.has(id), false);
  assert.equal(cache.add(''), true);
  assert.equal(cache.add(''), false);
});

test('an entry lives for exactly ttlMs', () => {
  const { cache, clock } = setup({ ttlMs: 1000 });
  cache.add('a');
  clock.t += 999;
  assert.equal(cache.has('a'), true);
  assert.equal(cache.add('a'), false);
  clock.t += 1;
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.add('a'), true);
  assert.equal(cache.has('a'), true);
});

test('seeing a key again does not extend its lifetime', () => {
  const { cache, clock } = setup({ ttlMs: 1000 });
  cache.add('a');
  for (let i = 0; i < 9; i += 1) {
    clock.t += 100;
    assert.equal(cache.add('a'), false);
    assert.equal(cache.has('a'), true);
  }
  // 900 ms in, replayed nine times: it still expires 1000 ms after the FIRST add.
  clock.t += 100;
  assert.equal(cache.has('a'), false);
});

test('a re-added expired key is queued as the youngest entry', () => {
  const { cache, clock } = setup({ maxEntries: 3, ttlMs: 1000 });
  cache.add('a');
  clock.t += 600;
  cache.add('b');
  clock.t += 600; // 'a' has expired, 'b' has not
  assert.equal(cache.add('a'), true);
  assert.deepEqual(keysOf(cache), ['b', 'a']);
  cache.add('c');
  cache.add('d'); // over capacity: the oldest, 'b', goes
  assert.deepEqual(keysOf(cache), ['a', 'c', 'd']);
});

test('beyond maxEntries the oldest entries are evicted first', () => {
  const { cache } = setup({ maxEntries: 3 });
  for (const key of ['a', 'b', 'c']) cache.add(key);
  assert.equal(cache.size, 3);

  // A duplicate must not disturb the queue order.
  assert.equal(cache.add('a'), false);

  assert.equal(cache.add('d'), true);
  assert.equal(cache.size, 3);
  assert.equal(cache.has('a'), false);
  assert.deepEqual(keysOf(cache), ['b', 'c', 'd']);

  cache.add('e');
  assert.deepEqual(keysOf(cache), ['c', 'd', 'e']);
  // An evicted key is new again.
  assert.equal(cache.add('a'), true);
  assert.deepEqual(keysOf(cache), ['d', 'e', 'a']);
});

test('a flood of unique keys never grows the cache past maxEntries', () => {
  const { cache, clock } = setup({ maxEntries: 500, ttlMs: 60_000 });
  let largest = 0;
  for (let i = 0; i < 100_000; i += 1) {
    if (i % 1000 === 0) clock.t += 1;
    assert.equal(cache.add(`flood-${i}`), true);
    if (i % 997 === 0) largest = Math.max(largest, cache.size);
  }
  assert.equal(largest, 500);
  assert.equal(cache.size, 500);
  assert.equal(cache.has('flood-99999'), true);
  assert.equal(cache.has('flood-99500'), true);
  assert.equal(cache.has('flood-99499'), false);
  assert.equal(cache.snapshot().length, 500);
});

test('expired entries are dropped by add, size, prune and snapshot', () => {
  const { cache, clock } = setup({ ttlMs: 1000 });
  cache.add('a');
  cache.add('b');
  clock.t += 500;
  cache.add('c');

  clock.t += 500; // a and b expire, c has 500 ms left
  assert.equal(cache.prune(), 2);
  assert.equal(cache.prune(), 0);
  assert.deepEqual(keysOf(cache), ['c']);

  cache.add('d');
  clock.t += 500; // c expires
  assert.equal(cache.size, 1);
  assert.deepEqual(keysOf(cache), ['d']);

  clock.t += 500; // d expires; the next add sweeps it out before inserting
  assert.equal(cache.add('e'), true);
  assert.deepEqual(keysOf(cache), ['e']);

  // snapshot() on its own, with nothing else having touched the cache since expiry.
  clock.t += 1000;
  assert.deepEqual(cache.snapshot(), []);
});

test('only strings are accepted as keys', () => {
  const { cache } = setup();
  cache.add('ok');
  const bad = [1, 0, null, undefined, true, {}, [], ['a'], Symbol('k'), 10n, Buffer.from('a')];
  bad.push(new String('a'));
  for (const key of bad) {
    const label = typeof key === 'symbol' ? 'symbol' : Object.prototype.toString.call(key);
    for (const method of ['add', 'has']) {
      assert.throws(
        () => cache[method](key),
        (err) => err instanceof ConfigError && err.code === 'ERR_CONFIG',
        `${method} ${label}`,
      );
    }
  }
  assert.deepEqual(keysOf(cache), ['ok']);
});

test('over-long keys are rejected so that entry size is bounded too', () => {
  assert.equal(DEFAULT_MAX_KEY_LENGTH, 128);
  const { cache } = setup();
  assert.equal(cache.add('k'.repeat(128)), true);
  assert.throws(() => cache.add('k'.repeat(129)), ConfigError);
  assert.throws(() => cache.has('k'.repeat(129)), ConfigError);

  const tight = setup({ maxKeyLength: 4 }).cache;
  assert.equal(tight.add('abcd'), true);
  assert.throws(() => tight.add('abcde'), ConfigError);
  assert.equal(tight.size, 1);
});

test('constructor rejects missing or out-of-range options', () => {
  const monoNow = () => 0;
  const bad = [
    undefined,
    {},
    { maxEntries: 0, ttlMs: 1, monoNow },
    { maxEntries: -1, ttlMs: 1, monoNow },
    { maxEntries: 1.5, ttlMs: 1, monoNow },
    { maxEntries: '10', ttlMs: 1, monoNow },
    { maxEntries: Infinity, ttlMs: 1, monoNow },
    { maxEntries: 1, ttlMs: 0, monoNow },
    { maxEntries: 1, ttlMs: -5, monoNow },
    { maxEntries: 1, ttlMs: NaN, monoNow },
    { maxEntries: 1, ttlMs: Infinity, monoNow },
    { maxEntries: 1, ttlMs: '1000', monoNow },
    { maxEntries: 1, ttlMs: 1 },
    { maxEntries: 1, ttlMs: 1, monoNow: 5 },
    { maxEntries: 1, ttlMs: 1, monoNow, wallNow: 5 },
    { maxEntries: 1, ttlMs: 1, now: monoNow },
    { maxEntries: 1, ttlMs: 1, monoNow, maxKeyLength: 0 },
    { maxEntries: 1, ttlMs: 1, monoNow, maxKeyLength: 2.5 },
  ];
  for (const options of bad) {
    assert.throws(() => new SeenCache(options), ConfigError, JSON.stringify(options));
  }
});

test('a clock that does not return a finite number is an error, not a silent no-expiry', () => {
  for (const value of [NaN, Infinity, undefined, '5', null]) {
    const cache = new SeenCache({ maxEntries: 4, ttlMs: 10, monoNow: () => value });
    assert.throws(
      () => cache.add('a'),
      (err) => err instanceof StateError && err.code === 'ERR_STATE',
      String(value),
    );
    assert.throws(() => cache.size, StateError);
  }
});

test('a fractional clock is floored so that snapshots hold integers', () => {
  const clock = { t: 1000.75 };
  const cache = new SeenCache({ maxEntries: 4, ttlMs: 100, monoNow: () => clock.t, wallNow: () => clock.t });
  cache.add('a');
  assert.deepEqual(cache.snapshot(), [['a', 1000]]);
});

test('if the clock steps backwards entries are kept, never dropped early', () => {
  const { cache, clock } = setup({ ttlMs: 1000, maxEntries: 3 });
  cache.add('a');
  clock.t -= 5000;
  assert.equal(cache.has('a'), true);
  assert.equal(cache.add('a'), false);
  cache.add('b');
  assert.equal(cache.size, 2);
  // The bound still holds while the clock is behind.
  cache.add('c');
  cache.add('d');
  assert.equal(cache.size, 3);
  assert.equal(cache.has('a'), false);
});

test('an expired key hidden behind a live one is still re-queued as the youngest', () => {
  // After a backward clock step the queue is not sorted by time, so the head sweep
  // cannot reach the expired entry; add() has to move it itself.
  const { cache, clock } = setup({ ttlMs: 1000, maxEntries: 3 });
  cache.add('x'); // stamped with the "future" time
  clock.t -= 5000;
  cache.add('a');
  clock.t += 500;
  cache.add('b');
  clock.t += 500; // 'a' is 1000 ms old: expired, but 'x' in front of it is not
  assert.equal(cache.has('x'), true);
  assert.equal(cache.add('a'), true);
  assert.deepEqual(keysOf(cache), ['x', 'b', 'a']);
  cache.add('c'); // over capacity: 'x' is the oldest in queue order
  assert.deepEqual(keysOf(cache), ['b', 'a', 'c']);
});

test('snapshot lists live entries oldest first and survives a JSON round trip', () => {
  const { cache, clock } = setup({ ttlMs: 1000 });
  cache.add('a');
  clock.t += 10;
  cache.add('b');
  clock.t += 10;
  cache.add('c');
  const snapshot = cache.snapshot();
  assert.deepEqual(snapshot, [
    ['a', 1_000_000],
    ['b', 1_000_010],
    ['c', 1_000_020],
  ]);

  // The snapshot is a copy: editing it does not reach into the cache.
  snapshot.length = 0;
  assert.equal(cache.size, 3);

  const restored = SeenCache.restore(JSON.parse(JSON.stringify(cache.snapshot())), {
    maxEntries: 100,
    ttlMs: 1000,
    monoNow: () => clock.t, wallNow: () => clock.t,
  });
  assert.deepEqual(restored.snapshot(), cache.snapshot());
  assert.equal(restored.add('a'), false);
  assert.equal(restored.add('d'), true);
});

test('restore drops entries that expired while the node was down', () => {
  const { cache, clock } = setup({ ttlMs: 1000 });
  cache.add('old');
  clock.t += 400;
  cache.add('mid');
  clock.t += 400;
  cache.add('new');
  const snapshot = cache.snapshot();

  clock.t += 300; // 'old' is now 1100 ms old, 'mid' 700 ms, 'new' 300 ms
  const options = { maxEntries: 100, ttlMs: 1000, monoNow: () => clock.t, wallNow: () => clock.t };
  const restored = SeenCache.restore(snapshot, options);
  assert.equal(restored.size, 2);
  assert.equal(restored.has('old'), false);
  assert.equal(restored.has('mid'), true);

  // Restored entries keep their original age: 'mid' expires 1000 ms after it was added.
  clock.t += 299;
  assert.equal(restored.has('mid'), true);
  clock.t += 1;
  assert.equal(restored.has('mid'), false);
  assert.equal(restored.has('new'), true);

  clock.t += 100_000;
  const empty = SeenCache.restore(snapshot, options);
  assert.equal(empty.size, 0);
});

test('restore keeps the newest entries when the snapshot exceeds maxEntries', () => {
  const { cache, clock } = setup({ maxEntries: 10 });
  for (let i = 0; i < 10; i += 1) {
    cache.add(`k${i}`);
    clock.t += 1;
  }
  const restored = SeenCache.restore(cache.snapshot(), {
    maxEntries: 4,
    ttlMs: 1000,
    monoNow: () => clock.t, wallNow: () => clock.t,
  });
  assert.deepEqual(keysOf(restored), ['k6', 'k7', 'k8', 'k9']);
  restored.add('k10');
  assert.deepEqual(keysOf(restored), ['k7', 'k8', 'k9', 'k10']);
});

test('restore pulls timestamps from the future back to now', () => {
  const clock = { t: 5000 };
  const options = { maxEntries: 10, ttlMs: 1000, monoNow: () => clock.t, wallNow: () => clock.t };
  const restored = SeenCache.restore([['future', 9_000_000]], options);
  assert.deepEqual(restored.snapshot(), [['future', 5000]]);
  clock.t += 999;
  assert.equal(restored.has('future'), true);
  clock.t += 1;
  assert.equal(restored.has('future'), false);
});

test('restore sorts an out-of-order snapshot so that expiry and eviction stay correct', () => {
  const clock = { t: 10_000 };
  const options = { maxEntries: 3, ttlMs: 1000, monoNow: () => clock.t, wallNow: () => clock.t };
  const restored = SeenCache.restore(
    [
      ['newest', 9900],
      ['oldest', 9100],
      ['middle', 9500],
      ['expired', 8000],
    ],
    options,
  );
  assert.deepEqual(restored.snapshot(), [
    ['oldest', 9100],
    ['middle', 9500],
    ['newest', 9900],
  ]);

  // Head pruning relies on the order: 'oldest' must go first.
  clock.t = 10_100;
  assert.equal(restored.prune(), 1);
  assert.deepEqual(keysOf(restored), ['middle', 'newest']);

  // ...and so does eviction.
  restored.add('x');
  restored.add('y');
  assert.deepEqual(keysOf(restored), ['newest', 'x', 'y']);
});

test('restore refuses a malformed snapshot as a whole', () => {
  const options = { maxEntries: 10, ttlMs: 1000, monoNow: () => 5000, wallNow: () => 5000 };
  const holed = [['a', 4900]];
  holed[2] = ['b', 4900];
  const bad = [
    null,
    undefined,
    'a',
    { a: 4900 },
    new Map([['a', 4900]]),
    [null],
    ['a'],
    [['a']],
    [['a', 4900, 1]],
    [[1, 4900]],
    [[null, 4900]],
    [['a', '4900']],
    [['a', 4900.5]],
    [['a', NaN]],
    [['a', Infinity]],
    [['a', null]],
    [['k'.repeat(129), 4900]],
    [
      ['a', 4900],
      ['a', 4950],
    ],
    // A duplicate is refused even if one of the copies has already expired.
    [
      ['a', 1],
      ['a', 4950],
    ],
    [['good', 4900], 'bad'],
    holed,
  ];
  for (const snapshot of bad) {
    assert.throws(
      () => SeenCache.restore(snapshot, options),
      (err) => err instanceof StoreError && err.code === 'ERR_STORE',
      JSON.stringify(snapshot) ?? String(snapshot),
    );
  }
  // Invalid options are a configuration error, reported before the snapshot is looked at.
  const badOptions = { maxEntries: 0, ttlMs: 1, monoNow: () => 0, wallNow: () => 0 };
  assert.throws(() => SeenCache.restore([], badOptions), ConfigError);
  assert.equal(SeenCache.restore([], options).size, 0);
});

test('two clocks: lifetimes run on the monotonic clock, snapshots carry wall time', () => {
  // DESIGN.md section 15, items 11 and 21. The monotonic clock of a process starts near
  // zero and means nothing to the next process; the wall clock is what survives.
  const mono = { t: 50 };
  const wall = { t: 1_700_000_000_000 };
  const options = { maxEntries: 10, ttlMs: 1000, monoNow: () => mono.t, wallNow: () => wall.t };
  const cache = new SeenCache(options);
  cache.add('a');
  mono.t += 300;
  wall.t += 300;
  cache.add('b');

  // A wall-clock step changes nothing about expiry.
  wall.t += 10_000_000;
  assert.equal(cache.has('a'), true);
  wall.t -= 10_000_000;

  mono.t += 100;
  wall.t += 100;
  assert.deepEqual(cache.snapshot(), [
    ['a', 1_700_000_000_000],
    ['b', 1_700_000_000_300],
  ]);
  const saved = JSON.parse(JSON.stringify(cache.snapshot()));

  // The process restarts 200 ms later: its monotonic clock starts again from 3.
  const later = { t: 3 };
  wall.t += 200;
  const restored = SeenCache.restore(saved, { ...options, monoNow: () => later.t });
  // 'a' is 600 ms old and 'b' 300 ms: they have 400 and 700 ms left.
  later.t += 399;
  assert.equal(restored.has('a'), true);
  later.t += 1;
  assert.equal(restored.has('a'), false);
  later.t += 299;
  assert.equal(restored.has('b'), true);
  later.t += 1;
  assert.equal(restored.has('b'), false);
});

test('snapshot and restore need a wall clock; the hot path does not', () => {
  const cache = new SeenCache({ maxEntries: 4, ttlMs: 10, monoNow: () => 0 });
  assert.equal(cache.add('a'), true);
  assert.equal(cache.has('a'), true);
  assert.throws(() => cache.snapshot(), StateError);
  assert.throws(
    () => SeenCache.restore([], { maxEntries: 4, ttlMs: 10, monoNow: () => 0 }),
    ConfigError,
  );
  const broken = new SeenCache({ maxEntries: 4, ttlMs: 10, monoNow: () => 0, wallNow: () => NaN });
  broken.add('a');
  assert.throws(() => broken.snapshot(), StateError);
});

test('regression: add() costs the same at 100 and 200 000 entries', () => {
  // Review finding (routing, medium): using the Map as the FIFO made every add() walk
  // the holes V8 leaves at the head of a Map, so a full cache cost O(maxEntries) per
  // packet (112 us at 100 000 entries against 13 us at 10 000). The ring buffer keeps it
  // flat (about 0.4 us here at any size; the old pattern re-created in a probe took
  // 6 to 11 us at 10 000 to 200 000). Measured as the best of three runs of a full cache
  // under a stream of unique keys (eviction on every add) and under TTL expiry, against
  // a cache too small to have the problem.
  const perAdd = (maxEntries, ttlMs) => {
    const clock = { t: 0 };
    const cache = new SeenCache({ maxEntries, ttlMs, monoNow: () => clock.t });
    for (let i = 0; i < maxEntries; i += 1) cache.add(`fill-${i}`);
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 20_000; i += 1) {
        clock.t += 1;
        cache.add(`k-${run}-${i}`);
      }
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 20_000);
    }
    return best;
  };
  for (const ttlMs of [1e12, 5_000]) {
    const small = perAdd(100, ttlMs);
    const large = perAdd(200_000, ttlMs);
    // Generous for a slow or busy machine, still well below the old cost.
    assert.ok(large < small * 6 + 1_500, `ttl ${ttlMs}: ${small} ns vs ${large} ns per add`);
  }
});
