/**
 * In-process event bus.
 *
 * Every module reports what it does by emitting events here; the control API turns them
 * into the live feed that ClawView and the CLI read. The bus is the only path from the
 * engine to the UI, so what it carries is what really happened.
 *
 * Properties the rest of the engine relies on:
 *
 *   - Events are numbered 1, 2, 3, ... without gaps, and every listener sees them in
 *     that order, including events emitted from inside a listener.
 *   - An event is immutable. `emit` stores a frozen deep copy of the data, so neither a
 *     listener nor the emitter can change history after the fact.
 *   - Event data is plain JSON (objects, arrays, strings, finite numbers, booleans,
 *     null). Anything else is refused at `emit`, where the mistake was made, instead of
 *     failing later inside the HTTP feed.
 *   - A listener that throws or rejects affects nobody else. The failure becomes an
 *     `internal.listener_error` event.
 *   - Memory is bounded: the bus keeps the last `capacity` events and nothing more, and
 *     each event's data is bounded in values, depth and characters of text.
 *
 * The bus has no timers and no I/O.
 */

import { ClawNetError, ConfigError } from './errors.js';

/** Subscribe to this type to receive every event. */
export const WILDCARD = '*';

/** Type of the event that reports a failed listener. */
export const LISTENER_ERROR_EVENT = 'internal.listener_error';

/** Longest event type name, in characters. */
export const MAX_EVENT_TYPE_LENGTH = 128;

/** Deepest nesting of containers inside event data. */
export const MAX_EVENT_DEPTH = 16;

/** Most values (scalars and containers together) one event's data may hold. */
export const MAX_EVENT_VALUES = 65536;

/**
 * Most characters of strings and object keys, together, in one event's data. With
 * MAX_EVENT_VALUES this bounds the memory one event can pin in the ring buffer.
 */
export const MAX_EVENT_TEXT = 1024 * 1024;

/** Largest ring buffer; keeps a typo in configuration from reserving gigabytes. */
const MAX_CAPACITY = 1_000_000;

/** Most types one `recent` query may filter on. */
const MAX_FILTER_TYPES = 1024;

/** Longest error text copied into an `internal.listener_error` event. */
const MAX_ERROR_TEXT = 256;

/** Dispatch-queue entries consumed before the queue array is compacted. */
const QUEUE_COMPACT_THRESHOLD = 1024;

/**
 * @typedef {object} BusEvent
 * @property {number} seq  position in the stream, starting at 1 and increasing by 1
 * @property {number} ts   `now()` at the time of the emit (milliseconds since the epoch)
 * @property {string} type event name, for example "peer.connected"
 * @property {unknown} data frozen JSON-compatible payload; null when none was given
 */

/**
 * @callback EventListener
 * @param {BusEvent} event
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {object} Subscription
 * @property {string} type      the event type subscribed to, or "*"
 * @property {EventListener} listener
 * @property {boolean} once     remove before the first call
 * @property {boolean} active   false once unsubscribed
 */

export class EventBus {
  #capacity;
  #now;
  /** Ring buffer: the event with sequence number s lives at index (s - 1) % capacity. */
  #ring;
  #count = 0;
  #seq = 0;
  /**
   * Subscriptions by event type (or "*"). `active` turns false on removal, so that a
   * delivery already under way skips the entry.
   *
   * @type {Map<string, Set<Subscription>>}
   */
  #listeners = new Map();
  /** Events recorded but not yet delivered; #queueHead is the next one to deliver. */
  #queue = [];
  #queueHead = 0;
  #delivering = false;

  /**
   * @param {object} [options]
   * @param {number} [options.capacity] events kept for `recent`, 1..1000000; default 2000
   * @param {() => number} [options.now] clock in milliseconds; default Date.now
   * @throws {ConfigError} if capacity is not an integer in range or now is not a function
   */
  constructor({ capacity = 2000, now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      throw new ConfigError(`event bus capacity must be an integer between 1 and ${MAX_CAPACITY}`);
    }
    if (typeof now !== 'function') {
      throw new ConfigError('event bus clock must be a function');
    }
    this.#capacity = capacity;
    this.#now = now;
    this.#ring = new Array(capacity);
  }

  /**
   * Sequence number of the most recent event, or 0 if none has been emitted.
   *
   * @returns {number}
   */
  get lastSeq() {
    return this.#seq;
  }

  /**
   * Record an event and deliver it to its listeners.
   *
   * Listeners for the exact type run first, then wildcard listeners, each group in
   * subscription order. Delivery is synchronous: listeners have run by the time `emit`
   * returns, except when `emit` is called from inside a listener. In that case the new
   * event is recorded immediately but delivered after the current one, so that every
   * listener sees events in sequence order.
   *
   * @param {string} type 1..128 characters, not "*"
   * @param {unknown} [data] JSON-compatible value; it is copied, so later changes to the
   *   original do not affect the event. Omitted means null. As in JSON, `undefined`
   *   object properties are dropped and `undefined` array items become null.
   * @returns {BusEvent} the frozen event that was recorded
   * @throws {ClawNetError} code ERR_INVALID_ARGUMENT if the type is invalid or the data
   *   is not plain JSON (a function, bigint, symbol, non-finite number, class instance,
   *   cycle, nesting over 16 levels, more than 65536 values or more than 1048576
   *   characters of text), or reading it failed (a getter or proxy that throws)
   */
  emit(type, data) {
    assertEventType(type);
    const event = this.#record(type, snapshot(data));
    this.#deliverPending();
    return event;
  }

  /**
   * Subscribe to one event type, or to every event with "*".
   *
   * Subscribing the same function twice registers it twice. A listener added while an
   * event is being delivered first sees the next event.
   *
   * @param {string} type event type, or "*"
   * @param {EventListener} listener called with each matching event; a returned promise
   *   is observed only to report its rejection
   * @returns {() => void} unsubscribe function; calling it more than once is harmless
   * @throws {ClawNetError} code ERR_INVALID_ARGUMENT for an invalid type or listener
   */
  on(type, listener) {
    return this.#subscribe(type, listener, false);
  }

  /**
   * Subscribe for a single event: the listener is removed before it is called.
   *
   * @param {string} type event type, or "*"
   * @param {EventListener} listener
   * @returns {() => void} unsubscribe function, for cancelling before the event arrives
   * @throws {ClawNetError} code ERR_INVALID_ARGUMENT for an invalid type or listener
   */
  once(type, listener) {
    return this.#subscribe(type, listener, true);
  }

  /**
   * Number of active subscriptions.
   *
   * @param {string} [type] an event type or "*"; omitted counts every subscription.
   *   Wildcard listeners are counted only under "*", not under each type.
   * @returns {number}
   */
  listenerCount(type) {
    if (type === undefined) {
      let total = 0;
      for (const entries of this.#listeners.values()) total += entries.size;
      return total;
    }
    return this.#listeners.get(type)?.size ?? 0;
  }

  /**
   * Read events from the ring buffer, oldest first.
   *
   * With `sinceSeq`, returns the oldest `limit` matching events after that sequence
   * number, so a reader can page forward with the last `seq` it saw. Without it, returns
   * the newest `limit` matching events. If the first returned `seq` is greater than
   * `sinceSeq + 1` and no type filter is in use, older events have already been dropped.
   *
   * @param {object} [query]
   * @param {number} [query.sinceSeq] only events with seq greater than this
   * @param {number} [query.limit] most events to return; default and maximum is the
   *   bus capacity
   * @param {Iterable<string>} [query.types] only events whose type is one of these
   *   (exact match, at most 1024 types)
   * @returns {BusEvent[]}
   * @throws {ClawNetError} code ERR_INVALID_ARGUMENT for a malformed query
   */
  recent(query = {}) {
    if (query === null || typeof query !== 'object') {
      throw invalidArgument('recent() takes an options object');
    }
    const { sinceSeq, limit, types } = query;
    if (sinceSeq !== undefined && (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0)) {
      throw invalidArgument('sinceSeq must be a non-negative integer');
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw invalidArgument('limit must be a non-negative integer');
    }
    const wanted = types === undefined ? null : toTypeSet(types);

    // The buffer never holds more than `capacity` events, so that is the widest limit.
    const max = limit ?? this.#capacity;
    const oldest = this.#seq - this.#count + 1;
    const out = [];
    if (max === 0 || this.#count === 0) return out;

    if (sinceSeq !== undefined) {
      const first = Math.max(sinceSeq + 1, oldest);
      for (let seq = first; seq <= this.#seq && out.length < max; seq += 1) {
        const event = this.#ring[(seq - 1) % this.#capacity];
        if (wanted === null || wanted.has(event.type)) out.push(event);
      }
      return out;
    }
    for (let seq = this.#seq; seq >= oldest && out.length < max; seq -= 1) {
      const event = this.#ring[(seq - 1) % this.#capacity];
      if (wanted === null || wanted.has(event.type)) out.push(event);
    }
    return out.reverse();
  }

  #subscribe(type, listener, once) {
    if (type !== WILDCARD) assertEventType(type);
    if (typeof listener !== 'function') {
      throw invalidArgument('event listener must be a function');
    }
    const entry = { type, listener, once, active: true };
    let entries = this.#listeners.get(type);
    if (entries === undefined) {
      entries = new Set();
      this.#listeners.set(type, entries);
    }
    entries.add(entry);
    return () => this.#unsubscribe(entry);
  }

  #unsubscribe(entry) {
    if (!entry.active) return;
    entry.active = false;
    const entries = this.#listeners.get(entry.type);
    entries.delete(entry);
    // Drop the empty set so that one-off types do not accumulate in the map.
    if (entries.size === 0) this.#listeners.delete(entry.type);
  }

  /** Assign the next sequence number, store the event and queue it for delivery. */
  #record(type, data) {
    // Read the clock first: if it throws, no sequence number has been consumed.
    const ts = this.#now();
    this.#seq += 1;
    const event = Object.freeze({ seq: this.#seq, ts, type, data });
    this.#ring[(this.#seq - 1) % this.#capacity] = event;
    if (this.#count < this.#capacity) this.#count += 1;
    this.#queue.push(event);
    return event;
  }

  /**
   * Deliver queued events in order. A nested call (an emit from inside a listener)
   * returns at once and leaves the work to the outer loop: that is what keeps delivery
   * in sequence order and keeps a chain of emits from growing the stack.
   */
  #deliverPending() {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      while (this.#queueHead < this.#queue.length) {
        const event = this.#queue[this.#queueHead];
        this.#queueHead += 1;
        if (this.#queueHead >= QUEUE_COMPACT_THRESHOLD) {
          this.#queue.splice(0, this.#queueHead);
          this.#queueHead = 0;
        }
        this.#deliver(event);
      }
      this.#queue.length = 0;
      this.#queueHead = 0;
    } finally {
      this.#delivering = false;
    }
  }

  #deliver(event) {
    const specific = this.#listeners.get(event.type);
    const wildcard = this.#listeners.get(WILDCARD);
    if (specific === undefined && wildcard === undefined) return;
    // Copy first: listeners may subscribe or unsubscribe while the event is delivered.
    const targets = [];
    if (specific !== undefined) targets.push(...specific);
    if (wildcard !== undefined) targets.push(...wildcard);

    for (const entry of targets) {
      // Removed by an earlier listener of this same event.
      if (!entry.active) continue;
      if (entry.once) this.#unsubscribe(entry);
      try {
        const result = entry.listener(event);
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          // An async listener: without this its rejection would be an unhandled
          // rejection, which terminates the process by default.
          result.then(undefined, (error) => this.#reportListenerError(event, error));
        }
      } catch (error) {
        this.#reportListenerError(event, error);
      }
    }
  }

  #reportListenerError(event, error) {
    // No recursion: a listener that fails while handling a failure report is dropped
    // silently, otherwise one broken wildcard listener would loop forever.
    if (event.type === LISTENER_ERROR_EVENT) return;
    const data = deepFreeze({
      event: { seq: event.seq, type: event.type },
      error: describeError(error),
    });
    try {
      this.#record(LISTENER_ERROR_EVENT, data);
    } catch {
      // Only the injected clock can throw here. This runs inside a catch block or a
      // promise reaction, where a second failure would escape as a crash, and with no
      // clock there is no event to report it with.
      return;
    }
    // Needed when a promise rejects after delivery has finished; a no-op otherwise.
    this.#deliverPending();
  }
}

function invalidArgument(message) {
  return new ClawNetError('ERR_INVALID_ARGUMENT', message);
}

function assertEventType(type) {
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_EVENT_TYPE_LENGTH) {
    throw invalidArgument(
      `event type must be a string of 1 to ${MAX_EVENT_TYPE_LENGTH} characters`,
    );
  }
  if (type === WILDCARD) {
    throw invalidArgument(`event type must not be "${WILDCARD}"`);
  }
}

function toTypeSet(types) {
  if (types === null || typeof types !== 'object' || typeof types[Symbol.iterator] !== 'function') {
    throw invalidArgument('types must be an array or set of event type names');
  }
  const wanted = new Set();
  // Counted per item, not per distinct type: an endless iterable that repeats one name
  // would otherwise never reach the limit.
  let count = 0;
  for (const type of types) {
    count += 1;
    if (count > MAX_FILTER_TYPES) {
      throw invalidArgument(`types must contain at most ${MAX_FILTER_TYPES} entries`);
    }
    if (typeof type !== 'string') throw invalidArgument('types must contain only strings');
    wanted.add(type);
  }
  return wanted;
}

/**
 * Describe whatever a listener threw, without trusting it: thrown values need not be
 * Error objects, and their properties may be anything.
 */
function describeError(error) {
  let name = 'Error';
  let code = null;
  let message;
  try {
    if (error !== null && typeof error === 'object') {
      if (typeof error.name === 'string') name = error.name;
      if (typeof error.code === 'string') code = error.code;
      message = typeof error.message === 'string' ? error.message : 'non-error object thrown';
    } else {
      message = String(error);
    }
  } catch {
    message = 'error could not be described';
  }
  return {
    name: name.slice(0, MAX_ERROR_TEXT),
    code: code === null ? null : code.slice(0, MAX_ERROR_TEXT),
    message: message.slice(0, MAX_ERROR_TEXT),
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Deep-copy `value` into frozen plain JSON, or throw if it is not JSON-compatible.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function snapshot(value) {
  if (value === undefined) return null;
  try {
    return copyValue(value, '', { values: 0, text: 0, ancestors: new Set() }, 0);
  } catch (error) {
    if (error instanceof ClawNetError) throw error;
    // A getter or proxy in the data threw. The emitter still gets the documented error.
    throw new ClawNetError('ERR_INVALID_ARGUMENT', 'event data could not be read', {
      cause: error,
    });
  }
}

/** Charge `length` characters of text to the event, or throw if it is over budget. */
function chargeText(state, length) {
  state.text += length;
  if (state.text > MAX_EVENT_TEXT) {
    throw invalidArgument(`event data holds more than ${MAX_EVENT_TEXT} characters of text`);
  }
}

function copyValue(value, path, state, depth) {
  state.values += 1;
  if (state.values > MAX_EVENT_VALUES) {
    throw invalidArgument(`event data holds more than ${MAX_EVENT_VALUES} values`);
  }
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      chargeText(state, value.length);
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw notSerializable(path, 'a non-finite number');
      return value;
    case 'object':
      break;
    default:
      throw notSerializable(path, `a ${typeof value}`);
  }

  if (depth >= MAX_EVENT_DEPTH) {
    throw invalidArgument(
      `event data nests deeper than ${MAX_EVENT_DEPTH} levels at ${path || 'the top'}`,
    );
  }
  if (state.ancestors.has(value)) throw notSerializable(path, 'a circular reference');

  let copy;
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    // Checked before allocating: a sparse array can claim a length of four billion.
    if (value.length > MAX_EVENT_VALUES - state.values) {
      throw invalidArgument(`event data holds more than ${MAX_EVENT_VALUES} values`);
    }
    copy = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      copy[i] = item === undefined ? null : copyValue(item, `${path}[${i}]`, state, depth + 1);
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw notSerializable(path, `an instance of ${describeConstructor(value)}`);
    }
    copy = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined) continue;
      chargeText(state, key.length);
      const child = copyValue(item, `${path}.${key.slice(0, 64)}`, state, depth + 1);
      if (key === '__proto__') {
        // Plain assignment to this key would replace the copy's prototype.
        Object.defineProperty(copy, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        copy[key] = child;
      }
    }
  }
  state.ancestors.delete(value);
  return Object.freeze(copy);
}

function notSerializable(path, what) {
  return invalidArgument(`event data is not JSON-serializable: ${path || 'the value'} is ${what}`);
}

function describeConstructor(value) {
  const name = value.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name.slice(0, 64) : 'a non-plain object';
}
