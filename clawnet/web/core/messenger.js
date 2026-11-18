/**
 * Reliable end-to-end messages for the web core: the parts of the engine's
 * ReliableMessenger and ConversationStore (`src/core/messaging/`) a phone needs to chat.
 *
 * Sending: a `msg` (UTF-8 text, 1 to 16384 bytes) is sealed once to the recipient's e2e key
 * (scheme 0x01, `meta { kind: "msg", ack: true }`) and kept, sealed, in an outbox in the
 * browser's storage. It is sent to the one neighbour, which routes it, and retransmitted
 * with the same id and an incremented `try` (jittered backoff from 2 s to 15 min, at most
 * four unacknowledged per destination) until an `ack` from the destination arrives or seven
 * days pass. The retransmissions continue only while the page is open.
 *
 * Receiving: at most `inboundPerSecond` DATA packets a second (with a burst allowance) are
 * opened, because opening is what costs; the rest are dropped for the sender to retransmit.
 * A DATA packet addressed to this node is opened (sender authenticated by the
 * Noise static key, the identity card and the sender's signature), checked against the
 * replay cache keyed by (sender, id), handled by kind, and acknowledged when it asks to be.
 * A duplicate is re-acknowledged, at most once a second, and not shown twice. As in the
 * engine, an ack counts only if it comes from the message's destination, and an unknown
 * kind is acknowledged and dropped.
 */

import { AuthError } from '../../src/core/errors.js';
import { PacketType, SealScheme } from '../../src/core/wire/types.js';
import { base64Decode, base64Encode, toHex, utf8, utf8Decode } from './bytes.js';
import { encodePacket } from './codec.js';
import { openMessage, sealMessage } from './envelope.js';
import { isValidNodeId, verifyCard } from './identity.js';
import { randomBytes } from './primitives.js';
import { validateDataHeader, validateMeta } from './schema.js';

export const MAX_TEXT_BYTES = 16384;
export const DEFAULTS = Object.freeze({
  ttl: 16,
  messageLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  maxClockSkewMs: 5 * 60 * 1000,
  retransmitMinMs: 2_000,
  retransmitMaxMs: 15 * 60 * 1000,
  retransmitJitter: 0.2,
  maxInFlightPerDestination: 4,
  outboxMaxEntries: 500,
  seenMaxEntries: 5000,
  messagesPerChat: 300,
  maxChats: 100,
  // About this many characters of stored conversations; older ones give way first.
  chatBytesMax: 1_000_000,
  // DATA packets opened per second, and in a burst. Each costs a key agreement and two
  // signature checks; beyond this they are dropped and the sender's retransmission retries.
  inboundPerSecond: 20,
  inboundBurst: 40,
});

const RE_ACK_INTERVAL_MS = 1000;

/** Characters of JSON a stored message takes besides its text, roughly. */
const MESSAGE_OVERHEAD = 200;

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {string} peer
 * @property {'in' | 'out'} direction
 * @property {string} text
 * @property {number} ts the sender's clock
 * @property {number} at this phone's clock when recorded
 * @property {'queued' | 'sent' | 'delivered' | 'expired' | 'received'} state
 */

export class Messenger {
  #identity;
  #storage;
  #cardOf;
  #remember;
  #transmit;
  #now;
  #rng;
  #emit;
  #o;
  #outbox = new Map();
  #seen = new Map();
  #reAcked = new Map();
  #chats = new Map();
  #timer = null;
  #closed = false;
  #inbound = null;
  stats = { sent: 0, retransmits: 0, acked: 0, expired: 0, received: 0, duplicates: 0, authFailures: 0, malformed: 0, unhandled: 0, rateLimited: 0, storageFailures: 0 };

  /**
   * @param {object} options
   * @param {import('./identity.js').Identity} options.identity
   * @param {ReturnType<import('./storage.js').createStorage>} options.storage
   * @param {(id: string) => object | null} options.cardOf identity card of a node, or null
   * @param {(card: object) => void} [options.remember] the verified card of a node this
   *   phone just wrote to or heard from
   * @param {(packet: Uint8Array) => boolean} options.transmit hand an encoded DATA packet to
   *   the link; false when there is no link
   * @param {(type: string, data: object) => void} [options.emit]
   * @param {() => number} [options.now]
   * @param {() => number} [options.rng]
   * @param {object} [options.settings] overrides of DEFAULTS
   */
  constructor({ identity, storage, cardOf, remember = () => {}, transmit, emit = () => {}, now = Date.now, rng = Math.random, settings = {} }) {
    this.#identity = identity;
    this.#storage = storage;
    this.#cardOf = cardOf;
    this.#remember = remember;
    this.#transmit = transmit;
    this.#emit = emit;
    this.#now = now;
    this.#rng = rng;
    this.#o = { ...DEFAULTS, ...settings };
    this.#load();
  }

  /**
   * Send a chat message.
   *
   * @param {string} dst NodeId
   * @param {string} text 1 to 16384 bytes of UTF-8
   * @returns {ChatMessage}
   * @throws {Error} with `code` "unknown-destination", "invalid-text" or "outbox-full"
   */
  sendText(dst, text) {
    if (!isValidNodeId(dst) || dst === this.#identity.nodeId) throw coded('unknown-destination', 'not a node this phone can write to');
    if (typeof text !== 'string' || text.trim() === '') throw coded('invalid-text', 'the message is empty');
    const content = utf8(text);
    if (content.length > MAX_TEXT_BYTES) throw coded('invalid-text', `a message is at most ${MAX_TEXT_BYTES} bytes`);
    const card = this.#cardOf(dst);
    const verdict = card === null ? { ok: false } : verifyCard(card);
    if (!verdict.ok || verdict.nodeId !== dst) throw coded('unknown-destination', 'this phone does not know that node\'s keys yet');
    if (this.#outbox.size >= this.#o.outboxMaxEntries) throw coded('outbox-full', 'too many messages are waiting to be delivered');
    const id = toHex(randomBytes(16));
    const createdAt = this.#now();
    const body = sealMessage({ sender: this.#identity, recipientE2eKey: verdict.e2ePublicKey, dst, id, meta: { kind: 'msg', ack: true }, content, now: createdAt });
    const entry = { id, dst, body, createdAt, expiresAt: createdAt + this.#o.messageLifetimeMs, attempts: 0, tryBase: 0, dueAt: 0 };
    this.#outbox.set(id, entry);
    const message = { id, peer: dst, direction: 'out', text, ts: createdAt, at: createdAt, state: 'queued' };
    this.#remember(card);
    this.#addChat(message);
    this.#saveOutbox();
    this.#pump();
    return { ...message, state: this.#chatState(dst, id) ?? message.state };
  }

  /** The link came up: messages waiting for one may go now. */
  linkUp() {
    for (const entry of this.#outbox.values()) {
      if (entry.attempts === 0) entry.dueAt = 0;
      else entry.dueAt = Math.min(entry.dueAt, this.#now() + this.#rng() * 2000);
    }
    this.#pump();
  }

  /**
   * A DATA packet for this node (scheme 0x01). Never throws.
   *
   * @param {{ header: object, body: Uint8Array }} packet
   */
  handleData(packet) {
    try {
      this.#receive(packet);
    } catch {
      this.stats.malformed += 1;
    }
  }

  /**
   * Seal and send an unreliable message (a probe reply). Best effort.
   *
   * @param {string} dst
   * @param {object} meta with `kind`
   * @returns {boolean}
   */
  sendOnce(dst, meta) {
    const card = this.#cardOf(dst);
    const verdict = card === null ? { ok: false } : verifyCard(card);
    if (!verdict.ok || verdict.nodeId !== dst) return false;
    const id = toHex(randomBytes(16));
    const body = sealMessage({ sender: this.#identity, recipientE2eKey: verdict.e2ePublicKey, dst, id, meta, now: this.#now() });
    return this.#transmit(encodePacket({ type: PacketType.DATA, header: { id, dst, ttl: this.#o.ttl, try: 0 }, body }));
  }

  /** @returns {Array<{ peer: string, last: ChatMessage | null, count: number, unread: number }>} newest first */
  conversations() {
    const out = [];
    for (const [peer, list] of this.#chats) out.push({ peer, last: list.at(-1) ?? null, count: list.length });
    return out.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }

  /** @param {string} peer @returns {ChatMessage[]} oldest first */
  messages(peer) {
    return (this.#chats.get(peer) ?? []).map((m) => ({ ...m }));
  }

  /** @returns {number} unacknowledged messages */
  get pending() {
    return this.#outbox.size;
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#saveOutbox();
    this.#saveSeen();
  }

  // ------------------------------------------------------------------ sending

  #pump() {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    const now = this.#now();
    const inFlight = new Map();
    for (const entry of this.#outbox.values()) {
      if (entry.attempts > 0) inFlight.set(entry.dst, (inFlight.get(entry.dst) ?? 0) + 1);
    }
    let next = Infinity;
    let changed = false;
    for (const entry of [...this.#outbox.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (entry.expiresAt <= now) {
        this.#outbox.delete(entry.id);
        this.stats.expired += 1;
        this.#setChatState(entry.dst, entry.id, 'expired');
        changed = true;
        continue;
      }
      if (entry.dueAt > now) {
        next = Math.min(next, entry.dueAt);
        continue;
      }
      if (entry.attempts === 0 && (inFlight.get(entry.dst) ?? 0) >= this.#o.maxInFlightPerDestination) continue;
      const tryNo = (entry.tryBase + entry.attempts) % 256;
      const packet = encodePacket({ type: PacketType.DATA, header: { id: entry.id, dst: entry.dst, ttl: this.#o.ttl, try: tryNo }, body: entry.body });
      if (!this.#transmit(packet)) {
        // No link: wait for linkUp().
        continue;
      }
      if (entry.attempts === 0) inFlight.set(entry.dst, (inFlight.get(entry.dst) ?? 0) + 1);
      entry.attempts += 1;
      this.stats.sent += 1;
      if (entry.attempts > 1) this.stats.retransmits += 1;
      entry.dueAt = now + this.#backoff(entry.attempts);
      next = Math.min(next, entry.dueAt);
      if (entry.attempts === 1) {
        this.#setChatState(entry.dst, entry.id, 'sent');
        changed = true;
      }
    }
    if (changed) this.#saveOutbox();
    if (next !== Infinity) this.#timer = setTimeout(() => this.#pump(), Math.max(50, Math.min(next - now, 2 ** 31 - 1)));
  }

  #backoff(attempts) {
    const { retransmitMinMs, retransmitMaxMs, retransmitJitter } = this.#o;
    const base = Math.min(retransmitMaxMs, retransmitMinMs * 2 ** Math.min(attempts - 1, 30));
    return Math.max(1, Math.round(base * (1 + retransmitJitter * (2 * this.#rng() - 1))));
  }

  #sendAck(dst, card, id) {
    try {
      const e2e = base64Decode(card.e2e, 32);
      const ackId = toHex(randomBytes(16));
      const body = sealMessage({ sender: this.#identity, recipientE2eKey: e2e, dst, id: ackId, meta: { kind: 'ack', id }, now: this.#now() });
      this.#transmit(encodePacket({ type: PacketType.DATA, header: { id: ackId, dst, ttl: this.#o.ttl, try: 0 }, body }));
    } catch {
      // Best effort: the sender's next retransmission covers a lost ack.
    }
  }

  // ------------------------------------------------------------------ receiving

  #receive(packet) {
    const { header, body } = packet;
    if (!validateDataHeader(header).ok || header.dst !== this.#identity.nodeId || !(body instanceof Uint8Array) || body.length === 0) {
      this.stats.malformed += 1;
      return;
    }
    if (body[0] !== SealScheme.NOISE_X) {
      // File chunks (scheme 0x02) are for nodes that receive files; the phone does not.
      this.stats.unhandled += 1;
      return;
    }
    if (!this.#takeInbound()) {
      this.stats.rateLimited += 1;
      return;
    }
    let opened;
    try {
      opened = openMessage({ recipient: this.#identity, dst: header.dst, id: header.id, body, now: this.#now(), maxAgeMs: this.#o.messageLifetimeMs, maxFutureMs: this.#o.maxClockSkewMs });
    } catch (err) {
      if (err instanceof AuthError) this.stats.authFailures += 1;
      return;
    }
    const { senderId, card, meta, content } = opened;
    if (!validateMeta(meta).ok) {
      this.stats.malformed += 1;
      return;
    }
    const key = `${senderId}:${header.id}`;
    const wantsAck = meta.ack === true;
    // A message still in the conversation is a duplicate even after the replay cache, which
    // is bounded, has let its entry go.
    if (this.#seenHas(key) || (meta.kind === 'msg' && this.#chatState(senderId, header.id) !== null)) {
      this.stats.duplicates += 1;
      if (wantsAck) {
        const last = this.#reAcked.get(key) ?? -Infinity;
        if (this.#now() - last >= RE_ACK_INTERVAL_MS) {
          this.#reAcked.set(key, this.#now());
          if (this.#reAcked.size > 1000) this.#reAcked.delete(this.#reAcked.keys().next().value);
          this.#sendAck(senderId, card, header.id);
        }
      }
      return;
    }
    if (meta.kind === 'ack') {
      const entry = this.#outbox.get(meta.id);
      if (entry !== undefined && entry.dst === senderId) {
        this.#outbox.delete(entry.id);
        this.stats.acked += 1;
        this.#setChatState(entry.dst, entry.id, 'delivered');
        this.#saveOutbox();
        this.#emit('delivered', { id: entry.id, peer: entry.dst });
      }
      this.#markSeen(key, meta.ts);
      return;
    }
    if (meta.kind === 'msg') {
      let text = null;
      if (content.length >= 1 && content.length <= MAX_TEXT_BYTES) {
        try {
          text = utf8Decode(content);
        } catch {
          text = null;
        }
      }
      if (text !== null) {
        this.stats.received += 1;
        const message = { id: header.id, peer: senderId, direction: 'in', text, ts: meta.ts, at: this.#now(), state: 'received' };
        this.#remember(card);
        this.#addChat(message);
        this.#emit('message', { ...message });
      } else {
        this.stats.malformed += 1;
      }
    } else {
      // A kind this phone has no handler for (a file offer, a cast service message...).
      this.stats.unhandled += 1;
      this.#emit('unhandled', { from: senderId, kind: meta.kind });
    }
    this.#markSeen(key, meta.ts);
    if (wantsAck) this.#sendAck(senderId, card, header.id);
  }

  /** One token of the inbound budget, or false when it is spent. */
  #takeInbound() {
    const now = this.#now();
    const bucket = (this.#inbound ??= { tokens: this.#o.inboundBurst, at: now });
    const since = now - bucket.at;
    if (since > 0) bucket.tokens = Math.min(this.#o.inboundBurst, bucket.tokens + (since * this.#o.inboundPerSecond) / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #seenHas(key) {
    const exp = this.#seen.get(key);
    if (exp === undefined) return false;
    if (exp <= this.#now()) {
      this.#seen.delete(key);
      return false;
    }
    return true;
  }

  #markSeen(key, ts) {
    this.#seen.set(key, ts + this.#o.messageLifetimeMs + this.#o.maxClockSkewMs);
    if (this.#seen.size > this.#o.seenMaxEntries) {
      // Drop the entries that expire first.
      const sorted = [...this.#seen].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, this.#seen.size - this.#o.seenMaxEntries)) this.#seen.delete(k);
    }
    this.#saveSeen();
  }

  // ------------------------------------------------------------------ conversations

  #addChat(message) {
    let list = this.#chats.get(message.peer);
    if (list === undefined) {
      list = [];
      this.#chats.set(message.peer, list);
    }
    list.push(message);
    if (list.length > this.#o.messagesPerChat) list.splice(0, list.length - this.#o.messagesPerChat);
    this.#trimChats(message.peer);
    this.#saveChats();
    this.#emit('chat', { peer: message.peer });
  }

  /**
   * At most `maxChats` conversations and about `chatBytesMax` characters of them: the least
   * recent conversations go first, then the oldest messages of `keep`, which is never
   * dropped whole.
   */
  #trimChats(keep) {
    const sizeOf = (list) => list.reduce((sum, m) => sum + m.text.length + MESSAGE_OVERHEAD, 0);
    const sizes = new Map();
    let total = 0;
    for (const [peer, list] of this.#chats) {
      sizes.set(peer, sizeOf(list));
      total += sizes.get(peer);
    }
    const leastRecentFirst = this.conversations().map((c) => c.peer).filter((peer) => peer !== keep).reverse();
    for (const peer of leastRecentFirst) {
      if (this.#chats.size <= this.#o.maxChats && total <= this.#o.chatBytesMax) break;
      this.#chats.delete(peer);
      total -= sizes.get(peer);
    }
    const list = this.#chats.get(keep);
    while (list !== undefined && list.length > 1 && total > this.#o.chatBytesMax) {
      total -= list[0].text.length + MESSAGE_OVERHEAD;
      list.shift();
    }
  }

  #chatState(peer, id) {
    return this.#chats.get(peer)?.find((m) => m.id === id)?.state ?? null;
  }

  #setChatState(peer, id, state) {
    const message = this.#chats.get(peer)?.find((m) => m.id === id);
    if (message === undefined || message.state === state) return;
    // Delivered is final; a late "sent" never overwrites it.
    if (message.state === 'delivered') return;
    message.state = state;
    this.#saveChats();
    this.#emit('chat', { peer });
  }

  // ------------------------------------------------------------------ storage

  #load() {
    const outbox = this.#storage.get('outbox');
    if (Array.isArray(outbox)) {
      for (const item of outbox.slice(0, this.#o.outboxMaxEntries)) {
        try {
          if (!isValidNodeId(item.dst) || !/^[0-9a-f]{32}$/.test(item.id)) continue;
          // A fresh starting point for `try` after a reload, as the engine does after a restart.
          const tryBase = Math.floor(this.#rng() * 256);
          this.#outbox.set(item.id, { id: item.id, dst: item.dst, body: base64Decode(item.body), createdAt: item.createdAt, expiresAt: item.expiresAt, attempts: 0, tryBase, dueAt: 0 });
        } catch {
          // A damaged entry is dropped.
        }
      }
    }
    const seen = this.#storage.get('seen');
    if (Array.isArray(seen)) {
      const now = this.#now();
      for (const item of seen) if (Array.isArray(item) && typeof item[0] === 'string' && Number.isSafeInteger(item[1]) && item[1] > now) this.#seen.set(item[0], item[1]);
    }
    const chats = this.#storage.get('chats');
    if (chats !== null && typeof chats === 'object') {
      for (const [peer, list] of Object.entries(chats)) {
        if (!isValidNodeId(peer) || !Array.isArray(list)) continue;
        const clean = list.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string' && (m.direction === 'in' || m.direction === 'out'));
        this.#chats.set(peer, clean.slice(-this.#o.messagesPerChat));
      }
    }
  }

  #saveOutbox() {
    this.#save('outbox', [...this.#outbox.values()].map((e) => ({ id: e.id, dst: e.dst, body: base64Encode(e.body), createdAt: e.createdAt, expiresAt: e.expiresAt })));
  }

  #saveSeen() {
    this.#save('seen', [...this.#seen]);
  }

  #saveChats() {
    this.#save('chats', Object.fromEntries(this.#chats));
  }

  /** The page keeps working from memory when the browser refuses to store; it is told. */
  #save(key, value) {
    if (this.#storage.set(key, value)) return;
    this.stats.storageFailures += 1;
    this.#emit('storage-failed', { key });
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
