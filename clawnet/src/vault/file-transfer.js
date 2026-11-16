/**
 * ClawVault file transfer (ARCHITECTURE.md 8.2, DESIGN.md sections 11 and 15.26).
 *
 * One node sends a file to another. The offer, the acceptance and the verdicts are sealed
 * messages (scheme 1); the chunks are scheme-2 packets sealed under a random transfer key
 * that travelled in the offer. Where ARCHITECTURE.md 8.2 and DESIGN.md section 15 differ,
 * section 15 wins and the differences are these:
 *
 *   - Item 26, chunk hashes. The sender hashes every chunk when it prepares the offer and
 *     keeps those hashes (16 bytes each, sealed on disk). Before it seals a chunk it reads
 *     the chunk again and compares: a chunk that no longer matches aborts the transfer with
 *     `source-changed`. The nonce of a chunk is its index, so one key must never seal two
 *     different plaintexts; the stored hashes make that a checked invariant, also across a
 *     restart of the sender. A new `send()` of the same file is a new transfer with a new key.
 *   - Item 26, credit. Flow control is receiver-driven: every acknowledgement carries a
 *     cumulative base (every chunk below it is held), the held ranges above it and a credit
 *     window `win`. The sender may have chunk `i` in flight only if `i < base + win`. The
 *     window starts at 4, grows by one with every acknowledgement that advances the base,
 *     is halved when the receiver sees a hole persist while later chunks arrive (or when
 *     nothing arrives for a stall interval) and never exceeds `files.window`. `win` is a
 *     field that `ARCHITECTURE.md` 4.3 does not list for `file-accept` and `file-sack`.
 *   - Acknowledgements go out after min(8, ceil(win / 2)) new chunks and not only after 8,
 *     because a window of 4 would otherwise wait for the timer on every round.
 *
 * Everything from the network is validated and fails closed; memory per transfer is bounded
 * by the chunk count (at most `MAX_CHUNKS`, so a 1 MiB bitmap and 16 MiB of chunk hashes),
 * writes are bounded by `MAX_PENDING_WRITES` per transfer, and a file name never reaches
 * the file system before `sanitizeFileName` and a containment check have run.
 */

import { createHash } from 'node:crypto';
import { link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ConfigError, StateError, StoreError } from '../core/errors.js';
import { openChunk, peekChunk, sealChunk } from '../core/crypto/envelope.js';
import { base64Decode, base64Encode, randomBytes } from '../core/crypto/primitives.js';
import { Limits, NODE_ID_PATTERN, PacketType } from '../core/wire/types.js';

/** Most chunks one transfer may have; with 1 bit each the receiver's bitmap is 128 KiB. */
export const MAX_CHUNKS = 1 << 20;

/** Most `[from, to]` ranges one acknowledgement carries. */
export const SACK_MAX_RANGES = 64;

/** Acknowledge after this many new chunks at the latest (see the file comment). */
export const SACK_EVERY = 8;

/** The credit window a transfer starts with. */
export const INITIAL_WINDOW = 4;

/** Largest plaintext of one chunk that fits a routed packet (ARCHITECTURE.md 4.3 and config.js). */
export const MAX_CHUNK_BYTES = Limits.MAX_ROUTED_PACKET - 16 * 1024;

/**
 * How long an incoming offer may wait for a decision before it is declined. It holds one of
 * the few pending-offer slots, so a slot must not be held for the message lifetime by
 * someone who will never be answered.
 */
export const DEFAULT_OFFER_TTL_MS = 24 * 3_600_000;

/** The upper bound an offer's `chunk` may name (ARCHITECTURE.md 8.2). */
export const MAX_OFFERED_CHUNK = 1032192;

const TID_PATTERN = /^[0-9a-f]{32}$/;
const KEY_BYTES = 32;
const HASH_BYTES = 32;
const CHUNK_HASH_BYTES = 16;
const MAX_NAME_BYTES = 255;
const MAX_STORED_NAME_BYTES = 200;
const MAX_PATH_CHARS = 4096;
// A sack only describes chunks this far above its base: held chunks lie within the window.
const SACK_SPAN = 2048;
const MAX_WINDOW = 1024;
const MAX_PENDING_WRITES = 256;
const PERSIST_EVERY_CHUNKS = 64;
const PERSIST_EVERY_MS = 1000;
const PROGRESS_EVENT_MS = 250;
const RATE_WINDOW_MS = 5000;
const LOSS_ARRIVALS = 3;
const STALLS_BEFORE_PAUSE = 3;
const READ_BLOCK = 256 * 1024;
const MAX_UNIQUE_ATTEMPTS = 10000;
// Replies to offers that are not valid, per peer and minute: nothing else answers a hostile peer.
const REJECT_REPLIES_PER_MIN = 20;
const MAX_REJECT_PEERS = 256;

const TERMINAL = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const REJECT_REASONS = new Set(['denied', 'busy', 'too-large', 'invalid']);
const CANCEL_REASONS = new Set(['user', 'source-changed', 'io', 'expired']);
const DONE_FAILURES = new Set(['hash', 'io']);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV', 'EMLINK', 'EINVAL', 'EACCES']);
// Characters Windows forbids in names, written out so that the source holds no invisible ones.
const WINDOWS_FORBIDDEN = new Set('<>:"|?*');
// Bidirectional marks and overrides, which make a name read differently from how it is
// spelled, and the line and paragraph separators.
const FORMAT_FORBIDDEN = new Set([0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const KINDS = Object.freeze(['file-offer', 'file-accept', 'file-reject', 'file-sack', 'file-done', 'file-cancel']);

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const utf8Length = (text) => Buffer.byteLength(text, 'utf8');
const isInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Control characters (C0, DEL and C1), what Windows forbids, and the characters that disguise a name. */
function isForbiddenInName(character) {
  const code = character.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || WINDOWS_FORBIDDEN.has(character) || FORMAT_FORBIDDEN.has(code);
}

/** Cut `text` to at most `bytes` UTF-8 bytes without splitting a character. */
function cutUtf8(text, bytes) {
  if (utf8Length(text) <= bytes) return text;
  let out = '';
  let used = 0;
  for (const character of text) {
    const size = utf8Length(character);
    if (used + size > bytes) break;
    out += character;
    used += size;
  }
  return out;
}

/** Split a sanitised name into stem and extension; a leading dot is not an extension. */
function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || utf8Length(name) - utf8Length(name.slice(0, dot)) > 32) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * Make a file name offered by a peer safe to use as a name in the downloads directory
 * (ARCHITECTURE.md 8.2): only the part after the last `/` or `\`, no control characters or
 * characters Windows forbids, no leading or trailing spaces and dots, a Windows device name
 * prefixed with `_`, at most 200 UTF-8 bytes with the extension kept, and `file` when
 * nothing is left.
 *
 * @param {unknown} name
 * @returns {string} a non-empty name without a path separator
 */
export function sanitizeFileName(name) {
  let text = typeof name === 'string' ? name.toWellFormed() : '';
  text = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1);
  text = [...text].filter((character) => !isForbiddenInName(character)).join('').replace(/^[ .]+|[ .]+$/g, '');
  if (text === '') return 'file';
  const firstDot = text.indexOf('.');
  const stem = firstDot === -1 ? text : text.slice(0, firstDot);
  if (WINDOWS_DEVICE.test(stem.trim())) text = `_${text}`;
  if (utf8Length(text) > MAX_STORED_NAME_BYTES) {
    const [base, extension] = splitExtension(text);
    text = cutUtf8(base, MAX_STORED_NAME_BYTES - utf8Length(extension)) + extension;
    text = text.replace(/[ .]+$/g, '');
    if (text === '') return 'file';
  }
  return text;
}

/** `report.pdf` attempt 2 is `report (2).pdf`; attempt 0 is the name itself. */
function uniqueName(name, attempt) {
  if (attempt === 0) return name;
  const [stem, extension] = splitExtension(name);
  return `${stem} (${attempt})${extension}`;
}

function packBits(states, chunks) {
  const out = Buffer.alloc(Math.ceil(chunks / 8));
  for (let i = 0; i < chunks; i += 1) if (states[i] === 2) out[i >> 3] |= 1 << (i & 7);
  return out;
}

function unpackBits(bytes, chunks) {
  if (bytes.length !== Math.ceil(chunks / 8)) return null;
  const states = new Uint8Array(chunks);
  for (let i = 0; i < chunks; i += 1) if ((bytes[i >> 3] >> (i & 7)) & 1) states[i] = 2;
  return states;
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
  return value;
}

function stateError(token, message, extra) {
  return Object.assign(new StateError(`${token}: ${message}`), extra);
}

/** Validate a `ranges` value: ascending, disjoint, above `base`, inside the file and the span. */
function parseRanges(value, base, chunks) {
  if (!Array.isArray(value) || value.length > SACK_MAX_RANGES) return null;
  let previousEnd = base;
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [from, to] = range;
    if (!isInteger(from, 0, chunks - 1) || !isInteger(to, 0, chunks - 1)) return null;
    if (from <= previousEnd || to < from || to - base >= SACK_SPAN) return null;
    previousEnd = to;
  }
  return value;
}

/** Validate the progress fields every `file-accept` and `file-sack` carries. */
function parseProgress(meta, chunks) {
  if (!isInteger(meta.base, 0, chunks)) return null;
  if (meta.win !== undefined && !isInteger(meta.win, 1, MAX_WINDOW)) return null;
  const ranges = parseRanges(meta.ranges, meta.base, chunks);
  if (ranges === null) return null;
  return { base: meta.base, ranges, win: meta.win ?? INITIAL_WINDOW };
}

/** The structure of the `transfers` document; one that fails it is set aside by storage. */
function validTransfersDoc(value) {
  if (!isPlainObject(value) || value.v !== 1 || !Array.isArray(value.transfers)) return false;
  return value.transfers.every(
    (record) =>
      isPlainObject(record) &&
      typeof record.id === 'string' &&
      TID_PATTERN.test(record.id) &&
      (record.direction === 'send' || record.direction === 'receive') &&
      typeof record.peer === 'string' &&
      NODE_ID_PATTERN.test(record.peer) &&
      typeof record.name === 'string' &&
      Number.isSafeInteger(record.size) &&
      record.size >= 0 &&
      (record.sha256 === null || typeof record.sha256 === 'string') &&
      isInteger(record.chunk, 1, MAX_OFFERED_CHUNK) &&
      isInteger(record.chunks, 0, MAX_CHUNKS) &&
      typeof record.state === 'string' &&
      Number.isSafeInteger(record.createdAt) &&
      Number.isSafeInteger(record.updatedAt) &&
      (record.path === null || typeof record.path === 'string') &&
      (record.error === null || typeof record.error === 'string') &&
      typeof record.key === 'string' &&
      (record.part === null || typeof record.part === 'string') &&
      typeof record.queued === 'boolean',
  );
}

/**
 * Create the file transfer service (service name `files`).
 *
 * @param {object} [options]
 * @param {number} [options.maxActive=8] transfers running at once per direction; further
 *   accepted ones wait in `paused`
 * @param {number} [options.maxPendingOffers=64] incoming offers waiting for a decision or a
 *   slot, over all peers; more are refused with `busy`
 * @param {number} [options.maxPendingPerPeer=8] the same, per peer
 * @param {number} [options.keep=200] finished transfers that stay listed
 * @param {number} [options.offerTtlMs=DEFAULT_OFFER_TTL_MS] how long an incoming offer may
 *   wait for a decision; after that it is declined as `denied`
 * @returns {object} a Service (ARCHITECTURE.md section 6); `api` offers `send`, `list`,
 *   `get`, `accept`, `reject` and `cancel`
 * @throws {ConfigError} if an option is not a positive integer
 */
export function createFileTransferService({ maxActive = 8, maxPendingOffers = 64, maxPendingPerPeer = 8, keep = 200, offerTtlMs = DEFAULT_OFFER_TTL_MS } = {}) {
  requireCount(maxActive, 'maxActive');
  requireCount(maxPendingOffers, 'maxPendingOffers');
  requireCount(maxPendingPerPeer, 'maxPendingPerPeer');
  requireCount(offerTtlMs, 'offerTtlMs');
  requireCount(keep, 'keep');

  let ctx = null;
  let running = false;
  let doc = null;
  let bitmapBlobs = null;
  let hashBlobs = null;
  let downloadsDir = '';
  let files = null;
  let timers = null;
  let limits = null;
  let sackDelayMs = 0;
  let cancelEvery = null;
  let cancelRoutes = null;
  /** tid -> transfer */
  const transfers = new Map();
  /** peer -> { count, resetAt } of replies sent to invalid offers */
  const rejectReplies = new Map();
  const counters = {
    offersIn: 0,
    offersOut: 0,
    completedIn: 0,
    completedOut: 0,
    failed: 0,
    chunksSent: 0,
    chunksResent: 0,
    chunksReceived: 0,
    chunksDuplicate: 0,
    chunksRejected: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };

  // ------------------------------------------------------------------ small helpers

  const now = () => ctx.now();
  const chunkLength = (t, index) => (index === t.chunks - 1 ? t.size - index * t.chunk : t.chunk);
  const stallInterval = (stalls) => Math.min(timers.retransmitMaxMs, timers.retransmitMinMs * 2 ** Math.min(stalls, 20));
  const isActive = (t) => !TERMINAL.has(t.state);

  function newRuntime(t) {
    return {
      handle: null,
      // Sender: 0 unknown, 2 held by the receiver. Receiver: 0 absent, 1 being written, 2 written.
      states: new Uint8Array(TERMINAL.has(t.state) ? 0 : t.chunks),
      held: 0,
      base: 0,
      // Receiver only: lowest index that has not arrived (written or being written); the
      // sender's `base` is the same idea from the other side.
      seenBase: 0,
      win: INITIAL_WINDOW,
      hashes: null,
      sentOnce: null,
      inflight: new Map(),
      highestHeld: -1,
      stalls: 0,
      lastSackAt: now(),
      lastChunkAt: now(),
      pumping: false,
      pumpAgain: false,
      blocked: false,
      blockedUntil: 0,
      needOffer: false,
      needAccept: false,
      controlRetryAt: 0,
      offerMessage: null,
      acceptMessage: null,
      pendingWrites: 0,
      unreported: 0,
      firstUnreportedAt: 0,
      aboveBase: 0,
      received: 0,
      lossUntil: 0,
      lastBaseAtSack: 0,
      dirty: 0,
      lastPersistAt: now(),
      persisting: Promise.resolve(),
      verifying: false,
      activating: false,
      aborted: false,
      lastProgressEmit: 0,
      samples: [],
    };
  }

  function toRecord(t) {
    return {
      id: t.id,
      direction: t.direction,
      peer: t.peer,
      name: t.name,
      size: t.size,
      sha256: t.sha256,
      chunk: t.chunk,
      chunks: t.chunks,
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      path: t.path,
      error: t.error,
      key: base64Encode(t.key),
      part: t.part,
      queued: t.queued,
    };
  }

  function persist() {
    doc.update((data) => {
      data.transfers = [...transfers.values()].map(toRecord);
    });
  }

  function bytesDone(t) {
    const { held, states } = t.rt;
    if (held === 0) return 0;
    const hasLast = t.chunks > 0 && states[t.chunks - 1] === 2;
    return hasLast ? (held - 1) * t.chunk + chunkLength(t, t.chunks - 1) : held * t.chunk;
  }

  function rateOf(t) {
    const { samples } = t.rt;
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    return last[0] > first[0] ? ((last[1] - first[1]) * 1000) / (last[0] - first[0]) : 0;
  }

  function view(t) {
    const done = t.state === 'completed' ? t.size : bytesDone(t);
    return {
      id: t.id,
      direction: t.direction,
      peer: t.peer,
      name: t.name,
      size: t.size,
      sha256: t.sha256,
      chunkSize: t.chunk,
      chunks: t.chunks,
      state: t.state,
      bytesDone: done,
      chunksDone: t.state === 'completed' ? t.chunks : t.rt.held,
      rateBps: TERMINAL.has(t.state) ? 0 : rateOf(t),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      path: t.path,
      error: t.error,
    };
  }

  function touch(t) {
    t.updatedAt = now();
  }

  function sample(t) {
    const at = now();
    const { samples } = t.rt;
    samples.push([at, bytesDone(t)]);
    while (samples.length > 2 && at - samples[0][0] > RATE_WINDOW_MS) samples.shift();
  }

  function emitProgress(t, force = false) {
    const at = now();
    if (!force && at - t.rt.lastProgressEmit < PROGRESS_EVENT_MS) return;
    t.rt.lastProgressEmit = at;
    const done = bytesDone(t);
    ctx.events.emit('file.progress', {
      id: t.id,
      direction: t.direction,
      bytesDone: done,
      size: t.size,
      chunksDone: t.rt.held,
      chunks: t.chunks,
      rateBps: rateOf(t),
    });
  }

  function setState(t, state, { error } = {}) {
    t.state = state;
    if (error !== undefined) t.error = error;
    touch(t);
    persist();
  }

  async function sendControl(t, kind, meta, { reliable = true } = {}) {
    try {
      const sent = await ctx.messaging.send(t.peer, { kind, meta: { tid: t.id, ...meta }, reliable });
      return sent?.id ?? null;
    } catch (error) {
      ctx.log.debug('file control message not sent', { kind, error: String(error?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  const messagePending = (id) => id !== null && ctx.messaging.get(id) != null;

  function lockedCount(direction, states) {
    let count = 0;
    // A transfer that is still opening its part file already holds its slot.
    for (const t of transfers.values()) if (t.direction === direction && !t.queued && isActive(t) && (states.includes(t.state) || t.rt.activating)) count += 1;
    return count;
  }

  // ------------------------------------------------------------------ ending a transfer

  async function closeHandle(t) {
    const { handle } = t.rt;
    t.rt.handle = null;
    if (handle !== null) await handle.close().catch(() => {});
  }

  async function dropBlobs(t) {
    await bitmapBlobs.delete(t.id).catch(() => {});
    await hashBlobs.delete(t.id).catch(() => {});
  }

  function pruneFinished() {
    const finished = [...transfers.values()].filter((t) => TERMINAL.has(t.state)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of finished.slice(keep)) {
      transfers.delete(old.id);
      void dropBlobs(old);
    }
  }

  /**
   * Move a transfer to a final state, release what it holds and report it. Idempotent for
   * transfers that already ended.
   */
  async function finish(t, state, { error = null, removePart = false, event } = {}) {
    if (TERMINAL.has(t.state)) return;
    t.rt.aborted = true;
    setState(t, state, { error });
    if (state === 'failed') counters.failed += 1;
    t.rt.inflight.clear();
    await closeHandle(t);
    if (removePart && t.part !== null) await unlink(join(downloadsDir, t.part)).catch(() => {});
    await dropBlobs(t);
    ctx.events.emit(event ?? `file.${state}`, { transfer: view(t) });
    t.rt.states = new Uint8Array(0);
    t.rt.hashes = null;
    t.rt.sentOnce = null;
    pruneFinished();
    persist();
    promoteWaiting();
  }

  function promoteWaiting() {
    if (!running) return;
    for (const t of transfers.values()) {
      if (!t.queued || !isActive(t)) continue;
      const direction = t.direction;
      const busy = lockedCount(direction, direction === 'receive' ? ['receiving'] : ['sending']);
      if (busy >= maxActive) return;
      t.queued = false;
      if (direction === 'receive') void activateReceive(t);
      else resumeSend(t);
    }
  }

  // ------------------------------------------------------------------ sending

  function sourceChanged(t) {
    if (t.rt.aborted) return;
    void finish(t, 'failed', { error: 'source-changed' });
    void sendControl(t, 'file-cancel', { reason: 'source-changed' });
  }

  function ioFailure(t, error) {
    ctx.log.warn('file transfer I/O failed', { id: t.id, error: String(error?.message ?? error).slice(0, 200) });
    void finish(t, 'failed', { error: 'io', removePart: t.direction === 'receive' });
    void sendControl(t, t.direction === 'send' ? 'file-cancel' : 'file-done', t.direction === 'send' ? { reason: 'io' } : { ok: false, reason: 'io' });
  }

  /** Hash the file once: the whole-file digest of the offer and a digest of every chunk. */
  async function prepare(t) {
    const { rt } = t;
    let handle = null;
    try {
      handle = await open(t.path, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size !== t.size) throw stateError('source-changed', 'the source changed while it was being prepared');
      const whole = createHash('sha256');
      const hashes = Buffer.alloc(t.chunks * CHUNK_HASH_BYTES);
      const block = Buffer.alloc(t.chunk);
      for (let index = 0; index < t.chunks; index += 1) {
        if (rt.aborted || !running) return;
        const length = chunkLength(t, index);
        const { bytesRead } = await handle.read(block, 0, length, index * t.chunk);
        if (bytesRead !== length) throw stateError('source-changed', 'the source is shorter than it was');
        const piece = block.subarray(0, length);
        whole.update(piece);
        sha256(piece).copy(hashes, index * CHUNK_HASH_BYTES, 0, CHUNK_HASH_BYTES);
      }
      const { size } = await handle.stat();
      if (size !== t.size) throw stateError('source-changed', 'the source changed while it was being prepared');
      if (rt.aborted || !running) return;
      t.sha256 = base64Encode(whole.digest());
      rt.hashes = hashes;
      await hashBlobs.put(t.id, hashes);
      if (rt.aborted || !running) return;
      setState(t, 'offered');
      counters.offersOut += 1;
      await sendOffer(t);
      ctx.events.emit('file.offered', { transfer: view(t) });
    } catch (error) {
      if (rt.aborted || !running) return;
      if (error instanceof StateError && error.message.startsWith('source-changed:')) sourceChanged(t);
      else ioFailure(t, error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function sendOffer(t) {
    const id = await sendControl(t, 'file-offer', {
      name: t.name,
      size: t.size,
      sha256: t.sha256,
      chunk: t.chunk,
      key: base64Encode(t.key),
    });
    t.rt.needOffer = id === null;
    t.rt.offerMessage = id;
    t.rt.controlRetryAt = now() + timers.retransmitMinMs;
  }

  /** Read chunk `index` again and seal it; throws `source-changed` if it is not what was hashed. */
  async function sealIndex(t, index) {
    const { rt } = t;
    if (rt.handle === null) {
      try {
        rt.handle = await open(t.path, 'r');
      } catch {
        throw stateError('source-changed', 'the source cannot be opened');
      }
    }
    const { handle } = rt;
    const info = await handle.stat();
    if (info.size !== t.size) throw stateError('source-changed', 'the source changed size');
    const length = chunkLength(t, index);
    const plaintext = Buffer.alloc(length);
    const { bytesRead } = await handle.read(plaintext, 0, length, index * t.chunk);
    if (bytesRead !== length) throw stateError('source-changed', 'the source is shorter than it was');
    const expected = rt.hashes.subarray(index * CHUNK_HASH_BYTES, (index + 1) * CHUNK_HASH_BYTES);
    if (!sha256(plaintext).subarray(0, CHUNK_HASH_BYTES).equals(expected)) {
      throw stateError('source-changed', 'a chunk no longer matches the hash recorded with the offer');
    }
    return sealChunk({ key: t.key, transferId: Buffer.from(t.id, 'hex'), index, plaintext });
  }

  async function pump(t) {
    const { rt } = t;
    if (rt.pumping) {
      rt.pumpAgain = true;
      return;
    }
    rt.pumping = true;
    try {
      do {
        rt.pumpAgain = false;
        await pumpOnce(t);
      } while (rt.pumpAgain && t.state === 'sending' && running);
    } catch (error) {
      if (rt.aborted || !running) return;
      if (error instanceof StateError && error.message.startsWith('source-changed:')) sourceChanged(t);
      else ioFailure(t, error);
    } finally {
      rt.pumping = false;
    }
  }

  async function pumpOnce(t) {
    const { rt } = t;
    while (t.state === 'sending' && running) {
      const limit = Math.min(rt.win, files.window);
      let next = -1;
      for (let i = rt.base; i < t.chunks && i < rt.base + limit; i += 1) {
        if (rt.states[i] !== 2 && !rt.inflight.has(i)) {
          next = i;
          break;
        }
      }
      if (next === -1) return;
      const body = await sealIndex(t, next);
      if (t.state !== 'sending' || !running) return;
      if (rt.states[next] === 2) continue;
      const result = ctx.packets.originate({
        type: PacketType.DATA,
        header: { id: randomBytes(16).toString('hex'), dst: t.peer, ttl: limits.ttl, try: 0 },
        body,
      });
      if (!result.ok) {
        rt.blocked = true;
        rt.blockedUntil = now() + Math.max(1, Math.floor(timers.retransmitMinMs / 4));
        return;
      }
      rt.blocked = false;
      rt.inflight.set(next, now());
      if (rt.sentOnce[next] === 1) counters.chunksResent += 1;
      rt.sentOnce[next] = 1;
      counters.chunksSent += 1;
      counters.bytesSent += chunkLength(t, next);
    }
  }

  /** Replace (`reset`) or extend (sack) what the receiver is known to hold. */
  function applyProgress(t, progress, { reset }) {
    const { rt } = t;
    if (reset) {
      rt.states.fill(0);
      rt.held = 0;
      rt.base = 0;
      rt.highestHeld = -1;
      rt.inflight.clear();
    }
    const mark = (index) => {
      if (rt.states[index] === 2) return;
      rt.states[index] = 2;
      rt.held += 1;
      rt.highestHeld = Math.max(rt.highestHeld, index);
      rt.inflight.delete(index);
    };
    for (let i = rt.base; i < progress.base; i += 1) mark(i);
    for (const [from, to] of progress.ranges) for (let i = from; i <= to; i += 1) mark(i);
    while (rt.base < t.chunks && rt.states[rt.base] === 2) rt.base += 1;
    rt.win = Math.min(progress.win, files.window);
    // A chunk below the highest one held that was sent long enough ago is presumed lost.
    const horizon = now() - timers.retransmitMinMs / 2;
    for (const [index, sentAt] of rt.inflight) if (index < rt.highestHeld && sentAt <= horizon) rt.inflight.delete(index);
  }

  function resumeSend(t) {
    const { rt } = t;
    if (t.state === 'paused') {
      setState(t, 'sending');
      ctx.events.emit('file.resumed', { id: t.id });
    }
    rt.stalls = 0;
    rt.lastSackAt = now();
    void pump(t);
  }

  function onAccept(t, meta, from) {
    if (from !== t.peer || t.direction !== 'send' || !isActive(t) || t.state === 'preparing') return;
    const progress = parseProgress(meta, t.chunks);
    if (progress === null) return;
    const { rt } = t;
    const wasOffered = t.state === 'offered';
    applyProgress(t, progress, { reset: true });
    rt.needOffer = false;
    touch(t);
    sample(t);
    if (t.state !== 'sending' && lockedCount('send', ['sending']) >= maxActive) {
      // Every slot is taken: the receiver waits, and a finishing transfer promotes this one.
      t.queued = true;
      setState(t, 'paused');
      if (wasOffered) ctx.events.emit('file.accepted', { transfer: view(t) });
      ctx.events.emit('file.paused', { id: t.id, reason: 'waiting-for-slot' });
      return;
    }
    t.queued = false;
    if (wasOffered) {
      setState(t, 'sending');
      ctx.events.emit('file.accepted', { transfer: view(t) });
      rt.stalls = 0;
      rt.lastSackAt = now();
      void pump(t);
    } else {
      resumeSend(t);
    }
    emitProgress(t, true);
  }

  function onSack(t, meta, from) {
    if (from !== t.peer || t.direction !== 'send' || (t.state !== 'sending' && t.state !== 'paused')) return;
    const progress = parseProgress(meta, t.chunks);
    if (progress === null) return;
    const before = t.rt.held;
    applyProgress(t, progress, { reset: false });
    if (t.rt.held !== before) {
      touch(t);
      sample(t);
      emitProgress(t);
    }
    if (t.state === 'paused' && !t.queued) resumeSend(t);
    t.rt.stalls = 0;
    t.rt.lastSackAt = now();
    t.rt.blocked = false;
    void pump(t);
  }

  function onDone(t, meta, from) {
    if (from !== t.peer || t.direction !== 'send' || !isActive(t) || typeof meta.ok !== 'boolean') return;
    if (meta.ok) {
      t.rt.held = t.chunks;
      counters.completedOut += 1;
      void finish(t, 'completed');
    } else if (typeof meta.reason === 'string' && DONE_FAILURES.has(meta.reason)) {
      void finish(t, 'failed', { error: meta.reason });
    }
  }

  function onReject(t, meta, from) {
    if (from !== t.peer || t.direction !== 'send' || !isActive(t) || !REJECT_REASONS.has(meta.reason)) return;
    void finish(t, 'rejected', { error: meta.reason });
  }

  function onCancel(t, meta, from) {
    if (from !== t.peer || !isActive(t) || !CANCEL_REASONS.has(meta.reason)) return;
    const failed = meta.reason !== 'user';
    void finish(t, failed ? 'failed' : 'cancelled', { error: meta.reason, removePart: t.direction === 'receive' });
  }

  // ------------------------------------------------------------------ receiving

  /**
   * The progress fields of `file-accept` and `file-sack`: what is held, and the credit.
   * A chunk counts from the moment it arrives and authenticates, before its write has
   * finished: writes finish in any order, and reporting them as holes would make the
   * sender send chunks that are already here. A write that fails fails the transfer.
   */
  function progressMeta(t) {
    const { rt } = t;
    const ranges = [];
    const limit = Math.min(t.chunks, rt.seenBase + SACK_SPAN);
    let i = rt.seenBase + 1;
    while (i < limit && ranges.length < SACK_MAX_RANGES) {
      while (i < limit && rt.states[i] === 0) i += 1;
      if (i >= limit) break;
      const from = i;
      while (i < limit && rt.states[i] !== 0) i += 1;
      ranges.push([from, i - 1]);
    }
    return { base: rt.seenBase, ranges, win: rt.win };
  }

  function sendSack(t) {
    const { rt } = t;
    if (rt.seenBase > rt.lastBaseAtSack) rt.win = Math.min(files.window, rt.win + 1);
    rt.lastBaseAtSack = rt.seenBase;
    rt.unreported = 0;
    rt.firstUnreportedAt = 0;
    rt.lastSackAt = now();
    void sendControl(t, 'file-sack', progressMeta(t), { reliable: false });
  }

  async function sendAccept(t) {
    const id = await sendControl(t, 'file-accept', progressMeta(t));
    t.rt.needAccept = id === null;
    t.rt.acceptMessage = id;
    t.rt.controlRetryAt = now() + timers.retransmitMinMs;
  }

  function ackEvery(t) {
    return Math.min(SACK_EVERY, Math.max(1, Math.ceil(t.rt.win / 2)));
  }

  /** Open (or create) the part file, load what it holds, and tell the sender. */
  async function activateReceive(t) {
    const { rt } = t;
    if (rt.activating) return;
    rt.activating = true;
    try {
      await mkdir(downloadsDir, { recursive: true });
      if (t.part === null) {
        t.part = `${sanitizeFileName(t.name)}.${t.id.slice(0, 8)}.part`;
        rt.handle = await open(join(downloadsDir, t.part), 'wx+');
      } else {
        await reopenPart(t);
      }
      if (!running || rt.aborted) return;
      // 'verifying' is what a stop or a crash during the final hash leaves behind. The saved
      // progress may be older than the last chunk, so the transfer goes back to receiving and
      // asks for what it lacks; with every chunk held, resume() verifies again at once.
      if (t.state === 'offered' || t.state === 'paused' || t.state === 'verifying') setState(t, 'receiving');
      rt.lastChunkAt = now();
      rt.stalls = 0;
      persist();
      await sendAccept(t);
      if (t.chunks === 0) void completeReceive(t);
    } catch (error) {
      if (running && !rt.aborted) ioFailure(t, error);
    } finally {
      rt.activating = false;
    }
  }

  /** Reopen the part file of a transfer that was interrupted and trust only what is proven. */
  async function reopenPart(t) {
    const { rt } = t;
    const path = join(downloadsDir, t.part);
    let known = null;
    const saved = await bitmapBlobs.get(t.id).catch(() => null);
    if (saved !== null) known = unpackBits(saved, t.chunks);
    try {
      rt.handle = await open(path, 'r+');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      rt.handle = await open(path, 'wx+');
      known = null;
    }
    const { size } = await rt.handle.stat();
    rt.states = known ?? new Uint8Array(t.chunks);
    rt.held = 0;
    let end = 0;
    for (let i = 0; i < t.chunks; i += 1) {
      if (rt.states[i] !== 2) continue;
      rt.held += 1;
      end = Math.max(end, i * t.chunk + chunkLength(t, i));
    }
    // Every chunk the bitmap claims must be on disk; a short file means the bitmap is stale.
    if (end > size) {
      rt.states = new Uint8Array(t.chunks);
      rt.held = 0;
    }
    rt.seenBase = 0;
    while (rt.seenBase < t.chunks && rt.states[rt.seenBase] === 2) rt.seenBase += 1;
    rt.win = INITIAL_WINDOW;
    rt.lastBaseAtSack = rt.seenBase;
  }

  function onChunk(packet) {
    const { body } = packet;
    let peeked;
    try {
      peeked = peekChunk(body);
    } catch {
      counters.chunksRejected += 1;
      return;
    }
    const t = transfers.get(peeked.transferId.toString('hex'));
    if (t === undefined || t.direction !== 'receive' || t.rt.handle === null || t.queued) {
      counters.chunksRejected += 1;
      return;
    }
    if (t.state !== 'receiving' && t.state !== 'paused') {
      counters.chunksRejected += 1;
      return;
    }
    const { rt } = t;
    if (peeked.index >= t.chunks) {
      counters.chunksRejected += 1;
      return;
    }
    let plaintext;
    try {
      ({ plaintext } = openChunk({ key: t.key, body }));
    } catch {
      counters.chunksRejected += 1;
      return;
    }
    if (plaintext.length !== chunkLength(t, peeked.index)) {
      counters.chunksRejected += 1;
      return;
    }
    const { index } = peeked;
    rt.lastChunkAt = now();
    rt.stalls = 0;
    if (t.state === 'paused') {
      setState(t, 'receiving');
      ctx.events.emit('file.resumed', { id: t.id });
    }
    if (rt.states[index] !== 0) {
      counters.chunksDuplicate += 1;
      // The sender evidently lost an acknowledgement: say what we hold, at most once per interval.
      if (now() - rt.lastSackAt >= sackDelayMs) sendSack(t);
      return;
    }
    if (rt.pendingWrites >= MAX_PENDING_WRITES) {
      counters.chunksRejected += 1;
      return;
    }
    rt.states[index] = 1;
    rt.pendingWrites += 1;
    rt.received += 1;
    while (rt.seenBase < t.chunks && rt.states[rt.seenBase] !== 0) rt.seenBase += 1;
    noteLoss(t, index);
    counters.chunksReceived += 1;
    counters.bytesReceived += plaintext.length;
    void writeChunk(t, index, plaintext);
  }

  /** A hole that outlives later arrivals is loss: halve the credit once per window of arrivals. */
  function noteLoss(t, index) {
    const { rt } = t;
    if (index < rt.seenBase) {
      rt.aboveBase = 0;
      return;
    }
    rt.aboveBase += 1;
    if (rt.aboveBase >= LOSS_ARRIVALS && rt.received >= rt.lossUntil) {
      rt.win = Math.max(1, Math.floor(rt.win / 2));
      rt.lossUntil = rt.received + rt.win;
    }
  }

  async function writeChunk(t, index, plaintext) {
    const { rt } = t;
    try {
      await rt.handle.write(plaintext, 0, plaintext.length, index * t.chunk);
    } catch (error) {
      rt.pendingWrites -= 1;
      if (running && !rt.aborted) ioFailure(t, error);
      return;
    }
    rt.pendingWrites -= 1;
    if (rt.aborted || !running) return;
    rt.states[index] = 2;
    rt.held += 1;
    touch(t);
    rt.dirty += 1;
    if (rt.unreported === 0) rt.firstUnreportedAt = now();
    rt.unreported += 1;
    sample(t);
    emitProgress(t);
    if (rt.unreported >= ackEvery(t)) sendSack(t);
    if (rt.dirty >= PERSIST_EVERY_CHUNKS) void persistProgress(t);
    if (rt.held === t.chunks && rt.pendingWrites === 0) void completeReceive(t);
  }

  /** fsync the part file, then save the bitmap: what the bitmap claims is always on disk. */
  function persistProgress(t) {
    const { rt } = t;
    rt.persisting = rt.persisting.then(async () => {
      if (rt.handle === null || TERMINAL.has(t.state)) return;
      rt.dirty = 0;
      rt.lastPersistAt = now();
      const snapshot = packBits(rt.states, t.chunks);
      await rt.handle.sync();
      await bitmapBlobs.put(t.id, snapshot);
      persist();
    }).catch((error) => ctx.log.warn('could not persist transfer progress', { id: t.id, error: String(error?.message ?? error).slice(0, 200) }));
    return rt.persisting;
  }

  async function digestOf(handle, size) {
    const hash = createHash('sha256');
    const block = Buffer.alloc(READ_BLOCK);
    for (let offset = 0; offset < size; ) {
      const length = Math.min(READ_BLOCK, size - offset);
      const { bytesRead } = await handle.read(block, 0, length, offset);
      if (bytesRead !== length) throw new StoreError('the part file is shorter than the transfer');
      hash.update(block.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest();
  }

  /** Put a verified part file under its final name without ever replacing an existing file. */
  async function commit(partPath, cleanName) {
    for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
      const target = join(downloadsDir, uniqueName(cleanName, attempt));
      try {
        await link(partPath, target);
        await unlink(partPath).catch((error) => ctx.log.warn('could not remove a part file', { error: String(error?.message ?? error).slice(0, 200) }));
        return target;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
      }
      // A file system without hard links: check, then rename (a narrow race that only
      // another process writing into the downloads directory could win).
      if (await stat(target).then(() => true, () => false)) continue;
      await rename(partPath, target);
      return target;
    }
    throw new StoreError('no free name for the received file');
  }

  async function completeReceive(t) {
    const { rt } = t;
    if (rt.verifying || TERMINAL.has(t.state) || rt.handle === null) return;
    rt.verifying = true;
    setState(t, 'verifying');
    try {
      await rt.persisting;
      await rt.handle.sync();
      const { size } = await rt.handle.stat();
      if (size !== t.size) throw new StoreError('the part file has the wrong size');
      const digest = await digestOf(rt.handle, t.size);
      if (rt.aborted || !running) return;
      if (!digest.equals(base64Decode(t.sha256, HASH_BYTES))) {
        await finish(t, 'failed', { error: 'hash', removePart: true });
        await sendControl(t, 'file-done', { ok: false, reason: 'hash' });
        return;
      }
      await closeHandle(t);
      const target = await commit(join(downloadsDir, t.part), sanitizeFileName(t.name));
      t.path = target;
      counters.completedIn += 1;
      t.rt.held = t.chunks;
      await finish(t, 'completed');
      await sendControl(t, 'file-done', { ok: true });
    } catch (error) {
      if (running && !rt.aborted) ioFailure(t, error);
    } finally {
      rt.verifying = false;
    }
  }

  function replyRejected(peer) {
    const at = now();
    const entry = rejectReplies.get(peer);
    if (entry === undefined || at >= entry.resetAt) {
      if (rejectReplies.size >= MAX_REJECT_PEERS) rejectReplies.delete(rejectReplies.keys().next().value);
      rejectReplies.set(peer, { count: 1, resetAt: at + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= REJECT_REPLIES_PER_MIN;
  }

  async function rejectOffer(from, tid, reason) {
    if (!replyRejected(from)) return;
    try {
      await ctx.messaging.send(from, { kind: 'file-reject', meta: { tid, reason }, reliable: true });
    } catch (error) {
      ctx.log.debug('file-reject not sent', { error: String(error?.message ?? error).slice(0, 200) });
    }
  }

  /** The strict reading of a `file-offer`'s fields; null when anything is out of range. */
  function parseOffer(meta) {
    if (typeof meta.tid !== 'string' || !TID_PATTERN.test(meta.tid)) return null;
    if (typeof meta.name !== 'string' || !meta.name.isWellFormed() || !isInteger(utf8Length(meta.name), 1, MAX_NAME_BYTES)) return null;
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) return null;
    if (!isInteger(meta.chunk, 1, MAX_OFFERED_CHUNK)) return null;
    try {
      return {
        tid: meta.tid,
        name: meta.name,
        size: meta.size,
        chunk: meta.chunk,
        sha256: meta.sha256,
        key: base64Decode(meta.key, KEY_BYTES),
        digest: base64Decode(meta.sha256, HASH_BYTES),
      };
    } catch {
      return null;
    }
  }

  function pendingOffers(peer) {
    let all = 0;
    let own = 0;
    for (const t of transfers.values()) {
      if (t.direction !== 'receive' || !isActive(t) || !(t.state === 'offered' || t.queued)) continue;
      all += 1;
      if (t.peer === peer) own += 1;
    }
    return { all, own };
  }

  /** The target path of a name must stay inside the downloads directory. */
  function confined(cleanName) {
    const path = resolve(downloadsDir, cleanName);
    const inside = relative(downloadsDir, path);
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !inside.includes(sep);
  }

  async function onOffer(message) {
    const { from, meta } = message;
    const offer = parseOffer(meta);
    if (offer === null) {
      if (typeof meta.tid === 'string' && TID_PATTERN.test(meta.tid)) await rejectOffer(from, meta.tid, 'invalid');
      return;
    }
    const known = transfers.get(offer.tid);
    if (known !== undefined) {
      await onKnownOffer(known, offer, from);
      return;
    }
    counters.offersIn += 1;
    if (offer.size > files.maxSizeBytes) return rejectOffer(from, offer.tid, 'too-large');
    const chunks = Math.ceil(offer.size / offer.chunk);
    if (chunks > MAX_CHUNKS) return rejectOffer(from, offer.tid, 'too-large');
    if (offer.chunk > MAX_CHUNK_BYTES || !confined(sanitizeFileName(offer.name))) return rejectOffer(from, offer.tid, 'invalid');
    if (files.accept === 'deny') return rejectOffer(from, offer.tid, 'denied');
    const pending = pendingOffers(from);
    if (pending.all >= maxPendingOffers || pending.own >= maxPendingPerPeer) return rejectOffer(from, offer.tid, 'busy');

    const at = now();
    const t = {
      id: offer.tid,
      direction: 'receive',
      peer: from,
      name: offer.name,
      size: offer.size,
      sha256: offer.sha256,
      chunk: offer.chunk,
      chunks,
      state: 'offered',
      createdAt: at,
      updatedAt: at,
      path: null,
      error: null,
      key: offer.key,
      part: null,
      queued: false,
      rt: null,
    };
    t.rt = newRuntime(t);
    transfers.set(t.id, t);
    persist();
    ctx.events.emit('file.incoming', { transfer: view(t) });
    if (files.accept === 'auto') await acceptTransfer(t);
  }

  /** A repeated offer: how a sender resumes, or learns what became of its transfer. */
  async function onKnownOffer(t, offer, from) {
    if (from !== t.peer || t.direction !== 'receive') return;
    const same = t.size === offer.size && t.chunk === offer.chunk && t.sha256 === offer.sha256 && t.key.equals(offer.key);
    if (!same) return rejectOffer(from, t.id, 'invalid');
    switch (t.state) {
      case 'receiving':
      case 'paused':
        if (!t.queued && t.rt.handle !== null) await sendAccept(t);
        break;
      case 'completed':
        await sendControl(t, 'file-done', { ok: true });
        break;
      case 'rejected':
        await sendControl(t, 'file-reject', { reason: REJECT_REASONS.has(t.error) ? t.error : 'denied' });
        break;
      case 'cancelled':
        await sendControl(t, 'file-cancel', { reason: 'user' });
        break;
      case 'failed':
        await sendControl(t, 'file-done', { ok: false, reason: t.error === 'hash' ? 'hash' : 'io' });
        break;
      default:
    }
  }

  async function acceptTransfer(t) {
    if (lockedCount('receive', ['receiving']) >= maxActive) {
      t.queued = true;
      setState(t, 'paused');
      ctx.events.emit('file.paused', { id: t.id, reason: 'waiting-for-slot' });
      return;
    }
    ctx.events.emit('file.accepted', { transfer: view(t) });
    await activateReceive(t);
  }

  // ------------------------------------------------------------------ message handlers

  /** Run a handler on the transfer a message names; ignore unknown ids and every failure. */
  function handler(kind, work) {
    return async (message) => {
      if (!running) return;
      const { meta } = message;
      if (typeof meta.tid !== 'string' || !TID_PATTERN.test(meta.tid)) return;
      const t = transfers.get(meta.tid);
      if (t === undefined) return;
      try {
        await work(t, meta, message.from);
      } catch (error) {
        ctx.log.warn('file message handler failed', { kind, error: String(error?.message ?? error).slice(0, 200) });
      }
    };
  }

  // ------------------------------------------------------------------ periodic work

  function tick() {
    if (!running) return;
    const at = now();
    for (const t of transfers.values()) {
      if (!isActive(t)) continue;
      const { rt } = t;
      if (t.direction === 'receive' && t.state === 'offered' && at - t.createdAt > offerTtlMs) {
        void declineUnanswered(t);
        continue;
      }
      if (at - t.updatedAt > limits.messageLifetimeMs && !rt.activating && !rt.verifying) {
        void expire(t);
        continue;
      }
      if (t.direction === 'send') tickSend(t, at);
      else tickReceive(t, at);
    }
  }

  async function declineUnanswered(t) {
    await finish(t, 'rejected', { error: 'denied' });
    await sendControl(t, 'file-reject', { reason: 'denied' });
  }

  async function expire(t) {
    await sendControl(t, 'file-cancel', { reason: 'expired' }, { reliable: false });
    await finish(t, 'failed', { error: 'expired', removePart: t.direction === 'receive' });
  }

  function tickSend(t, at) {
    const { rt } = t;
    if (rt.needOffer && at >= rt.controlRetryAt && t.state !== 'preparing') void sendOffer(t);
    if (t.state === 'sending') {
      if (rt.blocked && at >= rt.blockedUntil) void pump(t);
      if (rt.inflight.size > 0 && at - rt.lastSackAt >= stallInterval(rt.stalls)) {
        rt.inflight.clear();
        rt.stalls += 1;
        rt.lastSackAt = at;
        if (rt.stalls >= STALLS_BEFORE_PAUSE) {
          setState(t, 'paused');
          ctx.events.emit('file.paused', { id: t.id, reason: 'stalled' });
          // Ask again, unless the offer already in the outbox is still being retried.
          if (!messagePending(rt.offerMessage)) void sendOffer(t);
        } else {
          void pump(t);
        }
      }
    } else if (t.state === 'paused' && !t.queued && at - rt.lastSackAt >= stallInterval(rt.stalls)) {
      // Ask again, but only if the earlier offer is not still waiting in the outbox.
      rt.lastSackAt = at;
      rt.stalls += 1;
      if (!messagePending(rt.offerMessage)) void sendOffer(t);
    }
  }

  function tickReceive(t, at) {
    const { rt } = t;
    if (rt.needAccept && at >= rt.controlRetryAt && rt.handle !== null) void sendAccept(t);
    if (t.state !== 'receiving' && t.state !== 'paused') return;
    if (rt.handle === null || t.queued) return;
    if (rt.unreported > 0 && at - rt.firstUnreportedAt >= sackDelayMs) sendSack(t);
    if (rt.dirty > 0 && at - rt.lastPersistAt >= PERSIST_EVERY_MS) void persistProgress(t);
    if (t.chunks > 0 && rt.held < t.chunks && at - rt.lastChunkAt >= stallInterval(rt.stalls)) {
      rt.stalls += 1;
      rt.lastChunkAt = at;
      rt.win = Math.max(1, Math.floor(rt.win / 2));
      if (t.state === 'receiving' && rt.stalls >= STALLS_BEFORE_PAUSE) {
        setState(t, 'paused');
        ctx.events.emit('file.paused', { id: t.id, reason: 'stalled' });
      }
      if (!messagePending(rt.acceptMessage)) void sendAccept(t);
    }
  }

  // ------------------------------------------------------------------ restart

  async function restore() {
    for (const record of doc.data.transfers) {
      let key;
      try {
        key = base64Decode(record.key, KEY_BYTES);
      } catch {
        ctx.log.warn('files: dropping a stored transfer with an unreadable key', { id: record.id });
        continue;
      }
      const t = { ...record, key, rt: null };
      t.rt = newRuntime(t);
      transfers.set(t.id, t);
    }
  }

  /** Bring an unfinished transfer back to life after a restart. */
  async function resume(t) {
    const { rt } = t;
    try {
      if (t.direction === 'send') {
        rt.sentOnce = new Uint8Array(t.chunks);
        if (t.state === 'preparing') {
          void prepare(t);
          return;
        }
        const hashes = await hashBlobs.get(t.id);
        const info = await stat(t.path).catch(() => null);
        if (hashes === null || hashes.length !== t.chunks * CHUNK_HASH_BYTES || info === null || !info.isFile() || info.size !== t.size) {
          sourceChanged(t);
          return;
        }
        rt.hashes = hashes;
        if (t.state === 'sending') setState(t, 'paused');
        t.queued = false;
        rt.lastSackAt = now();
        await sendOffer(t);
      } else if (t.state === 'receiving' || t.state === 'paused' || t.state === 'verifying') {
        t.queued = false;
        await activateReceive(t);
        if (t.chunks > 0 && rt.held === t.chunks && !rt.aborted) void completeReceive(t);
      }
    } catch (error) {
      if (running && !rt.aborted) ioFailure(t, error);
    }
  }

  // ------------------------------------------------------------------ operations

  function requireTransfer(tid) {
    const t = typeof tid === 'string' ? transfers.get(tid) : undefined;
    if (t === undefined) throw stateError('not-found', `no transfer "${String(tid).slice(0, 40)}"`);
    return t;
  }

  async function send(to, path, { name } = {}) {
    if (!running) throw stateError('not-running', 'the file service is not running');
    if (typeof to !== 'string' || !NODE_ID_PATTERN.test(to)) throw new ConfigError('to must be a NodeId');
    if (to === ctx.nodeId) throw new ConfigError('a file cannot be sent to this node');
    if (typeof path !== 'string' || path === '' || path.length > MAX_PATH_CHARS || path.includes('\0')) {
      throw new ConfigError('path must be a non-empty string without NUL characters');
    }
    const shown = name ?? basename(path);
    if (typeof shown !== 'string' || !shown.isWellFormed() || !isInteger(utf8Length(shown), 1, MAX_NAME_BYTES)) {
      throw new ConfigError(`name must be 1 to ${MAX_NAME_BYTES} bytes of well-formed UTF-8`);
    }
    if (ctx.directory.cardOf(to) === null) throw stateError('unknown-destination', 'no identity card is known for that node');
    const source = resolve(path);
    const info = await stat(source).catch(() => null);
    if (info === null) throw stateError('invalid-file', 'the file does not exist', { reason: 'not-found' });
    if (!info.isFile()) throw stateError('invalid-file', 'the path is not a regular file', { reason: 'not-a-file' });
    const chunk = files.chunkSize;
    if (info.size > files.maxSizeBytes || Math.ceil(info.size / chunk) > MAX_CHUNKS) {
      throw stateError('invalid-file', 'the file is larger than this node sends', { reason: 'too-large' });
    }
    const at = now();
    const t = {
      id: randomBytes(16).toString('hex'),
      direction: 'send',
      peer: to,
      name: shown,
      size: info.size,
      sha256: null,
      chunk,
      chunks: Math.ceil(info.size / chunk),
      state: 'preparing',
      createdAt: at,
      updatedAt: at,
      path: source,
      error: null,
      key: randomBytes(KEY_BYTES),
      part: null,
      queued: false,
      rt: null,
    };
    t.rt = newRuntime(t);
    t.rt.sentOnce = new Uint8Array(t.chunks);
    transfers.set(t.id, t);
    persist();
    await doc.flush();
    void prepare(t);
    return view(t);
  }

  async function accept(tid) {
    const t = requireTransfer(tid);
    if (t.direction !== 'receive' || t.state !== 'offered') throw stateError('invalid-state', `transfer is ${t.state}, not an incoming offer`);
    await acceptTransfer(t);
    return view(t);
  }

  async function reject(tid) {
    const t = requireTransfer(tid);
    if (t.direction !== 'receive' || t.state !== 'offered') throw stateError('invalid-state', `transfer is ${t.state}, not an incoming offer`);
    await finish(t, 'rejected', { error: 'denied' });
    await sendControl(t, 'file-reject', { reason: 'denied' });
    return view(t);
  }

  async function cancel(tid) {
    const t = requireTransfer(tid);
    if (!isActive(t)) throw stateError('invalid-state', `transfer is already ${t.state}`);
    await finish(t, 'cancelled', { error: 'user', removePart: t.direction === 'receive' });
    await sendControl(t, 'file-cancel', { reason: 'user' });
    return view(t);
  }

  function list() {
    return [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).map(view);
  }

  function get(tid) {
    const t = typeof tid === 'string' ? transfers.get(tid) : undefined;
    return t === undefined ? null : view(t);
  }

  // ------------------------------------------------------------------ API routes

  function invalid(field, problem) {
    return ctx.api.error(400, 'invalid_request', `${field}: ${problem}`, { field, problem });
  }

  /** Give a file-validation error the status and details API.md section 4 asks for. */
  async function mapped(work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StateError && error.reason !== undefined && error.message.startsWith('invalid-file:')) {
        throw ctx.api.error(400, 'invalid_file', error.message, { reason: error.reason });
      }
      throw error;
    }
  }

  function registerRoutes() {
    ctx.api.route(
      'POST',
      '/files',
      async ({ body }) => {
        if (!isPlainObject(body)) throw invalid('body', 'must be an object');
        for (const field of Object.keys(body)) if (!['to', 'path', 'name'].includes(field)) throw invalid(field, 'unknown field');
        if (typeof body.to !== 'string' || !NODE_ID_PATTERN.test(body.to)) throw invalid('to', 'must be a NodeId');
        if (typeof body.path !== 'string' || body.path === '') throw invalid('path', 'must be a non-empty string');
        if (body.name !== undefined && (typeof body.name !== 'string' || !isInteger(utf8Length(body.name), 1, MAX_NAME_BYTES))) {
          throw invalid('name', `must be 1 to ${MAX_NAME_BYTES} bytes`);
        }
        const transfer = await mapped(() => send(body.to, body.path, { name: body.name }));
        return ctx.api.reply(202, { transfer });
      },
      { summary: 'offer a file to a node' },
    );
    ctx.api.route(
      'GET',
      '/files',
      async () => ({ transfers: list(), asOf: { boot: ctx.boot, seq: ctx.events.lastSeq } }),
      { summary: 'transfers, newest first' },
    );
    ctx.api.route(
      'GET',
      '/files/:id',
      async ({ params }) => {
        const transfer = get(params.id);
        if (transfer === null) throw stateError('not-found', 'no such transfer');
        return { transfer };
      },
      { summary: 'one transfer' },
    );
    for (const [action, work] of [['accept', accept], ['reject', reject], ['cancel', cancel]]) {
      ctx.api.route('POST', `/files/:id/${action}`, async ({ params }) => ({ transfer: await work(params.id) }), {
        summary: `${action} a transfer`,
      });
    }
  }

  // ------------------------------------------------------------------ the service

  return {
    name: 'files',

    api: {
      /**
       * Offer a file to a node. Resolves with the transfer in state `preparing`; hashing,
       * the offer and the transfer itself follow in the background.
       *
       * @param {string} to NodeId whose identity card is known
       * @param {string} path a regular file on this machine
       * @param {{ name?: string }} [options] the name shown to the receiver (1 to 255 bytes)
       * @returns {Promise<object>} the Transfer
       * @throws {ConfigError} for a bad argument
       * @throws {StateError} `unknown-destination`, or `invalid-file` with `error.reason`
       *   `not-found`, `not-a-file` or `too-large`
       */
      send,
      /** @returns {object[]} every Transfer held, newest first */
      list,
      /**
       * @param {string} tid
       * @returns {object | null} the Transfer, or null
       */
      get,
      /**
       * Accept an incoming offer that waits in state `offered`.
       *
       * @param {string} tid
       * @returns {Promise<object>} the Transfer
       * @throws {StateError} `not-found`, `invalid-state`
       */
      accept,
      /**
       * Decline an incoming offer that waits in state `offered`.
       *
       * @param {string} tid
       * @returns {Promise<object>} the Transfer
       * @throws {StateError} `not-found`, `invalid-state`
       */
      reject,
      /**
       * Stop a transfer in any unfinished state, in either direction; a partial download is deleted.
       *
       * @param {string} tid
       * @returns {Promise<object>} the Transfer
       * @throws {StateError} `not-found`, `invalid-state`
       */
      cancel,
    },

    async init(serviceContext) {
      ctx = serviceContext;
      files = ctx.config.files;
      timers = ctx.config.timers;
      limits = ctx.config.limits;
      downloadsDir = resolve(files.downloadsDir ?? join(ctx.node.dataDir, 'downloads'));
      sackDelayMs = Math.max(1, Math.min(200, Math.floor(timers.retransmitMinMs / 4)));
      doc = ctx.storage.doc('transfers', { defaults: { v: 1, transfers: [] }, validate: validTransfersDoc });
      bitmapBlobs = ctx.storage.blobs('bitmaps', { maxBytes: MAX_CHUNKS / 8 + 1024 });
      hashBlobs = ctx.storage.blobs('hashes', { maxBytes: MAX_CHUNKS * CHUNK_HASH_BYTES + 1024 });
      await doc.load();
      await restore();
      const handlers = {
        'file-offer': (message) => (running ? onOffer(message).catch((error) => ctx.log.warn('file-offer failed', { error: String(error?.message ?? error).slice(0, 200) })) : undefined),
        'file-accept': handler('file-accept', onAccept),
        'file-reject': handler('file-reject', onReject),
        'file-sack': handler('file-sack', onSack),
        'file-done': handler('file-done', onDone),
        'file-cancel': handler('file-cancel', onCancel),
      };
      for (const kind of KINDS) ctx.messaging.onKind(kind, handlers[kind]);
      ctx.packets.onLocal('data.transfer', onChunk);
      registerRoutes();
    },

    async start() {
      running = true;
      cancelEvery = ctx.every(tick, Math.max(5, Math.floor(sackDelayMs / 2)));
      cancelRoutes = ctx.routing.onRoutesChanged(() => {
        for (const t of transfers.values()) {
          if (t.state === 'sending' && t.rt.blocked) void pump(t);
          if (t.direction === 'send' && t.rt.needOffer) void sendOffer(t);
        }
      });
      for (const t of [...transfers.values()]) if (isActive(t)) void resume(t);
    },

    async stop() {
      running = false;
      cancelEvery?.();
      cancelRoutes?.();
      for (const t of transfers.values()) {
        await t.rt.persisting.catch(() => {});
        if (t.direction === 'receive' && t.rt.handle !== null && isActive(t) && t.state !== 'verifying') {
          const snapshot = packBits(t.rt.states, t.chunks);
          try {
            await t.rt.handle.sync();
            await bitmapBlobs.put(t.id, snapshot);
          } catch (error) {
            ctx.log.warn('could not save transfer progress at stop', { id: t.id, error: String(error?.message ?? error).slice(0, 200) });
          }
        }
        await closeHandle(t);
      }
      persist();
      await doc.flush();
    },

    stats() {
      let active = 0;
      for (const t of transfers.values()) if (isActive(t)) active += 1;
      return { active, ...counters };
    },
  };
}

