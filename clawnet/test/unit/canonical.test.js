import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalize, canonicalBytes, parseCanonical, MAX_DEPTH } from '../../src/core/wire/canonical.js';
import { CanonicalError } from '../../src/core/errors.js';

const vectors = JSON.parse(
  readFileSync(new URL('../vectors/canonical-json.json', import.meta.url), 'utf8'),
);

test('canonicalize produces the expected text for every valid vector', () => {
  for (const { name, input, canonical } of vectors.valid) {
    assert.equal(canonicalize(JSON.parse(input)), canonical, name);
  }
});

test('canonical output is a fixed point: it parses strictly and re-encodes to itself', () => {
  for (const { name, canonical } of vectors.valid) {
    const value = parseCanonical(canonical);
    assert.equal(canonicalize(value), canonical, name);
  }
});

test('canonicalize rejects values outside the subset', () => {
  for (const { name, input } of vectors.rejectValue) {
    assert.throws(() => canonicalize(JSON.parse(input)), CanonicalError, name);
  }
});

test('parseCanonical rejects everything that is not in canonical form', () => {
  for (const { name, input } of vectors.rejectStrict) {
    assert.throws(() => parseCanonical(input), CanonicalError, name);
  }
});

test('parseCanonical accepts bytes and rejects invalid UTF-8 and a byte-order mark', () => {
  assert.deepEqual(parseCanonical(Buffer.from('{"a":1}')), { a: 1 });
  assert.throws(() => parseCanonical(Buffer.from([0x22, 0xff, 0x22])), CanonicalError);
  assert.throws(() => parseCanonical(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), CanonicalError);
});

test('canonicalBytes is the UTF-8 encoding of canonicalize', () => {
  const value = { text: 'héllo \u{1f600}', n: 1 };
  assert.deepEqual(canonicalBytes(value), Buffer.from(canonicalize(value), 'utf8'));
});

test('key order does not depend on insertion order', () => {
  const a = { x: 1, y: [1, 2], z: { p: null, q: true } };
  const b = { z: { q: true, p: null }, y: [1, 2], x: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('JavaScript-only values are rejected', () => {
  const rejected = [
    undefined,
    () => {},
    Symbol('s'),
    10n,
    NaN,
    Infinity,
    1.5,
    new Date(0),
    new Map(),
    new Set(),
    Buffer.from('ab'),
    new Uint8Array(2),
    { a: undefined },
    [undefined],
    // eslint-disable-next-line no-sparse-arrays
    [1, , 3],
    { [Symbol('k')]: 1 },
    new (class Thing {})(),
  ];
  for (const value of rejected) {
    assert.throws(() => canonicalize(value), CanonicalError, String(value?.constructor?.name ?? value));
  }
});

test('objects without a prototype are accepted', () => {
  const value = Object.create(null);
  value.b = 1;
  value.a = 2;
  assert.equal(canonicalize(value), '{"a":2,"b":1}');
});

test('a "__proto__" key is rejected at any depth', () => {
  assert.throws(() => canonicalize(JSON.parse('{"__proto__":{"x":1},"a":2}')), CanonicalError);
  assert.throws(() => canonicalize(JSON.parse('{"a":[{"__proto__":1}]}')), CanonicalError);
  assert.throws(() => parseCanonical('{"__proto__":1}'), CanonicalError);
  // Other keys that merely look similar are ordinary data.
  assert.equal(canonicalize({ __proto: 1, proto__: 2 }), '{"__proto":1,"proto__":2}');
});

test('nesting limit counts containers, not scalars', () => {
  const build = (depth) => {
    let value = 1;
    for (let i = 0; i < depth; i += 1) value = { k: value };
    return value;
  };
  assert.doesNotThrow(() => canonicalize(build(MAX_DEPTH)));
  assert.throws(() => canonicalize(build(MAX_DEPTH + 1)), CanonicalError);
});
