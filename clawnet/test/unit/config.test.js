import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  defaultConfig,
  validateConfig,
  loadConfig,
  resolveDataDir,
  checkNetworkId,
  formatNetworkIdFile,
  readRecordedNetworkId,
  CONFIG_ENV,
  CONFIG_FILE_NAME,
  NETWORK_ID_FILE_NAME,
} from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';
import { tempDir } from '../helpers/tmp.js';

const ID_A = 'a'.repeat(52);
const ID_B = `${'b'.repeat(51)}q`;
const KEY = Buffer.alloc(32, 0x42).toString('base64');

/** Build `{ a: { b: value } }` from "a.b". */
function at(settingPath, value) {
  const keys = settingPath.split('.');
  const root = {};
  let node = root;
  for (const key of keys.slice(0, -1)) {
    node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return root;
}

function get(object, settingPath) {
  return settingPath.split('.').reduce((node, key) => node[key], object);
}

/** Matcher for a ConfigError about one specific setting. */
function configError(settingPath, pattern = /./) {
  return (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'ERR_CONFIG');
    assert.equal(err.path, settingPath);
    assert.ok(err.message.startsWith(`${settingPath}: `), err.message);
    assert.match(err.message, pattern);
    return true;
  };
}

function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

test('defaultConfig returns the documented defaults', () => {
  assert.deepEqual(defaultConfig(), {
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
      keepaliveMs: 10000,
      peerTimeoutMs: 30000,
      handshakeTimeoutMs: 10000,
      redialMinMs: 1000,
      redialMaxMs: 60000,
      redialJitter: 0.2,
      lsaRefreshMs: 60000,
      lsaMaxAgeMs: 210000,
      lsaTombstoneMs: 86400000,
      lsaMinIntervalMs: 5000,
      spfDebounceMs: 50,
      syncIntervalMs: 20000,
      gossipBatchMs: 25,
      retransmitMinMs: 2000,
      retransmitMaxMs: 900000,
      retransmitJitter: 0.2,
      transitHoldMs: 30000,
      forwardDedupeTtlMs: 60000,
      beaconIntervalMs: 5000,
    },
    limits: {
      ttl: 16,
      messageLifetimeMs: 604800000,
      seenCacheEntries: 100000,
      outboxMaxEntries: 10000,
      outboxMaxBytes: 268435456,
      transitQueueMax: 1000,
      peerPacketsPerSec: 2000,
      peerBytesPerSec: 16777216,
      dataPacketsPerSec: 1000,
      dataBytesPerSec: 8388608,
      castPerOriginPerMin: 60,
      maxClockSkewMs: 300000,
      maxInFlightPerDestination: 4,
      maxOrigins: 10000,
      newOriginsPerPeerPerMin: 120,
      dialsPerSecond: 5,
      beaconsPerSourcePerMin: 30,
      beaconsPerMin: 600,
      maxMessageBytes: 98304,
    },
    files: { downloadsDir: null, chunkSize: 32768, window: 32, accept: 'ask', maxSizeBytes: 4294967296 },
    mailbox: { maxEntries: 10000, maxBytesTotal: 268435456, maxBytesPerDepositor: 16777216 },
    log: { level: 'info' },
  });
});

test('defaultConfig returns a fresh, independent object on every call', () => {
  const first = defaultConfig();
  first.listen.port = 1;
  first.api.allowedHosts.push('evil.example');
  first.peers.allow.push(ID_A);
  first.timers.keepaliveMs = 1;
  const second = defaultConfig();
  assert.equal(second.listen.port, 47470);
  assert.deepEqual(second.api.allowedHosts, ['127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual(second.peers.allow, []);
  assert.equal(second.timers.keepaliveMs, 10000);
  assert.ok(!Object.isFrozen(second));
});

test('the defaults are valid and validateConfig returns them deep-frozen', () => {
  for (const input of [undefined, {}, defaultConfig()]) {
    const config = validateConfig(input);
    assert.deepEqual(config, defaultConfig());
    assert.ok(isDeepFrozen(config));
  }
  const config = validateConfig();
  assert.throws(() => {
    config.listen.port = 1;
  }, TypeError);
  assert.throws(() => {
    config.peers.block.push(ID_A);
  }, TypeError);
  assert.throws(() => {
    config.extra = true;
  }, TypeError);
});

test('validateConfig merges a partial config over the defaults', () => {
  const config = validateConfig({
    networkId: 'lab',
    listen: { port: 0 },
    discovery: { multicast: { enabled: false } },
    timers: { keepaliveMs: 50, peerTimeoutMs: 200 },
    peers: { allow: [ID_A] },
  });
  assert.equal(config.networkId, 'lab');
  assert.deepEqual(config.listen, { host: '0.0.0.0', port: 0 });
  assert.deepEqual(config.discovery.multicast, {
    enabled: false,
    group: '239.255.67.78',
    port: 47470,
    interface: null,
  });
  assert.equal(config.discovery.pex, true);
  assert.equal(config.timers.keepaliveMs, 50);
  assert.equal(config.timers.peerTimeoutMs, 200);
  assert.equal(config.timers.lsaRefreshMs, 60000);
  assert.deepEqual(config.peers, { target: 8, max: 64, allow: [ID_A], block: [] });
  assert.deepEqual(config.caps, defaultConfig().caps);
});

test('undefined values in a partial config leave the default in place', () => {
  const config = validateConfig({ networkId: undefined, listen: { host: undefined, port: 5 }, api: undefined });
  assert.equal(config.networkId, 'clawnet-main');
  assert.deepEqual(config.listen, { host: '0.0.0.0', port: 5 });
  assert.deepEqual(config.api, defaultConfig().api);
});

test('lists replace the default list instead of being appended to it', () => {
  const config = validateConfig({ api: { allowedHosts: ['console.example'] } });
  assert.deepEqual(config.api.allowedHosts, ['console.example']);
});

test('validateConfig does not modify its input and shares nothing with it', () => {
  const input = {
    advertise: ['tcp://192.0.2.1:47470'],
    peers: { allow: [ID_A], block: [ID_B] },
    api: { allowedHosts: ['LocalHost'] },
  };
  const snapshot = structuredClone(input);
  const config = validateConfig(Object.freeze(input));
  assert.deepEqual(input, snapshot);
  assert.notEqual(config.advertise, input.advertise);
  assert.notEqual(config.peers.allow, input.peers.allow);
  assert.ok(!Object.isFrozen(input.advertise), 'the caller keeps a mutable array');
  input.advertise.push('tcp://192.0.2.2:1');
  assert.deepEqual(config.advertise, ['tcp://192.0.2.1:47470']);
});

test('validateConfig normalizes host case and drops duplicate list entries', () => {
  const config = validateConfig({
    api: { allowedHosts: ['LOCALHOST', 'localhost', 'Console.Example', '[::1]', '[::1]'] },
    discovery: { bootstrap: ['tcp://192.0.2.1:1', 'tcp://192.0.2.2:1', 'tcp://192.0.2.1:1'] },
    peers: { block: [ID_A, ID_A, ID_B] },
  });
  assert.deepEqual(config.api.allowedHosts, ['localhost', 'console.example', '[::1]']);
  assert.deepEqual(config.discovery.bootstrap, ['tcp://192.0.2.1:1', 'tcp://192.0.2.2:1']);
  assert.deepEqual(config.peers.block, [ID_A, ID_B]);
});

test('validateConfig is idempotent', () => {
  const once = validateConfig({ networkKey: KEY, peers: { target: 3, max: 5 }, log: { level: 'debug' } });
  const twice = validateConfig(once);
  assert.deepEqual(twice, once);
  assert.notEqual(twice, once);
});

test('unknown keys are rejected at every level, with their path', () => {
  const cases = [
    [{ lisen: {} }, 'lisen'],
    [{ networkID: 'x' }, 'networkID'],
    [{ listen: { prot: 1 } }, 'listen.prot'],
    [{ api: { allowedHost: [] } }, 'api.allowedHost'],
    [{ discovery: { multicast: { grp: 'x' } } }, 'discovery.multicast.grp'],
    [{ discovery: { mdns: true } }, 'discovery.mdns'],
    [{ timers: { keepalive: 10 } }, 'timers.keepalive'],
    [{ timers: { keepAliveMs: 10 } }, 'timers.keepAliveMs'],
    [{ limits: { TTL: 3 } }, 'limits.TTL'],
    [{ files: { dir: '/x' } }, 'files.dir'],
    [{ mailbox: { quota: 1 } }, 'mailbox.quota'],
    [{ log: { verbose: true } }, 'log.verbose'],
    [{ caps: { admin: true } }, 'caps.admin'],
    [{ peers: { deny: [] } }, 'peers.deny'],
    [{ dataDir: '/x' }, 'dataDir'],
  ];
  for (const [config, settingPath] of cases) {
    assert.throws(() => validateConfig(config), configError(settingPath, /unknown setting/), settingPath);
  }
});

test('unknown keys with unusual names are reported without control characters', () => {
  assert.throws(() => validateConfig({ 'bad\nkey\tname': 1 }), configError('bad?key?name', /unknown setting/));
  assert.throws(() => validateConfig({ '': 1 }), configError('<empty>', /unknown setting/));
  assert.throws(
    () => validateConfig({ ['k'.repeat(500)]: 1 }),
    (err) => err instanceof ConfigError && err.message.length < 120,
  );
});

test('a "__proto__" key from JSON is an unknown setting and pollutes nothing', () => {
  const parsed = JSON.parse('{"__proto__":{"allowRemote":true},"api":{"__proto__":{"allowRemote":true}}}');
  assert.throws(() => validateConfig(parsed), configError('__proto__', /unknown setting/));
  const nested = JSON.parse('{"api":{"__proto__":{"allowRemote":true}}}');
  assert.throws(() => validateConfig(nested), configError('api.__proto__', /unknown setting/));
  assert.equal({}.allowRemote, undefined);
  assert.equal(validateConfig().api.allowRemote, false);
});

test('a config or section that is not an object is rejected', () => {
  for (const value of [null, 5, 'x', [], true, new Map()]) {
    assert.throws(() => validateConfig(value), configError('config', /must be an object/));
  }
  for (const name of ['listen', 'api', 'discovery', 'peers', 'caps', 'timers', 'limits', 'files', 'mailbox', 'log']) {
    for (const value of [null, 5, 'x', [], true]) {
      assert.throws(() => validateConfig({ [name]: value }), configError(name, /must be an object/), name);
    }
  }
  assert.throws(
    () => validateConfig({ discovery: { multicast: false } }),
    configError('discovery.multicast', /must be an object/),
  );
});

test('every setting rejects values of the wrong type or out of range', () => {
  const cases = [
    ['networkId', '', /1 to 64 characters/],
    ['networkId', 'x'.repeat(65), /1 to 64 characters/],
    ['networkId', 'has space', /1 to 64 characters/],
    ['networkId', 7, /1 to 64 characters/],
    ['networkId', null, /1 to 64 characters/],
    ['networkKey', '', /32 bytes/],
    ['networkKey', Buffer.alloc(31).toString('base64'), /32 bytes/],
    ['networkKey', Buffer.alloc(33).toString('base64'), /32 bytes/],
    ['networkKey', Buffer.alloc(32).toString('hex'), /32 bytes/],
    ['networkKey', Buffer.alloc(32).toString('base64url'), /32 bytes/],
    ['networkKey', 12345, /32 bytes/],
    ['listen.host', '', /IP address/],
    ['listen.host', '[::1]', /without brackets/],
    ['listen.host', '1.2.3', /IP address/],
    ['listen.host', 'fe80::1%eth0', /IP address/],
    ['listen.host', 'bad host', /IP address/],
    ['listen.host', 0, /IP address/],
    ['listen.port', -1, /between 0 and 65535/],
    ['listen.port', 65536, /between 0 and 65535/],
    ['listen.port', 1.5, /integer/],
    ['listen.port', '47470', /integer/],
    ['listen.port', null, /integer/],
    ['advertise', 'tcp://192.0.2.1:1', /must be a list/],
    ['advertise', Array.from({ length: 17 }, (_, i) => `tcp://192.0.2.${i + 1}:1`), /at most 16 entries/],
    ['api.enabled', 'yes', /true or false/],
    ['api.enabled', 1, /true or false/],
    ['api.port', 70000, /between 0 and 65535/],
    ['api.allowedHosts', 'localhost', /must be a list/],
    ['api.corsOrigins', {}, /must be a list/],
    ['api.serveUi', null, /true or false/],
    ['api.allowRemote', 'false', /true or false/],
    ['discovery.multicast.enabled', 0, /true or false/],
    ['discovery.multicast.group', '192.0.2.1', /multicast/],
    ['discovery.multicast.group', '223.255.255.255', /multicast/],
    ['discovery.multicast.group', '240.0.0.1', /multicast/],
    ['discovery.multicast.group', 'ff02::1', /multicast/],
    ['discovery.multicast.group', null, /multicast/],
    ['discovery.multicast.port', 0, /between 1 and 65535/],
    ['discovery.multicast.interface', 'eth0', /IPv4 address/],
    ['discovery.multicast.interface', '::1', /IPv4 address/],
    ['discovery.bootstrap', Array.from({ length: 257 }, (_, i) => `tcp://10.0.${i >> 8}.${i & 255}:1`), /at most 256/],
    ['discovery.pex', 'true', /true or false/],
    ['peers.target', -1, /between 0 and 4096/],
    ['peers.target', 2.5, /integer/],
    ['peers.max', 0, /between 1 and 4096/],
    ['peers.max', 4097, /between 1 and 4096/],
    ['peers.allow', ID_A, /must be a list/],
    ['caps.relay', 'true', /true or false/],
    ['caps.mailbox', null, /true or false/],
    ['caps.transit', 1, /true or false/],
    ['timers.keepaliveMs', 0, /between 1 and 2147483647/],
    ['timers.keepaliveMs', 2147483648, /between 1 and 2147483647/],
    ['timers.keepaliveMs', 10.5, /integer/],
    ['timers.keepaliveMs', '10000', /integer/],
    ['timers.keepaliveMs', NaN, /integer/],
    ['timers.keepaliveMs', Infinity, /integer/],
    ['timers.handshakeTimeoutMs', 0, /between 1 and/],
    ['timers.redialJitter', -0.1, /between 0 and 1/],
    ['timers.redialJitter', 1.1, /between 0 and 1/],
    ['timers.redialJitter', NaN, /between 0 and 1/],
    ['timers.redialJitter', '0.2', /between 0 and 1/],
    ['timers.spfDebounceMs', -1, /between 0 and/],
    ['timers.gossipBatchMs', -1, /between 0 and/],
    ['timers.syncIntervalMs', 0, /between 1 and/],
    ['timers.transitHoldMs', null, /integer/],
    ['timers.beaconIntervalMs', 0, /between 1 and/],
    ['limits.ttl', 0, /between 1 and 32/],
    ['limits.ttl', 33, /between 1 and 32/],
    ['limits.messageLifetimeMs', 0, /between 1 and/],
    ['limits.seenCacheEntries', 0, /between 1 and/],
    ['limits.outboxMaxEntries', 0, /between 1 and/],
    ['limits.outboxMaxBytes', 2 ** 41, /between 1 and/],
    ['limits.transitQueueMax', -1, /between 0 and/],
    ['limits.peerPacketsPerSec', 0, /between 1 and/],
    ['limits.peerBytesPerSec', 0, /between 1 and/],
    ['limits.castPerOriginPerMin', -1, /between 0 and/],
    ['limits.maxClockSkewMs', -1, /between 0 and/],
    ['limits.maxClockSkewMs', 86400001, /between 0 and 86400000/],
    ['files.downloadsDir', '', /absolute directory path/],
    ['files.downloadsDir', 'relative/dir', /absolute directory path/],
    ['files.downloadsDir', 7, /absolute directory path/],
    ['files.downloadsDir', `${path.resolve('x')}\0y`, /absolute directory path/],
    ['files.chunkSize', 63, /between 64 and 114688/],
    ['files.chunkSize', 114689, /between 64 and 114688/],
    ['files.chunkSize', 1032192, /between 64 and 114688/],
    ['discovery.allowLoopback', 'true', /true or false/],
    ['discovery.allowLoopback', null, /true or false/],
    ['timers.lsaMinIntervalMs', -1, /between 0 and 2147483647/],
    ['timers.lsaMinIntervalMs', 1.5, /integer/],
    ['timers.retransmitJitter', -0.01, /between 0 and 1/],
    ['timers.retransmitJitter', 1.01, /between 0 and 1/],
    ['timers.retransmitJitter', '0.2', /between 0 and 1/],
    ['timers.forwardDedupeTtlMs', 0, /between 1 and 2147483647/],
    ['timers.forwardDedupeTtlMs', 2147483648, /between 1 and 2147483647/],
    ['limits.dataPacketsPerSec', 0, /between 1 and 1000000/],
    ['limits.dataBytesPerSec', 131071, /between 131072 and 4294967296/],
    ['limits.dataBytesPerSec', 2 ** 32 + 1, /between 131072 and 4294967296/],
    ['limits.maxInFlightPerDestination', 0, /between 1 and 1024/],
    ['limits.maxInFlightPerDestination', 1025, /between 1 and 1024/],
    ['limits.maxOrigins', 0, /between 1 and 1000000/],
    ['limits.newOriginsPerPeerPerMin', 0, /between 1 and/],
    ['limits.dialsPerSecond', 0, /between 1 and 10000/],
    ['limits.dialsPerSecond', 10001, /between 1 and 10000/],
    ['limits.beaconsPerSourcePerMin', 0, /between 1 and/],
    ['limits.beaconsPerMin', 0, /between 1 and/],
    ['limits.maxMessageBytes', 0, /between 1 and 114688/],
    ['limits.maxMessageBytes', 114689, /between 1 and 114688/],
    ['limits.maxMessageBytes', '98304', /integer/],
    ['files.window', 0, /between 1 and 1024/],
    ['files.window', 1025, /between 1 and 1024/],
    ['files.accept', 'always', /"ask", "auto", "deny"/],
    ['files.accept', 'ASK', /"ask", "auto", "deny"/],
    ['files.accept', true, /"ask", "auto", "deny"/],
    ['files.maxSizeBytes', -1, /integer/],
    ['files.maxSizeBytes', 2 ** 53, /integer/],
    ['mailbox.maxEntries', -1, /between 0 and/],
    ['mailbox.maxBytesTotal', 2 ** 41, /between 0 and/],
    ['mailbox.maxBytesPerDepositor', -1, /between 0 and/],
    ['log.level', 'trace', /"debug", "info", "warn", "error"/],
    ['log.level', 'INFO', /"debug", "info", "warn", "error"/],
    ['log.level', 3, /"debug", "info", "warn", "error"/],
  ];
  for (const [settingPath, value, pattern] of cases) {
    assert.throws(
      () => validateConfig(at(settingPath, value)),
      configError(settingPath, pattern),
      `${settingPath} = ${String(value).slice(0, 40)}`,
    );
  }
});

test('list items are validated individually and reported with their index', () => {
  const cases = [
    ['advertise', ['tcp://192.0.2.1:1', 'udp://192.0.2.1:1'], 'advertise[1]', /tcp:\/\/host:port/],
    ['advertise', ['tcp://192.0.2.1:0'], 'advertise[0]', /tcp:\/\/host:port/],
    ['advertise', [42], 'advertise[0]', /tcp:\/\/host:port/],
    ['discovery.bootstrap', ['tcp://ok.example:1', 'ok.example:1'], 'discovery.bootstrap[1]', /tcp:\/\/host:port/],
    ['peers.allow', [ID_A, 'short'], 'peers.allow[1]', /NodeId/],
    ['peers.block', ['A'.repeat(52)], 'peers.block[0]', /NodeId/],
    ['peers.block', [`${'a'.repeat(51)}b`], 'peers.block[0]', /NodeId/],
    ['api.allowedHosts', ['localhost', 'localhost:47480'], 'api.allowedHosts[1]', /without a port/],
    ['api.allowedHosts', ['::1'], 'api.allowedHosts[0]', /bracketed IPv6/],
    ['api.allowedHosts', ['*'], 'api.allowedHosts[0]', /host name/],
    ['api.allowedHosts', [''], 'api.allowedHosts[0]', /host name/],
    ['api.allowedHosts', [null], 'api.allowedHosts[0]', /host name/],
    ['api.corsOrigins', ['*'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['localhost:5173'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['http://localhost:5173/'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['http://localhost:5173/app'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['HTTP://LOCALHOST:5173'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['https://example.org:443'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['file:///tmp/x'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['null'], 'api.corsOrigins[0]', /exact origin/],
    ['api.corsOrigins', ['http://ok.example', 7], 'api.corsOrigins[1]', /exact origin/],
  ];
  for (const [settingPath, value, errorPath, pattern] of cases) {
    assert.throws(() => validateConfig(at(settingPath, value)), configError(errorPath, pattern), errorPath);
  }
});

test('values at the edge of each range are accepted', () => {
  const accepted = [
    ['networkId', 'x'.repeat(64)],
    ['networkKey', KEY],
    ['listen.host', '::'],
    ['listen.host', '2001:db8::1'],
    ['listen.host', 'node.example.org'],
    ['listen.port', 0],
    ['listen.port', 65535],
    ['advertise', Array.from({ length: 16 }, (_, i) => `tcp://192.0.2.${i + 1}:1`)],
    ['api.port', 0],
    ['api.corsOrigins', ['http://localhost:5173', 'https://console.example.org']],
    ['api.allowedHosts', ['192.0.2.7', '[2001:db8::1]', 'a.b.example']],
    ['discovery.multicast.group', '224.0.0.1'],
    ['discovery.multicast.group', '239.255.255.255'],
    ['discovery.multicast.port', 1],
    ['discovery.multicast.interface', '192.0.2.9'],
    ['peers.target', 0],
    ['peers.max', 4096],
    ['timers.redialJitter', 0],
    ['timers.redialJitter', 1],
    ['timers.spfDebounceMs', 0],
    ['timers.gossipBatchMs', 0],
    ['timers.beaconIntervalMs', 1],
    ['timers.lsaTombstoneMs', 2147483647],
    ['limits.ttl', 1],
    ['limits.ttl', 32],
    ['limits.transitQueueMax', 0],
    ['limits.castPerOriginPerMin', 0],
    ['limits.maxClockSkewMs', 0],
    ['files.chunkSize', 64],
    ['files.chunkSize', 114688],
    ['discovery.allowLoopback', true],
    ['timers.lsaMinIntervalMs', 0],
    ['timers.retransmitJitter', 0],
    ['timers.retransmitJitter', 1],
    ['timers.retransmitMaxMs', 2147483647],
    ['timers.forwardDedupeTtlMs', 1],
    ['limits.dataPacketsPerSec', 1],
    ['limits.dataBytesPerSec', 131072],
    ['limits.dataBytesPerSec', 2 ** 32],
    ['limits.maxInFlightPerDestination', 1],
    ['limits.maxInFlightPerDestination', 1024],
    ['limits.maxOrigins', 1],
    ['limits.dialsPerSecond', 10000],
    ['limits.beaconsPerSourcePerMin', 1],
    ['limits.maxMessageBytes', 1],
    ['limits.maxMessageBytes', 114688],
    ['files.window', 1],
    ['files.window', 1024],
    ['files.accept', 'auto'],
    ['files.accept', 'deny'],
    ['files.maxSizeBytes', 0],
    ['files.maxSizeBytes', Number.MAX_SAFE_INTEGER],
    ['mailbox.maxEntries', 0],
    ['log.level', 'debug'],
    ['log.level', 'error'],
  ];
  for (const [settingPath, value] of accepted) {
    const config = validateConfig(at(settingPath, value));
    assert.deepEqual(get(config, settingPath), value, settingPath);
  }
});

test('files.downloadsDir must be absolute and is normalized', () => {
  const dir = path.resolve('some', 'place');
  assert.equal(validateConfig({ files: { downloadsDir: dir } }).files.downloadsDir, dir);
  // Built by hand: path.join would already remove the ".." this test is about.
  const messy = [dir, 'sub', '..', '.', 'downloads'].join(path.sep);
  assert.ok(messy.includes('..'));
  assert.equal(validateConfig({ files: { downloadsDir: messy } }).files.downloadsDir, path.join(dir, 'downloads'));
  assert.equal(validateConfig().files.downloadsDir, null);
});

test('timers that only make sense together are checked together', () => {
  const cases = [
    [{ timers: { keepaliveMs: 30000, peerTimeoutMs: 30000 } }, 'timers.peerTimeoutMs', /greater than timers\.keepaliveMs/],
    [{ timers: { keepaliveMs: 40000 } }, 'timers.peerTimeoutMs', /greater than timers\.keepaliveMs/],
    [{ timers: { peerTimeoutMs: 5000 } }, 'timers.peerTimeoutMs', /greater than timers\.keepaliveMs/],
    [{ timers: { redialMinMs: 5000, redialMaxMs: 4999 } }, 'timers.redialMaxMs', /less than timers\.redialMinMs/],
    [{ timers: { redialMinMs: 60001 } }, 'timers.redialMaxMs', /less than timers\.redialMinMs/],
    [{ timers: { retransmitMinMs: 900001 } }, 'timers.retransmitMaxMs', /less than timers\.retransmitMinMs/],
    [{ timers: { retransmitMinMs: 70000, retransmitMaxMs: 60000 } }, 'timers.retransmitMaxMs', /less than timers\.retransmitMinMs/],
    // The node's own LSA would expire everywhere before it may be refreshed.
    [{ timers: { lsaRefreshMs: 1000, lsaMaxAgeMs: 3000 } }, 'timers.lsaMinIntervalMs', /less than timers\.lsaMaxAgeMs/],
    [{ timers: { lsaMinIntervalMs: 210000 } }, 'timers.lsaMinIntervalMs', /less than timers\.lsaMaxAgeMs/],
    [{ timers: { lsaRefreshMs: 210000 } }, 'timers.lsaMaxAgeMs', /greater than timers\.lsaRefreshMs/],
    [{ timers: { lsaMaxAgeMs: 60000 } }, 'timers.lsaMaxAgeMs', /greater than timers\.lsaRefreshMs/],
    [{ timers: { lsaTombstoneMs: 209999 } }, 'timers.lsaTombstoneMs', /less than timers\.lsaMaxAgeMs/],
  ];
  for (const [config, settingPath, pattern] of cases) {
    assert.throws(() => validateConfig(config), configError(settingPath, pattern), settingPath);
  }
  // Equal bounds are fine where the rule is "not less than".
  const config = validateConfig({
    timers: {
      redialMinMs: 500,
      redialMaxMs: 500,
      retransmitMinMs: 700,
      retransmitMaxMs: 700,
      lsaRefreshMs: 100,
      lsaMaxAgeMs: 101,
      lsaTombstoneMs: 101,
      lsaMinIntervalMs: 100,
      keepaliveMs: 10,
      peerTimeoutMs: 11,
    },
  });
  assert.equal(config.timers.redialMaxMs, 500);
  assert.equal(config.timers.lsaTombstoneMs, 101);
  assert.equal(config.timers.peerTimeoutMs, 11);
});

test('peer and mailbox settings are checked against each other', () => {
  assert.throws(() => validateConfig({ peers: { target: 65 } }), configError('peers.target', /greater than peers\.max/));
  assert.throws(() => validateConfig({ peers: { max: 7 } }), configError('peers.target', /greater than peers\.max/));
  assert.equal(validateConfig({ peers: { target: 64 } }).peers.target, 64);

  assert.throws(
    () => validateConfig({ limits: { beaconsPerSourcePerMin: 601 } }),
    configError('limits.beaconsPerSourcePerMin', /greater than limits\.beaconsPerMin/),
  );
  assert.throws(
    () => validateConfig({ limits: { beaconsPerMin: 29 } }),
    configError('limits.beaconsPerSourcePerMin', /greater than limits\.beaconsPerMin/),
  );
  assert.equal(validateConfig({ limits: { beaconsPerSourcePerMin: 600 } }).limits.beaconsPerSourcePerMin, 600);

  assert.throws(
    () => validateConfig({ peers: { allow: [ID_A, ID_B], block: [ID_B] } }),
    configError('peers.block[0]', /also listed in peers\.allow/),
  );
  assert.throws(
    () => validateConfig({ mailbox: { maxBytesTotal: 1000, maxBytesPerDepositor: 1001 } }),
    configError('mailbox.maxBytesPerDepositor', /greater than mailbox\.maxBytesTotal/),
  );
  assert.equal(
    validateConfig({ mailbox: { maxBytesTotal: 1000, maxBytesPerDepositor: 1000 } }).mailbox.maxBytesPerDepositor,
    1000,
  );
});

test('api.host must be loopback unless api.allowRemote is true', () => {
  const loopback = ['127.0.0.1', '127.8.9.10', '::1', '0:0:0:0:0:0:0:1', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1'];
  for (const host of loopback) {
    assert.equal(validateConfig({ api: { host } }).api.host, host, host);
  }
  const exposed = ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', '128.0.0.1', '2001:db8::1', '::ffff:192.0.2.1', 'node.example.org', 'localhost.example.org'];
  for (const host of exposed) {
    assert.throws(() => validateConfig({ api: { host } }), configError('api.host', /loopback/), host);
    assert.throws(
      () => validateConfig({ api: { host, enabled: false } }),
      configError('api.host', /loopback/),
      `${host} (disabled)`,
    );
    const config = validateConfig({ api: { host, allowRemote: true } });
    assert.equal(config.api.host, host);
    assert.equal(config.api.allowRemote, true);
  }
});

test('the API cannot be enabled with an empty host allowlist or on the peer port', () => {
  assert.throws(
    () => validateConfig({ api: { allowedHosts: [] } }),
    configError('api.allowedHosts', /at least one host/),
  );
  assert.deepEqual(validateConfig({ api: { enabled: false, allowedHosts: [] } }).api.allowedHosts, []);

  assert.throws(() => validateConfig({ api: { port: 47470 } }), configError('api.port', /differ from listen\.port/));
  assert.throws(() => validateConfig({ listen: { port: 47480 } }), configError('api.port', /differ from listen\.port/));
  // Two ephemeral ports never collide, and a disabled API binds nothing.
  const config = validateConfig({ listen: { port: 0 }, api: { port: 0 } });
  assert.equal(config.api.port, 0);
  assert.equal(validateConfig({ api: { enabled: false, port: 47470 } }).api.port, 47470);
});

test('error messages never repeat the rejected value', () => {
  const secret = 'c2VjcmV0LW5ldHdvcmsta2V5LW5vdC1mb3ItbG9ncw';
  assert.throws(
    () => validateConfig({ networkKey: secret }),
    (err) => err instanceof ConfigError && !err.message.includes(secret) && !err.message.includes('c2Vj'),
  );
  assert.throws(
    () => validateConfig({ networkId: 'top secret name' }),
    (err) => err instanceof ConfigError && !err.message.includes('top secret'),
  );
});

test('loadConfig with no file, no environment and no overrides gives the defaults', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const config = loadConfig({ dataDir, env: {} });
  const expected = defaultConfig();
  expected.files.downloadsDir = path.join(dataDir, 'downloads');
  assert.deepEqual(config, expected);
  assert.ok(isDeepFrozen(config));
});

test('loadConfig reads config.json from the data directory', async (t) => {
  const dataDir = await tempDir(t, 'config');
  writeFileSync(
    path.join(dataDir, CONFIG_FILE_NAME),
    JSON.stringify({ networkId: 'from-file', listen: { port: 5000 }, peers: { target: 2 }, networkKey: KEY }),
  );
  const config = loadConfig({ dataDir, env: {} });
  assert.equal(config.networkId, 'from-file');
  assert.equal(config.networkKey, KEY);
  assert.deepEqual(config.listen, { host: '0.0.0.0', port: 5000 });
  assert.equal(config.peers.target, 2);
  assert.equal(config.peers.max, 64);
});

test('loadConfig layers defaults, file, environment and overrides in that order', async (t) => {
  const dataDir = await tempDir(t, 'config');
  writeFileSync(
    path.join(dataDir, CONFIG_FILE_NAME),
    JSON.stringify({
      networkId: 'file',
      listen: { host: '127.0.0.1', port: 1111 },
      api: { port: 2222 },
      log: { level: 'warn' },
      peers: { target: 3 },
    }),
  );
  const env = { CLAWNET_NETWORK: 'env', CLAWNET_LISTEN_PORT: '3333', CLAWNET_LOG_LEVEL: 'debug' };
  const overrides = { networkId: 'override', log: { level: 'error' } };

  const fileOnly = loadConfig({ dataDir, env: {} });
  assert.equal(fileOnly.networkId, 'file');
  assert.equal(fileOnly.listen.port, 1111);
  assert.equal(fileOnly.log.level, 'warn');

  const withEnv = loadConfig({ dataDir, env });
  assert.equal(withEnv.networkId, 'env');
  assert.equal(withEnv.listen.port, 3333);
  assert.equal(withEnv.listen.host, '127.0.0.1', 'the file value survives where env is silent');
  assert.equal(withEnv.log.level, 'debug');

  const all = loadConfig({ dataDir, env, overrides });
  assert.equal(all.networkId, 'override');
  assert.equal(all.log.level, 'error');
  assert.equal(all.listen.port, 3333, 'env still wins where overrides are silent');
  assert.equal(all.api.port, 2222);
  assert.equal(all.peers.target, 3);
  assert.equal(all.peers.max, 64, 'defaults fill the rest');
});

test('loadConfig maps every documented environment variable', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const downloads = path.join(dataDir, 'incoming');
  const env = {
    CLAWNET_NETWORK: 'lab-net',
    CLAWNET_NETWORK_KEY: KEY,
    CLAWNET_LISTEN_HOST: '127.0.0.1',
    CLAWNET_LISTEN_PORT: '0',
    CLAWNET_ADVERTISE: 'tcp://192.0.2.1:47470, tcp://node.example.org:47470',
    CLAWNET_API_ENABLED: 'no',
    CLAWNET_API_HOST: '0.0.0.0',
    CLAWNET_API_PORT: '8080',
    CLAWNET_API_ALLOW_REMOTE: 'TRUE',
    CLAWNET_BOOTSTRAP: 'tcp://192.0.2.9:1,,tcp://[2001:db8::1]:2,',
    CLAWNET_MULTICAST: 'off',
    CLAWNET_PEX: '0',
    CLAWNET_ALLOW_LOOPBACK: 'on',
    CLAWNET_PEERS_TARGET: '4',
    CLAWNET_PEERS_MAX: '10',
    CLAWNET_RELAY: 'false',
    CLAWNET_MAILBOX: 'yes',
    CLAWNET_TRANSIT: 'Off',
    CLAWNET_DOWNLOADS_DIR: downloads,
    CLAWNET_FILES_ACCEPT: 'deny',
    CLAWNET_LOG_LEVEL: 'warn',
  };
  assert.deepEqual(Object.keys(CONFIG_ENV).sort(), Object.keys(env).sort());

  const config = loadConfig({ dataDir, env });
  assert.equal(config.networkId, 'lab-net');
  assert.equal(config.networkKey, KEY);
  assert.deepEqual(config.listen, { host: '127.0.0.1', port: 0 });
  assert.deepEqual(config.advertise, ['tcp://192.0.2.1:47470', 'tcp://node.example.org:47470']);
  assert.equal(config.api.enabled, false);
  assert.equal(config.api.host, '0.0.0.0');
  assert.equal(config.api.port, 8080);
  assert.equal(config.api.allowRemote, true);
  assert.deepEqual(config.discovery.bootstrap, ['tcp://192.0.2.9:1', 'tcp://[2001:db8::1]:2']);
  assert.equal(config.discovery.multicast.enabled, false);
  assert.equal(config.discovery.pex, false);
  assert.equal(config.discovery.allowLoopback, true);
  assert.deepEqual(config.peers, { target: 4, max: 10, allow: [], block: [] });
  assert.deepEqual(config.caps, { relay: false, mailbox: true, transit: false });
  assert.equal(config.files.downloadsDir, downloads);
  assert.equal(config.files.accept, 'deny');
  assert.equal(config.log.level, 'warn');

  // Each variable is documented with the setting it really changes.
  for (const [name, settingPath] of Object.entries(CONFIG_ENV)) {
    assert.notDeepEqual(get(config, settingPath), get(defaultConfig(), settingPath), name);
  }
});

test('empty and unrelated environment variables are ignored', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const config = loadConfig({
    dataDir,
    env: {
      CLAWNET_NETWORK: '',
      CLAWNET_LISTEN_PORT: '   ',
      CLAWNET_BOOTSTRAP: '',
      CLAWNET_HOME: '/somewhere/else',
      CLAWNET_UNKNOWN_SETTING: 'x',
      PATH: '/usr/bin',
      CLAWNET_PEX: undefined,
    },
  });
  assert.equal(config.networkId, 'clawnet-main');
  assert.equal(config.listen.port, 47470);
  assert.deepEqual(config.discovery.bootstrap, []);
  assert.equal(config.discovery.pex, true);
});

test('malformed environment variables are rejected by name', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const cases = [
    ['CLAWNET_LISTEN_PORT', 'abc', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_LISTEN_PORT', '-1', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_LISTEN_PORT', '47470.0', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_LISTEN_PORT', '0x50', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_LISTEN_PORT', '1e3', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_LISTEN_PORT', '080', 'CLAWNET_LISTEN_PORT', /non-negative integer/],
    ['CLAWNET_API_PORT', '99999999999999999999', 'CLAWNET_API_PORT', /non-negative integer/],
    ['CLAWNET_PEX', 'maybe', 'CLAWNET_PEX', /true, false/],
    ['CLAWNET_API_ENABLED', '2', 'CLAWNET_API_ENABLED', /true, false/],
    ['CLAWNET_MAILBOX', 'enabled', 'CLAWNET_MAILBOX', /true, false/],
    // Well-formed text with an invalid meaning is caught by validation, by setting path.
    ['CLAWNET_LISTEN_PORT', '70000', 'listen.port', /between 0 and 65535/],
    ['CLAWNET_LOG_LEVEL', 'loud', 'log.level', /one of/],
    ['CLAWNET_BOOTSTRAP', 'tcp://192.0.2.1:1,nonsense', 'discovery.bootstrap[1]', /tcp:\/\/host:port/],
    ['CLAWNET_NETWORK_KEY', 'not-a-key', 'networkKey', /32 bytes/],
    ['CLAWNET_API_HOST', '0.0.0.0', 'api.host', /loopback/],
    ['CLAWNET_PEERS_MAX', '2', 'peers.target', /greater than peers\.max/],
  ];
  for (const [name, value, errorPath, pattern] of cases) {
    assert.throws(() => loadConfig({ dataDir, env: { [name]: value } }), configError(errorPath, pattern), `${name}=${value}`);
  }
});

test('files.downloadsDir defaults to the data directory and relative values resolve against it', async (t) => {
  const dataDir = await tempDir(t, 'config');
  assert.equal(loadConfig({ dataDir, env: {} }).files.downloadsDir, path.join(dataDir, 'downloads'));
  assert.equal(
    loadConfig({ dataDir, env: {}, overrides: { files: { downloadsDir: 'inbox' } } }).files.downloadsDir,
    path.join(dataDir, 'inbox'),
  );
  assert.equal(
    loadConfig({ dataDir, env: { CLAWNET_DOWNLOADS_DIR: path.join('a', 'b') } }).files.downloadsDir,
    path.join(dataDir, 'a', 'b'),
  );
  const elsewhere = path.resolve(dataDir, '..', 'elsewhere');
  assert.equal(
    loadConfig({ dataDir, env: {}, overrides: { files: { downloadsDir: elsewhere } } }).files.downloadsDir,
    elsewhere,
  );
  assert.throws(
    () => loadConfig({ dataDir, env: {}, overrides: { files: { downloadsDir: 5 } } }),
    configError('files.downloadsDir', /absolute directory path/),
  );
  assert.throws(
    () => loadConfig({ dataDir, env: {}, overrides: { files: 'nope' } }),
    configError('files', /must be an object/),
  );
});

test('a relative dataDir is resolved before it is used', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const relative = path.relative(process.cwd(), dataDir);
  // On Windows the temp dir can be on another drive, where no relative path exists.
  if (path.isAbsolute(relative)) {
    t.skip('temp directory is not reachable by a relative path');
    return;
  }
  const config = loadConfig({ dataDir: relative, env: {} });
  assert.equal(config.files.downloadsDir, path.join(dataDir, 'downloads'));
});

test('an explicitly named config file is used instead of the default one and must exist', async (t) => {
  const dataDir = await tempDir(t, 'config');
  writeFileSync(path.join(dataDir, CONFIG_FILE_NAME), JSON.stringify({ networkId: 'default-file' }));
  const other = path.join(dataDir, 'other.json');
  writeFileSync(other, JSON.stringify({ networkId: 'named-file' }));

  assert.equal(loadConfig({ dataDir, file: other, env: {} }).networkId, 'named-file');
  assert.equal(loadConfig({ dataDir, env: { CLAWNET_CONFIG: other } }).networkId, 'named-file');
  // The argument beats the environment variable.
  assert.equal(
    loadConfig({ dataDir, file: path.join(dataDir, CONFIG_FILE_NAME), env: { CLAWNET_CONFIG: other } }).networkId,
    'default-file',
  );

  const missing = path.join(dataDir, 'missing.json');
  assert.throws(() => loadConfig({ dataDir, file: missing, env: {} }), configError(missing, /cannot be read \(ENOENT\)/));
  assert.throws(
    () => loadConfig({ dataDir, env: { CLAWNET_CONFIG: missing } }),
    configError(missing, /cannot be read \(ENOENT\)/),
  );
});

test('a broken config file is rejected with the file name and no file contents', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const file = path.join(dataDir, CONFIG_FILE_NAME);

  writeFileSync(file, `{\n  "networkId": "x",\n  "networkKey": "${KEY}" oops\n}`);
  assert.throws(
    () => loadConfig({ dataDir, env: {} }),
    (err) => {
      configError(file, /not valid JSON \(line 3, column \d+\)/)(err);
      assert.ok(!err.message.includes(KEY.slice(0, 8)), 'the key must not leak into the message');
      assert.equal(err.cause, undefined, 'the parser error quotes the file and must not be attached');
      return true;
    },
  );

  for (const text of ['', '   ', '{', 'networkId: x', '{"a":1,}']) {
    writeFileSync(file, text);
    assert.throws(() => loadConfig({ dataDir, env: {} }), configError(file, /not valid JSON/), JSON.stringify(text));
  }
  for (const text of ['[]', 'null', '"text"', '42', 'true']) {
    writeFileSync(file, text);
    assert.throws(() => loadConfig({ dataDir, env: {} }), configError(file, /must contain a JSON object/), text);
  }

  writeFileSync(file, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]));
  assert.throws(() => loadConfig({ dataDir, env: {} }), configError(file, /not valid UTF-8/));

  writeFileSync(file, JSON.stringify({ listen: { port: 'eighty' } }));
  assert.throws(() => loadConfig({ dataDir, env: {} }), configError('listen.port', /integer/));

  writeFileSync(file, JSON.stringify({ lisen: { port: 80 } }));
  assert.throws(() => loadConfig({ dataDir, env: {} }), configError('lisen', /unknown setting/));
});

test('a config file with a byte-order mark is accepted', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const body = Buffer.from(JSON.stringify({ networkId: 'bom-file' }), 'utf8');
  writeFileSync(path.join(dataDir, CONFIG_FILE_NAME), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  assert.equal(loadConfig({ dataDir, env: {} }).networkId, 'bom-file');
});

test('an oversized config file and a directory in its place are refused', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const file = path.join(dataDir, CONFIG_FILE_NAME);
  writeFileSync(file, `{"networkId":"x"}${' '.repeat(1024 * 1024)}`);
  assert.throws(() => loadConfig({ dataDir, env: {} }), configError(file, /larger than 1048576 bytes/));

  const other = await tempDir(t, 'config');
  mkdirSync(path.join(other, CONFIG_FILE_NAME));
  assert.throws(
    () => loadConfig({ dataDir: other, env: {} }),
    configError(path.join(other, CONFIG_FILE_NAME), /not a regular file/),
  );
});

test('a config file exactly at the size limit is read, one byte more is not', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const file = path.join(dataDir, CONFIG_FILE_NAME);
  const body = '{"networkId":"edge"}';
  writeFileSync(file, body + ' '.repeat(1024 * 1024 - body.length));
  assert.equal(loadConfig({ dataDir, env: {} }).networkId, 'edge');
  writeFileSync(file, body + ' '.repeat(1024 * 1024 - body.length + 1));
  assert.throws(() => loadConfig({ dataDir, env: {} }), configError(file, /larger than 1048576 bytes/));
});

test('a data directory records its network and refuses another one', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const file = path.join(dataDir, NETWORK_ID_FILE_NAME);
  assert.equal(NETWORK_ID_FILE_NAME, 'network-id');

  // Nothing recorded yet: the caller is told where to record it, and nothing is written.
  assert.equal(readRecordedNetworkId(dataDir), null);
  assert.deepEqual(checkNetworkId({ dataDir, networkId: 'lab-net' }), { recorded: null, file });
  assert.equal(existsSync(file), false);

  assert.equal(formatNetworkIdFile('lab-net'), 'lab-net\n');
  writeFileSync(file, formatNetworkIdFile('lab-net'));
  assert.equal(readRecordedNetworkId(dataDir), 'lab-net');
  assert.deepEqual(checkNetworkId({ dataDir, networkId: 'lab-net' }), { recorded: 'lab-net', file });

  assert.throws(
    () => checkNetworkId({ dataDir, networkId: 'clawnet-main' }),
    configError('networkId', /belongs to network "lab-net", not "clawnet-main"/),
  );
  // Comparison is exact: no case folding, no trimming beyond one line ending.
  assert.throws(() => checkNetworkId({ dataDir, networkId: 'Lab-net' }), configError('networkId'));

  // An operator's hand edit with a Windows line ending, or none, still reads.
  for (const content of ['lab-net', 'lab-net\r\n']) {
    writeFileSync(file, content);
    assert.equal(readRecordedNetworkId(dataDir), 'lab-net', JSON.stringify(content));
  }
});

test('a damaged network-id file stops the node instead of being guessed at', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const file = path.join(dataDir, NETWORK_ID_FILE_NAME);
  const damaged = ['', '\n', 'lab net\n', 'lab-net\n\n', ' lab-net', 'lab-net\nother\n', `${'x'.repeat(65)}\n`, Buffer.from([0x6c, 0xe9, 0x0a]), 'x'.repeat(300)];
  for (const content of damaged) {
    writeFileSync(file, content);
    assert.throws(() => readRecordedNetworkId(dataDir), configError(file, /does not hold a valid network id/), JSON.stringify(String(content)).slice(0, 30));
    assert.throws(() => checkNetworkId({ dataDir, networkId: 'lab-net' }), configError(file));
  }

  const other = await tempDir(t, 'config');
  mkdirSync(path.join(other, NETWORK_ID_FILE_NAME));
  assert.throws(() => readRecordedNetworkId(other), configError(path.join(other, NETWORK_ID_FILE_NAME), /not a regular file/));
});

test('the network-id helpers validate their arguments', async (t) => {
  const dataDir = await tempDir(t, 'config');
  for (const networkId of [undefined, '', 'has space', 'x'.repeat(65), 7]) {
    assert.throws(() => checkNetworkId({ dataDir, networkId }), configError('networkId', /1 to 64 characters/));
    assert.throws(() => formatNetworkIdFile(networkId), configError('networkId', /1 to 64 characters/));
  }
  for (const bad of [undefined, '', '   ', 'a\0b', 7]) {
    assert.throws(() => readRecordedNetworkId(bad), configError('dataDir'));
    assert.throws(() => checkNetworkId({ dataDir: bad, networkId: 'x' }), configError('dataDir'));
  }
});

test('loadConfig validates its own arguments', async (t) => {
  const dataDir = await tempDir(t, 'config');
  for (const bad of [undefined, null, '', '   ', 5, {}, 'a\0b']) {
    assert.throws(() => loadConfig({ dataDir: bad, env: {} }), configError('dataDir', /non-empty path/));
  }
  assert.throws(() => loadConfig(), configError('dataDir', /non-empty path/));
  for (const bad of [null, '', 7, 'x\0y']) {
    assert.throws(() => loadConfig({ dataDir, file: bad, env: {} }), configError('file', /non-empty path/));
  }
  for (const bad of [null, 'x', 5, []]) {
    assert.throws(() => loadConfig({ dataDir, env: {}, overrides: bad }), configError('overrides', /must be an object/));
  }
  for (const bad of [null, 'x', 5]) {
    assert.throws(() => loadConfig({ dataDir, env: bad }), configError('env', /must be an object/));
  }
});

test('loadConfig reads process.env when no environment is given', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const name = 'CLAWNET_LOG_LEVEL';
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  process.env[name] = 'error';
  assert.equal(loadConfig({ dataDir }).log.level, 'error');
});

test('loadConfig does not modify the overrides it is given', async (t) => {
  const dataDir = await tempDir(t, 'config');
  const overrides = { files: { downloadsDir: 'inbox' }, peers: { allow: [ID_A] } };
  const before = structuredClone(overrides);
  loadConfig({ dataDir, env: {}, overrides });
  assert.deepEqual(overrides, before);
});

test('resolveDataDir prefers the explicit directory, then CLAWNET_HOME', () => {
  const posix = { platform: 'linux', homedir: '/home/ada' };
  assert.equal(resolveDataDir({ ...posix, explicit: '/srv/claw', env: { CLAWNET_HOME: '/env/home' } }), '/srv/claw');
  assert.equal(resolveDataDir({ ...posix, env: { CLAWNET_HOME: '/env/home' } }), '/env/home');
  assert.equal(resolveDataDir({ ...posix, explicit: '', env: { CLAWNET_HOME: '/env/home' } }), '/env/home');
  assert.equal(resolveDataDir({ ...posix, explicit: undefined, env: { CLAWNET_HOME: '' } }), '/home/ada/.clawnet');
  assert.equal(resolveDataDir({ ...posix, explicit: '/srv/claw/../data/.', env: {} }), '/srv/data');

  const windows = { platform: 'win32', homedir: 'C:\\Users\\ada' };
  assert.equal(
    resolveDataDir({ ...windows, explicit: 'D:\\claw', env: { CLAWNET_HOME: 'E:\\env', APPDATA: 'C:\\AppData' } }),
    'D:\\claw',
  );
  assert.equal(resolveDataDir({ ...windows, env: { CLAWNET_HOME: 'E:\\env', APPDATA: 'C:\\AppData' } }), 'E:\\env');
});

test('resolveDataDir falls back to the platform default', () => {
  assert.equal(resolveDataDir({ platform: 'linux', homedir: '/home/ada', env: {} }), '/home/ada/.clawnet');
  assert.equal(resolveDataDir({ platform: 'darwin', homedir: '/Users/ada', env: {} }), '/Users/ada/.clawnet');
  // APPDATA is a Windows convention and is ignored elsewhere.
  assert.equal(
    resolveDataDir({ platform: 'linux', homedir: '/home/ada', env: { APPDATA: '/weird' } }),
    '/home/ada/.clawnet',
  );
  assert.equal(
    resolveDataDir({
      platform: 'win32',
      homedir: 'C:\\Users\\ada',
      env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
    }),
    'C:\\Users\\ada\\AppData\\Roaming\\clawnet',
  );
  assert.equal(
    resolveDataDir({ platform: 'win32', homedir: 'C:\\Users\\ada', env: {} }),
    'C:\\Users\\ada\\AppData\\Roaming\\clawnet',
  );
  assert.equal(
    resolveDataDir({ platform: 'win32', homedir: 'C:\\Users\\ada', env: { APPDATA: '' } }),
    'C:\\Users\\ada\\AppData\\Roaming\\clawnet',
  );
});

test('resolveDataDir uses the real environment by default and returns an absolute path', (t) => {
  const previous = process.env.CLAWNET_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAWNET_HOME;
    else process.env.CLAWNET_HOME = previous;
  });
  delete process.env.CLAWNET_HOME;
  const fallback = resolveDataDir();
  assert.ok(path.isAbsolute(fallback));
  assert.match(path.basename(fallback), /^\.?clawnet$/);

  const chosen = path.resolve('claw-data-dir');
  process.env.CLAWNET_HOME = chosen;
  assert.equal(resolveDataDir(), chosen);
  assert.equal(resolveDataDir({}), chosen);
});

test('resolveDataDir rejects unusable input', () => {
  const base = { platform: 'linux', homedir: '/home/ada', env: {} };
  assert.throws(() => resolveDataDir({ ...base, explicit: 5 }), configError('dataDir', /non-empty path/));
  assert.throws(() => resolveDataDir({ ...base, explicit: '   ' }), configError('dataDir', /non-empty path/));
  assert.throws(() => resolveDataDir({ ...base, explicit: '/a\0b' }), configError('dataDir', /non-empty path/));
  assert.throws(
    () => resolveDataDir({ ...base, env: { CLAWNET_HOME: '  ' } }),
    configError('CLAWNET_HOME', /non-empty path/),
  );
  assert.throws(() => resolveDataDir({ ...base, env: null }), configError('env', /must be an object/));
  for (const homedir of ['', '  ', null, 7]) {
    assert.throws(
      () => resolveDataDir({ platform: 'linux', env: {}, homedir }),
      configError('dataDir', /no home directory; set CLAWNET_HOME/),
    );
  }
});
