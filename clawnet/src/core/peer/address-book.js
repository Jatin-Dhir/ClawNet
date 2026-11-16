/**
 * The address book (ARCHITECTURE.md 5.3): which addresses are worth dialing, which node
 * was last reached at each, and how the last attempts went.
 *
 * It is data and ordering only. It never dials and holds no timers; the peer manager
 * decides when to dial and calls back with the outcome. State persists through a
 * JsonFile of vault/store.js (or anything with the same interface, such as a Doc of
 * core/storage.js) holding `{ v: 1, entries: [...] }`. Everything loaded from that file
 * is validated entry by entry and anything malformed is dropped, so a damaged file costs
 * at most the entries it damaged. Losing the file loses nothing that discovery will not
 * find again.
 */

import { ConfigError } from '../errors.js';
import { isNodeId, validateAddress } from '../wire/schema.js';
import { Limits } from '../wire/types.js';

/** Where an address came from. `manual` and `bootstrap` make an entry static. */
export const AddressSource = Object.freeze({
  MANUAL: 'manual',
  BOOTSTRAP: 'bootstrap',
  MULTICAST: 'multicast',
  PEX: 'pex',
  HANDSHAKE: 'handshake',
});

/** Default bound on the number of entries. */
export const DEFAULT_MAX_ENTRIES = 4096;

/** Addresses remembered per NodeId (Limits.MAX_PEER_ADDRS). */
export const MAX_ADDRS_PER_ID = Limits.MAX_PEER_ADDRS;

/** A non-static entry with this many consecutive failures and no recent success is dropped. */
export const DROP_AFTER_FAILS = 10;

/** "Recent" for the drop rule above. */
export const DROP_SUCCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Addresses refused as our own for the rest of the process; bounded. */
const MAX_SELF_ADDRS = 256;

const SOURCES = new Set(Object.values(AddressSource));
const STATIC_SOURCES = new Set([AddressSource.MANUAL, AddressSource.BOOTSTRAP]);
const ERROR_PATTERN = /^[a-z-]{1,32}$/;
const MAX_TIME = Number.MAX_SAFE_INTEGER;

/**
 * @typedef {object} AddressEntry
 * @property {string} addr            "tcp://host:port"
 * @property {string | null} id       NodeId last reached at this address
 * @property {string[]} sources       sorted set of AddressSource values
 * @property {number} addedAt         ms
 * @property {number | null} lastOkAt  ms of the last successful link
 * @property {number | null} lastFailAt ms of the last failure
 * @property {number} fails           consecutive failures
 * @property {string | null} lastError reason of the last failure
 * @property {number} nextAttemptAt   ms before which the address is not offered; not persisted
 */

export class AddressBook {
  #doc;
  #now;
  #maxEntries;
  /** @type {Map<string, AddressEntry>} */
  #entries = new Map();
  #selfAddrs = new Set();
  #loaded = false;
  #saveQueued = false;

  /**
   * @param {object} options
   * @param {{ load(): Promise<unknown>, data: any, update(fn: (data: any) => void): void,
   *   flush(): Promise<void> }} options.doc a JsonFile (vault/store.js) with defaults
   *   `{ v: 1, entries: [] }`
   * @param {() => number} [options.now] wall clock in ms; default Date.now
   * @param {number} [options.maxEntries] default DEFAULT_MAX_ENTRIES
   * @throws {ConfigError} on invalid options
   */
  constructor({ doc, now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (doc === null || typeof doc !== 'object' || typeof doc.update !== 'function') {
      throw new ConfigError('doc must be a JsonFile-like document');
    }
    if (typeof now !== 'function') throw new ConfigError('now must be a function');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new ConfigError('maxEntries must be a positive integer');
    }
    this.#doc = doc;
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /**
   * Load the document and keep every valid entry in it.
   *
   * @returns {Promise<{ recovered: boolean, corruptPath: string | null, dropped: number }>}
   *   what the document reported about a corrupt file, and how many entries were invalid
   * @throws {import('../errors.js').StoreError} if the file cannot be read
   */
  async load() {
    const result = await this.#doc.load();
    let dropped = 0;
    const data = this.#doc.data;
    const list = data !== null && typeof data === 'object' && Array.isArray(data.entries) ? data.entries : [];
    for (const raw of list) {
      if (this.#entries.size >= this.#maxEntries) {
        dropped += 1;
        continue;
      }
      const entry = parseEntry(raw);
      if (entry === null || this.#entries.has(entry.addr)) {
        dropped += 1;
        continue;
      }
      this.#entries.set(entry.addr, entry);
    }
    for (const id of new Set([...this.#entries.values()].map(e => e.id).filter(Boolean))) {
      this.#trimAddressesOf(id);
    }
    this.#loaded = true;
    if (dropped > 0 || list !== data?.entries) this.#scheduleSave();
    return {
      recovered: Boolean(result?.recovered),
      corruptPath: result?.corruptPath ?? null,
      dropped,
    };
  }

  /** Write every change made so far. @returns {Promise<void>} */
  async flush() {
    this.#writeNow();
    await this.#doc.flush();
  }

  /** @returns {number} number of entries */
  get size() {
    return this.#entries.size;
  }

  /**
   * Remember an address.
   *
   * @param {string} addr
   * @param {{ id?: string | null, source: string }} options `id`: the node announced at it
   * @returns {boolean} true if the address is new. Invalid addresses, unknown sources and
   *   addresses marked as self are ignored (false).
   */
  add(addr, { id = null, source } = {}) {
    if (!validateAddress(addr).ok || !SOURCES.has(source) || this.#selfAddrs.has(addr)) return false;
    if (id !== null && !isNodeId(id)) return false;
    const existing = this.#entries.get(addr);
    if (existing !== undefined) {
      if (!existing.sources.includes(source)) {
        existing.sources = [...existing.sources, source].sort();
        this.#scheduleSave();
      }
      // A static entry's id is learned only by dialing it; an announced id does not move it.
      if (id !== null && existing.id === null) {
        existing.id = id;
        this.#trimAddressesOf(id);
        this.#scheduleSave();
      }
      return false;
    }
    const entry = {
      addr,
      id,
      sources: [source],
      addedAt: this.#now(),
      lastOkAt: null,
      lastFailAt: null,
      fails: 0,
      lastError: null,
      nextAttemptAt: 0,
    };
    this.#entries.set(addr, entry);
    if (id !== null) this.#trimAddressesOf(id);
    this.#evictIfFull();
    this.#scheduleSave();
    return this.#entries.has(addr);
  }

  /**
   * Replace the set of addresses that `source` gave for `id`: addresses no longer in the
   * list lose that source (and are removed when no source is left); new ones are added.
   *
   * @param {string} id NodeId
   * @param {string[]} addrs
   * @param {string} source
   */
  setAddressesFor(id, addrs, source) {
    if (!isNodeId(id) || !SOURCES.has(source) || !Array.isArray(addrs)) return;
    const wanted = new Set(addrs.slice(0, MAX_ADDRS_PER_ID).filter(a => validateAddress(a).ok));
    for (const entry of [...this.#entries.values()]) {
      if (entry.id !== id || !entry.sources.includes(source) || wanted.has(entry.addr)) continue;
      entry.sources = entry.sources.filter(s => s !== source);
      if (entry.sources.length === 0) this.#entries.delete(entry.addr);
      this.#scheduleSave();
    }
    for (const addr of wanted) this.add(addr, { id, source });
  }

  /**
   * A dial to `addr` reached node `id`: the address now belongs to that node.
   *
   * @param {string} addr
   * @param {string} id
   */
  bind(addr, id) {
    const entry = this.#entries.get(addr);
    if (entry === undefined || !isNodeId(id) || entry.id === id) return;
    entry.id = id;
    this.#trimAddressesOf(id);
    this.#scheduleSave();
  }

  /**
   * A link to `id` at `addr` came up and is known to be good: bind, reset the failure count.
   *
   * @param {string} addr
   * @param {string} id
   */
  markSuccess(addr, id) {
    const entry = this.#entries.get(addr);
    if (entry === undefined) return;
    if (isNodeId(id)) entry.id = id;
    entry.fails = 0;
    entry.lastOkAt = this.#now();
    entry.lastError = null;
    entry.nextAttemptAt = 0;
    if (isNodeId(id)) this.#trimAddressesOf(id);
    this.#scheduleSave();
  }

  /**
   * A link to `id` at `addr` came up: bind and record the time, but keep the failure count.
   * The count is reset only by markSuccess(), once the link has proved stable, so a link
   * that flaps still backs off further each time.
   *
   * @param {string} addr
   * @param {string} id
   */
  markReached(addr, id) {
    const entry = this.#entries.get(addr);
    if (entry === undefined) return;
    if (isNodeId(id)) entry.id = id;
    entry.lastOkAt = this.#now();
    if (isNodeId(id)) this.#trimAddressesOf(id);
    this.#scheduleSave();
  }

  /**
   * A dial to `addr` failed, or a link through it was lost. Increments the consecutive
   * failure count. A non-static entry with DROP_AFTER_FAILS failures whose last success
   * is unknown or older than a day is removed.
   *
   * @param {string} addr
   * @param {string} reason short machine-readable reason
   * @returns {number} the new failure count, or 0 if the address is unknown or was removed
   */
  markFailure(addr, reason) {
    const entry = this.#entries.get(addr);
    if (entry === undefined) return 0;
    const now = this.#now();
    entry.fails = Math.min(entry.fails + 1, 1_000_000);
    entry.lastFailAt = now;
    entry.lastError = typeof reason === 'string' && ERROR_PATTERN.test(reason) ? reason : 'unknown';
    this.#scheduleSave();
    const stale = entry.lastOkAt === null || entry.lastOkAt < now - DROP_SUCCESS_WINDOW_MS;
    if (!isStatic(entry) && entry.fails >= DROP_AFTER_FAILS && stale) {
      this.#entries.delete(addr);
      return 0;
    }
    return entry.fails;
  }

  /**
   * Do not offer `addr` as a candidate before `until`. Not persisted.
   *
   * @param {string} addr
   * @param {number} until ms
   */
  defer(addr, until) {
    const entry = this.#entries.get(addr);
    if (entry === undefined || !Number.isFinite(until)) return;
    entry.nextAttemptAt = Math.min(Math.max(0, Math.ceil(until)), MAX_TIME);
  }

  /**
   * Forget an address.
   *
   * @param {string} addr
   * @returns {boolean} whether it was known
   */
  remove(addr) {
    const removed = this.#entries.delete(addr);
    if (removed) this.#scheduleSave();
    return removed;
  }

  /**
   * `addr` turned out to be this node: remove it and refuse it for the rest of the process.
   *
   * @param {string} addr
   */
  markSelf(addr) {
    this.remove(addr);
    if (typeof addr !== 'string' || !validateAddress(addr).ok) return;
    if (this.#selfAddrs.size >= MAX_SELF_ADDRS) {
      this.#selfAddrs.delete(this.#selfAddrs.values().next().value);
    }
    this.#selfAddrs.add(addr);
  }

  /**
   * @param {string} addr
   * @returns {AddressEntry | null} a copy
   */
  get(addr) {
    const entry = this.#entries.get(addr);
    return entry === undefined ? null : copy(entry);
  }

  /**
   * @param {string} id
   * @returns {string[]} the addresses bound to that node
   */
  addressesOf(id) {
    const out = [];
    for (const entry of this.#entries.values()) if (entry.id === id) out.push(entry.addr);
    return out;
  }

  /** @returns {AddressEntry[]} copies of every entry */
  entries() {
    return [...this.#entries.values()].map(copy);
  }

  /**
   * Addresses worth dialing now.
   *
   * Qualify: `nextAttemptAt <= now()`, at least one source in `sources`, `id` not in
   * `exclude` (entries without an id always qualify), and at most one entry per known id
   * (the one with the fewest failures). Order: static first, then `prefer(id)`, then fewer
   * failures, then the most recent success, then the address.
   *
   * @param {object} [options]
   * @param {Iterable<string>} [options.exclude] NodeIds to leave out
   * @param {Iterable<string>} [options.sources] default: every source
   * @param {(id: string) => boolean} [options.prefer]
   * @param {(entry: AddressEntry) => boolean} [options.filter] further per-entry test
   * @param {number} [options.limit] default: no limit
   * @returns {AddressEntry[]} copies
   */
  candidates({ exclude = [], sources = SOURCES, prefer = () => false, filter = () => true, limit = Infinity } = {}) {
    const now = this.#now();
    const excluded = new Set(exclude);
    const wanted = new Set(sources);
    const bestPerId = new Map();
    const anonymous = [];
    for (const entry of this.#entries.values()) {
      if (entry.nextAttemptAt > now) continue;
      if (!entry.sources.some(s => wanted.has(s))) continue;
      if (entry.id !== null && excluded.has(entry.id)) continue;
      if (!filter(copy(entry))) continue;
      if (entry.id === null) {
        anonymous.push(entry);
        continue;
      }
      const best = bestPerId.get(entry.id);
      if (best === undefined || entry.fails < best.fails) bestPerId.set(entry.id, entry);
    }
    const preferred = entry => entry.id !== null && prefer(entry.id) === true;
    const list = [...anonymous, ...bestPerId.values()].sort((a, b) =>
      Number(isStatic(b)) - Number(isStatic(a)) ||
      Number(preferred(b)) - Number(preferred(a)) ||
      a.fails - b.fails ||
      (b.lastOkAt ?? -1) - (a.lastOkAt ?? -1) ||
      (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
    return list.slice(0, Math.max(0, limit)).map(copy);
  }

  /** Keep at most MAX_ADDRS_PER_ID addresses per node, dropping the oldest non-static. */
  #trimAddressesOf(id) {
    const mine = [...this.#entries.values()].filter(e => e.id === id && !isStatic(e));
    const statics = this.addressesOf(id).length - mine.length;
    let excess = statics + mine.length - MAX_ADDRS_PER_ID;
    if (excess <= 0) return;
    mine.sort((a, b) => a.addedAt - b.addedAt);
    for (const entry of mine) {
      if (excess <= 0) break;
      this.#entries.delete(entry.addr);
      excess -= 1;
    }
  }

  /** Evict down to maxEntries: never a static entry; most failures first, then never reached, then oldest success. */
  #evictIfFull() {
    while (this.#entries.size > this.#maxEntries) {
      let victim = null;
      for (const entry of this.#entries.values()) {
        if (isStatic(entry)) continue;
        if (
          victim === null ||
          entry.fails > victim.fails ||
          (entry.fails === victim.fails && (entry.lastOkAt ?? -1) < (victim.lastOkAt ?? -1))
        ) {
          victim = entry;
        }
      }
      if (victim === null) return;
      this.#entries.delete(victim.addr);
    }
  }

  /** Coalesce every change of one synchronous run into a single document update. */
  #scheduleSave() {
    if (!this.#loaded || this.#saveQueued) return;
    this.#saveQueued = true;
    queueMicrotask(() => this.#writeNow());
  }

  #writeNow() {
    if (!this.#loaded) return;
    this.#saveQueued = false;
    const entries = [...this.#entries.values()].map(persisted);
    this.#doc.update(data => {
      data.v = 1;
      data.entries = entries;
    });
  }
}

function isStatic(entry) {
  return entry.sources.some(s => STATIC_SOURCES.has(s));
}

function copy(entry) {
  return { ...entry, sources: [...entry.sources] };
}

function persisted(entry) {
  const { nextAttemptAt: _runtimeOnly, ...rest } = entry;
  return { ...rest, sources: [...entry.sources] };
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Validate one entry read from disk. @returns {AddressEntry | null} */
function parseEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { addr, id, sources, addedAt, lastOkAt, lastFailAt, fails, lastError } = raw;
  if (typeof addr !== 'string' || !validateAddress(addr).ok) return null;
  if (id !== null && !isNodeId(id)) return null;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > SOURCES.size) return null;
  if (!sources.every(s => typeof s === 'string' && SOURCES.has(s))) return null;
  if (new Set(sources).size !== sources.length) return null;
  if (!isTime(addedAt)) return null;
  if (lastOkAt !== null && !isTime(lastOkAt)) return null;
  if (lastFailAt !== null && !isTime(lastFailAt)) return null;
  if (!Number.isSafeInteger(fails) || fails < 0) return null;
  if (lastError !== null && (typeof lastError !== 'string' || !ERROR_PATTERN.test(lastError))) return null;
  return {
    addr,
    id,
    sources: [...sources].sort(),
    addedAt,
    lastOkAt,
    lastFailAt,
    fails,
    lastError,
    nextAttemptAt: 0,
  };
}
