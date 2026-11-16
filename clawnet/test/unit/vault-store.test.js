import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  AppendLog,
  JsonFile,
  atomicCreateFile,
  atomicWriteFile,
  ensurePrivateDir,
  readAtMost,
  renameWithRetry,
  sweepTempFiles,
} from '../../src/vault/store.js';
import { StateError, StoreError } from '../../src/core/errors.js';
import { tempDir } from '../helpers/tmp.js';

const IS_WINDOWS = process.platform === 'win32';
const POSIX_ONLY = IS_WINDOWS ? 'POSIX permission bits do not exist on Windows' : false;
const WINDOWS_ONLY = IS_WINDOWS ? false : 'only Windows refuses to replace an open file';

async function listDir(dir) {
  return (await readdir(dir)).sort();
}

async function collect(log) {
  const records = [];
  for await (const record of log.read()) records.push(record);
  return records;
}

function nextTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Open a log for the duration of a test and close it afterwards, whatever happens. */
async function openLog(t, path, options) {
  const log = new AppendLog(path, options);
  await log.open();
  t.after(() => log.close().catch(() => {}));
  return log;
}

// ---------------------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------------------

test('atomicWriteFile creates and replaces a file and leaves nothing else behind', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'state.json');

  await atomicWriteFile(target, 'first');
  assert.equal(await readFile(target, 'utf8'), 'first');

  await atomicWriteFile(target, Buffer.from([0x00, 0xff, 0x0a, 0x7f]));
  assert.deepEqual(await readFile(target), Buffer.from([0x00, 0xff, 0x0a, 0x7f]));

  await atomicWriteFile(target, new Uint8Array([1, 2, 3]));
  assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3]));

  await atomicWriteFile(target, '');
  assert.equal((await stat(target)).size, 0);

  assert.deepEqual(await listDir(dir), ['state.json']);
});

test('atomicWriteFile writes strings as UTF-8', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'text');
  const text = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)}`;
  await atomicWriteFile(target, text);
  assert.deepEqual(await readFile(target), Buffer.from(text, 'utf8'));
  assert.equal((await readFile(target)).length, 10);
});

test('atomicWriteFile applies the requested mode', { skip: POSIX_ONLY }, async (t) => {
  const dir = await tempDir(t, 'vault');
  await atomicWriteFile(join(dir, 'default'), 'x');
  assert.equal((await stat(join(dir, 'default'))).mode & 0o777, 0o600);

  // Replacing a world-readable file must not inherit its permissions.
  await writeFile(join(dir, 'loose'), 'x', { mode: 0o644 });
  await chmod(join(dir, 'loose'), 0o644);
  await atomicWriteFile(join(dir, 'loose'), 'y');
  assert.equal((await stat(join(dir, 'loose'))).mode & 0o777, 0o600);

  await atomicWriteFile(join(dir, 'shared'), 'x', { mode: 0o640 });
  assert.equal((await stat(join(dir, 'shared'))).mode & 0o777, 0o640);
});

test('atomicWriteFile fails with StoreError when the directory does not exist', async (t) => {
  const dir = await tempDir(t, 'vault');
  await assert.rejects(atomicWriteFile(join(dir, 'missing', 'state.json'), 'x'), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'ERR_STORE');
    assert.equal(err.cause.code, 'ENOENT');
    return true;
  });
  assert.deepEqual(await listDir(dir), []);
});

test('atomicWriteFile removes its temporary file when the rename cannot succeed', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'occupied');
  // A directory can never be replaced by a file, so every rename attempt fails.
  await mkdir(target);
  await writeFile(join(target, 'keep'), 'precious');

  await assert.rejects(atomicWriteFile(target, 'x'), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(typeof err.cause.code, 'string');
    return true;
  });
  assert.deepEqual(await listDir(dir), ['occupied']);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'precious');
});

test('atomicWriteFile rejects invalid arguments without touching the disk', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'state.json');
  await assert.rejects(atomicWriteFile(target, 42), StoreError);
  await assert.rejects(atomicWriteFile(target, { a: 1 }), StoreError);
  await assert.rejects(atomicWriteFile(target, undefined), StoreError);
  await assert.rejects(atomicWriteFile('', 'x'), StoreError);
  await assert.rejects(atomicWriteFile(null, 'x'), StoreError);
  await assert.rejects(atomicWriteFile(`${target}\0`, 'x'), StoreError);
  await assert.rejects(atomicWriteFile(target, 'x', { mode: 0o1000 }), StoreError);
  await assert.rejects(atomicWriteFile(target, 'x', { mode: -1 }), StoreError);
  await assert.rejects(atomicWriteFile(target, 'x', { mode: 1.5 }), StoreError);
  assert.deepEqual(await listDir(dir), []);
});

test('concurrent atomic writes to one file all succeed and leave exactly one winner', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'state.json');
  const contents = Array.from({ length: 16 }, (_, i) => `writer-${i}-${'x'.repeat(4096)}`);

  await Promise.all(contents.map((content) => atomicWriteFile(target, content)));

  // Whichever rename came last, the file is one writer's complete content.
  assert.ok(contents.includes(await readFile(target, 'utf8')));
  assert.deepEqual(await listDir(dir), ['state.json']);
});

// ---------------------------------------------------------------------------------------
// atomicCreateFile
// ---------------------------------------------------------------------------------------

test('atomicCreateFile creates a complete file and leaves nothing else behind', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'keystore.json');
  await atomicCreateFile(target, 'secret content');
  assert.equal(await readFile(target, 'utf8'), 'secret content');
  await atomicCreateFile(join(dir, 'bytes'), new Uint8Array([0, 1, 2]));
  assert.deepEqual(await readFile(join(dir, 'bytes')), Buffer.from([0, 1, 2]));
  assert.deepEqual(await listDir(dir), ['bytes', 'keystore.json']);
});

test('atomicCreateFile never replaces anything and leaves no temporary file', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'keystore.json');
  await writeFile(target, 'original');
  await assert.rejects(atomicCreateFile(target, 'intruder'), (err) => {
    assert.ok(err instanceof StateError);
    assert.match(err.message, /already exists/);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), 'original');

  // An empty file is a file too: nothing is ever taken over.
  const empty = join(dir, 'empty');
  await writeFile(empty, '');
  await assert.rejects(atomicCreateFile(empty, 'x'), StateError);
  assert.equal((await stat(empty)).size, 0);
  assert.deepEqual(await listDir(dir), ['empty', 'keystore.json']);
});

test('of several concurrent atomicCreateFile calls exactly one wins, with its whole content', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'once');
  const contents = Array.from({ length: 12 }, (_, i) => `creator-${i}-${'y'.repeat(8192)}`);
  const results = await Promise.allSettled(contents.map((content) => atomicCreateFile(target, content)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(r.reason instanceof StateError);
  const winner = contents[results.findIndex((r) => r.status === 'fulfilled')];
  assert.equal(await readFile(target, 'utf8'), winner);
  assert.deepEqual(await listDir(dir), ['once']);
});

test('atomicCreateFile publishes only complete content: before the link there is no target', async (t) => {
  // Regression: creation used to reserve the name with an empty file first, so a crash
  // between reserving and writing left an empty file that blocked every later create.
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'keystore.json');
  const content = 'z'.repeat(200000);
  let checked = false;
  await atomicCreateFile(target, content, {}, {
    link: async (from, to) => {
      // This is the last moment a crash could happen before publication.
      await assert.rejects(stat(to), { code: 'ENOENT' });
      assert.equal((await readFile(from, 'utf8')).length, content.length, 'temporary file is complete');
      checked = true;
      await link(from, to);
    },
  });
  assert.ok(checked);
  assert.equal(await readFile(target, 'utf8'), content);
  assert.deepEqual(await listDir(dir), ['keystore.json']);
});

test('a failed atomicCreateFile leaves neither the target nor a temporary file', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'keystore.json');
  const failure = Object.assign(new Error('disk gone'), { code: 'EIO' });
  await assert.rejects(
    atomicCreateFile(target, 'x', {}, { link: async () => Promise.reject(failure) }),
    (err) => err instanceof StoreError && err.cause === failure,
  );
  assert.deepEqual(await listDir(dir), []);

  await assert.rejects(atomicCreateFile(join(dir, 'missing', 'f'), 'x'), StoreError);
  for (const [path, data, options] of [['', 'x'], [target, 42], [target, null], [target, 'x', { mode: 0o1000 }], [`${target}\0`, 'x']]) {
    await assert.rejects(atomicCreateFile(path, data, options), StoreError);
  }
  assert.deepEqual(await listDir(dir), []);
});

test('atomicCreateFile falls back to an exclusive create where hard links are missing', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'keystore.json');
  const noLinks = { link: async () => Promise.reject(Object.assign(new Error('no links'), { code: 'ENOTSUP' })) };
  await atomicCreateFile(target, 'fallback', {}, noLinks);
  assert.equal(await readFile(target, 'utf8'), 'fallback');
  await assert.rejects(atomicCreateFile(target, 'second', {}, noLinks), StateError);
  assert.equal(await readFile(target, 'utf8'), 'fallback');
  assert.deepEqual(await listDir(dir), ['keystore.json']);
});

test('readAtMost reads a whole file but never more than its limit', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'f');
  const content = Buffer.alloc(200000, 7);
  await writeFile(path, content);
  const handle = await open(path, 'r');
  t.after(() => handle.close());
  assert.deepEqual(await readAtMost(handle, content.length), content);
  const again = await open(path, 'r');
  t.after(() => again.close());
  assert.equal(await readAtMost(again, content.length - 1), undefined);
  const third = await open(path, 'r');
  t.after(() => third.close());
  await assert.rejects(readAtMost(third, 0), StoreError);
});

test('atomicWriteFile waits out a file that another handle briefly holds open', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'state.json');
  await writeFile(target, 'old');

  const holder = await open(target, 'r');
  let closing = null;
  try {
    // Precondition: while the handle is open, a plain rename over the file is refused.
    await writeFile(join(dir, 'probe'), 'probe');
    await assert.rejects(rename(join(dir, 'probe'), target), { code: 'EPERM' });
    await rm(join(dir, 'probe'));

    const timer = setTimeout(() => {
      closing = holder.close();
    }, 40);
    t.after(() => clearTimeout(timer));

    await atomicWriteFile(target, 'new');
    // The write cannot have succeeded before the handle was released.
    assert.notEqual(closing, null);
  } finally {
    await (closing ?? holder.close());
  }

  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.deepEqual(await listDir(dir), ['state.json']);
});

// ---------------------------------------------------------------------------------------
// renameWithRetry
// ---------------------------------------------------------------------------------------

function failingRename(codes) {
  const calls = [];
  const queue = [...codes];
  return {
    calls,
    rename: async (from, to) => {
      calls.push([from, to]);
      const code = queue.shift();
      if (code !== undefined) throw Object.assign(new Error(`injected ${code}`), { code });
      await rename(from, to);
    },
  };
}

test('renameWithRetry retries transient Windows errors with increasing waits', async (t) => {
  const dir = await tempDir(t, 'vault');
  const from = join(dir, 'a');
  const to = join(dir, 'b');
  await writeFile(from, 'payload');

  const waits = [];
  const injected = failingRename(['EPERM', 'EBUSY', 'EACCES']);
  await renameWithRetry(from, to, {
    platform: 'win32',
    rename: injected.rename,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(injected.calls.length, 4);
  assert.deepEqual(waits, [10, 25, 50]);
  // The final attempt is the real rename.
  assert.equal(await readFile(to, 'utf8'), 'payload');
  assert.deepEqual(await listDir(dir), ['b']);
});

test('renameWithRetry gives up after a bounded number of attempts', async () => {
  const waits = [];
  const injected = failingRename(Array.from({ length: 50 }, () => 'EBUSY'));
  await assert.rejects(
    renameWithRetry('a', 'b', {
      platform: 'win32',
      rename: injected.rename,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.cause.code, 'EBUSY');
      return true;
    },
  );
  assert.equal(injected.calls.length, 6);
  assert.deepEqual(waits, [10, 25, 50, 100, 200]);
});

test('renameWithRetry does not retry errors that are not transient', async () => {
  for (const code of ['ENOENT', 'EXDEV', 'ENOSPC', 'EISDIR']) {
    const waits = [];
    const injected = failingRename([code, code]);
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: injected.rename,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
      (err) => err instanceof StoreError && err.cause.code === code,
      code,
    );
    assert.equal(injected.calls.length, 1, code);
    assert.deepEqual(waits, [], code);
  }
});

test('renameWithRetry never retries on platforms other than Windows', async () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const waits = [];
    const injected = failingRename(['EPERM', 'EPERM']);
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform,
        rename: injected.rename,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
      (err) => err instanceof StoreError && err.cause.code === 'EPERM',
      platform,
    );
    assert.equal(injected.calls.length, 1, platform);
    assert.deepEqual(waits, [], platform);
  }
});

test('renameWithRetry reports a missing source as StoreError using the real rename', async (t) => {
  const dir = await tempDir(t, 'vault');
  await assert.rejects(renameWithRetry(join(dir, 'absent'), join(dir, 'b')), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.cause.code, 'ENOENT');
    return true;
  });
});

// ---------------------------------------------------------------------------------------
// ensurePrivateDir, sweepTempFiles
// ---------------------------------------------------------------------------------------

test('ensurePrivateDir creates nested directories and is idempotent', async (t) => {
  const dir = await tempDir(t, 'vault');
  const nested = join(dir, 'a', 'b', 'c');
  await ensurePrivateDir(nested);
  assert.ok((await stat(nested)).isDirectory());

  await writeFile(join(nested, 'file'), 'kept');
  await ensurePrivateDir(nested);
  assert.equal(await readFile(join(nested, 'file'), 'utf8'), 'kept');
});

test('ensurePrivateDir refuses a path that is not a directory', async (t) => {
  const dir = await tempDir(t, 'vault');
  await writeFile(join(dir, 'file'), 'x');
  await assert.rejects(ensurePrivateDir(join(dir, 'file')), StoreError);
  await assert.rejects(ensurePrivateDir(join(dir, 'file', 'below')), StoreError);
  await assert.rejects(ensurePrivateDir(''), StoreError);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'x');
});

test('ensurePrivateDir makes directories owner-only and tightens existing ones', { skip: POSIX_ONLY }, async (t) => {
  const dir = await tempDir(t, 'vault');
  const fresh = join(dir, 'fresh', 'leaf');
  await ensurePrivateDir(fresh);
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);

  const loose = join(dir, 'loose');
  await mkdir(loose);
  await chmod(loose, 0o755);
  await ensurePrivateDir(loose);
  assert.equal((await stat(loose)).mode & 0o777, 0o700);
});

test('sweepTempFiles removes only leftovers of the given target', async (t) => {
  const dir = await tempDir(t, 'vault');
  const target = join(dir, 'state.json');
  await writeFile(target, '{}');
  await writeFile(join(dir, '.state.json.0123456789ab.tmp'), 'leftover');
  await writeFile(join(dir, '.state.json.ffffffffffff.tmp'), 'leftover');
  await writeFile(join(dir, '.other.json.0123456789ab.tmp'), 'someone else');
  await writeFile(join(dir, '.state.json.notes.tmp'), 'not ours');
  await writeFile(join(dir, '.state.json.0123456789zz.tmp'), 'not hex');
  await writeFile(join(dir, '.state.json.0123.tmp'), 'too short');
  await writeFile(join(dir, 'state.json.corrupt-1'), 'quarantined');

  assert.equal(await sweepTempFiles(target), 2);
  assert.deepEqual(await listDir(dir), [
    '.other.json.0123456789ab.tmp',
    '.state.json.0123.tmp',
    '.state.json.0123456789zz.tmp',
    '.state.json.notes.tmp',
    'state.json',
    'state.json.corrupt-1',
  ]);
  assert.equal(await sweepTempFiles(target), 0);
  assert.equal(await sweepTempFiles(join(dir, 'no-such-dir', 'state.json')), 0);
});

// ---------------------------------------------------------------------------------------
// JsonFile
// ---------------------------------------------------------------------------------------

test('JsonFile yields a private copy of the defaults when there is no file', async (t) => {
  const dir = await tempDir(t, 'vault');
  const defaults = { peers: [], seq: 0, nested: { a: 1 } };
  const file = new JsonFile(join(dir, 'state.json'), { defaults });

  const result = await file.load();
  assert.deepEqual(result, { data: { peers: [], seq: 0, nested: { a: 1 } }, recovered: false, corruptPath: null });
  assert.equal(file.data, result.data);
  assert.notEqual(file.data, defaults);

  file.update((data) => {
    data.peers.push('x');
    data.nested.a = 2;
  });
  await file.flush();
  assert.deepEqual(defaults, { peers: [], seq: 0, nested: { a: 1 } });
  // Loading alone writes nothing; the file appears with the first save.
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), {
    peers: ['x'],
    seq: 0,
    nested: { a: 2 },
  });
});

test('JsonFile does not create a file until something is saved', async (t) => {
  const dir = await tempDir(t, 'vault');
  const file = new JsonFile(join(dir, 'state.json'), { defaults: {} });
  await file.load();
  await file.flush();
  assert.deepEqual(await listDir(dir), []);
  assert.deepEqual(file.stats, { writes: 0, dirty: false, lastError: null });
});

test('JsonFile round-trips state through a second instance', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const first = new JsonFile(path, { defaults: { seq: 0, names: [] } });
  await first.load();
  first.update((data) => {
    data.seq = 41;
    data.names.push(`z${String.fromCodePoint(0xfc)}rich`, 'line\nbreak');
    data.ratio = 0.25;
  });
  await first.flush();

  const second = new JsonFile(path, { defaults: { seq: 0, names: [] } });
  const result = await second.load();
  assert.equal(result.recovered, false);
  assert.deepEqual(result.data, {
    seq: 41,
    names: [`z${String.fromCodePoint(0xfc)}rich`, 'line\nbreak'],
    ratio: 0.25,
  });
  assert.deepEqual(await listDir(dir), ['state.json']);
});

test('JsonFile coalesces updates made in one tick into a single write', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const file = new JsonFile(path, { defaults: { n: 0 } });
  await file.load();

  for (let i = 1; i <= 200; i += 1) {
    file.update((data) => {
      data.n = i;
    });
  }
  assert.equal(file.stats.dirty, true);
  await file.flush();

  assert.deepEqual(file.stats, { writes: 1, dirty: false, lastError: null });
  assert.equal(await readFile(path, 'utf8'), '{"n":200}\n');
});

test('JsonFile never overlaps writes and the last state wins', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const file = new JsonFile(path, { defaults: { n: 0 } });
  await file.load();

  // Count this file's temporary files while updates keep arriving during writes: two at
  // once would mean two writes in flight.
  let sampling = true;
  let mostTemps = 0;
  const sampler = (async () => {
    while (sampling) {
      const temps = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
      mostTemps = Math.max(mostTemps, temps.length);
      await nextTurn();
    }
  })();

  const updates = 300;
  for (let i = 1; i <= updates; i += 1) {
    file.update((data) => {
      data.n = i;
    });
    await nextTurn();
  }
  await file.flush();
  sampling = false;
  await sampler;

  assert.ok(mostTemps <= 1, `saw ${mostTemps} temporary files at once`);
  const { writes } = file.stats;
  assert.ok(writes >= 2, `expected several writes, got ${writes}`);
  assert.ok(writes < updates, `expected coalescing, got ${writes} writes for ${updates} updates`);
  assert.equal(await readFile(path, 'utf8'), `{"n":${updates}}\n`);
  assert.deepEqual(await listDir(dir), ['state.json']);
});

test('JsonFile.save writes even when nothing changed', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const file = new JsonFile(path, { defaults: { a: 1 } });
  await file.load();
  await file.save();
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
  await file.save();
  assert.equal(file.stats.writes, 2);
});

test('JsonFile moves a corrupt file aside and continues from the defaults', async (t) => {
  const cases = [
    ['garbage', Buffer.from('this is not json')],
    ['truncated', Buffer.from('{"seq":41,"names":["a"')],
    ['empty', Buffer.alloc(0)],
    ['invalid utf-8', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
    ['nul bytes', Buffer.alloc(64)],
    ['trailing garbage', Buffer.from('{"seq":1}{"seq":2}')],
  ];
  for (const [name, bytes] of cases) {
    const dir = await tempDir(t, 'vault');
    const path = join(dir, 'state.json');
    await writeFile(path, bytes);

    const file = new JsonFile(path, { defaults: { seq: 0 }, now: () => 1700000000000 });
    const result = await file.load();

    assert.equal(result.recovered, true, name);
    assert.deepEqual(result.data, { seq: 0 }, name);
    assert.equal(result.corruptPath, `${path}.corrupt-20231114T221320000Z`, name);
    // The damaged bytes are preserved exactly, under the new name only.
    assert.deepEqual(await readFile(result.corruptPath), bytes, name);
    assert.deepEqual(await listDir(dir), ['state.json.corrupt-20231114T221320000Z'], name);

    file.update((data) => {
      data.seq = 7;
    });
    await file.flush();
    assert.equal(await readFile(path, 'utf8'), '{"seq":7}\n', name);
    assert.deepEqual(await readFile(result.corruptPath), bytes, name);
  }
});

test('JsonFile never replaces an earlier quarantined copy', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const options = { defaults: {}, now: () => 1700000000000 };

  for (const content of ['first damage', 'second damage', 'third damage']) {
    await writeFile(path, content);
    const result = await new JsonFile(path, options).load();
    assert.equal(result.recovered, true);
  }

  assert.deepEqual(await listDir(dir), [
    'state.json.corrupt-20231114T221320000Z',
    'state.json.corrupt-20231114T221320000Z-1',
    'state.json.corrupt-20231114T221320000Z-2',
  ]);
  assert.equal(await readFile(`${path}.corrupt-20231114T221320000Z`, 'utf8'), 'first damage');
  assert.equal(await readFile(`${path}.corrupt-20231114T221320000Z-1`, 'utf8'), 'second damage');
  assert.equal(await readFile(`${path}.corrupt-20231114T221320000Z-2`, 'utf8'), 'third damage');
});

test('JsonFile treats a file that fails validation as corrupt', async (t) => {
  const validators = [
    ['throws', (value) => {
      if (!Number.isInteger(value.seq)) throw new Error('seq must be an integer');
    }],
    ['returns false', (value) => Number.isInteger(value.seq)],
  ];
  for (const [name, validate] of validators) {
    const dir = await tempDir(t, 'vault');
    const path = join(dir, 'state.json');

    await writeFile(path, '{"seq":"not a number"}');
    const bad = await new JsonFile(path, { defaults: { seq: 0 }, validate }).load();
    assert.equal(bad.recovered, true, name);
    assert.deepEqual(bad.data, { seq: 0 }, name);
    assert.equal(await readFile(bad.corruptPath, 'utf8'), '{"seq":"not a number"}', name);

    await writeFile(path, '{"seq":12}');
    const good = await new JsonFile(path, { defaults: { seq: 0 }, validate }).load();
    assert.deepEqual(good, { data: { seq: 12 }, recovered: false, corruptPath: null }, name);
  }
});

test('JsonFile treats an oversized file as corrupt instead of loading it', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const content = JSON.stringify({ blob: 'x'.repeat(1000) });
  await writeFile(path, content);

  const within = await new JsonFile(path, { defaults: {}, maxBytes: content.length }).load();
  assert.equal(within.recovered, false);

  const result = await new JsonFile(path, { defaults: {}, maxBytes: content.length - 1 }).load();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, {});
  assert.equal(await readFile(result.corruptPath, 'utf8'), content);
});

test('JsonFile reports an unreadable path as StoreError and can be retried', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  await mkdir(path);

  const file = new JsonFile(path, { defaults: { a: 1 } });
  await assert.rejects(file.load(), StoreError);
  assert.throws(() => file.data, StateError);
  // Nothing was moved aside: a directory is not a corrupt state file.
  assert.deepEqual(await listDir(dir), ['state.json']);

  await rm(path, { recursive: true });
  assert.deepEqual(await file.load(), { data: { a: 1 }, recovered: false, corruptPath: null });
});

test('JsonFile refuses to be used before load and to be loaded twice', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  await writeFile(path, '{"kept":true}');
  const file = new JsonFile(path, { defaults: {} });

  assert.throws(() => file.data, StateError);
  assert.throws(() => file.update(() => {}), StateError);
  await assert.rejects(file.save(), StateError);
  await assert.rejects(file.flush(), StateError);
  // None of the refused calls may have replaced the file that was never read.
  assert.equal(await readFile(path, 'utf8'), '{"kept":true}');

  const loading = file.load();
  await assert.rejects(file.load(), StateError);
  await loading;
  await assert.rejects(file.load(), (err) => err instanceof StateError && err.code === 'ERR_STATE');
  assert.deepEqual(file.data, { kept: true });
});

test('JsonFile validates its options', () => {
  assert.throws(() => new JsonFile('state.json'), StoreError);
  assert.throws(() => new JsonFile('state.json', {}), StoreError);
  assert.throws(() => new JsonFile('', { defaults: {} }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: () => {} }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: { big: 10n } }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: {}, validate: 'yes' }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: {}, onError: 1 }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: {}, now: 5 }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: {}, maxBytes: 0 }), StoreError);
  assert.throws(() => new JsonFile('state.json', { defaults: {}, mode: 0o7777 }), StoreError);
  assert.equal(new JsonFile('state.json', { defaults: null }).path, 'state.json');
});

test('JsonFile.update rejects misuse and keeps partial changes consistent with disk', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const file = new JsonFile(path, { defaults: { n: 0 } });
  await file.load();

  assert.throws(() => file.update('nope'), StoreError);
  assert.throws(() => file.update(async () => {}), StoreError);

  // A mutator that throws half way: what it changed is in memory, so it must reach disk.
  assert.throws(
    () => file.update((data) => {
      data.n = 5;
      throw new RangeError('half way');
    }),
    RangeError,
  );
  await file.flush();
  assert.equal(await readFile(path, 'utf8'), '{"n":5}\n');

  // The return value of a mutator is ignored, so an expression body cannot replace the state.
  file.update((data) => (data.n += 1));
  await file.flush();
  assert.deepEqual(file.data, { n: 6 });
  assert.equal(await readFile(path, 'utf8'), '{"n":6}\n');
});

test('JsonFile surfaces a failed save, keeps the state, and succeeds on retry', async (t) => {
  const dir = await tempDir(t, 'vault');
  const sub = join(dir, 'sub');
  await mkdir(sub);
  const path = join(sub, 'state.json');
  const reported = [];
  const file = new JsonFile(path, {
    defaults: { n: 0 },
    onError: (error) => {
      reported.push(error);
    },
  });
  await file.load();

  // Take the directory away: the background save must fail without an unhandled rejection.
  await rm(sub, { recursive: true });
  file.update((data) => {
    data.n = 1;
  });
  await assert.rejects(file.flush(), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.cause.code, 'ENOENT');
    return true;
  });
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof StoreError);
  assert.equal(file.stats.dirty, true);
  assert.equal(file.stats.lastError, reported[0]);
  assert.equal(file.stats.writes, 0);
  assert.deepEqual(file.data, { n: 1 });

  await mkdir(sub);
  await file.flush();
  assert.deepEqual(file.stats, { writes: 1, dirty: false, lastError: null });
  assert.equal(await readFile(path, 'utf8'), '{"n":1}\n');
  assert.deepEqual(await listDir(sub), ['state.json']);
});

test('JsonFile survives an onError callback that throws', async (t) => {
  const dir = await tempDir(t, 'vault');
  const sub = join(dir, 'sub');
  await mkdir(sub);
  let calls = 0;
  const file = new JsonFile(join(sub, 'state.json'), {
    defaults: {},
    onError: () => {
      calls += 1;
      throw new Error('observer bug');
    },
  });
  await file.load();
  await rm(sub, { recursive: true });
  file.update((data) => {
    data.a = 1;
  });
  await assert.rejects(file.flush(), StoreError);
  assert.equal(calls, 1);
});

test('JsonFile reports state that cannot be serialized and leaves the old file intact', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  const file = new JsonFile(path, { defaults: { ok: true } });
  await file.load();
  await file.save();

  file.update((data) => {
    data.self = data;
  });
  await assert.rejects(file.flush(), StoreError);
  assert.equal(await readFile(path, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(await listDir(dir), ['state.json']);

  file.update((data) => {
    delete data.self;
    data.fixed = 1;
  });
  await file.flush();
  assert.equal(await readFile(path, 'utf8'), '{"ok":true,"fixed":1}\n');
});

test('JsonFile.load clears temporary files left by a crash', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'state.json');
  await writeFile(path, '{"n":3}');
  await writeFile(join(dir, '.state.json.00112233aabb.tmp'), '{"n":4');

  const result = await new JsonFile(path, { defaults: {} }).load();
  assert.deepEqual(result.data, { n: 3 });
  assert.deepEqual(await listDir(dir), ['state.json']);
});

// ---------------------------------------------------------------------------------------
// AppendLog
// ---------------------------------------------------------------------------------------

test('AppendLog appends one JSON object per line and reads them back in order', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = await openLog(t, path);

  const records = [
    { n: 1, text: 'plain' },
    { n: 2, text: 'line\nbreak and "quotes"' },
    { n: 3, text: `${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)}`, nested: { list: [1, 2, 3] } },
    {},
  ];
  for (const record of records) await log.append(record);

  assert.deepEqual(await collect(log), records);
  const text = await readFile(path, 'utf8');
  assert.equal(text, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  assert.deepEqual(log.stats, {
    bytes: Buffer.byteLength(text),
    appended: 4,
    corruptLines: 0,
    tornBytes: 0,
    syncs: log.stats.syncs,
  });
});

test('AppendLog keeps its records across close and reopen', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');

  const first = new AppendLog(path);
  await first.open();
  await first.append({ n: 1 });
  await first.append({ n: 2 });
  await first.close();
  await first.close();

  const second = await openLog(t, path);
  assert.deepEqual(second.stats, { bytes: 16, appended: 0, corruptLines: 0, tornBytes: 0, syncs: 0 });
  await second.append({ n: 3 });
  assert.deepEqual(await collect(second), [{ n: 1 }, { n: 2 }, { n: 3 }]);

  // The same instance can be reopened after close.
  await second.close();
  await second.open();
  assert.deepEqual(await collect(second), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('AppendLog survives a crash at every byte offset of the last record', async (t) => {
  const dir = await tempDir(t, 'vault');
  const source = join(dir, 'source.jsonl');
  const kept = [{ n: 1, note: 'first' }, { n: 2, note: `caf${String.fromCodePoint(0xe9)}` }];
  const last = { n: 3, note: `torn ${String.fromCodePoint(0x1f600)} tail`, list: [1, { deep: true }] };

  const writer = new AppendLog(source);
  await writer.open();
  for (const record of [...kept, last]) await writer.append(record);
  await writer.close();

  const full = await readFile(source);
  const lastLine = Buffer.from(`${JSON.stringify(last)}\n`, 'utf8');
  const start = full.length - lastLine.length;
  assert.deepEqual(full.subarray(start), lastLine);
  // The record contains multi-byte characters, so some offsets split a code point.
  assert.ok(lastLine.length > JSON.stringify(last).length + 1);

  const path = join(dir, 'crashed.jsonl');
  for (let offset = start; offset <= full.length; offset += 1) {
    await writeFile(path, full.subarray(0, offset));
    const complete = offset === full.length;

    const log = new AppendLog(path);
    await log.open();
    try {
      assert.deepEqual(await collect(log), complete ? [...kept, last] : kept, `offset ${offset}`);
      assert.equal(log.stats.tornBytes, complete ? 0 : offset - start, `offset ${offset}`);
      assert.equal(log.stats.corruptLines, 0, `offset ${offset}`);
      assert.equal(log.stats.bytes, complete ? full.length : start, `offset ${offset}`);
      // The torn bytes are gone from the file itself, not merely skipped.
      assert.equal((await stat(path)).size, complete ? full.length : start, `offset ${offset}`);

      // The log must be fully usable again: a new record follows the last intact one.
      await log.append({ n: 'after' });
      assert.deepEqual(
        await collect(log),
        complete ? [...kept, last, { n: 'after' }] : [...kept, { n: 'after' }],
        `offset ${offset}`,
      );
    } finally {
      await log.close();
    }

    const reopened = new AppendLog(path);
    await reopened.open();
    try {
      assert.equal(reopened.stats.tornBytes, 0, `offset ${offset}`);
      assert.equal((await collect(reopened)).length, complete ? 4 : 3, `offset ${offset}`);
    } finally {
      await reopened.close();
    }
  }
});

test('AppendLog read at any truncation point of the whole file yields a prefix of the records', async (t) => {
  const dir = await tempDir(t, 'vault');
  const source = join(dir, 'source.jsonl');
  const records = [{ a: 1 }, { b: 'two' }, { c: [3] }, { d: { e: 4 } }];
  const writer = new AppendLog(source, { fsync: 'never' });
  await writer.open();
  for (const record of records) await writer.append(record);
  await writer.close();
  const full = await readFile(source);

  // Offsets at which each record becomes complete.
  const ends = [];
  for (let i = 0; i < full.length; i += 1) if (full[i] === 0x0a) ends.push(i + 1);
  assert.equal(ends.length, records.length);

  const path = join(dir, 'crashed.jsonl');
  for (let offset = 0; offset <= full.length; offset += 1) {
    await writeFile(path, full.subarray(0, offset));
    const log = new AppendLog(path, { fsync: 'never' });
    await log.open();
    try {
      const expected = ends.filter((end) => end <= offset).length;
      assert.deepEqual(await collect(log), records.slice(0, expected), `offset ${offset}`);
      assert.equal(log.stats.bytes, expected === 0 ? 0 : ends[expected - 1], `offset ${offset}`);
    } finally {
      await log.close();
    }
  }
});

test('AppendLog removes a torn tail longer than one read chunk', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const head = '{"n":1}\n';
  // 200 KiB without a newline: the backwards scan has to cross several chunks.
  await writeFile(path, `${head}{"blob":"${'x'.repeat(200 * 1024)}`);

  const log = await openLog(t, path);
  assert.equal(log.stats.tornBytes, 200 * 1024 + 9);
  assert.equal((await stat(path)).size, head.length);
  assert.deepEqual(await collect(log), [{ n: 1 }]);
});

test('AppendLog skips and counts corrupt lines in the middle', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const lines = [
    Buffer.from('{"n":1}\n'),
    Buffer.from('garbage{{{\n'),
    Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d, 0x0a]),
    Buffer.from('42\n'),
    Buffer.from('[1,2]\n'),
    Buffer.from('null\n'),
    Buffer.from('"text"\n'),
    Buffer.from('\n'),
    Buffer.from('{"n":2}{"n":3}\n'),
    Buffer.concat([Buffer.alloc(32), Buffer.from('\n')]),
    Buffer.from('{"n":4}\r\n'),
    Buffer.from('{"n":5}\n'),
  ];
  await writeFile(path, Buffer.concat(lines));

  const log = await openLog(t, path);
  assert.equal(log.stats.tornBytes, 0);
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 4 }, { n: 5 }]);
  assert.equal(log.stats.corruptLines, 9);

  // Damage is reported, not repaired: the file is untouched and appending still works.
  assert.deepEqual(await readFile(path), Buffer.concat(lines));
  await log.append({ n: 6 });
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 4 }, { n: 5 }, { n: 6 }]);
  assert.equal(log.stats.corruptLines, 9);
});

test('AppendLog handles a corrupt middle and a torn tail together', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  await writeFile(path, '{"n":1}\n{"n":2\n{"n":3}\n{"n":4,"tex');

  const log = await openLog(t, path);
  assert.equal(log.stats.tornBytes, 11);
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 3 }]);
  assert.equal(log.stats.corruptLines, 1);
  assert.equal(await readFile(path, 'utf8'), '{"n":1}\n{"n":2\n{"n":3}\n');
});

test('AppendLog reads records larger than a read chunk', async (t) => {
  const dir = await tempDir(t, 'vault');
  const log = await openLog(t, join(dir, 'log.jsonl'));
  const big = { blob: `${'a'.repeat(150000)}${String.fromCodePoint(0x1f600).repeat(20000)}` };
  await log.append({ n: 1 });
  await log.append(big);
  await log.append({ n: 2 });
  const records = await collect(log);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], { n: 1 });
  assert.equal(records[1].blob, big.blob);
  assert.deepEqual(records[2], { n: 2 });
});

test('AppendLog enforces the record size limit on append and on read', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  // Two oversized lines, one longer than a read chunk and one well inside a chunk, each
  // followed by a record that must survive.
  await writeFile(
    path,
    `{"n":1}\n{"blob":"${'x'.repeat(200000)}"}\n{"n":2}\n{"blob":"${'y'.repeat(60)}"}\n{"n":3}\n`,
  );

  const log = await openLog(t, path, { maxRecordBytes: 32 });
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(log.stats.corruptLines, 2);

  const exact = { blob: 'y'.repeat(32 - '{"blob":""}'.length) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 32);
  await log.append(exact);
  await assert.rejects(log.append({ blob: `${exact.blob}y` }), StoreError);
  // Size is measured in bytes, not characters.
  await assert.rejects(log.append({ blob: String.fromCodePoint(0x1f600).repeat(6) }), StoreError);
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 2 }, { n: 3 }, exact]);
});

test('AppendLog rejects records that are not JSON objects and writes nothing for them', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = await openLog(t, path);

  const circular = {};
  circular.self = circular;
  const rejected = [
    null,
    undefined,
    42,
    'text',
    [1, 2],
    circular,
    { big: 10n },
    { toJSON: () => 'a string instead' },
    { toJSON: () => undefined },
    { toJSON: () => [1] },
    // Regression: these serialize as "{}", so they used to be stored as empty records.
    new Map([['a', 1]]),
    new Set([1]),
    new (class Record {
      constructor() {
        this.a = 1;
      }
    })(),
  ];
  for (const record of rejected) {
    await assert.rejects(log.append(record), StoreError);
  }
  assert.equal((await stat(path)).size, 0);
  assert.equal(log.stats.appended, 0);

  // A record is serialized when append() is called, not when it is written.
  const record = { n: 1 };
  const pending = log.append(record);
  record.n = 2;
  await pending;
  assert.deepEqual(await collect(log), [{ n: 1 }]);
});

test('AppendLog keeps concurrent appends in call order', async (t) => {
  const dir = await tempDir(t, 'vault');
  const log = await openLog(t, join(dir, 'log.jsonl'));
  const records = Array.from({ length: 500 }, (_, n) => ({ n, pad: 'p'.repeat(n % 97) }));

  await Promise.all(records.map((record) => log.append(record)));

  assert.deepEqual(await collect(log), records);
  assert.equal(log.stats.appended, 500);
});

test('AppendLog writes batches larger than the batch limit completely and in order', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = new AppendLog(path, { fsync: 'never' });
  await log.open();
  // About 6 MiB queued at once, so the writer needs several batches; close() must still
  // wait for every one of them.
  const records = Array.from({ length: 24 }, (_, n) => ({ n, blob: String(n % 10).repeat(256 * 1024) }));
  const appends = records.map((record) => log.append(record));
  await log.close();
  await Promise.all(appends);

  const reopened = await openLog(t, path, { fsync: 'never' });
  const seen = await collect(reopened);
  assert.equal(seen.length, 24);
  for (let n = 0; n < 24; n += 1) {
    assert.equal(seen[n].n, n);
    assert.equal(seen[n].blob, records[n].blob);
  }
});

test('AppendLog fsync policy decides when the file is synced', async (t) => {
  const dir = await tempDir(t, 'vault');

  const never = await openLog(t, join(dir, 'never.jsonl'), { fsync: 'never' });
  for (let n = 0; n < 5; n += 1) await never.append({ n });
  await never.flush();
  assert.equal(never.stats.syncs, 0);

  const always = await openLog(t, join(dir, 'always.jsonl'), { fsync: 'always' });
  for (let n = 0; n < 5; n += 1) {
    await always.append({ n });
    // Durable by the time append() resolves: one fsync per awaited record.
    assert.equal(always.stats.syncs, n + 1);
  }
  await Promise.all(Array.from({ length: 10 }, (_, n) => always.append({ n })));
  // Ten appends queued together share one write and one fsync.
  assert.equal(always.stats.syncs, 6);
  await always.flush();
  assert.equal(always.stats.syncs, 6);

  const batch = await openLog(t, join(dir, 'batch.jsonl'), { fsync: 'batch' });
  await Promise.all(Array.from({ length: 10 }, (_, n) => batch.append({ n })));
  await batch.flush();
  assert.equal(batch.stats.syncs, 1);
  for (let n = 0; n < 5; n += 1) await batch.append({ n });
  await batch.flush();
  const { syncs } = batch.stats;
  assert.ok(syncs >= 2 && syncs <= 6, `expected 2..6 fsyncs, got ${syncs}`);
  // Nothing new to cover: flushing again does not sync again.
  await batch.flush();
  assert.equal(batch.stats.syncs, syncs);
});

test('AppendLog syncs a repaired file unless fsync is "never"', async (t) => {
  const dir = await tempDir(t, 'vault');
  await writeFile(join(dir, 'a.jsonl'), '{"n":1}\n{"n":');
  await writeFile(join(dir, 'b.jsonl'), '{"n":1}\n{"n":');

  const synced = await openLog(t, join(dir, 'a.jsonl'), { fsync: 'batch' });
  assert.deepEqual(synced.stats, { bytes: 8, appended: 0, corruptLines: 0, tornBytes: 5, syncs: 1 });

  const unsynced = await openLog(t, join(dir, 'b.jsonl'), { fsync: 'never' });
  assert.deepEqual(unsynced.stats, { bytes: 8, appended: 0, corruptLines: 0, tornBytes: 5, syncs: 0 });
});

test('AppendLog.read sees the records committed when iteration starts', async (t) => {
  const dir = await tempDir(t, 'vault');
  const log = await openLog(t, join(dir, 'log.jsonl'));
  await log.append({ n: 1 });
  await log.append({ n: 2 });

  const seen = [];
  for await (const record of log.read()) {
    seen.push(record);
    // Appending while reading is allowed and does not extend this iteration.
    await log.append({ n: seen.length + 100 });
  }
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(await collect(log), [{ n: 1 }, { n: 2 }, { n: 101 }, { n: 102 }]);

  // An empty log yields nothing.
  const empty = await openLog(t, join(dir, 'empty.jsonl'));
  assert.deepEqual(await collect(empty), []);
});

test('AppendLog.rewrite compacts atomically and the log stays usable', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = await openLog(t, path);
  for (let n = 0; n < 10; n += 1) await log.append({ n });

  await log.rewrite([{ n: 8 }, { n: 9 }]);
  assert.equal(await readFile(path, 'utf8'), '{"n":8}\n{"n":9}\n');

  // An append requested before a rewrite is replaced by it; one requested after survives.
  const before = log.append({ n: 'before' });
  const rewriting = log.rewrite(new Set([{ n: 8 }, { n: 9 }]));
  const after = log.append({ n: 'after' });
  await Promise.all([before, rewriting, after]);
  assert.equal(await readFile(path, 'utf8'), '{"n":8}\n{"n":9}\n{"n":"after"}\n');
  await log.rewrite([{ n: 8 }, { n: 9 }]);
  assert.deepEqual(await listDir(dir), ['log.jsonl']);
  assert.equal(log.stats.bytes, 16);

  await log.append({ n: 10 });
  assert.deepEqual(await collect(log), [{ n: 8 }, { n: 9 }, { n: 10 }]);
  await log.close();

  const reopened = await openLog(t, path);
  assert.deepEqual(await collect(reopened), [{ n: 8 }, { n: 9 }, { n: 10 }]);

  await reopened.rewrite([]);
  assert.equal((await stat(path)).size, 0);
  assert.deepEqual(await collect(reopened), []);
});

test('AppendLog.rewrite can compact from its own read and drops corrupt lines', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  await writeFile(path, '{"n":0}\n{"n":1}\nbroken\n{"n":2}\n{"n":3}\n{"n":4}\n');
  const log = await openLog(t, path);

  async function* evens(source) {
    for await (const record of source) if (record.n % 2 === 0) yield record;
  }
  const rewriting = log.rewrite(evens(log.read()));
  // Requested after the rewrite, so it must land in the new file behind the compacted
  // records. Were it written to the old file first, the filter would drop it (7 is odd).
  const appending = log.append({ n: 7 });
  await Promise.all([rewriting, appending]);

  assert.equal(await readFile(path, 'utf8'), '{"n":0}\n{"n":2}\n{"n":4}\n{"n":7}\n');
  assert.deepEqual(await collect(log), [{ n: 0 }, { n: 2 }, { n: 4 }, { n: 7 }]);
  assert.equal(log.stats.corruptLines, 0);
  assert.deepEqual(await listDir(dir), ['log.jsonl']);
});

test('AppendLog.rewrite leaves the log untouched when it fails', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = await openLog(t, path);
  await log.append({ n: 1 });
  await log.append({ n: 2 });
  const before = await readFile(path, 'utf8');

  // An invalid record half way through the input.
  await assert.rejects(log.rewrite([{ n: 9 }, 'not an object']), StoreError);
  await assert.rejects(log.rewrite(42), StoreError);
  await assert.rejects(log.rewrite(null), StoreError);
  // A source that fails half way.
  async function* failing() {
    yield { n: 9 };
    throw new RangeError('source failed');
  }
  await assert.rejects(log.rewrite(failing()), (err) => err instanceof StoreError && err.cause instanceof RangeError);

  // A read in progress: the file cannot be swapped under it.
  const reader = log.read();
  assert.deepEqual((await reader.next()).value, { n: 1 });
  await assert.rejects(log.rewrite([{ n: 9 }]), StateError);
  assert.deepEqual((await reader.next()).value, { n: 2 });
  assert.equal((await reader.next()).done, true);

  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await listDir(dir), ['log.jsonl']);

  // With the reader finished the same rewrite goes through.
  await log.rewrite([{ n: 9 }]);
  assert.deepEqual(await collect(log), [{ n: 9 }]);
});

test('AppendLog releases its reader when iteration stops early', async (t) => {
  const dir = await tempDir(t, 'vault');
  const log = await openLog(t, join(dir, 'log.jsonl'));
  for (let n = 0; n < 5; n += 1) await log.append({ n });

  for await (const record of log.read()) {
    if (record.n === 1) break;
  }
  // If the abandoned reader still counted, this would be refused.
  await log.rewrite([{ n: 'compacted' }]);
  assert.deepEqual(await collect(log), [{ n: 'compacted' }]);
});

test('AppendLog refuses operations in the wrong state', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = new AppendLog(path);

  await assert.rejects(log.append({ n: 1 }), StateError);
  await assert.rejects(log.flush(), StateError);
  await assert.rejects(log.rewrite([]), StateError);
  await assert.rejects(collect(log), StateError);
  await log.close();
  // Nothing above may have created the file.
  assert.deepEqual(await listDir(dir), []);

  await log.open();
  await assert.rejects(log.open(), (err) => err instanceof StateError && err.code === 'ERR_STATE');
  await log.append({ n: 1 });
  await log.close();

  await assert.rejects(log.append({ n: 2 }), StateError);
  await assert.rejects(log.flush(), StateError);
  await assert.rejects(log.rewrite([]), StateError);
  await assert.rejects(collect(log), StateError);
  assert.equal(await readFile(path, 'utf8'), '{"n":1}\n');

  // An append requested after close() is refused even though close() has not run yet.
  await log.open();
  const accepted = log.append({ n: 3 });
  const closing = log.close();
  const refused = assert.rejects(log.append({ n: 4 }), StateError);
  await accepted;
  await closing;
  await refused;
  assert.equal(await readFile(path, 'utf8'), '{"n":1}\n{"n":3}\n');
});

test('AppendLog validates its options and reports an unusable path', async (t) => {
  assert.throws(() => new AppendLog(''), StoreError);
  assert.throws(() => new AppendLog('log', { fsync: 'sometimes' }), StoreError);
  assert.throws(() => new AppendLog('log', { fsync: true }), StoreError);
  assert.throws(() => new AppendLog('log', { maxRecordBytes: 0 }), StoreError);
  assert.throws(() => new AppendLog('log', { mode: 'rw' }), StoreError);
  assert.equal(new AppendLog('log').path, 'log');

  const dir = await tempDir(t, 'vault');
  await mkdir(join(dir, 'a-directory'));
  await assert.rejects(new AppendLog(join(dir, 'a-directory')).open(), StoreError);
  await assert.rejects(new AppendLog(join(dir, 'missing', 'log.jsonl')).open(), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.cause.code, 'ENOENT');
    return true;
  });
});

test('AppendLog.open clears temporary files left by an interrupted rewrite', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  await writeFile(path, '{"n":1}\n');
  await writeFile(join(dir, '.log.jsonl.aabbccddeeff.tmp'), '{"n":9}\n{"n"');

  const log = await openLog(t, path);
  assert.deepEqual(await collect(log), [{ n: 1 }]);
  assert.deepEqual(await listDir(dir), ['log.jsonl']);
});

test('AppendLog stops at the end of a file that was shortened behind its back', async (t) => {
  const dir = await tempDir(t, 'vault');
  const path = join(dir, 'log.jsonl');
  const log = await openLog(t, path);
  await log.append({ n: 1 });
  await log.append({ n: 2 });
  await log.flush();

  // Another program cut the file mid-record. The reader must not invent data or hang.
  await truncate(path, 11);
  assert.deepEqual(await collect(log), [{ n: 1 }]);
});
