/**
 * Packet and frame codec of the web core: a port of the engine's `src/core/wire/codec.js`.
 *
 *   packet = u8 type | u8 flags (0) | u16be headerLen | header (canonical JSON) | body
 *   frame  = u32be length | packet
 *
 * Canonical JSON itself is the engine's module, shared unchanged
 * (`src/core/wire/canonical.js`); only the conversion to bytes is local, because the
 * engine's uses Node's Buffer.
 */

import { WireError } from '../../src/core/errors.js';
import { canonicalize, parseCanonical } from '../../src/core/wire/canonical.js';
import { isRoutedType, Limits, PACKET_TYPE_NAMES } from '../../src/core/wire/types.js';
import { utf8 } from './bytes.js';

export { canonicalize, parseCanonical };

export const PACKET_PREFIX_BYTES = 4;
export const FRAME_PREFIX_BYTES = 4;
export const PacketKind = Object.freeze({ LINK: 'link', ROUTED: 'routed' });

/** @returns {Uint8Array} the canonical JSON of `value` as UTF-8, what gets signed */
export function canonicalBytes(value) {
  return utf8(canonicalize(value));
}

/**
 * @param {{ type: number, header: object, body?: Uint8Array }} packet
 * @returns {Uint8Array}
 */
export function encodePacket(packet) {
  if (!isPlainObject(packet)) throw new WireError('packet must be an object with type, header and optional body');
  const { type, header, body } = packet;
  if (!isKnownType(type)) throw new WireError('unknown packet type');
  if (!isPlainObject(header)) throw new WireError('packet header must be a plain object');
  if (body !== undefined && !(body instanceof Uint8Array)) throw new WireError('packet body must be a Uint8Array');
  let headerBytes;
  try {
    headerBytes = canonicalBytes(header);
  } catch (cause) {
    throw new WireError('packet header cannot be encoded as canonical JSON', { cause });
  }
  if (headerBytes.length > Limits.MAX_HEADER) throw new WireError('packet header is too large');
  const bodyLength = body === undefined ? 0 : body.length;
  const total = PACKET_PREFIX_BYTES + headerBytes.length + bodyLength;
  if (total > Limits.MAX_PACKET) throw new WireError('packet is too large');
  const out = new Uint8Array(total);
  out[0] = type;
  out[1] = 0;
  out[2] = headerBytes.length >>> 8;
  out[3] = headerBytes.length & 255;
  out.set(headerBytes, PACKET_PREFIX_BYTES);
  if (bodyLength > 0) out.set(body, PACKET_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * @param {Uint8Array} bytes exactly one packet
 * @returns {{ type: number, flags: number, header: object, body: Uint8Array }} `body` is a view
 */
export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new WireError('packet must be a Uint8Array');
  if (bytes.length > Limits.MAX_PACKET) throw new WireError('packet is too large');
  if (bytes.length < PACKET_PREFIX_BYTES) throw new WireError('truncated packet');
  const type = bytes[0];
  if (!isKnownType(type)) throw new WireError(`unknown packet type ${type}`);
  if (bytes[1] !== 0) throw new WireError('unsupported packet flags');
  const headerLength = (bytes[2] << 8) | bytes[3];
  if (headerLength > Limits.MAX_HEADER) throw new WireError('packet header is too large');
  const bodyStart = PACKET_PREFIX_BYTES + headerLength;
  if (bodyStart > bytes.length) throw new WireError('truncated packet: header runs past the end');
  let header;
  try {
    header = parseCanonical(bytes.subarray(PACKET_PREFIX_BYTES, bodyStart));
  } catch (cause) {
    throw new WireError('packet header is not canonical JSON', { cause });
  }
  if (!isPlainObject(header)) throw new WireError('packet header must be a JSON object');
  return { type, flags: 0, header, body: bytes.subarray(bodyStart) };
}

/** @returns {"link" | "routed"} */
export function packetKind(type) {
  if (!isKnownType(type)) throw new WireError('unknown packet type');
  return isRoutedType(type) ? PacketKind.ROUTED : PacketKind.LINK;
}

/** The engine's sending limits: 64 KiB for link-local packets, 128 KiB for routed ones. */
export function assertSendable(packet) {
  if (!(packet instanceof Uint8Array) || packet.length < PACKET_PREFIX_BYTES) throw new WireError('truncated packet');
  const limit = packetKind(packet[0]) === PacketKind.ROUTED ? Limits.MAX_ROUTED_PACKET : Limits.MAX_SYNC_PACKET;
  if (packet.length > limit) throw new WireError(`packet is ${packet.length} bytes, send limit is ${limit}`);
  return packet.length;
}

/** @returns {Uint8Array} `u32be length || payload` */
export function encodeFrame(payload) {
  if (!(payload instanceof Uint8Array) || payload.length === 0) throw new WireError('frame payload must be non-empty bytes');
  if (payload.length > Limits.MAX_PACKET) throw new WireError('frame payload is too large');
  const out = new Uint8Array(FRAME_PREFIX_BYTES + payload.length);
  const n = payload.length;
  out[0] = n >>> 24;
  out[1] = (n >>> 16) & 255;
  out[2] = (n >>> 8) & 255;
  out[3] = n & 255;
  out.set(payload, FRAME_PREFIX_BYTES);
  return out;
}

/**
 * Incremental decoder for `u32be length || payload` frames; chunk boundaries are arbitrary.
 * After an error it stays failed, like the engine's.
 */
export class FrameDecoder {
  #prefix = new Uint8Array(FRAME_PREFIX_BYTES);
  #prefixFill = 0;
  #frame = null;
  #frameFill = 0;
  #failure = null;

  /** @param {Uint8Array} chunk @returns {Uint8Array[]} completed frames */
  push(chunk) {
    if (this.#failure !== null) throw this.#failure;
    if (!(chunk instanceof Uint8Array)) throw this.#fail('frame decoder input must be bytes');
    const frames = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#frame === null) {
        const take = Math.min(FRAME_PREFIX_BYTES - this.#prefixFill, chunk.length - offset);
        this.#prefix.set(chunk.subarray(offset, offset + take), this.#prefixFill);
        this.#prefixFill += take;
        offset += take;
        if (this.#prefixFill < FRAME_PREFIX_BYTES) break;
        const p = this.#prefix;
        const length = ((p[0] << 24) >>> 0) + ((p[1] << 16) | (p[2] << 8) | p[3]);
        if (length === 0) throw this.#fail('frame declares a length of zero');
        if (length > Limits.MAX_PACKET) throw this.#fail('frame declares more than the packet limit');
        this.#frame = new Uint8Array(length);
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

  #fail(message) {
    this.#failure = new WireError(message);
    this.#frame = null;
    return this.#failure;
  }
}

function isKnownType(type) {
  return Number.isInteger(type) && type >= 0 && type <= 0xff && Object.hasOwn(PACKET_TYPE_NAMES, type);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
