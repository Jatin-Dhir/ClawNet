/**
 * Canonical JSON.
 *
 * Signatures are computed over bytes, so two nodes must turn the same value into the
 * same bytes. This module implements RFC 8785 (JSON Canonicalization Scheme) restricted
 * to a subset that is trivial to reproduce exactly in any language:
 *
 *   - object keys are printable ASCII (0x20..0x7e) and are emitted in ascending order;
 *   - numbers are integers in the IEEE-754 safe range, emitted in plain decimal;
 *   - strings are well-formed Unicode, emitted with the minimal escaping that
 *     ECMAScript's JSON.stringify uses (the form RFC 8785 mandates);
 *   - no insignificant whitespace;
 *   - nesting is at most MAX_DEPTH containers deep.
 *
 * Floats are excluded on purpose: number formatting is where JSON canonicalization
 * schemes diverge between languages, and nothing in the protocol needs them.
 *
 * PortLock's `portlock.core.canonical` implements the same rules and both projects run
 * the same vector file (`test/vectors/canonical-json.json`).
 */

import { CanonicalError } from '../errors.js';

/** Maximum number of containers (objects and arrays) nested inside one another. */
export const MAX_DEPTH = 32;

const KEY_PATTERN = /^[\x20-\x7e]*$/;

/**
 * Serialize a value to canonical JSON text.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {CanonicalError} if the value is outside the supported subset
 */
export function canonicalize(value) {
  return encode(value, 0);
}

/**
 * Serialize a value to canonical JSON as UTF-8 bytes. This is what gets signed.
 *
 * @param {unknown} value
 * @returns {Buffer}
 */
export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

/**
 * Parse text that is required to already be in canonical form.
 *
 * Rejects anything a canonical encoder would not have produced: whitespace, unsorted or
 * duplicate keys, floats, exponents, non-minimal escapes, a byte-order mark. Use this for
 * data where accepting two encodings of one value would be a malleability problem.
 *
 * @param {string | Uint8Array} input
 * @returns {unknown}
 * @throws {CanonicalError}
 */
export function parseCanonical(input) {
  const text = typeof input === 'string' ? input : decodeUtf8(input);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new CanonicalError('input is not valid JSON', { cause });
  }
  if (canonicalize(value) !== text) {
    throw new CanonicalError('input is not in canonical form');
  }
  return value;
}

function decodeUtf8(bytes) {
  try {
    // ignoreBOM keeps a leading U+FEFF in the output so that JSON.parse rejects it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new CanonicalError('input is not valid UTF-8', { cause });
  }
}

function encode(value, depth) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError('numbers must be integers in the safe range');
      }
      // String(-0) is "0", which is also what RFC 8785 requires.
      return String(value);
    case 'string':
      return encodeString(value);
    case 'object':
      break;
    default:
      throw new CanonicalError(`unsupported type: ${typeof value}`);
  }

  if (depth >= MAX_DEPTH) {
    throw new CanonicalError(`nesting exceeds ${MAX_DEPTH} levels`);
  }

  if (Array.isArray(value)) {
    const parts = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw new CanonicalError('arrays must not have holes');
      parts[i] = encode(value[i], depth + 1);
    }
    return `[${parts.join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalError('only plain objects and arrays can be serialized');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalError('symbol keys are not allowed');
  }

  // Keys are ASCII, so the default sort (UTF-16 code units) is plain byte order.
  const keys = Object.keys(value).sort();
  const parts = new Array(keys.length);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!KEY_PATTERN.test(key)) {
      throw new CanonicalError('object keys must be printable ASCII');
    }
    parts[i] = `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`;
  }
  return `{${parts.join(',')}}`;
}

function encodeString(value) {
  if (!value.isWellFormed()) {
    throw new CanonicalError('strings must not contain lone surrogates');
  }
  return JSON.stringify(value);
}
