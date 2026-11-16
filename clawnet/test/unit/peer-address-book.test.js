import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Identity } from '../../src/core/crypto/identity.js';
import { ConfigError } from '../../src/core/errors.js';
import {
  AddressBook,
  AddressSource,
  DROP_AFTER_FAILS,
  MAX_ADDRS_PER_ID,
} from '../../src/core/peer/address-book.js';
import { JsonFile } from '../../src/vault/store.js';
import { tempDir } from '../helpers/tmp.js';

const A = Identity.generate().nodeId;
const B = Identity.generate().nodeId;
const C = Identity.generate().nodeId;
const addr = n => `tcp://10.0.0.${n}:4747`;
const DEFAULTS = { v: 1, entries: [] };

async function book(t, { now = () => 1_000_000, maxEntries, file } = {}) {
  const dir = await tempDir(t, 'abook');
  const path = file ?? join(dir, 'peers.json');
  const doc = new JsonFile(path, { defaults: DEFAULTS });
  const b = new AddressBook({ doc, now, maxEntries });
  await b.load();
  return { b, path, dir };
}

test('persistence round trip through a real JsonFile', async t => {
  const dir = await tempDir(t, 'abook');
  const path = join(dir, 'peers.json');
  let clock = 5000;
  const first = new AddressBook({ doc: new JsonFile(path, { defaults: DEFAULTS }), now: () => clock });
  await first.load();
  assert.equal(first.add(addr(1), { source: AddressSource.BOOTSTRAP }), true);
  assert.equal(first.add(addr(1), { source: AddressSource.PEX, id: A }), false);
  first.add(addr(2), { id: B, source: AddressSource.MULTICAST });
  clock = 6000;
  first.markSuccess(addr(1), A);
  first.markFailure(addr(2), 'connect-failed');
  first.defer(addr(2), 99_999);
  await first.flush();

  const second = new AddressBook({ doc: new JsonFile(path, { defaults: DEFAULTS }), now: () => clock });
  const result = await second.load();
  assert.deepEqual(result, { recovered: false, corruptPath: null, dropped: 0 });
  assert.deepEqual(second.get(addr(1)), {
    addr: addr(1), id: A, sources: ['bootstrap', 'pex'], addedAt: 5000, lastOkAt: 6000,
    lastFailAt: null, fails: 0, lastError: null, nextAttemptAt: 0,
  });
  const two = second.get(addr(2));
  assert.equal(two.fails, 1);
  assert.equal(two.lastError, 'connect-failed');
  assert.equal(two.lastFailAt, 6000);
  // defer() is runtime-only.
  assert.equal(two.nextAttemptAt, 0);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.v, 1);
  assert.ok(raw.entries.every(e => !('nextAttemptAt' in e)));
});

test('candidates: ordering for every tie-break', async t => {
  let clock = 1000;
  const { b } = await book(t, { now: () => clock });
  b.add(addr(1), { id: A, source: AddressSource.PEX });           // non-static, 0 fails
  b.add(addr(2), { id: B, source: AddressSource.PEX });           // preferred
  b.add(addr(3), { source: AddressSource.BOOTSTRAP });            // static, anonymous
  b.add(addr(4), { id: C, source: AddressSource.MULTICAST });     // 1 fail
  b.add(addr(5), { source: AddressSource.PEX });                  // anonymous, recent success
  b.add(addr(6), { source: AddressSource.PEX });                  // anonymous, older success
  b.markFailure(addr(4), 'closed');
  clock = 2000;
  b.markSuccess(addr(6), null);
  clock = 3000;
  b.markSuccess(addr(5), null);
  const order = b.candidates({ prefer: id => id === B }).map(e => e.addr);
  assert.deepEqual(order, [addr(3), addr(2), addr(5), addr(6), addr(1), addr(4)]);
  // Address is the last tie-break.
  const { b: plain } = await book(t);
  for (const n of [9, 7, 8]) plain.add(addr(n), { source: AddressSource.PEX });
  assert.deepEqual(plain.candidates().map(e => e.addr), [addr(7), addr(8), addr(9)]);
  assert.deepEqual(plain.candidates({ limit: 2 }).map(e => e.addr), [addr(7), addr(8)]);
});

test('candidates: sources, exclude, one entry per id, defer', async t => {
  let clock = 1000;
  const { b } = await book(t, { now: () => clock });
  b.add(addr(1), { id: A, source: AddressSource.PEX });
  b.add(addr(2), { id: A, source: AddressSource.PEX });
  b.add(addr(3), { id: B, source: AddressSource.HANDSHAKE });
  b.add(addr(4), { source: AddressSource.PEX });
  b.markFailure(addr(1), 'closed');
  // One per id, the one with fewer fails.
  assert.deepEqual(b.candidates({ sources: [AddressSource.PEX] }).map(e => e.addr), [addr(2), addr(4)]);
  assert.deepEqual(b.candidates({ sources: [AddressSource.PEX], exclude: [A] }).map(e => e.addr), [addr(4)]);
  assert.deepEqual(b.candidates({ sources: [AddressSource.HANDSHAKE] }).map(e => e.addr), [addr(3)]);
  b.defer(addr(4), 1500);
  assert.deepEqual(b.candidates({ exclude: [A, B] }).map(e => e.addr), []);
  clock = 1500;
  assert.deepEqual(b.candidates({ exclude: [A, B] }).map(e => e.addr), [addr(4)]);
  assert.deepEqual(b.candidates({ filter: e => e.addr !== addr(4), exclude: [A, B] }), []);
});

test('bind moves an address from one node to another', async t => {
  const { b } = await book(t);
  b.add(addr(1), { id: A, source: AddressSource.PEX });
  assert.deepEqual(b.addressesOf(A), [addr(1)]);
  b.bind(addr(1), B);
  assert.deepEqual(b.addressesOf(A), []);
  assert.deepEqual(b.addressesOf(B), [addr(1)]);
  b.bind(addr(1), 'not-a-node-id');
  assert.deepEqual(b.addressesOf(B), [addr(1)]);
});

test('setAddressesFor replaces one source and leaves the others', async t => {
  const { b } = await book(t);
  b.add(addr(1), { id: A, source: AddressSource.PEX });
  b.add(addr(1), { id: A, source: AddressSource.HANDSHAKE });
  b.setAddressesFor(A, [addr(1), addr(2)], AddressSource.HANDSHAKE);
  b.setAddressesFor(A, [addr(2), 'garbage'], AddressSource.HANDSHAKE);
  assert.deepEqual(b.get(addr(1)).sources, ['pex']);
  assert.deepEqual(b.get(addr(2)).sources, ['handshake']);
  b.setAddressesFor(A, [], AddressSource.HANDSHAKE);
  assert.equal(b.get(addr(2)), null, 'an entry with no source left is removed');
  assert.ok(b.get(addr(1)) !== null);
});

test('eviction never removes static entries; most failures go first', async t => {
  const { b } = await book(t, { maxEntries: 3 });
  b.add(addr(1), { source: AddressSource.BOOTSTRAP });
  b.add(addr(2), { source: AddressSource.PEX });
  b.add(addr(3), { source: AddressSource.PEX });
  b.markFailure(addr(2), 'closed');
  assert.equal(b.add(addr(4), { source: AddressSource.PEX }), true);
  assert.equal(b.size, 3);
  assert.equal(b.get(addr(2)), null);
  assert.ok(b.get(addr(1)) !== null);
  // Only statics left to fill: a new static entry may exceed nothing it cannot evict.
  const { b: statics } = await book(t, { maxEntries: 2 });
  statics.add(addr(1), { source: AddressSource.MANUAL });
  statics.add(addr(2), { source: AddressSource.BOOTSTRAP });
  statics.add(addr(3), { source: AddressSource.PEX });
  assert.ok(statics.get(addr(1)) && statics.get(addr(2)));
  assert.equal(statics.get(addr(3)), null);
});

test('at most 16 addresses per node, oldest non-static dropped', async t => {
  let clock = 0;
  const { b } = await book(t, { now: () => clock++ });
  for (let i = 1; i <= MAX_ADDRS_PER_ID + 3; i += 1) b.add(addr(i), { id: A, source: AddressSource.PEX });
  assert.equal(b.addressesOf(A).length, MAX_ADDRS_PER_ID);
  assert.equal(b.get(addr(1)), null);
  assert.ok(b.get(addr(MAX_ADDRS_PER_ID + 3)) !== null);
});

test('the 10-failure rule drops stale non-static entries only', async t => {
  let clock = 10 * 24 * 3600 * 1000;
  const { b } = await book(t, { now: () => clock });
  b.add(addr(1), { source: AddressSource.PEX });
  b.add(addr(2), { source: AddressSource.BOOTSTRAP });
  b.add(addr(3), { source: AddressSource.PEX });
  b.markSuccess(addr(3), null);
  for (let i = 1; i < DROP_AFTER_FAILS; i += 1) {
    assert.equal(b.markFailure(addr(1), 'closed'), i);
    b.markFailure(addr(2), 'closed');
    b.markFailure(addr(3), 'closed');
  }
  assert.equal(b.markFailure(addr(1), 'closed'), 0);
  assert.equal(b.get(addr(1)), null);
  assert.equal(b.markFailure(addr(2), 'closed'), DROP_AFTER_FAILS);
  // Reached recently: kept.
  assert.equal(b.markFailure(addr(3), 'closed'), DROP_AFTER_FAILS);
  clock += 25 * 3600 * 1000;
  assert.equal(b.markFailure(addr(3), 'closed'), 0);
  // Unknown reasons are stored as "unknown".
  b.markFailure(addr(2), 'Weird Reason!');
  assert.equal(b.get(addr(2)).lastError, 'unknown');
});

test('markReached keeps the failure count; markSuccess resets it', async t => {
  const { b } = await book(t);
  b.add(addr(1), { source: AddressSource.MANUAL });
  b.markFailure(addr(1), 'closed');
  b.markFailure(addr(1), 'closed');
  b.markReached(addr(1), A);
  assert.equal(b.get(addr(1)).fails, 2);
  assert.equal(b.get(addr(1)).id, A);
  b.markSuccess(addr(1), A);
  assert.equal(b.get(addr(1)).fails, 0);
});

test('self addresses are refused for the rest of the process', async t => {
  const { b } = await book(t);
  b.add(addr(1), { source: AddressSource.MANUAL });
  b.markSelf(addr(1));
  assert.equal(b.get(addr(1)), null);
  assert.equal(b.add(addr(1), { source: AddressSource.MANUAL }), false);
  b.setAddressesFor(A, [addr(1)], AddressSource.PEX);
  assert.equal(b.get(addr(1)), null);
});

test('invalid input is ignored', async t => {
  const { b } = await book(t);
  for (const bad of ['tcp://host', 'udp://1.2.3.4:5', '', null, 42, 'tcp://1.2.3.4:0']) {
    assert.equal(b.add(bad, { source: AddressSource.PEX }), false);
  }
  assert.equal(b.add(addr(1), { source: 'gossip' }), false);
  assert.equal(b.add(addr(1), { source: AddressSource.PEX, id: 'nope' }), false);
  assert.equal(b.size, 0);
  assert.throws(() => new AddressBook({ doc: null }), ConfigError);
  assert.throws(() => new AddressBook({ doc: { update() {} }, maxEntries: 0 }), ConfigError);
});

test('garbage in the loaded file is dropped without throwing', async t => {
  const dir = await tempDir(t, 'abook');
  const path = join(dir, 'peers.json');
  const good = {
    addr: addr(1), id: A, sources: ['pex'], addedAt: 1, lastOkAt: null, lastFailAt: null, fails: 0, lastError: null,
  };
  const entries = [
    good,
    { ...good, addr: addr(2), extra: 'ignored' },
    { ...good, addr: 'bad address' },
    { ...good, addr: addr(3), id: 'bad id' },
    { ...good, addr: addr(4), sources: ['nope'] },
    { ...good, addr: addr(5), sources: [] },
    { ...good, addr: addr(6), fails: -1 },
    { ...good, addr: addr(7), addedAt: '1' },
    { ...good, addr: addr(8), lastError: 'Has Spaces' },
    { ...good, addr: addr(1) },
    null, 7, 'x', [],
  ];
  await writeFile(path, JSON.stringify({ v: 1, entries }));
  const b = new AddressBook({ doc: new JsonFile(path, { defaults: DEFAULTS }) });
  const result = await b.load();
  assert.equal(result.dropped, entries.length - 2);
  assert.deepEqual(b.entries().map(e => e.addr).sort(), [addr(1), addr(2)]);
  assert.equal('extra' in b.get(addr(2)), false);

  // A file that is not JSON at all is quarantined by the JsonFile and the book starts empty.
  await writeFile(path, '{not json');
  const c = new AddressBook({ doc: new JsonFile(path, { defaults: DEFAULTS }) });
  const recovered = await c.load();
  assert.equal(recovered.recovered, true);
  assert.equal(c.size, 0);
  // Entries that are not an array at all.
  await writeFile(path, JSON.stringify({ v: 1, entries: 'nope' }));
  const d = new AddressBook({ doc: new JsonFile(path, { defaults: DEFAULTS }) });
  await d.load();
  assert.equal(d.size, 0);
});
