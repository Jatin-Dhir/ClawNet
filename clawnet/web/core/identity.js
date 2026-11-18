/**
 * Node identity for the web core: a port of the engine's `src/core/crypto/identity.js`.
 *
 * A node is three long-term keys: Ed25519 (identity), X25519 link and X25519 e2e. The
 * NodeId is the identity public key in lowercase unpadded base32; the identity card is the
 * identity key's signature over the two X25519 public keys, domain separated as
 * `utf8("clawnet/1/static-key-binding") || 0x00 || link || e2e`. Signed records sign
 * `utf8("clawnet/1/record/" + type) || 0x00 || canonical JSON without "sig"`.
 *
 * The verify functions take data straight from the network: they never throw.
 */

import { CryptoError } from '../../src/core/errors.js';
import { canonicalize } from '../../src/core/wire/canonical.js';
import { Domain, NODE_ID_PATTERN } from '../../src/core/wire/types.js';
import { concat, equalBytes, utf8 } from './bytes.js';
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
  x25519GenerateKeyPair,
  x25519PublicFromPrivate,
} from './primitives.js';

export const SHORT_ID_LENGTH = 8;
export const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const SHORT_ID_PLACEHOLDER = '?'.repeat(SHORT_ID_LENGTH);
const CARD_KEYS = Object.freeze(['id', 'link', 'e2e', 'sig']);
const RESERVED_RECORD_KEYS = Object.freeze(['type', 'origin', 'sig']);
const SEPARATOR = Uint8Array.of(0);
const FACTORY = Symbol('Identity.factory');

/** A node's long-term keys; the private halves live in private fields. */
export class Identity {
  #signSeed;
  #signPublic;
  #linkPrivate;
  #linkPublic;
  #e2ePrivate;
  #e2ePublic;
  #nodeId;
  #card;

  constructor(factory, secret) {
    if (factory !== FACTORY) throw new CryptoError('use Identity.generate() or Identity.fromSecret()');
    this.#signSeed = Uint8Array.from(secret.signSeed);
    this.#linkPrivate = Uint8Array.from(secret.linkPrivate);
    this.#e2ePrivate = Uint8Array.from(secret.e2ePrivate);
    this.#signPublic = ed25519PublicFromPrivate(this.#signSeed);
    this.#linkPublic = x25519PublicFromPrivate(this.#linkPrivate);
    this.#e2ePublic = x25519PublicFromPrivate(this.#e2ePrivate);
    this.#nodeId = base32Encode(this.#signPublic);
    const binding = withDomain(Domain.STATIC_KEY_BINDING, concat(this.#linkPublic, this.#e2ePublic));
    this.#card = Object.freeze({
      id: this.#nodeId,
      link: base64Encode(this.#linkPublic),
      e2e: base64Encode(this.#e2ePublic),
      sig: base64Encode(ed25519Sign(this.#signSeed, binding)),
    });
    Object.freeze(this);
  }

  /** @returns {Identity} three fresh, independent keys */
  static generate() {
    return new Identity(FACTORY, {
      signSeed: ed25519GenerateKeyPair().privateKey,
      linkPrivate: x25519GenerateKeyPair().privateKey,
      e2ePrivate: x25519GenerateKeyPair().privateKey,
    });
  }

  /**
   * @param {{ signSeed: Uint8Array, linkPrivate: Uint8Array, e2ePrivate: Uint8Array }} secret
   * @returns {Identity}
   */
  static fromSecret(secret) {
    if (secret === null || typeof secret !== 'object') {
      throw new CryptoError('identity secret must be an object holding three keys');
    }
    const { signSeed, linkPrivate, e2ePrivate } = secret;
    assertBytes(signSeed, 'signSeed', KEY_LENGTH);
    assertBytes(linkPrivate, 'linkPrivate', KEY_LENGTH);
    assertBytes(e2ePrivate, 'e2ePrivate', KEY_LENGTH);
    if (equalBytes(linkPrivate, e2ePrivate) || equalBytes(signSeed, linkPrivate) || equalBytes(signSeed, e2ePrivate)) {
      throw new CryptoError('identity keys must be three different keys');
    }
    return new Identity(FACTORY, { signSeed, linkPrivate, e2ePrivate });
  }

  /** @returns {{ signSeed: Uint8Array, linkPrivate: Uint8Array, e2ePrivate: Uint8Array }} copies */
  toSecret() {
    return {
      signSeed: Uint8Array.from(this.#signSeed),
      linkPrivate: Uint8Array.from(this.#linkPrivate),
      e2ePrivate: Uint8Array.from(this.#e2ePrivate),
    };
  }

  get nodeId() {
    return this.#nodeId;
  }

  get signPublicKey() {
    return Uint8Array.from(this.#signPublic);
  }

  /** Contains a private key. */
  get linkKeyPair() {
    return { publicKey: Uint8Array.from(this.#linkPublic), privateKey: Uint8Array.from(this.#linkPrivate) };
  }

  /** Contains a private key. */
  get e2eKeyPair() {
    return { publicKey: Uint8Array.from(this.#e2ePublic), privateKey: Uint8Array.from(this.#e2ePrivate) };
  }

  get card() {
    return this.#card;
  }

  /**
   * @param {string} domain
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} Ed25519 signature over `utf8(domain) || 0x00 || bytes`
   */
  sign(domain, bytes) {
    if (!isValidDomain(domain)) throw new CryptoError('signature domain must be a non-empty string without NUL characters');
    assertBytes(bytes, 'bytes to sign');
    return ed25519Sign(this.#signSeed, withDomain(domain, bytes));
  }

  /**
   * @param {string} type
   * @param {object} fields without `type`, `origin` or `sig`
   * @returns {Readonly<Record<string, unknown>>} the deep-frozen signed record
   */
  signRecord(type, fields) {
    if (typeof type !== 'string' || !RECORD_TYPE_PATTERN.test(type)) {
      throw new CryptoError('record type must be a short lowercase token');
    }
    if (!isPlainObject(fields)) throw new CryptoError('record fields must be a plain object');
    for (const key of RESERVED_RECORD_KEYS) {
      if (Object.hasOwn(fields, key)) throw new CryptoError(`record fields must not contain "${key}"`);
    }
    const text = canonicalize({ ...fields, type, origin: this.#nodeId });
    const signature = this.sign(Domain.RECORD_PREFIX + type, utf8(text));
    const record = JSON.parse(text);
    record.sig = base64Encode(signature);
    return deepFreeze(record);
  }

  toJSON() {
    return { nodeId: this.#nodeId, card: this.#card };
  }

  toString() {
    return `Identity(${this.#nodeId})`;
  }
}

/** @param {Uint8Array} publicKey @returns {string} */
export function publicKeyToNodeId(publicKey) {
  return base32Encode(assertBytes(publicKey, 'Ed25519 public key', KEY_LENGTH));
}

/** @param {string} nodeId @returns {Uint8Array} the Ed25519 public key */
export function nodeIdToPublicKey(nodeId) {
  if (!isValidNodeId(nodeId)) throw new CryptoError('not a valid NodeId');
  return base32Decode(nodeId);
}

/** @param {unknown} value @returns {boolean} 52 base32 characters, the canonical spelling */
export function isValidNodeId(value) {
  if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value)) return false;
  try {
    return base32Decode(value).length === KEY_LENGTH;
  } catch {
    return false;
  }
}

/** @returns {string} the first 8 characters of a NodeId, or "????????" */
export function shortId(nodeId) {
  return typeof nodeId === 'string' && NODE_ID_PATTERN.test(nodeId) ? nodeId.slice(0, SHORT_ID_LENGTH) : SHORT_ID_PLACEHOLDER;
}

/**
 * Verify an identity card. Same reasons as the engine's verifyCard.
 *
 * @returns {{ ok: true, nodeId: string, linkPublicKey: Uint8Array, e2ePublicKey: Uint8Array }
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
  const exactKeys = Object.keys(card).length === CARD_KEYS.length && CARD_KEYS.every((key) => Object.hasOwn(card, key));
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
  if (equalBytes(linkPublicKey, e2ePublicKey)) return rejected('key-reuse');
  const binding = withDomain(Domain.STATIC_KEY_BINDING, concat(linkPublicKey, e2ePublicKey));
  if (!ed25519Verify(base32Decode(card.id), binding, signature)) return rejected('bad-signature');
  return { ok: true, nodeId: card.id, linkPublicKey, e2ePublicKey };
}

/** @returns {boolean} whether `signature` is `nodeId`'s signature over `bytes` for `domain` */
export function verifySignature(nodeId, domain, bytes, signature) {
  if (!isValidNodeId(nodeId) || !isValidDomain(domain) || !(bytes instanceof Uint8Array)) return false;
  return ed25519Verify(base32Decode(nodeId), withDomain(domain, bytes), signature);
}

/** @returns {{ ok: true } | { ok: false, reason: string }} */
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
    bytes = utf8(canonicalize(unsigned));
  } catch {
    return rejected('not-canonical');
  }
  if (!ed25519Verify(base32Decode(origin), withDomain(Domain.RECORD_PREFIX + type, bytes), signature)) {
    return rejected('bad-signature');
  }
  return { ok: true };
}

function rejected(reason) {
  return { ok: false, reason };
}

function withDomain(domain, bytes) {
  return concat(utf8(domain), SEPARATOR, bytes);
}

function isValidDomain(domain) {
  return typeof domain === 'string' && domain.length > 0 && isWellFormed(domain) && !domain.includes('\x00');
}

/** String.prototype.isWellFormed, with a fallback for browsers that lack it. */
export function isWellFormed(text) {
  if (typeof text.isWellFormed === 'function') return text.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
