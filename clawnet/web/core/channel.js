/**
 * The phone's link to a node: the initiator side of the engine's link protocol
 * (`src/core/transport/secure-channel.js`), carried over a WebSocket instead of TCP.
 *
 * The WebSocket carries the same byte stream a TCP link does (PROTOCOL.md section 3.7):
 *
 *   -> u16be len || Noise message 1 (-> e; with a network key psk first: XXpsk0)
 *   <- u16be len || Noise message 2 (the node's handshake payload)
 *   -> u16be len || Noise message 3 (our handshake payload)
 *   then records u16be len || ChaCha20-Poly1305(frames), each frame u32be len || packet
 *
 * The checks on the node's payload are the engine's, in its order: canonical JSON object,
 * `v` is 1, schema, network id, the Noise static key equals the card's link key, the card
 * verifies, the clock is within the allowed skew. The node's first frame is the admission
 * verdict: a PING admits us, a BYE refuses us with a reason.
 *
 * Once linked: PINGs are answered with PONGs echoing the nonce; we send our own PING every
 * keepalive interval, measure the round trip like the engine's LinkMetric, and close the
 * link when nothing authenticated arrived for the peer timeout. Each direction rekeys after
 * every `rekeyInterval` records. A record that fails authentication closes the link.
 *
 * The phone never listens: it only dials (`openLink`).
 */

import { HandshakeError, ProtocolError, WireError, CanonicalError } from '../../src/core/errors.js';
import { Domain, Limits, PacketType } from '../../src/core/wire/types.js';
import { concat, readU16, toHex, u16, utf8 } from './bytes.js';
import { assertSendable, canonicalBytes, decodePacket, encodeFrame, encodePacket, FrameDecoder, parseCanonical } from './codec.js';
import { Identity, verifyCard } from './identity.js';
import { HandshakeState } from './noise.js';
import { base64Decode, randomBytes, timingSafeEqual } from './primitives.js';
import { HANDSHAKE_VERSION, validateByeHeader, validateHandshakePayload, validatePingHeader } from './schema.js';

/** The WebSocket subprotocol the engine requires (transport/websocket.js). */
export const WEBSOCKET_SUBPROTOCOL = 'clawnet.1';

/** Largest plaintext of one transport record. */
export const RECORD_PLAINTEXT_MAX = 65519;

/** Reasons a node may give in a BYE (the engine's list); others read as "unknown". */
export const BYE_REASONS = Object.freeze(['shutdown', 'manual', 'duplicate', 'replaced', 'full', 'blocked', 'not-allowed', 'self', 'timeout', 'protocol']);

/** Bytes the browser may hold unsent before every packet but a BYE is refused. */
const MAX_BUFFERED = 4 * 1024 * 1024;
const AEAD_TAG = 16;
const EMPTY = new Uint8Array(0);
const SEPARATOR = Uint8Array.of(0);
const KNOWN_BYE = new Set(BYE_REASONS);
const MAX_COST = 65535;

/**
 * Dial a node's WebSocket port and run the link handshake.
 *
 * @param {object} options
 * @param {string} options.url ws://host:port/
 * @param {Identity} options.identity this phone
 * @param {string} options.networkId
 * @param {Uint8Array | null} [options.networkKey] 32 bytes: Noise XXpsk0; null: Noise XX
 * @param {string} [options.agent]
 * @param {{ relay: boolean, mailbox: boolean, transit: boolean }} [options.caps]
 * @param {typeof WebSocket} [options.WebSocket] the WebSocket class; default globalThis.WebSocket
 * @param {() => number} [options.now] wall clock
 * @param {() => number} [options.monoNow] monotonic clock
 * @param {number} [options.handshakeTimeoutMs]
 * @param {number} [options.maxClockSkewMs]
 * @param {number} [options.keepaliveMs]
 * @param {number} [options.peerTimeoutMs]
 * @param {number} [options.rekeyInterval]
 * @returns {Promise<Link>} a link not yet started: set its callbacks, then call start()
 * @throws {HandshakeError} with the engine's reasons: connect-failed, handshake-timeout,
 *   closed, noise, bad-payload, version, network-mismatch, key-mismatch, bad-card,
 *   clock-skew, self, protocol, or the BYE reason the node refused us with
 */
export async function openLink({
  url,
  identity,
  networkId,
  networkKey = null,
  agent = 'clawnet-web/0.1.0',
  caps = { relay: false, mailbox: false, transit: false },
  WebSocket: WebSocketClass = globalThis.WebSocket,
  now = Date.now,
  monoNow = () => performance.now(),
  handshakeTimeoutMs = 10_000,
  maxClockSkewMs = 300_000,
  keepaliveMs = 10_000,
  peerTimeoutMs = 30_000,
  rekeyInterval = Limits.REKEY_INTERVAL,
} = {}) {
  if (!(identity instanceof Identity)) throw new TypeError('identity must be an Identity');
  if (typeof WebSocketClass !== 'function') throw new HandshakeError('connect-failed', 'this browser has no WebSocket');
  let ws;
  try {
    ws = new WebSocketClass(url, [WEBSOCKET_SUBPROTOCOL]);
  } catch (cause) {
    throw new HandshakeError('connect-failed', 'the address cannot be opened', { cause });
  }
  ws.binaryType = 'arraybuffer';
  const reader = new StreamReader(ws);
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HandshakeError('handshake-timeout', `the link was not up in ${handshakeTimeoutMs} ms`)), handshakeTimeoutMs);
  });
  deadline.catch(() => {});
  try {
    const link = await Promise.race([
      handshake({ ws, reader, identity, networkId, networkKey, agent, caps, now, monoNow, maxClockSkewMs, keepaliveMs, peerTimeoutMs, rekeyInterval }),
      deadline,
    ]);
    return link;
  } catch (err) {
    reader.detach();
    try {
      ws.close(1000);
    } catch {
      // Already closing.
    }
    throw err instanceof HandshakeError ? err : new HandshakeError('noise', 'link handshake failed', { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function handshake(opts) {
  const { ws, reader, identity, networkId, networkKey, agent, caps, now, monoNow, maxClockSkewMs } = opts;
  await reader.opened();
  if (ws.protocol !== WEBSOCKET_SUBPROTOCOL) throw new HandshakeError('protocol', 'the server did not agree to the ClawNet subprotocol');
  const startedAt = monoNow();
  const prologue = concat(utf8(Domain.LINK), SEPARATOR, utf8(networkId));
  const s = identity.linkKeyPair;
  let noise;
  try {
    noise = new HandshakeState({ pattern: networkKey === null ? 'XX' : 'XXpsk0', initiator: true, prologue, s, psk: networkKey ?? undefined });
  } finally {
    s.privateKey.fill(0);
  }
  sendRaw(ws, withLength(noise.writeMessage(EMPTY)));
  const sentAt = monoNow();
  const second = await reader.nextMessage();
  const rtt = monoNow() - sentAt;
  let payloadBytes;
  try {
    payloadBytes = noise.readMessage(second);
  } catch (cause) {
    throw new HandshakeError('noise', 'handshake message rejected', { cause });
  }
  const peer = verifyPeer(payloadBytes, noise.remoteStaticKey, { networkId, now, maxClockSkewMs });
  if (peer.id === identity.nodeId) throw new HandshakeError('self', 'that address is this node');
  const local = {
    v: HANDSHAKE_VERSION,
    card: identity.card,
    net: networkId,
    agent,
    caps,
    listen: [],
    // A browser does not see the socket's remote address.
    observed: null,
    ts: now(),
  };
  const verdict = validateHandshakePayload(local);
  if (!verdict.ok) throw new TypeError(`own handshake payload is invalid: ${verdict.reason}`);
  sendRaw(ws, withLength(noise.writeMessage(canonicalBytes(local))));
  const { tx, rx } = noise.split();
  const link = new Link({ ...opts, tx, rx, peer, handshakeHash: noise.handshakeHash, startedAt, firstRtt: rtt, leftover: reader.detach() });
  await link.confirmed;
  return link;
}

function verifyPeer(bytes, remoteStatic, { networkId, now, maxClockSkewMs }) {
  let payload;
  try {
    payload = parseCanonical(bytes);
  } catch (cause) {
    throw new HandshakeError('bad-payload', 'handshake payload is not canonical JSON', { cause });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new HandshakeError('bad-payload', 'handshake payload is not an object');
  if (payload.v !== HANDSHAKE_VERSION) throw new HandshakeError('version', 'unsupported handshake version');
  const verdict = validateHandshakePayload(payload);
  if (!verdict.ok) throw new HandshakeError('bad-payload', `handshake payload rejected: ${verdict.reason}`);
  if (payload.net !== networkId) throw new HandshakeError('network-mismatch', 'the node is on another network');
  const link = base64Decode(payload.card.link, 32);
  if (remoteStatic === null || !timingSafeEqual(link, remoteStatic)) throw new HandshakeError('key-mismatch', 'Noise static key is not the link key of the card');
  const card = verifyCard(payload.card);
  if (!card.ok) throw new HandshakeError('bad-card', `identity card rejected: ${card.reason}`);
  if (Math.abs(payload.ts - now()) > maxClockSkewMs) throw new HandshakeError('clock-skew', 'the node\'s clock differs from this phone\'s by more than five minutes');
  return { id: card.nodeId, payload: Object.freeze(payload) };
}

function withLength(message) {
  return concat(u16(message.length), message);
}

function sendRaw(ws, bytes) {
  ws.send(bytes);
}

/** Collects the WebSocket's binary messages into a byte queue; reads length-prefixed handshake messages. */
class StreamReader {
  #ws;
  #chunks = [];
  #length = 0;
  #waiter = null;
  #failure = null;
  #openWaiter = null;
  #opened = false;
  #handlers;

  constructor(ws) {
    this.#ws = ws;
    this.#handlers = {
      open: () => {
        this.#opened = true;
        this.#openWaiter?.resolve();
      },
      message: (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          this.#fail(new HandshakeError('protocol', 'the node sent a text message'));
          return;
        }
        this.push(new Uint8Array(event.data));
      },
      close: () => this.#fail(new HandshakeError(this.#opened ? 'closed' : 'connect-failed', this.#opened ? 'the connection closed during the handshake' : 'cannot connect to the node')),
      error: () => this.#fail(new HandshakeError(this.#opened ? 'closed' : 'connect-failed', this.#opened ? 'the connection failed during the handshake' : 'cannot connect to the node')),
    };
    for (const [name, handler] of Object.entries(this.#handlers)) ws.addEventListener(name, handler);
  }

  opened() {
    if (this.#opened) return Promise.resolve();
    if (this.#failure !== null) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#openWaiter = { resolve, reject };
    });
  }

  push(bytes) {
    if (bytes.length === 0) return;
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    this.#wake();
  }

  nextMessage() {
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
      this.#wake();
    });
  }

  /** Stop listening; returns the bytes received after the last message. */
  detach() {
    for (const [name, handler] of Object.entries(this.#handlers)) this.#ws.removeEventListener(name, handler);
    const rest = this.#take(this.#length);
    return rest;
  }

  #fail(err) {
    this.#failure ??= err;
    this.#openWaiter?.reject(err);
    this.#openWaiter = null;
    this.#wake();
  }

  #wake() {
    if (this.#waiter === null) return;
    const waiter = this.#waiter;
    if (this.#length >= 2) {
      const head = this.#peek(2);
      const length = readU16(head, 0);
      if (this.#length >= 2 + length) {
        this.#waiter = null;
        this.#take(2);
        waiter.resolve(this.#take(length));
        return;
      }
    }
    if (this.#failure !== null) {
      this.#waiter = null;
      waiter.reject(this.#failure);
    }
  }

  #peek(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (filled === n) break;
    }
    return out;
  }

  #take(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0];
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    this.#length -= n;
    return out;
  }
}

/**
 * An established link. Set `onPacket` and `onClose`, then call `start()`.
 */
export class Link {
  /** @type {string} the node's NodeId, authenticated */
  remoteId;
  /** @type {object} its verified identity card */
  remoteCard;
  /** @type {object} its handshake payload */
  remotePayload;
  /** @type {Uint8Array} */
  handshakeHash;
  /** @type {(packet: object) => void} every packet but PING, PONG and BYE */
  onPacket = () => {};
  /** @type {(info: { reason: string, remote: boolean }) => void} */
  onClose = () => {};
  /** @type {() => void} the round-trip estimate changed */
  onMetric = () => {};
  /** @type {Promise<void>} resolves when the node admitted us */
  confirmed;

  #ws;
  #tx;
  #rx;
  #rekeyInterval;
  #keepaliveMs;
  #peerTimeoutMs;
  #monoNow;
  #in = [];
  #inLength = 0;
  #decoder = new FrameDecoder();
  #recordsIn = 0;
  #recordsOut = 0;
  #closed = false;
  #started = false;
  #held = [];
  #confirm = null;
  #lastRecordAt;
  #ping = null;
  #srtt = null;
  #misses = 0;
  #timer = null;
  #handlers;
  stats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, rekeysIn: 0, rekeysOut: 0 };

  constructor({ ws, tx, rx, peer, handshakeHash, rekeyInterval, keepaliveMs, peerTimeoutMs, monoNow, firstRtt, leftover }) {
    this.#ws = ws;
    this.#tx = tx;
    this.#rx = rx;
    this.#rekeyInterval = rekeyInterval;
    this.#keepaliveMs = keepaliveMs;
    this.#peerTimeoutMs = peerTimeoutMs;
    this.#monoNow = monoNow;
    this.remoteId = peer.id;
    this.remoteCard = peer.payload.card;
    this.remotePayload = peer.payload;
    this.handshakeHash = handshakeHash;
    this.#lastRecordAt = monoNow();
    if (Number.isFinite(firstRtt) && firstRtt >= 0) this.#srtt = Math.min(firstRtt, MAX_COST);
    this.confirmed = new Promise((resolve, reject) => {
      this.#confirm = { resolve, reject };
    });
    this.#handlers = {
      message: (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          this.#fail('protocol');
          return;
        }
        this.#onBytes(new Uint8Array(event.data));
      },
      close: () => this.#gone('eof'),
      error: () => this.#gone('socket'),
    };
    for (const [name, handler] of Object.entries(this.#handlers)) ws.addEventListener(name, handler);
    if (leftover.length > 0) this.#onBytes(leftover);
  }

  /** @returns {boolean} */
  get closed() {
    return this.#closed;
  }

  /** @returns {number} the link cost as the engine computes it: smoothed RTT in ms, penalised per missed keepalive */
  get cost() {
    if (this.#srtt === null) return MAX_COST;
    const base = Math.max(1, Math.ceil(this.#srtt));
    const cost = Math.ceil(base * 2 ** this.#misses);
    return cost < MAX_COST ? cost : MAX_COST;
  }

  /** @returns {number | null} */
  get rttMs() {
    return this.#srtt === null ? null : Math.round(this.#srtt);
  }

  /** Deliver packets and start the keepalive. */
  start() {
    if (this.#started) return;
    this.#started = true;
    for (const packet of this.#held.splice(0)) this.#deliver(packet);
    this.#armKeepalive(Math.floor(Math.random() * this.#keepaliveMs));
  }

  /**
   * Queue a packet on the link.
   *
   * @param {object | Uint8Array} packet
   * @returns {boolean} false if the link is closed, or (for routed packets) the browser's
   *   send buffer is full
   */
  send(packet) {
    if (this.#closed) return false;
    const encoded = packet instanceof Uint8Array ? packet : encodePacket(packet);
    assertSendable(encoded);
    // Once the computer stops reading, nothing but a BYE is queued: answering its PINGs
    // would otherwise grow the browser's buffer with every one it sends.
    if (encoded[0] !== PacketType.BYE && this.#ws.bufferedAmount > MAX_BUFFERED) return false;
    const frame = encodeFrame(encoded);
    for (let offset = 0; offset < frame.length; offset += RECORD_PLAINTEXT_MAX) {
      this.#writeRecord(frame.subarray(offset, offset + RECORD_PLAINTEXT_MAX));
    }
    this.stats.packetsOut += 1;
    return true;
  }

  /**
   * Close the link, with `BYE {reason}` first when a reason is given.
   *
   * @param {string} [reason]
   */
  close(reason) {
    if (this.#closed) return;
    if (reason !== undefined && validateByeHeader({ reason }).ok) {
      try {
        this.send({ type: PacketType.BYE, header: { reason } });
      } catch {
        // Closing regardless.
      }
    }
    this.#shutdown({ reason: reason ?? 'manual', remote: false });
  }

  #writeRecord(plaintext) {
    const ciphertext = this.#tx.encryptWithAd(EMPTY, plaintext);
    const index = this.#recordsOut;
    this.#recordsOut += 1;
    if ((index + 1) % this.#rekeyInterval === 0) {
      this.#tx.rekey();
      this.stats.rekeysOut += 1;
    }
    const record = concat(u16(ciphertext.length), ciphertext);
    this.stats.bytesOut += record.length;
    this.#ws.send(record);
  }

  #onBytes(bytes) {
    if (this.#closed) return;
    this.#in.push(bytes);
    this.#inLength += bytes.length;
    while (!this.#closed && this.#inLength >= 2) {
      const head = this.#peekIn(2);
      const length = readU16(head, 0);
      if (length <= AEAD_TAG) {
        this.#fail('protocol');
        return;
      }
      if (this.#inLength < 2 + length) return;
      this.#takeIn(2);
      const ciphertext = this.#takeIn(length);
      this.stats.bytesIn += 2 + length;
      let plaintext;
      try {
        plaintext = this.#rx.decryptWithAd(EMPTY, ciphertext);
      } catch {
        // A forged, replayed, dropped or reordered record: the stream cannot be trusted.
        this.#fail('auth', false);
        return;
      }
      const index = this.#recordsIn;
      this.#recordsIn += 1;
      this.#lastRecordAt = this.#monoNow();
      if ((index + 1) % this.#rekeyInterval === 0) {
        this.#rx.rekey();
        this.stats.rekeysIn += 1;
      }
      let frames;
      try {
        frames = this.#decoder.push(plaintext);
      } catch {
        this.#fail('protocol');
        return;
      }
      for (const frame of frames) {
        let packet;
        try {
          packet = decodePacket(frame);
        } catch {
          this.#fail('protocol');
          return;
        }
        if (this.#confirm !== null) this.#handleConfirmation(packet);
        else if (!this.#started) this.#held.push(packet);
        else this.#deliver(packet);
        if (this.#closed) return;
      }
    }
  }

  #handleConfirmation(packet) {
    const { resolve, reject } = this.#confirm;
    this.#confirm = null;
    if (packet.type === PacketType.PING && validatePingHeader(packet.header).ok && packet.body.length === 0) {
      resolve();
      return;
    }
    if (packet.type === PacketType.BYE && validateByeHeader(packet.header).ok) {
      const reason = KNOWN_BYE.has(packet.header.reason) ? packet.header.reason : 'refused';
      this.#shutdown({ reason, remote: true });
      reject(new HandshakeError(reason, 'the node refused this phone'));
      return;
    }
    this.#fail('protocol');
    reject(new HandshakeError('protocol', 'the admission confirmation was not PING or BYE'));
  }

  #deliver(packet) {
    this.stats.packetsIn += 1;
    switch (packet.type) {
      case PacketType.PING:
        if (!validatePingHeader(packet.header).ok || packet.body.length !== 0) {
          this.#fail('protocol');
          return;
        }
        this.send({ type: PacketType.PONG, header: { n: packet.header.n } });
        return;
      case PacketType.PONG:
        if (!validatePingHeader(packet.header).ok || packet.body.length !== 0) {
          this.#fail('protocol');
          return;
        }
        if (this.#ping !== null && this.#ping.nonce === packet.header.n) {
          const rtt = this.#monoNow() - this.#ping.sentAt;
          this.#ping = null;
          if (Number.isFinite(rtt) && rtt >= 0) {
            const sample = Math.min(rtt, MAX_COST);
            this.#srtt = this.#srtt === null ? sample : this.#srtt + 0.125 * (sample - this.#srtt);
            this.#misses = 0;
            this.#metric();
          }
        }
        return;
      case PacketType.BYE: {
        if (!validateByeHeader(packet.header).ok || packet.body.length !== 0) {
          this.#fail('protocol');
          return;
        }
        const reason = KNOWN_BYE.has(packet.header.reason) ? packet.header.reason : 'unknown';
        this.#shutdown({ reason, remote: true });
        return;
      }
      default:
        try {
          this.onPacket(packet);
        } catch (error) {
          if (error instanceof ProtocolError || error instanceof WireError || error instanceof CanonicalError) this.#fail('protocol');
        }
    }
  }

  #metric() {
    try {
      this.onMetric();
    } catch {
      // An observer failing must not break the link.
    }
  }

  #armKeepalive(ms) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#keepalive(), ms);
  }

  #keepalive() {
    if (this.#closed) return;
    const now = this.#monoNow();
    if (now - this.#lastRecordAt >= this.#peerTimeoutMs) {
      this.close('timeout');
      return;
    }
    if (this.#ping !== null) {
      this.#misses += 1;
      this.#ping = null;
      this.#metric();
    }
    const nonce = toHex(randomBytes(8));
    if (this.send({ type: PacketType.PING, header: { n: nonce } })) this.#ping = { nonce, sentAt: now };
    this.#armKeepalive(this.#keepaliveMs);
  }

  /** A protocol or authentication failure: BYE when the stream is still trusted, then close. */
  #fail(reason, sendBye = true) {
    if (this.#closed) return;
    if (this.#confirm !== null) {
      const { reject } = this.#confirm;
      this.#confirm = null;
      reject(new HandshakeError('protocol', 'the link failed before admission'));
    }
    if (sendBye) this.close('protocol');
    this.#shutdown({ reason, remote: false });
  }

  #gone(reason) {
    if (this.#closed) return;
    if (this.#confirm !== null) {
      const { reject } = this.#confirm;
      this.#confirm = null;
      reject(new HandshakeError('closed', 'the connection closed before admission'));
    }
    this.#shutdown({ reason, remote: true });
  }

  #shutdown(info) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const [name, handler] of Object.entries(this.#handlers)) this.#ws.removeEventListener(name, handler);
    try {
      this.#ws.close(1000);
    } catch {
      // Already closed.
    }
    try {
      this.onClose(info);
    } catch {
      // The owner's bookkeeping failing must not matter here.
    }
  }

  #peekIn(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    for (const chunk of this.#in) {
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (filled === n) break;
    }
    return out;
  }

  #takeIn(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#in[0];
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) this.#in.shift();
      else this.#in[0] = chunk.subarray(take);
    }
    this.#inLength -= n;
    return out;
  }
}
