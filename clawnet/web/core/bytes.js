/**
 * Byte helpers for the web core: what the engine gets from Node's Buffer, written for
 * plain Uint8Array so the same code runs in a browser.
 *
 * The encoders match the engine's exactly (`src/core/crypto/primitives.js`): base64 is
 * RFC 4648 with padding and base32 is the lowercase, unpadded RFC 4648 alphabet, and both
 * decoders are strict, so every byte string has exactly one accepted spelling. The tests
 * compare them with the engine's on random and malformed input.
 */

import { CryptoError } from '../../src/core/errors.js';

const EMPTY = new Uint8Array(0);
const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE64_VALUES = valueTable(BASE64);
const BASE32_VALUES = valueTable(BASE32);
const encoder = new TextEncoder();

function valueTable(alphabet) {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
}

/** Most bytes one randomBytes() call returns; a guard against a length from the wire. */
export const MAX_RANDOM_BYTES = 1 << 20;

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} [length]
 * @returns {Uint8Array} the same value
 * @throws {CryptoError} if it is not a Uint8Array of that length
 */
export function assertBytes(value, name, length) {
  if (!(value instanceof Uint8Array)) throw new CryptoError(`${name} must be a Uint8Array`);
  if (length !== undefined && value.length !== length) {
    throw new CryptoError(`${name} must be ${length} bytes, got ${value.length}`);
  }
  return value;
}

/**
 * Cryptographically secure random bytes from `crypto.getRandomValues`, which browsers
 * provide in every context, secure or not (WebCrypto's `subtle` is the part they withhold).
 *
 * @param {number} n 0 to MAX_RANDOM_BYTES
 * @returns {Uint8Array}
 */
export function randomBytes(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_RANDOM_BYTES) {
    throw new CryptoError(`random byte count must be an integer from 0 to ${MAX_RANDOM_BYTES}`);
  }
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== 'function') {
    throw new CryptoError('this runtime has no crypto.getRandomValues');
  }
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65536 bytes per call.
  for (let offset = 0; offset < n; offset += 65536) {
    source.getRandomValues(out.subarray(offset, Math.min(n, offset + 65536)));
  }
  return out;
}

/** @param {...Uint8Array} parts @returns {Uint8Array} a new array holding them in order */
export function concat(...parts) {
  let total = 0;
  for (const part of parts) total += assertBytes(part, 'part').length;
  if (total === 0) return new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Compare without an early exit on the first difference. Lengths are not secret.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function equalBytes(a, b) {
  assertBytes(a, 'first operand');
  assertBytes(b, 'second operand');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Unsigned lexicographic comparison, as Buffer.compare does. */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** @param {Uint8Array} bytes @returns {string} lowercase hex */
export function toHex(bytes) {
  assertBytes(bytes, 'hex input');
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

/**
 * @param {string} text even-length lowercase or uppercase hex
 * @returns {Uint8Array}
 * @throws {CryptoError} for anything else
 */
export function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new CryptoError('hex input is malformed');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** @param {string} text @returns {Uint8Array} UTF-8; lone surrogates become U+FFFD */
export function utf8(text) {
  return encoder.encode(text);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws {TypeError} if the bytes are not well-formed UTF-8
 */
export function utf8Decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** RFC 4648 base64 with padding. */
export function base64Encode(bytes) {
  assertBytes(bytes, 'base64 input');
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${BASE64[n >> 18]}${BASE64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${BASE64[n >> 18]}${BASE64[(n >> 12) & 63]}${BASE64[(n >> 6) & 63]}=`;
  }
  return out;
}

/**
 * Strict RFC 4648 base64: only what base64Encode() produces is accepted.
 *
 * @param {string} text
 * @param {number} [expectedLength] required decoded length
 * @returns {Uint8Array}
 * @throws {CryptoError} if the text is not canonical base64 or has the wrong length
 */
export function base64Decode(text, expectedLength) {
  if (typeof text !== 'string') throw new CryptoError('base64 input must be a string');
  if (expectedLength !== undefined) {
    if (!Number.isInteger(expectedLength) || expectedLength < 0) {
      throw new CryptoError('expected length must be a non-negative integer');
    }
    if (text.length !== 4 * Math.ceil(expectedLength / 3)) {
      throw new CryptoError(`base64 input does not encode ${expectedLength} bytes`);
    }
  }
  if (text.length % 4 !== 0) throw new CryptoError('base64 input is not canonical');
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const v = [0, 0, 0, 0];
    for (let k = 0; k < 4; k += 1) {
      const code = text.charCodeAt(i + k);
      if (last && k >= 4 - pad) {
        if (code !== 0x3d) throw new CryptoError('base64 input is not canonical');
        continue;
      }
      const value = code < 128 ? BASE64_VALUES[code] : -1;
      if (value < 0) throw new CryptoError('base64 input is not canonical');
      v[k] = value;
    }
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    // Bits the padding leaves unused must be zero, or two spellings would decode alike.
    if (last && pad === 2 && (n & 0xffff) !== 0) throw new CryptoError('base64 input is not canonical');
    if (last && pad === 1 && (n & 0xff) !== 0) throw new CryptoError('base64 input is not canonical');
    out[o] = n >> 16;
    if (o + 1 < out.length) out[o + 1] = (n >> 8) & 255;
    if (o + 2 < out.length) out[o + 2] = n & 255;
    o += 3;
  }
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new CryptoError(`base64 input does not encode ${expectedLength} bytes`);
  }
  return out;
}

/** RFC 4648 base32, lowercase alphabet, no padding. */
export function base32Encode(bytes) {
  assertBytes(bytes, 'base32 input');
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Strict lowercase unpadded base32: uppercase, padding, impossible lengths and non-zero
 * trailing bits are refused.
 *
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {CryptoError}
 */
export function base32Decode(text) {
  if (typeof text !== 'string') throw new CryptoError('base32 input must be a string');
  const tail = text.length % 8;
  if (tail === 1 || tail === 3 || tail === 6) {
    throw new CryptoError('base32 input has a length no encoder produces');
  }
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? BASE32_VALUES[code] : -1;
    if (value < 0) throw new CryptoError('base32 input contains a character outside the alphabet');
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[pos] = (acc >>> bits) & 0xff;
      pos += 1;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new CryptoError('base32 input has non-zero trailing bits');
  return out;
}

/** @returns {Uint8Array} `value` as two big-endian bytes */
export function u16(value) {
  return new Uint8Array([(value >>> 8) & 255, value & 255]);
}

/** @returns {Uint8Array} `value` as four big-endian bytes */
export function u32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

/** @returns {number} the big-endian u16 at `offset` */
export function readU16(bytes, offset = 0) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** @returns {number} the big-endian u32 at `offset` */
export function readU32(bytes, offset = 0) {
  return ((bytes[offset] << 24) >>> 0) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

/** Overwrite a secret in place; best effort, as the engine's `fill(0)`. */
export function wipe(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

export { EMPTY };
