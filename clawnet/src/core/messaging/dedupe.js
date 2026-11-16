/**
 * Duplicate-suppression cache (DESIGN.md section 6).
 *
 * Two users: a forwarder remembers the `(id, try)` pairs it has already forwarded, and a
 * recipient remembers the message ids it has already delivered so a replayed Noise_X
 * message is recognised for the whole message lifetime.
 *
 * Both are fed by whoever can send us packets, so the cache is bounded twice: entries
 * expire after `ttlMs`, and beyond `maxEntries` the oldest entry is evicted.
 *
 * Both sit on the per-packet path, so every operation is O(1) amortised whatever the
 * size of the cache. Membership lives in a Map; the order of arrival lives in a separate
 * ring buffer. The Map is never asked for its oldest entry: in V8 a deleted Map entry
 * stays in the backing table until the next rehash and every new iterator walks over
 * all of them, which makes "first key of the Map" cost O(maxEntries) once entries leave
 * from the old end. The ring reaches its oldest record by index instead.
 *
 * An entry's lifetime runs from the FIRST time its key was added. Seeing the key again
 * does not extend it, otherwise a peer could keep an entry alive forever by replaying it.
 *
 * Eviction is the price of the bound: a flood of new keys pushes older ones out before
 * their ttl, after which those older keys read as unseen. Size `maxEntries` for the
 * traffic the node is expected to carry.
 */

import { ConfigError, StateError, StoreError } from '../errors.js';

/** Default bound on key length in UTF-16 code units; protocol keys are 32 to 36. */
export const DEFAULT_MAX_KEY_LENGTH = 128;

/** Smallest ring allocated; also the size a drained cache shrinks back to. */
const MIN_CAPACITY = 16;

export class SeenCache {
  /**
   * key -> sequence number of the key's record. Sequence numbers count records ever
   * queued; record `seq` lives in ring slot `seq % capacity`.
   */
  #seqOf = new Map();
  /** Ring of keys in arrival order. `undefined` marks a record that was removed early. */
  #keys = new Array(MIN_CAPACITY);
  /** Ring of the times the keys were first added, in ms, parallel to #keys. */
  #times = new Float64Array(MIN_CAPACITY);
  #capacity = MIN_CAPACITY;
  /** Sequence number of the oldest record still in the ring. */
  #head = 0;
  /** Sequence number the next record gets. The ring holds #tail - #head records. */
  #tail = 0;
  /** Removed records between #head and #tail: #tail - #head === #seqOf.size + #holes. */
  #holes = 0;
  #maxEntries;
  #ttlMs;
  #monoNow;
  #wallNow;
  #maxKeyLength;

  /**
   * @param {object} options
   * @param {number} options.maxEntries most entries kept, a positive integer. Memory is
   *   allocated as the cache fills, not up front, and given back as it drains.
   * @param {number} options.ttlMs      lifetime of an entry in milliseconds, > 0
   * @param {() => number} options.monoNow  MONOTONIC clock in milliseconds (for example
   *   `performance.now`). Lifetimes are measured on it, so a wall-clock step can neither
   *   expire every entry at once nor keep entries alive (DESIGN.md section 15, item 21).
   * @param {() => number} [options.wallNow]  WALL clock in milliseconds (`Date.now`).
   *   Needed only by snapshot() and restore(): a monotonic reading means nothing to
   *   another process, so persisted stamps are wall-clock times.
   * @param {number} [options.maxKeyLength=128] longest accepted key, in UTF-16 code
   *   units, so that the byte size of the cache is bounded as well as its entry count
   * @throws {ConfigError} if an option is missing or out of range
   */
  constructor({
    maxEntries,
    ttlMs,
    monoNow,
    wallNow,
    maxKeyLength = DEFAULT_MAX_KEY_LENGTH,
  } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new ConfigError('maxEntries must be a positive integer');
    }
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ConfigError('ttlMs must be a finite number > 0');
    }
    if (typeof monoNow !== 'function') {
      throw new ConfigError('monoNow must be a function returning milliseconds');
    }
    if (wallNow !== undefined && typeof wallNow !== 'function') {
      throw new ConfigError('wallNow must be a function returning milliseconds when given');
    }
    if (!Number.isSafeInteger(maxKeyLength) || maxKeyLength < 1) {
      throw new ConfigError('maxKeyLength must be a positive integer');
    }
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#monoNow = monoNow;
    this.#wallNow = wallNow;
    this.#maxKeyLength = maxKeyLength;
  }

  /**
   * Whether the key was added less than ttlMs ago and has not been evicted. O(1).
   *
   * @param {string} key
   * @returns {boolean}
   * @throws {ConfigError} if the key is not a string or is longer than maxKeyLength
   * @throws {StateError} if the injected clock misbehaves
   */
  has(key) {
    this.#checkKey(key);
    const seq = this.#seqOf.get(key);
    if (seq === undefined) return false;
    if (this.#clock() - this.#times[seq % this.#capacity] < this.#ttlMs) return true;
    this.#discard(key, seq);
    return false;
  }

  /**
   * Record a key. O(1) amortised, independent of maxEntries.
   *
   * @param {string} key
   * @returns {boolean} true if the key was new (or had expired), false if it is a
   *   duplicate. A duplicate does not extend the entry's lifetime.
   * @throws {ConfigError} if the key is not a string or is longer than maxKeyLength
   * @throws {StateError} if the injected clock misbehaves
   */
  add(key) {
    this.#checkKey(key);
    const now = this.#clock();
    const seq = this.#seqOf.get(key);
    if (seq !== undefined) {
      if (now - this.#times[seq % this.#capacity] < this.#ttlMs) return false;
      // Expired: remove the old record so the key is queued again as the youngest.
      this.#discard(key, seq);
    }
    this.#dropExpired(now);
    // Evicting before inserting keeps the ring from growing a slot past maxEntries.
    if (this.#seqOf.size >= this.#maxEntries) this.#evictOldest();
    this.#append(key, now);
    return true;
  }

  /**
   * Number of live entries.
   *
   * @returns {number}
   * @throws {StateError} if the injected clock misbehaves
   */
  get size() {
    this.#dropExpired(this.#clock());
    return this.#seqOf.size;
  }

  /**
   * Remove expired entries now instead of waiting for the next add().
   *
   * @returns {number} how many entries were removed
   * @throws {StateError} if the injected clock misbehaves
   */
  prune() {
    return this.#dropExpired(this.#clock());
  }

  /**
   * Live entries as plain JSON data, oldest first, for persisting across a restart.
   * O(size).
   *
   * @returns {Array<[string, number]>} `[key, firstSeenMs]` pairs, the times as integer
   *   WALL-clock milliseconds: each entry's monotonic age subtracted from wallNow()
   * @throws {StateError} if the cache was built without `wallNow`, or a clock misbehaves
   */
  snapshot() {
    const now = this.#clock();
    const wall = this.#wallClock();
    this.#dropExpired(now);
    const entries = [];
    for (let seq = this.#head; seq < this.#tail; seq += 1) {
      const slot = seq % this.#capacity;
      const key = this.#keys[slot];
      if (key !== undefined) entries.push([key, wall - (now - this.#times[slot])]);
    }
    return entries;
  }

  /**
   * Rebuild a cache from snapshot() output that was read back from disk.
   *
   * The snapshot is not trusted. Anything that snapshot() could not have produced is
   * refused as a whole rather than half-loaded. Each wall-clock stamp is turned back
   * into an age against the restoring process's wall clock and placed on its monotonic
   * clock, so an entry keeps the lifetime it had left across the restart. Entries that
   * have expired in the meantime are dropped; if there are more than maxEntries the
   * newest are kept; a stamp ahead of the wall clock (the clock was set back, or the file
   * was edited) is pulled back to now, so no entry can outlive ttlMs counted from the
   * restore.
   *
   * @param {unknown} snapshot value returned by snapshot(), after a JSON round trip
   * @param {ConstructorParameters<typeof SeenCache>[0]} options constructor options;
   *   `wallNow` is required here
   * @returns {SeenCache}
   * @throws {ConfigError} if the options are invalid or lack `wallNow`
   * @throws {StoreError} if the snapshot is malformed
   */
  static restore(snapshot, options) {
    const cache = new SeenCache(options);
    if (cache.#wallNow === undefined) {
      throw new ConfigError('restore needs a wallNow clock to read wall-clock stamps');
    }
    if (!Array.isArray(snapshot)) {
      throw new StoreError('seen-cache snapshot must be an array');
    }
    const now = cache.#clock();
    const wall = cache.#wallClock();
    const keys = new Set();
    const live = [];
    for (let i = 0; i < snapshot.length; i += 1) {
      const item = snapshot[i];
      if (!Array.isArray(item) || item.length !== 2) {
        throw new StoreError(`seen-cache snapshot entry ${i} must be a [key, time] pair`);
      }
      const [key, at] = item;
      if (typeof key !== 'string' || key.length > cache.#maxKeyLength) {
        throw new StoreError(`seen-cache snapshot entry ${i} has an invalid key`);
      }
      if (!Number.isSafeInteger(at)) {
        throw new StoreError(`seen-cache snapshot entry ${i} has an invalid time`);
      }
      if (keys.has(key)) {
        throw new StoreError(`seen-cache snapshot entry ${i} repeats a key`);
      }
      keys.add(key);
      const age = wall - Math.min(at, wall);
      if (age < cache.#ttlMs) live.push([key, now - age]);
    }
    // The queue must be oldest first for head pruning to work, whatever order the file
    // was in. Array.prototype.sort is stable, so equal times keep their file order.
    live.sort((a, b) => a[1] - b[1]);
    for (let i = Math.max(0, live.length - cache.#maxEntries); i < live.length; i += 1) {
      cache.#append(live[i][0], live[i][1]);
    }
    return cache;
  }

  #checkKey(key) {
    if (typeof key !== 'string') {
      throw new ConfigError('seen-cache keys must be strings');
    }
    if (key.length > this.#maxKeyLength) {
      throw new ConfigError(`seen-cache keys must be at most ${this.#maxKeyLength} characters`);
    }
  }

  /** Read the monotonic clock as integer milliseconds, so snapshots hold integers only. */
  #clock() {
    return readClock(this.#monoNow, 'monoNow');
  }

  #wallClock() {
    if (this.#wallNow === undefined) {
      throw new StateError('snapshot needs a wallNow clock: stamps are persisted as wall time');
    }
    return readClock(this.#wallNow, 'wallNow');
  }

  /** Queue a key that is not in the cache as its youngest record. */
  #append(key, at) {
    // Holes outnumber entries only after a backward clock step (see #dropExpired), and
    // squeezing them out then is what keeps the ring within 2 * maxEntries slots.
    if (this.#holes > this.#seqOf.size || this.#tail - this.#head === this.#capacity) {
      this.#rebuild();
    }
    const slot = this.#tail % this.#capacity;
    this.#keys[slot] = key;
    this.#times[slot] = at;
    this.#seqOf.set(key, this.#tail);
    this.#tail += 1;
  }

  /** Remove an entry wherever its record sits, leaving a hole for the head to collect. */
  #discard(key, seq) {
    this.#seqOf.delete(key);
    this.#keys[seq % this.#capacity] = undefined;
    this.#holes += 1;
  }

  /** Remove the oldest entry. The caller makes sure there is one. */
  #evictOldest() {
    for (;;) {
      const slot = this.#head % this.#capacity;
      const key = this.#keys[slot];
      this.#head += 1;
      if (key === undefined) {
        this.#holes -= 1;
        continue;
      }
      this.#seqOf.delete(key);
      this.#keys[slot] = undefined; // let go of the string
      return;
    }
  }

  /**
   * Drop expired entries from the old end of the queue. With a clock that never goes
   * backwards the queue is sorted by time, so stopping at the first live entry is exact,
   * and no hole survives it either: whatever was queued before an expired record has
   * expired as well.
   * If the clock does step back, an expired entry can sit behind a live one for a while:
   * has() and add() still treat it as expired, and maxEntries still bounds the entries.
   *
   * @returns {number} how many entries were removed (holes are not counted)
   */
  #dropExpired(now) {
    let removed = 0;
    while (this.#head < this.#tail) {
      const slot = this.#head % this.#capacity;
      const key = this.#keys[slot];
      if (key === undefined) {
        this.#holes -= 1;
      } else {
        if (now - this.#times[slot] < this.#ttlMs) break;
        this.#seqOf.delete(key);
        this.#keys[slot] = undefined; // let go of the string
        removed += 1;
      }
      this.#head += 1;
    }
    // Give memory back after a flood has drained. Shrinking at a quarter full to half
    // full leaves as much room to grow as to shrink, so the copies stay amortised O(1).
    if (this.#capacity > MIN_CAPACITY && this.#tail - this.#head <= this.#capacity / 4) {
      this.#rebuild();
    }
    return removed;
  }

  /**
   * Move the records into a ring of twice the number of entries, without the holes.
   * This one routine grows a full ring, shrinks a drained one and squeezes holes out.
   * Records keep their sequence numbers unless a hole in front of them was removed, so
   * with no holes (the normal case) the Map is not touched.
   */
  #rebuild() {
    const capacity = Math.max(MIN_CAPACITY, 2 * this.#seqOf.size);
    const keys = new Array(capacity);
    const times = new Float64Array(capacity);
    let next = this.#head;
    for (let seq = this.#head; seq < this.#tail; seq += 1) {
      const slot = seq % this.#capacity;
      const key = this.#keys[slot];
      if (key === undefined) continue;
      keys[next % capacity] = key;
      times[next % capacity] = this.#times[slot];
      if (next !== seq) this.#seqOf.set(key, next);
      next += 1;
    }
    this.#keys = keys;
    this.#times = times;
    this.#capacity = capacity;
    this.#tail = next;
    this.#holes = 0;
  }
}

/** Read an injected clock as integer milliseconds; anything else is a caller error. */
function readClock(clock, name) {
  const now = clock();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new StateError(`${name}() must return a finite number of milliseconds`);
  }
  return Math.floor(now);
}
