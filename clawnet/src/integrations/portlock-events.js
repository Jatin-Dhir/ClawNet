/**
 * Verification of PortLock security events.
 *
 * PortLock (Python) signs the events it exports with an Ed25519 key; this module is the
 * ClawNet side of that contract, implementing steps 1 to 6 of section 4 of PortLock's
 * `docs/SECURITY_EVENT_FORMAT.md` with this project's canonical JSON (`core/wire/canonical.js`)
 * and Ed25519 (`core/crypto/primitives.js`). The vectors in
 * `test/vectors/portlock-security-events.json` are the proof that both projects reach the
 * same verdict on the same bytes.
 *
 * What a verdict means: `ok` says the event is intact and was signed by whoever holds the
 * key inside it. It becomes evidence about one particular PortLock machine only when the
 * caller passes the keys it enrolled out of band as `trustedKeys` (format section 5).
 * Freshness is not checked here either: a valid old event is still valid (section 11).
 *
 * Input is hostile. Nothing here throws on a malformed event; `verifySecurityEvent`
 * returns a reason instead. Callers parsing raw JSON text should bound its length first
 * (the format allows 262144 bytes) and should use a parser that rejects duplicate object
 * keys: once text has become a JavaScript object a duplicate key is gone and cannot be
 * detected here.
 */

import { ConfigError } from '../core/errors.js';
import {
  KEY_LENGTH,
  SIGNATURE_LENGTH,
  base64Decode,
  base64Encode,
  ed25519Verify,
} from '../core/crypto/primitives.js';
import { canonicalBytes } from '../core/wire/canonical.js';

/** Domain separator of the signed bytes: `utf8("portlock/1/security-event") || 0x00`. */
export const SECURITY_EVENT_DOMAIN = 'portlock/1/security-event';

/** Envelope version this module implements. */
export const SECURITY_EVENT_VERSION = 1;

/** Largest canonical encoding of a whole event, in bytes. */
export const MAX_EVENT_BYTES = 262144;

/** The severities of the format, least to most serious. */
export const SECURITY_SEVERITIES = Object.freeze(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

/** The reasons `verifySecurityEvent` reports; they are PortLock's `verify_event` codes. */
export const SecurityEventReason = Object.freeze({
  NOT_SIGNED: 'not_signed',
  MALFORMED: 'malformed_event',
  BAD_KEY_ENCODING: 'bad_key_encoding',
  BAD_SIGNATURE_ENCODING: 'bad_signature_encoding',
  WEAK_KEY: 'weak_key',
  UNTRUSTED_KEY: 'untrusted_key',
  SIGNATURE_MISMATCH: 'signature_mismatch',
});

const PREFIX = Buffer.concat([Buffer.from(SECURITY_EVENT_DOMAIN, 'utf8'), Buffer.from([0])]);

const TOP_LEVEL_MEMBERS = Object.freeze([
  'v', 'id', 'ts', 'source', 'type', 'severity', 'subject', 'data', 'chain', 'sig',
]);
const SOURCE_MEMBERS = Object.freeze(['product', 'version', 'host']);
const CHAIN_MEMBERS = Object.freeze(['seq', 'hash']);
const SIG_MEMBERS = Object.freeze(['alg', 'key', 'value']);

const ID_PATTERN = /^[0-9a-f]{32}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_TYPE_LENGTH = 64;
const MAX_VERSION_LENGTH = 64;
const MAX_HOST_LENGTH = 255;
// Control characters: U+0000 to U+001F, U+007F and the C1 block.
const CONTROL = /\p{Cc}/u;

// Ed25519 (RFC 8032): the field prime, the group order, and the y-coordinates of the five
// points of small order, which between them cover all eight points of order 1, 2, 4 and 8.
const FIELD_PRIME = 2n ** 255n - 19n;
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const SMALL_ORDER_Y = new Set([
  0n,
  1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  55188659117513257062467267217118295137698188065244968500265048394206261417927n,
  FIELD_PRIME - 1n,
]);

const fail = (reason) => ({ ok: false, reason });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactlyMembers(value, members) {
  const keys = Object.keys(value);
  return keys.length === members.length && members.every((member) => Object.hasOwn(value, member));
}

function isSafeIntegerIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** A string of 1..max characters, well formed and free of control characters. */
function isLabel(value, max) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    value.isWellFormed() &&
    !CONTROL.test(value)
  );
}

/** Step 2: exactly the members of section 1, of the stated types, within range. */
function isWellShaped(event) {
  if (!hasExactlyMembers(event, TOP_LEVEL_MEMBERS)) return false;
  const { v, id, ts, source, type, severity, subject, data, chain, sig } = event;
  if (v !== SECURITY_EVENT_VERSION) return false;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
  if (!isSafeIntegerIn(ts, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isPlainObject(source) || !hasExactlyMembers(source, SOURCE_MEMBERS)) return false;
  if (source.product !== 'portlock') return false;
  if (!isLabel(source.version, MAX_VERSION_LENGTH) || !isLabel(source.host, MAX_HOST_LENGTH)) return false;
  if (typeof type !== 'string' || type.length > MAX_TYPE_LENGTH || !TYPE_PATTERN.test(type)) return false;
  if (!SECURITY_SEVERITIES.includes(severity)) return false;
  if (!isPlainObject(subject) || !isPlainObject(data)) return false;
  if (chain !== null) {
    if (!isPlainObject(chain) || !hasExactlyMembers(chain, CHAIN_MEMBERS)) return false;
    if (!isSafeIntegerIn(chain.seq, 0, Number.MAX_SAFE_INTEGER)) return false;
    if (typeof chain.hash !== 'string' || !HASH_PATTERN.test(chain.hash)) return false;
  }
  if (!isPlainObject(sig) || !hasExactlyMembers(sig, SIG_MEMBERS)) return false;
  return sig.alg === 'ed25519' && typeof sig.key === 'string' && typeof sig.value === 'string';
}

/** Little-endian bytes as an integer. */
function littleEndian(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/**
 * Step 4: the public key is one a signature can mean something under. Done here and not
 * left to the crypto provider, because providers disagree about these keys.
 *
 * @returns {string | null} a reason, or null when the key is usable
 */
function keyProblem(key) {
  const y = littleEndian(key) & ((1n << 255n) - 1n);
  if (y >= FIELD_PRIME) return SecurityEventReason.BAD_KEY_ENCODING;
  if (SMALL_ORDER_Y.has(y)) return SecurityEventReason.WEAK_KEY;
  return null;
}

/** Step 6, first half: RFC 8032 section 5.1.7 requires S < L, or one event has many signatures. */
function hasCanonicalScalar(signature) {
  return littleEndian(signature.subarray(KEY_LENGTH)) < GROUP_ORDER;
}

function decodeBase64(text, length) {
  try {
    return base64Decode(text, length);
  } catch {
    return null;
  }
}

/**
 * Normalise a list of trusted keys to a set of canonical base64 strings.
 *
 * @param {Iterable<string | Uint8Array>} keys
 * @returns {Set<string>}
 * @throws {ConfigError} if a key is not 32 bytes
 */
function trustedSet(keys) {
  const out = new Set();
  for (const key of keys) {
    const bytes = typeof key === 'string' ? decodeBase64(key, KEY_LENGTH) : key;
    if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_LENGTH) {
      throw new ConfigError('trustedKeys must hold 32-byte Ed25519 public keys, as base64 or bytes');
    }
    out.add(base64Encode(bytes));
  }
  return out;
}

/**
 * Verify a signed PortLock security event (format version 1, section 4). Every step runs
 * and the first failing one names the reason, in the order PortLock reports them.
 *
 * @param {unknown} event the parsed JSON object
 * @param {object} [options]
 * @param {Iterable<string | Uint8Array>} [options.trustedKeys] when given, `sig.key` must be
 *   one of these (base64 strings or 32-byte keys) or the event is `untrusted_key`
 * @returns {{ ok: true, reason: null, key: string } | { ok: false, reason: string }} on
 *   success `key` is the signer's public key as base64, to compare with an enrolled key
 *   when `trustedKeys` was not given; on failure `reason` is one of `SecurityEventReason`
 * @throws {ConfigError} if `trustedKeys` itself is malformed (a local mistake, not an
 *   attacker's input)
 */
export function verifySecurityEvent(event, { trustedKeys } = {}) {
  const trusted = trustedKeys === undefined ? null : trustedSet(trustedKeys);
  try {
    // 1. A JSON object with a `sig` member.
    if (!isPlainObject(event) || !Object.hasOwn(event, 'sig')) return fail(SecurityEventReason.NOT_SIGNED);

    // 2. The members of section 1, and a form canonical JSON can encode.
    if (!isWellShaped(event)) return fail(SecurityEventReason.MALFORMED);
    const { sig, ...unsigned } = event;
    let unsignedBytes;
    try {
      unsignedBytes = canonicalBytes(unsigned);
      if (unsignedBytes.length + canonicalBytes({ sig }).length > MAX_EVENT_BYTES) {
        return fail(SecurityEventReason.MALFORMED);
      }
    } catch {
      return fail(SecurityEventReason.MALFORMED);
    }

    // 3. Canonical base64 of exactly 32 and 64 bytes.
    const key = decodeBase64(sig.key, KEY_LENGTH);
    if (key === null) return fail(SecurityEventReason.BAD_KEY_ENCODING);
    const signature = decodeBase64(sig.value, SIGNATURE_LENGTH);
    if (signature === null) return fail(SecurityEventReason.BAD_SIGNATURE_ENCODING);

    // 4. A key that signatures can mean something under.
    const problem = keyProblem(key);
    if (problem !== null) return fail(problem);

    // 5. A key the caller enrolled.
    if (trusted !== null && !trusted.has(sig.key)) return fail(SecurityEventReason.UNTRUSTED_KEY);

    // 6. The signature itself; a key that is not a curve point fails here too.
    if (!hasCanonicalScalar(signature)) return fail(SecurityEventReason.SIGNATURE_MISMATCH);
    const message = Buffer.concat([PREFIX, unsignedBytes]);
    if (!ed25519Verify(key, message, signature)) return fail(SecurityEventReason.SIGNATURE_MISMATCH);
    return { ok: true, reason: null, key: sig.key };
  } catch {
    // A bad event is an expected input: whatever surprised us, it is not a valid one.
    return fail(SecurityEventReason.MALFORMED);
  }
}

/**
 * The bytes a PortLock event's signature covers: `utf8("portlock/1/security-event") ||
 * 0x00 || canonical(event without "sig")`. Exposed so tests and tools can reproduce the
 * vectors' `signing_input_b64`.
 *
 * @param {object} event a security event, signed or not
 * @returns {Buffer}
 * @throws {import('../core/errors.js').CanonicalError} if the event is outside canonical JSON
 */
export function securityEventSigningInput(event) {
  const { sig: _sig, ...unsigned } = event;
  return Buffer.concat([PREFIX, canonicalBytes(unsigned)]);
}
