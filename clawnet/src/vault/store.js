/**
 * Durable local state for ClawVault.
 *
 * Everything a node must still know after a crash goes through this module, so the rules
 * are stated once:
 *
 *   - A file is replaced, never edited in place: the new content is written to a temporary
 *     file in the same directory, flushed to stable storage, and renamed over the target.
 *     A reader therefore sees the old content or the new content, never a mixture.
 *   - Damaged state is never fatal and never silently discarded. A state file that cannot
 *     be parsed is moved aside under a `.corrupt-<timestamp>` name and the node continues
 *     from its defaults; a log keeps every record that is intact.
 *   - A log record is committed once its terminating newline is on disk. A crash can only
 *     ever leave an unterminated tail, which the next open removes.
 *
 * One process owns a data directory. Nothing here locks files against a second process,
 * and two objects for the same path in one process are not coordinated either.
 *
 * Errors are StoreError (I/O failure, invalid argument, unusable file) or StateError
 * (operation not valid now); the underlying system error is attached as `cause`.
 */

import { chmod, constants, link, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { ClawNetError, StateError, StoreError } from '../core/errors.js';

const IS_WINDOWS = process.platform === 'win32';

/** Error codes Windows reports while another process briefly holds a file open. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Error codes from link() that mean the file system has no hard links. */
const NO_LINK_CODES = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EMLINK']);

/**
 * Waits between rename attempts on Windows, in milliseconds. Ten attempts over at most
 * 3.6 s. A virus scanner or indexer normally lets go of a new file within tens of
 * milliseconds, but while a whole test suite or a busy node saturates the machine the
 * hold has been seen to outlast a window of 385 ms (an EPERM that surfaced once under
 * load). The waits grow quickly and the tail is flat, so the common case costs almost
 * nothing and a real permission problem is still reported within a few seconds.
 */
const RENAME_BACKOFF_MS = Object.freeze([10, 25, 50, 100, 200, 400, 800, 1000, 1000]);

/** Largest state file JsonFile will parse unless told otherwise. */
const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;

/** Largest log record, excluding its newline, unless told otherwise. */
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

/** Read granularity for log scans. */
const IO_CHUNK_BYTES = 64 * 1024;

/** Appends queued behind one another are written together up to this many bytes. */
const APPEND_BATCH_BYTES = 1024 * 1024;

const FSYNC_MODES = new Set(['batch', 'always', 'never']);

const NEWLINE = 0x0a;

const TEMP_SUFFIX_PATTERN = /^[0-9a-f]{12}\.tmp$/;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Rename a file, retrying on Windows while something else briefly holds it.
 *
 * Virus scanners and search indexers open new files for a moment, and Windows refuses to
 * replace a file that is open. On other platforms a failed rename is final.
 *
 * @param {string} from source path
 * @param {string} to   destination path; replaced if it exists
 * @param {object} [hooks] injection points; production code passes nothing
 * @param {(from: string, to: string) => Promise<void>} [hooks.rename] the rename primitive
 * @param {(ms: number) => Promise<void>} [hooks.sleep] waits the given milliseconds
 * @param {string} [hooks.platform] a `process.platform` value
 * @returns {Promise<void>}
 * @throws {StoreError} when the rename fails with a non-transient error or stays blocked
 */
export async function renameWithRetry(from, to, hooks = {}) {
  const { rename: attemptRename = rename, sleep = delay, platform = process.platform } = hooks;
  const waits = platform === 'win32' ? RENAME_BACKOFF_MS : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await attemptRename(from, to);
      return;
    } catch (cause) {
      if (attempt >= waits.length || !RENAME_RETRY_CODES.has(cause?.code)) {
        throw new StoreError(`cannot replace ${to}`, { cause });
      }
      await sleep(waits[attempt]);
    }
  }
}

/**
 * Replace a file's content atomically and durably.
 *
 * The data is written to a temporary file next to the target, fsynced, renamed over the
 * target, and the directory is fsynced where the platform supports that (not on Windows).
 * After a crash the target holds either its previous content or `data` in full. The
 * temporary file is removed on every failure path.
 *
 * @param {string} path target file; its directory must exist
 * @param {string | Uint8Array} data content; strings are written as UTF-8
 * @param {{ mode?: number }} [options] permission bits for the file (default 0o600;
 *   ignored by Windows)
 * @param {object} [hooks] injection points; production code passes nothing. They are
 *   those of `renameWithRetry`: `rename`, `sleep` and `platform`
 * @returns {Promise<void>}
 * @throws {StoreError} on invalid arguments or any I/O failure
 */
export async function atomicWriteFile(path, data, options = {}, hooks = {}) {
  const { mode = 0o600 } = options;
  requirePath(path);
  requireMode(mode);
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new StoreError('data must be a string or a Uint8Array');
  }
  const temp = await writeTemp(path, mode, (handle) => handle.writeFile(data));
  await commitTemp(temp, path, hooks ?? {});
}

/**
 * Create a file with the given content atomically and durably, never replacing one.
 *
 * The data is written to a temporary file next to the target and fsynced, then published
 * under the target name with a hard link, which fails if the name is taken, and the
 * temporary name is removed. After a crash the target is therefore absent or complete,
 * never empty or partial; at worst a temporary file is left for sweepTempFiles. Of
 * several concurrent creators exactly one succeeds.
 *
 * On a file system without hard links (FAT, some network shares) the name is reserved
 * with an exclusive create and the content renamed over it. That keeps the one-winner
 * property, but a crash between the two steps leaves an empty file at the target.
 *
 * @param {string} path target file; its directory must exist
 * @param {string | Uint8Array} data content; strings are written as UTF-8
 * @param {{ mode?: number }} [options] permission bits for the file (default 0o600;
 *   ignored by Windows)
 * @param {object} [hooks] injection points; production code passes nothing
 * @param {(existing: string, created: string) => Promise<void>} [hooks.link] the
 *   hard-link primitive
 * @returns {Promise<void>}
 * @throws {StateError} if something already exists at `path`; it is left untouched
 * @throws {StoreError} on invalid arguments or any other I/O failure
 */
export async function atomicCreateFile(path, data, options = {}, hooks = {}) {
  const { mode = 0o600 } = options ?? {};
  const { link: attemptLink = link } = hooks ?? {};
  requirePath(path);
  requireMode(mode);
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new StoreError('data must be a string or a Uint8Array');
  }
  const temp = await writeTemp(path, mode, (handle) => handle.writeFile(data));
  try {
    await attemptLink(temp, path);
  } catch (cause) {
    // ENOENT: our temporary file is gone, which happens when a concurrent creator won
    // and swept leftovers; the target then exists and the outcome is the same.
    if (cause?.code === 'EEXIST' || (cause?.code === 'ENOENT' && (await exists(path)))) {
      await unlink(temp).catch(() => {});
      throw new StateError(`${path} already exists`);
    }
    if (!NO_LINK_CODES.has(cause?.code)) {
      await unlink(temp).catch(() => {});
      throw new StoreError(`cannot create ${path}`, { cause });
    }
    await publishByPlaceholder(temp, path, mode);
    return;
  }
  // The content is reachable under its final name; the temporary name is only clutter.
  await unlink(temp).catch(() => {});
  await syncDir(dirname(path));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Fallback for atomicCreateFile where hard links are not supported. */
async function publishByPlaceholder(temp, path, mode) {
  try {
    const placeholder = await open(path, 'wx', mode);
    await placeholder.close();
  } catch (cause) {
    await unlink(temp).catch(() => {});
    if (cause?.code === 'EEXIST') throw new StateError(`${path} already exists`);
    throw new StoreError(`cannot create ${path}`, { cause });
  }
  try {
    await commitTemp(temp, path);
  } catch (cause) {
    // Our own empty placeholder must not be left to look like a damaged file.
    await unlink(path).catch(() => {});
    throw wrap(cause, `cannot create ${path}`);
  }
}

/**
 * Create a directory (and missing parents) that only its owner can enter.
 *
 * New directories get mode 0o700. On POSIX an existing directory with any other
 * permission bits is tightened to 0o700; parents that already exist are left alone.
 * Windows ignores POSIX modes: there the directory inherits the ACL of its parent.
 *
 * @param {string} path
 * @returns {Promise<void>}
 * @throws {StoreError} if the path cannot be created or is not a directory
 */
export async function ensurePrivateDir(path) {
  requirePath(path);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await stat(path);
    if (!info.isDirectory()) throw new StoreError(`${path} is not a directory`);
    if (!IS_WINDOWS && (info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  } catch (cause) {
    throw wrap(cause, `cannot prepare private directory ${path}`);
  }
}

/**
 * Remove temporary files that a crash left next to `path`.
 *
 * Only names this module generates for that exact target are touched. Call it when a
 * store is opened, never while a write to the same target may be in flight. Failures are
 * ignored: a leftover temporary file costs disk space, not correctness.
 *
 * @param {string} path the target file whose leftovers should be removed
 * @returns {Promise<number>} how many files were removed
 */
export async function sweepTempFiles(path) {
  requirePath(path);
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !TEMP_SUFFIX_PATTERN.test(name.slice(prefix.length))) continue;
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      // Still held by something else, or already gone: leave it for the next sweep.
    }
  }
  return removed;
}

/**
 * A small JSON document kept in memory and saved atomically.
 *
 * `update()` changes the in-memory value and schedules a save. Saves never overlap: while
 * one write is running, any number of further updates collapse into a single following
 * write of the latest state, and updates made in the same tick share one write.
 */
export class JsonFile {
  #path;
  #defaults;
  #validate;
  #mode;
  #now;
  #maxBytes;
  #onError;

  #data;
  #loading = false;
  #loaded = false;
  /** Bumped on every change; a write records the version it captured. */
  #version = 0;
  #savedVersion = 0;
  #pump = null;
  #error = null;
  #writes = 0;

  /**
   * @param {string} path file to keep the document in; its directory must exist
   * @param {object} options
   * @param {unknown} options.defaults JSON value used when there is no usable file. It is
   *   deep-copied, so the caller's object is never modified.
   * @param {(value: unknown) => unknown} [options.validate] called with the parsed file.
   *   Throwing, or returning exactly `false`, marks the file as corrupt.
   * @param {number} [options.mode] permission bits for the file (default 0o600)
   * @param {() => number} [options.now] clock in milliseconds since the epoch; names the
   *   quarantined copy of a corrupt file
   * @param {number} [options.maxBytes] a larger file is treated as corrupt (default 64 MiB)
   * @param {(error: StoreError) => void} [options.onError] told about a failed background
   *   save. The state stays in memory and the next update, save or flush retries.
   * @throws {StoreError} on invalid options
   */
  constructor(path, options = {}) {
    const {
      defaults,
      validate,
      mode = 0o600,
      now = Date.now,
      maxBytes = DEFAULT_MAX_JSON_BYTES,
      onError,
    } = options ?? {};
    requirePath(path);
    requireMode(mode);
    requireOptionalFunction(validate, 'validate');
    requireOptionalFunction(onError, 'onError');
    if (typeof now !== 'function') throw new StoreError('now must be a function');
    requirePositiveInteger(maxBytes, 'maxBytes');
    this.#defaults = cloneDefaults(defaults);
    this.#path = path;
    this.#validate = validate;
    this.#mode = mode;
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#onError = onError;
  }

  /** @returns {string} the file this document is stored in */
  get path() {
    return this.#path;
  }

  /**
   * Read the file. Must be called once before anything else.
   *
   * A missing file yields the defaults. A file that is not valid UTF-8 JSON, fails
   * `validate`, or exceeds `maxBytes` is renamed to `<name>.corrupt-<timestamp>` (kept
   * for the operator, never deleted here) and loading continues from the defaults.
   *
   * @returns {Promise<{ data: unknown, recovered: boolean, corruptPath: string | null }>}
   *   `recovered` is true when a corrupt file was moved aside to `corruptPath`
   * @throws {StateError} if already loaded
   * @throws {StoreError} if the file exists but cannot be read, or a corrupt file cannot
   *   be moved aside (continuing would overwrite it)
   */
  async load() {
    if (this.#loading || this.#loaded) throw new StateError('state file is already loaded');
    this.#loading = true;
    try {
      await sweepTempFiles(this.#path);

      const bytes = await this.#readFile();
      let corruptPath = null;
      let data;
      if (bytes === null) {
        data = structuredClone(this.#defaults);
      } else {
        const parsed = bytes === undefined ? undefined : this.#parse(bytes);
        if (parsed === undefined) {
          corruptPath = await this.#quarantine();
          data = structuredClone(this.#defaults);
        } else {
          data = parsed.value;
        }
      }

      this.#data = data;
      this.#loaded = true;
      return { data, recovered: corruptPath !== null, corruptPath };
    } finally {
      // A failed load may be retried; a successful one is final.
      this.#loading = false;
    }
  }

  /**
   * The live document. Change it through `update()` so the change is saved.
   *
   * @returns {unknown}
   * @throws {StateError} before `load()`
   */
  get data() {
    this.#requireLoaded();
    return this.#data;
  }

  /**
   * Counters for diagnostics and tests.
   *
   * @returns {{ writes: number, dirty: boolean, lastError: StoreError | null }} `writes`
   *   counts completed file writes; `dirty` is true while memory is ahead of disk;
   *   `lastError` is the failure of the most recent save attempt, if it failed
   */
  get stats() {
    return {
      writes: this.#writes,
      dirty: this.#version !== this.#savedVersion,
      lastError: this.#error,
    };
  }

  /**
   * Change the document and schedule a save.
   *
   * The mutator receives the live document and must change it in place, synchronously;
   * its return value is ignored. If it throws, whatever it changed so far stays in memory
   * and is still scheduled, so memory and disk cannot drift apart unnoticed.
   *
   * @param {(data: any) => void} mutator
   * @returns {void}
   * @throws {StateError} before `load()`
   * @throws {StoreError} if `mutator` is not a function or returns a promise
   */
  update(mutator) {
    this.#requireLoaded();
    if (typeof mutator !== 'function') throw new StoreError('mutator must be a function');
    let result;
    try {
      result = mutator(this.#data);
    } finally {
      this.#version += 1;
      this.#kick();
    }
    if (typeof result?.then === 'function') {
      // The promise is the caller's to handle; a change it makes later would not be saved.
      throw new StoreError('mutator must be synchronous');
    }
  }

  /**
   * Write the current document now, even if nothing changed, and wait for it.
   *
   * @returns {Promise<void>}
   * @throws {StateError} before `load()`
   * @throws {StoreError} if the write fails
   */
  async save() {
    this.#requireLoaded();
    this.#version += 1;
    await this.flush();
  }

  /**
   * Wait until every change made so far is on disk.
   *
   * @returns {Promise<void>}
   * @throws {StateError} before `load()`
   * @throws {StoreError} if the write fails; the document stays dirty and a later call
   *   retries
   */
  async flush() {
    this.#requireLoaded();
    while (this.#version !== this.#savedVersion) {
      await this.#kick();
      if (this.#error !== null) throw this.#error;
    }
  }

  #requireLoaded() {
    if (!this.#loaded) throw new StateError('state file is not loaded');
  }

  /** Start the writer unless it is already running. Its promise never rejects. */
  #kick() {
    this.#pump ??= this.#drain();
    return this.#pump;
  }

  async #drain() {
    let failure = null;
    try {
      // Yield once so that every update made in this tick lands in the same write.
      await null;
      while (this.#savedVersion !== this.#version) {
        const version = this.#version;
        await atomicWriteFile(this.#path, serialize(this.#data), { mode: this.#mode });
        this.#savedVersion = version;
        this.#writes += 1;
      }
      this.#error = null;
    } catch (cause) {
      failure = wrap(cause, `cannot save ${this.#path}`);
      this.#error = failure;
    } finally {
      this.#pump = null;
    }
    if (failure !== null && this.#onError !== undefined) {
      try {
        this.#onError(failure);
      } catch {
        // A faulty observer must not turn a reported failure into an unhandled rejection.
      }
    }
  }

  /**
   * @returns {Promise<Buffer | null | undefined>} the content, null when there is no
   *   file, undefined when the file is too large to load
   */
  async #readFile() {
    let handle;
    try {
      handle = await open(this.#path, 'r');
      const info = await handle.stat();
      if (!info.isFile()) throw new StoreError(`${this.#path} is not a regular file`);
      if (info.size > this.#maxBytes) return undefined;
      // Bounded by maxBytes, not by the size just reported: the file may still grow.
      return await readAtMost(handle, this.#maxBytes);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw wrap(cause, `cannot read ${this.#path}`);
    } finally {
      // The handle must be gone before a corrupt file can be renamed on Windows.
      await handle?.close().catch(() => {});
    }
  }

  /** @returns {{ value: unknown } | undefined} undefined when the content is unusable */
  #parse(bytes) {
    try {
      const value = JSON.parse(utf8.decode(bytes));
      if (this.#validate !== undefined && this.#validate(value) === false) return undefined;
      return { value };
    } catch {
      return undefined;
    }
  }

  /**
   * Move the unusable file out of the way without ever replacing an earlier copy.
   *
   * rename() replaces an existing destination, so the name is reserved first with an
   * exclusive create; the rename then only ever replaces our own empty placeholder.
   */
  async #quarantine() {
    const stamp = timestamp(this.#now());
    for (let n = 0; n < 1000; n += 1) {
      const candidate = `${this.#path}.corrupt-${stamp}${n === 0 ? '' : `-${n}`}`;
      try {
        const placeholder = await open(candidate, 'wx', this.#mode);
        await placeholder.close();
      } catch (cause) {
        if (cause?.code === 'EEXIST') continue;
        throw new StoreError(`cannot set aside corrupt file ${this.#path}`, { cause });
      }
      try {
        await renameWithRetry(this.#path, candidate);
      } catch (cause) {
        await unlink(candidate).catch(() => {});
        throw new StoreError(`cannot set aside corrupt file ${this.#path}`, { cause });
      }
      await syncDir(dirname(this.#path));
      return candidate;
    }
    throw new StoreError(`too many corrupt copies of ${this.#path}`);
  }
}

/**
 * An append-only log of JSON objects, one per line.
 *
 * Commit rule: a record exists once its newline is in the file. `open()` removes an
 * unterminated tail (a write cut short by a crash); `read()` skips and counts lines that
 * are terminated but unreadable, so damage in the middle costs only the damaged records.
 *
 * Durability is chosen with `fsync`:
 *
 *   - `"always"`: `append()` resolves after the record has been fsynced. Appends that
 *     queue up behind a running write share one write and one fsync.
 *   - `"batch"` (default): `append()` resolves once the record has been handed to the
 *     operating system; an fsync follows in the background, one at a time, each covering
 *     everything written before it started. `flush()` and `close()` wait for it. A power
 *     failure can lose the most recent records, never corrupt earlier ones.
 *   - `"never"`: no fsync on append. Records survive a process crash but not necessarily
 *     a power failure. `rewrite()` still fsyncs, since it replaces the whole file.
 *
 * All operations on one instance are serialized; `read()` sees the records committed when
 * its iteration starts.
 */
export class AppendLog {
  #path;
  #fsync;
  #mode;
  #maxRecordBytes;

  #open = false;
  #handle = null;
  /** Bytes of committed records; always ends just after a newline. */
  #size = 0;
  #tail = Promise.resolve();
  /** Appends not yet handed to a writer run; null when the next append must start one. */
  #group = null;
  /** Set when the file may no longer match `#size`; cleared only by reopening. */
  #failure = null;

  /** True while written data has not been covered by an fsync. */
  #unsynced = false;
  #syncing = null;

  #readers = 0;
  /** Pending while rewrite() swaps the file; new reads wait for it. */
  #swap = null;

  #appended = 0;
  #corruptLines = 0;
  #tornBytes = 0;
  #syncs = 0;

  /**
   * @param {string} path log file; its directory must exist
   * @param {object} [options]
   * @param {'batch' | 'always' | 'never'} [options.fsync] durability policy (default "batch")
   * @param {number} [options.mode] permission bits for the file (default 0o600)
   * @param {number} [options.maxRecordBytes] largest serialized record in bytes, newline
   *   excluded (default 8 MiB). Larger records are refused on append and counted as
   *   corrupt on read, which bounds the memory a damaged file can make a reader use.
   * @throws {StoreError} on invalid options
   */
  constructor(path, options = {}) {
    const { fsync = 'batch', mode = 0o600, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES } = options ?? {};
    requirePath(path);
    requireMode(mode);
    if (!FSYNC_MODES.has(fsync)) throw new StoreError('fsync must be "batch", "always" or "never"');
    requirePositiveInteger(maxRecordBytes, 'maxRecordBytes');
    this.#path = path;
    this.#fsync = fsync;
    this.#mode = mode;
    this.#maxRecordBytes = maxRecordBytes;
  }

  /** @returns {string} the log file */
  get path() {
    return this.#path;
  }

  /**
   * Counters for diagnostics and tests.
   *
   * @returns {{ bytes: number, appended: number, corruptLines: number, tornBytes: number, syncs: number }}
   *   `bytes`: committed size of the file; `appended`: records appended since `open()`;
   *   `corruptLines`: unreadable lines skipped by the most recent `read()` that ran to
   *   the end; `tornBytes`: size of the unterminated tail removed by `open()`;
   *   `syncs`: fsync calls on the log file since `open()`
   */
  get stats() {
    return {
      bytes: this.#size,
      appended: this.#appended,
      corruptLines: this.#corruptLines,
      tornBytes: this.#tornBytes,
      syncs: this.#syncs,
    };
  }

  /**
   * Open the log, creating the file if needed, and remove a torn final record.
   *
   * @returns {Promise<void>}
   * @throws {StateError} if already open
   * @throws {StoreError} if the file cannot be opened or repaired
   */
  open() {
    return this.#enqueue(async () => {
      if (this.#open) throw new StateError('log is already open');
      await sweepTempFiles(this.#path);
      let handle;
      try {
        handle = await open(this.#path, constants.O_RDWR | constants.O_CREAT, this.#mode);
        const info = await handle.stat();
        if (!info.isFile()) throw new StoreError(`${this.#path} is not a regular file`);
        const end = await committedEnd(handle, info.size);
        let syncs = 0;
        if (end !== info.size) {
          await handle.truncate(end);
          if (this.#fsync !== 'never') {
            await handle.sync();
            syncs = 1;
          }
        }
        // Without this a power failure could drop the directory entry of a new log, and
        // with it records that append() had already reported as synced.
        if (this.#fsync !== 'never') await syncDir(dirname(this.#path));
        this.#handle = handle;
        this.#size = end;
        this.#tornBytes = info.size - end;
        this.#syncs = syncs;
      } catch (cause) {
        await handle?.close().catch(() => {});
        throw wrap(cause, `cannot open log ${this.#path}`);
      }
      this.#appended = 0;
      this.#corruptLines = 0;
      this.#unsynced = false;
      this.#failure = null;
      this.#open = true;
    });
  }

  /**
   * Append one record.
   *
   * @param {object} record a plain JSON object; it is serialized before this returns, so
   *   later changes to it do not affect the log
   * @returns {Promise<void>} resolves when the record is committed under the configured
   *   fsync policy
   * @throws {StateError} if the log is not open
   * @throws {StoreError} if the record is not a JSON object, is too large, or the write
   *   fails. After a failed write the file is cut back to its last committed record; if
   *   even that fails the log refuses further appends until it is closed and reopened.
   */
  async append(record) {
    if (!this.#open) throw new StateError('log is not open');
    if (this.#failure !== null) throw this.#unusable();
    const line = encodeRecord(record, this.#maxRecordBytes);
    await new Promise((resolve, reject) => {
      if (this.#group === null) {
        const group = [];
        // #drain settles every append itself and never throws.
        void this.#enqueue(() => this.#drain(group));
        this.#group = group;
      }
      this.#group.push({ line, resolve, reject });
    });
  }

  /**
   * Iterate over the records committed when iteration starts, oldest first.
   *
   * Lines that are not UTF-8 JSON objects, or exceed `maxRecordBytes`, are skipped and
   * counted in `stats.corruptLines`. Consume the iterator with `for await` (or call its
   * `return()`): it holds a file handle until it finishes.
   *
   * @returns {AsyncGenerator<object, void, void>}
   * @throws {StateError} if the log is not open
   * @throws {StoreError} if the file cannot be read, or an earlier failure left the log
   *   unusable
   */
  async *read() {
    if (!this.#open) throw new StateError('log is not open');
    while (this.#swap !== null) await this.#swap;
    if (!this.#open) throw new StateError('log is not open');
    // After a failure the committed size is no longer known, so there is no safe range.
    if (this.#failure !== null) throw this.#unusable();

    // No await between the checks above and these two lines: rewrite() relies on that.
    const limit = this.#size;
    this.#readers += 1;
    let handle;
    try {
      handle = await open(this.#path, 'r');
      const chunk = Buffer.allocUnsafe(IO_CHUNK_BYTES);
      let position = 0;
      let corrupt = 0;
      let parts = [];
      let partBytes = 0;
      let oversized = false;

      while (position < limit) {
        const want = Math.min(chunk.length, limit - position);
        const { bytesRead } = await handle.read(chunk, 0, want, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const view = chunk.subarray(0, bytesRead);

        let start = 0;
        for (;;) {
          const newline = view.indexOf(NEWLINE, start);
          if (newline === -1) break;
          const piece = view.subarray(start, newline);
          start = newline + 1;

          let record;
          if (!oversized && partBytes + piece.length <= this.#maxRecordBytes) {
            record = parseLine(parts.length === 0 ? piece : Buffer.concat([...parts, piece]));
          }
          parts = [];
          partBytes = 0;
          oversized = false;
          if (record === undefined) corrupt += 1;
          else yield record;
        }

        if (start < view.length && !oversized) {
          const rest = view.subarray(start);
          if (partBytes + rest.length > this.#maxRecordBytes) {
            // Stop buffering: the rest of this line is skipped up to its newline.
            oversized = true;
            parts = [];
            partBytes = 0;
          } else {
            // Copied because the chunk buffer is overwritten by the next read.
            parts.push(Buffer.from(rest));
            partBytes += rest.length;
          }
        }
      }
      this.#corruptLines = corrupt;
    } catch (cause) {
      throw wrap(cause, `cannot read log ${this.#path}`);
    } finally {
      this.#readers -= 1;
      await handle?.close().catch(() => {});
    }
  }

  /**
   * Replace the whole log with the given records (compaction), atomically.
   *
   * After a crash the file holds either the old log or the new one. `records` may be an
   * async iterable derived from this log's own `read()`, which compacts without holding
   * the log in memory. Appends made meanwhile wait and land in the new file.
   *
   * @param {Iterable<object> | AsyncIterable<object>} records
   * @returns {Promise<void>}
   * @throws {StateError} if the log is not open, or a `read()` is still in progress when
   *   the input has been consumed (the old file cannot be replaced under a reader)
   * @throws {StoreError} if a record is invalid or the write fails; the log is unchanged
   */
  rewrite(records) {
    return this.#enqueue(async () => {
      if (!this.#open) throw new StateError('log is not open');
      if (this.#failure !== null) throw this.#unusable();
      if (typeof records?.[Symbol.asyncIterator] !== 'function'
        && typeof records?.[Symbol.iterator] !== 'function') {
        throw new StoreError('records must be iterable');
      }

      const temp = await writeTemp(this.#path, this.#mode, async (handle) => {
        let parts = [];
        let bytes = 0;
        for await (const record of records) {
          const line = encodeRecord(record, this.#maxRecordBytes);
          parts.push(line);
          bytes += line.length;
          if (bytes >= APPEND_BATCH_BYTES) {
            await handle.writeFile(Buffer.concat(parts, bytes));
            parts = [];
            bytes = 0;
          }
        }
        if (bytes > 0) await handle.writeFile(Buffer.concat(parts, bytes));
      });

      if (this.#readers > 0) {
        await unlink(temp).catch(() => {});
        throw new StateError('cannot rewrite the log while it is being read');
      }

      let release;
      this.#swap = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await this.#syncing;
        const old = this.#handle;
        this.#handle = null;
        try {
          // Windows will not replace a file that is open, so our own handle goes first.
          await old.close();
          await commitTemp(temp, this.#path);
        } catch (cause) {
          await unlink(temp).catch(() => {});
          throw wrap(cause, `cannot rewrite log ${this.#path}`);
        } finally {
          await this.#reopen();
        }
        this.#corruptLines = 0;
      } finally {
        this.#swap = null;
        release();
      }
      if (this.#failure !== null) throw this.#unusable();
    });
  }

  /**
   * Wait until every append made so far is written and, unless fsync is "never", synced.
   *
   * @returns {Promise<void>}
   * @throws {StateError} if the log is not open
   * @throws {StoreError} if a write or fsync failed
   */
  flush() {
    return this.#enqueue(async () => {
      if (!this.#open) throw new StateError('log is not open');
      await this.#settle(this.#handle);
      if (this.#failure !== null) throw this.#unusable();
    });
  }

  /**
   * Flush and close the log. Closing a log that is not open does nothing.
   *
   * @returns {Promise<void>}
   * @throws {StoreError} if the final fsync or the close fails, or an earlier failure
   *   left the log unusable. The file handle is released in every case.
   */
  close() {
    return this.#enqueue(async () => {
      if (!this.#open) return;
      this.#open = false;
      const handle = this.#handle;
      this.#handle = null;
      try {
        await this.#settle(handle);
      } finally {
        try {
          await handle?.close();
        } catch (cause) {
          this.#failure ??= new StoreError(`cannot close log ${this.#path}`, { cause });
        }
      }
      if (this.#failure !== null) throw this.#unusable();
    });
  }

  /**
   * Run `task` after everything queued before it, whether or not that succeeded.
   *
   * Queuing anything closes the current group of appends: an append requested after this
   * task must also run after it, so it may not join a group that runs before it.
   */
  #enqueue(task) {
    this.#group = null;
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => {});
    return result;
  }

  #unusable() {
    return new StoreError(`log ${this.#path} is unusable after a failure; close and reopen it`, {
      cause: this.#failure,
    });
  }

  /**
   * Write one group of appends, split into batches of bounded size.
   *
   * @param {{ line: Buffer, resolve: () => void, reject: (error: Error) => void }[]} group
   */
  async #drain(group) {
    // Appends that arrive while this group is being written start a new one behind it.
    if (this.#group === group) this.#group = null;
    try {
      let next = 0;
      while (next < group.length) {
        let end = next;
        let bytes = 0;
        do {
          bytes += group[end].line.length;
          end += 1;
        } while (end < group.length && bytes < APPEND_BATCH_BYTES);
        await this.#writeBatch(group.slice(next, end), bytes);
        next = end;
      }
    } catch (cause) {
      // Nothing above is expected to throw, but an append must never be left pending.
      // Rejecting an entry that has already been settled does nothing.
      const error = wrap(cause, `cannot append to log ${this.#path}`);
      for (const entry of group) entry.reject(error);
    }
  }

  /** Commit a group of appends with a single write, then settle each of them. */
  async #writeBatch(batch, bytes) {
    const fail = (error) => {
      for (const entry of batch) entry.reject(error);
    };
    if (!this.#open) {
      // close() was requested before this append was.
      fail(new StateError('log is not open'));
      return;
    }
    if (this.#failure !== null) {
      fail(this.#unusable());
      return;
    }

    const data = batch.length === 1 ? batch[0].line : Buffer.concat(batch.map((entry) => entry.line), bytes);
    try {
      await writeFully(this.#handle, data, this.#size);
    } catch (cause) {
      const error = new StoreError(`cannot append to log ${this.#path}`, { cause });
      try {
        // Remove whatever part of the batch reached the file, or the next record would
        // be glued to the fragment and both would be lost.
        await this.#handle.truncate(this.#size);
      } catch {
        this.#failure = error;
      }
      fail(error);
      return;
    }
    this.#size += data.length;
    this.#appended += batch.length;

    if (this.#fsync === 'always') {
      try {
        await this.#handle.sync();
        this.#syncs += 1;
      } catch (cause) {
        // After a failed fsync the kernel may have dropped the data: nothing written
        // through this handle can be trusted any more.
        this.#failure = new StoreError(`cannot fsync log ${this.#path}`, { cause });
        fail(this.#failure);
        return;
      }
    } else if (this.#fsync === 'batch') {
      this.#unsynced = true;
      this.#startSync();
    }
    for (const entry of batch) entry.resolve();
  }

  /** Background fsync for "batch" mode: one at a time, repeated while data keeps coming. */
  #startSync() {
    if (this.#syncing !== null) return;
    this.#syncing = (async () => {
      try {
        while (this.#unsynced && this.#handle !== null) {
          this.#unsynced = false;
          await this.#handle.sync();
          this.#syncs += 1;
        }
      } catch (cause) {
        this.#failure ??= new StoreError(`cannot fsync log ${this.#path}`, { cause });
      } finally {
        this.#syncing = null;
      }
    })();
  }

  /** Wait for the background fsync and cover anything it has not. Never throws. */
  async #settle(handle) {
    await this.#syncing;
    if (!this.#unsynced || handle === null || this.#fsync === 'never') return;
    try {
      this.#unsynced = false;
      await handle.sync();
      this.#syncs += 1;
    } catch (cause) {
      this.#failure ??= new StoreError(`cannot fsync log ${this.#path}`, { cause });
    }
  }

  /** Reacquire the append handle after rewrite() released it. */
  async #reopen() {
    try {
      const handle = await open(this.#path, constants.O_RDWR | constants.O_CREAT, this.#mode);
      try {
        this.#size = (await handle.stat()).size;
      } catch (cause) {
        await handle.close().catch(() => {});
        throw cause;
      }
      this.#handle = handle;
      this.#unsynced = false;
    } catch (cause) {
      this.#failure ??= new StoreError(`cannot reopen log ${this.#path}`, { cause });
    }
  }
}

/**
 * Write a new temporary file next to `target` and flush it to stable storage.
 *
 * @param {string} target
 * @param {number} mode
 * @param {(handle: import('node:fs/promises').FileHandle) => Promise<unknown>} fill
 * @returns {Promise<string>} path of the closed temporary file
 */
async function writeTemp(target, mode, fill) {
  // Same directory as the target: rename() is only atomic within one file system.
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
    await fill(handle);
    await handle.sync();
    const closing = handle;
    handle = undefined;
    await closing.close();
  } catch (cause) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw wrap(cause, `cannot write ${target}`);
  }
  return temp;
}

/** Rename a finished temporary file over its target and make the rename durable. */
async function commitTemp(temp, target, hooks = {}) {
  try {
    await renameWithRetry(temp, target, hooks);
  } catch (cause) {
    await unlink(temp).catch(() => {});
    throw cause;
  }
  await syncDir(dirname(target));
}

/**
 * Flush a directory entry change (a rename or a create) to stable storage.
 *
 * Best effort by design: Windows cannot open a directory for this, some file systems
 * refuse it, and by the time it runs the change itself has already succeeded, so
 * reporting a failure here would describe a write that did happen as one that did not.
 */
async function syncDir(dir) {
  if (IS_WINDOWS) return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // See above.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @returns {Promise<number>} offset just past the last newline in the first `size` bytes */
async function committedEnd(handle, size) {
  const chunk = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(size, 1)));
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const length = end - start;
    await readFully(handle, chunk, length, start);
    const newline = chunk.subarray(0, length).lastIndexOf(NEWLINE);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function readFully(handle, buffer, length, position) {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new StoreError('file changed size while it was being read');
    done += bytesRead;
  }
}

async function writeFully(handle, data, position) {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, position + done);
    // A write that makes no progress would otherwise spin here forever.
    if (bytesWritten <= 0) throw new StoreError('write made no progress');
    done += bytesWritten;
  }
}

/**
 * Read a whole file through an open handle, refusing to read more than `maxBytes`.
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} maxBytes
 * @returns {Promise<Buffer | undefined>} the content, or undefined if it exceeds maxBytes
 */
export async function readAtMost(handle, maxBytes) {
  requirePositiveInteger(maxBytes, 'maxBytes');
  const parts = [];
  let total = 0;
  for (;;) {
    // Read in chunks, so a limit far above the real size costs no memory up front.
    const chunk = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(parts, total);
    parts.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return undefined;
  }
}

/** @returns {Buffer} the record as one newline-terminated line */
function encodeRecord(record, maxBytes) {
  // Plain objects only: JSON.stringify writes a Map, a Set or most class instances as
  // "{}", which would store an empty record and report success.
  if (!isPlainObject(record)) throw new StoreError('a log record must be a plain JSON object');
  let text;
  try {
    text = JSON.stringify(record);
  } catch (cause) {
    throw new StoreError('log record cannot be serialized as JSON', { cause });
  }
  // A toJSON method can turn an object into any other JSON value, or into nothing.
  if (typeof text !== 'string' || !text.startsWith('{')) {
    throw new StoreError('a log record must be a JSON object');
  }
  const line = Buffer.from(`${text}\n`, 'utf8');
  if (line.length - 1 > maxBytes) {
    throw new StoreError(`log record exceeds ${maxBytes} bytes`);
  }
  return line;
}

/** @returns {object | undefined} undefined when the line is not a JSON object */
function parseLine(line) {
  try {
    const value = JSON.parse(utf8.decode(line));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isJsonObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(data) {
  let text;
  try {
    text = JSON.stringify(data);
  } catch (cause) {
    throw new StoreError('state cannot be serialized as JSON', { cause });
  }
  if (typeof text !== 'string') throw new StoreError('state cannot be serialized as JSON');
  return `${text}\n`;
}

function cloneDefaults(defaults) {
  if (defaults === undefined) throw new StoreError('defaults are required');
  let copy;
  try {
    copy = structuredClone(defaults);
  } catch (cause) {
    throw new StoreError('defaults must be a plain JSON value', { cause });
  }
  // Fails here, at construction, rather than at the first save.
  serialize(copy);
  return copy;
}

/** Compact UTC time that is legal in a file name on every platform, e.g. 20260131T235959123Z. */
function timestamp(ms) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    throw new StoreError('clock returned an invalid time');
  }
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function wrap(cause, message) {
  return cause instanceof ClawNetError ? cause : new StoreError(message, { cause });
}

function requirePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new StoreError('path must be a non-empty string');
  }
}

function requireMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new StoreError('mode must be an integer between 0 and 0o777');
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StoreError(`${name} must be a positive integer`);
  }
}

function requireOptionalFunction(value, name) {
  if (value !== undefined && typeof value !== 'function') {
    throw new StoreError(`${name} must be a function`);
  }
}
