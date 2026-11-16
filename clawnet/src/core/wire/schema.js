/**
 * Strict validators for everything that arrives from the network.
 *
 * Each validator answers one question: does this value have exactly the shape the
 * protocol defines, with every string, number and array inside its bounds? It returns
 * `{ ok: true }` or `{ ok: false, reason }` and never throws, so a caller can feed it
 * anything a peer sent. `reason` is a short stable string made of a path and a cause,
 * for example `lsa.links[3].cost: out of range`; it never echoes attacker-chosen values.
 *
 * What is NOT checked here: signatures, key binding, freshness, rate limits. A record
 * that passes is well-formed, not authentic. Signatures are verified by
 * core/crypto/identity.js before a record is trusted.
 *
 * Unknown fields are rejected everywhere. For signed records that is a security
 * property (a signature must not cover fields the verifier ignores); for the rest it
 * keeps a single accepted form per message. The one exception is the `meta` of a sealed
 * message whose kind belongs to a service: its extra fields are that service's to check.
 *
 * The object key `__proto__` is refused at every level, in every validator, including
 * inside those service-owned fields.
 */

import { isIPv4, isIPv6 } from 'node:net';

import { WireError } from '../errors.js';
import {
  CHANNEL_ID_PATTERN,
  Limits,
  MESSAGE_ID_PATTERN,
  NODE_ID_PATTERN,
  RecordType,
} from './types.js';

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} Verdict
 *   Result of a validator. `reason` is `<path>: <cause>`.
 */

/** Handshake payload version this implementation speaks. */
export const HANDSHAKE_VERSION = 1;

/** Longest accepted address string, scheme and port included. */
export const MAX_ADDRESS_LENGTH = 300;

/** Longest DNS name (RFC 1035 presentation form without the trailing dot). */
export const MAX_DNS_NAME_LENGTH = 253;

/** Network identifier: 1..64 characters that are safe in file names, logs and URLs. */
export const NETWORK_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Agent string: 1..64 printable ASCII characters. */
export const AGENT_PATTERN = /^[\x20-\x7e]{1,64}$/;

/** PING and PONG nonce: 8 random bytes as 16 lowercase hex characters (section 15 item 6). */
export const PING_NONCE_PATTERN = /^[0-9a-f]{16}$/;

/** BYE reason: 1..32 characters of lowercase letters and hyphens. */
export const BYE_REASON_PATTERN = /^[a-z-]{1,32}$/;

/** Sealed-message `meta.kind`: 1..32 characters of lowercase letters, digits and hyphens. */
export const META_KIND_PATTERN = /^[a-z0-9-]{1,32}$/;

/** The sealed-message kinds whose `meta` is defined at the transport level. */
export const MetaKind = Object.freeze({
  /** A reliable user message; the recipient answers with an `ack`. */
  MSG: 'msg',
  /** Acknowledgement of a message, naming its id. */
  ACK: 'ack',
});

/**
 * The one object key no validator ever accepts. Canonical JSON refuses it (section 15
 * item 2); refusing it here too means an in-process value cannot slip it past a check.
 */
const FORBIDDEN_KEY = '__proto__';

/**
 * Bounds for scanning the open-ended part of a `meta` object. Canonical JSON nests at most
 * 32 containers and `meta` is at most 8 KiB, so honest values are far inside these.
 */
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_VALUES = 8192;

/** Poly1305 tag appended to an encrypted cast body. */
const AEAD_TAG_BYTES = 16;

/** Longest textual IPv4 and IPv6 addresses ("255.255.255.255", IPv6 with an IPv4 tail). */
const MAX_IPV4_TEXT = 15;
const MAX_IPV6_TEXT = 45;

const ADDRESS_SCHEME = 'tcp://';
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A final label that resolvers may read as a number instead of a name. */
const NUMERIC_LABEL_PATTERN = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
/** Field names that are safe to repeat in a reason string. */
const REPORTABLE_KEY_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

const OK = Object.freeze({ ok: true });

// Causes. Internal checks return null on success or a string that starts with the
// relative path of the failing value (".links[3].cost") followed by ": <cause>"; each
// level prepends its own path segment, so no path is built for values that pass.
const NOT_OBJECT = ': not an object';
const NOT_ARRAY = ': not an array';
const NOT_STRING = ': not a string';
const NOT_INTEGER = ': not an integer';
const NOT_BOOLEAN = ': not a boolean';
const BAD_FORMAT = ': bad format';
const BAD_BASE64 = ': bad base64';
const WRONG_LENGTH = ': wrong length';
const OUT_OF_RANGE = ': out of range';
const TOO_LONG = ': too long';
const TOO_SHORT = ': too short';
const TOO_MANY = ': too many items';
const MISSING = ': missing';
const UNEXPECTED = ': unexpected';
const UNKNOWN_FIELD = ': unknown field';
const INVALID = ': invalid';
const FORBIDDEN = ': forbidden key';
const TOO_LARGE = ': too large';
const TOO_DEEP = ': too deep';

// ---------------------------------------------------------------------------
// Predicates. Exported because configuration and the API validate the same shapes.
// ---------------------------------------------------------------------------

/**
 * True for a canonical NodeId: unpadded lowercase base32 of exactly 32 bytes
 * (NODE_ID_PATTERN in types.js, DESIGN.md section 15 item 1).
 *
 * 52 base32 characters carry 260 bits, four more than a key has. RFC 4648 requires those
 * trailing bits to be zero, which leaves `a` and `q` as the only valid last characters.
 * Enforcing it gives each key exactly one id, so a blocklisted or already-connected node
 * cannot reappear under a second spelling of the same key.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNodeId(value) {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value);
}

/**
 * True for a network identifier (handshake `net`, beacon `net`, config `networkId`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNetworkId(value) {
  return typeof value === 'string' && NETWORK_ID_PATTERN.test(value);
}

/**
 * True for an IPv4 or IPv6 literal without brackets and without a zone identifier.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIpLiteral(value) {
  return typeof value === 'string' && (isIpv4Literal(value) || isIpv6Literal(value));
}

/**
 * True for a DNS host name: at most 253 characters; labels of 1..63 letters, digits and
 * hyphens that neither start nor end with a hyphen; no trailing dot.
 *
 * A name whose last label is a number ("1.2.3", "2130706433", "0x7f.1") is refused:
 * system resolvers read such names as IPv4 addresses in legacy notation, so accepting
 * them would let a peer smuggle an address past checks that only look at IP literals.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDnsName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DNS_NAME_LENGTH) {
    return false;
  }
  const labels = value.split('.');
  for (const label of labels) {
    if (!DNS_LABEL_PATTERN.test(label)) return false;
  }
  return !NUMERIC_LABEL_PATTERN.test(labels[labels.length - 1]);
}

/**
 * True if `value` is strict RFC 4648 base64 (standard alphabet, padded, no stray bits)
 * that decodes to exactly `byteLength` bytes.
 *
 * @param {unknown} value
 * @param {number} byteLength expected decoded length in bytes
 * @returns {boolean}
 */
export function isBase64Bytes(value, byteLength) {
  return (
    typeof value === 'string' &&
    value.length === base64TextLength(byteLength) &&
    strictBase64ByteLength(value) === byteLength
  );
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Validate a peer address string: `tcp://host:port`, at most 300 characters, where host
 * is an IPv4 literal, a bracketed IPv6 literal or a DNS name and port is 1..65535 in
 * plain decimal.
 *
 * @param {unknown} value
 * @returns {Verdict}
 */
export function validateAddress(value) {
  return run('address', checkAddress, value);
}

/**
 * Split a valid address into host and port.
 *
 * @param {unknown} str
 * @returns {{ host: string, port: number } | null} the host without IPv6 brackets and the
 *   numeric port, or null if `str` is not a valid address
 */
export function parseAddress(str) {
  const parsed = scanAddress(str);
  return typeof parsed === 'string' ? null : parsed;
}

/**
 * Build an address string from a host and a port. IPv6 literals get their brackets.
 *
 * @param {string} host IPv4 literal, IPv6 literal without brackets, or DNS name
 * @param {number} port 1..65535
 * @returns {string} an address that validateAddress accepts
 * @throws {WireError} if host or port cannot form a valid address
 */
export function formatAddress(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WireError(
      'cannot format address: host must be a string and port an integer in 1..65535',
    );
  }
  if (isIpv6Literal(host)) return `${ADDRESS_SCHEME}[${host}]:${port}`;
  if (isIpv4Literal(host) || isDnsName(host)) return `${ADDRESS_SCHEME}${host}:${port}`;
  throw new WireError('cannot format address: host is not an IP literal or DNS name');
}

/** @returns {{ host: string, port: number } | string} parsed address, or the cause */
function scanAddress(value) {
  if (typeof value !== 'string') return NOT_STRING;
  if (value.length > MAX_ADDRESS_LENGTH) return TOO_LONG;
  if (!value.startsWith(ADDRESS_SCHEME)) return ': bad scheme';
  const rest = value.slice(ADDRESS_SCHEME.length);

  let host;
  let portText;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) return ': bad host';
    host = rest.slice(1, close);
    if (!isIpv6Literal(host)) return ': bad host';
    if (rest[close + 1] !== ':') return ': bad port';
    portText = rest.slice(close + 2);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon === -1) return ': bad port';
    host = rest.slice(0, colon);
    if (!isIpv4Literal(host) && !isDnsName(host)) return ': bad host';
    portText = rest.slice(colon + 1);
  }

  if (!PORT_PATTERN.test(portText)) return ': bad port';
  const port = Number(portText);
  if (port > 65535) return ': bad port';
  return { host, port };
}

function checkAddress(value) {
  const parsed = scanAddress(value);
  return typeof parsed === 'string' ? parsed : null;
}

function isIpv4Literal(value) {
  return value.length <= MAX_IPV4_TEXT && isIPv4(value);
}

function isIpv6Literal(value) {
  // A zone identifier ("fe80::1%eth0") names an interface of the sender's machine and
  // means nothing, or something else, on ours.
  return value.length <= MAX_IPV6_TEXT && !value.includes('%') && isIPv6(value);
}

// ---------------------------------------------------------------------------
// Leaf checks
// ---------------------------------------------------------------------------

function checkNodeId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return isNodeId(value) ? null : BAD_FORMAT;
}

function checkMessageId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return MESSAGE_ID_PATTERN.test(value) ? null : BAD_FORMAT;
}

function checkChannelId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return CHANNEL_ID_PATTERN.test(value) ? null : BAD_FORMAT;
}

function checkNetworkId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return NETWORK_ID_PATTERN.test(value) ? null : BAD_FORMAT;
}

function checkAgent(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return AGENT_PATTERN.test(value) ? null : BAD_FORMAT;
}

function checkBoolean(value) {
  return typeof value === 'boolean' ? null : NOT_BOOLEAN;
}

function checkString(value) {
  return typeof value === 'string' ? null : NOT_STRING;
}

function checkObservedAddress(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return NOT_STRING;
  return isIpLiteral(value) ? null : BAD_FORMAT;
}

function checkVersion(value) {
  if (!Number.isSafeInteger(value)) return NOT_INTEGER;
  return value === HANDSHAKE_VERSION ? null : ': unsupported version';
}

/** @returns {(value: unknown) => string | null} check for a safe integer in min..max */
function integer(min, max) {
  return (value) => {
    if (!Number.isSafeInteger(value)) return NOT_INTEGER;
    return value >= min && value <= max ? null : OUT_OF_RANGE;
  };
}

/** @returns {(value: unknown) => string | null} check for base64 of exactly `byteLength` bytes */
function base64Bytes(byteLength) {
  const textLength = base64TextLength(byteLength);
  return (value) => {
    if (typeof value !== 'string') return NOT_STRING;
    if (value.length !== textLength) return WRONG_LENGTH;
    const decoded = strictBase64ByteLength(value);
    if (decoded < 0) return BAD_BASE64;
    // One or two bytes fewer or more can share the text length; only decoding tells.
    return decoded === byteLength ? null : WRONG_LENGTH;
  };
}

/** @returns {(value: unknown) => string | null} check that the value is exactly `expected` */
function literal(expected) {
  return (value) => (value === expected ? null : ': unexpected value');
}

/**
 * @param {RegExp} regex anchored, with a bounded repetition, so a long string fails fast
 * @returns {(value: unknown) => string | null} check for a string matching `regex`
 */
function pattern(regex) {
  return (value) => {
    if (typeof value !== 'string') return NOT_STRING;
    return regex.test(value) ? null : BAD_FORMAT;
  };
}

function base64TextLength(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Decoded length of a strict base64 string, or -1 if it is not strict.
 *
 * Buffer's decoder is lenient: it skips unknown characters, accepts the URL-safe
 * alphabet, tolerates missing padding and ignores stray trailing bits. Re-encoding the
 * result and comparing closes all of that at once, because the encoder has exactly one
 * output per byte string. The caller bounds `text.length` before calling.
 */
function strictBase64ByteLength(text) {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes.length : -1;
}

// ---------------------------------------------------------------------------
// Composite checks
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Build a check for a plain object with exactly the given fields.
 *
 * @param {Record<string, (value: unknown) => string | null>} required checked in order
 * @param {object} [extra]
 * @param {Record<string, (value: unknown) => string | null>} [extra.optional]
 * @param {(value: any) => string | null} [extra.cross] cross-field check, run only after
 *   every field has passed on its own
 * @param {boolean} [extra.open] accept string keys besides the listed ones; their values
 *   are left to another module but are still scanned for the forbidden key, within bounds
 * @returns {(value: unknown) => string | null}
 */
function object(required, { optional = {}, cross = null, open = false } = {}) {
  const requiredNames = Object.keys(required);
  const optionalNames = Object.keys(optional);
  const known = new Set([...requiredNames, ...optionalNames]);

  return (value) => {
    if (!isPlainObject(value)) return NOT_OBJECT;
    // ownKeys also reports symbols and non-enumerable properties, which JSON cannot
    // produce but an in-process caller could.
    const scan = { values: 0 };
    for (const key of Reflect.ownKeys(value)) {
      if (key === FORBIDDEN_KEY) return `.${FORBIDDEN_KEY}${FORBIDDEN}`;
      if (typeof key === 'string' && known.has(key)) continue;
      if (open && typeof key === 'string' && isEnumerable(value, key)) {
        const cause = scanForbidden(value[key], 1, scan);
        if (cause !== null) return reportable(key) ? `.${key}${cause}` : cause;
        continue;
      }
      return reportable(key) ? `.${key}${UNKNOWN_FIELD}` : UNKNOWN_FIELD;
    }
    for (const name of requiredNames) {
      if (!Object.hasOwn(value, name)) return `.${name}${MISSING}`;
      const cause = required[name](value[name]);
      if (cause !== null) return `.${name}${cause}`;
    }
    for (const name of optionalNames) {
      if (!Object.hasOwn(value, name)) continue;
      const cause = optional[name](value[name]);
      if (cause !== null) return `.${name}${cause}`;
    }
    return cross === null ? null : cross(value);
  };
}

function reportable(key) {
  return typeof key === 'string' && REPORTABLE_KEY_PATTERN.test(key);
}

function isEnumerable(value, key) {
  return Object.prototype.propertyIsEnumerable.call(value, key);
}

/**
 * Walk a JSON-shaped value that no validator here owns and refuse the forbidden key at any
 * depth, along with anything JSON cannot express. `scan.values` is shared by every call
 * for one top-level value, so a wide or self-referencing value costs at most
 * MAX_SCAN_VALUES steps.
 *
 * @returns {string | null} a cause without a path, or null
 */
function scanForbidden(value, depth, scan) {
  scan.values += 1;
  if (scan.values > MAX_SCAN_VALUES) return TOO_LARGE;
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isSafeInteger(value) ? null : INVALID;
    case 'object':
      break;
    default:
      return INVALID;
  }
  if (depth > MAX_SCAN_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) {
    if (value.length > MAX_SCAN_VALUES) return TOO_LARGE;
    for (let i = 0; i < value.length; i += 1) {
      const cause = scanForbidden(value[i], depth + 1, scan);
      if (cause !== null) return cause;
    }
    return null;
  }
  if (!isPlainObject(value)) return INVALID;
  for (const key of Reflect.ownKeys(value)) {
    if (key === FORBIDDEN_KEY) return FORBIDDEN;
    if (typeof key !== 'string' || !isEnumerable(value, key)) return INVALID;
    const cause = scanForbidden(value[key], depth + 1, scan);
    if (cause !== null) return cause;
  }
  return null;
}

/**
 * Build a check for an array of at most `maxItems` items that each pass `item`.
 *
 * @param {(value: unknown) => string | null} item
 * @param {number} maxItems
 * @returns {(value: unknown) => string | null}
 */
function array(item, maxItems) {
  return (value) => {
    if (!Array.isArray(value)) return NOT_ARRAY;
    if (value.length > maxItems) return TOO_MANY;
    for (let i = 0; i < value.length; i += 1) {
      const cause = item(value[i]);
      if (cause !== null) return `[${i}]${cause}`;
    }
    return null;
  };
}

/** Run a check and turn its result into a Verdict. This is where "never throws" is kept. */
function run(root, check, value) {
  let cause;
  try {
    cause = check(value);
  } catch {
    // Only reachable with exotic in-process values (a Proxy or getter that throws);
    // nothing parsed from JSON can get here.
    cause = INVALID;
  }
  return cause === null ? OK : { ok: false, reason: `${root}${cause}` };
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const checkTimestamp = integer(0, SAFE_MAX);
const checkSequence = integer(1, SAFE_MAX);
const checkPort = integer(1, 65535);
const checkKey = base64Bytes(32);
const checkSignature = base64Bytes(64);

const checkCard = object({
  id: checkNodeId,
  link: checkKey,
  e2e: checkKey,
  sig: checkSignature,
});

const checkCaps = object({
  relay: checkBoolean,
  mailbox: checkBoolean,
  transit: checkBoolean,
});

const checkAddressList = array(checkAddress, Limits.MAX_PEER_ADDRS);

const checkHandshakePayload = object({
  v: checkVersion,
  card: checkCard,
  net: checkNetworkId,
  agent: checkAgent,
  caps: checkCaps,
  listen: checkAddressList,
  observed: checkObservedAddress,
  ts: checkTimestamp,
});

const checkDataHeader = object(
  {
    id: checkMessageId,
    dst: checkNodeId,
    ttl: integer(0, Limits.MAX_TTL),
    try: integer(0, Limits.MAX_TRY),
  },
  { optional: { cust: checkNodeId } },
);

const checkProbeHeader = object(
  {
    id: checkMessageId,
    dst: checkNodeId,
    ttl: integer(0, Limits.MAX_TTL),
    rsvp: checkNodeId,
    n: integer(1, Limits.MAX_TTL),
  },
  // `n` is the ttl the originator set and only ever decreases; a larger ttl would make
  // the hop index n - ttl + 1 zero or negative.
  { cross: (probe) => (probe.ttl > probe.n ? `.ttl${OUT_OF_RANGE}` : null) },
);

/** PING and PONG carry the same header: the nonce the PONG echoes. */
const checkPingHeader = object({ n: pattern(PING_NONCE_PATTERN) });

const checkByeHeader = object({ reason: pattern(BYE_REASON_PATTERN) });

const checkMetaKind = pattern(META_KIND_PATTERN);

/** Fields every sealed message's `meta` carries (DESIGN.md section 6, section 15 item 9). */
const META_REQUIRED = {
  kind: checkMetaKind,
  card: checkCard,
  ts: checkTimestamp,
  hs: checkSignature,
};

const checkMsgMeta = object({
  ...META_REQUIRED,
  kind: literal(MetaKind.MSG),
  ack: checkBoolean,
});

const checkAckMeta = object({
  ...META_REQUIRED,
  kind: literal(MetaKind.ACK),
  id: checkMessageId,
});

/**
 * Any other kind: the reserved fields are checked here, everything else belongs to the
 * kind's owner. `ack` is reserved for ReliableMessenger whatever the kind.
 */
const checkOtherMeta = object(META_REQUIRED, { optional: { ack: checkBoolean }, open: true });

// A Map, so that a kind such as "constructor" finds nothing.
const META_CHECKS = new Map([
  [MetaKind.MSG, checkMsgMeta],
  [MetaKind.ACK, checkAckMeta],
]);

const checkLink = object({
  peer: checkNodeId,
  cost: integer(1, 65535),
});

function crossCheckLsa(lsa) {
  const seen = new Set();
  for (let i = 0; i < lsa.links.length; i += 1) {
    const { peer } = lsa.links[i];
    if (peer === lsa.origin) return `.links[${i}].peer: is origin`;
    if (seen.has(peer)) return `.links[${i}].peer: duplicate`;
    seen.add(peer);
  }
  return null;
}

function crossCheckCardOwner(record) {
  return record.card.id === record.origin ? null : '.card.id: does not match origin';
}

function crossCheckCast(cast) {
  const hasSalt = Object.hasOwn(cast, 'salt');
  if (cast.enc && !hasSalt) return `.salt${MISSING}`;
  if (!cast.enc && hasSalt) return `.salt${UNEXPECTED}`;

  const maxBytes = Limits.MAX_CAST_BODY + (cast.enc ? AEAD_TAG_BYTES : 0);
  // Bound the text before decoding it, so an oversized body costs nothing.
  if (cast.body.length > base64TextLength(maxBytes)) return `.body${TOO_LONG}`;
  if (cast.body.length % 4 !== 0) return `.body${BAD_BASE64}`;
  const byteLength = strictBase64ByteLength(cast.body);
  if (byteLength < 0) return `.body${BAD_BASE64}`;
  if (byteLength > maxBytes) return `.body${TOO_LONG}`;
  // An AEAD ciphertext is never shorter than its tag; anything shorter cannot decrypt.
  if (cast.enc && byteLength < AEAD_TAG_BYTES) return `.body${TOO_SHORT}`;
  return null;
}

const checkLsa = object(
  {
    type: literal(RecordType.LSA),
    origin: checkNodeId,
    seq: checkSequence,
    ts: checkTimestamp,
    links: array(checkLink, Limits.MAX_LSA_LINKS),
    caps: checkCaps,
    sig: checkSignature,
  },
  { cross: crossCheckLsa },
);

const checkPeerRecord = object(
  {
    type: literal(RecordType.PEER),
    origin: checkNodeId,
    seq: checkSequence,
    ts: checkTimestamp,
    addrs: checkAddressList,
    caps: checkCaps,
    card: checkCard,
    sig: checkSignature,
  },
  { cross: crossCheckCardOwner },
);

const checkCast = object(
  {
    type: literal(RecordType.CAST),
    origin: checkNodeId,
    chan: checkChannelId,
    n: checkSequence,
    ts: checkTimestamp,
    enc: checkBoolean,
    body: checkString,
    sig: checkSignature,
  },
  { optional: { salt: base64Bytes(32) }, cross: crossCheckCast },
);

const checkBeacon = object(
  {
    type: literal(RecordType.BEACON),
    origin: checkNodeId,
    ts: checkTimestamp,
    port: checkPort,
    net: checkNetworkId,
    card: checkCard,
    sig: checkSignature,
  },
  // `mac`: HMAC-SHA256 under the key derived from the network key, present in private
  // networks (section 15 item 23).
  { optional: { mac: base64Bytes(32) }, cross: crossCheckCardOwner },
);

const checkReceipt = object({
  type: literal(RecordType.RECEIPT),
  origin: checkNodeId,
  id: checkMessageId,
  ts: checkTimestamp,
  sig: checkSignature,
});

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate an identity card: `{ id, link, e2e, sig }` where `id` is a NodeId, `link` and
 * `e2e` are base64 of 32 bytes and `sig` is base64 of 64 bytes.
 *
 * @param {unknown} card
 * @returns {Verdict} reasons are rooted at `card`
 */
export function validateCard(card) {
  return run('card', checkCard, card);
}

/**
 * Validate a capability set: `{ relay, mailbox, transit }`, all booleans.
 *
 * @param {unknown} caps
 * @returns {Verdict} reasons are rooted at `caps`
 */
export function validateCaps(caps) {
  return run('caps', checkCaps, caps);
}

/**
 * Validate a link handshake payload (Noise messages 2 and 3):
 * `{ v: 1, card, net, agent, caps, listen, observed, ts }`.
 *
 * `net` is 1..64 characters of `[A-Za-z0-9._-]`, `agent` is 1..64 printable ASCII
 * characters, `listen` holds at most Limits.MAX_PEER_ADDRS addresses, `observed` is null
 * or an IP literal, `ts` is a non-negative safe integer (milliseconds).
 *
 * @param {unknown} payload
 * @returns {Verdict} reasons are rooted at `handshake`
 */
export function validateHandshakePayload(payload) {
  return run('handshake', checkHandshakePayload, payload);
}

/**
 * Validate a DATA packet header: `{ id, dst, ttl, try }` plus optional `cust`.
 * `ttl` is 0..Limits.MAX_TTL and `try` is 0..Limits.MAX_TRY.
 *
 * @param {unknown} header
 * @returns {Verdict} reasons are rooted at `data`
 */
export function validateDataHeader(header) {
  return run('data', checkDataHeader, header);
}

/**
 * Validate a PROBE packet header: `{ id, dst, ttl, rsvp, n }`. `ttl` is
 * 0..Limits.MAX_TTL, `n` is 1..Limits.MAX_TTL, and `ttl` is at most `n`.
 *
 * @param {unknown} header
 * @returns {Verdict} reasons are rooted at `probe`
 */
export function validateProbeHeader(header) {
  return run('probe', checkProbeHeader, header);
}

/**
 * Validate a PING packet header: `{ n }` where `n` is a fresh random nonce of 16
 * lowercase hex characters (DESIGN.md section 15 item 6).
 *
 * @param {unknown} header
 * @returns {Verdict} reasons are rooted at `ping`
 */
export function validatePingHeader(header) {
  return run('ping', checkPingHeader, header);
}

/**
 * Validate a PONG packet header: `{ n }`, the 16 lowercase hex characters of the PING
 * being answered. Whether it matches an outstanding PING is the link's business.
 *
 * @param {unknown} header
 * @returns {Verdict} reasons are rooted at `pong`
 */
export function validatePongHeader(header) {
  return run('pong', checkPingHeader, header);
}

/**
 * Validate a BYE packet header: `{ reason }` matching BYE_REASON_PATTERN. Whether the
 * reason is one of the known ones is for the receiver to decide.
 *
 * @param {unknown} header
 * @returns {Verdict} reasons are rooted at `bye`
 */
export function validateByeHeader(header) {
  return run('bye', checkByeHeader, header);
}

/**
 * Validate the `meta` object of a sealed (scheme 1) message.
 *
 * Every kind carries `kind` (META_KIND_PATTERN), `card` (an identity card), `ts` (a
 * non-negative safe integer) and `hs` (base64 of a 64-byte signature). The kinds the
 * transport owns are checked exactly:
 *
 *   - `msg`: `{ kind, card, ts, hs, ack }` with `ack` a boolean;
 *   - `ack`: `{ kind, card, ts, hs, id }` with `id` a message id.
 *
 * For any other kind only those reserved fields (and `ack`, if present, as a boolean)
 * are checked; the remaining fields are the owning service's to validate. They must
 * still be plain JSON without the key `__proto__` at any depth, within fixed bounds.
 *
 * @param {unknown} meta
 * @returns {Verdict} reasons are rooted at `meta`
 */
export function validateMeta(meta) {
  let kind;
  try {
    if (!isPlainObject(meta)) return { ok: false, reason: `meta${NOT_OBJECT}` };
    if (!Object.hasOwn(meta, 'kind')) return { ok: false, reason: `meta.kind${MISSING}` };
    kind = meta.kind;
  } catch {
    return { ok: false, reason: `meta${INVALID}` };
  }
  const cause = checkMetaKind(kind);
  if (cause !== null) return { ok: false, reason: `meta.kind${cause}` };
  return run('meta', META_CHECKS.get(kind) ?? checkOtherMeta, meta);
}

/**
 * Validate a link-state advertisement:
 * `{ type: "lsa", origin, seq, ts, links: [{ peer, cost }], caps, sig }`.
 * At most Limits.MAX_LSA_LINKS links, cost 1..65535, no duplicate peers and no link from
 * the origin to itself.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at `lsa`
 */
export function validateLsa(record) {
  return run('lsa', checkLsa, record);
}

/**
 * Validate a peer record:
 * `{ type: "peer", origin, seq, ts, addrs, caps, card, sig }` with at most
 * Limits.MAX_PEER_ADDRS addresses and `card.id` equal to `origin`.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at `peer`
 */
export function validatePeerRecord(record) {
  return run('peer', checkPeerRecord, record);
}

/**
 * Validate a cast:
 * `{ type: "cast", origin, chan, n, ts, enc, salt?, body, sig }`.
 * `salt` (base64 of 32 bytes) is present if and only if `enc` is true. `body` is strict
 * base64 of at most Limits.MAX_CAST_BODY bytes, or of 16 bytes (the tag) up to
 * Limits.MAX_CAST_BODY + 16 bytes when `enc` is true.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at `cast`
 */
export function validateCast(record) {
  return run('cast', checkCast, record);
}

/**
 * Validate a LAN discovery beacon:
 * `{ type: "beacon", origin, ts, port, net, card, sig }` plus an optional `mac` (base64
 * of 32 bytes, used in networks with a network key), with port 1..65535 and `card.id`
 * equal to `origin`.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at `beacon`
 */
export function validateBeacon(record) {
  return run('beacon', checkBeacon, record);
}

/**
 * Validate a custody receipt: `{ type: "receipt", origin, id, ts, sig }`.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at `receipt`
 */
export function validateReceipt(record) {
  return run('receipt', checkReceipt, record);
}

// A Map, not an object, so that a type such as "constructor" finds nothing.
const RECORD_CHECKS = new Map([
  [RecordType.LSA, checkLsa],
  [RecordType.PEER, checkPeerRecord],
  [RecordType.CAST, checkCast],
  [RecordType.BEACON, checkBeacon],
  [RecordType.RECEIPT, checkReceipt],
]);

/**
 * Validate any signed record, choosing the validator by `record.type`.
 *
 * @param {unknown} record
 * @returns {Verdict} reasons are rooted at the record type (`lsa`, `peer`, ...), or at
 *   `record` when the type itself is missing or unknown
 */
export function validateRecord(record) {
  let type;
  try {
    if (!isPlainObject(record)) return { ok: false, reason: `record${NOT_OBJECT}` };
    if (!Object.hasOwn(record, 'type')) return { ok: false, reason: `record.type${MISSING}` };
    type = record.type;
  } catch {
    return { ok: false, reason: `record${INVALID}` };
  }
  if (typeof type !== 'string') return { ok: false, reason: `record.type${NOT_STRING}` };
  const check = RECORD_CHECKS.get(type);
  if (check === undefined) return { ok: false, reason: 'record.type: unknown' };
  return run(type, check, record);
}
