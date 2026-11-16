/**
 * Node configuration.
 *
 * One typed, validated, deep-frozen object configures the whole node. It is assembled
 * from four layers, later ones winning:
 *
 *   defaults  <  config file (JSON)  <  CLAWNET_* environment variables  <  overrides
 *
 * Validation is strict on purpose. Unknown keys are errors, so a typo cannot silently
 * leave a setting at its default; every number has a range; settings that only make
 * sense together are checked together. Every failure is a ConfigError whose message
 * starts with the path of the offending setting (also available as `err.path`). Messages
 * describe what is expected and never repeat the rejected value, because one of the
 * settings is a secret (networkKey).
 *
 * Every timer in the engine is configuration (DESIGN.md section 13), which is what lets
 * tests run the real code paths with short intervals.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

import { ConfigError } from './errors.js';
import { isBase64Bytes, isDnsName, isNetworkId, isNodeId, parseAddress } from './wire/schema.js';
import { Limits } from './wire/types.js';

/**
 * @typedef {object} ListenConfig
 * @property {string} host  address the peer TCP listener binds: an IP literal (IPv6
 *   without brackets) or a host name. Default "0.0.0.0".
 * @property {number} port  peer TCP port, 0..65535; 0 lets the OS choose. Default 47470.
 */

/**
 * @typedef {object} ApiConfig
 * @property {boolean} enabled      serve the local control API. Default true.
 * @property {string} host          address the API binds. Must be a loopback address
 *   ("localhost", 127.0.0.0/8 or ::1) unless `allowRemote` is true. Default "127.0.0.1".
 * @property {number} port          API TCP port, 0..65535; 0 lets the OS choose. Default 47480.
 * @property {string[]} allowedHosts `Host` header values the API accepts, compared
 *   without the port: IPv4 literals, bracketed IPv6 literals or host names, stored in
 *   lower case. Defeats DNS rebinding. Default ["127.0.0.1", "localhost", "[::1]"].
 * @property {string[]} corsOrigins  exact origins ("http://localhost:5173") allowed to
 *   call the API from a browser. Empty means no CORS headers at all. Default [].
 * @property {boolean} serveUi      serve the built ClawView console. Default true.
 * @property {boolean} allowRemote  permit a non-loopback `host`. The bearer token is
 *   then the only protection, and it travels unencrypted. Default false.
 */

/**
 * @typedef {object} MulticastConfig
 * @property {boolean} enabled        send and receive LAN beacons. Default true.
 * @property {string} group           IPv4 multicast group (224.0.0.0/4). Default "239.255.67.78".
 * @property {number} port            UDP port, 1..65535. Default 47470.
 * @property {string | null} interface IPv4 address of the local interface to use, or
 *   null to let the OS choose. Default null.
 */

/**
 * @typedef {object} DiscoveryConfig
 * @property {MulticastConfig} multicast LAN discovery.
 * @property {string[]} bootstrap  addresses ("tcp://host:port") dialed at start and
 *   whenever the node has too few peers; at most 256. Default [].
 * @property {boolean} pex         learn and dial addresses from signed peer records. Default true.
 * @property {boolean} allowLoopback dial addresses learned from peer records or beacons
 *   even when they are loopback, unspecified, multicast or link-local. Only for tests and
 *   single-machine networks: a signed record proves who announced an address, not that
 *   it is theirs. Configured bootstrap addresses are not affected. Default false.
 */

/**
 * @typedef {object} PeersConfig
 * @property {number} target   peer count the node tries to maintain, 0..max. Default 8.
 * @property {number} max      most simultaneous links, 1..4096. Default 64.
 * @property {string[]} allow  NodeIds allowed to connect; empty means anyone. At most 4096.
 *   Default [].
 * @property {string[]} block  NodeIds that are always refused. At most 4096. Default [].
 */

/**
 * @typedef {object} CapsConfig
 * @property {boolean} relay    advertise willingness to relay for others. Default true.
 * @property {boolean} mailbox  accept custody deposits for unreachable nodes. Default false.
 * @property {boolean} transit  allow routes to pass through this node. Default true.
 */

/**
 * All values are milliseconds unless stated otherwise. Each is at most 2147483647, the
 * longest delay a Node.js timer supports.
 *
 * @typedef {object} TimersConfig
 * @property {number} keepaliveMs        interval between PINGs on an idle link. Default 10000.
 * @property {number} peerTimeoutMs      silence after which a link is closed; must exceed
 *   keepaliveMs. Default 30000.
 * @property {number} handshakeTimeoutMs time allowed for a link handshake. Default 10000.
 * @property {number} redialMinMs        first redial delay. Default 1000.
 * @property {number} redialMaxMs        redial delay cap; at least redialMinMs. Default 60000.
 * @property {number} redialJitter       random spread applied to each redial delay, as a
 *   fraction 0..1 (not milliseconds). Default 0.2.
 * @property {number} lsaRefreshMs       interval between re-advertisements of the node's
 *   own LSA. Default 60000.
 * @property {number} lsaMaxAgeMs        age, since local receipt, at which an LSA
 *   expires; must exceed lsaRefreshMs. Default 210000.
 * @property {number} lsaTombstoneMs     how long the highest sequence number of an
 *   expired LSA is remembered; at least lsaMaxAgeMs. Default 86400000.
 * @property {number} lsaMinIntervalMs   least time between two LSAs from one origin: the
 *   node originates at most one per interval and floods at most one per origin per
 *   interval; 0 removes the limit. Must be less than lsaMaxAgeMs, or the node's own LSA
 *   could expire before it is allowed to refresh it. Default 5000.
 * @property {number} spfDebounceMs      delay between an LSDB change and route
 *   recomputation; 0 recomputes at once. Default 50.
 * @property {number} syncIntervalMs     interval between anti-entropy rounds. Default 20000.
 * @property {number} gossipBatchMs      how long new records are batched before being
 *   pushed; 0 pushes at once. Default 25.
 * @property {number} retransmitMinMs    first retransmission delay of a reliable message.
 *   Default 2000.
 * @property {number} retransmitMaxMs    retransmission delay cap; at least retransmitMinMs.
 *   Default 900000 (15 minutes).
 * @property {number} retransmitJitter   random spread applied to each retransmission delay,
 *   as a fraction 0..1 (not milliseconds). Default 0.2.
 * @property {number} transitHoldMs      how long a forwarder holds a packet that has no route.
 *   Default 30000.
 * @property {number} forwardDedupeTtlMs how long a forwarder remembers a routed packet it
 *   has forwarded, to drop copies of it. Default 60000.
 * @property {number} beaconIntervalMs   interval between LAN beacons. Default 5000.
 */

/**
 * @typedef {object} LimitsConfig
 * @property {number} ttl                 hop limit given to new packets, 1..32. Default 16.
 * @property {number} messageLifetimeMs   how long a reliable message is retried and how
 *   long its id stays in the replay cache, in milliseconds. Default 604800000 (7 days).
 * @property {number} seenCacheEntries    most message ids remembered for duplicate and
 *   replay suppression. Default 100000.
 * @property {number} outboxMaxEntries    most messages waiting for acknowledgement. Default 10000.
 * @property {number} outboxMaxBytes      most bytes of sealed messages in the outbox.
 *   Default 268435456.
 * @property {number} transitQueueMax     most packets held for destinations without a
 *   route; 0 disables holding. Default 1000.
 * @property {number} peerPacketsPerSec   per-peer rate limit for control packets (everything
 *   but routed DATA). Exceeding it is a protocol violation. Default 2000.
 * @property {number} peerBytesPerSec     per-peer byte rate limit for control packets.
 *   Default 16777216.
 * @property {number} dataPacketsPerSec   per-peer rate budget for routed DATA packets,
 *   separate from the control budget. A packet over budget is dropped and counted; the
 *   neighbour is not disconnected, since it may only be relaying someone else's flood.
 *   Default 1000.
 * @property {number} dataBytesPerSec     per-peer byte budget for routed DATA packets; at
 *   least one maximum-size routed packet (131072). Default 8388608.
 * @property {number} castPerOriginPerMin casts accepted per origin per minute; 0
 *   refuses all casts. Default 60.
 * @property {number} maxClockSkewMs      how far in the future a timestamp may lie, in
 *   milliseconds. Default 300000.
 * @property {number} maxInFlightPerDestination most unacknowledged reliable messages in
 *   flight to one destination; the rest wait in the outbox. Default 4.
 * @property {number} maxOrigins          most origins any per-origin table (LSAs, peer
 *   records, rate-limit state) holds. Default 10000.
 * @property {number} newOriginsPerPeerPerMin most previously unknown origins one
 *   neighbour may introduce per minute. Default 120.
 * @property {number} dialsPerSecond      global cap on outgoing connection attempts.
 *   Default 5.
 * @property {number} beaconsPerSourcePerMin LAN beacons accepted per source address per
 *   minute, counted before any signature is checked; at most beaconsPerMin. Default 30.
 * @property {number} beaconsPerMin       LAN beacons accepted per minute in total.
 *   Default 600.
 * @property {number} maxMessageBytes     largest sealed message (meta and content), in
 *   bytes; leaves room for the packet header and the sealing overhead inside one routed
 *   packet. Default 98304.
 */

/**
 * @typedef {object} FilesConfig
 * @property {string | null} downloadsDir absolute directory received files are written
 *   to. `loadConfig` fills in `<dataDir>/downloads`; `validateConfig` alone leaves the
 *   default null, which means the same thing to the file-transfer module.
 * @property {number} chunkSize    plaintext bytes per file chunk, 64..114688 (a chunk
 *   travels in one routed packet). Default 32768.
 * @property {number} window       chunks in flight per transfer, 1..1024. Default 32.
 * @property {"ask" | "auto" | "deny"} accept what to do with an incoming offer. Default "ask".
 * @property {number} maxSizeBytes largest file accepted, in bytes. Default 4294967296.
 */

/**
 * @typedef {object} MailboxConfig
 * @property {number} maxEntries           most packets held in custody. Default 10000.
 * @property {number} maxBytesTotal        most bytes held in custody overall. Default 268435456.
 * @property {number} maxBytesPerDepositor most bytes held for one depositor; at most
 *   maxBytesTotal. Default 16777216.
 */

/**
 * @typedef {object} LogConfig
 * @property {"debug" | "info" | "warn" | "error"} level least severe level written. Default "info".
 */

/**
 * @typedef {object} ClawNetConfig
 * @property {string} networkId   network name, 1..64 characters of [A-Za-z0-9._-]. Part
 *   of the handshake prologue: nodes with different names cannot link. A data directory
 *   belongs to the network it was first started on (see checkNetworkId). Default
 *   "clawnet-main".
 * @property {string | null} networkKey  optional pre-shared key, base64 of exactly 32
 *   bytes. When set, links use Noise XXpsk0 and nodes without the key cannot join.
 *   Default null.
 * @property {ListenConfig} listen         peer listener.
 * @property {string[]} advertise          addresses ("tcp://host:port") announced to
 *   other nodes in addition to observed ones; at most 16. Default [].
 * @property {ApiConfig} api               local control API.
 * @property {DiscoveryConfig} discovery   how peers are found.
 * @property {PeersConfig} peers           peer count targets and access lists.
 * @property {CapsConfig} caps             capabilities this node advertises.
 * @property {TimersConfig} timers         every interval and timeout.
 * @property {LimitsConfig} limits         resource bounds.
 * @property {FilesConfig} files           file transfer.
 * @property {MailboxConfig} mailbox       custody quotas, used when caps.mailbox is true.
 * @property {LogConfig} log               logging.
 */

/** File name looked up in the data directory when no config file is named. */
export const CONFIG_FILE_NAME = 'config.json';

/** Environment variable that names the data directory. */
export const DATA_DIR_ENV = 'CLAWNET_HOME';

/** Environment variable that names the config file, when `loadConfig` is not told. */
export const CONFIG_FILE_ENV = 'CLAWNET_CONFIG';

/** A config file larger than this is refused unread. */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** Longest delay accepted by setTimeout; larger values fire immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** File in the data directory that records the network the directory belongs to. */
export const NETWORK_ID_FILE_NAME = 'network-id';

/** A network-id file larger than this is refused unread: the id is at most 64 characters. */
const MAX_NETWORK_ID_FILE_BYTES = 256;

/**
 * Largest payload one routed packet can carry: a file chunk or a sealed message. Senders
 * keep routed packets within Limits.MAX_ROUTED_PACKET (DESIGN.md section 15 item 7), and
 * 16 KiB of that is kept back for the packet prefix, the header (at most 8 KiB) and the
 * sealing and AEAD framing.
 */
const MAX_ROUTED_PAYLOAD = Limits.MAX_ROUTED_PACKET - 16 * 1024;

const MAX_STORE_BYTES = 2 ** 40;
const MAX_PATH_LENGTH = 4096;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const NO_HOME_MESSAGE = `cannot be determined: no home directory; set ${DATA_DIR_ENV}`;

const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const ACCEPT_MODES = Object.freeze(['ask', 'auto', 'deny']);

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * The built-in defaults (DESIGN.md section 13).
 *
 * @returns {ClawNetConfig} a new object on every call; the caller may modify it freely
 */
export function defaultConfig() {
  return {
    networkId: 'clawnet-main',
    networkKey: null,
    listen: { host: '0.0.0.0', port: 47470 },
    advertise: [],
    api: {
      enabled: true,
      host: '127.0.0.1',
      port: 47480,
      allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
      corsOrigins: [],
      serveUi: true,
      allowRemote: false,
    },
    discovery: {
      multicast: { enabled: true, group: '239.255.67.78', port: 47470, interface: null },
      bootstrap: [],
      pex: true,
      allowLoopback: false,
    },
    peers: { target: 8, max: 64, allow: [], block: [] },
    caps: { relay: true, mailbox: false, transit: true },
    timers: {
      keepaliveMs: 10_000,
      peerTimeoutMs: 30_000,
      handshakeTimeoutMs: 10_000,
      redialMinMs: 1_000,
      redialMaxMs: 60_000,
      redialJitter: 0.2,
      lsaRefreshMs: 60_000,
      lsaMaxAgeMs: 210_000,
      lsaTombstoneMs: 86_400_000,
      lsaMinIntervalMs: 5_000,
      spfDebounceMs: 50,
      syncIntervalMs: 20_000,
      gossipBatchMs: 25,
      retransmitMinMs: 2_000,
      retransmitMaxMs: 900_000,
      retransmitJitter: 0.2,
      transitHoldMs: 30_000,
      forwardDedupeTtlMs: 60_000,
      beaconIntervalMs: 5_000,
    },
    limits: {
      ttl: 16,
      messageLifetimeMs: 604_800_000,
      seenCacheEntries: 100_000,
      outboxMaxEntries: 10_000,
      outboxMaxBytes: 268_435_456,
      transitQueueMax: 1_000,
      peerPacketsPerSec: 2_000,
      peerBytesPerSec: 16_777_216,
      dataPacketsPerSec: 1_000,
      dataBytesPerSec: 8_388_608,
      castPerOriginPerMin: 60,
      maxClockSkewMs: 300_000,
      maxInFlightPerDestination: 4,
      maxOrigins: 10_000,
      newOriginsPerPeerPerMin: 120,
      dialsPerSecond: 5,
      beaconsPerSourcePerMin: 30,
      beaconsPerMin: 600,
      maxMessageBytes: 98_304,
    },
    files: {
      downloadsDir: null,
      chunkSize: 32_768,
      window: 32,
      accept: 'ask',
      maxSizeBytes: 4_294_967_296,
    },
    mailbox: {
      maxEntries: 10_000,
      maxBytesTotal: 268_435_456,
      maxBytesPerDepositor: 16_777_216,
    },
    log: { level: 'info' },
  };
}

// ---------------------------------------------------------------------------
// Schema. A rule takes (value, path) and returns the normalized value or throws.
// ---------------------------------------------------------------------------

function fail(settingPath, message, options) {
  const error = new ConfigError(`${settingPath}: ${message}`, options);
  error.path = settingPath;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function integer(min, max) {
  return (value, at) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw fail(at, `must be an integer between ${min} and ${max}`);
    }
    return value;
  };
}

function fraction(min, max) {
  return (value, at) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw fail(at, `must be a number between ${min} and ${max}`);
    }
    return value;
  };
}

function boolean(value, at) {
  if (typeof value !== 'boolean') throw fail(at, 'must be true or false');
  return value;
}

function oneOf(choices) {
  const text = choices.map((choice) => `"${choice}"`).join(', ');
  return (value, at) => {
    if (typeof value !== 'string' || !choices.includes(value)) {
      throw fail(at, `must be one of ${text}`);
    }
    return value;
  };
}

function nullable(rule) {
  return (value, at) => (value === null ? null : rule(value, at));
}

/** A list of at most `maxItems` items; duplicates are dropped, first occurrence wins. */
function list(rule, maxItems) {
  return (value, at) => {
    if (!Array.isArray(value)) throw fail(at, 'must be a list');
    if (value.length > maxItems) throw fail(at, `must have at most ${maxItems} entries`);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < value.length; i += 1) {
      const item = rule(value[i], `${at}[${i}]`);
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  };
}

/** An object with exactly the given settings. */
function section(rules) {
  const names = Object.keys(rules);
  return (value, at) => {
    if (!isPlainObject(value)) throw fail(at || 'config', 'must be an object');
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !Object.hasOwn(rules, key)) {
        throw fail(joinPath(at, describeKey(key)), 'unknown setting');
      }
    }
    // Every setting is present: the value was merged over the defaults before it got
    // here, and a rule rejects `undefined` like any other wrong type.
    const out = {};
    for (const name of names) {
      const present = Object.hasOwn(value, name) ? value[name] : undefined;
      out[name] = rules[name](present, joinPath(at, name));
    }
    return out;
  };
}

function joinPath(base, name) {
  return base === '' ? name : `${base}.${name}`;
}

/** Name an unknown key in an error without letting it inject control characters. */
function describeKey(key) {
  if (typeof key !== 'string') return '<symbol>';
  const printable = key.replace(/[^\x21-\x7e]/g, '?');
  return printable.length > 64 ? `${printable.slice(0, 64)}...` : printable || '<empty>';
}

function networkId(value, at) {
  if (!isNetworkId(value)) {
    throw fail(at, 'must be 1 to 64 characters from A-Z, a-z, 0-9, ".", "_" and "-"');
  }
  return value;
}

function networkKey(value, at) {
  if (!isBase64Bytes(value, 32)) {
    throw fail(at, 'must be null or the base64 encoding of exactly 32 bytes');
  }
  return value;
}

function nodeId(value, at) {
  if (!isNodeId(value)) {
    throw fail(at, 'must be a canonical NodeId (51 lowercase base32 characters, then "a" or "q")');
  }
  return value;
}

function address(value, at) {
  if (parseAddress(value) === null) {
    throw fail(at, 'must be an address of the form tcp://host:port');
  }
  return value;
}

/** A host a socket can bind to: an IP literal (IPv6 without brackets) or a host name. */
function bindHost(value, at) {
  if (typeof value !== 'string' || !(isIPv4(value) || isPlainIPv6(value) || isDnsName(value))) {
    throw fail(at, 'must be an IP address (IPv6 without brackets) or a host name');
  }
  return value;
}

/** A value of the HTTP Host header, without port. */
function hostHeader(value, at) {
  if (typeof value === 'string' && value.length <= 255) {
    const host = value.toLowerCase();
    const bracketed = host.startsWith('[') && host.endsWith(']') && isPlainIPv6(host.slice(1, -1));
    if (bracketed || isIPv4(host) || isDnsName(host)) return host;
  }
  throw fail(
    at,
    'must be a host name, an IPv4 address or a bracketed IPv6 address, without a port',
  );
}

/** An exact web origin. A wildcard is refused: the API is protected by a bearer token. */
function origin(value, at) {
  if (typeof value === 'string' && value.length <= 300 && URL.canParse(value)) {
    const url = new URL(value);
    const web = url.protocol === 'http:' || url.protocol === 'https:';
    if (web && url.origin === value) return value;
  }
  throw fail(
    at,
    'must be an exact origin such as "http://localhost:5173" (scheme, host, optional port)',
  );
}

function multicastGroup(value, at) {
  if (typeof value === 'string' && isIPv4(value)) {
    const first = Number(value.slice(0, value.indexOf('.')));
    if (first >= 224 && first <= 239) return value;
  }
  throw fail(at, 'must be an IPv4 multicast address (224.0.0.0 to 239.255.255.255)');
}

function ipv4(value, at) {
  if (typeof value !== 'string' || !isIPv4(value)) {
    throw fail(at, 'must be null or an IPv4 address');
  }
  return value;
}

function absoluteDirectory(value, at) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw fail(at, 'must be null or an absolute directory path');
  }
  return path.resolve(value);
}

function isPlainIPv6(value) {
  return value.length <= 45 && !value.includes('%') && isIPv6(value);
}

const timer = integer(1, MAX_TIMER_MS);
const delay = integer(0, MAX_TIMER_MS);
const port = integer(0, 65535);

const checkConfig = section({
  networkId,
  networkKey: nullable(networkKey),
  listen: section({ host: bindHost, port }),
  advertise: list(address, Limits.MAX_PEER_ADDRS),
  api: section({
    enabled: boolean,
    host: bindHost,
    port,
    allowedHosts: list(hostHeader, 64),
    corsOrigins: list(origin, 64),
    serveUi: boolean,
    allowRemote: boolean,
  }),
  discovery: section({
    multicast: section({
      enabled: boolean,
      group: multicastGroup,
      port: integer(1, 65535),
      interface: nullable(ipv4),
    }),
    bootstrap: list(address, 256),
    pex: boolean,
    allowLoopback: boolean,
  }),
  peers: section({
    target: integer(0, 4096),
    max: integer(1, 4096),
    allow: list(nodeId, 4096),
    block: list(nodeId, 4096),
  }),
  caps: section({ relay: boolean, mailbox: boolean, transit: boolean }),
  timers: section({
    keepaliveMs: timer,
    peerTimeoutMs: timer,
    handshakeTimeoutMs: timer,
    redialMinMs: timer,
    redialMaxMs: timer,
    redialJitter: fraction(0, 1),
    lsaRefreshMs: timer,
    lsaMaxAgeMs: timer,
    lsaTombstoneMs: timer,
    lsaMinIntervalMs: delay,
    spfDebounceMs: delay,
    syncIntervalMs: timer,
    gossipBatchMs: delay,
    retransmitMinMs: timer,
    retransmitMaxMs: timer,
    retransmitJitter: fraction(0, 1),
    transitHoldMs: timer,
    forwardDedupeTtlMs: timer,
    beaconIntervalMs: timer,
  }),
  limits: section({
    ttl: integer(1, Limits.MAX_TTL),
    messageLifetimeMs: integer(1, ONE_YEAR_MS),
    seenCacheEntries: integer(1, 16_777_216),
    outboxMaxEntries: integer(1, 10_000_000),
    outboxMaxBytes: integer(1, MAX_STORE_BYTES),
    transitQueueMax: integer(0, 1_000_000),
    peerPacketsPerSec: integer(1, 1_000_000),
    peerBytesPerSec: integer(1, 2 ** 32),
    // A byte budget below one full routed packet would refuse such packets forever.
    dataPacketsPerSec: integer(1, 1_000_000),
    dataBytesPerSec: integer(Limits.MAX_ROUTED_PACKET, 2 ** 32),
    castPerOriginPerMin: integer(0, 100_000),
    maxClockSkewMs: integer(0, 86_400_000),
    maxInFlightPerDestination: integer(1, 1024),
    maxOrigins: integer(1, 1_000_000),
    newOriginsPerPeerPerMin: integer(1, 1_000_000),
    dialsPerSecond: integer(1, 10_000),
    beaconsPerSourcePerMin: integer(1, 100_000),
    beaconsPerMin: integer(1, 1_000_000),
    maxMessageBytes: integer(1, MAX_ROUTED_PAYLOAD),
  }),
  files: section({
    downloadsDir: nullable(absoluteDirectory),
    chunkSize: integer(64, MAX_ROUTED_PAYLOAD),
    window: integer(1, 1024),
    accept: oneOf(ACCEPT_MODES),
    maxSizeBytes: integer(0, Number.MAX_SAFE_INTEGER),
  }),
  mailbox: section({
    maxEntries: integer(0, 10_000_000),
    maxBytesTotal: integer(0, MAX_STORE_BYTES),
    maxBytesPerDepositor: integer(0, MAX_STORE_BYTES),
  }),
  log: section({ level: oneOf(LOG_LEVELS) }),
});

/** True if binding `host` exposes a socket only to this machine. */
function isLoopbackHost(host) {
  if (host.toLowerCase() === 'localhost') return true;
  if (isIPv4(host)) return LOOPBACK.check(host, 'ipv4');
  if (isIPv6(host)) return LOOPBACK.check(host, 'ipv6');
  return false;
}

/** Checks that involve more than one setting. Runs on an already normalized config. */
function checkCrossField(config) {
  const { timers, peers, api, listen, mailbox } = config;

  if (timers.peerTimeoutMs <= timers.keepaliveMs) {
    throw fail('timers.peerTimeoutMs', 'must be greater than timers.keepaliveMs');
  }
  if (timers.redialMaxMs < timers.redialMinMs) {
    throw fail('timers.redialMaxMs', 'must not be less than timers.redialMinMs');
  }
  if (timers.retransmitMaxMs < timers.retransmitMinMs) {
    throw fail('timers.retransmitMaxMs', 'must not be less than timers.retransmitMinMs');
  }
  if (timers.lsaMaxAgeMs <= timers.lsaRefreshMs) {
    throw fail('timers.lsaMaxAgeMs', 'must be greater than timers.lsaRefreshMs');
  }
  if (timers.lsaTombstoneMs < timers.lsaMaxAgeMs) {
    throw fail('timers.lsaTombstoneMs', 'must not be less than timers.lsaMaxAgeMs');
  }
  // The node refreshes its LSA every max(lsaRefreshMs, lsaMinIntervalMs); if that reached
  // lsaMaxAgeMs, every receiver would expire the LSA before its replacement arrived.
  if (timers.lsaMinIntervalMs >= timers.lsaMaxAgeMs) {
    throw fail('timers.lsaMinIntervalMs', 'must be less than timers.lsaMaxAgeMs');
  }

  if (config.limits.beaconsPerSourcePerMin > config.limits.beaconsPerMin) {
    throw fail('limits.beaconsPerSourcePerMin', 'must not be greater than limits.beaconsPerMin');
  }

  if (peers.target > peers.max) {
    throw fail('peers.target', 'must not be greater than peers.max');
  }
  const allowed = new Set(peers.allow);
  const conflict = peers.block.findIndex((id) => allowed.has(id));
  if (conflict !== -1) {
    throw fail(`peers.block[${conflict}]`, 'is also listed in peers.allow');
  }

  if (mailbox.maxBytesPerDepositor > mailbox.maxBytesTotal) {
    throw fail('mailbox.maxBytesPerDepositor', 'must not be greater than mailbox.maxBytesTotal');
  }

  if (!api.allowRemote && !isLoopbackHost(api.host)) {
    throw fail(
      'api.host',
      'must be a loopback address (127.0.0.1, ::1 or localhost) unless api.allowRemote is true',
    );
  }
  if (api.enabled && api.allowedHosts.length === 0) {
    throw fail('api.allowedHosts', 'must list at least one host while api.enabled is true');
  }
  if (api.enabled && api.port !== 0 && api.port === listen.port) {
    throw fail('api.port', 'must differ from listen.port');
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Define an own property; plain assignment to "__proto__" would change the prototype. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Lay `layer` over `base` without modifying either. Sections merge key by key; anything
 * else (scalars, lists, null) replaces the value beneath it; `undefined` changes nothing.
 * Unknown keys are carried along so that validation can report them with their path.
 */
function mergeLayer(base, layer) {
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;
  const out = {};
  for (const key of Object.keys(base)) setOwn(out, key, base[key]);
  for (const key of Object.keys(layer)) {
    const value = layer[key];
    if (value === undefined) continue;
    setOwn(out, key, Object.hasOwn(base, key) ? mergeLayer(base[key], value) : value);
  }
  return out;
}

function assertLayer(layer, what) {
  if (!isPlainObject(layer)) throw fail(what, 'must be an object');
}

/**
 * Validate a configuration and return its normalized, deep-frozen form.
 *
 * The argument may be partial: settings it omits take their defaults. It is not
 * modified, and the result shares no objects with it. Normalization lower-cases
 * `api.allowedHosts`, resolves `files.downloadsDir`, and drops duplicate list entries.
 *
 * @param {object} [config] full or partial configuration
 * @returns {Readonly<ClawNetConfig>}
 * @throws {ConfigError} naming the offending setting (`err.path`) for an unknown key, a
 *   wrong type, a value out of range, or settings that contradict each other
 */
export function validateConfig(config = {}) {
  assertLayer(config, 'config');
  const normalized = checkConfig(mergeLayer(defaultConfig(), config), '');
  checkCrossField(normalized);
  return deepFreeze(normalized);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function envText(value) {
  return value;
}

function envInteger(value, name) {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) throw fail(name, 'must be a non-negative integer');
  return Number(value);
}

function envBoolean(value, name) {
  const text = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw fail(name, 'must be one of true, false, 1, 0, yes, no, on, off');
}

function envList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Environment variable -> [path of the setting, parser of the variable's text]. */
const ENV_SETTINGS = Object.freeze({
  CLAWNET_NETWORK: [['networkId'], envText],
  CLAWNET_NETWORK_KEY: [['networkKey'], envText],
  CLAWNET_LISTEN_HOST: [['listen', 'host'], envText],
  CLAWNET_LISTEN_PORT: [['listen', 'port'], envInteger],
  CLAWNET_ADVERTISE: [['advertise'], envList],
  CLAWNET_API_ENABLED: [['api', 'enabled'], envBoolean],
  CLAWNET_API_HOST: [['api', 'host'], envText],
  CLAWNET_API_PORT: [['api', 'port'], envInteger],
  CLAWNET_API_ALLOW_REMOTE: [['api', 'allowRemote'], envBoolean],
  CLAWNET_BOOTSTRAP: [['discovery', 'bootstrap'], envList],
  CLAWNET_MULTICAST: [['discovery', 'multicast', 'enabled'], envBoolean],
  CLAWNET_PEX: [['discovery', 'pex'], envBoolean],
  CLAWNET_ALLOW_LOOPBACK: [['discovery', 'allowLoopback'], envBoolean],
  CLAWNET_PEERS_TARGET: [['peers', 'target'], envInteger],
  CLAWNET_PEERS_MAX: [['peers', 'max'], envInteger],
  CLAWNET_RELAY: [['caps', 'relay'], envBoolean],
  CLAWNET_MAILBOX: [['caps', 'mailbox'], envBoolean],
  CLAWNET_TRANSIT: [['caps', 'transit'], envBoolean],
  CLAWNET_DOWNLOADS_DIR: [['files', 'downloadsDir'], envText],
  CLAWNET_FILES_ACCEPT: [['files', 'accept'], envText],
  CLAWNET_LOG_LEVEL: [['log', 'level'], envText],
});

/**
 * The environment variables `loadConfig` reads, each with the setting it overrides.
 * Booleans accept true/false/1/0/yes/no/on/off; lists are comma-separated; a variable
 * that is empty or only whitespace counts as unset. CLAWNET_HOME and CLAWNET_CONFIG name
 * the data directory and the config file and are not settings.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CONFIG_ENV = Object.freeze(
  Object.fromEntries(Object.entries(ENV_SETTINGS).map(([name, [keys]]) => [name, keys.join('.')])),
);

/** Build a partial config from the CLAWNET_* variables that are set. */
function configFromEnv(env) {
  const layer = {};
  for (const [name, [keys, parse]] of Object.entries(ENV_SETTINGS)) {
    const raw = env[name];
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text === '') continue;
    let node = layer;
    for (const key of keys.slice(0, -1)) {
      node[key] ??= {};
      node = node[key];
    }
    node[keys.at(-1)] = parse(text, name);
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON config file.
 *
 * @param {string} file absolute path
 * @param {boolean} required false makes a missing file equivalent to an empty one
 * @returns {object} the parsed top-level object
 */
function readConfigFile(file, required) {
  let bytes;
  try {
    bytes = readBounded(file, MAX_CONFIG_FILE_BYTES);
  } catch (cause) {
    if (cause?.code === 'ENOENT' && !required) return {};
    throw describeReadFailure(file, 'config file', cause);
  }
  if (bytes === null) {
    throw fail(file, `config file is larger than ${MAX_CONFIG_FILE_BYTES} bytes`);
  }

  let text;
  try {
    // Not ignoring the byte-order mark means it is stripped: Windows editors add one.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail(file, 'config file is not valid UTF-8');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // The parser's own message quotes the text around the error, which could be part of
    // the network key, so only the position is passed on.
    throw fail(file, `config file is not valid JSON${describeJsonPosition(error, text)}`);
  }
  if (!isPlainObject(parsed)) throw fail(file, 'config file must contain a JSON object');
  return parsed;
}

function describeJsonPosition(error, text) {
  const match = /position (\d+)/.exec(String(error?.message));
  if (match === null) return '';
  const position = Math.min(Number(match[1]), text.length);
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return ` (line ${line}, column ${column})`;
}

/**
 * Read a regular file of at most `maxBytes` bytes.
 *
 * The path is examined before it is opened, so a FIFO or device is refused instead of
 * blocking or streaming forever, and again through the open descriptor, so a file swapped
 * in between is caught too. At most `maxBytes + 1` bytes are read, however large the file
 * has become in the meantime.
 *
 * @param {string} file
 * @param {number} maxBytes
 * @returns {Buffer | null} the content, or null when the file is larger than maxBytes
 * @throws {Error} the system error, or one with code "ENOTFILE" for anything but a
 *   regular file
 */
function readBounded(file, maxBytes) {
  if (!statSync(file).isFile()) throw notAFile();
  const fd = openSync(file, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw notAFile();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > maxBytes ? null : buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function notAFile() {
  const error = new Error('not a regular file');
  error.code = 'ENOTFILE';
  return error;
}

/** Turn a failure of readBounded into a ConfigError that names the file, not its content. */
function describeReadFailure(file, what, cause) {
  if (cause?.code === 'ENOTFILE') return fail(file, `${what} is not a regular file`);
  return fail(file, `${what} cannot be read (${cause?.code ?? 'unknown error'})`, { cause });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// ---------------------------------------------------------------------------
// The network a data directory belongs to (DESIGN.md section 15 item 3)
// ---------------------------------------------------------------------------

/**
 * The content to store in `<dataDir>/network-id` for a network: the id and a newline.
 *
 * @param {string} networkId a valid network id
 * @returns {string}
 * @throws {ConfigError} if `networkId` is not a valid network id
 */
export function formatNetworkIdFile(networkId) {
  return `${networkIdArgument(networkId)}\n`;
}

/**
 * Read the network id recorded in a data directory. Reads one small file and writes nothing.
 *
 * The file holds the id, optionally followed by "\n" or "\r\n" (an operator may have
 * edited it). Anything else is refused rather than guessed at, because the id decides
 * which network the identity in this directory may be used on.
 *
 * @param {string} dataDir the node's data directory
 * @returns {string | null} the recorded id, or null when the directory has none yet
 * @throws {ConfigError} if dataDir is not a usable path, or the file exists but cannot be
 *   read or does not hold a valid network id
 */
export function readRecordedNetworkId(dataDir) {
  const file = path.join(path.resolve(usablePath(dataDir, 'dataDir')), NETWORK_ID_FILE_NAME);
  let bytes;
  try {
    bytes = readBounded(file, MAX_NETWORK_ID_FILE_BYTES);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw describeReadFailure(file, 'network id file', cause);
  }
  // latin1 maps every byte to one character, so any non-ASCII byte fails the pattern.
  const text = bytes === null ? '' : bytes.toString('latin1').replace(/\r?\n$/, '');
  if (!isNetworkId(text)) {
    throw fail(file, 'network id file does not hold a valid network id');
  }
  return text;
}

/**
 * Check that a data directory may be used with the configured network.
 *
 * An identity belongs to one network, because signed records and identity cards do not
 * name their network. The node therefore records the network id the first time it starts
 * with a data directory and refuses to start with a different one. When this returns
 * `recorded: null` the caller must write `formatNetworkIdFile(networkId)` to `file`
 * atomically (vault/store.js `atomicWriteFile`) before it creates or opens the keystore,
 * so that no identity ever exists without a recorded network.
 *
 * @param {object} options
 * @param {string} options.dataDir   the node's data directory
 * @param {string} options.networkId the configured network id
 * @returns {{ recorded: string | null, file: string }} the id already recorded (equal to
 *   `networkId`), or null if none is; and the absolute path of the network-id file
 * @throws {ConfigError} with `err.path` "networkId" if the directory belongs to another
 *   network; or as readRecordedNetworkId
 */
export function checkNetworkId({ dataDir, networkId } = {}) {
  networkIdArgument(networkId);
  const file = path.join(path.resolve(usablePath(dataDir, 'dataDir')), NETWORK_ID_FILE_NAME);
  const recorded = readRecordedNetworkId(dataDir);
  if (recorded !== null && recorded !== networkId) {
    // Both ids are public (they travel in every handshake), so naming them is safe.
    throw fail(
      'networkId',
      `the data directory belongs to network "${recorded}", not "${networkId}"; ` +
        'use another data directory or the original network id',
    );
  }
  return { recorded, file };
}

function networkIdArgument(value) {
  if (!isNetworkId(value)) {
    throw fail('networkId', 'must be 1 to 64 characters from A-Z, a-z, 0-9, ".", "_" and "-"');
  }
  return value;
}

/**
 * Load the node configuration: defaults, then the config file, then CLAWNET_*
 * environment variables, then `overrides`; the result is validated and frozen.
 *
 * The config file is `file` if given, else `$CLAWNET_CONFIG`, else
 * `<dataDir>/config.json`. A file named explicitly must exist; the default one is
 * optional. `files.downloadsDir` defaults to `<dataDir>/downloads`, and a relative value
 * is resolved against `dataDir`. This function reads at most one file, synchronously,
 * and writes nothing.
 *
 * @param {object} options
 * @param {string} options.dataDir     the node's data directory (see resolveDataDir)
 * @param {string} [options.file]      config file path; relative paths are resolved
 *   against the current working directory
 * @param {object} [options.overrides] partial config applied last (CLI flags, tests)
 * @param {Record<string, string | undefined>} [options.env] environment; default process.env
 * @returns {Readonly<ClawNetConfig>}
 * @throws {ConfigError} if dataDir is missing, the file cannot be read or parsed, an
 *   environment variable is malformed, or the merged configuration is invalid
 */
export function loadConfig({ dataDir, file, overrides, env = process.env } = {}) {
  if (!nonEmptyString(dataDir) || dataDir.includes('\0')) {
    throw fail('dataDir', 'must be a non-empty path');
  }
  if (file !== undefined && (!nonEmptyString(file) || file.includes('\0'))) {
    throw fail('file', 'must be a non-empty path');
  }
  if (env === null || typeof env !== 'object') throw fail('env', 'must be an object');
  if (overrides !== undefined) assertLayer(overrides, 'overrides');
  const root = path.resolve(dataDir);

  const named = file ?? (nonEmptyString(env[CONFIG_FILE_ENV]) ? env[CONFIG_FILE_ENV] : undefined);
  const fromFile =
    named === undefined
      ? readConfigFile(path.join(root, CONFIG_FILE_NAME), false)
      : readConfigFile(path.resolve(named), true);

  let merged = mergeLayer(defaultConfig(), fromFile);
  merged = mergeLayer(merged, configFromEnv(env));
  if (overrides !== undefined) merged = mergeLayer(merged, overrides);

  if (isPlainObject(merged.files)) {
    const { downloadsDir } = merged.files;
    if (downloadsDir === null) {
      merged.files = { ...merged.files, downloadsDir: path.join(root, 'downloads') };
    } else if (nonEmptyString(downloadsDir) && !downloadsDir.includes('\0')) {
      merged.files = { ...merged.files, downloadsDir: path.resolve(root, downloadsDir) };
    }
  }
  return validateConfig(merged);
}

/**
 * Decide where the node keeps its data.
 *
 * Order: `explicit` (a command-line flag), then `$CLAWNET_HOME`, then the platform
 * default: `%APPDATA%\clawnet` on Windows (falling back to
 * `<home>\AppData\Roaming\clawnet` when APPDATA is unset) and `~/.clawnet` elsewhere.
 * Nothing is created or touched on disk.
 *
 * @param {object} [options]
 * @param {string} [options.explicit]  directory chosen by the user; wins when non-empty
 * @param {Record<string, string | undefined>} [options.env] default process.env
 * @param {string} [options.platform]  a `process.platform` value; default the current one
 * @param {string} [options.homedir]   the user's home directory; default os.homedir()
 * @returns {string} an absolute path in the syntax of `platform`
 * @throws {ConfigError} if a given value is not a usable path, or no location can be
 *   determined because the home directory is unknown
 */
export function resolveDataDir({
  explicit,
  env = process.env,
  platform = process.platform,
  homedir,
} = {}) {
  if (env === null || typeof env !== 'object') throw fail('env', 'must be an object');
  const paths = platform === 'win32' ? path.win32 : path.posix;

  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return paths.resolve(usablePath(explicit, 'dataDir'));
  }
  const fromEnv = env[DATA_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return paths.resolve(usablePath(fromEnv, DATA_DIR_ENV));
  }
  if (platform === 'win32' && env.APPDATA !== undefined && env.APPDATA !== '') {
    return paths.join(paths.resolve(usablePath(env.APPDATA, 'APPDATA')), 'clawnet');
  }

  let home = homedir;
  if (home === undefined) {
    try {
      home = osHomedir();
    } catch (cause) {
      throw fail('dataDir', NO_HOME_MESSAGE, { cause });
    }
  }
  if (!nonEmptyString(home)) throw fail('dataDir', NO_HOME_MESSAGE);
  const base = paths.resolve(usablePath(home, 'homedir'));
  return platform === 'win32'
    ? paths.join(base, 'AppData', 'Roaming', 'clawnet')
    : paths.join(base, '.clawnet');
}

function usablePath(value, name) {
  if (!nonEmptyString(value) || value.length > MAX_PATH_LENGTH || value.includes('\0')) {
    throw fail(name, 'must be a non-empty path');
  }
  return value;
}
