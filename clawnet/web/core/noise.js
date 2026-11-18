/**
 * The Noise Protocol Framework, revision 34, suite 25519_ChaChaPoly_SHA256: a port of the
 * engine's `src/core/crypto/noise.js` to Uint8Array and the noble primitives.
 *
 * The structure is the specification's and the engine's: CipherState, SymmetricState and
 * HandshakeState (section 5), patterns as data (sections 7 and 9) interpreted by one
 * engine for both roles. Every pattern the engine supports is supported here, so the same
 * published test vectors (test/vectors/noise-vectors.json) run against both
 * implementations; XXpsk0, which no vector covers, is checked against the engine byte for
 * byte instead.
 *
 * ClawNet uses XX and XXpsk0 for links and X for end-to-end messages. As in the engine, a
 * public key of small order is refused where it arrives.
 *
 * Errors: local misuse throws CryptoError or StateError; anything wrong with a received
 * message throws AuthError.
 */

import { AuthError, CryptoError, StateError } from '../../src/core/errors.js';
import { concat, equalBytes, utf8, wipe } from './bytes.js';
import {
  AEAD_TAG_LENGTH,
  HASH_LENGTH,
  KEY_LENGTH,
  aeadDecrypt,
  aeadEncrypt,
  assertBytes,
  hmacSha256,
  sha256,
  x25519,
  x25519GenerateKeyPair,
  x25519HasSmallOrder,
  x25519PublicFromPrivate,
} from './primitives.js';

/** Largest Noise message in bytes (specification section 3). */
export const NOISE_MAX_MESSAGE = 65535;

/** Largest plaintext one transport message carries. */
export const NOISE_MAX_PLAINTEXT = NOISE_MAX_MESSAGE - AEAD_TAG_LENGTH;

const SUITE = '25519_ChaChaPoly_SHA256';
const DH_LENGTH = KEY_LENGTH;
const EMPTY = new Uint8Array(0);
const ZEROS = new Uint8Array(KEY_LENGTH);
const MAX_NONCE = 0xffffffffffffffffn;

const FUNDAMENTAL = {
  N: [[], ['s'], [['e', 'es']]],
  K: [['s'], ['s'], [['e', 'es', 'ss']]],
  X: [[], ['s'], [['e', 'es', 's', 'ss']]],
  NN: [[], [], [['e'], ['e', 'ee']]],
  NK: [[], ['s'], [['e', 'es'], ['e', 'ee']]],
  NX: [[], [], [['e'], ['e', 'ee', 's', 'es']]],
  KN: [['s'], [], [['e'], ['e', 'ee', 'se']]],
  KK: [['s'], ['s'], [['e', 'es', 'ss'], ['e', 'ee', 'se']]],
  KX: [['s'], [], [['e'], ['e', 'ee', 'se', 's', 'es']]],
  XN: [[], [], [['e'], ['e', 'ee'], ['s', 'se']]],
  XK: [[], ['s'], [['e', 'es'], ['e', 'ee'], ['s', 'se']]],
  XX: [[], [], [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']]],
  IN: [[], [], [['e', 's'], ['e', 'ee', 'se']]],
  IK: [[], ['s'], [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']]],
  IX: [[], [], [['e', 's'], ['e', 'ee', 'se', 's', 'es']]],
};

const PSK_VARIANTS = [
  'Npsk0', 'Kpsk0', 'Xpsk1',
  'NNpsk0', 'NNpsk2', 'NKpsk0', 'NKpsk2', 'NXpsk2',
  'XNpsk3', 'XKpsk3', 'XXpsk0', 'XXpsk3',
  'KNpsk0', 'KNpsk2', 'KKpsk0', 'KKpsk2', 'KXpsk2',
  'INpsk1', 'INpsk2', 'IKpsk1', 'IKpsk2', 'IXpsk2',
];

const PATTERNS = buildPatterns();

/** Names of every handshake pattern this module accepts. */
export const NOISE_PATTERNS = Object.freeze([...PATTERNS.keys()]);

/** @param {string} pattern @returns {string} the full Noise protocol name */
export function protocolName(pattern) {
  return `Noise_${lookupPattern(pattern).name}_${SUITE}`;
}

/** A key and a nonce counter for one direction (section 5.1). */
export class CipherState {
  #key = null;
  #nonce = 0n;

  /** @param {Uint8Array} [key] */
  constructor(key) {
    if (key !== undefined) this.#key = Uint8Array.from(assertBytes(key, 'cipher key', KEY_LENGTH));
  }

  hasKey() {
    return this.#key !== null;
  }

  get nonce() {
    return this.#nonce;
  }

  /** @param {bigint | number} nonce */
  setNonce(nonce) {
    const value = typeof nonce === 'number' && Number.isSafeInteger(nonce) ? BigInt(nonce) : nonce;
    if (typeof value !== 'bigint' || value < 0n || value > MAX_NONCE) {
      throw new CryptoError('nonce must be an integer from 0 to 2^64 - 1');
    }
    this.#nonce = value;
  }

  /** EncryptWithAd. @returns {Uint8Array} */
  encryptWithAd(ad, plaintext) {
    assertBytes(ad, 'associated data');
    assertBytes(plaintext, 'plaintext');
    const overhead = this.#key === null ? 0 : AEAD_TAG_LENGTH;
    if (plaintext.length + overhead > NOISE_MAX_MESSAGE) {
      throw new CryptoError(`Noise message would exceed ${NOISE_MAX_MESSAGE} bytes`);
    }
    if (this.#key === null) return Uint8Array.from(plaintext);
    this.#requireNonce();
    const ciphertext = aeadEncrypt(this.#key, encodeNonce(this.#nonce), ad, plaintext);
    this.#nonce += 1n;
    return ciphertext;
  }

  /** DecryptWithAd; the nonce is unchanged on failure. @returns {Uint8Array} */
  decryptWithAd(ad, ciphertext) {
    assertBytes(ad, 'associated data');
    assertBytes(ciphertext, 'ciphertext');
    if (ciphertext.length > NOISE_MAX_MESSAGE) {
      throw new AuthError(`Noise message exceeds ${NOISE_MAX_MESSAGE} bytes`);
    }
    if (this.#key === null) return Uint8Array.from(ciphertext);
    this.#requireNonce();
    const plaintext = aeadDecrypt(this.#key, encodeNonce(this.#nonce), ad, ciphertext);
    this.#nonce += 1n;
    return plaintext;
  }

  /** Rekey (section 4.2); the nonce is not changed. */
  rekey() {
    if (this.#key === null) throw new StateError('cannot rekey a cipher that has no key');
    const next = aeadEncrypt(this.#key, encodeNonce(MAX_NONCE), EMPTY, ZEROS);
    this.#key = next.slice(0, KEY_LENGTH);
  }

  #requireNonce() {
    if (this.#nonce === MAX_NONCE) {
      throw new StateError('nonce counter exhausted: this cipher can process no more messages');
    }
  }
}

class SymmetricState {
  #ck;
  #h;
  #cipher = new CipherState();

  constructor(name) {
    const bytes = utf8(name);
    if (bytes.length <= HASH_LENGTH) {
      this.#h = new Uint8Array(HASH_LENGTH);
      this.#h.set(bytes);
    } else {
      this.#h = sha256(bytes);
    }
    this.#ck = this.#h;
  }

  mixKey(inputKeyMaterial) {
    const [ck, tempK] = hkdf(this.#ck, inputKeyMaterial, 2);
    this.#ck = ck;
    this.#cipher = new CipherState(tempK);
  }

  mixHash(data) {
    this.#h = sha256(this.#h, data);
  }

  mixKeyAndHash(inputKeyMaterial) {
    const [ck, tempH, tempK] = hkdf(this.#ck, inputKeyMaterial, 3);
    this.#ck = ck;
    this.mixHash(tempH);
    this.#cipher = new CipherState(tempK);
  }

  hasKey() {
    return this.#cipher.hasKey();
  }

  getHandshakeHash() {
    return Uint8Array.from(this.#h);
  }

  encryptAndHash(plaintext) {
    const ciphertext = this.#cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext = this.#cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    const [k1, k2] = hkdf(this.#ck, EMPTY, 2);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

/** One party's side of a Noise handshake (section 5.3); same API as the engine's. */
export class HandshakeState {
  #pattern;
  #initiator;
  #symmetric;
  #s = null;
  #e = null;
  #rs = null;
  #re = null;
  #psk = null;
  #index = 0;
  #failed = false;
  #ciphers = null;
  #hash = null;

  /**
   * @param {object} options see the engine's HandshakeState
   */
  constructor({ pattern, initiator, prologue, s, e, rs, re, psk } = {}) {
    const compiled = lookupPattern(pattern);
    if (typeof initiator !== 'boolean') throw new CryptoError('initiator must be a boolean');
    assertBytes(prologue, 'prologue');
    const self = initiator ? compiled.initiator : compiled.responder;
    const peer = initiator ? compiled.responder : compiled.initiator;

    if (self.usesStatic) {
      if (s == null) throw new CryptoError(`pattern ${compiled.name} needs a local static key`);
      this.#s = copyKeyPair(s, 'local static key');
    } else if (s != null) {
      throw new CryptoError(`pattern ${compiled.name} has no local static key for this role`);
    }
    if (e != null) this.#e = copyKeyPair(e, 'local ephemeral key');
    if (peer.pre.includes('s')) {
      if (rs == null) throw new CryptoError(`pattern ${compiled.name} needs the remote static key`);
      this.#rs = Uint8Array.from(assertBytes(rs, 'remote static key', DH_LENGTH));
      if (x25519HasSmallOrder(this.#rs)) throw new CryptoError('remote static key is not a usable public key');
    } else if (rs != null) {
      throw new CryptoError(`pattern ${compiled.name} does not take a remote static key`);
    }
    if (re != null) throw new CryptoError('a remote ephemeral key cannot be supplied in advance');
    if (compiled.psk) {
      if (psk == null) throw new CryptoError(`pattern ${compiled.name} needs a pre-shared key`);
      this.#psk = Uint8Array.from(assertBytes(psk, 'pre-shared key', KEY_LENGTH));
    } else if (psk != null) {
      throw new CryptoError(`pattern ${compiled.name} does not use a pre-shared key`);
    }

    this.#pattern = compiled;
    this.#initiator = initiator;
    this.#symmetric = new SymmetricState(`Noise_${compiled.name}_${SUITE}`);
    this.#symmetric.mixHash(prologue);
    if (compiled.initiator.pre.length > 0) this.#symmetric.mixHash(initiator ? this.#s.publicKey : this.#rs);
    if (compiled.responder.pre.length > 0) this.#symmetric.mixHash(initiator ? this.#rs : this.#s.publicKey);
  }

  get isComplete() {
    return this.#hash !== null;
  }

  /** @returns {Uint8Array | null} */
  get remoteStaticKey() {
    return this.#rs === null || this.#failed ? null : Uint8Array.from(this.#rs);
  }

  /** @returns {Uint8Array} */
  get handshakeHash() {
    if (this.#hash === null) throw new StateError('handshake is not complete');
    return Uint8Array.from(this.#hash);
  }

  /** @param {Uint8Array} [payload] @returns {Uint8Array} */
  writeMessage(payload = EMPTY) {
    assertBytes(payload, 'payload');
    const tokens = this.#nextTokens(true);
    if (payload.length + this.#overhead(tokens) > NOISE_MAX_MESSAGE) {
      throw new CryptoError(`handshake message would exceed ${NOISE_MAX_MESSAGE} bytes`);
    }
    try {
      const parts = [];
      for (const token of tokens) {
        if (token === 'e') {
          this.#e ??= x25519GenerateKeyPair();
          parts.push(this.#e.publicKey);
          this.#mixEphemeral(this.#e.publicKey);
        } else if (token === 's') {
          parts.push(this.#symmetric.encryptAndHash(this.#s.publicKey));
        } else {
          this.#mixSecret(token);
        }
      }
      parts.push(this.#symmetric.encryptAndHash(payload));
      this.#advance();
      return concat(...parts);
    } catch (err) {
      this.#fail();
      throw err;
    }
  }

  /** @param {Uint8Array} message @returns {Uint8Array} the payload */
  readMessage(message) {
    assertBytes(message, 'message');
    const tokens = this.#nextTokens(false);
    try {
      if (message.length > NOISE_MAX_MESSAGE) throw new AuthError(`handshake message exceeds ${NOISE_MAX_MESSAGE} bytes`);
      if (message.length < this.#overhead(tokens)) throw new AuthError('handshake message is truncated');
      let offset = 0;
      for (const token of tokens) {
        if (token === 'e') {
          this.#re = receivedKey(message.subarray(offset, offset + DH_LENGTH));
          offset += DH_LENGTH;
          this.#mixEphemeral(this.#re);
        } else if (token === 's') {
          const length = DH_LENGTH + (this.#symmetric.hasKey() ? AEAD_TAG_LENGTH : 0);
          this.#rs = receivedKey(this.#symmetric.decryptAndHash(message.subarray(offset, offset + length)));
          offset += length;
        } else {
          this.#mixSecret(token);
        }
      }
      const payload = this.#symmetric.decryptAndHash(message.subarray(offset));
      this.#advance();
      return payload;
    } catch (err) {
      this.#fail();
      if (err instanceof AuthError) throw err;
      throw new AuthError('handshake message rejected', { cause: err });
    }
  }

  /** @returns {{ tx: CipherState | null, rx: CipherState | null }} */
  split() {
    if (this.#ciphers === null) {
      throw new StateError(this.#hash === null ? 'handshake is not complete' : 'split() was already called');
    }
    const [first, second] = this.#ciphers;
    this.#ciphers = null;
    const tx = this.#initiator ? first : second;
    const rx = this.#initiator ? second : first;
    if (!this.#pattern.oneWay) return { tx, rx };
    return this.#initiator ? { tx, rx: null } : { tx: null, rx };
  }

  #nextTokens(writing) {
    if (this.#failed) throw new StateError('handshake has failed and cannot be used again');
    if (this.isComplete) throw new StateError('handshake is already complete');
    const initiatorsTurn = this.#index % 2 === 0;
    if ((initiatorsTurn === this.#initiator) !== writing) {
      throw new StateError(
        writing
          ? 'out of turn: the next handshake message must be read, not written'
          : 'out of turn: the next handshake message must be written, not read',
      );
    }
    return this.#pattern.messages[this.#index];
  }

  #overhead(tokens) {
    let keyed = this.#symmetric.hasKey();
    let size = 0;
    for (const token of tokens) {
      if (token === 'e') {
        size += DH_LENGTH;
        if (this.#pattern.psk) keyed = true;
      } else if (token === 's') {
        size += DH_LENGTH + (keyed ? AEAD_TAG_LENGTH : 0);
      } else {
        keyed = true;
      }
    }
    return size + (keyed ? AEAD_TAG_LENGTH : 0);
  }

  #mixEphemeral(publicKey) {
    this.#symmetric.mixHash(publicKey);
    // Section 9.2: with a psk modifier every "e" token is followed by MixKey(e.public_key).
    if (this.#pattern.psk) this.#symmetric.mixKey(publicKey);
  }

  #mixSecret(token) {
    if (token === 'psk') {
      this.#symmetric.mixKeyAndHash(this.#psk);
      return;
    }
    const mine = token[this.#initiator ? 0 : 1] === 'e' ? this.#e : this.#s;
    const theirs = token[this.#initiator ? 1 : 0] === 'e' ? this.#re : this.#rs;
    this.#symmetric.mixKey(x25519(mine.privateKey, theirs));
  }

  #advance() {
    this.#index += 1;
    if (this.#index === this.#pattern.messages.length) {
      this.#ciphers = this.#symmetric.split();
      this.#hash = this.#symmetric.getHandshakeHash();
      this.#discardSecrets();
    }
  }

  #fail() {
    this.#failed = true;
    this.#discardSecrets();
  }

  #discardSecrets() {
    for (const secret of [this.#s?.privateKey, this.#e?.privateKey, this.#psk]) wipe(secret);
    this.#s = null;
    this.#e = null;
    this.#psk = null;
    this.#symmetric = null;
  }
}

/** HKDF of section 4.3, in terms of HMAC. */
function hkdf(chainingKey, inputKeyMaterial, outputs) {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out = [hmacSha256(tempKey, Uint8Array.of(1))];
  for (let i = 2; i <= outputs; i += 1) out.push(hmacSha256(tempKey, out[out.length - 1], Uint8Array.of(i)));
  return out;
}

/** 32 zero bits, then the counter as 64 bits little-endian (section 12.3). */
function encodeNonce(counter) {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, counter, true);
  return nonce;
}

function receivedKey(bytes) {
  if (bytes.length !== DH_LENGTH || x25519HasSmallOrder(bytes)) {
    throw new AuthError('handshake message carries an unusable public key');
  }
  return Uint8Array.from(bytes);
}

function copyKeyPair(pair, name) {
  if (pair === null || typeof pair !== 'object') {
    throw new CryptoError(`${name} must be a { publicKey, privateKey } pair`);
  }
  const publicKey = Uint8Array.from(assertBytes(pair.publicKey, `${name} (public half)`, DH_LENGTH));
  const privateKey = Uint8Array.from(assertBytes(pair.privateKey, `${name} (private half)`, DH_LENGTH));
  if (!equalBytes(x25519PublicFromPrivate(privateKey), publicKey)) {
    throw new CryptoError(`${name}: the public half does not belong to the private half`);
  }
  return { publicKey, privateKey };
}

function lookupPattern(pattern) {
  if (typeof pattern !== 'string') throw new CryptoError('handshake pattern must be a string');
  const prefix = 'Noise_';
  const suffix = `_${SUITE}`;
  const name =
    pattern.startsWith(prefix) && pattern.endsWith(suffix)
      ? pattern.slice(prefix.length, pattern.length - suffix.length)
      : pattern;
  const compiled = PATTERNS.get(name);
  if (compiled === undefined) throw new CryptoError('unsupported Noise handshake pattern');
  return compiled;
}

function buildPatterns() {
  const patterns = new Map();
  for (const [name, [initiatorPre, responderPre, messages]] of Object.entries(FUNDAMENTAL)) {
    patterns.set(name, compilePattern(name, initiatorPre, responderPre, messages, false));
  }
  for (const name of PSK_VARIANTS) {
    const [, base, position] = /^([A-Z]+)psk(\d)$/.exec(name);
    const [initiatorPre, responderPre, baseMessages] = FUNDAMENTAL[base];
    const messages = baseMessages.map((tokens) => [...tokens]);
    if (position === '0') messages[0].unshift('psk');
    else messages[Number(position) - 1].push('psk');
    patterns.set(name, compilePattern(name, initiatorPre, responderPre, messages, true));
  }
  return patterns;
}

function compilePattern(name, initiatorPre, responderPre, messages, psk) {
  const sends = (parity) => messages.some((tokens, i) => i % 2 === parity && tokens.includes('s'));
  return Object.freeze({
    name,
    psk,
    oneWay: messages.length === 1,
    messages: Object.freeze(messages.map((tokens) => Object.freeze([...tokens]))),
    initiator: Object.freeze({ pre: Object.freeze([...initiatorPre]), usesStatic: initiatorPre.includes('s') || sends(0) }),
    responder: Object.freeze({ pre: Object.freeze([...responderPre]), usesStatic: responderPre.includes('s') || sends(1) }),
  });
}
