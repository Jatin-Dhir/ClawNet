/**
 * Last-writer-wins dataset of the web core: a port of `LwwDataset` from the engine's
 * `src/sync/datasets.js`, with the same total order, bounds and sync contract, so that
 * the phone takes part in ClawSync for the `lsa` and `peer` datasets exactly as a node
 * does. The phone does not run the `cast` and `receipt` datasets; the protocol lets a
 * node decline a dataset it does not run (SYNC_REQUEST `stop: "set"`).
 *
 * Total order (DESIGN.md section 15, item 14): a higher version wins; at an equal version
 * the record with the greater SHA-256 of its canonical form wins. Digest entries are
 * `[key, version, first 16 hex characters of that hash]`, or `[key, version, 1]` for a
 * removed record (a floor).
 */

import { ProtocolError } from '../../src/core/errors.js';
import { Limits } from '../../src/core/wire/types.js';
import { toHex } from './bytes.js';
import { canonicalBytes, PACKET_PREFIX_BYTES } from './codec.js';
import { sha256 } from './primitives.js';

export const SET_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const DIGEST_HASH_CHARS = 16;
export const RECORD_OVERHEAD = PACKET_PREFIX_BYTES + 64 + 4;
export const MAX_RECORD = Limits.MAX_SYNC_PACKET - RECORD_OVERHEAD;

const DIGEST_HASH_PATTERN = /^[0-9a-f]{16}$/;
const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** A peer broke the sync protocol; `reason` is the engine's stable identifier. */
export class SyncFault extends ProtocolError {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export function isKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** @returns {string | null} lowercase hex SHA-256 of the canonical form, or null */
export function recordHash(record) {
  const measured = measure(record);
  return measured === null ? null : measured.hash;
}

function measure(record) {
  let bytes;
  try {
    bytes = canonicalBytes(record);
  } catch {
    return null;
  }
  return { hash: toHex(sha256(bytes)), size: bytes.length };
}

export class LwwDataset {
  #name;
  #keyOf;
  #versionOf;
  #check;
  #onAccept;
  #onEquivocation;
  #priority;
  #maxEntries;
  #held = new Map();
  #floors = new Map();
  #pins = new Set();
  #index = [];
  #victim = undefined;
  #summary = null;

  /**
   * @param {object} options the engine's LwwDataset options
   */
  constructor({ name, key, version, check, maxEntries, onAccept, onEquivocation, priority } = {}) {
    if (typeof name !== 'string' || !SET_NAME_PATTERN.test(name)) throw new TypeError('dataset name is malformed');
    for (const [label, fn] of [['key', key], ['version', version], ['check', check]]) {
      if (typeof fn !== 'function') throw new TypeError(`${label} must be a function`);
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    this.#name = name;
    this.#keyOf = key;
    this.#versionOf = version;
    this.#check = check;
    this.#maxEntries = maxEntries;
    this.#onAccept = onAccept;
    this.#onEquivocation = onEquivocation;
    this.#priority = priority;
  }

  get name() {
    return this.#name;
  }

  get size() {
    return this.#held.size;
  }

  /** @returns {{ accepted: boolean, isNew?: boolean, reason?: string, invalid?: boolean }} */
  offer(record, from) {
    const head = this.#head(record);
    if (head.reason !== undefined) return invalid(head.reason);
    const { key, version } = head;
    const current = this.#held.get(key);
    let measured = null;
    if (current !== undefined) {
      if (version < current.version) return ignored('stale');
      if (version === current.version) {
        measured = measure(record);
        if (measured === null) return invalid('malformed');
        if (measured.hash === current.hash) return ignored('duplicate');
        if (measured.hash < current.hash && current.equivocated) return ignored('stale');
      }
    } else {
      const floor = this.#floors.get(key);
      if (floor !== undefined && version <= floor) return ignored('removed');
      if (!this.#admits(key, version)) return ignored('full');
    }
    if (measured === null) {
      measured = measure(record);
      if (measured === null) return invalid('malformed');
    }
    if (measured.size > MAX_RECORD) return invalid('too-large');
    const { hash } = measured;
    const verdict = runCheck(this.#check, record);
    if (!verdict.ok) return verdict.soft ? ignored(verdict.reason) : invalid(verdict.reason);
    if (current !== undefined && version === current.version) return this.#settleTie(key, version, record, hash, current, from);
    if (current !== undefined) {
      current.record = record;
      current.version = version;
      current.hash = hash;
      current.equivocated = false;
    } else {
      if (this.#held.size >= this.#maxEntries) this.#evict();
      this.#held.set(key, { record, version, hash, equivocated: false });
      if (!this.#floors.delete(key)) insertSorted(this.#index, key);
    }
    this.#changed();
    const isNew = current === undefined;
    this.#onAccept?.(record, { isNew, from });
    return { accepted: true, isNew };
  }

  get(key) {
    return this.#held.get(key)?.record;
  }

  has(key) {
    return this.#held.has(key);
  }

  /** @returns {object[]} every record, ascending by key */
  values() {
    const out = [];
    for (const key of this.#index) {
      const entry = this.#held.get(key);
      if (entry !== undefined) out.push(entry.record);
    }
    return out;
  }

  /** Delete a record and keep its version as a floor (see the engine). */
  remove(key) {
    const entry = this.#held.get(key);
    if (entry === undefined) return false;
    this.#held.delete(key);
    this.#floors.set(key, entry.version);
    if (this.#floors.size > this.#maxEntries) {
      const oldest = this.#floors.keys().next().value;
      this.#floors.delete(oldest);
      removeSorted(this.#index, oldest);
    }
    this.#changed();
    return true;
  }

  forget(key) {
    if (!this.#floors.delete(key)) return false;
    removeSorted(this.#index, key);
    this.#changed();
    return true;
  }

  floorOf(key) {
    return this.#floors.get(key);
  }

  pin(key) {
    if (!isKey(key)) throw new TypeError('pin: key is malformed');
    this.#pins.add(key);
    this.#victim = undefined;
  }

  syncKnows(record) {
    const head = this.#head(record);
    if (head.reason !== undefined) return true;
    return this.#held.has(head.key) || this.#floors.has(head.key);
  }

  syncKey(record) {
    const head = this.#head(record);
    return head.reason === undefined ? head.key : null;
  }

  syncSummary() {
    if (this.#summary === null) {
      this.#summary = toHex(sha256(canonicalBytes(this.#index.map((key) => this.#entryOf(key)))));
    }
    return this.#summary;
  }

  syncPage(after, { maxEntries, maxBytes }) {
    const index = this.#index;
    const entries = [];
    let bytes = 2;
    let i = after === null ? 0 : upperBound(index, after);
    for (; i < index.length && entries.length < Math.max(1, maxEntries); i += 1) {
      const entry = this.#entryOf(index[i]);
      const size = JSON.stringify(entry).length + 1;
      if (entries.length > 0 && bytes + size > maxBytes) break;
      entries.push(entry);
      bytes += size;
    }
    const upto = i < index.length ? entries[entries.length - 1][0] : null;
    const hint = {};
    if (this.#held.size >= this.#maxEntries) hint.min = this.#evictionCandidate()?.version ?? Number.MAX_SAFE_INTEGER;
    return { after, upto, entries, hint };
  }

  syncCursor(value) {
    if (!isKey(value)) throw new SyncFault('bad-cursor', 'cursor is not a valid key');
    return value;
  }

  syncCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  syncReconcile(page, { push = true, pushAfter = null } = {}) {
    const min = checkLwwPage(page);
    return this.#reconcile(page, min, push, pushAfter);
  }

  syncServe(wants, page, upTo = null) {
    if (!Array.isArray(wants)) throw new SyncFault('bad-request', 'request is not a list');
    const entries = page.entries;
    let e = 0;
    let previous = null;
    for (const key of wants) {
      if (!isKey(key)) throw new SyncFault('bad-request', 'requested key is malformed');
      if (previous !== null && key <= previous) throw new SyncFault('bad-request', 'requested keys are not in ascending order');
      while (e < entries.length && entries[e][0] < key) e += 1;
      if (e === entries.length || entries[e][0] !== key || entries[e][2] === 1) {
        throw new SyncFault('bad-range', 'requested key was not advertised');
      }
      if (upTo !== null && key > upTo) throw new SyncFault('bad-range', 'requested key is beyond the continuation point');
      previous = key;
    }
    return this.#serve(wants);
  }

  syncConsumed(page, cursor) {
    let count = 0;
    for (const entry of page.entries) {
      if (entry[0] > cursor) break;
      count += 1;
    }
    return count;
  }

  #head(record) {
    if (!isPlainObject(record)) return { reason: 'malformed' };
    let key;
    let version;
    try {
      key = this.#keyOf(record);
      version = this.#versionOf(record);
    } catch {
      return { reason: 'malformed' };
    }
    if (!isKey(key)) return { reason: 'bad-key' };
    if (!Number.isSafeInteger(version) || version < 0) return { reason: 'bad-version' };
    return { key, version };
  }

  #settleTie(key, version, record, hash, current, from) {
    const report = !current.equivocated;
    const previous = current.record;
    const wins = hash > current.hash;
    current.equivocated = true;
    if (wins) {
      current.record = record;
      current.hash = hash;
      this.#changed();
    }
    if (report) this.#onEquivocation?.({ key, version, kept: wins ? record : previous, rejected: wins ? previous : record });
    if (!wins) return ignored('stale');
    this.#onAccept?.(record, { isNew: false, from });
    return { accepted: true, isNew: false };
  }

  #entryOf(key) {
    const held = this.#held.get(key);
    return held !== undefined ? [key, held.version, held.hash.slice(0, DIGEST_HASH_CHARS)] : [key, this.#floors.get(key), 1];
  }

  *#reconcile({ after, upto, entries }, min, push, pushAfter) {
    const index = this.#index;
    let i = after === null ? 0 : upperBound(index, after);
    let e = 0;
    for (;;) {
      const mine = i < index.length && (upto === null || index[i] <= upto) ? index[i] : null;
      const theirs = e < entries.length ? entries[e] : null;
      if (mine === null && theirs === null) return;
      if (theirs === null || (mine !== null && mine < theirs[0])) {
        if (!push || (pushAfter !== null && mine <= pushAfter)) {
          if (theirs === null && !push) return;
          let stop = theirs === null ? index.length : lowerBound(index, theirs[0]);
          if (push) stop = Math.min(stop, upperBound(index, pushAfter));
          i = Math.max(i + 1, stop);
          continue;
        }
        i += 1;
        const held = this.#held.get(mine);
        if (held !== undefined && (min === null || held.version > min)) yield { cursor: mine, push: held.record };
        continue;
      }
      e += 1;
      const [key, version, mark] = theirs;
      const tombstone = mark === 1;
      if (mine === key) i += 1;
      const held = this.#held.get(key);
      if (held !== undefined) {
        const order = tombstone ? held.version - version : compareRecord(held.version, held.hash, version, mark);
        if (order > 0) {
          if (push && (pushAfter === null || key > pushAfter)) yield { cursor: key, push: held.record };
        } else if (order < 0 && !tombstone) {
          yield { cursor: key, want: key };
        }
        continue;
      }
      if (tombstone) continue;
      const floor = this.#floors.get(key);
      if (floor !== undefined && version <= floor) continue;
      if (this.#admits(key, version)) yield { cursor: key, want: key };
    }
  }

  *#serve(wants) {
    for (const key of wants) {
      const held = this.#held.get(key);
      if (held !== undefined) yield { cursor: key, record: held.record };
    }
  }

  #changed() {
    this.#victim = undefined;
    this.#summary = null;
  }

  #admits(key, version) {
    if (this.#held.size < this.#maxEntries) return true;
    const victim = this.#evictionCandidate();
    if (victim === null) return false;
    if (this.#pins.has(key)) return true;
    const priority = this.#priorityOf(key);
    if (priority !== victim.priority) return priority > victim.priority;
    return version > victim.version;
  }

  #evict() {
    const victim = this.#evictionCandidate();
    this.#held.delete(victim.key);
    removeSorted(this.#index, victim.key);
    this.#changed();
  }

  #evictionCandidate() {
    if (this.#victim === undefined) {
      let best = null;
      for (const [key, entry] of this.#held) {
        if (this.#pins.has(key)) continue;
        const priority = this.#priorityOf(key);
        if (best === null || priority < best.priority || (priority === best.priority && (entry.version < best.version || (entry.version === best.version && key < best.key)))) {
          best = { key, version: entry.version, priority };
        }
      }
      this.#victim = best;
    }
    return this.#victim;
  }

  #priorityOf(key) {
    if (this.#priority === undefined) return 0;
    try {
      const value = this.#priority(key);
      return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
    } catch {
      return 0;
    }
  }
}

function checkLwwPage(page) {
  const { after, upto, entries, hint } = page;
  if (after !== null && !isKey(after)) throw new SyncFault('bad-cursor', 'page start is malformed');
  if (upto !== null && !isKey(upto)) throw new SyncFault('bad-cursor', 'page end is malformed');
  if (after !== null && upto !== null && after >= upto) throw new SyncFault('bad-cursor', 'page ends before it starts');
  if (!Array.isArray(entries)) throw new SyncFault('bad-digest', 'digest is not a list');
  let previous = after;
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !isKey(entry[0]) ||
      !Number.isSafeInteger(entry[1]) ||
      entry[1] < 0 ||
      (entry[2] !== 1 && !(typeof entry[2] === 'string' && DIGEST_HASH_PATTERN.test(entry[2])))
    ) {
      throw new SyncFault('bad-digest', 'digest entry is malformed');
    }
    if (previous !== null && entry[0] <= previous) throw new SyncFault('bad-digest', 'digest entries are not ascending inside the page');
    previous = entry[0];
  }
  if (upto !== null && entries.length > 0 && previous > upto) throw new SyncFault('bad-digest', 'digest entries run past the end of the page');
  if (!isPlainObject(hint)) throw new SyncFault('bad-hint', 'hint is not an object');
  for (const name of Object.keys(hint)) if (name !== 'min') throw new SyncFault('bad-hint', 'hint has an unknown field');
  if (hint.min === undefined) return null;
  if (!Number.isSafeInteger(hint.min) || hint.min < 0) throw new SyncFault('bad-hint', 'hint.min is not a version');
  return hint.min;
}

function compareRecord(version, hash, theirVersion, theirHash) {
  if (version !== theirVersion) return version < theirVersion ? -1 : 1;
  const prefix = hash.slice(0, DIGEST_HASH_CHARS);
  return prefix < theirHash ? -1 : prefix > theirHash ? 1 : 0;
}

function runCheck(check, record) {
  let verdict;
  try {
    verdict = check(record);
  } catch {
    return { ok: false, soft: false, reason: 'check-threw' };
  }
  if (verdict === null || typeof verdict !== 'object') return { ok: false, soft: false, reason: 'rejected' };
  if (verdict.ok === true) return { ok: true };
  const reason = typeof verdict.reason === 'string' && verdict.reason !== '' ? verdict.reason : 'rejected';
  return { ok: false, soft: verdict.soft === true, reason };
}

function ignored(reason) {
  return { accepted: false, reason };
}

function invalid(reason) {
  return { accepted: false, reason, invalid: true };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(sorted, value) {
  sorted.splice(lowerBound(sorted, value), 0, value);
}

function removeSorted(sorted, value) {
  const at = lowerBound(sorted, value);
  if (sorted[at] === value) sorted.splice(at, 1);
}
