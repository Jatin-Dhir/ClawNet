/**
 * ClawSync datasets (DESIGN.md section 9): the two shapes of replicated state.
 *
 *   - LwwDataset: one record per key, last writer wins (peer records, LSAs).
 *   - LogDataset: append-only sequences, one per stream (casts per channel and origin).
 *
 * Every record is a self-authenticating signed object, so a dataset never trusts the
 * peer that relayed it. Each dataset is given a `check` function that validates and
 * verifies a record, and nothing is stored that `check` has not passed. Cheap tests run
 * first: a record that is old, a duplicate, or outside the retention bounds is turned
 * away before `check`, so replays of known records cost no signature verification.
 *
 * Pure logic: no sockets, no timers, no clock. Memory is bounded by the limits given to
 * the constructor, whatever peers send.
 *
 * Besides the plain storage API, both classes implement the *sync contract* that
 * SyncEngine (antientropy.js) drives. Anything with these members can be synchronized:
 *
 *   name                         dataset name, SET_NAME_PATTERN
 *   offer(record, from?)         validate and store; returns an OfferResult
 *   syncKnows(record)            whether the record's key (LWW) or stream (log) is known
 *                                here; cheap, no signature work
 *   syncSummary()                hex SHA-256 of our whole digest, to skip equal datasets
 *   syncPage(after, limits)      our digest after a cursor, as one bounded page
 *   syncCursor(value)            validate a cursor received from a peer
 *   syncCompare(a, b)            order two cursors
 *   syncReconcile(page, options) compare a peer's page with our state, lazily
 *   syncServe(wants, page, upTo) answer a peer's request against a page we sent
 *   syncConsumed(page, cursor)   how many entries of a page lie at or before a cursor
 *   syncKey(record)              optional: the key a flood hold-down applies to
 *
 * A *cursor* is a position in the dataset's total order (a key for LWW data, a
 * `[stream, index]` pair for logs). A *page* is `{ after, upto, entries, hint }`: the
 * digest entries strictly after `after` up to and including `upto`, where `null` means
 * "from the start" and "to the end". A page is a complete statement about its range: its
 * sender holds exactly what the entries list there, which is what lets the receiver deal
 * with each page on its own. The wire form is specified in SYNC-WIRE.md.
 *
 * Order is defined on strings by UTF-16 code unit. Keys and stream ids are restricted to
 * printable ASCII so that this is plain byte order in every implementation.
 */

import { sha256 } from '../core/crypto/primitives.js';
import { CanonicalError, ConfigError, ProtocolError, StateError } from '../core/errors.js';
import { canonicalBytes } from '../core/wire/canonical.js';

/** Dataset names: lowercase, 1..32 characters. They travel in every sync packet header. */
export const SET_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Hex characters of a record hash carried by an LWW digest entry: the first 8 bytes of
 * the SHA-256 of the record's canonical form (DESIGN.md section 15, item 14).
 */
export const DIGEST_HASH_CHARS = 16;

/** A digest hash: DIGEST_HASH_CHARS lowercase hex characters. */
const DIGEST_HASH_PATTERN = /^[0-9a-f]{16}$/;

/**
 * SHA-256 of a record's canonical JSON form, as lowercase hex. This is the tie-break of
 * the total order of LWW records and what digests abbreviate.
 *
 * @param {unknown} record
 * @returns {string | null} 64 hex characters, or null if the record is not canonical-JSON
 *   data
 */
export function recordHash(record) {
  try {
    return sha256(canonicalBytes(record)).toString('hex');
  } catch (err) {
    if (err instanceof CanonicalError) return null;
    throw err;
  }
}

/** Longest key or stream id, in characters. */
export const MAX_KEY_LENGTH = 128;

/** Largest log index, and the index part of a cursor that covers a whole stream. */
export const MAX_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * Most out-of-order ranges one entry of a log digest page lists. A stream with more is
 * spread over several pages, each continuing inside the stream where the last one ended.
 */
export const MAX_RANGES = 32;

/** Records `LogDataset.diff` returns in `have` unless the caller asks for another cap. */
export const DEFAULT_MAX_HAVE = 1024;

/** Printable ASCII without the space, 1..MAX_KEY_LENGTH characters. */
const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Input from a peer broke the sync protocol. `reason` is a short stable identifier that
 * is safe to log and to send in a BYE; `message` adds detail for the operator.
 */
export class SyncFault extends ProtocolError {
  /**
   * @param {string} reason  stable identifier, e.g. "bad-digest", "bad-range"
   * @param {string} message human-readable detail; never echoes peer-chosen bytes
   */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * @typedef {object} OfferResult
 * @property {boolean} accepted  the record is now stored
 * @property {boolean} [isNew]   with `accepted`: nothing was stored under this key before
 * @property {number} [selfNewer] log only: the record belongs to one of our own streams,
 *   came from a peer and lies at or above the newest index we knew there; our counter
 *   for that stream must move past it (DESIGN.md section 15, item 16)
 * @property {string} [reason]   why it was not stored: "duplicate", "stale", "removed",
 *   "full", "pruned", "streams-full", "malformed", "bad-key", "bad-version", "bad-stream",
 *   "bad-index", "check-threw", or the reason `check` gave
 * @property {boolean} [invalid] the record is malformed or failed `check`: a correct peer
 *   would not have relayed it
 */

/**
 * @typedef {object} CheckVerdict
 * @property {boolean} ok        the record is well-formed and its signature verifies
 * @property {string} [reason]   short stable reason when not ok
 * @property {boolean} [soft]    not ok, but through no fault of the relaying peer (expired
 *   here, rate limited here, not wanted here): drop it quietly instead of reporting it
 */

/**
 * @typedef {object} Page
 * @property {unknown} after     cursor the page starts after, or null for the start
 * @property {unknown} upto      cursor the page ends at (inclusive), or null for the end
 * @property {unknown[]} entries digest entries in ascending order
 * @property {object} hint       what the sender of the page can still accept
 */

/**
 * @typedef {object} ReconcileStep
 * @property {unknown} cursor   position this step completes; steps ascend strictly
 * @property {object} [push]    a record of ours the peer lacks
 * @property {unknown} [want]   a request item for something the peer has and we lack
 */

/**
 * True for a string usable as an LWW key or a log stream id.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * Last-writer-wins dataset: one record per key, totally ordered (DESIGN.md section 15,
 * item 14). The higher version wins; at an equal version the record whose canonical
 * SHA-256 is greater wins and is accepted, so the engine floods it again and every node
 * ends up holding the same one. Two valid records with one version under one key are
 * equivocation, reported through `onEquivocation`.
 *
 * Bounds and retention, all deterministic so that two nodes with the same contents make
 * the same decisions and never trade a record back and forth:
 *
 *   - At most `maxEntries` records. When a record for a new key arrives at capacity, the
 *     unpinned record of lowest priority (then lowest version, then lowest key) is evicted
 *     to make room, but only if the newcomer's key is pinned, has a higher priority, or
 *     has the same priority and a strictly higher version. Otherwise the newcomer is
 *     refused with reason "full". Pinned keys are never evicted. Without a `priority`
 *     function every key has the same priority. While full, the version of the next
 *     eviction candidate is advertised to peers as a watermark (`hint.min`) so they do
 *     not offer records that would be refused.
 *   - `remove(key)` deletes a record and remembers its version as a *floor*: the removed
 *     version and anything older is refused ("removed") and never requested, so a peer
 *     that still holds it cannot bring it back; a strictly newer version is accepted as
 *     usual. Floors are advertised as tombstone entries so peers stop offering the
 *     record. At most `maxEntries` floors are kept, oldest forgotten first.
 */
export class LwwDataset {
  #name;
  #keyOf;
  #versionOf;
  #check;
  #onAccept;
  #onEquivocation;
  #priority;
  #maxEntries;
  /**
   * key -> { record, version, hash, equivocated }. `hash` is recordHash(record);
   * `equivocated` is set once a second valid record with this version was reported.
   */
  #held = new Map();
  /** key -> version of a removed record. Insertion order is age, oldest first. */
  #floors = new Map();
  #pins = new Set();
  /** Every key of #held and #floors, ascending. A key is never in both maps. */
  #index = [];
  /** Cached eviction candidate: undefined = not computed, null = every record is pinned. */
  #victim = undefined;
  /** Cached syncSummary(), null when the contents changed since. */
  #summary = null;

  /**
   * @param {object} options
   * @param {string} options.name  dataset name, SET_NAME_PATTERN
   * @param {(record: object) => string} options.key  key of a record: 1..128 printable
   *   ASCII characters without spaces. Called on unverified input; must not have side
   *   effects. A throw or any other return value marks the record invalid.
   * @param {(record: object) => number} options.version  version of a record: a safe
   *   integer >= 0. Same rules as `key`.
   * @param {(record: object) => CheckVerdict} options.check  full validation, signature
   *   included. Anything but `{ ok: true }` refuses the record; a throw refuses it too.
   * @param {number} options.maxEntries  most records held, >= 1
   * @param {(record: object, info: { isNew: boolean, from: string | undefined }) => void}
   *   [options.onAccept]  called after a record is stored; `isNew` is false when it
   *   replaced another record; `from` is whatever was passed to offer(). Must not throw.
   * @param {(event: { key: string, version: number, kept: object, rejected: object }) => void}
   *   [options.onEquivocation]  called once per key and version when two valid records
   *   share them; `kept` is the one with the greater hash. Must not throw.
   * @param {(key: string) => number} [options.priority]  value of keeping a key when
   *   the dataset is full, higher is kept longer: for example 1 for an origin attached
   *   to the confirmed graph and 0 otherwise (DESIGN.md section 15, item 19). Called on
   *   keys of unverified records; must be cheap and must not throw. Call
   *   priorityChanged() when its answers change.
   * @throws {ConfigError} if an option is missing or out of range
   */
  constructor({ name, key, version, check, maxEntries, onAccept, onEquivocation, priority } = {}) {
    this.#name = requireName(name);
    this.#keyOf = requireFunction(key, 'key');
    this.#versionOf = requireFunction(version, 'version');
    this.#check = requireFunction(check, 'check');
    this.#maxEntries = requireCount(maxEntries, 'maxEntries');
    this.#onAccept = optionalFunction(onAccept, 'onAccept');
    this.#onEquivocation = optionalFunction(onEquivocation, 'onEquivocation');
    this.#priority = optionalFunction(priority, 'priority');
  }

  /** @returns {string} the dataset name */
  get name() {
    return this.#name;
  }

  /** @returns {number} records currently held */
  get size() {
    return this.#held.size;
  }

  /**
   * Validate a record and store it if it comes later in the total order than what is
   * held under its key.
   *
   * @param {unknown} record  a signed record, straight from a peer or from this node
   * @param {string} [from]   who relayed it (a peer id), passed through to onAccept
   * @returns {OfferResult}
   */
  offer(record, from) {
    const head = this.#head(record);
    if (head.reason !== undefined) return invalid(head.reason);
    const { key, version } = head;

    const current = this.#held.get(key);
    let hash = null;
    if (current !== undefined) {
      if (version < current.version) return ignored('stale');
      if (version === current.version) {
        hash = recordHash(record);
        if (hash === null) return invalid('malformed');
        if (hash === current.hash) return ignored('duplicate');
        // A loser once the equivocation is known costs no further check.
        if (hash < current.hash && current.equivocated) return ignored('stale');
      }
    } else {
      const floor = this.#floors.get(key);
      if (floor !== undefined && version <= floor) return ignored('removed');
      if (!this.#admits(key, version)) return ignored('full');
    }
    if (hash === null) {
      hash = recordHash(record);
      if (hash === null) return invalid('malformed');
    }

    const verdict = runCheck(this.#check, record);
    if (!verdict.ok) return verdict.soft ? ignored(verdict.reason) : invalid(verdict.reason);

    if (current !== undefined && version === current.version) {
      return this.#settleTie(key, version, record, hash, current, from);
    }
    if (current !== undefined) {
      current.record = record;
      current.version = version;
      current.hash = hash;
      current.equivocated = false;
    } else {
      if (this.#held.size >= this.#maxEntries) this.#evict();
      this.#held.set(key, { record, version, hash, equivocated: false });
      // A key that had a floor is already in the index.
      if (!this.#floors.delete(key)) insertSorted(this.#index, key);
    }
    this.#changed();
    const isNew = current === undefined;
    if (this.#onAccept !== undefined) this.#onAccept(record, { isNew, from });
    return { accepted: true, isNew };
  }

  /**
   * @param {string} key
   * @returns {object | undefined} the record held under `key`
   */
  get(key) {
    return this.#held.get(key)?.record;
  }

  /**
   * @param {string} key
   * @returns {boolean} whether a record is held under `key`
   */
  has(key) {
    return this.#held.has(key);
  }

  /**
   * @returns {object[]} a snapshot of every record held, ascending by key
   */
  values() {
    const out = [];
    for (const key of this.#index) {
      const entry = this.#held.get(key);
      if (entry !== undefined) out.push(entry.record);
    }
    return out;
  }

  /**
   * @returns {Array<[string, number, string]>} `[key, version, hash]` for every record
   *   held, ascending by key; `hash` is the first DIGEST_HASH_CHARS hex characters of
   *   recordHash(record)
   */
  digest() {
    const out = [];
    for (const key of this.#index) {
      const entry = this.#held.get(key);
      if (entry !== undefined) out.push(recordEntry(key, entry));
    }
    return out;
  }

  /**
   * Compare a complete remote digest with this dataset.
   *
   * @param {unknown} remoteDigest  entries as digest() produces them, ascending by key;
   *   `[key, version, 1]` marks a key the remote removed (see SYNC-WIRE.md)
   * @returns {{ missingHere: string[], missingThere: object[] }} keys the remote holds in
   *   a later version than we do (and that we could store), and the records we hold that
   *   the remote lacks or holds in an earlier version
   * @throws {SyncFault} if the digest is malformed or not in ascending order
   */
  diff(remoteDigest) {
    const missingHere = [];
    const missingThere = [];
    const page = { after: null, upto: null, entries: remoteDigest, hint: {} };
    for (const step of this.syncReconcile(page)) {
      if (step.push !== undefined) missingThere.push(step.push);
      else missingHere.push(step.want);
    }
    return { missingHere, missingThere };
  }

  /**
   * Delete a record and remember its version as a floor (see the class description).
   *
   * @param {string} key
   * @returns {boolean} whether a record was held under `key`
   */
  remove(key) {
    const entry = this.#held.get(key);
    if (entry === undefined) return false;
    this.#held.delete(key);
    // The key stays in the index: it now names a floor.
    this.#floors.set(key, entry.version);
    if (this.#floors.size > this.#maxEntries) {
      const oldest = this.#floors.keys().next().value;
      this.#floors.delete(oldest);
      removeSorted(this.#index, oldest);
    }
    this.#changed();
    return true;
  }

  /**
   * Drop the floor left by remove(), so that any version of `key` is acceptable again.
   *
   * @param {string} key
   * @returns {boolean} whether a floor existed
   */
  forget(key) {
    if (!this.#floors.delete(key)) return false;
    removeSorted(this.#index, key);
    this.#changed();
    return true;
  }

  /**
   * @param {string} key
   * @returns {number | undefined} the version remembered by remove(), if any
   */
  floorOf(key) {
    return this.#floors.get(key);
  }

  /**
   * Protect a key from eviction. The key need not be held yet; a pinned key is always
   * admitted, evicting an unpinned record if the dataset is full.
   *
   * @param {string} key
   * @throws {ConfigError} if `key` is not a valid key
   * @throws {StateError} if `maxEntries` keys are pinned already
   */
  pin(key) {
    if (!isKey(key)) throw new ConfigError('pin: key must be 1..128 printable ASCII characters');
    if (this.#pins.has(key)) return;
    if (this.#pins.size >= this.#maxEntries) {
      throw new StateError(`cannot pin more than maxEntries (${this.#maxEntries}) keys`);
    }
    this.#pins.add(key);
    this.#victim = undefined;
  }

  /**
   * Remove the protection given by pin().
   *
   * @param {string} key
   * @returns {boolean} whether the key was pinned
   */
  unpin(key) {
    const was = this.#pins.delete(key);
    if (was) this.#victim = undefined;
    return was;
  }

  /**
   * @param {string} key
   * @returns {boolean} whether the key is pinned
   */
  isPinned(key) {
    return this.#pins.has(key);
  }

  /**
   * Drop the cached eviction choice. Call when the answers of the `priority` function
   * change (for example when the routing graph changed).
   */
  priorityChanged() {
    this.#victim = undefined;
  }

  /**
   * Sync contract: whether the record's key is known here, held or removed. Malformed
   * records count as known, so that offer() reports them.
   *
   * @param {unknown} record
   * @returns {boolean}
   */
  syncKnows(record) {
    const head = this.#head(record);
    if (head.reason !== undefined) return true;
    return this.#held.has(head.key) || this.#floors.has(head.key);
  }

  /**
   * Sync contract: the key a flood hold-down applies to.
   *
   * @param {unknown} record  a record this dataset accepted
   * @returns {string | null} null if the record has no valid key
   */
  syncKey(record) {
    const head = this.#head(record);
    return head.reason === undefined ? head.key : null;
  }

  /**
   * Sync contract: hex SHA-256 of the canonical JSON list of every digest entry, records
   * and tombstones, ascending: exactly the entries the pages of a whole round would list.
   * Two datasets with the same summary have nothing to exchange. Cached until the
   * contents change.
   *
   * @returns {string}
   */
  syncSummary() {
    if (this.#summary === null) {
      const entries = this.#index.map((key) => this.#entryOf(key));
      this.#summary = sha256(canonicalBytes(entries)).toString('hex');
    }
    return this.#summary;
  }

  /**
   * Sync contract: one page of our digest.
   *
   * Entries are `[key, version, hash]` for a record and `[key, version, 1]` for a floor.
   * The first entry is always included, so a page makes progress whatever the limits are.
   *
   * @param {string | null} after  cursor to start after, or null for the start
   * @param {{ maxEntries: number, maxBytes: number }} limits  most entries, and most bytes
   *   of their canonical JSON encoding
   * @returns {Page}
   */
  syncPage(after, { maxEntries, maxBytes }) {
    const index = this.#index;
    const entries = [];
    let bytes = 2;
    let i = after === null ? 0 : upperBound(index, after);
    for (; i < index.length && entries.length < Math.max(1, maxEntries); i += 1) {
      const entry = this.#entryOf(index[i]);
      const size = entryBytes(entry);
      if (entries.length > 0 && bytes + size > maxBytes) break;
      entries.push(entry);
      bytes += size;
    }
    const upto = i < index.length ? entries[entries.length - 1][0] : null;
    const hint = {};
    if (this.#held.size >= this.#maxEntries) {
      // With every record pinned nothing can be evicted, so nothing new is acceptable.
      hint.min = this.#evictionCandidate()?.version ?? Number.MAX_SAFE_INTEGER;
    }
    return { after, upto, entries, hint };
  }

  /**
   * Sync contract: validate a cursor received from a peer.
   *
   * @param {unknown} value
   * @returns {string}
   * @throws {SyncFault} reason "bad-cursor"
   */
  syncCursor(value) {
    if (!isKey(value)) throw new SyncFault('bad-cursor', 'cursor is not a valid key');
    return value;
  }

  /**
   * Sync contract: order two cursors.
   *
   * @param {string} a
   * @param {string} b
   * @returns {number} negative, zero or positive as `a` is before, at or after `b`
   */
  syncCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Sync contract: compare a peer's page with our state.
   *
   * The page is validated in full before anything is returned. The result is lazy and
   * reads live state: consume it before the dataset changes. Steps come in ascending key
   * order; a step either pushes a record the peer lacks or names a key we want.
   *
   * @param {Page} page  the peer's page; `hint.min` (optional) is the lowest version the
   *   peer can still accept for a key it does not hold
   * @param {object} [options]
   * @param {boolean} [options.push=true]  false to produce wants only
   * @param {string | null} [options.pushAfter=null]  push only keys after this cursor
   * @returns {Iterable<ReconcileStep>}
   * @throws {SyncFault} "bad-digest", "bad-cursor" or "bad-hint"
   */
  syncReconcile(page, { push = true, pushAfter = null } = {}) {
    const min = checkLwwPage(page);
    return this.#reconcile(page, min, push, pushAfter);
  }

  /**
   * Sync contract: answer a peer's request against a page we sent.
   *
   * A peer may only ask for keys that the page advertised as records, at or before the
   * point it says it processed. Keys we no longer hold are skipped.
   *
   * @param {unknown} wants  keys in ascending order
   * @param {Page} page      the page we sent, as syncPage() returned it
   * @param {string | null} [upTo=null]  the peer's continuation cursor, null for the
   *   whole page
   * @returns {Iterable<{ cursor: string, record: object }>}
   * @throws {SyncFault} "bad-request" or "bad-range"
   */
  syncServe(wants, page, upTo = null) {
    if (!Array.isArray(wants)) throw new SyncFault('bad-request', 'request is not a list');
    const entries = page.entries;
    let e = 0;
    let previous = null;
    for (const key of wants) {
      if (!isKey(key)) throw new SyncFault('bad-request', 'requested key is malformed');
      if (previous !== null && key <= previous) {
        throw new SyncFault('bad-request', 'requested keys are not in ascending order');
      }
      while (e < entries.length && entries[e][0] < key) e += 1;
      if (e === entries.length || entries[e][0] !== key || entries[e][2] === 1) {
        throw new SyncFault('bad-range', 'requested key was not advertised');
      }
      if (upTo !== null && key > upTo) {
        throw new SyncFault('bad-range', 'requested key is beyond the continuation point');
      }
      previous = key;
    }
    return this.#serve(wants);
  }

  /**
   * Sync contract: how many entries of `page` lie at or before `cursor`.
   *
   * @param {Page} page
   * @param {string} cursor
   * @returns {number}
   */
  syncConsumed(page, cursor) {
    let count = 0;
    for (const entry of page.entries) {
      if (entry[0] > cursor) break;
      count += 1;
    }
    return count;
  }

  /** Key and version of a record, or the reason it is invalid. */
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
    if (!isVersion(version)) return { reason: 'bad-version' };
    return { key, version };
  }

  /** A verified record with the same version as the one held, and a different hash. */
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
    if (report && this.#onEquivocation !== undefined) {
      this.#onEquivocation(
        Object.freeze({
          key,
          version,
          kept: wins ? record : previous,
          rejected: wins ? previous : record,
        }),
      );
    }
    if (!wins) return ignored('stale');
    if (this.#onAccept !== undefined) this.#onAccept(record, { isNew: false, from });
    return { accepted: true, isNew: false };
  }

  /** The digest entry of a key of the index: a record or a floor. */
  #entryOf(key) {
    const held = this.#held.get(key);
    return held !== undefined ? recordEntry(key, held) : [key, this.#floors.get(key), 1];
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
        // The peer did not list this key: it lacks the record.
        if (!push || (pushAfter !== null && mine <= pushAfter)) {
          // Nothing can be pushed before the push cursor or, without pushes, before the
          // next key the peer listed. Jump there instead of walking our keys one by one,
          // so that a digest replayed by a peer costs next to nothing.
          if (theirs === null && !push) return;
          let stop = theirs === null ? index.length : lowerBound(index, theirs[0]);
          if (push) stop = Math.min(stop, upperBound(index, pushAfter));
          i = Math.max(i + 1, stop);
          continue;
        }
        i += 1;
        const held = this.#held.get(mine);
        if (held !== undefined && (min === null || held.version > min)) {
          yield { cursor: mine, push: held.record };
        }
        continue;
      }

      e += 1;
      const [key, version, mark] = theirs;
      const tombstone = mark === 1;
      if (mine === key) i += 1;

      const held = this.#held.get(key);
      if (held !== undefined) {
        // Records compare by (version, hash prefix); a tombstone by version alone.
        const order = tombstone
          ? held.version - version
          : compareRecord(held.version, held.hash, version, mark);
        if (order > 0) {
          if (push && (pushAfter === null || key > pushAfter)) {
            yield { cursor: key, push: held.record };
          }
        } else if (order < 0 && !tombstone) {
          yield { cursor: key, want: key };
        }
        continue;
      }
      if (tombstone) continue;
      const floor = this.#floors.get(key);
      if (floor !== undefined && version <= floor) continue;
      // At capacity, only ask for what would win a place under the eviction rule.
      if (this.#admits(key, version)) yield { cursor: key, want: key };
    }
  }

  *#serve(wants) {
    for (const key of wants) {
      const held = this.#held.get(key);
      if (held !== undefined) yield { cursor: key, record: held.record };
    }
  }

  /** The contents changed: cached answers that depend on them are stale. */
  #changed() {
    this.#victim = undefined;
    this.#summary = null;
  }

  /** Whether a record for a key we do not hold could be stored right now. */
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

  /**
   * The unpinned record of lowest priority, then lowest version, then lowest key; or
   * null. Cached until the contents, the pins or the priorities change.
   */
  #evictionCandidate() {
    if (this.#victim === undefined) {
      let best = null;
      for (const [key, entry] of this.#held) {
        if (this.#pins.has(key)) continue;
        const priority = this.#priorityOf(key);
        if (
          best === null ||
          priority < best.priority ||
          (priority === best.priority &&
            (entry.version < best.version || (entry.version === best.version && key < best.key)))
        ) {
          best = { key, version: entry.version, priority };
        }
      }
      this.#victim = best;
    }
    return this.#victim;
  }

  #priorityOf(key) {
    if (this.#priority === undefined) return 0;
    let value;
    try {
      value = this.#priority(key);
    } catch {
      return 0;
    }
    return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
  }
}

/**
 * Append-only log dataset: per stream, records numbered from 1.
 *
 * Records may arrive in any order. Per stream the dataset tracks
 *
 *   floor  indices at or below it are pruned: never held, never accepted, never requested;
 *   high   the contiguous high-water mark: every index in (floor, high] is held;
 *   top    the newest index seen;
 *
 * and the held indices above `high`, which are the out-of-order arrivals.
 *
 * Retention is a sliding window: a stream keeps the `maxPerStream` indices ending at its
 * newest one, i.e. `floor = max(floor, top - maxPerStream)`. The floor only ever rises,
 * and it is part of the digest, so a pruned index is never asked for again and peers do
 * not offer it. The window size is advertised too (`hint.win`), so a peer with a longer
 * memory sends only what this node will keep.
 *
 * At most `maxStreams` streams are tracked. A record for a new stream beyond that is
 * refused with reason "streams-full": dropping a stream loses its floor, and the stream
 * would be fetched again, so by default nothing is evicted. With a `priority` function a
 * newcomer whose stream ranks strictly higher than the lowest-ranked stream held takes
 * that stream's place (DESIGN.md section 15, item 19). While full, the digest carries
 * `hint.full` so peers do not offer unknown streams. The owner frees a slot with
 * dropStream().
 *
 * With `ownStream`, the dataset knows which streams this node writes. A record of one of
 * them that arrives from a peer at or above the newest index we knew there is reported
 * (`selfNewer`, `onSelfNewer`): our counter must jump past it (section 15, item 16).
 */
export class LogDataset {
  #name;
  #streamOf;
  #indexOf;
  #check;
  #onAccept;
  #ownStream;
  #onSelfNewer;
  #priority;
  #maxPerStream;
  #maxStreams;
  /** Cached eviction candidate: undefined = not computed, null = no stream held. */
  #victim = undefined;
  /** Cached syncSummary(), null when the contents changed since. */
  #summary = null;
  /**
   * stream -> { floor, high, top, held: Map<index, record>, above: number[] }
   * `above` lists the held indices greater than `high`, ascending.
   */
  #streams = new Map();
  /** Stream ids, ascending. */
  #index = [];
  #size = 0;

  /**
   * @param {object} options
   * @param {string} options.name  dataset name, SET_NAME_PATTERN
   * @param {(record: object) => string} options.stream  stream id of a record: 1..128
   *   printable ASCII characters without spaces. Called on unverified input; must not
   *   have side effects. A throw or any other return value marks the record invalid.
   * @param {(record: object) => number} options.index  position of a record in its
   *   stream: a safe integer >= 1. Same rules as `stream`.
   * @param {(record: object) => CheckVerdict} options.check  full validation, signature
   *   included. Anything but `{ ok: true }` refuses the record; a throw refuses it too.
   * @param {number} options.maxPerStream  retention window per stream, >= 1
   * @param {number} options.maxStreams    most streams tracked, >= 1
   * @param {(record: object, info: { isNew: boolean, from: string | undefined }) => void}
   *   [options.onAccept]  called after a record is stored; `isNew` is always true for a
   *   log. Must not throw.
   * @param {(stream: string) => boolean} [options.ownStream]  true for the streams this
   *   node writes itself
   * @param {(event: { stream: string, index: number, record: object }) => void}
   *   [options.onSelfNewer]  told when a peer delivers a valid record of one of our own
   *   streams at or above the newest index we knew there. Must not throw.
   * @param {(stream: string) => number} [options.priority]  value of keeping a stream
   *   when maxStreams are tracked; without it a full dataset refuses new streams. Must
   *   be cheap and must not throw. Call priorityChanged() when its answers change.
   * @throws {ConfigError} if an option is missing or out of range
   */
  constructor({
    name,
    stream,
    index,
    check,
    maxPerStream,
    maxStreams,
    onAccept,
    ownStream,
    onSelfNewer,
    priority,
  } = {}) {
    this.#name = requireName(name);
    this.#streamOf = requireFunction(stream, 'stream');
    this.#indexOf = requireFunction(index, 'index');
    this.#check = requireFunction(check, 'check');
    this.#maxPerStream = requireCount(maxPerStream, 'maxPerStream');
    this.#maxStreams = requireCount(maxStreams, 'maxStreams');
    this.#onAccept = optionalFunction(onAccept, 'onAccept');
    this.#ownStream = optionalFunction(ownStream, 'ownStream');
    this.#onSelfNewer = optionalFunction(onSelfNewer, 'onSelfNewer');
    this.#priority = optionalFunction(priority, 'priority');
  }

  /** @returns {string} the dataset name */
  get name() {
    return this.#name;
  }

  /** @returns {number} records currently held, over all streams */
  get size() {
    return this.#size;
  }

  /** @returns {number} streams currently tracked */
  get streamCount() {
    return this.#streams.size;
  }

  /**
   * Validate a record and store it unless its index is already held or pruned.
   *
   * @param {unknown} record  a signed record, straight from a peer or from this node
   * @param {string} [from]   who relayed it (a peer id), passed through to onAccept
   * @returns {OfferResult}
   */
  offer(record, from) {
    const head = this.#head(record);
    if (head.reason !== undefined) return invalid(head.reason);
    const { stream, index } = head;

    let state = this.#streams.get(stream);
    let victim = null;
    if (state !== undefined) {
      if (index <= state.floor) return ignored('pruned');
      if (state.held.has(index)) return ignored('duplicate');
    } else if (this.#streams.size >= this.#maxStreams) {
      victim = this.#streamVictim(stream);
      if (victim === null) return ignored('streams-full');
    }

    const verdict = runCheck(this.#check, record);
    if (!verdict.ok) return verdict.soft ? ignored(verdict.reason) : invalid(verdict.reason);

    // Our own stream from a peer at or above what we knew: someone holds records of
    // ours that this node has lost track of, typically after a restart.
    const knownTop = state === undefined ? 0 : state.top;
    const selfNewer =
      from !== undefined && index >= knownTop && this.#ownStream?.(stream) === true;

    if (victim !== null) this.dropStream(victim);
    if (state === undefined) state = this.#open(stream);
    this.#changed();
    state.held.set(index, record);
    this.#size += 1;
    if (index === state.high + 1) {
      state.high = index;
      absorb(state);
    } else {
      insertSorted(state.above, index);
    }
    if (index > state.top) {
      state.top = index;
      const floor = index - this.#maxPerStream;
      if (floor > state.floor) this.#raise(state, floor);
    }
    if (this.#onAccept !== undefined) this.#onAccept(record, { isNew: true, from });
    if (!selfNewer) return { accepted: true, isNew: true };
    if (this.#onSelfNewer !== undefined) {
      this.#onSelfNewer(Object.freeze({ stream, index, record }));
    }
    return { accepted: true, isNew: true, selfNewer: index };
  }

  /**
   * @param {string} stream
   * @param {number} index
   * @returns {object | undefined} the record at `index` of `stream`, if held
   */
  get(stream, index) {
    return this.#streams.get(stream)?.held.get(index);
  }

  /**
   * @param {string} stream
   * @param {number} from  first index, inclusive
   * @param {number} to    last index, inclusive
   * @returns {object[]} the held records with `from <= index <= to`, ascending. Empty for
   *   an unknown stream or arguments that are not integers. At most `maxPerStream` long.
   */
  range(stream, from, to) {
    const state = this.#streams.get(stream);
    if (state === undefined || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
      return [];
    }
    const out = [];
    for (const index of heldFrom(state, from)) {
      if (index > to) break;
      out.push(state.held.get(index));
    }
    return out;
  }

  /** @returns {string[]} the ids of every tracked stream, ascending */
  streams() {
    return this.#index.slice();
  }

  /**
   * @param {string} stream
   * @returns {number | undefined} the stream's floor: indices at or below it are pruned
   */
  floorOf(stream) {
    return this.#streams.get(stream)?.floor;
  }

  /**
   * @param {string} stream
   * @returns {number | undefined} the contiguous high-water mark: every index in
   *   (floor, high] is held
   */
  highOf(stream) {
    return this.#streams.get(stream)?.high;
  }

  /**
   * @param {string} stream
   * @returns {number | undefined} the newest index seen in the stream
   */
  topOf(stream) {
    return this.#streams.get(stream)?.top;
  }

  /**
   * Prune a stream up to `floor` and never accept or request those indices again. A
   * floor only rises; a value at or below the current one changes nothing.
   *
   * @param {string} stream  may be a stream not seen yet, which is then tracked
   * @param {number} floor   a safe integer >= 0
   * @throws {ConfigError} if an argument is malformed
   * @throws {StateError} if the stream is new and `maxStreams` streams are tracked
   */
  raiseFloor(stream, floor) {
    if (!isKey(stream)) throw new ConfigError('raiseFloor: stream id is malformed');
    if (!isVersion(floor)) throw new ConfigError('raiseFloor: floor must be an integer >= 0');
    let state = this.#streams.get(stream);
    if (state === undefined) {
      if (this.#streams.size >= this.#maxStreams) {
        throw new StateError(`cannot track more than maxStreams (${this.#maxStreams}) streams`);
      }
      state = this.#open(stream);
    }
    if (floor > state.floor) this.#raise(state, floor);
  }

  /**
   * Forget a stream entirely, its floor included. Peers that still hold the stream will
   * offer it again; use this for streams the `check` function no longer admits.
   *
   * @param {string} stream
   * @returns {boolean} whether the stream was tracked
   */
  dropStream(stream) {
    const state = this.#streams.get(stream);
    if (state === undefined) return false;
    this.#size -= state.held.size;
    this.#streams.delete(stream);
    removeSorted(this.#index, stream);
    this.#changed();
    return true;
  }

  /**
   * Drop the cached eviction choice. Call when the answers of the `priority` function
   * change.
   */
  priorityChanged() {
    this.#victim = undefined;
  }

  /**
   * Sync contract: whether the record's stream is tracked here. Malformed records count
   * as known, so that offer() reports them.
   *
   * @param {unknown} record
   * @returns {boolean}
   */
  syncKnows(record) {
    const head = this.#head(record);
    return head.reason !== undefined || this.#streams.has(head.stream);
  }

  /**
   * Sync contract: hex SHA-256 of the canonical JSON form of digest(). Two datasets with
   * the same summary hold the same indices and floors. Cached until the contents change.
   *
   * @returns {string}
   */
  syncSummary() {
    if (this.#summary === null) {
      this.#summary = sha256(canonicalBytes(this.digest())).toString('hex');
    }
    return this.#summary;
  }

  /**
   * @returns {Array<[string, number, number] | [string, number, number, Array<[number, number]>]>}
   *   one entry per stream, ascending by stream id: `[stream, floor, high]`, followed by
   *   every held range above `high` as `[[from, to], ...]` (ascending) when there are any.
   *   Complete: two datasets hold the same indices exactly when their digests are equal.
   */
  digest() {
    return this.#index.map(
      stream => entryOf(stream, this.#streams.get(stream), 0, Infinity).entry,
    );
  }

  /**
   * Compare a complete remote digest with this dataset.
   *
   * @param {unknown} remoteDigest  entries as digest() produces them, ascending by stream
   * @param {object} [options]
   * @param {number} [options.maxHave=DEFAULT_MAX_HAVE]  cap on the records returned
   * @returns {{ want: Array<[string, number, number]>, have: object[], truncated: boolean }}
   *   `want`: inclusive index ranges the remote holds, that we lack and would retain;
   *   `have`: records we hold that the remote lacks and has not pruned, ascending, at most
   *   `maxHave`; `truncated`: whether the cap cut `have` short
   * @throws {SyncFault} if the digest is malformed or not in ascending order
   */
  diff(remoteDigest, { maxHave = DEFAULT_MAX_HAVE } = {}) {
    const want = [];
    const have = [];
    let truncated = false;
    // Without the remote's window size, assume it keeps everything above its floor. A
    // complete digest is not a wire page, so the per-entry range limit does not apply.
    const page = { after: null, upto: null, entries: remoteDigest, hint: { win: MAX_INDEX } };
    const checked = checkLogPage(page, Infinity);
    for (const step of this.#reconcile(page, checked, true, null)) {
      if (step.want !== undefined) want.push(step.want);
      else if (have.length < maxHave) have.push(step.push);
      else truncated = true;
    }
    return { want, have, truncated };
  }

  /**
   * Sync contract: one page of our digest.
   *
   * An entry is `[stream, floor, high]`, then the held ranges above `high` when there
   * are any. An entry lists at most MAX_RANGES ranges. If the stream holds more, the
   * entry ends with the stream's newest index (`[stream, floor, high, ranges, top]`), it
   * is the last of the page, and the page ends inside the stream, at the end of the last
   * range listed (`upto`). The next page then continues from there.
   *
   * A cursor `[stream, index]` restarts inside a stream: the page begins with that
   * stream's entry, which lists only what is held above `index`, and only indices above
   * `index` are still to be reconciled.
   *
   * @param {[string, number] | null} after  cursor to start after, or null for the start
   * @param {{ maxEntries: number, maxBytes: number }} limits  most entries, and most bytes
   *   of their canonical JSON encoding; the first entry is included whatever they are
   * @returns {Page}  `hint.win` is our retention window; `hint.full` is set when we
   *   cannot track another stream
   */
  syncPage(after, { maxEntries, maxBytes }) {
    const index = this.#index;
    const entries = [];
    let bytes = 2;
    let upto = null;
    let i = startOf(index, after);
    for (; i < index.length && entries.length < Math.max(1, maxEntries); i += 1) {
      const stream = index[i];
      const lower = after !== null && stream === after[0] ? after[1] : 0;
      const { entry, more, last } = entryOf(stream, this.#streams.get(stream), lower, MAX_RANGES);
      const size = entryBytes(entry);
      if (entries.length > 0 && bytes + size > maxBytes) break;
      entries.push(entry);
      bytes += size;
      if (more) {
        // What the entry says about the stream stops at its last range.
        upto = [stream, last];
        break;
      }
    }
    if (upto === null && i < index.length) upto = [entries[entries.length - 1][0], MAX_INDEX];
    const hint = { win: this.#maxPerStream };
    if (this.#streams.size >= this.#maxStreams) hint.full = true;
    return { after, upto, entries, hint };
  }

  /**
   * Sync contract: validate a cursor received from a peer.
   *
   * @param {unknown} value
   * @returns {[string, number]} `[stream, index]`: everything up to and including that
   *   index of that stream; index MAX_INDEX covers the whole stream
   * @throws {SyncFault} reason "bad-cursor"
   */
  syncCursor(value) {
    if (!Array.isArray(value) || value.length !== 2 || !isKey(value[0]) || !isVersion(value[1])) {
      throw new SyncFault('bad-cursor', 'cursor is not a [stream, index] pair');
    }
    return [value[0], value[1]];
  }

  /**
   * Sync contract: order two cursors.
   *
   * @param {[string, number]} a
   * @param {[string, number]} b
   * @returns {number} negative, zero or positive as `a` is before, at or after `b`
   */
  syncCompare(a, b) {
    return compareLogCursors(a, b);
  }

  /**
   * Sync contract: compare a peer's page with our state.
   *
   * The page is validated in full before anything is returned. The result is lazy and
   * reads live state: consume it before the dataset changes. Steps come in ascending
   * `[stream, index]` order: a push carries one record the peer lacks and can keep, a
   * want is one inclusive range `[stream, from, to]` the peer holds, that we lack and
   * would retain.
   *
   * @param {Page} page  the peer's page; `hint.win` is the peer's retention window and
   *   `hint.full` (optional) says it cannot track another stream
   * @param {object} [options]
   * @param {boolean} [options.push=true]  false to produce wants only
   * @param {[string, number] | null} [options.pushAfter=null]  push only records after
   *   this cursor
   * @returns {Iterable<ReconcileStep>}
   * @throws {SyncFault} "bad-digest", "bad-cursor" or "bad-hint"
   */
  syncReconcile(page, { push = true, pushAfter = null } = {}) {
    const checked = checkLogPage(page, MAX_RANGES);
    return this.#reconcile(page, checked, push, pushAfter);
  }

  /**
   * Sync contract: answer a peer's request against a page we sent.
   *
   * A peer may only ask for index ranges between the floor and the highest index the
   * page advertised for a stream, inside the page, at or before the point it says it
   * processed. That makes a range bounded by what we chose to advertise, however large
   * the numbers in it are; within a range only the indices we still hold are produced.
   *
   * @param {unknown} wants  `[stream, from, to]` ranges in ascending order
   * @param {Page} page      the page we sent, as syncPage() returned it
   * @param {[string, number] | null} [upTo=null]  the peer's continuation cursor, null
   *   for the whole page
   * @returns {Iterable<{ cursor: [string, number], record: object }>}
   * @throws {SyncFault} "bad-request" or "bad-range"
   */
  syncServe(wants, page, upTo = null) {
    if (!Array.isArray(wants)) throw new SyncFault('bad-request', 'request is not a list');
    const advertised = new Map();
    for (const entry of page.entries) advertised.set(entry[0], entry);
    const after = page.after;
    let lastStream = null;
    let lastTo = 0;
    for (const want of wants) {
      if (
        !Array.isArray(want) ||
        want.length !== 3 ||
        !isKey(want[0]) ||
        !isIndex(want[1]) ||
        !isIndex(want[2]) ||
        want[2] < want[1]
      ) {
        throw new SyncFault('bad-request', 'requested range is malformed');
      }
      const [stream, from, to] = want;
      const ascending =
        lastStream === null || stream > lastStream || (stream === lastStream && from > lastTo);
      if (!ascending) {
        throw new SyncFault('bad-request', 'requested ranges are not in ascending order');
      }
      const entry = advertised.get(stream);
      if (entry === undefined) {
        throw new SyncFault('bad-range', 'requested stream was not advertised');
      }
      // The last range listed, not the stream's newest index: a page that ends inside
      // a stream serves nothing beyond its own end.
      const top = entry.length >= 4 ? entry[3][entry[3].length - 1][1] : entry[2];
      if (from <= entry[1] || to > top) {
        throw new SyncFault('bad-range', 'requested range exceeds what was advertised');
      }
      if (after !== null && stream === after[0] && from <= after[1]) {
        throw new SyncFault('bad-range', 'requested range starts before the page');
      }
      if (upTo !== null && compareLogCursors([stream, to], upTo) > 0) {
        throw new SyncFault('bad-range', 'requested range is beyond the continuation point');
      }
      lastStream = stream;
      lastTo = to;
    }
    return this.#serve(wants);
  }

  /**
   * Sync contract: how many entries of `page` lie at or before `cursor`.
   *
   * @param {Page} page
   * @param {[string, number]} cursor
   * @returns {number}
   */
  syncConsumed(page, cursor) {
    const { upto, entries } = page;
    let count = 0;
    for (const entry of entries) {
      if (entry[0] > cursor[0]) break;
      if (entry[0] === cursor[0]) {
        // The page may end inside its last stream; reaching that end completes the entry.
        const end = upto !== null && upto[0] === entry[0] ? upto[1] : MAX_INDEX;
        if (cursor[1] < end) break;
      }
      count += 1;
    }
    return count;
  }

  *#reconcile({ after, upto }, { entries, win, full }, push, pushAfter) {
    const index = this.#index;
    const lastStream = upto === null ? null : upto[0];
    // New streams we can still track; shared by every stream of this pass.
    const room = { streams: this.#maxStreams - this.#streams.size };
    let i = startOf(index, after);
    let e = 0;
    for (;;) {
      const mine =
        i < index.length && (lastStream === null || index[i] <= lastStream) ? index[i] : null;
      const theirs = e < entries.length ? entries[e] : null;
      if (mine === null && theirs === null) return;

      let stream;
      let entry = null;
      if (theirs === null || (mine !== null && mine < theirs.stream)) {
        // A stream the peer did not list. It holds nothing there for us, and whether we
        // push depends on the rules below. Where they rule out a whole run of streams,
        // jump over the run instead of visiting each stream.
        const never = !push || full;
        if (never || (pushAfter !== null && mine < pushAfter[0])) {
          if (theirs === null && never) return;
          let stop = theirs === null ? index.length : lowerBound(index, theirs.stream);
          if (!never) stop = Math.min(stop, lowerBound(index, pushAfter[0]));
          i = Math.max(i + 1, stop);
          continue;
        }
        stream = mine;
        i += 1;
      } else {
        stream = theirs.stream;
        entry = theirs;
        e += 1;
        if (mine === stream) i += 1;
      }

      // The page may start and end inside a stream: there, only the indices above its
      // start cursor and up to its end cursor are its business.
      const lower = after !== null && stream === after[0] ? after[1] : 0;
      const upper = upto !== null && stream === upto[0] ? upto[1] : MAX_INDEX;
      // `full`: a peer that cannot track another stream has no use for one it did not
      // list. Those streams were skipped above, so every stream here may be pushed
      // unless the push cursor is already past it.
      let pushFrom = push ? 0 : null;
      if (pushFrom !== null && pushAfter !== null) {
        if (stream < pushAfter[0]) pushFrom = null;
        else if (stream === pushAfter[0]) pushFrom = pushAfter[1];
      }
      yield* this.#reconcileStream(stream, entry, lower, upper, win, pushFrom, room);
    }
  }

  /**
   * One stream of a reconcile pass.
   *
   * @param {string} stream
   * @param {{ floor: number, high: number, top: number, ranges: Array<[number, number]> } | null}
   *   theirs  the peer's entry in parsed form, null if it did not list the stream
   * @param {number} lower  only indices above this one are considered
   * @param {number} upper  only indices up to and including this one are considered
   * @param {number} win    the peer's retention window
   * @param {number | null} pushFrom  push only indices above this one; null for no pushes
   * @param {{ streams: number }} room  new streams we can still track
   */
  *#reconcileStream(stream, theirs, lower, upper, win, pushFrom, room) {
    const mine = this.#streams.get(stream);
    const theirFloor = theirs === null ? 0 : theirs.floor;
    const theirHigh = theirs === null ? 0 : theirs.high;
    const theirRanges = theirs === null ? [] : theirs.ranges;
    // After this exchange both sides know the newest index either of them holds, and
    // each prunes to its own window below it. Nothing under those floors is worth moving.
    const newest = Math.max(theirs === null ? 0 : theirs.top, mine === undefined ? 0 : mine.top);

    const wants = [];
    const admissible =
      mine !== undefined || room.streams > 0 || this.#streamVictim(stream) !== null;
    if (theirs !== null && admissible) {
      const myFloor = mine === undefined ? 0 : mine.floor;
      const from = Math.max(lower, myFloor, newest - this.#maxPerStream);
      // What the peer holds: its contiguous part, then its out-of-order ranges.
      const segments =
        theirHigh > theirFloor ? [[theirFloor + 1, theirHigh], ...theirRanges] : theirRanges;
      for (const [first, end] of segments) {
        const last = Math.min(end, upper);
        // We hold everything in (floor, high], and `from` is at or above our floor.
        let start = Math.max(first, from + 1, mine === undefined ? 0 : mine.high + 1);
        if (start > last) continue;
        if (mine !== undefined) {
          const above = mine.above;
          for (let k = lowerBound(above, start); k < above.length && above[k] <= last; k += 1) {
            if (above[k] > start) wants.push([stream, start, above[k] - 1]);
            start = above[k] + 1;
          }
        }
        if (start <= last) wants.push([stream, start, last]);
      }
      if (wants.length > 0 && mine === undefined) room.streams -= 1;
    }

    // A wanted range holds no index of ours, so a push never falls inside one and the
    // two ascending sequences interleave by comparing where they start.
    let w = 0;
    if (mine !== undefined && pushFrom !== null) {
      // The peer holds everything in (theirFloor, theirHigh].
      const from = Math.max(lower, pushFrom, theirHigh, newest - win);
      for (const index of heldOutside(mine, from + 1, upper, theirRanges)) {
        while (w < wants.length && wants[w][1] < index) {
          yield { cursor: [stream, wants[w][2]], want: wants[w] };
          w += 1;
        }
        yield { cursor: [stream, index], push: mine.held.get(index) };
      }
    }
    for (; w < wants.length; w += 1) {
      yield { cursor: [stream, wants[w][2]], want: wants[w] };
    }
  }

  *#serve(wants) {
    for (const [stream, from, to] of wants) {
      const state = this.#streams.get(stream);
      if (state === undefined) continue;
      for (const index of heldFrom(state, from)) {
        if (index > to) break;
        yield { cursor: [stream, index], record: state.held.get(index) };
      }
    }
  }

  /** Stream and index of a record, or the reason it is invalid. */
  #head(record) {
    if (!isPlainObject(record)) return { reason: 'malformed' };
    let stream;
    let index;
    try {
      stream = this.#streamOf(record);
      index = this.#indexOf(record);
    } catch {
      return { reason: 'malformed' };
    }
    if (!isKey(stream)) return { reason: 'bad-stream' };
    if (!isIndex(index)) return { reason: 'bad-index' };
    return { stream, index };
  }

  /** The contents changed: cached answers that depend on them are stale. */
  #changed() {
    this.#victim = undefined;
    this.#summary = null;
  }

  /**
   * With a `priority` function and every slot taken: the stream a newcomer would
   * displace, if it ranks strictly higher than the lowest-ranked stream held (ties:
   * the largest stream id goes first). Otherwise null.
   */
  #streamVictim(newcomer) {
    if (this.#priority === undefined) return null;
    if (this.#victim === undefined) {
      let best = null;
      for (const stream of this.#index) {
        const priority = this.#priorityOf(stream);
        if (best === null || priority <= best.priority) best = { stream, priority };
      }
      this.#victim = best;
    }
    const victim = this.#victim;
    if (victim === null || this.#priorityOf(newcomer) <= victim.priority) return null;
    return victim.stream;
  }

  #priorityOf(stream) {
    let value;
    try {
      value = this.#priority(stream);
    } catch {
      return 0;
    }
    return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
  }

  #open(stream) {
    const state = { floor: 0, high: 0, top: 0, held: new Map(), above: [] };
    this.#streams.set(stream, state);
    insertSorted(this.#index, stream);
    this.#changed();
    return state;
  }

  /** Prune everything at or below `floor`, which must be above the current floor. */
  #raise(state, floor) {
    this.#changed();
    // Every index in (floor, high] is held, so this loop runs once per pruned record.
    const contiguousEnd = Math.min(floor, state.high);
    for (let index = state.floor + 1; index <= contiguousEnd; index += 1) {
      state.held.delete(index);
      this.#size -= 1;
    }
    if (floor > state.high) {
      const above = state.above;
      const cut = upperBound(above, floor);
      for (let k = 0; k < cut; k += 1) {
        state.held.delete(above[k]);
        this.#size -= 1;
      }
      if (cut > 0) above.splice(0, cut);
      state.high = floor;
      absorb(state);
    }
    state.floor = floor;
    if (state.top < floor) state.top = floor;
  }
}

/** Move `high` up through the out-of-order indices that have become contiguous. */
function absorb(state) {
  const above = state.above;
  let taken = 0;
  while (taken < above.length && above[taken] === state.high + 1) {
    state.high += 1;
    taken += 1;
  }
  if (taken > 0) above.splice(0, taken);
}

/** The held indices of a stream that are >= `start`, ascending. Reads live state. */
function* heldFrom(state, start) {
  for (let index = Math.max(start, state.floor + 1); index <= state.high; index += 1) {
    yield index;
  }
  const above = state.above;
  for (let k = lowerBound(above, start); k < above.length; k += 1) yield above[k];
}

/**
 * The held indices of a stream in `start..end` that are outside every one of `ranges`
 * (ascending, disjoint), ascending. A range is stepped over in one move, so the cost is
 * the indices produced plus the ranges, not the indices skipped: a peer cannot make this
 * slow by claiming to hold a huge range.
 */
function* heldOutside(state, start, end, ranges) {
  let r = 0;
  let index = Math.max(start, state.floor + 1);
  const contiguousEnd = Math.min(state.high, end);
  while (index <= contiguousEnd) {
    while (r < ranges.length && ranges[r][1] < index) r += 1;
    if (r < ranges.length && ranges[r][0] <= index) {
      index = ranges[r][1] + 1;
    } else {
      yield index;
      index += 1;
    }
  }
  const above = state.above;
  let k = lowerBound(above, start);
  while (k < above.length && above[k] <= end) {
    while (r < ranges.length && ranges[r][1] < above[k]) r += 1;
    if (r < ranges.length && ranges[r][0] <= above[k]) {
      k = upperBound(above, ranges[r][1]);
    } else {
      yield above[k];
      k += 1;
    }
  }
}

/**
 * The digest entry of a stream for a page that restarts above `lower` (0: from the
 * start of the stream), listing at most `maxRanges` ranges.
 *
 * Only indices above `lower` are listed, so a range the cursor falls into appears from
 * the cursor on. That is still a well-formed entry: every out-of-order index is at least
 * two above `high`.
 *
 * @returns {{ entry: unknown[], more: boolean, last: number }}  `more`: the stream holds
 *   indices above the last range listed, and the entry ends with the stream's newest
 *   index to say so; `last`: the end of the last range listed, when there is one
 */
function entryOf(stream, state, lower, maxRanges) {
  const above = state.above;
  let k = lower > state.high ? upperBound(above, lower) : 0;
  const entry = [stream, state.floor, state.high];
  if (k === above.length) return { entry, more: false, last: state.high };
  const ranges = [];
  while (k < above.length && ranges.length < maxRanges) {
    let end = k;
    while (end + 1 < above.length && above[end + 1] === above[end] + 1) end += 1;
    ranges.push([above[k], above[end]]);
    k = end + 1;
  }
  entry.push(ranges);
  const more = k < above.length;
  if (more) entry.push(state.top);
  return { entry, more, last: ranges[ranges.length - 1][1] };
}

/** Index of the first stream a page after `after` has to look at. */
function startOf(index, after) {
  if (after === null) return 0;
  return after[1] >= MAX_INDEX ? upperBound(index, after[0]) : lowerBound(index, after[0]);
}

function compareLogCursors(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/**
 * Validate a peer's LWW page. Returns the peer's capacity watermark, or null.
 */
function checkLwwPage(page) {
  const { after, upto, entries, hint } = page;
  if (after !== null && !isKey(after)) throw new SyncFault('bad-cursor', 'page start is malformed');
  if (upto !== null && !isKey(upto)) throw new SyncFault('bad-cursor', 'page end is malformed');
  if (after !== null && upto !== null && after >= upto) {
    throw new SyncFault('bad-cursor', 'page ends before it starts');
  }
  if (!Array.isArray(entries)) throw new SyncFault('bad-digest', 'digest is not a list');
  let previous = after;
  for (const entry of entries) {
    // [key, version, hash] for a record, [key, version, 1] for a tombstone.
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !isKey(entry[0]) ||
      !isVersion(entry[1]) ||
      (entry[2] !== 1 && !(typeof entry[2] === 'string' && DIGEST_HASH_PATTERN.test(entry[2])))
    ) {
      throw new SyncFault('bad-digest', 'digest entry is malformed');
    }
    if (previous !== null && entry[0] <= previous) {
      throw new SyncFault('bad-digest', 'digest entries are not ascending inside the page');
    }
    previous = entry[0];
  }
  if (upto !== null && entries.length > 0 && previous > upto) {
    throw new SyncFault('bad-digest', 'digest entries run past the end of the page');
  }

  if (!isPlainObject(hint)) throw new SyncFault('bad-hint', 'hint is not an object');
  for (const name of Object.keys(hint)) {
    if (name !== 'min') throw new SyncFault('bad-hint', 'hint has an unknown field');
  }
  if (hint.min === undefined) return null;
  if (!isVersion(hint.min)) throw new SyncFault('bad-hint', 'hint.min is not a version');
  return hint.min;
}

/**
 * Validate a peer's log page. Returns its entries in parsed form and its hint.
 *
 * @param {Page} page
 * @param {number} maxRanges  most ranges one entry may list
 */
function checkLogPage(page, maxRanges) {
  const { after, upto, entries, hint } = page;
  if (after !== null && !isLogCursor(after)) {
    throw new SyncFault('bad-cursor', 'page start is malformed');
  }
  if (upto !== null && !isLogCursor(upto)) {
    throw new SyncFault('bad-cursor', 'page end is malformed');
  }
  if (after !== null && upto !== null && compareLogCursors(after, upto) >= 0) {
    throw new SyncFault('bad-cursor', 'page ends before it starts');
  }
  if (!Array.isArray(entries)) throw new SyncFault('bad-digest', 'digest is not a list');

  const parsed = [];
  let previous = null;
  for (const entry of entries) {
    const item = parseLogEntry(entry, maxRanges);
    if (previous !== null && item.stream <= previous) {
      throw new SyncFault('bad-digest', 'digest entries are not in ascending order');
    }
    previous = item.stream;
    parsed.push(item);
  }
  if (parsed.length > 0) {
    const first = parsed[0].stream;
    if (after !== null && (first < after[0] || (first === after[0] && after[1] >= MAX_INDEX))) {
      throw new SyncFault('bad-digest', 'digest entries start before the page');
    }
    if (upto !== null && previous > upto[0]) {
      throw new SyncFault('bad-digest', 'digest entries run past the end of the page');
    }
  }

  if (!isPlainObject(hint)) throw new SyncFault('bad-hint', 'hint is not an object');
  for (const name of Object.keys(hint)) {
    if (name !== 'win' && name !== 'full') {
      throw new SyncFault('bad-hint', 'hint has an unknown field');
    }
  }
  if (!isIndex(hint.win)) throw new SyncFault('bad-hint', 'hint.win is not a window size');
  if (hint.full !== undefined && hint.full !== true) {
    throw new SyncFault('bad-hint', 'hint.full is not true');
  }
  return { entries: parsed, win: hint.win, full: hint.full === true };
}

/**
 * Validate one log digest entry: `[stream, floor, high]`, optionally followed by the
 * held ranges above `high`, optionally followed by the stream's newest index when it
 * lies beyond the last range listed.
 *
 * @returns {{ stream: string, floor: number, high: number, ranges: Array<[number, number]>,
 *   top: number }}  `top`: the newest index the sender holds in the stream
 */
function parseLogEntry(entry, maxRanges) {
  if (!Array.isArray(entry) || entry.length < 3 || entry.length > 5) {
    throw new SyncFault('bad-digest', 'digest entry is malformed');
  }
  const [stream, floor, high] = entry;
  if (!isKey(stream) || !isVersion(floor) || !isVersion(high) || high < floor) {
    throw new SyncFault('bad-digest', 'digest entry is malformed');
  }
  let top = high;
  let ranges = [];
  if (entry.length >= 4) {
    ranges = entry[3];
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > maxRanges) {
      throw new SyncFault('bad-digest', 'digest entry has a malformed range list');
    }
    for (const range of ranges) {
      // A range that touches the previous one should have been merged into it.
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !isIndex(range[0]) ||
        !isIndex(range[1]) ||
        range[1] < range[0] ||
        range[0] <= top + 1
      ) {
        throw new SyncFault('bad-digest', 'digest entry has a malformed range');
      }
      top = range[1];
    }
  }
  if (entry.length === 5) {
    if (!isIndex(entry[4]) || entry[4] <= top) {
      throw new SyncFault('bad-digest', 'digest entry has a malformed newest index');
    }
    top = entry[4];
  }
  return { stream, floor, high, ranges, top };
}

function isLogCursor(value) {
  return Array.isArray(value) && value.length === 2 && isKey(value[0]) && isVersion(value[1]);
}

/** Run an injected check and normalize its answer. Anything unexpected refuses. */
function runCheck(check, record) {
  let verdict;
  try {
    verdict = check(record);
  } catch {
    // A validator that throws has not vouched for the record: fail closed.
    return { ok: false, soft: false, reason: 'check-threw' };
  }
  if (verdict === null || typeof verdict !== 'object') {
    return { ok: false, soft: false, reason: 'rejected' };
  }
  if (verdict.ok === true) return { ok: true };
  const reason =
    typeof verdict.reason === 'string' && verdict.reason !== '' ? verdict.reason : 'rejected';
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

/** A version, a floor or a high-water mark: a safe integer >= 0. */
function isVersion(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A log index or a count: a safe integer >= 1. */
function isIndex(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/** The digest entry of a held LWW record. */
function recordEntry(key, held) {
  return [key, held.version, held.hash.slice(0, DIGEST_HASH_CHARS)];
}

/**
 * Order of an LWW record we hold against a peer's digest entry for the same key: by
 * version, then by hash. The peer only sends a prefix of its hash, and a prefix orders
 * like the whole hash unless the two prefixes are equal; equal prefixes count as the
 * same record (a 64-bit collision between two valid records of one key and version).
 *
 * @returns {number} negative, zero or positive as ours comes before, with or after theirs
 */
function compareRecord(version, hash, theirVersion, theirHash) {
  if (version !== theirVersion) return version < theirVersion ? -1 : 1;
  const prefix = hash.slice(0, DIGEST_HASH_CHARS);
  return prefix < theirHash ? -1 : prefix > theirHash ? 1 : 0;
}

/** Bytes a digest entry adds to a canonical JSON list. Entries are ASCII by construction. */
function entryBytes(entry) {
  return JSON.stringify(entry).length + 1;
}

/** First position whose element is >= `value` in an ascending array. */
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

/** First position whose element is > `value` in an ascending array. */
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

function requireName(name) {
  if (typeof name !== 'string' || !SET_NAME_PATTERN.test(name)) {
    throw new ConfigError('dataset name must match /^[a-z][a-z0-9-]{0,31}$/');
  }
  return name;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new ConfigError(`${label} must be a function`);
  return value;
}

function optionalFunction(value, label) {
  if (value !== undefined && typeof value !== 'function') {
    throw new ConfigError(`${label} must be a function when given`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(`${label} must be an integer >= 1`);
  }
  return value;
}
