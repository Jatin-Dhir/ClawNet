/**
 * Node storage (ARCHITECTURE.md 3 and 5.8).
 *
 * Gives the node and its services named documents, logs and blob directories under one
 * data directory. Everything is encrypted at rest with the keystore's storage key unless
 * the caller declares it plain, and every path is confined to the directory.
 *
 * Three kinds of object, all built on `vault/store.js`:
 *
 *   - a Doc has the interface of `JsonFile`; a plain Doc IS a `JsonFile`;
 *   - a Log has the interface of `AppendLog`; a plain Log IS an `AppendLog`;
 *   - Blobs hold one sealed file per key (the outbox keeps its packets in them).
 *
 * Sealed formats (the associated data binds each item to its place, so a doc, a log line or
 * a blob copied to another name, scope or key fails to open instead of being accepted as
 * something else):
 *
 *   doc file  { "v": 1, "b": base64(seal(key, canonicalBytes(data), "doc:" + path)) }
 *   log line  { "b": base64(seal(key, canonicalBytes(record), "log:" + path)) }
 *   blob file seal(key, bytes, "blob:" + path + ":" + blobKey)
 *
 * where `path` is the name prefixed with the names of the scopes it lives in
 * ("services/cast/state"). Sealed data is therefore canonical JSON: integers only.
 *
 * Errors are StoreError (invalid argument, I/O failure, unreadable or tampered file) or
 * StateError (a name used twice).
 *
 * Limitation: confinement is by name validation and path resolution. A symbolic link that
 * somebody with write access to the data directory plants inside it is followed; the data
 * directory is private to its owner (mode 0700) and that is the boundary.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { open as openFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { StateError, StoreError } from './errors.js';
import { base64Decode, base64Encode } from './crypto/primitives.js';
import { canonicalBytes, parseCanonical } from './wire/canonical.js';
import { open as openSealed, seal as sealBytes } from '../vault/keystore.js';
import {
  AppendLog,
  JsonFile,
  atomicWriteFile,
  readAtMost,
} from '../vault/store.js';

/** Names of docs, logs and scopes: `<name>.json`, `<name>.log` and the directory `<name>/`. */
export const STORAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Keys of blobs, which become file names. */
export const BLOB_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Largest blob `put` accepts and `get` reads unless a `maxBytes` is given: a packet is at most 1 MiB. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/** File names Windows treats as devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/;

const ENVELOPE_VERSION = 1;
const KEY_LENGTH = 32;
const IS_WINDOWS = process.platform === 'win32';

/** Marks the second constructor argument as coming from `scope()`, not from a caller. */
class ScopeToken {
  constructor(shared, prefix, dir) {
    this.shared = shared;
    this.prefix = prefix;
    this.dir = dir;
  }
}

/** A JsonFile that tells the node when it had to set a corrupt file aside. */
class ReportingJsonFile extends JsonFile {
  #report;
  #loaded = false;

  constructor(path, options, report) {
    super(path, options);
    this.#report = report;
  }

  /** @returns {boolean} whether `load()` has completed */
  get isLoaded() {
    return this.#loaded;
  }

  async load() {
    const result = await super.load();
    this.#loaded = true;
    if (result.recovered) this.#report(this.path, result.corruptPath);
    return result;
  }
}

/**
 * A document whose file holds the envelope `{ v, b }`. It reuses a JsonFile for the file
 * handling (atomic replacement, coalesced saves, quarantine of a damaged file) and keeps
 * the plaintext itself.
 *
 * The envelope's `b` is a getter that seals the current plaintext when the file is
 * serialized. Sealing at the last moment means a burst of updates costs one encryption and
 * one random nonce, not one per update, and the bytes written are always the latest state.
 */
class SealedDoc {
  #inner;
  #key;
  #ad;
  #defaults;
  #userValidate;
  #report;
  #opened;
  #data;
  #loaded = false;

  constructor(path, { name, key, defaults, validate, now }, report) {
    this.#key = key;
    this.#ad = Buffer.from(`doc:${name}`, 'utf8');
    this.#defaults = structuredClone(defaults);
    this.#userValidate = validate;
    this.#report = report;
    this.#inner = new JsonFile(path, {
      defaults: { v: ENVELOPE_VERSION, b: '' },
      now,
      validate: (value) => {
        this.#opened = this.#unseal(value);
        return this.#opened !== undefined;
      },
    });
  }

  /** @returns {string} the file this document lives in */
  get path() {
    return this.#inner.path;
  }

  /** @returns {boolean} whether `load()` has completed */
  get isLoaded() {
    return this.#loaded;
  }

  /** @returns {unknown} the live plaintext document */
  get data() {
    this.#requireLoaded();
    return this.#data;
  }

  /** @returns {{ writes: number, dirty: boolean, lastError: StoreError | null }} */
  get stats() {
    return this.#inner.stats;
  }

  /**
   * Read the file. A file that cannot be opened with this key and this name (damaged,
   * tampered, moved from another name, or sealed under another key) is set aside like a
   * corrupt JsonFile and the defaults are used.
   *
   * @returns {Promise<{ data: unknown, recovered: boolean, corruptPath: string | null }>}
   */
  async load() {
    this.#opened = undefined;
    const result = await this.#inner.load();
    this.#data = this.#opened === undefined ? structuredClone(this.#defaults) : this.#opened.data;
    this.#opened = undefined;
    Object.defineProperty(this.#inner.data, 'b', {
      enumerable: true,
      configurable: true,
      get: () => base64Encode(sealBytes(this.#key, canonicalBytes(this.#data), this.#ad)),
    });
    this.#loaded = true;
    if (result.recovered) this.#report(this.path, result.corruptPath);
    return { data: this.#data, recovered: result.recovered, corruptPath: result.corruptPath };
  }

  /**
   * Change the document in place and schedule a save.
   *
   * @param {(data: any) => void} mutator synchronous; changes the live document
   * @throws {StoreError} if the mutator is not synchronous, or leaves data that has no
   *   canonical JSON form (a float, undefined, a cycle): that could never be sealed
   */
  update(mutator) {
    this.#requireLoaded();
    if (typeof mutator !== 'function') throw new StoreError('mutator must be a function');
    let result;
    try {
      result = mutator(this.#data);
    } finally {
      // As JsonFile: whatever the mutator did is in memory, so it is also scheduled.
      this.#inner.update(() => {});
    }
    if (typeof result?.then === 'function') throw new StoreError('mutator must be synchronous');
    try {
      canonicalBytes(this.#data);
    } catch (cause) {
      throw new StoreError('a sealed document must be canonical JSON (integers only)', { cause });
    }
  }

  /** @returns {Promise<void>} resolves when the current state is on disk */
  async save() {
    this.#requireLoaded();
    await this.#inner.save();
  }

  /** @returns {Promise<void>} resolves when every change made so far is on disk */
  async flush() {
    this.#requireLoaded();
    await this.#inner.flush();
  }

  #requireLoaded() {
    if (!this.#loaded) throw new StateError('document is not loaded');
  }

  /** @returns {{ data: unknown } | undefined} undefined when the envelope does not open */
  #unseal(value) {
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== 2 ||
      value.v !== ENVELOPE_VERSION ||
      typeof value.b !== 'string'
    ) {
      return undefined;
    }
    try {
      const data = parseCanonical(openSealed(this.#key, base64Decode(value.b), this.#ad));
      if (this.#userValidate !== undefined && this.#userValidate(data) === false) return undefined;
      return { data };
    } catch {
      return undefined;
    }
  }
}

/**
 * An AppendLog whose records are sealed. A line that does not open (damaged, tampered,
 * copied from another log) is skipped and counted like a corrupt line.
 */
class SealedLog {
  #inner;
  #key;
  #ad;
  #unopened = 0;

  constructor(path, { name, key, fsync }) {
    this.#inner = new AppendLog(path, { fsync });
    this.#key = key;
    this.#ad = Buffer.from(`log:${name}`, 'utf8');
  }

  /** @returns {string} the log file */
  get path() {
    return this.#inner.path;
  }

  /** @returns {{ bytes: number, appended: number, corruptLines: number, tornBytes: number, syncs: number }} */
  get stats() {
    const stats = this.#inner.stats;
    return { ...stats, corruptLines: stats.corruptLines + this.#unopened };
  }

  /** @returns {Promise<void>} */
  open() {
    return this.#inner.open();
  }

  /**
   * @param {object} record plain object of canonical JSON data
   * @returns {Promise<void>}
   */
  async append(record) {
    await this.#inner.append({ b: this.#sealRecord(record) });
  }

  /**
   * Iterate over the records that open, oldest first.
   *
   * @returns {AsyncGenerator<object, void, void>}
   */
  async *read() {
    this.#unopened = 0;
    for await (const line of this.#inner.read()) {
      const record = this.#unsealLine(line);
      if (record === undefined) this.#unopened += 1;
      else yield record;
    }
  }

  /**
   * @param {Iterable<object> | AsyncIterable<object>} records
   * @returns {Promise<void>}
   */
  rewrite(records) {
    return this.#inner.rewrite(this.#sealAll(records));
  }

  /** @returns {Promise<void>} */
  flush() {
    return this.#inner.flush();
  }

  /** @returns {Promise<void>} */
  close() {
    return this.#inner.close();
  }

  async *#sealAll(records) {
    // for await accepts both sync and async iterables, as AppendLog.rewrite does.
    for await (const record of records) yield { b: this.#sealRecord(record) };
  }

  #sealRecord(record) {
    if (!isPlainObject(record)) throw new StoreError('a log record must be a plain JSON object');
    let bytes;
    try {
      bytes = canonicalBytes(record);
    } catch (cause) {
      throw new StoreError('a sealed log record must be canonical JSON (integers only)', { cause });
    }
    return base64Encode(sealBytes(this.#key, bytes, this.#ad));
  }

  #unsealLine(line) {
    if (Object.keys(line).length !== 1 || typeof line.b !== 'string') return undefined;
    try {
      const record = parseCanonical(openSealed(this.#key, base64Decode(line.b), this.#ad));
      return isPlainObject(record) ? record : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A directory of sealed files, one per key. */
class Blobs {
  #dir;
  #label;
  #key;
  #maxBytes;

  constructor(dir, { label, key, maxBytes }) {
    this.#dir = dir;
    this.#label = label;
    this.#key = key;
    this.#maxBytes = maxBytes;
  }

  /**
   * Store a blob, replacing any earlier one under the key.
   *
   * @param {string} key BLOB_KEY_PATTERN
   * @param {Uint8Array} bytes at most the blob size limit
   * @returns {Promise<void>} resolves when the blob is durable (atomic replacement)
   * @throws {StoreError} for a bad key, bad bytes, an oversized blob or an I/O failure
   */
  async put(key, bytes) {
    const file = this.#file(key);
    if (!(bytes instanceof Uint8Array)) throw new StoreError('a blob must be a Buffer or Uint8Array');
    if (bytes.length > this.#maxBytes) {
      throw new StoreError(`a blob is at most ${this.#maxBytes} bytes`);
    }
    await atomicWriteFile(file, sealBytes(this.#key, bytes, this.#ad(key)));
  }

  /**
   * Read a blob.
   *
   * @param {string} key
   * @returns {Promise<Buffer | null>} null when there is no such blob
   * @throws {StoreError} if the file cannot be read, is oversized, or does not open under
   *   this key, name and blob key (damaged, tampered, or copied from elsewhere)
   */
  async get(key) {
    const file = this.#file(key);
    let handle;
    let sealed;
    try {
      handle = await openFile(file, 'r');
      // The limit covers the nonce and tag that sealing adds.
      sealed = await readAtMost(handle, this.#maxBytes + 64);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw cause instanceof StoreError ? cause : new StoreError(`cannot read blob ${key}`, { cause });
    } finally {
      await handle?.close().catch(() => {});
    }
    if (sealed === undefined) throw new StoreError(`blob ${key} is larger than the blob limit`);
    try {
      return openSealed(this.#key, sealed, this.#ad(key));
    } catch (cause) {
      throw new StoreError(`blob ${key} cannot be opened: it is damaged or does not belong here`, {
        cause,
      });
    }
  }

  /**
   * Remove a blob. Removing one that does not exist is not an error.
   *
   * @param {string} key
   * @returns {Promise<void>}
   * @throws {StoreError} for a bad key or an I/O failure
   */
  async delete(key) {
    const file = this.#file(key);
    try {
      await unlink(file);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return;
      throw new StoreError(`cannot delete blob ${key}`, { cause });
    }
  }

  /**
   * @returns {Promise<string[]>} the keys of the stored blobs, sorted; files that are not
   *   valid blob keys (temporary files of an interrupted write) are not listed
   * @throws {StoreError} on an I/O failure
   */
  async keys() {
    let names;
    try {
      names = await readdir(this.#dir);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return [];
      throw new StoreError(`cannot list blobs in ${this.#label}`, { cause });
    }
    return names.filter(isBlobKey).sort();
  }

  #file(key) {
    if (!isBlobKey(key)) throw new StoreError('invalid blob key');
    return join(this.#dir, key);
  }

  #ad(key) {
    return Buffer.from(`blob:${this.#label}:${key}`, 'utf8');
  }
}

/**
 * The storage of one node, or of one scope inside it.
 */
export class NodeStorage {
  #shared;
  #prefix;
  #dir;
  #docs = new Map();
  #logs = new Map();
  #blobs = new Map();
  #scopes = new Map();

  /**
   * @param {object} options
   * @param {string} options.dir the data directory; it must already exist
   * @param {Uint8Array} options.storageKey the keystore's 32-byte storage key
   * @param {() => number} [options.now] wall clock in ms; names quarantined files
   * @param {(info: { file: string, movedTo: string }) => void} [options.onRecovered] called
   *   when a sealed or plain doc had to be set aside; both paths are relative to `dir`,
   *   with `/` separators, so an event does not carry the user's home directory
   * @param {ScopeToken} [token] internal: how scope() builds a child
   * @throws {StoreError} for a bad argument
   */
  constructor({ dir, storageKey, now = Date.now, onRecovered } = {}, token) {
    if (token instanceof ScopeToken) {
      this.#shared = token.shared;
      this.#prefix = token.prefix;
      this.#dir = token.dir;
      return;
    }
    if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) {
      throw new StoreError('dir must be a non-empty path');
    }
    if (!(storageKey instanceof Uint8Array) || storageKey.length !== KEY_LENGTH) {
      throw new StoreError('storageKey must be 32 bytes');
    }
    if (typeof now !== 'function') throw new StoreError('now must be a function');
    if (onRecovered !== undefined && typeof onRecovered !== 'function') {
      throw new StoreError('onRecovered must be a function');
    }
    this.#dir = resolve(dir);
    this.#prefix = '';
    this.#shared = {
      root: this.#dir,
      // A private copy: the caller wipes the keystore's buffer when it is done with it.
      key: Buffer.from(storageKey),
      now,
      onRecovered,
    };
  }

  /** @returns {string} absolute path of this storage's directory */
  get dir() {
    return this.#dir;
  }

  /**
   * A child storage rooted at `<dir>/<name>`, created with mode 0700. Asking for the same
   * name again returns the same object.
   *
   * @param {string} name STORAGE_NAME_PATTERN
   * @returns {NodeStorage}
   * @throws {StoreError} for a bad name or if the directory cannot be made
   */
  scope(name) {
    checkName(name);
    let child = this.#scopes.get(name);
    if (child === undefined) {
      const dir = join(this.#dir, name);
      makePrivateDir(dir);
      child = new NodeStorage(
        {},
        new ScopeToken(this.#shared, `${this.#prefix}${name}/`, dir),
      );
      this.#scopes.set(name, child);
    }
    return child;
  }

  /**
   * A named document, `<name>.json`. Call `load()` before use.
   *
   * @param {string} name STORAGE_NAME_PATTERN
   * @param {object} options
   * @param {unknown} options.defaults used when there is no usable file
   * @param {(value: unknown) => unknown} [options.validate] throwing or returning false
   *   marks the file as corrupt
   * @param {boolean} [options.sealed] encrypt with the storage key (default true)
   * @returns {JsonFile | object} a JsonFile when plain; when sealed an object with the same
   *   members (`load`, `data`, `update`, `save`, `flush`, `path`, `stats`)
   * @throws {StoreError} for a bad name or defaults
   * @throws {StateError} if the name is already used for a doc in this scope
   */
  doc(name, { defaults, validate, sealed = true } = {}) {
    checkName(name);
    if (this.#docs.has(name)) throw new StateError(`doc-exists: "${name}" is already open`);
    if (defaults === undefined) throw new StoreError('defaults are required');
    if (validate !== undefined && typeof validate !== 'function') {
      throw new StoreError('validate must be a function');
    }
    const path = join(this.#dir, `${name}.json`);
    const { now } = this.#shared;
    const report = (file, movedTo) => this.#recovered(file, movedTo);
    const doc = sealed
      ? new SealedDoc(
          path,
          { name: `${this.#prefix}${name}`, key: this.#shared.key, defaults, validate, now },
          report,
        )
      : new ReportingJsonFile(path, { defaults, validate, now }, report);
    this.#docs.set(name, doc);
    return doc;
  }

  /**
   * A named append-only log, `<name>.log`. Call `open()` before use.
   *
   * @param {string} name STORAGE_NAME_PATTERN
   * @param {object} [options]
   * @param {boolean} [options.sealed] encrypt each record (default true)
   * @param {'batch' | 'always' | 'never'} [options.fsync] durability (default "batch")
   * @returns {AppendLog | object} an AppendLog when plain; when sealed an object with the
   *   same members (`open`, `append`, `read`, `rewrite`, `flush`, `close`, `stats`, `path`)
   * @throws {StoreError} for a bad name or option
   * @throws {StateError} if the name is already used for a log in this scope
   */
  log(name, { sealed = true, fsync = 'batch' } = {}) {
    checkName(name);
    if (this.#logs.has(name)) throw new StateError(`log-exists: "${name}" is already open`);
    const path = join(this.#dir, `${name}.log`);
    const log = sealed
      ? new SealedLog(path, { name: `${this.#prefix}${name}`, key: this.#shared.key, fsync })
      : new AppendLog(path, { fsync });
    this.#logs.set(name, log);
    return log;
  }

  /**
   * A directory `<name>/` of sealed blobs, created with mode 0700.
   *
   * @param {string} name STORAGE_NAME_PATTERN
   * @param {object} [options]
   * @param {number} [options.maxBytes] largest blob (default MAX_BLOB_BYTES)
   * @returns {Blobs}
   * @throws {StoreError} for a bad name or option, or if the directory cannot be made
   * @throws {StateError} if the name is already used for blobs in this scope
   */
  blobs(name, { maxBytes = MAX_BLOB_BYTES } = {}) {
    checkName(name);
    if (this.#blobs.has(name)) throw new StateError(`blobs-exist: "${name}" is already open`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new StoreError('maxBytes must be a positive integer');
    }
    const dir = join(this.#dir, name);
    makePrivateDir(dir);
    const blobs = new Blobs(dir, {
      label: `${this.#prefix}${name}`,
      key: this.#shared.key,
      maxBytes,
    });
    this.#blobs.set(name, blobs);
    return blobs;
  }

  /**
   * An absolute path inside this storage's directory.
   *
   * @param {...string} parts path segments
   * @returns {string}
   * @throws {StoreError} if a part is not a string, contains a NUL, is absolute, or the
   *   result leaves the directory
   */
  path(...parts) {
    for (const part of parts) {
      if (typeof part !== 'string' || part.includes('\0')) {
        throw new StoreError('path parts must be strings without NUL characters');
      }
      if (isAbsolute(part)) throw new StoreError('path parts must be relative');
    }
    const full = resolve(this.#dir, ...parts);
    const rel = relative(this.#dir, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new StoreError('path leaves the data directory');
    }
    return full;
  }

  /**
   * Flush every doc and close every log of this storage and its scopes. Every one is
   * attempted even if an earlier one fails; the first failure is then thrown.
   *
   * @returns {Promise<void>}
   * @throws {StoreError} the first failure, if any
   */
  async closeAll() {
    const failures = [];
    const attempt = async (work) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await this.#closeTree(attempt);
    if (failures.length > 0) {
      throw failures[0] instanceof StoreError
        ? failures[0]
        : new StoreError('cannot close storage', { cause: failures[0] });
    }
  }

  async #closeTree(attempt) {
    await Promise.all([...this.#docs.values()].map((doc) => attempt(async () => {
      if (doc.isLoaded) await doc.flush();
    })));
    for (const log of this.#logs.values()) await attempt(() => log.close());
    for (const child of this.#scopes.values()) await child.#closeTree(attempt);
  }

  #recovered(file, movedTo) {
    const { root, onRecovered } = this.#shared;
    if (onRecovered === undefined) return;
    const rel = (path) => relative(root, path).split(sep).join('/');
    try {
      onRecovered({ file: rel(file), movedTo: rel(movedTo) });
    } catch {
      // A faulty observer must not turn a successful recovery into a failed load.
    }
  }
}

function checkName(name) {
  if (typeof name !== 'string' || !STORAGE_NAME_PATTERN.test(name)) {
    throw new StoreError(`name must match ${STORAGE_NAME_PATTERN}`);
  }
}

/** Whether a string may be used as a blob key (and so as a file name on any platform). */
function isBlobKey(key) {
  // A trailing dot is dropped by Windows, so "a." and "a" would be one file.
  return (
    typeof key === 'string' &&
    BLOB_KEY_PATTERN.test(key) &&
    !key.endsWith('.') &&
    !WINDOWS_DEVICE_NAME.test(key)
  );
}

function makePrivateDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) chmodSync(dir, 0o700);
  } catch (cause) {
    throw new StoreError(`cannot prepare private directory ${dir}`, { cause });
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
