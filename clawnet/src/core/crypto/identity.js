/**
 * Node identity (DESIGN.md section 3).
 *
 * A node is three long-term keys: an Ed25519 identity key, an X25519 link key (the static
 * key of link handshakes) and an X25519 e2e key (the key end-to-end messages are sealed
 * to). The NodeId is the identity public key in base32, so every signature can be checked
 * from the id alone. The identity card is the identity key's signature over the two
 * X25519 keys; it is what lets a peer conclude "this Noise static key belongs to that
 * NodeId".
 *
 * Every signature made here is domain separated: the signed bytes are
 * `utf8(domain) || 0x00 || payload`, and a domain never contains a zero byte, so a
 * signature made for one purpose cannot be replayed as a signature for another.
 *
 * The verify* functions take data straight from the network. They never throw; they
 * report a reason instead.
 */

import { CryptoError } from '../errors.js';
import { canonicalBytes, canonicalize } from '../wire/canonical.js';
import { Domain, NODE_ID_PATTERN } from '../wire/types.js';
import {
  KEY_LENGTH,
  SIGNATURE_LENGTH,
  assertBytes,
  base32Decode,
  base32Encode,
  base64Decode,
  base64Encode,
  ed25519GenerateKeyPair,
  ed25519PublicFromPrivate,
  ed25519Sign,
  ed25519Verify,
  timingSafeEqual,
  x25519GenerateKeyPair,
  x25519PublicFromPrivate,
} from './primitives.js';

/** Characters of a NodeId that shortId() keeps. */
export const SHORT_ID_LENGTH = 8;

/**
 * Shape of a signed record's `type`. It becomes part of a signature domain, so it is kept
 * to a short lowercase token.
 */
export const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const SHORT_ID_PLACEHOLDER = '?'.repeat(SHORT_ID_LENGTH);
const CARD_KEYS = Object.freeze(['id', 'link', 'e2e', 'sig']);
const RESERVED_RECORD_KEYS = Object.freeze(['type', 'origin', 'sig']);
const SEPARATOR = Buffer.from([0]);

// Only the static factories may call the constructor.
const FACTORY = Symbol('Identity.factory');

/**
 * A node's long-term keys and everything that needs the private halves.
 *
 * The private keys live in private fields: they do not show up in util.inspect(),
 * JSON.stringify(), string conversion or error messages. They leave the object only
 * through toSecret(), linkKeyPair and e2eKeyPair, whose results the caller must treat as
 * secret.
 */
export class Identity {
  #signSeed;
  #signPublic;
  #linkPrivate;
  #linkPublic;
  #e2ePrivate;
  #e2ePublic;
  #nodeId;
  #card;

  /**
   * @param {symbol} factory internal; use Identity.generate() or Identity.fromSecret()
   * @param {{ signSeed: Uint8Array, linkPrivate: Uint8Array, e2ePrivate: Uint8Array }} secret
   * @throws {CryptoError} if called directly
   */
  constructor(factory, secret) {
    if (factory !== FACTORY) {
      throw new CryptoError('use Identity.generate() or Identity.fromSecret()');
    }
    this.#signSeed = Buffer.from(secret.signSeed);
    this.#linkPrivate = Buffer.from(secret.linkPrivate);
    this.#e2ePrivate = Buffer.from(secret.e2ePrivate);
    this.#signPublic = ed25519PublicFromPrivate(this.#signSeed);
    this.#linkPublic = x25519PublicFromPrivate(this.#linkPrivate);
    this.#e2ePublic = x25519PublicFromPrivate(this.#e2ePrivate);
    this.#nodeId = base32Encode(this.#signPublic);
    const binding = withDomain(
      Domain.STATIC_KEY_BINDING,
      Buffer.concat([this.#linkPublic, this.#e2ePublic])
    );
    this.#card = Object.freeze({
      id: this.#nodeId,
      link: base64Encode(this.#linkPublic),
      e2e: base64Encode(this.#e2ePublic),
      sig: base64Encode(ed25519Sign(this.#signSeed, binding)),
    });
    Object.freeze(this);
  }

  /**
   * Create an identity with three fresh, independent keys.
   *
   * @returns {Identity}
   */
  static generate() {
    return new Identity(FACTORY, {
      signSeed: ed25519GenerateKeyPair().privateKey,
      linkPrivate: x25519GenerateKeyPair().privateKey,
      e2ePrivate: x25519GenerateKeyPair().privateKey,
    });
  }

  /**
   * Restore an identity from its three private keys, as returned by toSecret().
   *
   * @param {object} secret
   * @param {Uint8Array} secret.signSeed    32-byte Ed25519 seed
   * @param {Uint8Array} secret.linkPrivate 32-byte X25519 private key for link handshakes
   * @param {Uint8Array} secret.e2ePrivate  32-byte X25519 private key for end-to-end messages
   * @returns {Identity}
   * @throws {CryptoError} if a key is missing or not 32 bytes, or two of them are the same
   *   bytes (one key per protocol, DESIGN.md section 3)
   */
  static fromSecret(secret) {
    if (secret === null || typeof secret !== 'object') {
      throw new CryptoError('identity secret must be an object holding three keys');
    }
    const { signSeed, linkPrivate, e2ePrivate } = secret;
    assertBytes(signSeed, 'signSeed', KEY_LENGTH);
    assertBytes(linkPrivate, 'linkPrivate', KEY_LENGTH);
    assertBytes(e2ePrivate, 'e2ePrivate', KEY_LENGTH);
    if (
      timingSafeEqual(linkPrivate, e2ePrivate) ||
      timingSafeEqual(signSeed, linkPrivate) ||
      timingSafeEqual(signSeed, e2ePrivate)
    ) {
      throw new CryptoError('identity keys must be three different keys');
    }
    return new Identity(FACTORY, { signSeed, linkPrivate, e2ePrivate });
  }

  /**
   * The three private keys, for storage. Whoever holds them is this node.
   *
   * @returns {{ signSeed: Buffer, linkPrivate: Buffer, e2ePrivate: Buffer }} fresh copies,
   *   32 bytes each
   */
  toSecret() {
    return {
      signSeed: Buffer.from(this.#signSeed),
      linkPrivate: Buffer.from(this.#linkPrivate),
      e2ePrivate: Buffer.from(this.#e2ePrivate),
    };
  }

  /** @returns {string} this node's NodeId, 52 base32 characters */
  get nodeId() {
    return this.#nodeId;
  }

  /** @returns {Buffer} the 32-byte Ed25519 identity public key (a copy) */
  get signPublicKey() {
    return Buffer.from(this.#signPublic);
  }

  /**
   * The X25519 static key pair for link handshakes. Contains a private key.
   *
   * @returns {{ publicKey: Buffer, privateKey: Buffer }} fresh copies
   */
  get linkKeyPair() {
    return { publicKey: Buffer.from(this.#linkPublic), privateKey: Buffer.from(this.#linkPrivate) };
  }

  /**
   * The X25519 static key pair for end-to-end messages. Contains a private key.
   *
   * @returns {{ publicKey: Buffer, privateKey: Buffer }} fresh copies
   */
  get e2eKeyPair() {
    return { publicKey: Buffer.from(this.#e2ePublic), privateKey: Buffer.from(this.#e2ePrivate) };
  }

  /**
   * The identity card: `{ id, link, e2e, sig }`, binding both X25519 public keys to the
   * NodeId. Public; send it to peers.
   *
   * @returns {Readonly<{ id: string, link: string, e2e: string, sig: string }>} frozen
   */
  get card() {
    return this.#card;
  }

  /**
   * Sign bytes for one purpose.
   *
   * @param {string} domain what the signature is for, e.g. a `Domain` constant; non-empty,
   *   well-formed, without U+0000
   * @param {Uint8Array} bytes
   * @returns {Buffer} 64-byte Ed25519 signature over `utf8(domain) || 0x00 || bytes`
   * @throws {CryptoError} if the domain is not usable or `bytes` is not a byte array
   */
  sign(domain, bytes) {
    if (!isValidDomain(domain)) {
      throw new CryptoError('signature domain must be a non-empty string without NUL characters');
    }
    assertBytes(bytes, 'bytes to sign');
    return ed25519Sign(this.#signSeed, withDomain(domain, bytes));
  }

  /**
   * Build a signed record: `fields` plus `type`, `origin` (this NodeId) and `sig`.
   *
   * The result is a deep-frozen copy holding exactly the values that were signed, so a
   * record cannot drift away from its signature after the fact.
   *
   * @param {string} type    record type, matching RECORD_TYPE_PATTERN
   * @param {object} fields  plain object; must not contain `type`, `origin` or `sig`
   * @returns {Readonly<Record<string, unknown>>}
   * @throws {CryptoError} if the type or the fields object is not acceptable
   * @throws {import('../errors.js').CanonicalError} if a field has no canonical JSON form
   */
  signRecord(type, fields) {
    if (typeof type !== 'string' || !RECORD_TYPE_PATTERN.test(type)) {
      throw new CryptoError('record type must be a short lowercase token');
    }
    if (!isPlainObject(fields)) throw new CryptoError('record fields must be a plain object');
    for (const key of RESERVED_RECORD_KEYS) {
      if (Object.hasOwn(fields, key)) {
        throw new CryptoError(`record fields must not contain "${key}": it is set when signing`);
      }
    }
    const text = canonicalize({ ...fields, type, origin: this.#nodeId });
    const signature = this.sign(Domain.RECORD_PREFIX + type, Buffer.from(text, 'utf8'));
    // Re-parsing the signed text yields a private copy with nothing but plain JSON values.
    const record = JSON.parse(text);
    record.sig = base64Encode(signature);
    return deepFreeze(record);
  }

  /** @returns {{ nodeId: string, card: object }} public information only */
  toJSON() {
    return { nodeId: this.#nodeId, card: this.#card };
  }

  /** @returns {string} */
  toString() {
    return `Identity(${this.#nodeId})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Identity <${this.#nodeId.slice(0, SHORT_ID_LENGTH)}>`;
  }
}

/**
 * NodeId of an Ed25519 public key.
 *
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {string} 52 lowercase base32 characters
 * @throws {CryptoError} if the key is not 32 bytes
 */
export function publicKeyToNodeId(publicKey) {
  return base32Encode(assertBytes(publicKey, 'Ed25519 public key', KEY_LENGTH));
}

/**
 * Ed25519 public key of a NodeId.
 *
 * @param {string} nodeId
 * @returns {Buffer} 32 bytes
 * @throws {CryptoError} if the value is not a valid NodeId
 */
export function nodeIdToPublicKey(nodeId) {
  if (!isValidNodeId(nodeId)) throw new CryptoError('not a valid NodeId');
  return base32Decode(nodeId);
}

/**
 * Whether a value is a valid NodeId: 52 base32 characters that are the one canonical
 * encoding of 32 bytes (DESIGN.md 15.1).
 *
 * 52 characters carry 260 bits, so without a rule 16 strings would name every key and any
 * check done on the string (blocklist, self-connection, tie-break) could be dodged by
 * respelling it. NODE_ID_PATTERN demands that the last character be "a" or "q", which is
 * exactly "the four unused bits are zero"; the strict decode is checked as well, so the
 * two rules cannot drift apart unnoticed.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidNodeId(value) {
  if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value)) return false;
  try {
    return base32Decode(value).length === KEY_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Abbreviated NodeId for logs and displays. Not an identifier: never compare short ids.
 *
 * Anything that is not a valid NodeId (non-canonical spellings included) is masked, so
 * arbitrary peer-supplied text never reaches a log line.
 *
 * @param {unknown} nodeId
 * @returns {string} the first 8 characters, or "????????" if the value is not a NodeId
 */
export function shortId(nodeId) {
  return typeof nodeId === 'string' && NODE_ID_PATTERN.test(nodeId)
    ? nodeId.slice(0, SHORT_ID_LENGTH)
    : SHORT_ID_PLACEHOLDER;
}

/**
 * Verify an identity card received from a peer.
 *
 * Reasons: "not-an-object", "bad-shape" (not exactly id, link, e2e, sig), "bad-id",
 * "bad-encoding", "key-reuse" (link and e2e are the same key), "bad-signature",
 * "malformed" (the object could not even be read).
 *
 * @param {unknown} card
 * @returns {{ ok: true, nodeId: string, linkPublicKey: Buffer, e2ePublicKey: Buffer }
 *   | { ok: false, reason: string }}
 */
export function verifyCard(card) {
  try {
    return checkCard(card);
  } catch {
    return rejected('malformed');
  }
}

function checkCard(card) {
  if (!isPlainObject(card)) return rejected('not-an-object');
  // Fields outside the signature would be attacker-controlled baggage on a trusted object.
  const exactKeys =
    Object.keys(card).length === CARD_KEYS.length &&
    CARD_KEYS.every(key => Object.hasOwn(card, key));
  if (!exactKeys) return rejected('bad-shape');
  if (!isValidNodeId(card.id)) return rejected('bad-id');
  let linkPublicKey;
  let e2ePublicKey;
  let signature;
  try {
    linkPublicKey = base64Decode(card.link, KEY_LENGTH);
    e2ePublicKey = base64Decode(card.e2e, KEY_LENGTH);
    signature = base64Decode(card.sig, SIGNATURE_LENGTH);
  } catch {
    return rejected('bad-encoding');
  }
  if (linkPublicKey.equals(e2ePublicKey)) return rejected('key-reuse');
  const binding = withDomain(
    Domain.STATIC_KEY_BINDING,
    Buffer.concat([linkPublicKey, e2ePublicKey])
  );
  if (!ed25519Verify(base32Decode(card.id), binding, signature)) return rejected('bad-signature');
  return { ok: true, nodeId: card.id, linkPublicKey, e2ePublicKey };
}

/**
 * Verify a domain-separated signature made by Identity#sign(). Never throws.
 *
 * @param {unknown} nodeId    the signer
 * @param {unknown} domain    the purpose the signature must have been made for
 * @param {unknown} bytes     the signed payload (Uint8Array)
 * @param {unknown} signature 64 bytes (Uint8Array)
 * @returns {boolean}
 */
export function verifySignature(nodeId, domain, bytes, signature) {
  if (!isValidNodeId(nodeId) || !isValidDomain(domain) || !(bytes instanceof Uint8Array)) {
    return false;
  }
  return ed25519Verify(base32Decode(nodeId), withDomain(domain, bytes), signature);
}

/**
 * Verify a signed record received from the network.
 *
 * Checks the type, that `origin` is a valid NodeId, that `sig` decodes to exactly 64
 * bytes, and the signature over
 * `utf8(Domain.RECORD_PREFIX + type) || 0x00 || canonicalBytes(record without sig)`.
 *
 * Reasons: "not-an-object", "bad-type", "wrong-type" (not `expectedType`), "bad-origin",
 * "bad-sig-encoding", "not-canonical" (a value canonical JSON cannot represent),
 * "bad-signature", "malformed" (the object could not even be read).
 *
 * @param {unknown} record
 * @param {string} [expectedType] if given, the record's type must be exactly this
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyRecord(record, expectedType) {
  try {
    return checkRecord(record, expectedType);
  } catch {
    return rejected('malformed');
  }
}

function checkRecord(record, expectedType) {
  if (!isPlainObject(record)) return rejected('not-an-object');
  const { sig, ...unsigned } = record;
  const { type, origin } = unsigned;
  if (typeof type !== 'string' || !RECORD_TYPE_PATTERN.test(type)) return rejected('bad-type');
  if (expectedType !== undefined && type !== expectedType) return rejected('wrong-type');
  if (!isValidNodeId(origin)) return rejected('bad-origin');
  let signature;
  try {
    signature = base64Decode(sig, SIGNATURE_LENGTH);
  } catch {
    return rejected('bad-sig-encoding');
  }
  let bytes;
  try {
    bytes = canonicalBytes(unsigned);
  } catch {
    return rejected('not-canonical');
  }
  const message = withDomain(Domain.RECORD_PREFIX + type, bytes);
  if (!ed25519Verify(base32Decode(origin), message, signature)) return rejected('bad-signature');
  return { ok: true };
}

function rejected(reason) {
  return { ok: false, reason };
}

/** The bytes that are actually signed: `utf8(domain) || 0x00 || bytes`. */
function withDomain(domain, bytes) {
  return Buffer.concat([Buffer.from(domain, 'utf8'), SEPARATOR, bytes]);
}

/**
 * A domain may not contain U+0000, or ("a", "b\0c") and ("a\0b", "c") would sign the same
 * bytes; and it must be well-formed, or two different strings could encode to the same
 * UTF-8.
 */
function isValidDomain(domain) {
  return (
    typeof domain === 'string' &&
    domain.length > 0 &&
    domain.isWellFormed() &&
    !domain.includes('\x00')
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
