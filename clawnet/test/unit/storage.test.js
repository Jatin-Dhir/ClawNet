import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BLOB_KEY_PATTERN, MAX_BLOB_BYTES, NodeStorage } from '../../src/core/storage.js';
import { StateError, StoreError } from '../../src/core/errors.js';
import { AppendLog, JsonFile } from '../../src/vault/store.js';
import { tempDir } from '../helpers/tmp.js';

const MARKER = 'plaintext-marker-3f9a1c';

async function storageIn(t, options = {}) {
  const dir = await tempDir(t, 'storage');
  const recovered = [];
  const storage = new NodeStorage({
    dir,
    storageKey: options.key ?? randomBytes(32),
    now: options.now,
    onRecovered: (info) => recovered.push(info),
  });
  t.after(() => storage.closeAll().catch(() => {}));
  return { dir, storage, recovered };
}

async function readAll(log) {
  const records = [];
  for await (const record of log.read()) records.push(record);
  return records;
}

async function names(dir) {
  return (await readdir(dir)).sort();
}

test('sealed doc: defaults, update, save, reload from disk', async (t) => {
  const { dir, storage } = await storageIn(t);
  const doc = storage.doc('state', { defaults: { lsaSeq: 0, peers: [] } });
  const first = await doc.load();
  assert.deepEqual(first.data, { lsaSeq: 0, peers: [] });
  assert.equal(first.recovered, false);
  doc.update((d) => {
    d.lsaSeq = 41;
    d.peers.push('a');
  });
  await doc.flush();
  assert.equal(doc.stats.dirty, false);
  assert.equal(doc.data.lsaSeq, 41);
  assert.ok((await readFile(join(dir, 'state.json'))).length > 0);

});

test('sealed doc survives a reopen with the same key', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const doc = storage.doc('state', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = 7;
  });
  await storage.closeAll();

  const reopened = new NodeStorage({ dir, storageKey: key });
  const doc2 = reopened.doc('state', { defaults: { n: 0 } });
  const result = await doc2.load();
  assert.deepEqual(result.data, { n: 7 });
  assert.equal(result.recovered, false);
  assert.deepEqual(doc2.data, { n: 7 });
});

test('files on disk do not contain the plaintext of sealed items', async (t) => {
  const { dir, storage } = await storageIn(t);
  const doc = storage.doc('secret', { defaults: { text: '' } });
  await doc.load();
  doc.update((d) => {
    d.text = MARKER;
  });
  await doc.flush();
  const log = storage.log('journal');
  await log.open();
  await log.append({ text: MARKER });
  await log.flush();
  const blobs = storage.blobs('bodies');
  await blobs.put('one', Buffer.from(MARKER));

  const raw = [
    await readFile(join(dir, 'secret.json')),
    await readFile(join(dir, 'journal.log')),
    await readFile(join(dir, 'bodies', 'one')),
  ];
  for (const bytes of raw) {
    assert.equal(bytes.includes(MARKER), false);
    assert.equal(bytes.includes(Buffer.from(MARKER).toString('base64').slice(0, 20)), false);
  }
  assert.match(raw[0].toString(), /^\{"v":1,"b":"[A-Za-z0-9+/=]+"\}\n$/);
});

test('plain doc and plain log are the vault classes and do hold plaintext', async (t) => {
  const { dir, storage } = await storageIn(t);
  const doc = storage.doc('plain', { defaults: { text: '' }, sealed: false });
  const log = storage.log('plainlog', { sealed: false });
  assert.ok(doc instanceof JsonFile);
  assert.ok(log instanceof AppendLog);
  await doc.load();
  doc.update((d) => {
    d.text = MARKER;
  });
  await doc.flush();
  await log.open();
  await log.append({ text: MARKER });
  await log.flush();
  assert.ok((await readFile(join(dir, 'plain.json'))).includes(MARKER));
  assert.ok((await readFile(join(dir, 'plainlog.log'))).includes(MARKER));
  assert.deepEqual(await readAll(log), [{ text: MARKER }]);
});

test('a burst of updates is one write and the file holds the last state', async (t) => {
  const { storage } = await storageIn(t);
  const doc = storage.doc('burst', { defaults: { n: 0 } });
  await doc.load();
  for (let i = 1; i <= 50; i += 1) {
    doc.update((d) => {
      d.n = i;
    });
  }
  await doc.flush();
  assert.equal(doc.stats.writes, 1);
  assert.equal(doc.data.n, 50);
});

test('closeAll flushes pending updates and closes logs', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const doc = storage.doc('pending', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = 9;
  });
  const log = storage.log('events');
  await log.open();
  await log.append({ n: 1 });
  await storage.closeAll();
  await assert.rejects(log.append({ n: 2 }), StateError);

  const other = new NodeStorage({ dir, storageKey: key });
  const doc2 = other.doc('pending', { defaults: { n: 0 } });
  assert.deepEqual((await doc2.load()).data, { n: 9 });
  const log2 = other.log('events');
  await log2.open();
  assert.deepEqual(await readAll(log2), [{ n: 1 }]);
  await other.closeAll();
});

test('closeAll skips a doc that was never loaded and can be called twice', async (t) => {
  const { storage } = await storageIn(t);
  storage.doc('never', { defaults: {} });
  await storage.closeAll();
  await storage.closeAll();
});

test('a sealed doc moved to another name is quarantined and reported', async (t) => {
  const key = randomBytes(32);
  const { dir, storage, recovered } = await storageIn(t, { key, now: () => 1_700_000_000_000 });
  const doc = storage.doc('first', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = 5;
  });
  await doc.flush();
  await copyFile(join(dir, 'first.json'), join(dir, 'second.json'));

  const swapped = storage.doc('second', { defaults: { n: -1 } });
  const result = await swapped.load();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, { n: -1 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].file, 'second.json');
  assert.match(recovered[0].movedTo, /^second\.json\.corrupt-/);
  assert.ok(!recovered[0].file.includes(dir));
  assert.ok((await names(dir)).some((name) => name.startsWith('second.json.corrupt-')));
});

test('a doc sealed under another key is quarantined', async (t) => {
  const { dir, storage } = await storageIn(t);
  const doc = storage.doc('keyed', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = 1;
  });
  await doc.flush();

  const recovered = [];
  const stranger = new NodeStorage({
    dir,
    storageKey: randomBytes(32),
    onRecovered: (info) => recovered.push(info),
  });
  const result = await stranger.doc('keyed', { defaults: { n: 99 } }).load();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, { n: 99 });
  assert.equal(recovered.length, 1);
});

test('a tampered doc is quarantined, a malformed envelope too', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const doc = storage.doc('tamper', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = 3;
  });
  await doc.flush();
  const text = await readFile(join(dir, 'tamper.json'), 'utf8');
  const at = text.indexOf('"b":"') + 20;
  const flipped = text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
  await writeFile(join(dir, 'tamper.json'), flipped);
  await writeFile(join(dir, 'shape.json'), '{"v":1,"b":"AAAA","extra":1}\n');
  await writeFile(join(dir, 'version.json'), '{"v":2,"b":""}\n');

  const recovered = [];
  const reader = new NodeStorage({ dir, storageKey: key, onRecovered: (info) => recovered.push(info) });
  const results = [];
  for (const name of ['tamper', 'shape', 'version']) {
    results.push(await reader.doc(name, { defaults: { n: -1 } }).load());
  }
  assert.deepEqual(results.map((r) => r.recovered), [true, true, true]);
  assert.deepEqual(results.map((r) => r.data), [{ n: -1 }, { n: -1 }, { n: -1 }]);
  assert.deepEqual(recovered.map((r) => r.file).sort(), ['shape.json', 'tamper.json', 'version.json']);
});

test('a doc that fails the validator is quarantined', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const doc = storage.doc('checked', { defaults: { n: 0 } });
  await doc.load();
  doc.update((d) => {
    d.n = -5;
  });
  await doc.flush();
  const strict = new NodeStorage({ dir, storageKey: key });
  const result = await strict
    .doc('checked', { defaults: { n: 1 }, validate: (value) => value.n >= 0 })
    .load();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, { n: 1 });
});

test('a sealed doc refuses data with no canonical form, and async mutators', async (t) => {
  const { storage } = await storageIn(t);
  const doc = storage.doc('canon', { defaults: { n: 0 } });
  await doc.load();
  assert.throws(() => doc.update((d) => {
    d.n = 1.5;
  }), StoreError);
  doc.update((d) => {
    d.n = 2;
  });
  assert.throws(() => doc.update(() => Promise.resolve()), StoreError);
  assert.throws(() => doc.update('nope'), StoreError);
  const fresh = storage.doc('unloaded', { defaults: {} });
  assert.throws(() => fresh.data, StateError);
  assert.throws(() => fresh.update(() => {}), StateError);
});

test('sealed log: round trip, reopen, rewrite', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const log = storage.log('journal');
  await log.open();
  for (let i = 0; i < 5; i += 1) await log.append({ i, text: 'x'.repeat(i) });
  assert.deepEqual((await readAll(log)).map((r) => r.i), [0, 1, 2, 3, 4]);
  await log.rewrite([{ i: 10 }, { i: 11 }]);
  await log.append({ i: 12 });
  assert.deepEqual((await readAll(log)).map((r) => r.i), [10, 11, 12]);
  await log.close();

  const again = new NodeStorage({ dir, storageKey: key }).log('journal');
  await again.open();
  assert.deepEqual((await readAll(again)).map((r) => r.i), [10, 11, 12]);
  await again.close();
});

test('sealed log: damage costs only the damaged records', async (t) => {
  const key = randomBytes(32);
  const dir = await tempDir(t, 'storage');
  const storage = new NodeStorage({ dir, storageKey: key });
  const a = storage.log('alpha');
  const b = storage.log('beta');
  await a.open();
  await b.open();
  await a.append({ n: 1 });
  await a.append({ n: 2 });
  await a.append({ n: 3 });
  await b.append({ n: 99 });
  await storage.closeAll();

  const lines = (await readFile(join(dir, 'alpha.log'), 'utf8')).split('\n').filter(Boolean);
  const betaLine = (await readFile(join(dir, 'beta.log'), 'utf8')).split('\n').filter(Boolean)[0];
  const at = lines[1].indexOf('"b":"') + 20;
  lines[1] = lines[1].slice(0, at) + (lines[1][at] === 'A' ? 'B' : 'A') + lines[1].slice(at + 1);
  lines.push(betaLine, '{"b":5}', '{"x":"y"}');
  await writeFile(join(dir, 'alpha.log'), `${lines.join('\n')}\n`);

  const again = new NodeStorage({ dir, storageKey: key }).log('alpha');
  await again.open();
  assert.deepEqual((await readAll(again)).map((r) => r.n), [1, 3]);
  assert.equal(again.stats.corruptLines, 4);
  await again.close();
});

test('sealed log: a torn tail is tolerated; float records are refused', async (t) => {
  const key = randomBytes(32);
  const dir = await tempDir(t, 'storage');
  const first = new NodeStorage({ dir, storageKey: key }).log('journal');
  await first.open();
  await first.append({ n: 1 });
  await first.close();
  const path = join(dir, 'journal.log');
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('{"b":"AAAA')]));

  const log = new NodeStorage({ dir, storageKey: key }).log('journal');
  await log.open();
  assert.equal(log.stats.tornBytes > 0, true);
  assert.deepEqual(await readAll(log), [{ n: 1 }]);
  await assert.rejects(log.append({ n: 1.5 }), StoreError);
  await assert.rejects(log.append([1]), StoreError);
  await assert.rejects(log.rewrite([{ ok: 1 }, { bad: 0.5 }]), StoreError);
  assert.deepEqual(await readAll(log), [{ n: 1 }]);
  await log.close();
});

test('blobs: put, get, delete, keys, overwrite', async (t) => {
  const { dir, storage } = await storageIn(t);
  const blobs = storage.blobs('outbox');
  assert.equal(await blobs.get('missing'), null);
  assert.deepEqual(await blobs.keys(), []);
  await blobs.put('b2', Buffer.from('two'));
  await blobs.put('a1', Buffer.from('one'));
  assert.deepEqual(await blobs.keys(), ['a1', 'b2']);
  assert.deepEqual(await blobs.get('a1'), Buffer.from('one'));
  await blobs.put('a1', Buffer.from('uno'));
  assert.deepEqual(await blobs.get('a1'), Buffer.from('uno'));
  await blobs.delete('a1');
  await blobs.delete('a1');
  assert.deepEqual(await blobs.keys(), ['b2']);
  await blobs.put('empty', Buffer.alloc(0));
  assert.equal((await blobs.get('empty')).length, 0);
  assert.deepEqual(await names(join(dir, 'outbox')), ['b2', 'empty']);
});

test('blobs: a blob copied to another key or another store fails to open', async (t) => {
  const { dir, storage } = await storageIn(t);
  const outbox = storage.blobs('outbox');
  const other = storage.blobs('other');
  await outbox.put('first', Buffer.from('payload'));
  await copyFile(join(dir, 'outbox', 'first'), join(dir, 'outbox', 'second'));
  await copyFile(join(dir, 'outbox', 'first'), join(dir, 'other', 'first'));
  await assert.rejects(outbox.get('second'), StoreError);
  await assert.rejects(other.get('first'), StoreError);
  assert.deepEqual(await outbox.get('first'), Buffer.from('payload'));

  const file = join(dir, 'outbox', 'first');
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(outbox.get('first'), StoreError);
});

test('blobs: keys are validated, and so are sizes', async (t) => {
  const { storage } = await storageIn(t);
  const blobs = storage.blobs('outbox', { maxBytes: 16 });
  const bad = ['', '.hidden', '../x', 'a/b', 'a\\b', 'UPPER', 'x'.repeat(65), 'trailing.', 'nul', 'con.txt', 'com1', 'a b', 'a\0b'];
  for (const key of bad) {
    await assert.rejects(blobs.put(key, Buffer.from('x')), StoreError, JSON.stringify(key));
    await assert.rejects(blobs.get(key), StoreError, JSON.stringify(key));
    await assert.rejects(blobs.delete(key), StoreError, JSON.stringify(key));
  }
  assert.ok(BLOB_KEY_PATTERN.test('ab12.cd_ef-gh'));
  await blobs.put('ok', Buffer.alloc(16));
  await assert.rejects(blobs.put('big', Buffer.alloc(17)), StoreError);
  await assert.rejects(blobs.put('str', 'text'), StoreError);
  assert.equal(MAX_BLOB_BYTES, 2 * 1024 * 1024);
  assert.throws(() => storage.blobs('zero', { maxBytes: 0 }), StoreError);
});

test('blobs: keys() ignores files that are not blob keys', async (t) => {
  const { dir, storage } = await storageIn(t);
  const blobs = storage.blobs('outbox');
  await blobs.put('real', Buffer.from('x'));
  await writeFile(join(dir, 'outbox', '.real.0123456789ab.tmp'), 'junk');
  await writeFile(join(dir, 'outbox', 'Not-A-Key'), 'junk');
  assert.deepEqual(await blobs.keys(), ['real']);
});

test('path() stays inside the directory', async (t) => {
  const { dir, storage } = await storageIn(t);
  assert.equal(storage.path('a', 'b.txt'), join(dir, 'a', 'b.txt'));
  assert.equal(storage.path(), dir);
  assert.equal(storage.path('a', '..', 'c'), join(dir, 'c'));
  assert.equal(storage.path('..foo'), join(dir, '..foo'));
  for (const parts of [['..', 'x'], ['a', '..', '..', 'x'], ['..'], [join(dir, 'x')], ['/etc/passwd'], ['a\0b'], [5]]) {
    assert.throws(() => storage.path(...parts), StoreError, JSON.stringify(parts));
  }
  if (process.platform === 'win32') {
    assert.throws(() => storage.path('C:\\Windows'), StoreError);
    assert.throws(() => storage.path('\\\\server\\share'), StoreError);
    assert.throws(() => storage.path('D:evil'), StoreError);
  }
});

test('scope() makes a private subdirectory with its own namespace', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  const services = storage.scope('services');
  const cast = services.scope('cast');
  assert.equal(cast.dir, join(dir, 'services', 'cast'));
  assert.equal((await stat(cast.dir)).isDirectory(), true);
  assert.equal(storage.scope('services'), services);
  if (process.platform !== 'win32') {
    assert.equal((await stat(cast.dir)).mode & 0o777, 0o700);
  }
  assert.equal(cast.path('x'), join(dir, 'services', 'cast', 'x'));
  assert.throws(() => cast.path('..', '..', 'keystore.json'), StoreError);

  const inCast = cast.doc('state', { defaults: { who: 'cast' } });
  const inRoot = storage.doc('state', { defaults: { who: 'root' } });
  await inCast.load();
  await inRoot.load();
  inCast.update((d) => {
    d.who = 'cast!';
  });
  await storage.closeAll();
  assert.deepEqual(await names(join(dir, 'services', 'cast')), ['state.json']);

  // The associated data names the scope: a doc cannot be moved between scopes.
  await copyFile(join(dir, 'services', 'cast', 'state.json'), join(dir, 'state.json'));
  const other = new NodeStorage({ dir, storageKey: key });
  const moved = await other.doc('state', { defaults: { who: 'default' } }).load();
  assert.equal(moved.recovered, true);
  assert.deepEqual(moved.data, { who: 'default' });
});

test('names are validated and cannot be used twice', async (t) => {
  const { storage } = await storageIn(t);
  for (const name of ['', 'Upper', '-lead', 'has space', 'a/b', '..', 'x'.repeat(33), 'a.b', 5, null]) {
    assert.throws(() => storage.doc(name, { defaults: {} }), StoreError, String(name));
    assert.throws(() => storage.log(name), StoreError, String(name));
    assert.throws(() => storage.blobs(name), StoreError, String(name));
    assert.throws(() => storage.scope(name), StoreError, String(name));
  }
  storage.doc('one', { defaults: {} });
  storage.log('one');
  storage.blobs('one');
  assert.throws(() => storage.doc('one', { defaults: {} }), StateError);
  assert.throws(() => storage.log('one'), StateError);
  assert.throws(() => storage.blobs('one'), StateError);
  assert.throws(() => storage.doc('two'), StoreError);
  assert.throws(() => storage.doc('two', { defaults: {}, validate: 5 }), StoreError);
  assert.throws(() => storage.log('two', { fsync: 'sometimes' }), StoreError);
});

test('constructor validates its arguments', async (t) => {
  const dir = await tempDir(t, 'storage');
  const key = randomBytes(32);
  assert.throws(() => new NodeStorage(), StoreError);
  assert.throws(() => new NodeStorage({ dir: '', storageKey: key }), StoreError);
  assert.throws(() => new NodeStorage({ dir, storageKey: randomBytes(31) }), StoreError);
  assert.throws(() => new NodeStorage({ dir, storageKey: 'x'.repeat(32) }), StoreError);
  assert.throws(() => new NodeStorage({ dir, storageKey: key, now: 5 }), StoreError);
  assert.throws(() => new NodeStorage({ dir, storageKey: key, onRecovered: 5 }), StoreError);
});

test('the storage keeps its own copy of the key', async (t) => {
  const dir = await tempDir(t, 'storage');
  const key = randomBytes(32);
  const storage = new NodeStorage({ dir, storageKey: key });
  const doc = storage.doc('wiped', { defaults: { n: 0 } });
  await doc.load();
  key.fill(0);
  doc.update((d) => {
    d.n = 1;
  });
  await storage.closeAll();
  assert.ok((await readFile(join(dir, 'wiped.json'))).length > 20);
});

test('a throwing onRecovered does not fail the load', async (t) => {
  const dir = await tempDir(t, 'storage');
  await writeFile(join(dir, 'bad.json'), 'not json');
  const storage = new NodeStorage({
    dir,
    storageKey: randomBytes(32),
    onRecovered: () => {
      throw new Error('observer bug');
    },
  });
  const result = await storage.doc('bad', { defaults: { ok: true }, sealed: false }).load();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, { ok: true });
});

test('a blob store created in a directory that already holds blobs lists them', async (t) => {
  const key = randomBytes(32);
  const { dir, storage } = await storageIn(t, { key });
  await storage.blobs('outbox').put('abc', Buffer.from('1'));
  await mkdir(join(dir, 'unrelated'), { recursive: true });
  const again = new NodeStorage({ dir, storageKey: key }).blobs('outbox');
  assert.deepEqual(await again.keys(), ['abc']);
  assert.deepEqual(await again.get('abc'), Buffer.from('1'));
});
