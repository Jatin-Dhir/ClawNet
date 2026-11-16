/**
 * The authenticated, encrypted link between two nodes (DESIGN.md section 4 and 15.4 to
 * 15.7; ARCHITECTURE.md 5.2).
 *
 * establishChannel() runs the Noise handshake over a connected stream: Noise_XX, or
 * Noise_XXpsk0 when the network has a pre-shared key, so that a non-member's first
 * message fails before any Diffie-Hellman work and learns nothing about the responder.
 * After it, the remote static key must equal the `link` key of the identity card the
 * peer sent, the card must verify, and the owner's `authorize` decides admission.
 *
 * The resulting SecureChannel turns packets into frames, frames into a byte stream and
 * that stream into Noise transport records (`u16be length || ciphertext`), and back. It
 * is the only module that turns socket bytes into packets. Its send scheduler has three
 * strict priority classes (DESIGN.md 15.7): control, then acks, then data, switching only
 * at frame boundaries, and it writes only while the stream accepts more (backpressure).
 *
 * Queue bounds and drop policy:
 *   - acks and data share `maxQueueBytes`. Data is refused (send returns false) once that
 *     bound would be exceeded; acks may use a further reserve of a quarter of the bound,
 *     so data is always dropped before acks are. Nothing already accepted is discarded.
 *   - control frames have their own bound, `maxControlBytes`. Control traffic is small
 *     and must never wait behind data, so a control queue that overflows means the peer
 *     has stopped reading: the link is closed with reason "overflow".
 *
 * Each direction calls Noise Rekey() after every `rekeyInterval` records.
 */

import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';

import { HandshakeState } from '../crypto/noise.js';
import { Identity, verifyCard } from '../crypto/identity.js';
import { assertBytes, base64Decode, randomBytes, timingSafeEqual } from '../crypto/primitives.js';
import { ConfigError, HandshakeError, WireError } from '../errors.js';
import {
  FrameDecoder,
  assertSendable,
  decodePacket,
  encodeFrame,
  encodePacket,
  packetKind,
  PacketKind,
} from '../wire/codec.js';
import { canonicalBytes, parseCanonical } from '../wire/canonical.js';
import {
  HANDSHAKE_VERSION,
  isNetworkId,
  validateByeHeader,
  validateHandshakePayload,
  validatePingHeader,
} from '../wire/schema.js';
import { Domain, Limits, PacketType } from '../wire/types.js';
import { normalizeIp } from './tcp.js';

/** Largest plaintext one transport record carries (NOISE_MAX_PLAINTEXT of noise.js). */
export const RECORD_PLAINTEXT_MAX = 65519;

/** Default bound on queued ack and data bytes per link. */
export const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

/** Default bound on queued control bytes per link; overflowing it closes the link. */
export const DEFAULT_MAX_CONTROL_BYTES = 4 * 1024 * 1024;

/** Default time a closing link waits for its socket to finish before destroying it. */
export const DEFAULT_LINGER_MS = 500;

/** Send priority classes, highest first (DESIGN.md 15.7). */
export const SendPriority = Object.freeze({
  CONTROL: 'control',
  ACK: 'ack',
  DATA: 'data',
});

/**
 * BYE reasons that travel on the wire (ARCHITECTURE.md 4.1). A received reason outside
 * this list is reported as "unknown".
 */
export const BYE_REASONS = Object.freeze([
  'shutdown', 'manual', 'duplicate', 'replaced', 'full', 'blocked',
  'not-allowed', 'self', 'timeout', 'protocol',
]);

const EMPTY = Buffer.alloc(0);
const SEPARATOR = Buffer.from([0]);
const RECORD_PREFIX = 2;
const AEAD_TAG = 16;
const PING_NONCE_BYTES = 8;
const KNOWN_BYE = new Set(BYE_REASONS);

/**
 * @typedef {object} LocalInfo  what a node tells a peer about itself
 * @property {string} agent     software name and version, AGENT_PATTERN
 * @property {{ relay: boolean, mailbox: boolean, transit: boolean }} caps
 * @property {string[]} listen  addresses it can be dialed at, at most Limits.MAX_PEER_ADDRS
 */

/**
 * Run the link handshake over a connected stream and return the secure channel.
 *
 * The initiator sends `-> e` with an empty payload; the responder answers with its
 * handshake payload `{ v, card, net, agent, caps, listen, observed, ts }` (canonical
 * JSON) in message 2; the initiator verifies it and sends its own in message 3; the
 * responder verifies that. Each side then calls `authorize`. The responder's first frame
 * on the encrypted stream is the admission confirmation: `PING` with a fresh nonce
 * (admitted) or `BYE {reason}` (refused). The initiator resolves only after reading it,
 * so a refused initiator never believes it has a link.
 *
 * Verification of the peer's payload, in order, with the HandshakeError reason of each
 * failure: canonical JSON object (`bad-payload`), `v` is 1 (`version`), schema
 * (`bad-payload`), `net` (`network-mismatch`), Noise remote static key equals `card.link`
 * (`key-mismatch`), card signature (`bad-card`), `ts` within the clock skew
 * (`clock-skew`), then `authorize`. A Noise failure is `noise`, a stream that ends is
 * `closed`, the deadline is `handshake-timeout`.
 *
 * @param {object} options
 * @param {import('node:stream').Duplex} options.stream connected byte stream
 * @param {boolean} options.initiator      true for the side that connected
 * @param {Identity} options.identity      this node
 * @param {string} options.networkId       part of the prologue and checked in the payload
 * @param {Uint8Array | null} [options.networkKey] 32-byte network key: Noise_XXpsk0; null: Noise_XX
 * @param {(observed: string | null) => LocalInfo} options.buildLocal what to announce;
 *   `observed` is the IP the peer reported seeing us at (null on the responder)
 * @param {(peer: { id: string, card: object, payload: object, initiator: boolean }) => string | null}
 *   options.authorize returns null to admit, or a BYE reason to refuse
 * @param {() => number} [options.now] wall clock in ms; default Date.now
 * @param {number} options.handshakeTimeoutMs deadline for the whole handshake
 * @param {number} options.maxClockSkewMs  largest accepted |payload.ts - now()|
 * @param {number} [options.maxQueueBytes]   ack and data queue bound
 * @param {number} [options.maxControlBytes] control queue bound
 * @param {number} [options.rekeyInterval]   records per direction between rekeys;
 *   default Limits.REKEY_INTERVAL
 * @returns {Promise<SecureChannel>} a channel not yet started: assign its callbacks, then
 *   call start()
 * @throws {HandshakeError} for every failure listed above; the stream is destroyed
 * @throws {ConfigError} for invalid options (local misuse)
 */
export async function establishChannel(options) {
  const opts = checkOptions(options);
  const { stream, initiator } = opts;
  const startedAt = performance.now();
  const reader = new MessageReader(stream);
  let channel = null;
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new HandshakeError('handshake-timeout', `handshake did not complete in ${opts.handshakeTimeoutMs} ms`));
    }, opts.handshakeTimeoutMs);
  });
  // Rejections of the deadline are observed through the race below; this keeps an
  // unraced rejection (after success) from being reported as unhandled.
  deadline.catch(() => {});
  try {
    const run = initiator ? runInitiator(opts, reader, startedAt) : runResponder(opts, reader, startedAt);
    const outcome = await Promise.race([
      run.then(result => {
        channel = result.channel;
        return result;
      }),
      deadline,
    ]);
    return outcome.channel;
  } catch (err) {
    reader.fail(err);
    if (channel !== null && !channel.closed) channel.destroy();
    if (!stream.destroyed) stream.destroy();
    throw err instanceof HandshakeError || err instanceof ConfigError
      ? err
      : new HandshakeError('noise', 'handshake failed', { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function runInitiator(opts, reader, startedAt) {
  const handshake = newHandshake(opts);
  writeHandshakeMessage(opts.stream, handshake.writeMessage(EMPTY));
  const sentAt = performance.now();
  const second = await reader.next();
  const handshakeRttMs = performance.now() - sentAt;
  const peer = verifyPeer(opts, readNoise(handshake, second), handshake.remoteStaticKey);
  const refusal = opts.authorize({ id: peer.id, card: peer.payload.card, payload: peer.payload, initiator: true });
  if (refusal !== null) throw refused(refusal, peer.id, 'refused by local policy');
  const local = localPayload(opts, peer.payload.observed);
  writeHandshakeMessage(opts.stream, handshake.writeMessage(local));
  const channel = new SecureChannel(KEY, {
    opts, handshake, peer, handshakeRttMs, startedAt, leftover: reader.detach(), awaitConfirmation: true,
  });
  await channel.confirmed;
  return { channel };
}

async function runResponder(opts, reader, startedAt) {
  const handshake = newHandshake(opts);
  const first = readNoise(handshake, await reader.next());
  // Message 1 carries no payload (DESIGN.md section 4). In plain XX it is not encrypted,
  // so a payload here is what an XXpsk0 initiator's tag looks like to a node without the
  // network key: reported as "noise", like every other key or network mismatch.
  if (first.length !== 0) throw new HandshakeError('noise', 'first handshake message carries a payload');
  writeHandshakeMessage(opts.stream, handshake.writeMessage(localPayload(opts, null)));
  const sentAt = performance.now();
  const third = await reader.next();
  const handshakeRttMs = performance.now() - sentAt;
  const peer = verifyPeer(opts, readNoise(handshake, third), handshake.remoteStaticKey);
  const refusal = opts.authorize({ id: peer.id, card: peer.payload.card, payload: peer.payload, initiator: false });
  const channel = new SecureChannel(KEY, {
    opts, handshake, peer, handshakeRttMs, startedAt, leftover: reader.detach(), awaitConfirmation: false,
  });
  if (refusal !== null) {
    // The refusal travels encrypted as the admission confirmation, so the initiator learns
    // why instead of seeing a bare disconnect.
    await channel.close(refusal);
    throw refused(refusal, peer.id, 'refused by local policy');
  }
  channel.confirm();
  return { channel };
}

function refused(reason, peer, message) {
  const err = new HandshakeError(reason, message);
  err.peer = peer;
  return err;
}

function newHandshake(opts) {
  const prologue = Buffer.concat([
    Buffer.from(Domain.LINK, 'utf8'),
    SEPARATOR,
    Buffer.from(opts.networkId, 'utf8'),
  ]);
  const s = opts.identity.linkKeyPair;
  try {
    return new HandshakeState({
      pattern: opts.networkKey === null ? 'XX' : 'XXpsk0',
      initiator: opts.initiator,
      prologue,
      s,
      psk: opts.networkKey ?? undefined,
    });
  } finally {
    // The getter hands out a copy; HandshakeState keeps (and later wipes) its own.
    s.privateKey.fill(0);
  }
}

function readNoise(handshake, message) {
  try {
    return handshake.readMessage(message);
  } catch (cause) {
    throw new HandshakeError('noise', 'handshake message rejected', { cause });
  }
}

function writeHandshakeMessage(stream, message) {
  const prefix = Buffer.allocUnsafe(RECORD_PREFIX);
  prefix.writeUInt16BE(message.length);
  stream.write(Buffer.concat([prefix, message]));
}

function localPayload(opts, observedByPeer) {
  const local = opts.buildLocal(observedByPeer);
  const payload = {
    v: HANDSHAKE_VERSION,
    card: opts.identity.card,
    net: opts.networkId,
    agent: local?.agent,
    caps: local?.caps,
    listen: local?.listen,
    observed: observedIp(opts.stream),
    ts: opts.now(),
  };
  const verdict = validateHandshakePayload(payload);
  if (!verdict.ok) throw new ConfigError(`buildLocal produced an invalid handshake payload: ${verdict.reason}`);
  return canonicalBytes(payload);
}

/** The peer's IP as this side sees it, for the payload's `observed`, or null. */
function observedIp(stream) {
  const ip = normalizeIp(stream.remoteAddress);
  return isIP(ip) === 0 ? null : ip;
}

/** The payload checks of ARCHITECTURE.md 5.2, in order. */
function verifyPeer(opts, bytes, remoteStatic) {
  let payload;
  try {
    payload = parseCanonical(bytes);
  } catch (cause) {
    throw new HandshakeError('bad-payload', 'handshake payload is not canonical JSON', { cause });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HandshakeError('bad-payload', 'handshake payload is not an object');
  }
  if (payload.v !== HANDSHAKE_VERSION) {
    throw new HandshakeError('version', 'unsupported handshake version');
  }
  const verdict = validateHandshakePayload(payload);
  if (!verdict.ok) throw new HandshakeError('bad-payload', `handshake payload rejected: ${verdict.reason}`);
  if (payload.net !== opts.networkId) {
    throw new HandshakeError('network-mismatch', 'peer is on another network');
  }
  const link = base64Decode(payload.card.link, 32);
  if (remoteStatic === null || !timingSafeEqual(link, remoteStatic)) {
    throw new HandshakeError('key-mismatch', 'Noise static key is not the link key of the card');
  }
  const card = verifyCard(payload.card);
  if (!card.ok) throw new HandshakeError('bad-card', `identity card rejected: ${card.reason}`);
  if (Math.abs(payload.ts - opts.now()) > opts.maxClockSkewMs) {
    const err = new HandshakeError('clock-skew', 'peer clock differs from ours by more than the allowed skew');
    err.peer = card.nodeId;
    throw err;
  }
  return { id: card.nodeId, payload: deepFreeze(payload) };
}

/** Reads `u16be length || message` handshake messages from a stream. */
class MessageReader {
  #stream;
  #chunks = new ChunkQueue();
  #waiter = null;
  #failure = null;
  #onData = chunk => {
    this.#chunks.push(chunk);
    this.#wake();
  };
  #onEnd = () => this.fail(new HandshakeError('closed', 'connection closed during the handshake'));
  #onError = cause => this.fail(new HandshakeError('closed', 'connection failed during the handshake', { cause }));

  constructor(stream) {
    this.#stream = stream;
    stream.on('data', this.#onData);
    stream.on('end', this.#onEnd);
    stream.on('close', this.#onEnd);
    stream.on('error', this.#onError);
    if (stream.destroyed) this.#onEnd();
  }

  /** @returns {Promise<Buffer>} the next handshake message */
  next() {
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
      this.#wake();
    });
  }

  fail(err) {
    this.#failure ??= err;
    this.#wake();
  }

  /** Stop listening and hand over the bytes received after the last message. */
  detach() {
    this.#stream.removeListener('data', this.#onData);
    this.#stream.removeListener('end', this.#onEnd);
    this.#stream.removeListener('close', this.#onEnd);
    this.#stream.removeListener('error', this.#onError);
    return this.#chunks.take(this.#chunks.length);
  }

  #wake() {
    if (this.#waiter === null) return;
    const waiter = this.#waiter;
    if (this.#chunks.length >= RECORD_PREFIX) {
      const length = this.#chunks.peekU16();
      if (this.#chunks.length >= RECORD_PREFIX + length) {
        this.#waiter = null;
        this.#chunks.take(RECORD_PREFIX);
        waiter.resolve(this.#chunks.take(length));
        return;
      }
    }
    if (this.#failure !== null) {
      this.#waiter = null;
      waiter.reject(this.#failure);
    }
  }
}

/**
 * A byte queue made of received chunks; copies each byte once when it is taken. The cost
 * is linear in the bytes received however finely the peer splits them into segments.
 */
class ChunkQueue {
  #list = [];
  /** Index in #list of the first chunk still holding bytes. */
  #first = 0;
  /** Offset of the first unread byte in that chunk. */
  #head = 0;
  length = 0;

  push(chunk) {
    if (chunk.length === 0) return;
    this.#list.push(chunk);
    this.length += chunk.length;
  }

  peekU16() {
    const first = this.#list[this.#first];
    if (first.length - this.#head >= 2) return first.readUInt16BE(this.#head);
    return (first[this.#head] << 8) | this.#list[this.#first + 1][0];
  }

  /** Remove and return the first `n` bytes (n <= length). */
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#list[this.#first];
      const available = chunk.length - this.#head;
      const want = Math.min(available, n - filled);
      chunk.copy(out, filled, this.#head, this.#head + want);
      filled += want;
      if (want === available) {
        this.#list[this.#first] = undefined;
        this.#first += 1;
        this.#head = 0;
      } else {
        this.#head += want;
      }
    }
    this.length -= n;
    if (this.#first === this.#list.length) {
      this.#list = [];
      this.#first = 0;
    } else if (this.#first > 1024 && this.#first * 2 > this.#list.length) {
      this.#list = this.#list.slice(this.#first);
      this.#first = 0;
    }
    return out;
  }
}

/** A FIFO with O(1) amortized shift. */
class Fifo {
  #items = [];
  #head = 0;

  get size() {
    return this.#items.length - this.#head;
  }

  push(item) {
    this.#items.push(item);
  }

  shift() {
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head += 1;
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }

  clear() {
    this.#items = [];
    this.#head = 0;
  }
}

// Only establishChannel constructs channels.
const KEY = Symbol('SecureChannel');

/**
 * An established link: an ordered, authenticated, encrypted packet stream.
 *
 * Assign `onPacket` (and optionally `onClose`, `onDrain`) before calling start(). Until
 * start(), received packets are held and reading is paused.
 */
export class SecureChannel {
  /** @type {string} the peer's NodeId, authenticated */
  remoteId;
  /** @type {Readonly<object>} the peer's identity card, verified */
  remoteCard;
  /** @type {Readonly<object>} the peer's handshake payload, verified and frozen */
  remotePayload;
  /** @type {boolean} */
  initiator;
  /** @type {Buffer} Noise handshake hash, identical on both ends */
  handshakeHash;
  /** @type {number} one handshake round trip in ms (message 1 to 2, or 2 to 3) */
  handshakeRttMs;
  /** @type {number} performance.now() when this side began the handshake */
  handshakeStartedAt;
  /** @type {{ host: string, port: number } | null} remote socket address */
  remoteAddress;
  /** @type {(packet: import('../wire/codec.js').Packet, size: number) => void} */
  onPacket = () => {};
  /** @type {(info: { reason: string, remote: boolean, error?: Error }) => void} */
  onClose = () => {};
  /** @type {() => void} called when queued ack and data bytes fall below half the bound */
  onDrain = () => {};

  #stream;
  #tx;
  #rx;
  #rekeyInterval;
  #maxQueueBytes;
  #maxControlBytes;
  #ackReserve;

  #queues = { control: new Fifo(), ack: new Fifo(), data: new Fifo() };
  #queuedControl = 0;
  #queuedNormal = 0;
  #current = null;
  #currentOffset = 0;
  #writable = true;
  #flushScheduled = false;
  #wasOver = false;

  #in = new ChunkQueue();
  #decoder = new FrameDecoder();
  #inPackets = new Fifo();
  #processing = false;
  #started = false;
  #readPaused = false;
  #lastRecordAt;

  #confirm = null;
  /** @type {Promise<void> | null} resolves when the responder's admission is read */
  confirmed = null;

  #closeInfo = null;
  #closing = null;
  #ending = false;
  #streamClosed = false;
  #streamClosedWaiters = [];

  #stats = {
    recordsIn: 0, recordsOut: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
    rekeysIn: 0, rekeysOut: 0, sendRefused: 0,
  };

  /** @param {symbol} key internal; use establishChannel() */
  constructor(key, { opts, handshake, peer, handshakeRttMs, startedAt, leftover, awaitConfirmation }) {
    if (key !== KEY) throw new ConfigError('use establishChannel() to create a SecureChannel');
    const { tx, rx } = handshake.split();
    this.#tx = tx;
    this.#rx = rx;
    this.#stream = opts.stream;
    this.#rekeyInterval = opts.rekeyInterval;
    this.#maxQueueBytes = opts.maxQueueBytes;
    this.#maxControlBytes = opts.maxControlBytes;
    this.#ackReserve = Math.floor(opts.maxQueueBytes / 4);
    this.remoteId = peer.id;
    this.remotePayload = peer.payload;
    this.remoteCard = peer.payload.card;
    this.initiator = opts.initiator;
    this.handshakeHash = handshake.handshakeHash;
    this.handshakeRttMs = handshakeRttMs;
    this.handshakeStartedAt = startedAt;
    this.#lastRecordAt = performance.now();
    const ip = observedIp(opts.stream);
    this.remoteAddress = ip === null ? null : { host: ip, port: opts.stream.remotePort ?? 0 };

    if (awaitConfirmation) {
      this.confirmed = new Promise((resolve, reject) => {
        this.#confirm = { resolve, reject };
      });
    }
    const stream = this.#stream;
    stream.on('data', chunk => this.#onData(chunk));
    stream.on('end', () => this.#remoteGone('eof'));
    stream.on('error', error => this.#remoteGone('socket', error));
    stream.on('close', () => {
      this.#streamClosed = true;
      for (const wake of this.#streamClosedWaiters.splice(0)) wake();
      this.#remoteGone('eof');
    });
    stream.on('drain', () => {
      this.#writable = true;
      this.#scheduleFlush();
    });
    if (leftover.length > 0) this.#onData(leftover);
    else this.#updateFlow();
  }

  /** @returns {boolean} true once the channel has closed or begun closing */
  get closed() {
    return this.#closeInfo !== null;
  }

  /** @returns {number} ack and data bytes waiting to be written */
  get queuedBytes() {
    return this.#queuedNormal;
  }

  /** @returns {number} control bytes waiting to be written */
  get queuedControlBytes() {
    return this.#queuedControl;
  }

  /** @returns {number} performance.now() of the last authenticated record received */
  get lastRecordAt() {
    return this.#lastRecordAt;
  }

  /** Begin delivering received packets to onPacket. */
  start() {
    if (this.#started) return;
    this.#started = true;
    this.#process();
  }

  /**
   * Queue a packet.
   *
   * @param {import('../wire/codec.js').Packet | Uint8Array} packet a packet object, or an
   *   already encoded packet
   * @param {object} [options]
   * @param {"control" | "ack" | "data"} [options.priority] default: "control" for
   *   link-local types, "data" for routed types
   * @returns {boolean} true if queued; false if the channel is closed or the class's queue
   *   is full (nothing is queued then). A control overflow also closes the channel.
   * @throws {WireError} if the packet cannot be encoded or exceeds the send limit of its
   *   type (codec.assertSendable): a local bug, not a peer's fault
   */
  send(packet, { priority } = {}) {
    const encoded = packet instanceof Uint8Array ? packet : encodePacket(packet);
    assertSendable(encoded);
    const kind = packetKind(encoded[0]);
    const cls = priority ?? (kind === PacketKind.ROUTED ? SendPriority.DATA : SendPriority.CONTROL);
    if (cls !== SendPriority.CONTROL && cls !== SendPriority.ACK && cls !== SendPriority.DATA) {
      throw new ConfigError('priority must be "control", "ack" or "data"');
    }
    if (this.#closeInfo !== null) {
      this.#stats.sendRefused += 1;
      return false;
    }
    const frame = encodeFrame(encoded);
    if (cls === SendPriority.CONTROL) {
      if (this.#queuedControl + frame.length > this.#maxControlBytes) {
        this.#stats.sendRefused += 1;
        this.#shutdown({ reason: 'overflow', remote: false }, null);
        return false;
      }
      this.#queuedControl += frame.length;
    } else {
      const limit = this.#maxQueueBytes + (cls === SendPriority.ACK ? this.#ackReserve : 0);
      if (this.#queuedNormal + frame.length > limit) {
        this.#stats.sendRefused += 1;
        this.#wasOver = true;
        return false;
      }
      this.#queuedNormal += frame.length;
      if (this.#queuedNormal > this.#maxQueueBytes / 2) this.#wasOver = true;
    }
    this.#queues[cls].push(frame);
    this.#stats.packetsOut += 1;
    this.#scheduleFlush();
    return true;
  }

  /** Stop delivering packets and stop reading from the stream (TCP then pushes back). */
  pauseReading() {
    this.#readPaused = true;
    this.#updateFlow();
  }

  /** Undo pauseReading(). */
  resumeReading() {
    if (!this.#readPaused) return;
    this.#readPaused = false;
    this.#process();
  }

  /**
   * Close the link. With a reason, `BYE {reason}` is sent first as control. Queued acks
   * and data are discarded; control frames already queued are still sent.
   *
   * @param {string} [reason] a BYE reason; omitted closes without BYE (reported as "manual")
   * @param {{ lingerMs?: number }} [options] how long to wait for the stream to finish
   * @returns {Promise<void>} resolves when the stream is closed
   */
  close(reason, { lingerMs = DEFAULT_LINGER_MS } = {}) {
    if (this.#closing !== null) return this.#closing;
    if (reason !== undefined) {
      const verdict = validateByeHeader({ reason });
      if (!verdict.ok) throw new ConfigError('close reason must match the BYE reason pattern');
    }
    const info = { reason: reason ?? 'manual', remote: false };
    return this.#shutdown(info, reason ?? null, lingerMs);
  }

  /** Close immediately without sending anything. */
  destroy() {
    if (this.#closeInfo === null) this.#emitClose({ reason: 'manual', remote: false });
    this.#confirmFailed(new HandshakeError('closed', 'channel destroyed'));
    this.#stream.destroy();
    this.#closing ??= Promise.resolve();
  }

  /**
   * @returns {{ recordsIn: number, recordsOut: number, packetsIn: number, packetsOut: number,
   *   bytesIn: number, bytesOut: number, rekeysIn: number, rekeysOut: number,
   *   sendRefused: number, queuedBytes: number, queuedControlBytes: number }}
   */
  stats() {
    return { ...this.#stats, queuedBytes: this.#queuedNormal, queuedControlBytes: this.#queuedControl };
  }

  /** Responder side: send the admission confirmation (a PING with a fresh nonce). */
  confirm() {
    this.send({ type: PacketType.PING, header: { n: randomNonce() } }, { priority: SendPriority.CONTROL });
  }

  // ------------------------------------------------------------------ closing

  #shutdown(info, byeReason, lingerMs = DEFAULT_LINGER_MS) {
    if (this.#closing !== null) return this.#closing;
    this.#emitClose(info);
    this.#confirmFailed(new HandshakeError('closed', 'channel closed before admission'));
    // Acks and data are dropped; a frame already being written must still be completed,
    // or the peer would parse the BYE as part of it.
    this.#queues.ack.clear();
    this.#queues.data.clear();
    this.#queuedNormal = 0;
    if (info.reason === 'overflow') {
      this.#stream.destroy();
      this.#closing = Promise.resolve();
      return this.#closing;
    }
    if (byeReason !== null) {
      const frame = encodeFrame(encodePacket({ type: PacketType.BYE, header: { reason: byeReason } }));
      this.#queues.control.push(frame);
      this.#queuedControl += frame.length;
    }
    this.#ending = true;
    this.#flush();
    this.#closing = this.#awaitStreamClose(lingerMs);
    return this.#closing;
  }

  /**
   * Resolve when the stream has closed, destroying it after `lingerMs` if the peer has not
   * closed its side. Without the deadline a peer that never closes keeps the socket (and
   * its file descriptor) for as long as it likes.
   */
  #awaitStreamClose(lingerMs) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#stream.destroy();
        resolve();
      }, lingerMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.#streamClosed) done();
      else this.#streamClosedWaiters.push(done);
    });
  }

  #emitClose(info) {
    if (this.#closeInfo !== null) return;
    this.#closeInfo = info;
    try {
      this.onClose(info);
    } catch {
      // The owner's bookkeeping failing must not keep the socket open.
    }
  }

  #remoteGone(reason, error) {
    if (this.#closeInfo === null) {
      const info = { reason, remote: true };
      if (error !== undefined) info.error = error;
      this.#emitClose(info);
      this.#confirmFailed(new HandshakeError('closed', 'connection closed before admission'));
    }
    this.#closing ??= Promise.resolve();
    if (!this.#stream.destroyed) this.#stream.destroy();
  }

  #fail(reason, sendBye) {
    if (this.#closeInfo !== null) return;
    if (this.#confirm !== null) {
      this.#confirmFailed(new HandshakeError('protocol', 'admission confirmation was not a valid frame'));
    }
    this.#shutdown({ reason, remote: false }, sendBye ? reason : null);
    if (!sendBye) this.#stream.destroy();
  }

  #confirmFailed(err) {
    if (this.#confirm === null) return;
    const { reject } = this.#confirm;
    this.#confirm = null;
    reject(err);
  }

  // ------------------------------------------------------------------ writing

  #scheduleFlush() {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush() {
    if (this.#stream.destroyed || this.#stream.writableEnded) return;
    while (this.#writable) {
      const plaintext = this.#nextRecordPlaintext();
      if (plaintext === null) break;
      const ciphertext = this.#tx.encryptWithAd(EMPTY, plaintext);
      const index = this.#stats.recordsOut;
      this.#stats.recordsOut += 1;
      if ((index + 1) % this.#rekeyInterval === 0) {
        this.#tx.rekey();
        this.#stats.rekeysOut += 1;
      }
      const record = Buffer.allocUnsafe(RECORD_PREFIX + ciphertext.length);
      record.writeUInt16BE(ciphertext.length, 0);
      ciphertext.copy(record, RECORD_PREFIX);
      this.#stats.bytesOut += record.length;
      if (!this.#stream.write(record)) this.#writable = false;
    }
    if (this.#ending && this.#current === null && this.#queues.control.size === 0) {
      this.#stream.end();
    }
    if (this.#wasOver && this.#queuedNormal < this.#maxQueueBytes / 2 && this.#closeInfo === null) {
      this.#wasOver = false;
      try {
        this.onDrain();
      } catch {
        // A failing observer must not stop the writer.
      }
    }
  }

  /** Up to RECORD_PLAINTEXT_MAX bytes of queued frames, highest priority first, or null. */
  #nextRecordPlaintext() {
    const pieces = [];
    let space = RECORD_PLAINTEXT_MAX;
    while (space > 0) {
      if (this.#current === null && !this.#pickFrame()) break;
      const remaining = this.#current.length - this.#currentOffset;
      const take = Math.min(space, remaining);
      pieces.push(this.#current.subarray(this.#currentOffset, this.#currentOffset + take));
      space -= take;
      this.#currentOffset += take;
      if (this.#currentOffset === this.#current.length) this.#current = null;
    }
    return pieces.length === 0 ? null : Buffer.concat(pieces);
  }

  #pickFrame() {
    let frame;
    if (this.#queues.control.size > 0) {
      frame = this.#queues.control.shift();
      this.#queuedControl -= frame.length;
    } else if (this.#ending) {
      return false;
    } else if (this.#queues.ack.size > 0) {
      frame = this.#queues.ack.shift();
      this.#queuedNormal -= frame.length;
    } else if (this.#queues.data.size > 0) {
      frame = this.#queues.data.shift();
      this.#queuedNormal -= frame.length;
    } else {
      return false;
    }
    this.#current = frame;
    this.#currentOffset = 0;
    return true;
  }

  // ------------------------------------------------------------------ reading

  #onData(chunk) {
    if (this.#closeInfo !== null) return;
    this.#in.push(chunk);
    this.#process();
  }

  #canDeliver() {
    if (this.#confirm !== null) return true;
    return this.#started && !this.#readPaused;
  }

  #process() {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#closeInfo === null) {
        if (this.#inPackets.size > 0) {
          if (!this.#canDeliver()) break;
          this.#deliver(this.#inPackets.shift());
          continue;
        }
        if (!this.#canDeliver()) break;
        if (!this.#readRecord()) break;
      }
    } finally {
      this.#processing = false;
    }
    this.#updateFlow();
  }

  /** Decrypt one record into packets. @returns {boolean} false if none was complete */
  #readRecord() {
    if (this.#in.length < RECORD_PREFIX) return false;
    const length = this.#in.peekU16();
    if (length <= AEAD_TAG) {
      this.#fail('protocol', true);
      return false;
    }
    if (this.#in.length < RECORD_PREFIX + length) return false;
    this.#in.take(RECORD_PREFIX);
    const ciphertext = this.#in.take(length);
    this.#stats.bytesIn += RECORD_PREFIX + length;
    let plaintext;
    try {
      plaintext = this.#rx.decryptWithAd(EMPTY, ciphertext);
    } catch {
      // A forged, replayed, dropped or reordered record: the stream cannot be trusted.
      this.#fail('auth', false);
      return false;
    }
    const index = this.#stats.recordsIn;
    this.#stats.recordsIn += 1;
    this.#lastRecordAt = performance.now();
    if ((index + 1) % this.#rekeyInterval === 0) {
      this.#rx.rekey();
      this.#stats.rekeysIn += 1;
    }
    let frames;
    try {
      frames = this.#decoder.push(plaintext);
      for (const frame of frames) this.#inPackets.push({ packet: decodePacket(frame), size: frame.length });
    } catch (err) {
      if (!(err instanceof WireError)) throw err;
      this.#fail('protocol', true);
      return false;
    }
    return true;
  }

  #deliver({ packet, size }) {
    this.#stats.packetsIn += 1;
    if (this.#confirm !== null) {
      this.#handleConfirmation(packet);
      return;
    }
    if (packet.type === PacketType.BYE) {
      if (!validateByeHeader(packet.header).ok || packet.body.length !== 0) {
        this.#fail('protocol', true);
        return;
      }
      const reason = KNOWN_BYE.has(packet.header.reason) ? packet.header.reason : 'unknown';
      this.#emitClose({ reason, remote: true });
      this.#ending = true;
      this.#queues.ack.clear();
      this.#queues.data.clear();
      this.#queuedNormal = 0;
      this.#flush();
      this.#closing ??= Promise.resolve();
      // The peer said goodbye and ended its side, but it may never close the socket: give
      // it the usual linger and then destroy ours, as a local close does.
      void this.#awaitStreamClose(DEFAULT_LINGER_MS);
      return;
    }
    try {
      this.onPacket(packet, size);
    } catch (error) {
      this.#emitClose({ reason: 'protocol', remote: false, error });
      this.#shutdown({ reason: 'protocol', remote: false }, 'protocol');
    }
  }

  #handleConfirmation(packet) {
    const { resolve, reject } = this.#confirm;
    if (packet.type === PacketType.PING && validatePingHeader(packet.header).ok && packet.body.length === 0) {
      this.#confirm = null;
      resolve();
      return;
    }
    if (packet.type === PacketType.BYE && validateByeHeader(packet.header).ok) {
      this.#confirm = null;
      const reason = KNOWN_BYE.has(packet.header.reason) ? packet.header.reason : 'refused';
      const err = new HandshakeError(reason, 'refused by the peer');
      err.peer = this.remoteId;
      this.#emitClose({ reason, remote: true });
      this.#stream.destroy();
      this.#closing ??= Promise.resolve();
      reject(err);
      return;
    }
    this.#confirm = null;
    reject(new HandshakeError('protocol', 'admission confirmation was not PING or BYE'));
    this.#fail('protocol', true);
  }

  /** Keep the stream flowing only while there is somewhere for its bytes to go. */
  #updateFlow() {
    const stream = this.#stream;
    if (this.#closeInfo !== null || stream.destroyed) return;
    if (this.#canDeliver()) {
      if (stream.isPaused()) stream.resume();
    } else if (!stream.isPaused()) {
      stream.pause();
    }
  }
}

function randomNonce() {
  return randomBytes(PING_NONCE_BYTES).toString('hex');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function positiveInteger(value, name, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new ConfigError(`${name} must be a positive integer`);
  return result;
}

function checkOptions(options) {
  const {
    stream, initiator, identity, networkId, networkKey = null, buildLocal, authorize,
    now = Date.now, handshakeTimeoutMs, maxClockSkewMs, maxQueueBytes, maxControlBytes,
    rekeyInterval,
  } = options ?? {};
  if (stream === null || typeof stream !== 'object' || typeof stream.write !== 'function') {
    throw new ConfigError('stream must be a connected Duplex');
  }
  if (typeof initiator !== 'boolean') throw new ConfigError('initiator must be a boolean');
  if (!(identity instanceof Identity)) throw new ConfigError('identity must be an Identity');
  if (!isNetworkId(networkId)) throw new ConfigError('networkId is not a valid network id');
  if (networkKey !== null) {
    try {
      assertBytes(networkKey, 'network key', 32);
    } catch (cause) {
      throw new ConfigError('networkKey must be 32 bytes or null', { cause });
    }
  }
  if (typeof buildLocal !== 'function') throw new ConfigError('buildLocal must be a function');
  if (typeof authorize !== 'function') throw new ConfigError('authorize must be a function');
  if (typeof now !== 'function') throw new ConfigError('now must be a function');
  const skew = maxClockSkewMs;
  if (!Number.isSafeInteger(skew) || skew < 0) throw new ConfigError('maxClockSkewMs must be a non-negative integer');
  return {
    stream,
    initiator,
    identity,
    networkId,
    networkKey: networkKey === null ? null : Buffer.from(networkKey),
    buildLocal,
    authorize,
    now,
    handshakeTimeoutMs: positiveInteger(handshakeTimeoutMs, 'handshakeTimeoutMs'),
    maxClockSkewMs: skew,
    maxQueueBytes: positiveInteger(maxQueueBytes, 'maxQueueBytes', DEFAULT_MAX_QUEUE_BYTES),
    maxControlBytes: positiveInteger(maxControlBytes, 'maxControlBytes', DEFAULT_MAX_CONTROL_BYTES),
    rekeyInterval: positiveInteger(rekeyInterval, 'rekeyInterval', Limits.REKEY_INTERVAL),
  };
}
