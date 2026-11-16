/**
 * Cryptographic primitives.
 *
 * Thin wrappers over `node:crypto` (OpenSSL). Nothing here is a new construction: each
 * function is one standard primitive with its preconditions checked, so that the rest of
 * the engine cannot call it with a key of the wrong size, a string where bytes are
 * expected, or a truncated tag.
 *
 *   - X25519 (RFC 7748), Ed25519 (RFC 8032)
 *   - ChaCha20-Poly1305 with a 96-bit nonce and a 128-bit tag (RFC 8439)
 *   - SHA-256, HMAC-SHA256 (RFC 2104), HKDF-SHA256 (RFC 5869)
 *   - base32 and base64 (RFC 4648), decoded strictly
 *
 * Keys cross this API as raw 32-byte Buffers. OpenSSL wants them wrapped in PKCS#8 or
 * SPKI, so the fixed DER prefixes below are added and stripped here and nowhere else.
 *
 * Errors: a violated precondition throws CryptoError; failed authentication throws
 * AuthError. Messages never contain key material, plaintext, or the offending input.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  timingSafeEqual as nodeTimingSafeEqual,
  verify as nodeVerify,
} from 'node:crypto';

import { AuthError, CryptoError } from '../errors.js';

/** Length in bytes of every X25519 and Ed25519 key, public or private. */
export const KEY_LENGTH = 32;
/** Length in bytes of an Ed25519 signature. */
export const SIGNATURE_LENGTH = 64;
/** Length in bytes of a SHA-256 digest. */
export const HASH_LENGTH = 32;
/** Length in bytes of a ChaCha20-Poly1305 nonce. */
export const AEAD_NONCE_LENGTH = 12;
/** Length in bytes of a ChaCha20-Poly1305 authentication tag. */
export const AEAD_TAG_LENGTH = 16;
/** Most bytes one randomBytes() call returns; a guard against a length taken from the wire. */
export const MAX_RANDOM_BYTES = 1 << 20;

// RFC 5869: output is at most 255 blocks of the hash.
const HKDF_MAX_LENGTH = 255 * HASH_LENGTH;
// node:crypto refuses a longer `info`.
const HKDF_MAX_INFO = 1024;

// DER wrappers for raw 32-byte keys (RFC 8410). Private: PKCS#8 PrivateKeyInfo holding an
// OCTET STRING. Public: SubjectPublicKeyInfo holding a BIT STRING.
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ZERO_KEY = Buffer.alloc(KEY_LENGTH);

/**
 * The u-coordinates of small order on Curve25519 and its twist, with the unused top bit
 * cleared: 0, 1, the two of order 8, p - 1, and the non-canonical spellings p (= 0) and
 * p + 1 (= 1). These are exactly the inputs for which X25519 returns all zeros whatever
 * the private key is. The list is the one libsodium uses for the same purpose.
 */
const X25519_SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(hex => Buffer.from(hex, 'hex'));

/**
 * Encodings of the eight points of small order on edwards25519, with the sign bit of x
 * cleared (the last three rows are the non-canonical encodings of y = -1, 0 and 1).
 *
 * A signature under such a "public key" can satisfy the RFC 8032 verification equation
 * for messages nobody signed, because the key contributes almost nothing to it. Whether a
 * provider accepts such keys varies by library and version, so ed25519Verify() refuses
 * them itself, with the list libsodium uses for the same purpose.
 */
const ED25519_SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(hex => Buffer.from(hex, 'hex'));

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE32_ALPHABET.length; i += 1) {
  BASE32_VALUES[BASE32_ALPHABET.charCodeAt(i)] = i;
}

/**
 * Check that a value is a byte array, optionally of an exact length.
 *
 * @param {unknown} value
 * @param {string} name     what the value is, for the error message
 * @param {number} [length] required length in bytes
 * @returns {Uint8Array} the same value
 * @throws {CryptoError} if the value is not a Buffer or Uint8Array, or has the wrong length
 */
export function assertBytes(value, name, length) {
  if (!(value instanceof Uint8Array)) {
    throw new CryptoError(`${name} must be a Buffer or Uint8Array`);
  }
  if (length !== undefined && value.length !== length) {
    throw new CryptoError(`${name} must be ${length} bytes, got ${value.length}`);
  }
  return value;
}

/**
 * Cryptographically secure random bytes from the operating system.
 *
 * @param {number} n number of bytes, 0 to MAX_RANDOM_BYTES
 * @returns {Buffer}
 * @throws {CryptoError} if `n` is not an integer in range
 */
export function randomBytes(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_RANDOM_BYTES) {
    throw new CryptoError(`random byte count must be an integer from 0 to ${MAX_RANDOM_BYTES}`);
  }
  return nodeRandomBytes(n);
}

/**
 * SHA-256 of the concatenation of the chunks.
 *
 * @param {...Uint8Array} chunks
 * @returns {Buffer} 32 bytes
 * @throws {CryptoError} if a chunk is not a byte array
 */
export function sha256(...chunks) {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(assertBytes(chunk, 'hash input'));
  return hash.digest();
}

/**
 * HMAC-SHA256 of the concatenation of the chunks.
 *
 * @param {Uint8Array} key any length
 * @param {...Uint8Array} chunks
 * @returns {Buffer} 32 bytes
 * @throws {CryptoError} if the key or a chunk is not a byte array
 */
export function hmacSha256(key, ...chunks) {
  const mac = createHmac('sha256', assertBytes(key, 'HMAC key'));
  for (const chunk of chunks) mac.update(assertBytes(chunk, 'HMAC input'));
  return mac.digest();
}

/**
 * HKDF-SHA256 (RFC 5869): extract with `salt`, then expand with `info`.
 *
 * @param {object} params
 * @param {Uint8Array} params.ikm      input keying material, at least one byte
 * @param {Uint8Array} [params.salt]   omitted means the RFC's default of 32 zero bytes
 * @param {Uint8Array} params.info     context; binds the output to one purpose
 * @param {number} params.length       output length in bytes, 1 to 8160
 * @returns {Buffer}
 * @throws {CryptoError} if an argument has the wrong type or is out of range
 */
export function hkdfExpand({ ikm, salt, info, length } = {}) {
  assertBytes(ikm, 'HKDF input keying material');
  if (ikm.length === 0) throw new CryptoError('HKDF input keying material must not be empty');
  const saltBytes = salt === undefined ? Buffer.alloc(0) : assertBytes(salt, 'HKDF salt');
  assertBytes(info, 'HKDF info');
  if (info.length > HKDF_MAX_INFO) {
    throw new CryptoError(`HKDF info must be at most ${HKDF_MAX_INFO} bytes`);
  }
  if (!Number.isInteger(length) || length < 1 || length > HKDF_MAX_LENGTH) {
    throw new CryptoError(`HKDF output length must be an integer from 1 to ${HKDF_MAX_LENGTH}`);
  }
  return Buffer.from(hkdfSync('sha256', ikm, saltBytes, info, length));
}

/**
 * Generate an X25519 key pair.
 *
 * @returns {{ publicKey: Buffer, privateKey: Buffer }} two 32-byte keys
 * @throws {CryptoError} if the crypto provider returns an unexpected encoding
 */
export function x25519GenerateKeyPair() {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKey: exportRaw(pair.publicKey, 'spki', X25519_SPKI_PREFIX),
    privateKey: exportRaw(pair.privateKey, 'pkcs8', X25519_PKCS8_PREFIX),
  };
}

/**
 * Derive the X25519 public key that belongs to a private key.
 *
 * @param {Uint8Array} privateKey 32 bytes
 * @returns {Buffer} 32 bytes
 * @throws {CryptoError} if the key is not 32 bytes
 */
export function x25519PublicFromPrivate(privateKey) {
  assertBytes(privateKey, 'X25519 private key', KEY_LENGTH);
  return derivePublic(privateKey, X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX, 'X25519');
}

/**
 * X25519 Diffie-Hellman.
 *
 * An all-zero result means the peer supplied a point of small order, which would make the
 * "shared" secret a constant anyone can compute. That is refused instead of returned.
 *
 * @param {Uint8Array} privateKey 32 bytes
 * @param {Uint8Array} publicKey  32 bytes, the other party's public key
 * @returns {Buffer} 32-byte shared secret
 * @throws {CryptoError} if a key has the wrong size or the public key has small order
 */
export function x25519(privateKey, publicKey) {
  assertBytes(privateKey, 'X25519 private key', KEY_LENGTH);
  assertBytes(publicKey, 'X25519 public key', KEY_LENGTH);
  let secret;
  try {
    secret = diffieHellman({
      privateKey: importPrivate(X25519_PKCS8_PREFIX, privateKey),
      publicKey: importPublic(X25519_SPKI_PREFIX, publicKey),
    });
  } catch (cause) {
    // OpenSSL itself fails the derivation for small-order points.
    throw new CryptoError('X25519 key agreement failed: unusable public key', { cause });
  }
  if (secret.length !== KEY_LENGTH || nodeTimingSafeEqual(secret, ZERO_KEY)) {
    throw new CryptoError('X25519 key agreement failed: unusable public key');
  }
  return secret;
}

/**
 * Whether an X25519 public key is one of the small-order values that x25519() refuses.
 *
 * x25519() stays the authority: it checks the result of every key agreement. This lets a
 * protocol turn such a key away at the moment it arrives instead of at a later step, when
 * the failure is harder to attribute to the peer that sent it.
 *
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {boolean}
 * @throws {CryptoError} if the key is not 32 bytes
 */
export function x25519HasSmallOrder(publicKey) {
  assertBytes(publicKey, 'X25519 public key', KEY_LENGTH);
  // RFC 7748: the top bit of a u-coordinate is ignored, so it is ignored here as well.
  const masked = Buffer.from(publicKey);
  masked[KEY_LENGTH - 1] &= 0x7f;
  // Public keys are not secret, so an early exit leaks nothing.
  return X25519_SMALL_ORDER.some(point => point.equals(masked));
}

/**
 * Generate an Ed25519 key pair.
 *
 * @returns {{ publicKey: Buffer, privateKey: Buffer }} 32-byte public key and 32-byte seed
 * @throws {CryptoError} if the crypto provider returns an unexpected encoding
 */
export function ed25519GenerateKeyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: exportRaw(pair.publicKey, 'spki', ED25519_SPKI_PREFIX),
    privateKey: exportRaw(pair.privateKey, 'pkcs8', ED25519_PKCS8_PREFIX),
  };
}

/**
 * Derive the Ed25519 public key that belongs to a seed.
 *
 * @param {Uint8Array} seed 32 bytes
 * @returns {Buffer} 32 bytes
 * @throws {CryptoError} if the seed is not 32 bytes
 */
export function ed25519PublicFromPrivate(seed) {
  assertBytes(seed, 'Ed25519 seed', KEY_LENGTH);
  return derivePublic(seed, ED25519_PKCS8_PREFIX, ED25519_SPKI_PREFIX, 'Ed25519');
}

/**
 * Ed25519 signature (RFC 8032, pure Ed25519, deterministic).
 *
 * @param {Uint8Array} seed    32-byte private seed
 * @param {Uint8Array} message bytes to sign
 * @returns {Buffer} 64-byte signature
 * @throws {CryptoError} if an argument has the wrong type or size
 */
export function ed25519Sign(seed, message) {
  assertBytes(seed, 'Ed25519 seed', KEY_LENGTH);
  assertBytes(message, 'message');
  let signature;
  try {
    signature = nodeSign(null, message, importPrivate(ED25519_PKCS8_PREFIX, seed));
  } catch (cause) {
    throw new CryptoError('Ed25519 signing failed', { cause });
  }
  if (signature.length !== SIGNATURE_LENGTH) throw new CryptoError('Ed25519 signing failed');
  return signature;
}

/**
 * Whether an Ed25519 public key encodes one of the eight points of small order. Such a
 * key has no private key in any useful sense and ed25519Verify() never accepts it.
 *
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {boolean}
 * @throws {CryptoError} if the key is not 32 bytes
 */
export function ed25519HasSmallOrder(publicKey) {
  assertBytes(publicKey, 'Ed25519 public key', KEY_LENGTH);
  // The top bit is the sign of x; both signs of a small-order point have small order.
  const masked = Buffer.from(publicKey);
  masked[KEY_LENGTH - 1] &= 0x7f;
  // Public keys are not secret, so an early exit leaks nothing.
  return ED25519_SMALL_ORDER.some(point => point.equals(masked));
}

/**
 * Verify an Ed25519 signature. Never throws: anything that is not a valid signature by
 * this key over this message, including arguments of the wrong type or size, is `false`.
 *
 * Public keys of small order are refused outright, whatever the crypto provider would do
 * with them (see ED25519_SMALL_ORDER).
 *
 * @param {Uint8Array} publicKey 32 bytes
 * @param {Uint8Array} message
 * @param {Uint8Array} signature 64 bytes
 * @returns {boolean}
 */
export function ed25519Verify(publicKey, message, signature) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== KEY_LENGTH) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_LENGTH) return false;
  if (!(message instanceof Uint8Array)) return false;
  if (ed25519HasSmallOrder(publicKey)) return false;
  try {
    const key = importPublic(ED25519_SPKI_PREFIX, publicKey);
    return nodeVerify(null, message, key, signature) === true;
  } catch {
    return false;
  }
}

/**
 * ChaCha20-Poly1305 authenticated encryption.
 *
 * The caller owns nonce uniqueness: one (key, nonce) pair must never encrypt two
 * different messages.
 *
 * @param {Uint8Array} key       32 bytes
 * @param {Uint8Array} nonce     12 bytes
 * @param {Uint8Array} ad        associated data, authenticated but not encrypted; may be empty
 * @param {Uint8Array} plaintext may be empty
 * @returns {Buffer} ciphertext followed by the 16-byte tag
 * @throws {CryptoError} if an argument has the wrong type or size
 */
export function aeadEncrypt(key, nonce, ad, plaintext) {
  assertBytes(key, 'AEAD key', KEY_LENGTH);
  assertBytes(nonce, 'AEAD nonce', AEAD_NONCE_LENGTH);
  assertBytes(ad, 'AEAD associated data');
  assertBytes(plaintext, 'AEAD plaintext');
  try {
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: AEAD_TAG_LENGTH,
    });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } catch (cause) {
    throw new CryptoError('AEAD encryption failed', { cause });
  }
}

/**
 * ChaCha20-Poly1305 authenticated decryption.
 *
 * @param {Uint8Array} key        32 bytes
 * @param {Uint8Array} nonce      12 bytes
 * @param {Uint8Array} ad         associated data the sender used
 * @param {Uint8Array} ciphertext ciphertext followed by the 16-byte tag
 * @returns {Buffer} plaintext
 * @throws {CryptoError} if an argument has the wrong type, or key or nonce the wrong size
 * @throws {AuthError} if the input is shorter than a tag or does not authenticate
 */
export function aeadDecrypt(key, nonce, ad, ciphertext) {
  assertBytes(key, 'AEAD key', KEY_LENGTH);
  assertBytes(nonce, 'AEAD nonce', AEAD_NONCE_LENGTH);
  assertBytes(ad, 'AEAD associated data');
  assertBytes(ciphertext, 'AEAD ciphertext');
  if (ciphertext.length < AEAD_TAG_LENGTH) {
    throw new AuthError('ciphertext is shorter than an authentication tag');
  }
  const split = ciphertext.length - AEAD_TAG_LENGTH;
  try {
    // authTagLength pins the tag to 16 bytes; without it OpenSSL would accept shorter tags.
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: AEAD_TAG_LENGTH,
    });
    decipher.setAuthTag(ciphertext.subarray(split));
    decipher.setAAD(ad, { plaintextLength: split });
    const head = decipher.update(ciphertext.subarray(0, split));
    // final() is what checks the tag; nothing is returned unless it succeeds.
    return Buffer.concat([head, decipher.final()]);
  } catch (cause) {
    throw new AuthError('ciphertext failed authentication', { cause });
  }
}

/**
 * Compare two byte arrays without leaking where they differ.
 *
 * The lengths are not secret: a mismatch returns `false` immediately.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 * @throws {CryptoError} if an argument is not a byte array
 */
export function timingSafeEqual(a, b) {
  assertBytes(a, 'first operand');
  assertBytes(b, 'second operand');
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(a, b);
}

/**
 * RFC 4648 base32 with the lowercase alphabet and no padding.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws {CryptoError} if the input is not a byte array
 */
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
      out += BASE32_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Decode lowercase, unpadded RFC 4648 base32.
 *
 * Strict: every byte string has exactly one accepted encoding. Uppercase, padding,
 * lengths no encoder produces and non-zero trailing bits are all rejected, so an
 * identifier cannot be respelled to slip past an equality check.
 *
 * @param {string} text
 * @returns {Buffer}
 * @throws {CryptoError} if the input is not canonical base32
 */
export function base32Decode(text) {
  if (typeof text !== 'string') throw new CryptoError('base32 input must be a string');
  const tail = text.length % 8;
  if (tail === 1 || tail === 3 || tail === 6) {
    throw new CryptoError('base32 input has a length no encoder produces');
  }
  const out = Buffer.alloc(Math.floor((text.length * 5) / 8));
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

/**
 * RFC 4648 base64 with padding.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws {CryptoError} if the input is not a byte array
 */
export function base64Encode(bytes) {
  assertBytes(bytes, 'base64 input');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64');
}

/**
 * Decode RFC 4648 base64 with padding.
 *
 * Strict: the input must be exactly what base64Encode() produces for the decoded bytes.
 * Missing padding, whitespace, the URL-safe alphabet and non-zero trailing bits are all
 * rejected.
 *
 * @param {string} text
 * @param {number} [expectedLength] required decoded length in bytes
 * @returns {Buffer}
 * @throws {CryptoError} if the input is not canonical base64 or has the wrong length
 */
export function base64Decode(text, expectedLength) {
  if (typeof text !== 'string') throw new CryptoError('base64 input must be a string');
  if (expectedLength !== undefined) {
    if (!Number.isInteger(expectedLength) || expectedLength < 0) {
      throw new CryptoError('expected length must be a non-negative integer');
    }
    // Checked before decoding so an oversized value is never materialised.
    if (text.length !== 4 * Math.ceil(expectedLength / 3)) {
      throw new CryptoError(`base64 input does not encode ${expectedLength} bytes`);
    }
  }
  const out = Buffer.from(text, 'base64');
  // Buffer.from() skips what it does not understand; re-encoding is what makes this strict.
  if (out.toString('base64') !== text) throw new CryptoError('base64 input is not canonical');
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new CryptoError(`base64 input does not encode ${expectedLength} bytes`);
  }
  return out;
}

function importPrivate(prefix, raw) {
  return createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
}

function importPublic(prefix, raw) {
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

function exportRaw(keyObject, type, prefix) {
  const der = keyObject.export({ format: 'der', type });
  // Fail closed if the provider ever emits a different (longer or reordered) encoding:
  // slicing the tail of an unknown structure could return bytes that are not the key.
  if (der.length !== prefix.length + KEY_LENGTH || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new CryptoError('crypto provider returned an unexpected key encoding');
  }
  return Buffer.from(der.subarray(prefix.length));
}

function derivePublic(privateKey, pkcs8Prefix, spkiPrefix, algorithm) {
  let publicKey;
  try {
    publicKey = createPublicKey(importPrivate(pkcs8Prefix, privateKey));
  } catch (cause) {
    throw new CryptoError(`${algorithm} private key could not be loaded`, { cause });
  }
  return exportRaw(publicKey, 'spki', spkiPrefix);
}
