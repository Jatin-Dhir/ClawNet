/**
 * Counters: flattening of nested module statistics, totals, and rates over a window,
 * driven by a fake clock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Counters, flatten, MAX_COUNTERS } from '../../src/core/diag/counters.js';
import { ConfigError } from '../../src/core/errors.js';

function setup(tree, options = {}) {
  const clock = { at: 1_000_000 };
  const state = { tree };
  const counters = new Counters({ source: () => state.tree, now: () => clock.at, ...options });
  return { counters, clock, state };
}

test('flatten gives dotted names for non-negative integers and nothing else', () => {
  const flat = flatten({
    forwarder: { forwarded: 5, dropped_ttl: 0, ratio: 0.5, label: 'x', flag: true, nothing: null, negative: -1 },
    services: { cast: { published: 7 } },
    list: [1, 2],
    big: 2 ** 60,
    'bad key': 3,
    __proto__: { inherited: 1 },
  });
  assert.deepEqual([...flat], [['forwarder.forwarded', 5], ['forwarder.dropped_ttl', 0], ['services.cast.published', 7]]);
});

test('flatten is bounded in depth and in the number of counters', () => {
  assert.equal(flatten({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }).size, 0, 'too deep');
  const wide = Object.fromEntries(Array.from({ length: MAX_COUNTERS + 50 }, (_, i) => [`k${i}`, i]));
  assert.equal(flatten(wide).size, MAX_COUNTERS);
  assert.equal(flatten(null).size, 0);
  assert.equal(flatten([1]).size, 0);
});

test('the snapshot reports totals sorted by name, and rates only for what moved in the window', () => {
  const { counters, clock, state } = setup({ b: { two: 10, still: 4 }, a: { one: 0 } });
  counters.sample();
  clock.at += 2000;
  state.tree = { b: { two: 16, still: 4 }, a: { one: 0 }, c: { fresh: 3 } };
  counters.sample();
  clock.at += 2000;
  state.tree = { b: { two: 18, still: 4 }, a: { one: 0 }, c: { fresh: 3 } };
  const snapshot = counters.snapshot();
  assert.equal(snapshot.at, clock.at);
  assert.equal(snapshot.uptimeMs, 4000);
  assert.equal(snapshot.windowMs, 10000);
  assert.deepEqual(Object.keys(snapshot.totals), ['a.one', 'b.still', 'b.two', 'c.fresh']);
  assert.deepEqual(snapshot.totals, { 'a.one': 0, 'b.still': 4, 'b.two': 18, 'c.fresh': 3 });
  // b.two moved by 8 in 4 s; c.fresh did not exist at the start of the window, so it counts from 0.
  assert.deepEqual(snapshot.rates, { 'b.two': 2, 'c.fresh': 0.75 });
});

test('a counter that went down was reset and has no rate', () => {
  const { counters, clock, state } = setup({ links: { bytes: 1000 } });
  counters.sample();
  clock.at += 1000;
  state.tree = { links: { bytes: 20 } };
  assert.deepEqual(counters.snapshot().rates, {});
  assert.equal(counters.snapshot().totals['links.bytes'], 20);
});

test('samples older than the window are not used', () => {
  const { counters, clock, state } = setup({ n: { x: 0 } }, { windowMs: 5000 });
  counters.sample();
  clock.at += 4000;
  state.tree = { n: { x: 4 } };
  counters.sample();
  clock.at += 4000;
  state.tree = { n: { x: 6 } };
  // The sample at t=0 is outside the 5 s window; the one 4 s ago is the base: 2 in 4 s.
  assert.deepEqual(counters.snapshot().rates, { 'n.x': 0.5 });
  clock.at += 60_000;
  assert.deepEqual(counters.snapshot().rates, {}, 'with no sample in the window there is no rate');
});

test('with one sample taken right now there is no rate yet', () => {
  const { counters, state } = setup({ n: { x: 1 } });
  counters.sample();
  state.tree = { n: { x: 9 } };
  assert.deepEqual(counters.snapshot().rates, {});
});

test('memory stays bounded however often it is sampled', () => {
  const { counters, clock } = setup({ n: { x: 1 } });
  for (let i = 0; i < 5000; i += 1) {
    clock.at += 1;
    counters.sample();
  }
  assert.ok(counters.snapshot().totals['n.x'] === 1);
});

test('constructor options are validated', () => {
  const ok = { source: () => ({}), now: () => 0 };
  assert.throws(() => new Counters({ ...ok, source: 1 }), ConfigError);
  assert.throws(() => new Counters({ ...ok, now: null }), ConfigError);
  assert.throws(() => new Counters({ ...ok, windowMs: 999 }), ConfigError);
  assert.throws(() => new Counters({ ...ok, windowMs: 1.5 }), ConfigError);
  assert.doesNotThrow(() => new Counters(ok));
});
