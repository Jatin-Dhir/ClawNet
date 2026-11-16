/**
 * Chat history: the `msg` message kind (ARCHITECTURE.md 5.7) and the service that exposes
 * it through the control API.
 *
 * `ConversationStore` sends and receives `msg` messages through the reliable messenger,
 * keeps the history per peer, follows the life of every outgoing message (queued, sent,
 * held by a mailbox, delivered or expired) from the events the messenger emits, and
 * persists everything in an append-only log so a restart shows the same conversations.
 *
 * Nothing here talks to the network or owns a timer: the messenger does the delivery,
 * the node hands over its event bus and a log.
 */

import { ConfigError, StateError } from '../errors.js';
import { isNodeId } from '../wire/schema.js';
import { MESSAGE_ID_PATTERN } from '../wire/types.js';

/** Largest text of one chat message, in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 16384;

/** Newest messages kept in memory per peer. */
export const DEFAULT_MAX_PER_PEER = 1000;

/** Most peers whose history is kept; the least recently active one is dropped first. */
export const DEFAULT_MAX_PEERS = 1000;

/** Largest page a caller may ask for (API.md section 5). */
export const MAX_PAGE = 500;

/** Page size when the caller does not say. */
export const DEFAULT_PAGE = 50;

/** The log is rewritten once it holds this many records and more than twice the retained ones. */
const COMPACT_MIN_RECORDS = 256;

/** Events about messages this store has not recorded yet, kept while a send is in flight. */
const EARLY_EVENTS_MAX = 256;

/** The `kind` of a chat message on the wire. */
const CHAT_KIND = 'msg';

/**
 * Order of the states of an outgoing message. A state only ever moves up: an
 * acknowledgement that overtakes a late "sent" event must not be undone by it, and a
 * message that was delivered can no longer expire.
 */
const STATE_RANK = Object.freeze({ queued: 0, sent: 1, custody: 2, expired: 3, delivered: 4, received: 0 });

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isInteger(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new ConfigError(`${name} must be a function`);
}

/**
 * Check chat text from a local caller.
 *
 * @param {unknown} text
 * @returns {Buffer} the UTF-8 bytes
 * @throws {ConfigError} if it is not a well-formed string of 1 to MAX_TEXT_BYTES bytes
 */
function checkOutgoingText(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new ConfigError('text must be a well-formed string');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_TEXT_BYTES) {
    throw new ConfigError(`text must be 1 to ${MAX_TEXT_BYTES} bytes of UTF-8`);
  }
  return bytes;
}

/**
 * Decode the content of a received message; null if it is not a valid chat text.
 *
 * @param {Uint8Array} content
 * @returns {string | null}
 */
function decodeIncomingText(content) {
  if (!(content instanceof Uint8Array) || content.length < 1 || content.length > MAX_TEXT_BYTES) return null;
  try {
    return utf8.decode(content);
  } catch {
    return null;
  }
}

/**
 * @typedef {object} ChatMessage
 * @property {number} seq     local order; paging cursor
 * @property {string} id      message id
 * @property {string} peer    the other party
 * @property {'in' | 'out'} direction
 * @property {string} text
 * @property {number} ts      the sender's clock when it was sent
 * @property {number} at      this node's clock when it was recorded
 * @property {string} state   outgoing: queued, sent, custody, delivered, expired; incoming: received
 */

/** Check one record of the log; returns it when it has the shape this store writes. */
function validRecord(record) {
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.id !== 'string' || !MESSAGE_ID_PATTERN.test(record.id) || !isNodeId(record.peer)) return null;
  if (record.op === 'msg') {
    const stateOk = record.state === undefined || Object.hasOwn(STATE_RANK, record.state);
    const ok = isInteger(record.seq, 1) && (record.direction === 'in' || record.direction === 'out') &&
      typeof record.text === 'string' && isInteger(record.ts) && isInteger(record.at) && stateOk;
    return ok ? record : null;
  }
  if (record.op === 'state') {
    return Object.hasOwn(STATE_RANK, record.state) && isInteger(record.at) ? record : null;
  }
  return null;
}

export class ConversationStore {
  #selfId;
  #messenger;
  #log;
  #events;
  #now;
  #maxPerPeer;
  #maxPeers;

  /** peer -> ChatMessage[] ascending by seq. Insertion order is recency: oldest activity first. */
  #peers = new Map();
  /** `${peer}:${id}` -> ChatMessage. Keyed by peer too: an id is only unique per sender. */
  #byKey = new Map();
  #nextSeq = 1;
  #logRecords = 0;
  #compacting = null;
  #opened = false;
  #closed = false;
  #offHandler = null;
  #offEvents = [];
  /** Sends in progress: events that arrive before `send()` returns are held in `#early`. */
  #sending = 0;
  #early = new Map();
  #stats = {
    sent: 0, received: 0, ignored: 0, duplicates: 0, stateChanges: 0,
    corruptRecords: 0, compactions: 0, compactErrors: 0,
  };

  /**
   * @param {object} options
   * @param {string} options.selfId this node's id
   * @param {{ send: Function, onKind: Function }} options.messenger the reliable messenger
   *   (or an adapter with its `send` and `onKind`)
   * @param {{ open: Function, append: Function, read: Function, rewrite: Function, flush: Function }} options.log
   *   an `AppendLog` (or sealed log) that is already open
   * @param {{ emit: Function, on: Function }} options.events the node's event bus
   * @param {() => number} [options.now] wall clock
   * @param {number} [options.maxPerPeer] messages kept per peer
   * @param {number} [options.maxPeers] peers kept
   * @throws {ConfigError} for an invalid option
   */
  constructor({ selfId, messenger, log, events, now = Date.now, maxPerPeer = DEFAULT_MAX_PER_PEER, maxPeers = DEFAULT_MAX_PEERS } = {}) {
    if (!isNodeId(selfId)) throw new ConfigError('selfId must be a NodeId');
    for (const [object, members, name] of [
      [messenger, ['send', 'onKind'], 'messenger'],
      [log, ['append', 'read', 'rewrite', 'flush'], 'log'],
      [events, ['emit', 'on'], 'events'],
    ]) {
      if (object === null || typeof object !== 'object') throw new ConfigError(`${name} is required`);
      for (const member of members) requireFunction(object[member], `${name}.${member}`);
    }
    requireFunction(now, 'now');
    if (!isInteger(maxPerPeer, 1) || !isInteger(maxPeers, 1)) throw new ConfigError('maxPerPeer and maxPeers must be positive integers');
    this.#selfId = selfId;
    this.#messenger = messenger;
    this.#log = log;
    this.#events = events;
    this.#now = now;
    this.#maxPerPeer = maxPerPeer;
    this.#maxPeers = maxPeers;
  }

  /**
   * Load the history from the log, register the `msg` handler and start following the
   * messenger's events. Records that do not parse are skipped and counted.
   *
   * @returns {Promise<void>}
   * @throws {StateError} if already open
   */
  async open() {
    if (this.#opened) throw new StateError('already-open: the conversation store is open');
    this.#opened = true;
    await this.#load();
    this.#offHandler = this.#messenger.onKind(CHAT_KIND, (message) => this.#receive(message));
    const state = (name, map) => this.#events.on(name, (event) => map(event.data));
    this.#offEvents = [
      state('message.sent', (data) => data.kind === CHAT_KIND && this.#advance(data.dst, data.id, 'sent')),
      state('message.acked', (data) => data.kind === CHAT_KIND && this.#advance(data.dst, data.id, 'delivered')),
      state('message.expired', (data) => data.kind === CHAT_KIND && this.#advance(data.dst, data.id, 'expired')),
      // The deposit event does not name the kind; an id this store does not know is not ours.
      state('custody.deposited', (data) => this.#advance(data.dst, data.id, 'custody')),
    ];
  }

  /**
   * Stop following events, wait for a running compaction and flush the log.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#offEvents) off();
    this.#offEvents = [];
    this.#offHandler?.();
    this.#offHandler = null;
    await this.#compacting;
    if (this.#opened) await this.#log.flush();
  }

  /**
   * Send a chat message. It is in the outbox when this returns; its progress arrives as
   * `chat.state` events.
   *
   * @param {string} to destination NodeId
   * @param {string} text 1 to MAX_TEXT_BYTES bytes of well-formed UTF-8
   * @returns {Promise<ChatMessage>}
   * @throws {ConfigError} for an invalid destination or text
   * @throws {StateError} `unknown-destination`, `outbox-full`, or `not-open`
   */
  async send(to, text) {
    this.#requireOpen();
    if (!isNodeId(to)) throw new ConfigError('to must be a NodeId');
    const content = checkOutgoingText(text);
    this.#sending += 1;
    try {
      const sentAt = Math.trunc(this.#now());
      const { id, state } = await this.#messenger.send(to, { kind: CHAT_KIND, content });
      const message = {
        seq: this.#nextSeq,
        id,
        peer: to,
        direction: 'out',
        text,
        ts: sentAt,
        at: Math.trunc(this.#now()),
        state: state === 'sent' ? 'sent' : 'queued',
      };
      this.#nextSeq += 1;
      const early = this.#early.get(`${to}:${id}`);
      if (early !== undefined && STATE_RANK[early] > STATE_RANK[message.state]) message.state = early;
      this.#insert(message);
      this.#stats.sent += 1;
      const record = this.#record(message);
      this.#emit('chat.message', { message: { ...message } });
      await this.#append(record);
      return { ...message };
    } finally {
      this.#sending -= 1;
      if (this.#sending === 0) this.#early.clear();
    }
  }

  /**
   * @returns {Array<{ peer: string, count: number, lastAt: number, last: ChatMessage }>}
   *   one entry per peer, most recently active first
   */
  list() {
    const out = [];
    for (const [peer, items] of this.#peers) {
      if (items.length === 0) continue;
      const last = items[items.length - 1];
      out.push({ peer, count: items.length, lastAt: last.at, last: { ...last } });
    }
    return out.reverse();
  }

  /**
   * One page of the history with a peer, newest first.
   *
   * @param {string} peer
   * @param {{ before?: number, limit?: number }} [options] `before`: only messages with a
   *   smaller `seq`
   * @returns {{ items: ChatMessage[], nextBefore: number | null }} `nextBefore` is the
   *   cursor for the next older page, or null when there is none
   * @throws {ConfigError} for an invalid argument
   */
  messages(peer, { before, limit = DEFAULT_PAGE } = {}) {
    if (!isNodeId(peer)) throw new ConfigError('peer must be a NodeId');
    if (!isInteger(limit, 1) || limit > MAX_PAGE) throw new ConfigError(`limit must be an integer from 1 to ${MAX_PAGE}`);
    if (before !== undefined && !isInteger(before, 1)) throw new ConfigError('before must be a positive integer');
    const items = this.#peers.get(peer) ?? [];
    // Messages are ascending by seq: the page ends just before `before`.
    let end = items.length;
    if (before !== undefined) {
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (items[mid].seq < before) lo = mid + 1;
        else hi = mid;
      }
      end = lo;
    }
    const start = Math.max(0, end - limit);
    const page = items.slice(start, end).reverse().map((message) => ({ ...message }));
    return { items: page, nextBefore: start > 0 ? page[page.length - 1].seq : null };
  }

  /** @returns {Record<string, number>} counters: flat non-negative integers */
  stats() {
    return {
      ...this.#stats,
      peers: this.#peers.size,
      messages: this.#byKey.size,
      logRecords: this.#logRecords,
    };
  }

  // -------------------------------------------------------------------------------------

  #requireOpen() {
    if (!this.#opened || this.#closed) throw new StateError('not-open: the conversation store is not open');
  }

  #emit(type, data) {
    try {
      this.#events.emit(type, data);
    } catch {
      // A refused event must not undo a message that is already recorded.
    }
  }

  async #load() {
    const messages = new Map();
    const states = [];
    for await (const raw of this.#log.read()) {
      const record = validRecord(raw);
      if (record === null) {
        this.#stats.corruptRecords += 1;
        continue;
      }
      this.#logRecords += 1;
      if (record.op === 'state') {
        states.push(record);
        continue;
      }
      messages.set(`${record.peer}:${record.id}`, {
        seq: record.seq,
        id: record.id,
        peer: record.peer,
        direction: record.direction,
        text: record.text,
        ts: record.ts,
        at: record.at,
        state: record.state ?? (record.direction === 'in' ? 'received' : 'queued'),
      });
    }
    for (const record of states) {
      const message = messages.get(`${record.peer}:${record.id}`);
      if (message !== undefined && message.direction === 'out' && STATE_RANK[record.state] > STATE_RANK[message.state]) {
        message.state = record.state;
      }
    }
    // Insert oldest first so that retention and peer recency come out as they were live.
    const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq);
    for (const message of ordered) {
      this.#insert(message);
      this.#nextSeq = Math.max(this.#nextSeq, message.seq + 1);
    }
  }

  /** Add a message to memory, enforcing both retention bounds. */
  #insert(message) {
    const key = `${message.peer}:${message.id}`;
    let items = this.#peers.get(message.peer);
    if (items === undefined) {
      items = [];
    } else {
      // Re-insert so that this peer becomes the most recently active one.
      this.#peers.delete(message.peer);
    }
    this.#peers.set(message.peer, items);
    items.push(message);
    this.#byKey.set(key, message);
    while (items.length > this.#maxPerPeer) {
      const dropped = items.shift();
      this.#byKey.delete(`${dropped.peer}:${dropped.id}`);
    }
    while (this.#peers.size > this.#maxPeers) {
      const [oldest, dropped] = this.#peers.entries().next().value;
      this.#peers.delete(oldest);
      for (const gone of dropped) this.#byKey.delete(`${gone.peer}:${gone.id}`);
    }
  }

  #record(message) {
    return {
      op: 'msg',
      seq: message.seq,
      id: message.id,
      peer: message.peer,
      direction: message.direction,
      text: message.text,
      ts: message.ts,
      at: message.at,
      state: message.state,
    };
  }

  /**
   * Append to the log. A failing disk is reported to the caller of `send`, but the message
   * stays in memory: it is already in the outbox and will be delivered.
   */
  async #append(record) {
    this.#logRecords += 1;
    await this.#log.append(record);
    this.#maybeCompact();
  }

  async #receive(message) {
    const text = decodeIncomingText(message.content);
    if (text === null) {
      // Acknowledged all the same: the sender cannot fix a message this node will never accept.
      this.#stats.ignored += 1;
      return;
    }
    const peer = message.from;
    if (peer === this.#selfId) return;
    if (this.#byKey.has(`${peer}:${message.id}`)) {
      this.#stats.duplicates += 1;
      return;
    }
    const chat = {
      seq: this.#nextSeq,
      id: message.id,
      peer,
      direction: 'in',
      text,
      ts: isInteger(message.ts) ? message.ts : Math.trunc(this.#now()),
      at: Math.trunc(this.#now()),
      state: 'received',
    };
    this.#nextSeq += 1;
    this.#insert(chat);
    this.#stats.received += 1;
    this.#emit('chat.message', { message: { ...chat } });
    // A failed append rejects here, so the messenger does not acknowledge and the sender
    // retransmits; the retry finds the message in memory and is a harmless duplicate.
    await this.#append(this.#record(chat));
  }

  /** Move an outgoing message to a later state, if it is one of ours and is not there yet. */
  #advance(peer, id, state) {
    if (this.#closed || typeof peer !== 'string' || typeof id !== 'string') return;
    const key = `${peer}:${id}`;
    const message = this.#byKey.get(key);
    if (message === undefined) {
      if (this.#sending > 0 && this.#early.size < EARLY_EVENTS_MAX) {
        const held = this.#early.get(key);
        if (held === undefined || STATE_RANK[state] > STATE_RANK[held]) this.#early.set(key, state);
      }
      return;
    }
    if (message.direction !== 'out' || STATE_RANK[state] <= STATE_RANK[message.state]) return;
    message.state = state;
    this.#stats.stateChanges += 1;
    this.#emit('chat.state', { id, peer, state });
    this.#append({ op: 'state', id, peer, state, at: Math.trunc(this.#now()) }).catch(() => {
      // A state record that cannot be written costs a stale label after a restart, never a
      // message: the message itself is already in the log.
    });
  }

  #maybeCompact() {
    if (this.#compacting !== null || this.#closed) return;
    const retained = this.#byKey.size;
    if (this.#logRecords < COMPACT_MIN_RECORDS || this.#logRecords <= retained * 2) return;
    const snapshot = [...this.#byKey.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((message) => this.#record(message));
    this.#logRecords = snapshot.length;
    this.#compacting = this.#log.rewrite(snapshot).then(
      () => {
        this.#stats.compactions += 1;
      },
      () => {
        this.#stats.compactErrors += 1;
      },
    ).finally(() => {
      this.#compacting = null;
    });
  }
}

// ---------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------

function invalid(ctx, field, problem) {
  return ctx.api.error(400, 'invalid_request', `${field}: ${problem}`, { field, problem });
}

/** A body that is a JSON object with exactly the allowed fields. */
function bodyFields(ctx, body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid(ctx, 'body', 'a JSON object is required');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(ctx, key, 'unknown field');
  }
  return body;
}

function queryInteger(ctx, query, name, { min, max }) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,15}$/.test(raw)) throw invalid(ctx, name, 'must be an integer');
  const value = Number(raw);
  if (value < min || value > max) throw invalid(ctx, name, `must be from ${min} to ${max}`);
  return value;
}

function checkQuery(ctx, query, allowed) {
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw invalid(ctx, key, 'unknown query parameter');
  }
}

/**
 * The chat endpoints of API.md section 6.5 as a service: `POST /messages`,
 * `GET /conversations` and `GET /conversations/:id`. The history itself lives in the
 * node (`node.sendMessage`, `node.conversations`, `node.conversation`); this service only
 * validates input and shapes the answers.
 *
 * @returns {object} a Service (ARCHITECTURE.md section 6) named `messages`
 */
export function createMessagesService() {
  return {
    name: 'messages',
    init(ctx) {
      const { node } = ctx;
      ctx.api.route('POST', '/messages', async (req) => {
        const body = bodyFields(ctx, req.body, ['to', 'text']);
        if (!isNodeId(body.to)) throw invalid(ctx, 'to', 'must be a NodeId');
        if (typeof body.text !== 'string') throw invalid(ctx, 'text', 'must be a string');
        try {
          return ctx.api.reply(202, { message: await node.sendMessage(body.to, body.text) });
        } catch (error) {
          if (error instanceof ConfigError) throw invalid(ctx, 'text', error.message);
          if (error instanceof StateError && error.message.startsWith('unknown-destination:')) {
            throw ctx.api.error(404, 'unknown_destination', 'no identity card known for that node', { to: body.to });
          }
          throw error;
        }
      }, { summary: 'send a chat message' });

      ctx.api.route('GET', '/conversations', (req) => {
        checkQuery(ctx, req.query, []);
        return { conversations: node.conversations() };
      }, { summary: 'conversation list' });

      ctx.api.route('GET', '/conversations/:id', (req) => {
        checkQuery(ctx, req.query, ['limit', 'before']);
        if (!isNodeId(req.params.id)) throw invalid(ctx, 'id', 'must be a NodeId');
        const limit = queryInteger(ctx, req.query, 'limit', { min: 1, max: MAX_PAGE });
        const before = queryInteger(ctx, req.query, 'before', { min: 1, max: Number.MAX_SAFE_INTEGER });
        const page = node.conversation(req.params.id, { limit, before });
        return { peer: req.params.id, items: page.items, nextBefore: page.nextBefore };
      }, { summary: 'messages with one node' });
    },
  };
}
