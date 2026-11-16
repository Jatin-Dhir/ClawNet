/**
 * Small, bounded rate limiters and a bounded set, shared by the discovery modules.
 *
 * Everything here takes the time as an argument, a monotonic millisecond reading
 * (DESIGN.md section 15, item 21: intervals never use the wall clock). A reading that goes
 * backwards refills nothing and restarts the measurement, so a clock step can neither
 * lock a limiter nor give it a burst of free tokens.
 */

import { ConfigError } from '../errors.js';

/**
 * A token bucket: holds up to `capacity` tokens and gains `perSecond` per second.
 */
export class TokenBucket {
  #capacity;
  #perMs;
  #tokens;
  #at = null;

  /**
   * @param {object} options
   * @param {number} options.capacity  burst size, > 0
   * @param {number} options.perSecond refill rate in tokens per second, > 0
   * @throws {ConfigError} if a value is not a positive finite number
   */
  constructor({ capacity, perSecond }) {
    if (!(Number.isFinite(capacity) && capacity > 0)) {
      throw new ConfigError('token bucket capacity must be a positive number');
    }
    if (!(Number.isFinite(perSecond) && perSecond > 0)) {
      throw new ConfigError('token bucket rate must be a positive number');
    }
    this.#capacity = capacity;
    this.#perMs = perSecond / 1000;
    this.#tokens = capacity;
  }

  #refill(now) {
    if (this.#at !== null && now > this.#at) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#at) * this.#perMs);
    }
    this.#at = now;
  }

  /**
   * Take one token if there is one.
   *
   * @param {number} now monotonic milliseconds
   * @returns {boolean} false if the bucket is empty
   */
  take(now) {
    this.#refill(now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /**
   * @param {number} now monotonic milliseconds
   * @returns {boolean} whether the bucket is full again, so a fresh bucket would behave
   *   the same and this one can be forgotten
   */
  isFull(now) {
    this.#refill(now);
    return this.#tokens >= this.#capacity;
  }
}

/**
 * Token buckets by key (a source address, say) in a table of bounded size.
 *
 * A bucket that has refilled completely is the same as no bucket, so full buckets are
 * dropped to make room. If the table is still full the key is refused: an attacker who
 * spoofs many sources can then lock out new sources for as long as the flood lasts, but
 * cannot make the table grow.
 */
export class KeyedTokenBuckets {
  #capacity;
  #perSecond;
  #maxKeys;
  /** @type {Map<string, TokenBucket>} */
  #buckets = new Map();

  /**
   * @param {object} options
   * @param {number} options.capacity  burst per key, > 0
   * @param {number} options.perSecond refill per key, > 0
   * @param {number} options.maxKeys   most keys tracked at once, >= 1
   * @throws {ConfigError}
   */
  constructor({ capacity, perSecond, maxKeys }) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new ConfigError('keyed token buckets need maxKeys >= 1');
    }
    // Validates capacity and perSecond.
    new TokenBucket({ capacity, perSecond });
    this.#capacity = capacity;
    this.#perSecond = perSecond;
    this.#maxKeys = maxKeys;
  }

  /** @returns {number} keys currently tracked */
  get size() {
    return this.#buckets.size;
  }

  /**
   * Take one token for `key`.
   *
   * @param {string} key
   * @param {number} now monotonic milliseconds
   * @returns {"ok" | "limited" | "table-full"} `limited`: the key is over its rate;
   *   `table-full`: the key is new and there is no room to track it
   */
  take(key, now) {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxKeys) this.#sweep(now);
      if (this.#buckets.size >= this.#maxKeys) return 'table-full';
      bucket = new TokenBucket({ capacity: this.#capacity, perSecond: this.#perSecond });
      this.#buckets.set(key, bucket);
    }
    return bucket.take(now) ? 'ok' : 'limited';
  }

  /** Forget the buckets that have refilled completely. */
  #sweep(now) {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.isFull(now)) this.#buckets.delete(key);
    }
  }
}

/**
 * A set of strings that forgets its oldest member when it is full.
 */
export class BoundedSet {
  #max;
  #items = new Set();

  /**
   * @param {number} max most members kept, >= 1
   * @throws {ConfigError}
   */
  constructor(max) {
    if (!Number.isSafeInteger(max) || max < 1) throw new ConfigError('bounded set needs max >= 1');
    this.#max = max;
  }

  /**
   * Add a member.
   *
   * @param {string} item
   * @returns {boolean} true if it was not a member before
   */
  add(item) {
    if (this.#items.has(item)) return false;
    if (this.#items.size >= this.#max) {
      this.#items.delete(this.#items.values().next().value);
    }
    this.#items.add(item);
    return true;
  }

  /** @returns {number} members held */
  get size() {
    return this.#items.size;
  }
}
