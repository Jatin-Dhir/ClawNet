/**
 * Packet and frame codec (DESIGN.md section 5).
 *
 *   packet = u8 type | u8 flags (0) | u16be headerLen | header (canonical JSON) | body
 *   frame  = u32be length | packet
 *
 * A link carries frames inside its decrypted Noise byte stream; each frame holds exactly
 * one packet. Everything here is pure: no sockets, no timers. The decoders treat their
 * input as hostile and fail closed with a WireError; the transport closes the link when
 * one is thrown.
 *
 * The header is parsed with the strict canonical parser so that a packet has exactly one
 * encoding. That is what lets forwarders deduplicate and lets tests compare bytes.
 *
 * Two size bounds apply (DESIGN.md section 15 item 7). Limits.MAX_PACKET is the hard bound
 * on anything received, enforced by decodePacket and FrameDecoder. Senders are stricter:
 * assertSendable keeps link-local packets within Limits.MAX_SYNC_PACKET and routed ones
 * within Limits.MAX_ROUTED_PACKET, so that no packet holds a slow link for long.
 */

import { WireError } from '../errors.js';
import { canonicalBytes, parseCanonical } from './canonical.js';
import { isRoutedType, Limits, PACKET_TYPE_NAMES } from './types.js';

/** Bytes before the header: type, flags, header length. */
export const PACKET_PREFIX_BYTES = 4;

/**
 * The two classes of packet, which have different send limits (DESIGN.md section 15
 * item 7).
 */
export const PacketKind = Object.freeze({
  /** PING, PONG, BYE, GOSSIP and SYNC_*: never forwarded; at most Limits.MAX_SYNC_PACKET. */
  LINK: 'link',
  /** DATA and PROBE: forwarded hop by hop; at most Limits.MAX_ROUTED_PACKET. */
  ROUTED: 'routed',
});

/** Bytes of the frame length prefix. */
export const FRAME_PREFIX_BYTES = 4;

/** Largest frame length a u32 prefix can declare. */
const MAX_U32 = 0xffffffff;

/**
 * @typedef {object} Packet
 * @property {number} type    one of PacketType
 * @property {number} flags   always 0 in protocol version 1
 * @property {Record<string, unknown>} header parsed canonical JSON object
 * @property {Buffer} body    bytes after the header; a view into the input, not a copy
 */

/**
 * Encode one packet.
 *
 * @param {object} packet
 * @param {number} packet.type      one of PacketType
 * @param {Record<string, unknown>} packet.header  plain object, canonical-JSON encodable
 * @param {Uint8Array} [packet.body]  opaque body bytes; omitted means empty
 * @returns {Buffer} a freshly allocated buffer holding the whole packet
 * @throws {WireError} for an unknown type, a header that is not a plain object or cannot
 *   be written as canonical JSON, a header over Limits.MAX_HEADER bytes, a body that is
 *   not bytes, or a packet over Limits.MAX_PACKET bytes
 */
export function encodePacket(packet) {
  if (!isPlainObject(packet)) {
    throw new WireError('packet must be an object with type, header and optional body');
  }
  const { type, header, body } = packet;
  if (!isKnownType(type)) {
    throw new WireError(`unknown packet type ${describeType(type)}`);
  }
  if (!isPlainObject(header)) {
    throw new WireError('packet header must be a plain object');
  }
  if (body !== undefined && !(body instanceof Uint8Array)) {
    throw new WireError('packet body must be a Buffer or Uint8Array');
  }

  let headerBytes;
  try {
    headerBytes = canonicalBytes(header);
  } catch (cause) {
    throw new WireError('packet header cannot be encoded as canonical JSON', { cause });
  }
  if (headerBytes.length > Limits.MAX_HEADER) {
    throw new WireError(
      `packet header is ${headerBytes.length} bytes, limit is ${Limits.MAX_HEADER}`,
    );
  }

  const bodyLength = body === undefined ? 0 : body.length;
  const total = PACKET_PREFIX_BYTES + headerBytes.length + bodyLength;
  if (total > Limits.MAX_PACKET) {
    throw new WireError(`packet is ${total} bytes, limit is ${Limits.MAX_PACKET}`);
  }

  const out = Buffer.allocUnsafe(total);
  out[0] = type;
  out[1] = 0;
  out.writeUInt16BE(headerBytes.length, 2);
  out.set(headerBytes, PACKET_PREFIX_BYTES);
  if (bodyLength > 0) out.set(body, PACKET_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * Decode one packet received from a peer.
 *
 * The returned body is a view into `buf`: no bytes are copied, so the caller must not
 * reuse `buf` while it still needs the body.
 *
 * @param {Uint8Array} buf exactly one packet (one frame payload)
 * @returns {Packet}
 * @throws {WireError} for input that is not bytes, a packet over Limits.MAX_PACKET bytes,
 *   truncated input, an unknown type, non-zero flags, a header over Limits.MAX_HEADER
 *   bytes, or a header that is not strictly canonical JSON for a plain object
 */
export function decodePacket(buf) {
  if (!(buf instanceof Uint8Array)) {
    throw new WireError('packet must be a Buffer or Uint8Array');
  }
  if (buf.length > Limits.MAX_PACKET) {
    throw new WireError(`packet is ${buf.length} bytes, limit is ${Limits.MAX_PACKET}`);
  }
  if (buf.length < PACKET_PREFIX_BYTES) {
    throw new WireError(`truncated packet: ${buf.length} bytes is shorter than the fixed prefix`);
  }
  // A view over the same memory, so that the body below is a Buffer without copying.
  const bytes = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);

  const type = bytes[0];
  if (!isKnownType(type)) {
    throw new WireError(`unknown packet type ${type}`);
  }
  const flags = bytes[1];
  if (flags !== 0) {
    throw new WireError(`unsupported packet flags 0x${flags.toString(16).padStart(2, '0')}`);
  }
  const headerLength = bytes.readUInt16BE(2);
  if (headerLength > Limits.MAX_HEADER) {
    throw new WireError(`packet header is ${headerLength} bytes, limit is ${Limits.MAX_HEADER}`);
  }
  const bodyStart = PACKET_PREFIX_BYTES + headerLength;
  if (bodyStart > bytes.length) {
    throw new WireError('truncated packet: header runs past the end of the packet');
  }

  let header;
  try {
    header = parseCanonical(bytes.subarray(PACKET_PREFIX_BYTES, bodyStart));
  } catch (cause) {
    throw new WireError('packet header is not canonical JSON', { cause });
  }
  if (!isPlainObject(header)) {
    throw new WireError('packet header must be a JSON object');
  }

  return { type, flags, header, body: bytes.subarray(bodyStart) };
}

/**
 * The class of a packet type.
 *
 * @param {number} type one of PacketType
 * @returns {"link" | "routed"} a PacketKind value
 * @throws {WireError} for an unknown type
 */
export function packetKind(type) {
  if (!isKnownType(type)) throw new WireError(`unknown packet type ${describeType(type)}`);
  return isRoutedType(type) ? PacketKind.ROUTED : PacketKind.LINK;
}

/**
 * The largest packet, in bytes, that a node may send or forward with this type.
 *
 * Link-local packets are kept within Limits.MAX_SYNC_PACKET and routed packets within
 * Limits.MAX_ROUTED_PACKET, so no single packet holds a slow link for long. These are
 * sending limits; a received packet is bounded only by Limits.MAX_PACKET (decodePacket).
 *
 * @param {number} type one of PacketType
 * @returns {number}
 * @throws {WireError} for an unknown type
 */
export function sendLimit(type) {
  return packetKind(type) === PacketKind.ROUTED ? Limits.MAX_ROUTED_PACKET : Limits.MAX_SYNC_PACKET;
}

/**
 * Check, on the sending side, that an encoded packet may be put on a link.
 *
 * Reads only the fixed prefix: the type byte chooses the limit, the flags must be zero,
 * and the declared header must fit inside the packet. Callers encode with encodePacket
 * and call this before queueing; a forwarder calls it before relaying a packet it
 * received, which may be larger than it is allowed to send.
 *
 * @param {Uint8Array} packet an encoded packet
 * @param {"link" | "routed"} [kind] the class the caller means to send; when given, a
 *   packet of the other class is refused, so a routed packet cannot be sent through a
 *   path that only expects link-local ones and the reverse
 * @returns {number} the packet's length in bytes
 * @throws {WireError} if the packet is not bytes, is shorter than its prefix, has an
 *   unknown type, non-zero flags or a header running past its end, is of the other
 *   kind, or exceeds the send limit of its type
 */
export function assertSendable(packet, kind) {
  if (kind !== undefined && kind !== PacketKind.LINK && kind !== PacketKind.ROUTED) {
    throw new WireError('packet kind must be "link" or "routed"');
  }
  if (!(packet instanceof Uint8Array)) {
    throw new WireError('packet must be a Buffer or Uint8Array');
  }
  if (packet.length < PACKET_PREFIX_BYTES) {
    throw new WireError(`truncated packet: ${packet.length} bytes is shorter than the fixed prefix`);
  }
  const type = packet[0];
  const actual = packetKind(type);
  if (kind !== undefined && actual !== kind) {
    throw new WireError(`packet type ${type} is ${actual}, not ${kind}`);
  }
  if (packet[1] !== 0) {
    throw new WireError('unsupported packet flags');
  }
  const headerLength = (packet[2] << 8) | packet[3];
  if (headerLength > Limits.MAX_HEADER) {
    throw new WireError(`packet header is ${headerLength} bytes, limit is ${Limits.MAX_HEADER}`);
  }
  if (PACKET_PREFIX_BYTES + headerLength > packet.length) {
    throw new WireError('truncated packet: header runs past the end of the packet');
  }
  const limit = sendLimit(type);
  if (packet.length > limit) {
    throw new WireError(`${actual} packet is ${packet.length} bytes, send limit is ${limit}`);
  }
  return packet.length;
}

/**
 * Prefix a payload with its length so it can be written to a byte stream.
 *
 * @param {Uint8Array} payload one packet, 1..maxFrame bytes
 * @param {object} [options]
 * @param {number} [options.maxFrame] largest payload in bytes; default Limits.MAX_PACKET
 * @returns {Buffer} `u32be length || payload` in a freshly allocated buffer
 * @throws {WireError} if the payload is not bytes, is empty, or exceeds maxFrame
 */
export function encodeFrame(payload, { maxFrame = Limits.MAX_PACKET } = {}) {
  assertMaxFrame(maxFrame);
  if (!(payload instanceof Uint8Array)) {
    throw new WireError('frame payload must be a Buffer or Uint8Array');
  }
  if (payload.length === 0) {
    throw new WireError('frame payload must not be empty');
  }
  if (payload.length > maxFrame) {
    throw new WireError(`frame payload is ${payload.length} bytes, limit is ${maxFrame}`);
  }
  const out = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.set(payload, FRAME_PREFIX_BYTES);
  return out;
}

/**
 * Incremental decoder for a stream of `u32be length || payload` frames.
 *
 * Chunk boundaries are arbitrary: a chunk may hold a fraction of a length prefix or many
 * whole frames. A frame's storage is allocated once, when its length prefix is complete,
 * and incoming bytes are copied straight into it, so the cost is linear in the bytes
 * received however they are sliced, and the decoder never holds more than one frame.
 *
 * A declared length of zero or above `maxFrame` is rejected as soon as the prefix is
 * complete, before any body byte is stored. After any error the decoder stays failed and
 * every later push throws: the stream position is lost, so the link must be closed.
 */
export class FrameDecoder {
  #maxFrame;
  /** Length prefix of the frame in progress; only the first #prefixFill bytes are valid. */
  #prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
  #prefixFill = 0;
  /** Storage of the frame in progress, or null while its length prefix is incomplete. */
  #frame = null;
  #frameFill = 0;
  #failure = null;

  /**
   * @param {object} [options]
   * @param {number} [options.maxFrame] largest accepted frame payload in bytes;
   *   default Limits.MAX_PACKET
   * @throws {WireError} if maxFrame is not an integer in 1..4294967295
   */
  constructor({ maxFrame = Limits.MAX_PACKET } = {}) {
    assertMaxFrame(maxFrame);
    this.#maxFrame = maxFrame;
  }

  /**
   * Bytes received that are not yet part of a returned frame: the partial length prefix
   * plus the partial payload. At most `4 + maxFrame - 1`.
   *
   * @returns {number}
   */
  get buffered() {
    return this.#prefixFill + this.#frameFill;
  }

  /**
   * Feed the next bytes of the stream.
   *
   * Each returned frame is a Buffer the caller owns; it never aliases `chunk`, so the
   * caller may reuse the chunk's memory immediately. If the chunk contains an invalid
   * length prefix, frames completed earlier in the same chunk are discarded with it.
   *
   * @param {Uint8Array} chunk any number of bytes, including none
   * @returns {Buffer[]} the frames completed by this chunk, in stream order
   * @throws {WireError} if the chunk is not bytes, a frame declares a length of zero or
   *   more than maxFrame, or the decoder has already failed
   */
  push(chunk) {
    if (this.#failure !== null) throw this.#failure;
    if (!(chunk instanceof Uint8Array)) {
      throw this.#fail('frame decoder input must be a Buffer or Uint8Array');
    }

    const frames = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#frame === null) {
        const take = Math.min(FRAME_PREFIX_BYTES - this.#prefixFill, chunk.length - offset);
        this.#prefix.set(chunk.subarray(offset, offset + take), this.#prefixFill);
        this.#prefixFill += take;
        offset += take;
        if (this.#prefixFill < FRAME_PREFIX_BYTES) break;

        const length = this.#prefix.readUInt32BE(0);
        if (length === 0) {
          throw this.#fail('frame declares a length of zero');
        }
        if (length > this.#maxFrame) {
          throw this.#fail(`frame declares ${length} bytes, limit is ${this.#maxFrame}`);
        }
        // Uninitialized memory is safe here: the buffer is only handed out once every
        // byte of it has been overwritten with received data.
        this.#frame = Buffer.allocUnsafe(length);
        this.#frameFill = 0;
        continue;
      }

      const take = Math.min(this.#frame.length - this.#frameFill, chunk.length - offset);
      this.#frame.set(chunk.subarray(offset, offset + take), this.#frameFill);
      this.#frameFill += take;
      offset += take;
      if (this.#frameFill === this.#frame.length) {
        frames.push(this.#frame);
        this.#frame = null;
        this.#frameFill = 0;
        this.#prefixFill = 0;
      }
    }
    return frames;
  }

  /** Record a failure, release the partial frame, and return the error to throw. */
  #fail(message) {
    this.#failure = new WireError(message);
    this.#frame = null;
    this.#frameFill = 0;
    this.#prefixFill = 0;
    return this.#failure;
  }
}

function assertMaxFrame(maxFrame) {
  if (!Number.isInteger(maxFrame) || maxFrame < 1 || maxFrame > MAX_U32) {
    throw new WireError(`maxFrame must be an integer between 1 and ${MAX_U32}`);
  }
}

function isKnownType(type) {
  return (
    Number.isInteger(type) && type >= 0 && type <= 0xff && Object.hasOwn(PACKET_TYPE_NAMES, type)
  );
}

/** Describe a caller-supplied type for an error message without echoing arbitrary data. */
function describeType(type) {
  return Number.isInteger(type) ? String(type) : `of type ${typeof type}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
