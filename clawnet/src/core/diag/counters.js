/**
 * Counters and rates: turns the nested statistics the modules report (`node.stats()`) into
 * the flat `module.counter` totals and per-second rates of API.md section 6.8.
 *
 * The class has no timer: whoever owns it calls `sample()` (once a second in the diag
 * service), and both clocks are injected, so tests drive it with a fake one.
 */

import { ConfigError } from '../errors.js';

/** Most counters one snapshot reports; the nesting of `stats()` is small, this is a fuse. */
export const MAX_COUNTERS = 4096;

/** Deepest nesting followed when flattening. */
const MAX_DEPTH = 6;

/** Samples older than the window by more than this are dropped, in addition to the window. */
const SLACK_MS = 2000;

/** Most samples kept, whatever the clock does. */
const MAX_SAMPLES = 600;

/**
 * Flatten nested statistics to dotted names. Only non-negative safe integers count: a
 * float is a gauge such as an average and has no meaningful rate, booleans and strings
 * are not counters. A key that is not a plain name (it could be set by a remote party)
 * is skipped.
 *
 * @param {unknown} tree
 * @returns {Map<string, number>}
 */
export function flatten(tree) {
  const out = new Map();
  const walk = (value, prefix, depth) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || depth > MAX_DEPTH) return;
    for (const [key, entry] of Object.entries(value)) {
      if (out.size >= MAX_COUNTERS) return;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
      const name = prefix === '' ? key : `${prefix}.${key}`;
      if (Number.isSafeInteger(entry) && entry >= 0) out.set(name, entry);
      else walk(entry, name, depth + 1);
    }
  };
  walk(tree, '', 0);
  return out;
}

export class Counters {
  #source;
  #now;
  #windowMs;
  #startedAt;
  /** @type {Array<{ at: number, totals: Map<string, number> }>} oldest first */
  #samples = [];

  /**
   * @param {object} options
   * @param {() => object} options.source returns the nested statistics
   * @param {() => number} options.now wall clock in milliseconds
   * @param {number} [options.windowMs] the span rates are measured over, 1000 to one day
   * @throws {ConfigError} for an invalid option
   */
  constructor({ source, now, windowMs = 10000 } = {}) {
    if (typeof source !== 'function') throw new ConfigError('source must be a function');
    if (typeof now !== 'function') throw new ConfigError('now must be a function');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 86_400_000) {
      throw new ConfigError('windowMs must be an integer from 1000 to 86400000');
    }
    this.#source = source;
    this.#now = now;
    this.#windowMs = windowMs;
    this.#startedAt = now();
  }

  /**
   * Record the current totals. Call about once a second.
   *
   * @returns {void}
   */
  sample() {
    const at = this.#now();
    this.#samples.push({ at, totals: flatten(this.#source()) });
    const horizon = at - this.#windowMs - SLACK_MS;
    let drop = 0;
    while (drop < this.#samples.length - 1 && this.#samples[drop].at < horizon) drop += 1;
    if (this.#samples.length - drop > MAX_SAMPLES) drop = this.#samples.length - MAX_SAMPLES;
    if (drop > 0) this.#samples.splice(0, drop);
  }

  /**
   * @returns {{ at: number, uptimeMs: number, windowMs: number,
   *   totals: Record<string, number>, rates: Record<string, number> }} current totals, and
   *   for every counter that moved inside the window its change per second
   */
  snapshot() {
    const at = this.#now();
    const totals = flatten(this.#source());
    const rates = {};
    const from = this.#oldestInWindow(at);
    if (from !== null && at > from.at) {
      const seconds = (at - from.at) / 1000;
      for (const [name, total] of totals) {
        // A counter that went down was reset (a link closed, a module restarted): it has
        // no rate, and the next samples measure from the new value. One that did not exist
        // yet counts from zero.
        const delta = total - (from.totals.get(name) ?? 0);
        if (delta > 0) rates[name] = Math.round((delta / seconds) * 100) / 100;
      }
    }
    return {
      at,
      uptimeMs: Math.max(0, at - this.#startedAt),
      windowMs: this.#windowMs,
      totals: Object.fromEntries([...totals].sort(([a], [b]) => (a < b ? -1 : 1))),
      rates,
    };
  }

  /** The oldest sample that is still inside the window, or null when there is none. */
  #oldestInWindow(at) {
    for (const sample of this.#samples) {
      if (sample.at >= at - this.#windowMs) return sample;
    }
    return null;
  }
}
