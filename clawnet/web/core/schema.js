/**
 * Strict validators for what the web core receives: a port of the parts of the engine's
 * `src/core/wire/schema.js` that a phone node needs (handshake payload, packet headers,
 * sealed-message meta, LSAs, peer records). Same rules, same reasons, never throws.
 *
 * Node's `net.isIPv4` and `net.isIPv6` are regular expressions in Node's own source; the
 * two below are the same expressions, and a test compares them with `node:net` on many
 * strings, so the browser accepts exactly the addresses the engine accepts.
 */

import { Limits, MESSAGE_ID_PATTERN, NODE_ID_PATTERN, RecordType } from '../../src/core/wire/types.js';
import { base64Decode } from './bytes.js';

export const HANDSHAKE_VERSION = 1;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_DNS_NAME_LENGTH = 253;
export const NETWORK_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const AGENT_PATTERN = /^[\x20-\x7e]{1,64}$/;
export const PING_NONCE_PATTERN = /^[0-9a-f]{16}$/;
export const BYE_REASON_PATTERN = /^[a-z-]{1,32}$/;
export const META_KIND_PATTERN = /^[a-z0-9-]{1,32}$/;
export const MetaKind = Object.freeze({ MSG: 'msg', ACK: 'ack' });

const FORBIDDEN_KEY = '__proto__';
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_VALUES = 8192;
const MAX_IPV4_TEXT = 15;
const MAX_IPV6_TEXT = 45;
const ADDRESS_SCHEME = 'tcp://';
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const NUMERIC_LABEL_PATTERN = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
const REPORTABLE_KEY_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

// Node.js lib/internal/net.js.
const V4_SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4_RE = new RegExp(`^${V4_STR}$`);
const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const IPV6_RE = new RegExp(
  '^(?:' +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$',
);

/** Node's net.isIPv4. */
export function isIPv4(value) {
  return typeof value === 'string' && IPV4_RE.test(value);
}

/** Node's net.isIPv6. */
export function isIPv6(value) {
  if (typeof value !== 'string' || value.length < 2 || !value.includes(':')) return false;
  return IPV6_RE.test(value);
}

const OK = Object.freeze({ ok: true });
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
const TOO_MANY = ': too many items';
const MISSING = ': missing';
const UNKNOWN_FIELD = ': unknown field';
const INVALID = ': invalid';
const FORBIDDEN = ': forbidden key';
const TOO_LARGE = ': too large';
const TOO_DEEP = ': too deep';

export function isNodeId(value) {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value);
}

export function isNetworkId(value) {
  return typeof value === 'string' && NETWORK_ID_PATTERN.test(value);
}

export function isIpLiteral(value) {
  return typeof value === 'string' && (isIpv4Literal(value) || isIpv6Literal(value));
}

export function isDnsName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DNS_NAME_LENGTH) return false;
  const labels = value.split('.');
  for (const label of labels) if (!DNS_LABEL_PATTERN.test(label)) return false;
  return !NUMERIC_LABEL_PATTERN.test(labels[labels.length - 1]);
}

export function isBase64Bytes(value, byteLength) {
  return typeof value === 'string' && value.length === base64TextLength(byteLength) && strictBase64ByteLength(value) === byteLength;
}

export function validateAddress(value) {
  return run('address', checkAddress, value);
}

export function parseAddress(str) {
  const parsed = scanAddress(str);
  return typeof parsed === 'string' ? null : parsed;
}

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
  return value.length <= MAX_IPV6_TEXT && !value.includes('%') && isIPv6(value);
}

function checkNodeId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return isNodeId(value) ? null : BAD_FORMAT;
}

function checkMessageId(value) {
  if (typeof value !== 'string') return NOT_STRING;
  return MESSAGE_ID_PATTERN.test(value) ? null : BAD_FORMAT;
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

function checkObservedAddress(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return NOT_STRING;
  return isIpLiteral(value) ? null : BAD_FORMAT;
}

function checkVersion(value) {
  if (!Number.isSafeInteger(value)) return NOT_INTEGER;
  return value === HANDSHAKE_VERSION ? null : ': unsupported version';
}

function integer(min, max) {
  return (value) => {
    if (!Number.isSafeInteger(value)) return NOT_INTEGER;
    return value >= min && value <= max ? null : OUT_OF_RANGE;
  };
}

function base64Bytes(byteLength) {
  const textLength = base64TextLength(byteLength);
  return (value) => {
    if (typeof value !== 'string') return NOT_STRING;
    if (value.length !== textLength) return WRONG_LENGTH;
    const decoded = strictBase64ByteLength(value);
    if (decoded < 0) return BAD_BASE64;
    return decoded === byteLength ? null : WRONG_LENGTH;
  };
}

function literal(expected) {
  return (value) => (value === expected ? null : ': unexpected value');
}

function pattern(regex) {
  return (value) => {
    if (typeof value !== 'string') return NOT_STRING;
    return regex.test(value) ? null : BAD_FORMAT;
  };
}

function base64TextLength(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

function strictBase64ByteLength(text) {
  try {
    return base64Decode(text).length;
  } catch {
    return -1;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function object(required, { optional = {}, cross = null, open = false } = {}) {
  const requiredNames = Object.keys(required);
  const optionalNames = Object.keys(optional);
  const known = new Set([...requiredNames, ...optionalNames]);
  return (value) => {
    if (!isPlainObject(value)) return NOT_OBJECT;
    const scan = { values: 0 };
    for (const key of Reflect.ownKeys(value)) {
      if (key === FORBIDDEN_KEY) return `.${FORBIDDEN_KEY}${FORBIDDEN}`;
      if (typeof key === 'string' && known.has(key)) continue;
      if (open && typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key)) {
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
    if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)) return INVALID;
    const cause = scanForbidden(value[key], depth + 1, scan);
    if (cause !== null) return cause;
  }
  return null;
}

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

function run(root, check, value) {
  let cause;
  try {
    cause = check(value);
  } catch {
    cause = INVALID;
  }
  return cause === null ? OK : { ok: false, reason: `${root}${cause}` };
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const checkTimestamp = integer(0, SAFE_MAX);
const checkSequence = integer(1, SAFE_MAX);
const checkKey = base64Bytes(32);
const checkSignature = base64Bytes(64);
const checkCard = object({ id: checkNodeId, link: checkKey, e2e: checkKey, sig: checkSignature });
const checkCaps = object({ relay: checkBoolean, mailbox: checkBoolean, transit: checkBoolean });
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
  { id: checkMessageId, dst: checkNodeId, ttl: integer(0, Limits.MAX_TTL), try: integer(0, Limits.MAX_TRY) },
  { optional: { cust: checkNodeId } },
);

const checkProbeHeader = object(
  { id: checkMessageId, dst: checkNodeId, ttl: integer(0, Limits.MAX_TTL), rsvp: checkNodeId, n: integer(1, Limits.MAX_TTL) },
  { cross: (probe) => (probe.ttl > probe.n ? `.ttl${OUT_OF_RANGE}` : null) },
);

const checkPingHeader = object({ n: pattern(PING_NONCE_PATTERN) });
const checkByeHeader = object({ reason: pattern(BYE_REASON_PATTERN) });
const checkMetaKind = pattern(META_KIND_PATTERN);
const META_REQUIRED = { kind: checkMetaKind, card: checkCard, ts: checkTimestamp, hs: checkSignature };
const checkMsgMeta = object({ ...META_REQUIRED, kind: literal(MetaKind.MSG), ack: checkBoolean });
const checkAckMeta = object({ ...META_REQUIRED, kind: literal(MetaKind.ACK), id: checkMessageId });
const checkOtherMeta = object(META_REQUIRED, { optional: { ack: checkBoolean }, open: true });
const META_CHECKS = new Map([
  [MetaKind.MSG, checkMsgMeta],
  [MetaKind.ACK, checkAckMeta],
]);

const checkLink = object({ peer: checkNodeId, cost: integer(1, 65535) });

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

export function validateCard(card) {
  return run('card', checkCard, card);
}

export function validateCaps(caps) {
  return run('caps', checkCaps, caps);
}

export function validateHandshakePayload(payload) {
  return run('handshake', checkHandshakePayload, payload);
}

export function validateDataHeader(header) {
  return run('data', checkDataHeader, header);
}

export function validateProbeHeader(header) {
  return run('probe', checkProbeHeader, header);
}

export function validatePingHeader(header) {
  return run('ping', checkPingHeader, header);
}

export function validateByeHeader(header) {
  return run('bye', checkByeHeader, header);
}

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

export function validateLsa(record) {
  return run('lsa', checkLsa, record);
}

export function validatePeerRecord(record) {
  return run('peer', checkPeerRecord, record);
}
