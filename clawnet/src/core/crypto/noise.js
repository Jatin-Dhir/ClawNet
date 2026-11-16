/**
 * The Noise Protocol Framework, revision 34 (https://noiseprotocol.org/noise.html), for
 * one cipher suite: DH = 25519, cipher = ChaChaPoly, hash = SHA256.
 *
 * The three objects of the specification are implemented as it defines them (section 5):
 * CipherState, SymmetricState and HandshakeState. Handshake patterns are data, not code:
 * each one is a table of tokens (section 7) and one engine interprets every token for
 * both roles. Names used below (MixKey, MixHash, Split, ...) are the specification's.
 *
 * Supported patterns are the fundamental one-way and interactive patterns of sections 7.4
 * and 7.5, the pre-shared-key patterns section 9.4 lists, and XXpsk0. Every one of them
 * except XXpsk0 is checked against published test vectors from independent
 * implementations (test/vectors/NOISE-VECTORS.md). Neither vector source publishes
 * XXpsk0; it is built from the same tokens and the same psk rules (section 9) that the
 * vectors for NNpsk0, KKpsk0 and XXpsk3 do verify, and NOISE-VECTORS.md says so.
 *
 * ClawNet uses XX and XXpsk0 for links (DESIGN.md 15.4) and X for end-to-end messages.
 *
 * Where the specification leaves a choice (section 12.1), the strict one is taken: a public
 * key of small order is refused instead of being allowed to produce an all-zero DH output,
 * so no key is ever derived from a value that does not depend on the private keys.
 *
 * Errors: local misuse throws CryptoError (bad argument) or StateError (wrong moment);
 * anything wrong with a received message throws AuthError.
 */

import { AuthError, CryptoError, StateError } from '../errors.js';
import {
  AEAD_TAG_LENGTH,
  HASH_LENGTH,
  KEY_LENGTH,
  aeadDecrypt,
  aeadEncrypt,
  assertBytes,
  hmacSha256,
  sha256,
  timingSafeEqual,
  x25519,
  x25519GenerateKeyPair,
  x25519HasSmallOrder,
  x25519PublicFromPrivate,
} from './primitives.js';

/** Largest Noise message in bytes, handshake or transport (specification section 3). */
export const NOISE_MAX_MESSAGE = 65535;

/** Largest plaintext one transport message can carry: the limit less the tag. */
export const NOISE_MAX_PLAINTEXT = NOISE_MAX_MESSAGE - AEAD_TAG_LENGTH;

const SUITE = '25519_ChaChaPoly_SHA256';
const DH_LENGTH = KEY_LENGTH;
const EMPTY = Buffer.alloc(0);
const ZEROS = Buffer.alloc(KEY_LENGTH);
// 2^64 - 1 never encrypts a message: Rekey() uses it (section 4.2).
const MAX_NONCE = 0xffffffffffffffffn;

/**
 * Fundamental patterns, transcribed from sections 7.4 and 7.5.
 * Each entry: [initiator pre-message, responder pre-message, messages]. Messages alternate
 * direction starting with the initiator.
 */
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

/**
 * Pre-shared-key patterns: the ones the specification lists as recommended (section 9.4),
 * plus XXpsk0. ClawNet's private networks use XXpsk0 (DESIGN.md 15.4) because it mixes
 * the key in before anything else, so a responder rejects a non-member's first message
 * before doing any Diffie-Hellman work for it or sending it anything.
 */
const PSK_VARIANTS = [
  'Npsk0', 'Kpsk0', 'Xpsk1',
  'NNpsk0', 'NNpsk2', 'NKpsk0', 'NKpsk2', 'NXpsk2',
  'XNpsk3', 'XKpsk3', 'XXpsk0', 'XXpsk3',
  'KNpsk0', 'KNpsk2', 'KKpsk0', 'KKpsk2', 'KXpsk2',
  'INpsk1', 'INpsk2', 'IKpsk1', 'IKpsk2', 'IXpsk2',
];

const PATTERNS = buildPatterns();

/** Names of every handshake pattern this module accepts, e.g. "XX", "XXpsk0", "X". */
export const NOISE_PATTERNS = Object.freeze([...PATTERNS.keys()]);

/**
 * Full Noise protocol name for a handshake pattern.
 *
 * @param {string} pattern a pattern name such as "XX" or "XXpsk3", or an already complete
 *   protocol name such as "Noise_XX_25519_ChaChaPoly_SHA256"
 * @returns {string} e.g. "Noise_XXpsk3_25519_ChaChaPoly_SHA256"
 * @throws {CryptoError} if the pattern is not supported
 */
export function protocolName(pattern) {
  return `Noise_${lookupPattern(pattern).name}_${SUITE}`;
}

/**
 * A key and a nonce counter for one direction of traffic (specification section 5.1).
 *
 * As the specification requires, a CipherState without a key passes data through
 * unchanged; the handshake relies on that before its first key agreement. split() only
 * ever returns CipherStates that have a key. Check hasKey() before using one built by
 * hand.
 */
export class CipherState {
  #key = null;
  #nonce = 0n;

  /**
   * @param {Uint8Array} [key] 32-byte key; omit for a CipherState with no key
   * @throws {CryptoError} if the key is not 32 bytes
   */
  constructor(key) {
    if (key !== undefined) this.#key = Buffer.from(assertBytes(key, 'cipher key', KEY_LENGTH));
  }

  /** @returns {boolean} whether a key is set */
  hasKey() {
    return this.#key !== null;
  }

  /** @returns {bigint} the nonce the next message will use */
  get nonce() {
    return this.#nonce;
  }

  /**
   * Set the nonce of the next message. Reusing a nonce with the same key destroys
   * confidentiality; this exists for protocols that carry explicit nonces.
   *
   * @param {bigint | number} nonce integer from 0 to 2^64 - 1
   * @throws {CryptoError} if the value is not an integer in range
   */
  setNonce(nonce) {
    const value = typeof nonce === 'number' && Number.isSafeInteger(nonce) ? BigInt(nonce) : nonce;
    if (typeof value !== 'bigint' || value < 0n || value > MAX_NONCE) {
      throw new CryptoError('nonce must be an integer from 0 to 2^64 - 1');
    }
    this.#nonce = value;
  }

  /**
   * EncryptWithAd: encrypt and authenticate under the current nonce, then increment it.
   *
   * @param {Uint8Array} ad        associated data
   * @param {Uint8Array} plaintext at most NOISE_MAX_PLAINTEXT bytes when a key is set
   * @returns {Buffer} ciphertext and 16-byte tag, or a copy of the plaintext when no key is set
   * @throws {CryptoError} if an argument is not a byte array or the message would exceed
   *   NOISE_MAX_MESSAGE
   * @throws {StateError} if the nonce counter is exhausted
   */
  encryptWithAd(ad, plaintext) {
    assertBytes(ad, 'associated data');
    assertBytes(plaintext, 'plaintext');
    const overhead = this.#key === null ? 0 : AEAD_TAG_LENGTH;
    if (plaintext.length + overhead > NOISE_MAX_MESSAGE) {
      throw new CryptoError(`Noise message would exceed ${NOISE_MAX_MESSAGE} bytes`);
    }
    if (this.#key === null) return Buffer.from(plaintext);
    this.#requireNonce();
    const ciphertext = aeadEncrypt(this.#key, encodeNonce(this.#nonce), ad, plaintext);
    this.#nonce += 1n;
    return ciphertext;
  }

  /**
   * DecryptWithAd: verify and decrypt under the current nonce, then increment it. On
   * failure the nonce is left unchanged, as the specification requires.
   *
   * @param {Uint8Array} ad
   * @param {Uint8Array} ciphertext
   * @returns {Buffer} plaintext
   * @throws {CryptoError} if an argument is not a byte array
   * @throws {AuthError} if the message is oversized or does not authenticate
   * @throws {StateError} if the nonce counter is exhausted
   */
  decryptWithAd(ad, ciphertext) {
    assertBytes(ad, 'associated data');
    assertBytes(ciphertext, 'ciphertext');
    if (ciphertext.length > NOISE_MAX_MESSAGE) {
      throw new AuthError(`Noise message exceeds ${NOISE_MAX_MESSAGE} bytes`);
    }
    if (this.#key === null) return Buffer.from(ciphertext);
    this.#requireNonce();
    const plaintext = aeadDecrypt(this.#key, encodeNonce(this.#nonce), ad, ciphertext);
    this.#nonce += 1n;
    return plaintext;
  }

  /**
   * Rekey: replace the key with one derived from it (section 4.2). The nonce is not
   * changed. Both ends of a direction must call this at the same point in the stream.
   *
   * @throws {StateError} if no key is set
   */
  rekey() {
    if (this.#key === null) throw new StateError('cannot rekey a cipher that has no key');
    const next = aeadEncrypt(this.#key, encodeNonce(MAX_NONCE), EMPTY, ZEROS);
    this.#key = Buffer.from(next.subarray(0, KEY_LENGTH));
  }

  #requireNonce() {
    if (this.#nonce === MAX_NONCE) {
      throw new StateError('nonce counter exhausted: this cipher can process no more messages');
    }
  }
}

/** Chaining key, handshake hash and the handshake's CipherState (section 5.2). */
class SymmetricState {
  #ck;
  #h;
  #cipher = new CipherState();

  /** InitializeSymmetric. @param {string} name full protocol name */
  constructor(name) {
    const bytes = Buffer.from(name, 'ascii');
    this.#h =
      bytes.length <= HASH_LENGTH
        ? Buffer.concat([bytes, Buffer.alloc(HASH_LENGTH - bytes.length)])
        : sha256(bytes);
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
    return Buffer.from(this.#h);
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

/**
 * One party's side of a Noise handshake (specification section 5.3).
 *
 * Call writeMessage() and readMessage() in the order the pattern dictates until
 * isComplete, then split() once to obtain the transport ciphers.
 */
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
   * @param {object} options
   * @param {string} options.pattern   pattern name ("XX", "XXpsk3", "X", ...) or full protocol name
   * @param {boolean} options.initiator true for the party that sends the first message
   * @param {Uint8Array} options.prologue data both parties must agree on; may be empty
   * @param {{ publicKey: Uint8Array, privateKey: Uint8Array }} [options.s] local static key
   *   pair; required exactly when the pattern uses one for this role
   * @param {{ publicKey: Uint8Array, privateKey: Uint8Array }} [options.e] fixed ephemeral
   *   key pair. FOR TEST VECTORS ONLY: an ephemeral key that is ever used twice voids the
   *   security of the handshake. Leave unset and a fresh one is generated.
   * @param {Uint8Array} [options.rs]  remote static public key; required exactly when the
   *   pattern says this role knows it in advance
   * @param {Uint8Array} [options.re]  not accepted: no supported pattern has a remote
   *   ephemeral pre-message
   * @param {Uint8Array} [options.psk] 32-byte pre-shared key; required exactly for psk patterns
   * @throws {CryptoError} if the pattern is unsupported or an option is missing, superfluous
   *   or malformed, or `rs` is a public key of small order
   */
  constructor({ pattern, initiator, prologue, s, e, rs, re, psk } = {}) {
    const compiled = lookupPattern(pattern);
    if (typeof initiator !== 'boolean') throw new CryptoError('initiator must be a boolean');
    assertBytes(prologue, 'prologue');
    const self = initiator ? compiled.initiator : compiled.responder;
    const peer = initiator ? compiled.responder : compiled.initiator;

    // An option the pattern does not use is refused rather than ignored: a caller who
    // passes `rs` to XX believes the peer is pinned, and it would not be.
    if (self.usesStatic) {
      if (s == null) throw new CryptoError(`pattern ${compiled.name} needs a local static key`);
      this.#s = copyKeyPair(s, 'local static key');
    } else if (s != null) {
      throw new CryptoError(`pattern ${compiled.name} has no local static key for this role`);
    }
    if (e != null) this.#e = copyKeyPair(e, 'local ephemeral key');
    if (peer.pre.includes('s')) {
      if (rs == null) throw new CryptoError(`pattern ${compiled.name} needs the remote static key`);
      this.#rs = Buffer.from(assertBytes(rs, 'remote static key', DH_LENGTH));
      if (x25519HasSmallOrder(this.#rs)) {
        throw new CryptoError('remote static key is not a usable public key');
      }
    } else if (rs != null) {
      throw new CryptoError(`pattern ${compiled.name} does not take a remote static key`);
    }
    if (re != null) throw new CryptoError('a remote ephemeral key cannot be supplied in advance');
    if (compiled.psk) {
      if (psk == null) throw new CryptoError(`pattern ${compiled.name} needs a pre-shared key`);
      this.#psk = Buffer.from(assertBytes(psk, 'pre-shared key', KEY_LENGTH));
    } else if (psk != null) {
      throw new CryptoError(`pattern ${compiled.name} does not use a pre-shared key`);
    }

    this.#pattern = compiled;
    this.#initiator = initiator;
    this.#symmetric = new SymmetricState(`Noise_${compiled.name}_${SUITE}`);
    this.#symmetric.mixHash(prologue);
    // Pre-message keys are hashed initiator first (section 5.3). Only "s" occurs.
    if (compiled.initiator.pre.length > 0) {
      this.#symmetric.mixHash(initiator ? this.#s.publicKey : this.#rs);
    }
    if (compiled.responder.pre.length > 0) {
      this.#symmetric.mixHash(initiator ? this.#rs : this.#s.publicKey);
    }
  }

  /** @returns {boolean} true once the last handshake message has been written or read */
  get isComplete() {
    return this.#hash !== null;
  }

  /**
   * The peer's static public key, or null while it is not known (or after a failure).
   *
   * A key received during the handshake is available as soon as the message carrying it
   * has been read successfully. Whether that key belongs to who the peer claims to be is
   * for the caller to decide (ClawNet checks it against a signed identity card).
   *
   * @returns {Buffer | null} 32 bytes
   */
  get remoteStaticKey() {
    return this.#rs === null || this.#failed ? null : Buffer.from(this.#rs);
  }

  /**
   * The handshake hash `h`: a value both parties share that is unique to this session
   * (section 11.2).
   *
   * @returns {Buffer} 32 bytes
   * @throws {StateError} if the handshake is not complete
   */
  get handshakeHash() {
    if (this.#hash === null) throw new StateError('handshake is not complete');
    return Buffer.from(this.#hash);
  }

  /**
   * Produce the next handshake message.
   *
   * @param {Uint8Array} [payload] application data to carry; whether it is encrypted, and
   *   how strongly, depends on the pattern and the message (section 7.7)
   * @returns {Buffer} the message, at most NOISE_MAX_MESSAGE bytes
   * @throws {StateError} if it is not this party's turn, or the handshake is finished or failed
   * @throws {CryptoError} if the payload is not a byte array or is too large; neither
   *   changes any state. Remote public keys are checked when they arrive, so nothing a peer
   *   sent can make this method throw; should the crypto provider itself fail, that error
   *   is passed on and the object is unusable afterwards
   */
  writeMessage(payload = EMPTY) {
    assertBytes(payload, 'payload');
    const tokens = this.#nextTokens(true);
    // Checked before any state changes, so an oversized payload does not burn the handshake.
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
      return Buffer.concat(parts);
    } catch (err) {
      this.#fail();
      throw err;
    }
  }

  /**
   * Consume the peer's next handshake message.
   *
   * @param {Uint8Array} message
   * @returns {Buffer} the payload it carried
   * @throws {StateError} if it is not the peer's turn, or the handshake is finished or failed
   * @throws {CryptoError} if the message is not a byte array
   * @throws {AuthError} if the message is truncated, oversized, carries an unusable public
   *   key or does not authenticate; the object is unusable afterwards
   */
  readMessage(message) {
    assertBytes(message, 'message');
    const tokens = this.#nextTokens(false);
    try {
      if (message.length > NOISE_MAX_MESSAGE) {
        throw new AuthError(`handshake message exceeds ${NOISE_MAX_MESSAGE} bytes`);
      }
      if (message.length < this.#overhead(tokens)) {
        throw new AuthError('handshake message is truncated');
      }
      let offset = 0;
      for (const token of tokens) {
        if (token === 'e') {
          this.#re = receivedKey(message.subarray(offset, offset + DH_LENGTH));
          offset += DH_LENGTH;
          this.#mixEphemeral(this.#re);
        } else if (token === 's') {
          const length = DH_LENGTH + (this.#symmetric.hasKey() ? AEAD_TAG_LENGTH : 0);
          const sealed = message.subarray(offset, offset + length);
          this.#rs = receivedKey(this.#symmetric.decryptAndHash(sealed));
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
      // Everything that can go wrong here was caused by the bytes the peer sent.
      if (err instanceof AuthError) throw err;
      throw new AuthError('handshake message rejected', { cause: err });
    }
  }

  /**
   * Split: hand over the two transport ciphers. Callable once, so that two copies of the
   * same key and nonce counter can never exist.
   *
   * After a one-way pattern only the initiator may send (section 7.4): the initiator gets
   * `rx: null` and the responder gets `tx: null`.
   *
   * @returns {{ tx: CipherState | null, rx: CipherState | null }} `tx` encrypts what this
   *   party sends, `rx` decrypts what it receives
   * @throws {StateError} if the handshake is not complete or split() was already called
   */
  split() {
    if (this.#ciphers === null) {
      throw new StateError(
        this.#hash === null ? 'handshake is not complete' : 'split() was already called'
      );
    }
    const [first, second] = this.#ciphers;
    this.#ciphers = null;
    // The first cipher carries initiator-to-responder traffic (section 5.3).
    const tx = this.#initiator ? first : second;
    const rx = this.#initiator ? second : first;
    if (!this.#pattern.oneWay) return { tx, rx };
    return this.#initiator ? { tx, rx: null } : { tx: null, rx };
  }

  /** Token list of the message due now; enforces order. */
  #nextTokens(writing) {
    if (this.#failed) throw new StateError('handshake has failed and cannot be used again');
    if (this.isComplete) throw new StateError('handshake is already complete');
    const initiatorsTurn = this.#index % 2 === 0;
    if ((initiatorsTurn === this.#initiator) !== writing) {
      throw new StateError(
        writing
          ? 'out of turn: the next handshake message must be read, not written'
          : 'out of turn: the next handshake message must be written, not read'
      );
    }
    return this.#pattern.messages[this.#index];
  }

  /**
   * Bytes a message adds around its payload: public keys and tags. Follows the same rule
   * as the engine (a tag appears once a key exists) without touching any state.
   */
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
    // Section 9.2: with any psk modifier, wherever it sits, every "e" token is followed by
    // MixKey(e.public_key). Without it, a psk0 handshake would encrypt each session's first
    // payload under a key and nonce that depend on the psk alone.
    if (this.#pattern.psk) this.#symmetric.mixKey(publicKey);
  }

  /** The "ee", "es", "se", "ss" and "psk" tokens: identical for reading and writing. */
  #mixSecret(token) {
    if (token === 'psk') {
      this.#symmetric.mixKeyAndHash(this.#psk);
      return;
    }
    // In a token the first letter is the initiator's key, the second the responder's.
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

  /**
   * Drop the handshake's own copies of secret keys as soon as they have no further use.
   * Best effort only: JavaScript cannot guarantee that no other copy remains in memory.
   */
  #discardSecrets() {
    for (const secret of [this.#s?.privateKey, this.#e?.privateKey, this.#psk]) secret?.fill(0);
    this.#s = null;
    this.#e = null;
    this.#psk = null;
    this.#symmetric = null;
  }
}

/**
 * HKDF as section 4.3 defines it, in terms of HMAC. (It equals RFC 5869 with the chaining
 * key as salt and an empty info.)
 */
function hkdf(chainingKey, inputKeyMaterial, outputs) {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out = [hmacSha256(tempKey, Buffer.from([1]))];
  for (let i = 2; i <= outputs; i += 1) {
    out.push(hmacSha256(tempKey, out[out.length - 1], Buffer.from([i])));
  }
  return out;
}

/** ChaChaPoly nonce: 32 zero bits, then the counter as 64 bits little-endian (section 12.3). */
function encodeNonce(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 4);
  return nonce;
}

/**
 * A public key taken from a handshake message. A key of small order is refused here, in
 * the message that carried it, and not at the key agreement that would fail on it later:
 * that agreement can be part of this party's own next message, where the failure would no
 * longer look like something the peer did.
 */
function receivedKey(bytes) {
  if (x25519HasSmallOrder(bytes)) {
    throw new AuthError('handshake message carries an unusable public key');
  }
  return Buffer.from(bytes);
}

function copyKeyPair(pair, name) {
  if (pair === null || typeof pair !== 'object') {
    throw new CryptoError(`${name} must be a { publicKey, privateKey } pair`);
  }
  const publicKey = Buffer.from(assertBytes(pair.publicKey, `${name} (public half)`, DH_LENGTH));
  const privateKey = Buffer.from(assertBytes(pair.privateKey, `${name} (private half)`, DH_LENGTH));
  // A mismatched pair would produce a handshake only the wrong key could complete.
  if (!timingSafeEqual(x25519PublicFromPrivate(privateKey), publicKey)) {
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
    const messages = baseMessages.map(tokens => [...tokens]);
    // psk0 goes first in the first message; pskN goes last in the Nth (section 9.4).
    if (position === '0') messages[0].unshift('psk');
    else messages[Number(position) - 1].push('psk');
    patterns.set(name, compilePattern(name, initiatorPre, responderPre, messages, true));
  }
  return patterns;
}

function compilePattern(name, initiatorPre, responderPre, messages, psk) {
  const sends = parity => messages.some((tokens, i) => i % 2 === parity && tokens.includes('s'));
  return Object.freeze({
    name,
    psk,
    // One-way patterns (section 7.4) are exactly the ones with a single message.
    oneWay: messages.length === 1,
    messages: Object.freeze(messages.map(tokens => Object.freeze([...tokens]))),
    initiator: Object.freeze({
      pre: Object.freeze([...initiatorPre]),
      usesStatic: initiatorPre.includes('s') || sends(0),
    }),
    responder: Object.freeze({
      pre: Object.freeze([...responderPre]),
      usesStatic: responderPre.includes('s') || sends(1),
    }),
  });
}
