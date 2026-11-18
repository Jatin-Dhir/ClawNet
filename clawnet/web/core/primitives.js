/**
 * Cryptographic primitives of the web core: the engine's `src/core/crypto/primitives.js`
 * with the same names and the same checks, on the vendored noble libraries instead of
 * OpenSSL (web/vendor/README.md says why and which versions).
 *
 *   - X25519 (RFC 7748) and Ed25519 (RFC 8032): @noble/curves
 *   - ChaCha20-Poly1305 with a 96-bit nonce and a 128-bit tag (RFC 8439): @noble/ciphers
 *   - SHA-256, HMAC-SHA256 (RFC 2104), HKDF-SHA256 (RFC 5869): @noble/hashes
 *
 * Nothing here is a new construction; each function is one library call with its
 * preconditions checked. Where the two implementations could differ the engine's choice
 * is copied: keys of small order are refused by the same lists, and Ed25519 verification
 * uses the library's strict mode (RFC 8032 encodings, `zip215: false`).
 *
 * One difference remains and is documented in docs/REVIEW.md: noble verifies Ed25519 with
 * the cofactored equation, OpenSSL with the cofactorless one. They agree on every
 * signature an honest signer produces; a signer that deliberately builds a signature with
 * a small-order component can make one that only one of them accepts.
 *
 * Errors: a violated precondition throws CryptoError; failed authentication throws
 * AuthError. Messages never contain key material.
 */

import { AuthError, CryptoError } from '../../src/core/errors.js';
import { chacha20poly1305 } from '../vendor/noble-ciphers/chacha.js';
import { ed25519, x25519 as nobleX25519 } from '../vendor/noble-curves/ed25519.js';
import { hkdf } from '../vendor/noble-hashes/hkdf.js';
import { hmac } from '../vendor/noble-hashes/hmac.js';
import { sha256 as nobleSha256 } from '../vendor/noble-hashes/sha2.js';
import {
  assertBytes,
  base32Decode,
  base32Encode,
  base64Decode,
  base64Encode,
  equalBytes,
  fromHex,
  randomBytes,
} from './bytes.js';

export { assertBytes, base32Decode, base32Encode, base64Decode, base64Encode, randomBytes };

export const KEY_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;
export const HASH_LENGTH = 32;
export const AEAD_NONCE_LENGTH = 12;
export const AEAD_TAG_LENGTH = 16;

const HKDF_MAX_LENGTH = 255 * HASH_LENGTH;
// The engine's node:crypto refuses a longer `info`; refused here too so both agree.
const HKDF_MAX_INFO = 1024;
const ZERO_KEY = new Uint8Array(KEY_LENGTH);

/** The same small-order X25519 u-coordinates the engine refuses (libsodium's list). */
const X25519_SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(fromHex);

/** The same small-order Ed25519 encodings the engine refuses (libsodium's list). */
const ED25519_SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(fromHex);

/** SHA-256 of the concatenation of the chunks. @returns {Uint8Array} 32 bytes */
export function sha256(...chunks) {
  const hash = nobleSha256.create();
  for (const chunk of chunks) hash.update(assertBytes(chunk, 'hash input'));
  return hash.digest();
}

/** HMAC-SHA256 of the concatenation of the chunks. @returns {Uint8Array} 32 bytes */
export function hmacSha256(key, ...chunks) {
  const mac = hmac.create(nobleSha256, assertBytes(key, 'HMAC key'));
  for (const chunk of chunks) mac.update(assertBytes(chunk, 'HMAC input'));
  return mac.digest();
}

/**
 * HKDF-SHA256 (RFC 5869), with the engine's argument rules.
 *
 * @param {{ ikm: Uint8Array, salt?: Uint8Array, info: Uint8Array, length: number }} params
 * @returns {Uint8Array}
 */
export function hkdfExpand({ ikm, salt, info, length } = {}) {
  assertBytes(ikm, 'HKDF input keying material');
  if (ikm.length === 0) throw new CryptoError('HKDF input keying material must not be empty');
  const saltBytes = salt === undefined ? new Uint8Array(0) : assertBytes(salt, 'HKDF salt');
  assertBytes(info, 'HKDF info');
  if (info.length > HKDF_MAX_INFO) throw new CryptoError(`HKDF info must be at most ${HKDF_MAX_INFO} bytes`);
  if (!Number.isInteger(length) || length < 1 || length > HKDF_MAX_LENGTH) {
    throw new CryptoError(`HKDF output length must be an integer from 1 to ${HKDF_MAX_LENGTH}`);
  }
  // RFC 5869: an empty salt means HashLen zero bytes, which is what node:crypto does too.
  return hkdf(nobleSha256, ikm, saltBytes.length === 0 ? ZERO_KEY : saltBytes, info, length);
}

/** @returns {{ publicKey: Uint8Array, privateKey: Uint8Array }} */
export function x25519GenerateKeyPair() {
  const privateKey = randomBytes(KEY_LENGTH);
  return { publicKey: nobleX25519.getPublicKey(privateKey), privateKey };
}

/** @param {Uint8Array} privateKey 32 bytes @returns {Uint8Array} 32 bytes */
export function x25519PublicFromPrivate(privateKey) {
  assertBytes(privateKey, 'X25519 private key', KEY_LENGTH);
  return nobleX25519.getPublicKey(privateKey);
}

/**
 * X25519 Diffie-Hellman; an all-zero result (a peer key of small order) is refused.
 *
 * @param {Uint8Array} privateKey 32 bytes
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {Uint8Array} 32-byte shared secret
 */
export function x25519(privateKey, publicKey) {
  assertBytes(privateKey, 'X25519 private key', KEY_LENGTH);
  assertBytes(publicKey, 'X25519 public key', KEY_LENGTH);
  let secret;
  try {
    secret = nobleX25519.getSharedSecret(privateKey, publicKey);
  } catch (cause) {
    // noble refuses an all-zero result itself.
    throw new CryptoError('X25519 key agreement failed: unusable public key', { cause });
  }
  if (secret.length !== KEY_LENGTH || equalBytes(secret, ZERO_KEY)) {
    throw new CryptoError('X25519 key agreement failed: unusable public key');
  }
  return secret;
}

/** @param {Uint8Array} publicKey @returns {boolean} whether it is a small-order point */
export function x25519HasSmallOrder(publicKey) {
  assertBytes(publicKey, 'X25519 public key', KEY_LENGTH);
  const masked = Uint8Array.from(publicKey);
  masked[KEY_LENGTH - 1] &= 0x7f;
  return X25519_SMALL_ORDER.some((point) => equalBytes(point, masked));
}

/** @returns {{ publicKey: Uint8Array, privateKey: Uint8Array }} 32-byte key and seed */
export function ed25519GenerateKeyPair() {
  const privateKey = randomBytes(KEY_LENGTH);
  return { publicKey: ed25519.getPublicKey(privateKey), privateKey };
}

/** @param {Uint8Array} seed 32 bytes @returns {Uint8Array} 32 bytes */
export function ed25519PublicFromPrivate(seed) {
  assertBytes(seed, 'Ed25519 seed', KEY_LENGTH);
  return ed25519.getPublicKey(seed);
}

/** Pure Ed25519 (RFC 8032), deterministic. @returns {Uint8Array} 64 bytes */
export function ed25519Sign(seed, message) {
  assertBytes(seed, 'Ed25519 seed', KEY_LENGTH);
  assertBytes(message, 'message');
  let signature;
  try {
    signature = ed25519.sign(message, seed);
  } catch (cause) {
    throw new CryptoError('Ed25519 signing failed', { cause });
  }
  if (signature.length !== SIGNATURE_LENGTH) throw new CryptoError('Ed25519 signing failed');
  return signature;
}

/** @param {Uint8Array} publicKey @returns {boolean} whether it encodes a small-order point */
export function ed25519HasSmallOrder(publicKey) {
  assertBytes(publicKey, 'Ed25519 public key', KEY_LENGTH);
  const masked = Uint8Array.from(publicKey);
  masked[KEY_LENGTH - 1] &= 0x7f;
  return ED25519_SMALL_ORDER.some((point) => equalBytes(point, masked));
}

/**
 * Verify an Ed25519 signature. Never throws: anything that is not a valid signature by
 * this key over this message is `false`. Small-order keys are refused outright.
 *
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
export function ed25519Verify(publicKey, message, signature) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== KEY_LENGTH) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_LENGTH) return false;
  if (!(message instanceof Uint8Array)) return false;
  if (ed25519HasSmallOrder(publicKey)) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false }) === true;
  } catch {
    return false;
  }
}

/**
 * ChaCha20-Poly1305 encryption. The caller owns nonce uniqueness.
 *
 * @returns {Uint8Array} ciphertext followed by the 16-byte tag
 */
export function aeadEncrypt(key, nonce, ad, plaintext) {
  assertBytes(key, 'AEAD key', KEY_LENGTH);
  assertBytes(nonce, 'AEAD nonce', AEAD_NONCE_LENGTH);
  assertBytes(ad, 'AEAD associated data');
  assertBytes(plaintext, 'AEAD plaintext');
  try {
    return chacha20poly1305(key, nonce, ad).encrypt(plaintext);
  } catch (cause) {
    throw new CryptoError('AEAD encryption failed', { cause });
  }
}

/**
 * ChaCha20-Poly1305 decryption.
 *
 * @returns {Uint8Array} plaintext
 * @throws {AuthError} if the input is shorter than a tag or does not authenticate
 */
export function aeadDecrypt(key, nonce, ad, ciphertext) {
  assertBytes(key, 'AEAD key', KEY_LENGTH);
  assertBytes(nonce, 'AEAD nonce', AEAD_NONCE_LENGTH);
  assertBytes(ad, 'AEAD associated data');
  assertBytes(ciphertext, 'AEAD ciphertext');
  if (ciphertext.length < AEAD_TAG_LENGTH) throw new AuthError('ciphertext is shorter than an authentication tag');
  try {
    return chacha20poly1305(key, nonce, ad).decrypt(ciphertext);
  } catch (cause) {
    throw new AuthError('ciphertext failed authentication', { cause });
  }
}

/** Compare two byte arrays without an early exit; lengths are not secret. */
export function timingSafeEqual(a, b) {
  return equalBytes(a, b);
}
