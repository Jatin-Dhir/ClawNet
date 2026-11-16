import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_SCRYPT, Keystore, MAX_PASSPHRASE_LENGTH, open, seal } from '../../src/vault/keystore.js';
import { AuthError, ConfigError, CryptoError, StateError, StoreError } from '../../src/core/errors.js';
import { canonicalBytes, canonicalize } from '../../src/core/wire/canonical.js';
import { tempDir } from '../helpers/tmp.js';

const IS_WINDOWS = process.platform === 'win32';
const POSIX_ONLY = IS_WINDOWS ? 'POSIX permission bits do not exist on Windows' : false;

/** The cheapest parameters the keystore accepts, so the suite stays fast. */
const FAST = Object.freeze({ N: 2 ** 14 });

const PASSPHRASE = 'correct horse battery staple';

function isBase64(value) {
  return typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Create an encrypted keystore with a known secret in a fresh directory. */
async function encryptedKeystore(t, secret = randomBytes(64)) {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  await Keystore.create(path, secret, { passphrase: PASSPHRASE, scrypt: FAST });
  return { dir, path, secret };
}

/** Everything a caller could use to tell two failures apart. */
function shape(error) {
  return {
    constructor: error.constructor,
    name: error.name,
    code: error.code,
    message: error.message,
    cause: error.cause,
    keys: Object.keys(error).sort(),
  };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the operation to fail' });
}

/** Decrypt a keystore file using only node:crypto and the documented format. */
function decryptIndependently(file, passphrase) {
  const key = scryptSync(
    Buffer.from(passphrase.normalize('NFKC'), 'utf8'),
    Buffer.from(file.kdf.salt, 'base64'),
    32,
    { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, maxmem: 256 * 1024 * 1024 },
  );
  const ct = Buffer.from(file.ct, 'base64');
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(file.nonce, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(canonicalBytes({ v: file.v, kdf: file.kdf, cipher: file.cipher }));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
}

/** Build a keystore file by hand, following the documented format. */
function encryptIndependently({ secret, storageKey, passphrase, kdf, nonce }) {
  const key = scryptSync(
    Buffer.from(passphrase.normalize('NFKC'), 'utf8'),
    Buffer.from(kdf.salt, 'base64'),
    32,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
  );
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(canonicalBytes({ v: 1, kdf, cipher: 'chacha20-poly1305' }));
  const plaintext = canonicalBytes({
    secret: secret.toString('base64'),
    storageKey: storageKey.toString('base64'),
  });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, kdf, cipher: 'chacha20-poly1305', nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

// ---------------------------------------------------------------------------------------
// Unencrypted keystores
// ---------------------------------------------------------------------------------------

test('create without a passphrase stores the secret in the documented plain format', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

  assert.deepEqual(await Keystore.create(path, secret), { encrypted: false });

  const file = await readJson(path);
  assert.deepEqual(Object.keys(file).sort(), ['kdf', 'secret', 'storageKey', 'v']);
  assert.equal(file.v, 1);
  assert.equal(file.kdf, null);
  assert.equal(file.secret, secret.toString('base64'));
  assert.ok(isBase64(file.storageKey));
  assert.equal(Buffer.from(file.storageKey, 'base64').length, 32);

  const opened = await Keystore.open(path);
  assert.ok(Buffer.isBuffer(opened.secret));
  assert.deepEqual(opened.secret, secret);
  assert.deepEqual(opened.storageKey, Buffer.from(file.storageKey, 'base64'));
  assert.equal(await Keystore.isEncrypted(path), false);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

test('keystore files are created with owner-only permissions', { skip: POSIX_ONLY }, async (t) => {
  const dir = await tempDir(t, 'keystore');
  await Keystore.create(join(dir, 'plain.json'), randomBytes(32));
  await Keystore.create(join(dir, 'locked.json'), randomBytes(32), { passphrase: PASSPHRASE, scrypt: FAST });
  assert.equal((await stat(join(dir, 'plain.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'locked.json'))).mode & 0o777, 0o600);

  await Keystore.changePassphrase(join(dir, 'locked.json'), { oldPassphrase: PASSPHRASE });
  assert.equal((await stat(join(dir, 'locked.json'))).mode & 0o777, 0o600);
});

test('every keystore gets its own random storage key', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const secret = randomBytes(32);
  await Keystore.create(join(dir, 'a.json'), secret);
  await Keystore.create(join(dir, 'b.json'), secret);
  const a = await Keystore.open(join(dir, 'a.json'));
  const b = await Keystore.open(join(dir, 'b.json'));
  assert.equal(a.storageKey.length, 32);
  assert.equal(b.storageKey.length, 32);
  assert.notDeepEqual(a.storageKey, b.storageKey);
  assert.notDeepEqual(a.storageKey, Buffer.alloc(32));
  // The returned buffers are the caller's own: wiping them does not affect the file.
  a.secret.fill(0);
  a.storageKey.fill(0);
  assert.deepEqual((await Keystore.open(join(dir, 'a.json'))).secret, secret);
});

// ---------------------------------------------------------------------------------------
// Encrypted keystores
// ---------------------------------------------------------------------------------------

test('create with a passphrase writes the documented encrypted format', async (t) => {
  const secret = Buffer.from('this is the node identity secret, do not leak');
  const { dir, path } = await encryptedKeystore(t, secret);

  const text = await readFile(path, 'utf8');
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file).sort(), ['cipher', 'ct', 'kdf', 'nonce', 'v']);
  assert.equal(file.v, 1);
  assert.equal(file.cipher, 'chacha20-poly1305');
  assert.deepEqual(Object.keys(file.kdf).sort(), ['N', 'name', 'p', 'r', 'salt']);
  assert.deepEqual({ ...file.kdf, salt: null }, { name: 'scrypt', N: 16384, r: 8, p: 1, salt: null });
  assert.ok(isBase64(file.kdf.salt) && isBase64(file.nonce) && isBase64(file.ct));
  assert.equal(Buffer.from(file.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(file.nonce, 'base64').length, 12);

  // Neither the secret nor its base64 form appears anywhere in the file.
  assert.ok(!text.includes(secret.toString('base64')));
  assert.ok(!(await readFile(path)).includes(secret));

  const opened = await Keystore.open(path, { passphrase: PASSPHRASE });
  assert.deepEqual(opened.secret, secret);
  assert.equal(opened.storageKey.length, 32);
  assert.equal(await Keystore.isEncrypted(path), true);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

test('the encrypted format can be decrypted with node:crypto alone', async (t) => {
  const { path, secret } = await encryptedKeystore(t);
  const file = await readJson(path);
  const opened = await Keystore.open(path, { passphrase: PASSPHRASE });

  const plaintext = decryptIndependently(file, PASSPHRASE);
  assert.equal(
    plaintext.toString('utf8'),
    canonicalize({ secret: secret.toString('base64'), storageKey: opened.storageKey.toString('base64') }),
  );
  // Ciphertext is plaintext plus the 16-byte tag, nothing else.
  assert.equal(Buffer.from(file.ct, 'base64').length, plaintext.length + 16);
});

test('a keystore built by hand from the documented format opens', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = randomBytes(48);
  const storageKey = randomBytes(32);
  const kdf = { name: 'scrypt', N: 32768, r: 4, p: 2, salt: randomBytes(16).toString('base64') };
  const file = encryptIndependently({ secret, storageKey, passphrase: PASSPHRASE, kdf, nonce: randomBytes(12) });

  // Formatting and key order of the file are not part of what is authenticated.
  await writeFile(path, JSON.stringify({ ct: file.ct, nonce: file.nonce, cipher: file.cipher, kdf, v: 1 }, null, 4));

  const opened = await Keystore.open(path, { passphrase: PASSPHRASE });
  assert.deepEqual(opened.secret, secret);
  assert.deepEqual(opened.storageKey, storageKey);
});

test('create uses N = 2^17, r = 8, p = 1 unless told otherwise', async (t) => {
  assert.deepEqual(DEFAULT_SCRYPT, { N: 131072, r: 8, p: 1 });
  assert.ok(Object.isFrozen(DEFAULT_SCRYPT));

  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = randomBytes(32);
  assert.deepEqual(await Keystore.create(path, secret, { passphrase: PASSPHRASE }), { encrypted: true });

  const { kdf } = await readJson(path);
  assert.deepEqual({ N: kdf.N, r: kdf.r, p: kdf.p }, { N: 131072, r: 8, p: 1 });
  assert.deepEqual((await Keystore.open(path, { passphrase: PASSPHRASE })).secret, secret);
});

test('create honours custom scrypt parameters and records them in the file', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = randomBytes(32);
  await Keystore.create(path, secret, { passphrase: PASSPHRASE, scrypt: { N: 2 ** 15, r: 4, p: 2 } });

  const { kdf } = await readJson(path);
  assert.deepEqual({ N: kdf.N, r: kdf.r, p: kdf.p }, { N: 32768, r: 4, p: 2 });
  assert.deepEqual((await Keystore.open(path, { passphrase: PASSPHRASE })).secret, secret);
});

test('two keystores for the same secret and passphrase share no salt, nonce or ciphertext', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const secret = randomBytes(32);
  await Keystore.create(join(dir, 'a.json'), secret, { passphrase: PASSPHRASE, scrypt: FAST });
  await Keystore.create(join(dir, 'b.json'), secret, { passphrase: PASSPHRASE, scrypt: FAST });
  const a = await readJson(join(dir, 'a.json'));
  const b = await readJson(join(dir, 'b.json'));
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ct, b.ct);
});

test('the passphrase is NFKC-normalized before key derivation', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = randomBytes(32);

  // An "e" with an acute accent in precomposed form, an "fi" ligature, a full-width digit ...
  const typed = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0xfb01)}sh ${String.fromCodePoint(0xff11)}`;
  // ... and the same passphrase as another keyboard would produce it.
  const equivalent = `cafe${String.fromCodePoint(0x301)} fish 1`;
  assert.notEqual(typed, equivalent);
  assert.equal(typed.normalize('NFKC'), equivalent.normalize('NFKC'));

  await Keystore.create(path, secret, { passphrase: typed, scrypt: FAST });
  assert.deepEqual((await Keystore.open(path, { passphrase: typed })).secret, secret);
  assert.deepEqual((await Keystore.open(path, { passphrase: equivalent })).secret, secret);
  // The key really is derived from the normalized form.
  assert.ok(decryptIndependently(await readJson(path), equivalent).length > 0);

  // Normalization is not case folding or trimming.
  await assert.rejects(Keystore.open(path, { passphrase: 'cafe fish 1' }), AuthError);
  await assert.rejects(Keystore.open(path, { passphrase: `${typed} ` }), AuthError);
  await assert.rejects(Keystore.open(path, { passphrase: typed.toUpperCase() }), AuthError);
});

// ---------------------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------------------

test('a wrong passphrase and a tampered file fail identically', async (t) => {
  const { path } = await encryptedKeystore(t);
  const original = await readJson(path);

  const wrong = await failure(Keystore.open(path, { passphrase: 'not the passphrase' }));
  assert.ok(wrong instanceof AuthError);
  assert.deepEqual(shape(wrong), {
    constructor: AuthError,
    name: 'AuthError',
    code: 'ERR_AUTH',
    message: 'cannot unlock keystore',
    cause: undefined,
    keys: ['code', 'name'],
  });

  const flip = (base64, index) => {
    const bytes = Buffer.from(base64, 'base64');
    bytes[index < 0 ? bytes.length + index : index] ^= 0x01;
    return bytes.toString('base64');
  };
  const ctBytes = Buffer.from(original.ct, 'base64');
  const tampered = {
    'ciphertext, first byte': { ...original, ct: flip(original.ct, 0) },
    'ciphertext, middle byte': { ...original, ct: flip(original.ct, ctBytes.length - 17) },
    'tag, first byte': { ...original, ct: flip(original.ct, -16) },
    'tag, last byte': { ...original, ct: flip(original.ct, -1) },
    'ciphertext truncated': { ...original, ct: ctBytes.subarray(0, ctBytes.length - 1).toString('base64') },
    'ciphertext extended': { ...original, ct: Buffer.concat([ctBytes, Buffer.alloc(1)]).toString('base64') },
    'ciphertext reduced to a tag': { ...original, ct: ctBytes.subarray(ctBytes.length - 16).toString('base64') },
    nonce: { ...original, nonce: flip(original.nonce, 5) },
    salt: { ...original, kdf: { ...original.kdf, salt: flip(original.kdf.salt, 0) } },
    'N raised': { ...original, kdf: { ...original.kdf, N: original.kdf.N * 2 } },
    'r lowered': { ...original, kdf: { ...original.kdf, r: 4 } },
    'p raised': { ...original, kdf: { ...original.kdf, p: 2 } },
  };

  for (const [name, file] of Object.entries(tampered)) {
    await writeFile(path, JSON.stringify(file));
    const error = await failure(Keystore.open(path, { passphrase: PASSPHRASE }));
    assert.deepEqual(shape(error), shape(wrong), name);
  }

  // Control: the untouched file still opens, so the failures above came from the changes.
  await writeFile(path, JSON.stringify(original));
  assert.equal((await Keystore.open(path, { passphrase: PASSPHRASE })).storageKey.length, 32);
});

test('a ciphertext made under the right key for a different header is refused', async (t) => {
  // The header is authenticated in its own right, not only through the derived key: a
  // ciphertext that is valid under the correct key but was bound to another header fails.
  const { path } = await encryptedKeystore(t);
  const file = await readJson(path);
  const key = scryptSync(Buffer.from(PASSPHRASE), Buffer.from(file.kdf.salt, 'base64'), 32, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: 256 * 1024 * 1024,
  });

  // Re-encrypt under the very same key and nonce, bound to a header that differs from the
  // one in the file.
  const nonce = Buffer.from(file.nonce, 'base64');
  const plaintext = decryptIndependently(file, PASSPHRASE);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(canonicalBytes({ v: 1, kdf: { ...file.kdf, name: 'scrypt-weak' }, cipher: file.cipher }));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  await writeFile(path, JSON.stringify({ ...file, ct: ct.toString('base64') }));
  await assert.rejects(Keystore.open(path, { passphrase: PASSPHRASE }), {
    name: 'AuthError',
    message: 'cannot unlock keystore',
  });
});

test('a missing passphrase is a StateError, and so is a passphrase for a plain keystore', async (t) => {
  const { dir, path } = await encryptedKeystore(t);
  for (const options of [undefined, {}, { passphrase: undefined }, { passphrase: null }]) {
    await assert.rejects(Keystore.open(path, options), (err) => {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'ERR_STATE');
      return true;
    });
  }

  // Replacing an encrypted keystore with an unencrypted one must not open silently for
  // an operator who supplies the passphrase.
  const plain = join(dir, 'plain.json');
  await Keystore.create(plain, randomBytes(32));
  await assert.rejects(Keystore.open(plain, { passphrase: PASSPHRASE }), StateError);
  await assert.rejects(
    Keystore.changePassphrase(plain, { oldPassphrase: PASSPHRASE, newPassphrase: 'new', scrypt: FAST }),
    StateError,
  );
  assert.equal(await Keystore.isEncrypted(plain), false);
});

test('invalid passphrases are rejected as configuration errors', async (t) => {
  const { dir, path } = await encryptedKeystore(t);
  const loneSurrogate = `abc${String.fromCharCode(0xd800)}`;

  for (const passphrase of ['', 42, ['a'], { a: 1 }, Buffer.from('bytes'), loneSurrogate]) {
    await assert.rejects(Keystore.open(path, { passphrase }), ConfigError);
    await assert.rejects(
      Keystore.create(join(dir, 'new.json'), randomBytes(32), { passphrase, scrypt: FAST }),
      ConfigError,
    );
    await assert.rejects(
      Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE, newPassphrase: passphrase, scrypt: FAST }),
      ConfigError,
    );
  }
  // Nothing was created and the keystore still opens with its original passphrase.
  assert.deepEqual(await readdir(dir), ['keystore.json']);
  assert.equal((await Keystore.open(path, { passphrase: PASSPHRASE })).storageKey.length, 32);
});

test('hostile or unknown files are rejected before any key derivation', async (t) => {
  const { path } = await encryptedKeystore(t);
  const good = await readJson(path);
  const kdf = (changes) => ({ ...good, kdf: { ...good.kdf, ...changes } });

  const hostile = {
    'N far too large': kdf({ N: 2 ** 30 }),
    'N just above the limit': kdf({ N: 2 ** 23 }),
    'N beyond the safe integer range': kdf({ N: 2 ** 60 }),
    'N not a power of two': kdf({ N: 30000 }),
    'N one below a power of two': kdf({ N: 2 ** 15 - 1 }),
    'N too small': kdf({ N: 1024 }),
    'N zero': kdf({ N: 0 }),
    'N one': kdf({ N: 1 }),
    'N negative': kdf({ N: -16384 }),
    'N fractional': kdf({ N: 16384.5 }),
    'N as a string': kdf({ N: '16384' }),
    'N missing': { ...good, kdf: { name: 'scrypt', r: 8, p: 1, salt: good.kdf.salt } },
    'r zero': kdf({ r: 0 }),
    'r huge': kdf({ r: 1000000 }),
    'r fractional': kdf({ r: 8.5 }),
    'p zero': kdf({ p: 0 }),
    'p huge': kdf({ p: 1000000 }),
    'p null': kdf({ p: null }),
    // 1 GiB, while N, r, p and the total work are each within their own limits.
    'memory above the cap (N * r)': kdf({ N: 2 ** 22, r: 2 }),
    'work above the cap (N * r * p)': kdf({ N: 2 ** 20, r: 4, p: 16 }),
    'unknown version': { ...good, v: 2 },
    'version as a string': { ...good, v: '1' },
    'version missing': { kdf: good.kdf, cipher: good.cipher, nonce: good.nonce, ct: good.ct },
    'unknown kdf': kdf({ name: 'pbkdf2' }),
    'unknown cipher': { ...good, cipher: 'aes-256-gcm' },
    'unknown extra field': { ...good, hint: 'my passphrase is ...' },
    'unknown kdf field': kdf({ dkLen: 64 }),
    'kdf not an object': { ...good, kdf: 'scrypt' },
    'kdf an array': { ...good, kdf: [] },
    'salt too short': kdf({ salt: randomBytes(8).toString('base64') }),
    'salt too long': kdf({ salt: randomBytes(32).toString('base64') }),
    'salt not base64': kdf({ salt: '!!!!!!!!!!!!!!!!!!!!!!==' }),
    'salt without padding': kdf({ salt: good.kdf.salt.replace(/=+$/, '') }),
    'nonce too short': { ...good, nonce: randomBytes(8).toString('base64') },
    'nonce too long': { ...good, nonce: randomBytes(24).toString('base64') },
    'nonce not a string': { ...good, nonce: 12 },
    'ciphertext shorter than a tag': { ...good, ct: randomBytes(15).toString('base64') },
    'ciphertext empty': { ...good, ct: '' },
    'ciphertext in base64url': { ...good, ct: Buffer.from(good.ct, 'base64').toString('base64url') },
    'ciphertext missing': { v: 1, kdf: good.kdf, cipher: good.cipher, nonce: good.nonce },
  };

  for (const [name, file] of Object.entries(hostile)) {
    await writeFile(path, JSON.stringify(file));
    // With the correct passphrase: reaching the KDF would end in AuthError or success.
    const withPassphrase = await failure(Keystore.open(path, { passphrase: PASSPHRASE }));
    assert.ok(withPassphrase instanceof StoreError, `${name}: ${withPassphrase}`);
    assert.equal(withPassphrase.code, 'ERR_STORE', name);
    // Without one: the file is judged before the passphrase is even asked for.
    await assert.rejects(Keystore.open(path), StoreError, name);
    await assert.rejects(Keystore.isEncrypted(path), StoreError, name);
    await assert.rejects(
      Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE, newPassphrase: 'x', scrypt: FAST }),
      StoreError,
      name,
    );
  }

  // Parameters at the edge of the accepted range are not rejected as hostile: with the
  // wrong key they reach authentication instead. (N = 2^15, r = 16 is 64 MiB.)
  await writeFile(path, JSON.stringify(kdf({ N: 2 ** 15, r: 16, p: 2 })));
  await assert.rejects(Keystore.open(path, { passphrase: PASSPHRASE }), AuthError);
});

test('files that are not keystores are rejected without leaking their content', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const marker = 'SECRET-MARKER-0123456789';
  const contents = [
    Buffer.alloc(0),
    Buffer.from(`{"v":1,"kdf":null,"secret":"${marker}`),
    Buffer.from(`not json ${marker}`),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('"text"'),
    Buffer.from('1'),
    Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    Buffer.from(JSON.stringify({ v: 1, kdf: null, secret: marker, storageKey: 'not base64 !!' })),
    Buffer.from(JSON.stringify({ v: 1, kdf: null, secret: '', storageKey: randomBytes(32).toString('base64') })),
    Buffer.from(JSON.stringify({ v: 1, kdf: null, secret: 'QUJD', storageKey: randomBytes(31).toString('base64') })),
    Buffer.from(JSON.stringify({ v: 1, kdf: null, secret: 'QUJD' })),
    Buffer.from(JSON.stringify({
      v: 1,
      kdf: null,
      secret: 'QUJD',
      storageKey: randomBytes(32).toString('base64'),
      extra: 1,
    })),
    Buffer.from(JSON.stringify({ v: 1, kdf: null, secret: 7, storageKey: randomBytes(32).toString('base64') })),
    Buffer.from(JSON.stringify({ v: 1, secret: 'QUJD', storageKey: randomBytes(32).toString('base64') })),
  ];
  for (const [index, bytes] of contents.entries()) {
    await writeFile(path, bytes);
    const attempts = [
      () => Keystore.open(path),
      () => Keystore.open(path, { passphrase: PASSPHRASE }),
      () => Keystore.isEncrypted(path),
    ];
    for (const attempt of attempts) {
      const error = await failure(attempt());
      assert.ok(error instanceof StoreError, `case ${index}: ${error}`);
      assert.ok(!error.message.includes(marker), `case ${index}`);
      assert.equal(error.cause, undefined, `case ${index}`);
    }
  }

  // Larger than any keystore can be: refused by size, before it is read into memory.
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await assert.rejects(Keystore.open(path), StoreError);

  await mkdir(join(dir, 'directory'));
  await assert.rejects(Keystore.open(join(dir, 'directory')), StoreError);
  await assert.rejects(Keystore.isEncrypted(join(dir, 'directory')), StoreError);
});

test('content that authenticates but is malformed is reported as a store error', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const kdf = { name: 'scrypt', N: 16384, r: 8, p: 1, salt: randomBytes(16).toString('base64') };
  const key = scryptSync(Buffer.from(PASSPHRASE), Buffer.from(kdf.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const storageKey = randomBytes(32).toString('base64');

  const plaintexts = [
    '{"storageKey":"x","secret":"QUJD"}',
    ` {"secret":"QUJD","storageKey":"${storageKey}"}`,
    `{"secret":"QUJD","storageKey":"${storageKey}","more":1}`,
    `{"secret":"QUJD","storageKey":"${randomBytes(16).toString('base64')}"}`,
    `{"secret":"","storageKey":"${storageKey}"}`,
    `{"secret":"QUJD"}`,
    '[]',
    'null',
    '',
  ];
  for (const plaintext of plaintexts) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    cipher.setAAD(canonicalBytes({ v: 1, kdf, cipher: 'chacha20-poly1305' }));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
    await writeFile(path, JSON.stringify({
      v: 1,
      kdf,
      cipher: 'chacha20-poly1305',
      nonce: nonce.toString('base64'),
      ct: ct.toString('base64'),
    }));
    await assert.rejects(Keystore.open(path, { passphrase: PASSPHRASE }), StoreError, plaintext);
  }
});

test('a keystore that does not exist is a StateError, and exists() reports it', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  assert.equal(await Keystore.exists(path), false);
  await assert.rejects(Keystore.open(path), StateError);
  await assert.rejects(Keystore.open(path, { passphrase: PASSPHRASE }), StateError);
  await assert.rejects(Keystore.isEncrypted(path), StateError);
  await assert.rejects(Keystore.changePassphrase(path, { newPassphrase: 'x', scrypt: FAST }), StateError);
  assert.deepEqual(await readdir(dir), []);

  await Keystore.create(path, randomBytes(32));
  assert.equal(await Keystore.exists(path), true);
});

// ---------------------------------------------------------------------------------------
// create and changePassphrase
// ---------------------------------------------------------------------------------------

test('create never overwrites an existing file', async (t) => {
  const { dir, path, secret } = await encryptedKeystore(t);
  const before = await readFile(path);

  for (const options of [undefined, { passphrase: PASSPHRASE, scrypt: FAST }, { passphrase: 'other', scrypt: FAST }]) {
    await assert.rejects(Keystore.create(path, randomBytes(32), options), (err) => {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'ERR_STATE');
      return true;
    });
  }
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
  assert.deepEqual((await Keystore.open(path, { passphrase: PASSPHRASE })).secret, secret);

  // Any file in the way counts, even one that is not a keystore.
  const other = join(dir, 'notes.txt');
  await writeFile(other, 'not a keystore');
  await assert.rejects(Keystore.create(other, randomBytes(32)), StateError);
  assert.equal(await readFile(other, 'utf8'), 'not a keystore');
});

test('of several concurrent creators exactly one wins', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secrets = Array.from({ length: 8 }, () => randomBytes(32));

  const results = await Promise.allSettled(secrets.map((secret) => Keystore.create(path, secret)));

  const won = results.filter((result) => result.status === 'fulfilled');
  const lost = results.filter((result) => result.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 7);
  for (const result of lost) assert.ok(result.reason instanceof StateError, String(result.reason));

  // The file holds the winner's secret, complete.
  const winner = secrets[results.findIndex((result) => result.status === 'fulfilled')];
  assert.deepEqual((await Keystore.open(path)).secret, winner);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

test('concurrent creators keep the one-winner rule across many rounds', async (t) => {
  // The winner sweeps leftover temporary files; a loser whose file was swept away must
  // still see "already exists", not an I/O error.
  for (let round = 0; round < 10; round += 1) {
    const dir = await tempDir(t, 'keystore');
    const path = join(dir, 'keystore.json');
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => Keystore.create(path, randomBytes(32))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}`);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      assert.ok(r.reason instanceof StateError, `round ${round}: ${r.reason}`);
    }
    assert.deepEqual(await readdir(dir), ['keystore.json'], `round ${round}`);
  }
});

test('a create interrupted by a crash leaves nothing that blocks the next start', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  // What a crash before publication leaves: a complete or partial temporary copy. It is
  // not a keystore, the next create succeeds, and the copy of the secrets is removed.
  const leftover = join(dir, '.keystore.json.0123456789ab.tmp');
  await writeFile(leftover, '{"v":1,"kdf":null,"secret":"AAAA');
  assert.equal(await Keystore.exists(path), false);
  await assert.rejects(Keystore.open(path), StateError);
  await Keystore.create(path, randomBytes(32));
  assert.deepEqual(await readdir(dir), ['keystore.json']);
  assert.equal((await Keystore.open(path)).storageKey.length, 32);
});

test('an empty file at the keystore path is reported, never taken over or unlocked', async (t) => {
  // Regression: the previous create reserved the name with an empty file, so a crash at
  // that moment produced exactly this. Now it can only come from outside.
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  await writeFile(path, '');
  await assert.rejects(Keystore.create(path, randomBytes(32)), StateError);
  for (const options of [undefined, { passphrase: PASSPHRASE }]) {
    await assert.rejects(Keystore.open(path, options), (err) => {
      assert.ok(err instanceof StoreError, String(err));
      assert.match(err.message, /not valid/);
      return true;
    });
  }
  assert.equal((await stat(path)).size, 0);
});

test('passphrases are bounded in length before any key derivation', async (t) => {
  const { dir, path } = await encryptedKeystore(t);
  assert.equal(MAX_PASSPHRASE_LENGTH, 1024);
  const longest = 'p'.repeat(MAX_PASSPHRASE_LENGTH);
  await Keystore.create(join(dir, 'long.json'), randomBytes(32), { passphrase: longest, scrypt: FAST });
  assert.equal((await Keystore.open(join(dir, 'long.json'), { passphrase: longest })).storageKey.length, 32);

  const tooLong = 'p'.repeat(MAX_PASSPHRASE_LENGTH + 1);
  const huge = 'p'.repeat(64 * 1024 * 1024);
  for (const passphrase of [tooLong, huge]) {
    const started = process.hrtime.bigint();
    await assert.rejects(Keystore.open(path, { passphrase }), (err) => err instanceof ConfigError && /at most 1024/.test(err.message));
    await assert.rejects(Keystore.create(join(dir, 'x.json'), randomBytes(32), { passphrase, scrypt: FAST }), ConfigError);
    await assert.rejects(
      Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE, newPassphrase: passphrase, scrypt: FAST }),
      ConfigError,
    );
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2000);
  }
  assert.deepEqual((await readdir(dir)).sort(), ['keystore.json', 'long.json']);
});

test('a path containing a NUL byte is refused as a store error', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = `${join(dir, 'keystore.json')}\0.bak`;
  await assert.rejects(Keystore.create(path, randomBytes(32)), StoreError);
  await assert.rejects(Keystore.open(path), StoreError);
  await assert.rejects(Keystore.exists(path), StoreError);
  await assert.rejects(Keystore.isEncrypted(path), StoreError);
  assert.deepEqual(await readdir(dir), []);
});

test('create validates the secret, the path and the scrypt options', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');

  for (const secret of [Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1), 'a string', null, undefined, [1, 2, 3], 7]) {
    await assert.rejects(Keystore.create(path, secret), CryptoError);
  }
  await assert.rejects(Keystore.create('', randomBytes(32)), StoreError);
  await assert.rejects(Keystore.create(undefined, randomBytes(32)), StoreError);

  const badScrypt = [
    { N: 2 ** 23 },
    { N: 1024 },
    { N: 20000 },
    { N: '16384' },
    { r: 0 },
    { r: 17 },
    { p: 0 },
    { p: 17 },
    { N: 2 ** 22, r: 2 },
    { N: 2 ** 20, r: 4, p: 16 },
    'fast',
    [],
  ];
  for (const scrypt of badScrypt) {
    await assert.rejects(Keystore.create(path, randomBytes(32), { passphrase: PASSPHRASE, scrypt }), ConfigError);
    // Checked even when the keystore will not be encrypted, so a bad config never hides.
    await assert.rejects(Keystore.create(path, randomBytes(32), { scrypt }), ConfigError);
  }
  assert.deepEqual(await readdir(dir), []);

  // The directory must exist; nothing is left behind when it does not.
  await assert.rejects(Keystore.create(join(dir, 'missing', 'keystore.json'), randomBytes(32)), StoreError);
  assert.deepEqual(await readdir(dir), []);

  // An undefined parameter means the default, not an error.
  await Keystore.create(join(dir, 'partial.json'), randomBytes(32), {
    passphrase: PASSPHRASE,
    scrypt: { N: 2 ** 14, r: undefined, p: undefined },
  });
  const partial = await readJson(join(dir, 'partial.json'));
  assert.deepEqual({ N: partial.kdf.N, r: partial.kdf.r, p: partial.kdf.p }, { N: 16384, r: 8, p: 1 });

  // The largest accepted secret round-trips, and a Uint8Array view is taken as given.
  const big = randomBytes(64 * 1024);
  await Keystore.create(path, big, { passphrase: PASSPHRASE, scrypt: FAST });
  assert.deepEqual((await Keystore.open(path, { passphrase: PASSPHRASE })).secret, big);

  const backing = randomBytes(64);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 8, 16);
  await Keystore.create(join(dir, 'view.json'), view);
  assert.deepEqual((await Keystore.open(join(dir, 'view.json'))).secret, backing.subarray(8, 24));
});

test('changePassphrase re-encrypts and keeps the secret and the storage key', async (t) => {
  const { dir, path, secret } = await encryptedKeystore(t);
  const before = await readJson(path);
  const original = await Keystore.open(path, { passphrase: PASSPHRASE });

  const result = await Keystore.changePassphrase(path, {
    oldPassphrase: PASSPHRASE,
    newPassphrase: 'a new passphrase',
    scrypt: { N: 2 ** 15 },
  });
  assert.deepEqual(result, { encrypted: true });

  const after = await readJson(path);
  assert.notEqual(after.kdf.salt, before.kdf.salt);
  assert.notEqual(after.nonce, before.nonce);
  assert.notEqual(after.ct, before.ct);
  assert.equal(after.kdf.N, 32768);

  await assert.rejects(Keystore.open(path, { passphrase: PASSPHRASE }), AuthError);
  const reopened = await Keystore.open(path, { passphrase: 'a new passphrase' });
  assert.deepEqual(reopened.secret, secret);
  assert.deepEqual(reopened.storageKey, original.storageKey);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

test('changePassphrase can add and remove encryption', async (t) => {
  const dir = await tempDir(t, 'keystore');
  const path = join(dir, 'keystore.json');
  const secret = randomBytes(40);
  await Keystore.create(path, secret);
  const original = await Keystore.open(path);

  assert.deepEqual(
    await Keystore.changePassphrase(path, { newPassphrase: PASSPHRASE, scrypt: FAST }),
    { encrypted: true },
  );
  assert.equal(await Keystore.isEncrypted(path), true);
  assert.ok(!(await readFile(path, 'utf8')).includes(secret.toString('base64')));
  await assert.rejects(Keystore.open(path), StateError);
  const locked = await Keystore.open(path, { passphrase: PASSPHRASE });
  assert.deepEqual(locked.secret, secret);
  assert.deepEqual(locked.storageKey, original.storageKey);

  assert.deepEqual(await Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE }), { encrypted: false });
  assert.equal(await Keystore.isEncrypted(path), false);
  const unlocked = await Keystore.open(path);
  assert.deepEqual(unlocked.secret, secret);
  assert.deepEqual(unlocked.storageKey, original.storageKey);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

test('changePassphrase leaves the file untouched when it is refused', async (t) => {
  const { dir, path } = await encryptedKeystore(t);
  const before = await readFile(path);

  await assert.rejects(
    Keystore.changePassphrase(path, { oldPassphrase: 'wrong', newPassphrase: 'new', scrypt: FAST }),
    { name: 'AuthError', message: 'cannot unlock keystore' },
  );
  await assert.rejects(Keystore.changePassphrase(path, { newPassphrase: 'new', scrypt: FAST }), StateError);
  await assert.rejects(Keystore.changePassphrase(path), StateError);
  await assert.rejects(
    Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE, newPassphrase: 'new', scrypt: { N: 3 } }),
    ConfigError,
  );

  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(dir), ['keystore.json']);
});

// ---------------------------------------------------------------------------------------
// seal / open
// ---------------------------------------------------------------------------------------

test('seal and open round-trip records with and without associated data', () => {
  const key = randomBytes(32);
  const cases = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from(`unicode ${String.fromCodePoint(0x1f600)}`, 'utf8'),
    randomBytes(65536),
  ];
  for (const plaintext of cases) {
    for (const ad of [undefined, null, Buffer.alloc(0), Buffer.from('outbox/42')]) {
      const sealed = seal(key, plaintext, ad);
      assert.ok(Buffer.isBuffer(sealed));
      assert.equal(sealed.length, plaintext.length + 28);
      const opened = open(key, sealed, ad);
      assert.ok(Buffer.isBuffer(opened));
      assert.deepEqual(opened, plaintext);
    }
  }
  // Omitted associated data and empty associated data are the same thing.
  assert.deepEqual(open(key, seal(key, Buffer.from('x')), Buffer.alloc(0)), Buffer.from('x'));
  // Uint8Array inputs work as well as Buffers.
  const sealed = seal(new Uint8Array(key), new Uint8Array([1, 2, 3]), new Uint8Array([9]));
  assert.deepEqual(open(new Uint8Array(key), new Uint8Array(sealed), new Uint8Array([9])), Buffer.from([1, 2, 3]));
});

test('seal uses a fresh random nonce for every record', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('the same record every time');
  const nonces = new Set();
  const bodies = new Set();
  for (let i = 0; i < 200; i += 1) {
    const sealed = seal(key, plaintext);
    nonces.add(sealed.subarray(0, 12).toString('hex'));
    bodies.add(sealed.subarray(12).toString('hex'));
  }
  assert.equal(nonces.size, 200);
  assert.equal(bodies.size, 200);
});

test('seal output is nonce || ChaCha20-Poly1305 ciphertext || tag', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('interoperable');
  const ad = Buffer.from('context');
  const sealed = seal(key, plaintext, ad);

  const decipher = createDecipheriv('chacha20-poly1305', key, sealed.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(ad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const opened = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
  assert.deepEqual(opened, plaintext);
});

test('open decrypts the RFC 8439 section 2.8.2 test vector', () => {
  const key = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex');
  const nonce = Buffer.from('070000004041424344454647', 'hex');
  const ad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
  const ciphertext = Buffer.from(
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6'
    + '3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36'
    + '92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc'
    + '3ff4def08e4b7a9de576d26586cec64b6116',
    'hex',
  );
  const tag = Buffer.from('1ae10b594f09e26a7e902ecbd0600691', 'hex');

  const plaintext = open(key, Buffer.concat([nonce, ciphertext, tag]), ad);
  assert.equal(
    plaintext.toString('latin1'),
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the "
    + 'future, sunscreen would be it.',
  );
});

test('open rejects any modification, wrong key or wrong associated data identically', () => {
  const key = randomBytes(32);
  const ad = Buffer.from('store/record-7');
  const sealed = seal(key, Buffer.from('twenty bytes of data'), ad);
  const expected = {
    constructor: AuthError,
    name: 'AuthError',
    code: 'ERR_AUTH',
    message: 'cannot open sealed record',
    cause: undefined,
    keys: ['code', 'name'],
  };
  const check = (fn, label) => {
    let error;
    try {
      fn();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error !== undefined, `${label}: expected a failure`);
    assert.deepEqual(shape(error), expected, label);
  };

  // Every single bit position class: each byte of nonce, ciphertext and tag.
  for (let i = 0; i < sealed.length; i += 1) {
    const copy = Buffer.from(sealed);
    copy[i] ^= 0x80;
    check(() => open(key, copy, ad), `byte ${i}`);
  }
  for (let length = 0; length < sealed.length; length += 1) {
    check(() => open(key, sealed.subarray(0, length), ad), `truncated to ${length}`);
  }
  check(() => open(key, Buffer.concat([sealed, Buffer.alloc(1)]), ad), 'extended');
  check(() => open(randomBytes(32), sealed, ad), 'wrong key');
  check(() => open(key, sealed, Buffer.from('store/record-8')), 'wrong associated data');
  check(() => open(key, sealed), 'missing associated data');
  check(() => open(key, seal(key, Buffer.from('x')), ad), 'unexpected associated data');
  // Two records cannot be spliced: the nonce of one with the body of another.
  const other = seal(key, Buffer.from('twenty bytes of DATA'), ad);
  check(() => open(key, Buffer.concat([sealed.subarray(0, 12), other.subarray(12)]), ad), 'spliced');

  assert.deepEqual(open(key, sealed, ad), Buffer.from('twenty bytes of data'));
});

test('seal and open reject arguments that are not bytes or keys of the wrong size', () => {
  const key = randomBytes(32);
  const sealed = seal(key, Buffer.from('x'));
  for (const badKey of [randomBytes(31), randomBytes(33), Buffer.alloc(0), 'k'.repeat(32), null, undefined, 32]) {
    assert.throws(() => seal(badKey, Buffer.from('x')), CryptoError);
    assert.throws(() => open(badKey, sealed), CryptoError);
  }
  for (const notBytes of ['text', 42, null, undefined, [1, 2], { length: 3 }]) {
    assert.throws(() => seal(key, notBytes), CryptoError);
    assert.throws(() => open(key, notBytes), CryptoError);
  }
  for (const badAd of ['text', 42, [1], {}]) {
    assert.throws(() => seal(key, Buffer.from('x'), badAd), CryptoError);
    assert.throws(() => open(key, sealed, badAd), CryptoError);
  }
  assert.throws(() => seal(randomBytes(31), Buffer.from('x')), { code: 'ERR_CRYPTO' });
});

test('a keystore storage key seals records that survive a passphrase change', async (t) => {
  const { path } = await encryptedKeystore(t);
  const first = await Keystore.open(path, { passphrase: PASSPHRASE });
  const sealed = seal(first.storageKey, Buffer.from('outbox entry'), Buffer.from('outbox/1'));

  await Keystore.changePassphrase(path, { oldPassphrase: PASSPHRASE, newPassphrase: 'rotated', scrypt: FAST });
  const second = await Keystore.open(path, { passphrase: 'rotated' });
  assert.deepEqual(open(second.storageKey, sealed, Buffer.from('outbox/1')), Buffer.from('outbox entry'));
});
