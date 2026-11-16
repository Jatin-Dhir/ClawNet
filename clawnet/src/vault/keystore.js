/**
 * The node's long-term secrets at rest.
 *
 * A keystore file holds two things: the caller's `secret` (the serialized identity keys)
 * and a `storageKey`, 32 random bytes generated when the keystore is created, which other
 * modules use to encrypt their local stores with `seal()` and `open()` below.
 *
 * With a passphrase the file is
 *
 *   { "v": 1,
 *     "kdf": { "name": "scrypt", "N": .., "r": .., "p": .., "salt": base64(16 bytes) },
 *     "cipher": "chacha20-poly1305",
 *     "nonce": base64(12 random bytes),
 *     "ct": base64(ciphertext || 16-byte tag) }
 *
 * The key is scrypt(NFKC(passphrase) as UTF-8, salt, N, r, p) -> 32 bytes. The plaintext
 * is the canonical JSON of { "secret": base64, "storageKey": base64 }. The associated
 * data is the canonical JSON of { v, kdf, cipher } exactly as stored, so nobody can swap
 * in weaker parameters without the tag failing. Every encryption uses a fresh salt, hence
 * a fresh key, so the random nonce can never repeat under one key.
 *
 * Without a passphrase the file is { "v": 1, "kdf": null, "secret": base64,
 * "storageKey": base64 }, protected by file permissions only (mode 0o600; Windows ignores
 * POSIX modes and the file inherits the ACL of its directory). `Keystore.create` reports
 * `encrypted: false` in that case so the caller can warn the operator.
 *
 * Failure reporting is deliberately coarse where a secret is involved: a wrong passphrase
 * and a modified file both end in the same AuthError, with no detail and no cause. What
 * anyone can see by reading the file (it is not a keystore, the version is unknown, the
 * KDF parameters are out of range) is reported as StoreError, and those checks all run
 * before any key derivation, so a hostile file cannot make the node burn memory or CPU.
 *
 * A keystore is created with an exclusive atomic create: after a crash it is either
 * absent or complete, never empty or half-written (ARCHITECTURE.md section 7.3).
 *
 * ChaCha20-Poly1305 and the random bytes come from core/crypto. scrypt does not: no other
 * module needs a password-based KDF, so it is taken from node:crypto here, the only place
 * that uses it.
 */

import { open as openFile, stat } from 'node:fs/promises';
// scrypt is the one primitive core/crypto does not provide; see the module comment.
import { scrypt as scryptCallback } from 'node:crypto';

import { aeadDecrypt, aeadEncrypt, randomBytes } from '../core/crypto/primitives.js';
import { AuthError, ConfigError, CryptoError, StateError, StoreError } from '../core/errors.js';
import { canonicalBytes, canonicalize, parseCanonical } from '../core/wire/canonical.js';
import { atomicCreateFile, atomicWriteFile, readAtMost, sweepTempFiles } from './store.js';

const VERSION = 1;
const KDF_NAME = 'scrypt';
const CIPHER = 'chacha20-poly1305';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;

/** scrypt parameters used when the caller does not choose: about 128 MiB and a few hundred ms. */
export const DEFAULT_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

/**
 * Bounds on scrypt parameters, applied to options and to files alike.
 *
 * scrypt needs about 128 * N * r bytes and time proportional to N * r * p. The caps keep
 * the worst file an attacker can plant at 512 MiB and 16 times the default work, instead
 * of whatever numbers they care to write.
 */
const SCRYPT_MIN_N = 2 ** 14;
const SCRYPT_MAX_N = 2 ** 22;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 16;
const SCRYPT_MAX_BLOCKS = 2 ** 22;
const SCRYPT_MAX_WORK = 2 ** 24;

/** Largest secret a keystore will hold. Identity key bundles are a few hundred bytes. */
const MAX_SECRET_BYTES = 64 * 1024;

/** Largest keystore file that will be read; a full-size secret needs well under this. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Longest passphrase, in UTF-16 code units. scrypt hashes the whole passphrase first, so
 * an unbounded one is unbounded work before the cost parameters even apply.
 */
export const MAX_PASSPHRASE_LENGTH = 1024;

const FILE_MODE = 0o600;

const UNLOCK_FAILED = 'cannot unlock keystore';
const OPEN_FAILED = 'cannot open sealed record';

const EMPTY = Buffer.alloc(0);

const PLAIN_KEYS = ['kdf', 'secret', 'storageKey', 'v'];
const ENCRYPTED_KEYS = ['cipher', 'ct', 'kdf', 'nonce', 'v'];
const KDF_KEYS = ['N', 'name', 'p', 'r', 'salt'];
const CONTENT_KEYS = ['secret', 'storageKey'];

/** Operations on a keystore file. All methods are static; there is no instance state. */
export class Keystore {
  /**
   * Create a keystore holding `secret` and a freshly generated storage key.
   *
   * @param {string} path file to create; its directory must exist
   * @param {Uint8Array} secret 1 to 65536 bytes
   * @param {object} [options]
   * @param {string} [options.passphrase] encrypts the keystore; omit (or pass null) to
   *   store it unencrypted
   * @param {{ N?: number, r?: number, p?: number }} [options.scrypt] cost parameters,
   *   default N = 2^17, r = 8, p = 1. N must be a power of two from 2^14 to 2^22, r and p
   *   from 1 to 16, with N*r <= 2^22 and N*r*p <= 2^24.
   * @returns {Promise<{ encrypted: boolean }>} `encrypted: false` means the secret is
   *   protected by file permissions only
   * @throws {StateError} if a file already exists at `path` (it is never overwritten)
   * @throws {CryptoError} if `secret` is not bytes of an accepted length
   * @throws {ConfigError} if the passphrase or scrypt parameters are invalid
   * @throws {StoreError} if the file cannot be written
   */
  static async create(path, secret, options = {}) {
    const { passphrase, scrypt } = options ?? {};
    requirePath(path);
    if (!(secret instanceof Uint8Array) || secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
      throw new CryptoError(`secret must be 1 to ${MAX_SECRET_BYTES} bytes`);
    }
    const params = resolveScrypt(scrypt);
    if (hasPassphrase(passphrase)) checkPassphrase(passphrase);
    // Cheap early answer; the exclusive create below is what actually guarantees it.
    if (await Keystore.exists(path)) throw new StateError('keystore already exists');

    const storageKey = randomBytes(KEY_BYTES);
    let text;
    try {
      text = await serialize(secret, storageKey, passphrase, params);
    } finally {
      storageKey.fill(0);
    }

    // The file appears under its name complete or not at all, and only one of several
    // concurrent creators can succeed. An empty placeholder reserved first would survive
    // a crash and block every later start.
    try {
      await atomicCreateFile(path, text, { mode: FILE_MODE });
    } catch (cause) {
      if (cause instanceof StateError) throw new StateError('keystore already exists');
      throw new StoreError('cannot create keystore', { cause });
    }
    // Only the winner sweeps, and only afterwards, so that it never removes the file of a
    // creator still in flight: a crash during an earlier attempt may have left a copy of
    // its secrets behind.
    await sweepTempFiles(path);
    return { encrypted: hasPassphrase(passphrase) };
  }

  /**
   * Read a keystore and return its secrets.
   *
   * @param {string} path
   * @param {object} [options]
   * @param {string} [options.passphrase] required if, and only if, the keystore is encrypted
   * @returns {Promise<{ secret: Buffer, storageKey: Buffer }>} fresh buffers owned by the
   *   caller; `storageKey` is 32 bytes. Overwrite them when they are no longer needed.
   * @throws {AuthError} "cannot unlock keystore": wrong passphrase or modified file; the
   *   two cases are not distinguishable
   * @throws {StateError} if there is no keystore at `path`, if it is encrypted and no
   *   passphrase was given, or if a passphrase was given for an unencrypted keystore
   *   (which would otherwise let someone replace a protected keystore with an
   *   unprotected one unnoticed)
   * @throws {ConfigError} if the passphrase is not a non-empty, well-formed string
   * @throws {StoreError} if the file is unreadable, not a keystore, of an unknown
   *   version, or has KDF parameters outside the accepted range
   */
  static async open(path, options = {}) {
    const { passphrase } = options ?? {};
    requirePath(path);
    const file = await readKeystore(path);
    if (file.kdf === null) {
      if (hasPassphrase(passphrase)) {
        file.secret.fill(0);
        file.storageKey.fill(0);
        throw new StateError('keystore is not encrypted but a passphrase was supplied');
      }
      return { secret: file.secret, storageKey: file.storageKey };
    }
    if (!hasPassphrase(passphrase)) {
      throw new StateError('keystore is encrypted and needs a passphrase');
    }
    return decrypt(file, passphrase);
  }

  /**
   * Re-encrypt a keystore under a different passphrase, or add or remove encryption.
   *
   * The secret and the storage key are preserved; salt and nonce are regenerated. The
   * file is replaced atomically, so a crash leaves the old keystore or the new one.
   *
   * @param {string} path
   * @param {object} options
   * @param {string} [options.oldPassphrase] current passphrase; omit for an unencrypted keystore
   * @param {string} [options.newPassphrase] new passphrase; omit to store it unencrypted
   * @param {{ N?: number, r?: number, p?: number }} [options.scrypt] cost parameters for
   *   the new file (default N = 2^17, r = 8, p = 1)
   * @returns {Promise<{ encrypted: boolean }>} whether the keystore is now encrypted
   * @throws {AuthError | StateError | ConfigError | StoreError} as `Keystore.open`
   */
  static async changePassphrase(path, options = {}) {
    const { oldPassphrase, newPassphrase, scrypt } = options ?? {};
    requirePath(path);
    // Reject bad input before spending a key derivation on the old passphrase.
    const params = resolveScrypt(scrypt);
    if (hasPassphrase(newPassphrase)) checkPassphrase(newPassphrase);

    const { secret, storageKey } = await Keystore.open(path, { passphrase: oldPassphrase });
    try {
      const text = await serialize(secret, storageKey, newPassphrase, params);
      // A crash during an earlier change may have left a copy of the secrets behind.
      await sweepTempFiles(path);
      await atomicWriteFile(path, text, { mode: FILE_MODE });
    } finally {
      secret.fill(0);
      storageKey.fill(0);
    }
    return { encrypted: hasPassphrase(newPassphrase) };
  }

  /**
   * Report whether a keystore needs a passphrase. Does no key derivation.
   *
   * @param {string} path
   * @returns {Promise<boolean>}
   * @throws {StateError} if there is no keystore at `path`
   * @throws {StoreError} if the file is unreadable or not a valid keystore
   */
  static async isEncrypted(path) {
    requirePath(path);
    const file = await readKeystore(path);
    if (file.kdf === null) {
      file.secret.fill(0);
      file.storageKey.fill(0);
      return false;
    }
    return true;
  }

  /**
   * Report whether anything exists at `path`. Says nothing about its validity.
   *
   * @param {string} path
   * @returns {Promise<boolean>}
   * @throws {StoreError} if the path cannot be examined
   */
  static async exists(path) {
    requirePath(path);
    try {
      await stat(path);
      return true;
    } catch (cause) {
      if (cause?.code === 'ENOENT') return false;
      throw new StoreError('cannot examine keystore path', { cause });
    }
  }
}

/**
 * Encrypt one record for storage at rest.
 *
 * ChaCha20-Poly1305 (RFC 8439) with a random 96-bit nonce. Output layout:
 * `nonce (12 bytes) || ciphertext || tag (16 bytes)`, 28 bytes longer than the plaintext.
 *
 * Message bound: nonces are random, so two records sealed under one key share a nonce
 * with probability about n^2 / 2^97 after n records, and a shared nonce exposes both
 * records and allows forgeries. Keep n at or below 2^32 records per storage key (the
 * NIST SP 800-38D limit for random 96-bit nonces, collision probability under 2^-32).
 * This function cannot count for the caller. A store that could exceed the bound must
 * use more than one key.
 *
 * @param {Uint8Array} storageKey 32 bytes
 * @param {Uint8Array} plaintext any length, including zero
 * @param {Uint8Array} [ad] associated data: authenticated, not stored. Bind each record
 *   to its place (store name, record id) so one record cannot be swapped for another.
 * @returns {Buffer}
 * @throws {CryptoError} if an argument is not bytes or the key is not 32 bytes
 */
export function seal(storageKey, plaintext, ad) {
  requireKey(storageKey);
  requireBytes(plaintext, 'plaintext');
  const aad = optionalBytes(ad, 'associated data');
  const nonce = randomBytes(NONCE_BYTES);
  return Buffer.concat([nonce, aeadSeal(storageKey, nonce, plaintext, aad)]);
}

/**
 * Decrypt and authenticate a record produced by `seal`.
 *
 * @param {Uint8Array} storageKey 32 bytes
 * @param {Uint8Array} sealed output of `seal`
 * @param {Uint8Array} [ad] the associated data given to `seal`
 * @returns {Buffer} the plaintext
 * @throws {AuthError} "cannot open sealed record": wrong key, wrong associated data, or
 *   the record was modified or truncated
 * @throws {CryptoError} if an argument is not bytes or the key is not 32 bytes
 */
export function open(storageKey, sealed, ad) {
  requireKey(storageKey);
  requireBytes(sealed, 'sealed record');
  const aad = optionalBytes(ad, 'associated data');
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new AuthError(OPEN_FAILED);
  const plaintext = aeadOpen(
    storageKey,
    sealed.subarray(0, NONCE_BYTES),
    sealed.subarray(NONCE_BYTES),
    aad,
  );
  if (plaintext === null) throw new AuthError(OPEN_FAILED);
  return plaintext;
}

/** @returns {Promise<string>} the keystore file content */
async function serialize(secret, storageKey, passphrase, params) {
  const content = {
    // A view, not a copy: there is no extra buffer of key material to clean up.
    secret: Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString('base64'),
    storageKey: storageKey.toString('base64'),
  };
  if (!hasPassphrase(passphrase)) {
    return canonicalize({ v: VERSION, kdf: null, ...content });
  }

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = {
    v: VERSION,
    kdf: { name: KDF_NAME, N: params.N, r: params.r, p: params.p, salt: salt.toString('base64') },
    cipher: CIPHER,
  };
  const plaintext = canonicalBytes(content);
  const password = passphraseBytes(passphrase);
  let key;
  try {
    key = await deriveKey(password, salt, params);
    const ct = aeadSeal(key, nonce, plaintext, canonicalBytes(header));
    return canonicalize({ ...header, nonce: nonce.toString('base64'), ct: ct.toString('base64') });
  } finally {
    key?.fill(0);
    password.fill(0);
    plaintext.fill(0);
  }
}

/** @returns {Promise<{ secret: Buffer, storageKey: Buffer }>} */
async function decrypt(file, passphrase) {
  const password = passphraseBytes(passphrase);
  // Rebuilt from the parsed values, so it is byte-identical to what the writer
  // authenticated regardless of how the file itself is formatted.
  const header = canonicalBytes({ v: VERSION, kdf: file.kdf, cipher: CIPHER });
  let key;
  let plaintext;
  try {
    key = await deriveKey(password, file.salt, file.kdf);
    plaintext = aeadOpen(key, file.nonce, file.ct, header);
    if (plaintext === null) throw new AuthError(UNLOCK_FAILED);
    return parseContent(plaintext);
  } finally {
    key?.fill(0);
    password.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * Read and structurally validate a keystore file. No secret-dependent work happens here.
 *
 * @returns {Promise<
 *   { kdf: null, secret: Buffer, storageKey: Buffer } |
 *   { kdf: { name: string, N: number, r: number, p: number, salt: string },
 *     salt: Buffer, nonce: Buffer, ct: Buffer }>}
 */
async function readKeystore(path) {
  const bytes = await readFileBounded(path);
  try {
    return parseKeystore(bytes);
  } finally {
    // An unencrypted keystore is the secret itself; do not leave a second copy around.
    bytes.fill(0);
  }
}

async function readFileBounded(path) {
  let handle;
  try {
    handle = await openFile(path, 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw new StoreError('keystore path is not a regular file');
    // Checked again while reading: the file may grow after it was examined.
    const bytes = info.size > MAX_FILE_BYTES ? undefined : await readAtMost(handle, MAX_FILE_BYTES);
    if (bytes === undefined) throw new StoreError('keystore file is too large');
    return bytes;
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    if (cause?.code === 'ENOENT') throw new StateError('keystore does not exist');
    throw new StoreError('cannot read keystore', { cause });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseKeystore(bytes) {
  let file;
  try {
    file = JSON.parse(bytes.toString('utf8'));
  } catch {
    // The parser's message can quote file content, which may be key material.
    throw invalid('not JSON');
  }
  if (!isPlainObject(file)) throw invalid('not an object');
  if (file.v !== VERSION) throw new StoreError('unsupported keystore version');

  if (file.kdf === null) {
    requireKeys(file, PLAIN_KEYS);
    return { kdf: null, ...decodeContent(file, invalid) };
  }

  requireKeys(file, ENCRYPTED_KEYS);
  const { kdf } = file;
  if (!isPlainObject(kdf)) throw invalid('bad kdf');
  requireKeys(kdf, KDF_KEYS);
  if (kdf.name !== KDF_NAME) throw new StoreError('unsupported keystore key derivation');
  if (file.cipher !== CIPHER) throw new StoreError('unsupported keystore cipher');
  const reason = scryptProblem(kdf);
  if (reason !== null) throw new StoreError(`keystore key derivation parameters rejected: ${reason}`);

  const salt = decodeBase64(kdf.salt);
  if (salt === null || salt.length !== SALT_BYTES) throw invalid('bad salt');
  const nonce = decodeBase64(file.nonce);
  if (nonce === null || nonce.length !== NONCE_BYTES) throw invalid('bad nonce');
  const ct = decodeBase64(file.ct);
  if (ct === null || ct.length < TAG_BYTES) throw invalid('bad ciphertext');

  return {
    kdf: { name: KDF_NAME, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    salt,
    nonce,
    ct,
  };
}

/**
 * Parse the decrypted content. It authenticated, so whoever wrote it knew the passphrase;
 * a failure here is a malformed keystore, not an attack to be hidden behind AuthError.
 */
function parseContent(plaintext) {
  const malformed = () => new StoreError('keystore content is not valid');
  let content;
  try {
    content = parseCanonical(plaintext);
  } catch {
    throw malformed();
  }
  if (!isPlainObject(content)) throw malformed();
  if (!hasExactKeys(content, CONTENT_KEYS)) throw malformed();
  return decodeContent(content, malformed);
}

/** @returns {{ secret: Buffer, storageKey: Buffer }} */
function decodeContent(source, fail) {
  const secret = decodeBase64(source.secret);
  if (secret === null || secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
    throw fail('bad secret');
  }
  const storageKey = decodeBase64(source.storageKey);
  if (storageKey === null || storageKey.length !== KEY_BYTES) throw fail('bad storage key');
  return { secret, storageKey };
}

function invalid(reason) {
  return new StoreError(`keystore file is not valid: ${reason}`);
}

function requireKeys(object, keys) {
  if (!hasExactKeys(object, keys)) throw invalid('unexpected or missing fields');
}

/** Fields outside the authenticated set would be attacker-controlled, so none are allowed. */
function hasExactKeys(object, sortedKeys) {
  const keys = Object.keys(object).sort();
  return keys.length === sortedKeys.length && keys.every((key, i) => key === sortedKeys[i]);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict RFC 4648 base64: anything that does not re-encode to itself is refused. */
function decodeBase64(value) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/** @returns {string | null} why the parameters are unacceptable, or null if they are fine */
function scryptProblem({ N, r, p }) {
  if (!Number.isSafeInteger(N) || N < SCRYPT_MIN_N || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0) {
    return `N must be a power of two from ${SCRYPT_MIN_N} to ${SCRYPT_MAX_N}`;
  }
  if (!Number.isSafeInteger(r) || r < 1 || r > SCRYPT_MAX_R) {
    return `r must be an integer from 1 to ${SCRYPT_MAX_R}`;
  }
  if (!Number.isSafeInteger(p) || p < 1 || p > SCRYPT_MAX_P) {
    return `p must be an integer from 1 to ${SCRYPT_MAX_P}`;
  }
  if (N * r > SCRYPT_MAX_BLOCKS) return `N * r must not exceed ${SCRYPT_MAX_BLOCKS}`;
  if (N * r * p > SCRYPT_MAX_WORK) return `N * r * p must not exceed ${SCRYPT_MAX_WORK}`;
  return null;
}

function resolveScrypt(options) {
  if (options !== undefined && !isPlainObject(options)) {
    throw new ConfigError('scrypt options must be an object');
  }
  // A parameter left undefined means "use the default", so callers can pass their
  // configuration through without filtering it first.
  const params = {
    N: options?.N ?? DEFAULT_SCRYPT.N,
    r: options?.r ?? DEFAULT_SCRYPT.r,
    p: options?.p ?? DEFAULT_SCRYPT.p,
  };
  const reason = scryptProblem(params);
  if (reason !== null) throw new ConfigError(`invalid scrypt parameters: ${reason}`);
  return params;
}

function hasPassphrase(passphrase) {
  return passphrase !== undefined && passphrase !== null;
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new ConfigError('passphrase must be a non-empty string');
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new ConfigError(`passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
  }
  // A lone surrogate has no UTF-8 encoding; it would silently become U+FFFD and make
  // different passphrases unlock the same keystore.
  if (!passphrase.isWellFormed()) {
    throw new ConfigError('passphrase must be well-formed Unicode');
  }
}

/** NFKC makes one passphrase typed on different keyboards and platforms the same bytes. */
function passphraseBytes(passphrase) {
  checkPassphrase(passphrase);
  return Buffer.from(passphrase.normalize('NFKC'), 'utf8');
}

/** @returns {Promise<Buffer>} 32-byte key; the caller overwrites it after use */
function deriveKey(password, salt, { N, r, p }) {
  // OpenSSL refuses to run unless maxmem covers 128 * r * (N + p + 2) bytes; Node's
  // default of 32 MiB is far below what the default parameters need.
  const maxmem = 128 * r * (N + p + 2) + 1024;
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, { N, r, p, maxmem }, (cause, key) => {
      if (cause) reject(new CryptoError('key derivation failed', { cause }));
      else resolve(key);
    });
  });
}

/** @returns {Buffer} ciphertext || tag */
function aeadSeal(key, nonce, plaintext, ad) {
  return aeadEncrypt(key, nonce, ad, plaintext);
}

/**
 * @returns {Buffer | null} the plaintext, or null if authentication fails. The failure
 *   carries no detail on purpose: callers turn it into one fixed AuthError.
 */
function aeadOpen(key, nonce, sealed, ad) {
  try {
    return aeadDecrypt(key, nonce, ad, sealed);
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

function requirePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new StoreError('keystore path must be a non-empty string');
  }
}

function requireKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new CryptoError(`storage key must be ${KEY_BYTES} bytes`);
  }
}

function requireBytes(value, name) {
  if (!(value instanceof Uint8Array)) throw new CryptoError(`${name} must be bytes`);
}

function optionalBytes(value, name) {
  if (value === undefined || value === null) return EMPTY;
  requireBytes(value, name);
  return value;
}
