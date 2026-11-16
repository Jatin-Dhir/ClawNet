import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import { deriveBeaconKey } from '../../src/core/crypto/envelope.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { BEACON_MAX_BYTES, authenticateBeacon, encodeBeacon, parseBeacon } from '../../src/core/discovery/beacon.js';
import { DialGovernor } from '../../src/core/discovery/dial-governor.js';
import { MulticastDiscovery } from '../../src/core/discovery/multicast.js';
import { ConfigError, HandshakeError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';

const NOW = 1_700_000_000_000;
const GROUP = '239.255.67.78';
const NETWORK = 'testnet';

// ---------------------------------------------------------------------------------------
// A fake datagram transport: the subset of dgram.Socket the module uses, recording what
// it is asked to do and letting a test deliver datagrams from any source address.
// ---------------------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  calls = [];
  sent = [];
  closed = 0;
  /** Set to "bind", "membership" or "send" to make that step fail. */
  failOn = null;

  bind(options, done) {
    this.calls.push(['bind', options]);
    if (this.failOn === 'bind') {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('bind EACCES'), { code: 'EACCES' })));
      return;
    }
    queueMicrotask(done);
  }

  address() {
    return { address: '0.0.0.0', family: 'IPv4', port: this.calls[0][1].port || 40_000 };
  }

  setMulticastTTL(ttl) {
    this.calls.push(['ttl', ttl]);
  }

  setMulticastLoopback(on) {
    this.calls.push(['loopback', on]);
  }

  setMulticastInterface(iface) {
    this.calls.push(['interface', iface]);
  }

  addMembership(group, iface) {
    this.calls.push(['membership', group, iface]);
    if (this.failOn === 'membership') throw Object.assign(new Error('addMembership ENODEV'), { code: 'ENODEV' });
  }

  send(message, port, address, done) {
    this.sent.push({ message: Buffer.from(message), port, address });
    queueMicrotask(() => done(this.failOn === 'send' ? Object.assign(new Error('send ENETUNREACH'), { code: 'ENETUNREACH' }) : null));
  }

  close(done) {
    this.closed += 1;
    done?.();
  }

  deliver(bytes, address = '192.168.1.20') {
    const message = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    this.emit('message', message, { address, family: 'IPv4', port: 54_321, size: message.length });
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

/** JSON with every object's keys in sorted order at every depth, which is canonical for a beacon. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function harness(overrides = {}) {
  const self = overrides.identity ?? Identity.generate();
  const clock = { wall: NOW, mono: 10_000 };
  const socket = new FakeSocket();
  const dials = [];
  const candidates = [];
  const timers = [];
  const events = new EventBus({ now: () => clock.wall });
  const governor = new DialGovernor({ monoNow: () => clock.mono, rng: () => 0.5, dialsPerSecond: 1000 });
  const options = {
    identity: self,
    networkId: NETWORK,
    networkKey: null,
    group: GROUP,
    port: 47_470,
    iface: null,
    listenPort: () => 47_470,
    intervalMs: 5000,
    maxClockSkewMs: 300_000,
    beaconsPerSourcePerMin: 30,
    beaconsPerMin: 600,
    allowLoopback: false,
    isKnown: () => false,
    dial: (address, hint) => {
      dials.push({ address, hint });
      return Promise.resolve({ id: hint.id });
    },
    governor,
    onCandidate: candidate => candidates.push(candidate),
    events,
    now: () => clock.wall,
    monoNow: () => clock.mono,
    rng: () => 0.5,
    createSocket: () => socket,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  };
  const module = new MulticastDiscovery(options);
  return { module, socket, dials, candidates, timers, events, clock, governor, self, options };
}

/** A beacon from a fresh identity (or the given one). */
function beaconFrom(overrides = {}) {
  const identity = overrides.identity ?? Identity.generate();
  const bytes = encodeBeacon({
    identity,
    networkId: NETWORK,
    port: 47_480,
    ts: NOW,
    beaconKey: null,
    ...overrides,
  });
  return { identity, bytes };
}

const eventsOf = (events, type) => events.recent({ types: [type] }).map(e => e.data);

// ---------------------------------------------------------------------------------------
// Sending and the socket
// ---------------------------------------------------------------------------------------

test('start binds as configured, joins the group and announces at once', async t => {
  const { module, socket, timers, self } = harness({ iface: '127.0.0.1', port: 47_470 });
  t.after(() => module.stop());
  assert.equal(await module.start(), true);
  assert.deepEqual(socket.calls, [
    ['bind', { port: 47_470, address: '127.0.0.1', exclusive: false }],
    ['ttl', 1],
    ['loopback', true],
    ['interface', '127.0.0.1'],
    ['membership', GROUP, '127.0.0.1'],
  ]);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].address, GROUP);
  assert.equal(socket.sent[0].port, 47_470);
  const beacon = parseBeacon(socket.sent[0].message);
  assert.equal(beacon.ok, true);
  assert.equal(beacon.beacon.origin, self.nodeId);
  assert.equal(beacon.beacon.port, 47_470);
  assert.equal(beacon.beacon.net, NETWORK);
  assert.equal(beacon.beacon.ts, NOW);
  assert.deepEqual(authenticateBeacon(beacon.beacon, null), { ok: true });
  // The next one is scheduled one interval (give or take the jitter) from now.
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
});

test('without an interface the socket binds the wildcard address and leaves the interface to the OS', async t => {
  const { module, socket } = harness({ iface: null });
  t.after(() => module.stop());
  await module.start();
  assert.deepEqual(socket.calls[0], ['bind', { port: 47_470, address: undefined, exclusive: false }]);
  assert.equal(socket.calls.some(call => call[0] === 'interface'), false);
  assert.deepEqual(socket.calls.at(-1), ['membership', GROUP, undefined]);
});

test('beacons repeat with the interval, carry the current listen port, and stop with the module', async () => {
  let listen = 47_470;
  const { module, socket, timers, clock } = harness({ listenPort: () => listen, rng: () => 1 });
  await module.start();
  assert.equal(timers.at(-1).ms, 5500, 'jitter spreads the interval by up to 10%');
  clock.wall += 5000;
  listen = 51_000;
  timers.at(-1).fn();
  assert.equal(socket.sent.length, 2);
  assert.equal(parseBeacon(socket.sent[1].message).beacon.port, 51_000);
  assert.equal(parseBeacon(socket.sent[1].message).beacon.ts, NOW + 5000);
  assert.equal(timers.length, 2, 'the next beacon is scheduled');

  await module.stop();
  assert.equal(timers.at(-1).cancelled, true);
  assert.equal(socket.closed, 1);
  await module.stop();
  assert.equal(socket.closed, 1, 'stop is idempotent');
  assert.equal(module.announce(), false, 'nothing is sent after stop');
  assert.equal(socket.sent.length, 2);
});

test('no beacon is sent while the node is not listening', async t => {
  let listen = null;
  const { module, socket } = harness({ listenPort: () => listen });
  t.after(() => module.stop());
  await module.start();
  assert.equal(socket.sent.length, 0);
  listen = 47_470;
  assert.equal(module.announce(), true);
  assert.equal(socket.sent.length, 1);
  listen = 0;
  assert.equal(module.announce(), false);
});

test('a beacon on a keyed network carries a MAC that the receiver checks', async t => {
  const networkKey = randomBytes(32);
  const { module, socket } = harness({ networkKey });
  t.after(() => module.stop());
  await module.start();
  const beacon = parseBeacon(socket.sent[0].message).beacon;
  assert.equal(typeof beacon.mac, 'string');
  assert.deepEqual(authenticateBeacon(beacon, deriveBeaconKey(networkKey)), { ok: true });
});

test('a socket error disables multicast: counted, reported once, never thrown', async t => {
  for (const failOn of ['bind', 'membership']) {
    const { module, socket, events } = harness();
    socket.failOn = failOn;
    assert.equal(await module.start(), false, failOn);
    const stats = module.stats();
    assert.equal(stats.disabled, 1);
    assert.equal(stats.socketErrors, 1);
    assert.equal(socket.sent.length, 0);
    assert.equal(socket.closed, 1, 'the socket is released');
    const reports = eventsOf(events, 'discovery.error');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].source, 'multicast');
    assert.match(reports[0].message, failOn === 'bind' ? /EACCES/ : /ENODEV/);
    // Later errors are counted but not reported again, and datagrams are ignored.
    socket.emit('error', new Error('again'));
    assert.equal(module.stats().socketErrors, 2);
    assert.equal(eventsOf(events, 'discovery.error').length, 1);
    await module.stop();
  }

  // A failed send after a good start disables it too.
  const { module, socket, events, dials } = harness();
  t.after(() => module.stop());
  socket.failOn = 'send';
  assert.equal(await module.start(), true, 'the first send has not failed yet');
  await tick();
  assert.equal(module.stats().disabled, 1);
  assert.equal(eventsOf(events, 'discovery.error').length, 1);
  assert.match(eventsOf(events, 'discovery.error')[0].message, /ENETUNREACH/);
  socket.deliver(beaconFrom().bytes);
  assert.equal(dials.length, 0, 'a disabled module dials nothing');
});

test('a socket that cannot even be created is a disabled module, not an exception', async () => {
  const { module, events } = harness({
    createSocket: () => {
      throw new Error('EMFILE');
    },
  });
  assert.equal(await module.start(), false);
  assert.equal(eventsOf(events, 'discovery.error').length, 1);
  await module.stop();
});

// ---------------------------------------------------------------------------------------
// Receiving: what becomes a candidate
// ---------------------------------------------------------------------------------------

test('a valid beacon yields one candidate at the datagram source address and the beacon port', async t => {
  const { module, socket, dials, candidates, events } = harness();
  t.after(() => module.stop());
  await module.start();
  const { identity, bytes } = beaconFrom({ port: 47_999 });
  socket.deliver(bytes, '192.168.7.33');
  await tick();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, identity.nodeId);
  assert.equal(candidates[0].addr, 'tcp://192.168.7.33:47999');
  assert.equal(candidates[0].source, 'multicast');
  assert.deepEqual(candidates[0].card, identity.card);
  assert.deepEqual(dials, [{ address: 'tcp://192.168.7.33:47999', hint: { id: identity.nodeId, source: 'multicast' } }]);
  assert.deepEqual(eventsOf(events, 'discovery.candidate'), [
    { addr: 'tcp://192.168.7.33:47999', peer: identity.nodeId, source: 'multicast' },
  ]);
  const stats = module.stats();
  assert.equal(stats.candidates, 1);
  assert.equal(stats.dialsStarted, 1);
  assert.equal(stats.dialsOk, 1);

  // The same beacon again is a candidate again (the node may have lost the link) but is
  // announced as an event only the first time. The dial is gated by the governor: the
  // first has finished, so the IP is free.
  socket.deliver(bytes, '192.168.7.33');
  await tick();
  assert.equal(candidates.length, 2);
  assert.equal(eventsOf(events, 'discovery.candidate').length, 1);
  assert.equal(dials.length, 2);
});

test('the address comes from the datagram, never from the beacon', async t => {
  const { module, socket, dials } = harness();
  t.after(() => module.stop());
  await module.start();
  // The record has no address field to lie about: a beacon is what its signature covers.
  const { bytes } = beaconFrom({ port: 47_480 });
  for (const field of ['addr', 'addrs', 'host', 'ip']) assert.equal(bytes.toString().includes(`"${field}"`), false);
  socket.deliver(bytes, '10.9.8.7');
  await tick();
  assert.equal(dials[0].address, 'tcp://10.9.8.7:47480');
});

test('beacons that must be ignored produce no candidate and no dial', async t => {
  const { module, socket, dials, candidates, self } = harness();
  t.after(() => module.stop());
  await module.start();
  const counters = () => module.stats();

  // wrong network
  socket.deliver(beaconFrom({ networkId: 'othernet' }).bytes);
  assert.equal(counters().dropWrongNetwork, 1);
  // our own beacon, looped back by the group
  socket.deliver(encodeBeacon({ identity: self, networkId: NETWORK, port: 47_470, ts: NOW, beaconKey: null }));
  assert.equal(counters().dropOwn, 1);
  // too old and too new
  socket.deliver(beaconFrom({ ts: NOW - 300_001 }).bytes);
  socket.deliver(beaconFrom({ ts: NOW + 300_001 }).bytes);
  assert.equal(counters().dropStale, 2);
  // bad signature: a valid beacon with one flipped bit in the signature
  const good = beaconFrom().bytes.toString('utf8');
  const record = JSON.parse(good);
  const sig = Buffer.from(record.sig, 'base64');
  sig[0] ^= 1;
  socket.deliver(Buffer.from(good.replace(record.sig, sig.toString('base64'))));
  assert.equal(counters().dropBadSignature, 1);
  // a card that belongs to another node
  const mallory = Identity.generate();
  const swapped = JSON.parse(good);
  swapped.card = mallory.card;
  socket.deliver(Buffer.from(canon(swapped)));
  assert.equal(counters().dropBadShape, 1);
  // oversize, not canonical, not a beacon
  socket.deliver(Buffer.alloc(BEACON_MAX_BYTES + 1, 0x20));
  assert.equal(counters().dropOversize, 1);
  socket.deliver(Buffer.from(JSON.stringify(JSON.parse(good), null, 1)));
  socket.deliver(Buffer.from('not json at all'));
  assert.equal(counters().dropNotCanonical, 2);
  socket.deliver(Buffer.from('{"a":1}'));
  assert.equal(counters().dropBadShape, 2);
  // a source address that is never dialed
  socket.deliver(beaconFrom().bytes, '127.0.0.1');
  socket.deliver(beaconFrom().bytes, '169.254.3.4');
  socket.deliver(beaconFrom().bytes, '224.0.0.9');
  assert.equal(counters().dropAddress, 3);

  await tick();
  assert.equal(candidates.length, 0);
  assert.equal(dials.length, 0);
});

test('beacons from nodes that are linked, dialed or backing off are ignored before any signature work', async t => {
  const known = new Set();
  const { module, socket, dials } = harness({ isKnown: id => known.has(id) });
  t.after(() => module.stop());
  await module.start();

  const { identity, bytes } = beaconFrom();
  known.add(identity.nodeId);
  socket.deliver(bytes);
  assert.equal(module.stats().dropKnown, 1);
  // The proof that no signature was checked: the same node with a corrupt signature is
  // also "known", not "bad signature".
  const record = JSON.parse(bytes.toString('utf8'));
  const corrupt = bytes.toString('utf8').replace(record.sig, Buffer.alloc(64, 1).toString('base64'));
  socket.deliver(Buffer.from(corrupt));
  assert.equal(module.stats().dropKnown, 2);
  assert.equal(module.stats().dropBadSignature, 0);
  assert.equal(dials.length, 0);

  known.clear();
  socket.deliver(bytes);
  await tick();
  assert.equal(dials.length, 1);
});

test('an isKnown that throws counts as known: fail closed', async t => {
  const { module, socket, dials } = harness({
    isKnown: () => {
      throw new Error('peer manager is down');
    },
  });
  t.after(() => module.stop());
  await module.start();
  socket.deliver(beaconFrom().bytes);
  assert.equal(module.stats().dropKnown, 1);
  assert.equal(dials.length, 0);
});

test('loopback and link-local sources are dialed only when allowLoopback is set', async t => {
  const { module, socket, dials } = harness({ allowLoopback: true });
  t.after(() => module.stop());
  await module.start();
  socket.deliver(beaconFrom().bytes, '127.0.0.1');
  await tick();
  assert.equal(dials.length, 1);
  assert.equal(dials[0].address, 'tcp://127.0.0.1:47480');
});

// ---------------------------------------------------------------------------------------
// The network key
// ---------------------------------------------------------------------------------------

test('on a network with a key only beacons with a valid MAC become candidates', async t => {
  const networkKey = randomBytes(32);
  const beaconKey = deriveBeaconKey(networkKey);
  const { module, socket, dials } = harness({ networkKey });
  t.after(() => module.stop());
  await module.start();

  const member = beaconFrom({ beaconKey });
  socket.deliver(member.bytes, '192.168.0.10');
  await tick();
  assert.equal(dials.length, 1);
  assert.equal(dials[0].hint.id, member.identity.nodeId);

  socket.deliver(beaconFrom().bytes, '192.168.0.11');
  assert.equal(module.stats().dropNoMac, 1);
  socket.deliver(beaconFrom({ beaconKey: deriveBeaconKey(randomBytes(32)) }).bytes, '192.168.0.12');
  assert.equal(module.stats().dropBadMac, 1);

  // The MAC is checked first: a beacon with a wrong MAC and a corrupt signature is a
  // MAC failure, and no signature failure is ever counted.
  const wrong = beaconFrom({ beaconKey: deriveBeaconKey(randomBytes(32)) }).bytes.toString('utf8');
  const record = JSON.parse(wrong);
  socket.deliver(Buffer.from(wrong.replace(record.sig, Buffer.alloc(64, 3).toString('base64'))), '192.168.0.13');
  assert.equal(module.stats().dropBadMac, 2);
  assert.equal(module.stats().dropBadSignature, 0);
  await tick();
  assert.equal(dials.length, 1);
});

test('a beacon with a MAC is refused by a node that has no network key', async t => {
  const { module, socket, dials } = harness({ networkKey: null });
  t.after(() => module.stop());
  await module.start();
  socket.deliver(beaconFrom({ beaconKey: deriveBeaconKey(randomBytes(32)) }).bytes);
  assert.equal(module.stats().dropUnexpectedMac, 1);
  assert.equal(dials.length, 0);
});

// ---------------------------------------------------------------------------------------
// Rate limits: applied before any parsing, let alone cryptography
// ---------------------------------------------------------------------------------------

test('a source address is limited to beaconsPerSourcePerMin, whatever it sends', async t => {
  const { module, socket, dials, clock } = harness({ beaconsPerSourcePerMin: 6, beaconsPerMin: 100 });
  t.after(() => module.stop());
  await module.start();
  const beacons = Array.from({ length: 10 }, () => beaconFrom().bytes);
  for (const bytes of beacons) socket.deliver(bytes, '192.168.0.50');
  await tick();
  assert.equal(dials.length, 1, 'one IP is dialed once at a time; the rest are denied by the governor');
  assert.equal(module.stats().candidates, 6);
  assert.equal(module.stats().rateLimitedSource, 4);
  // Another source is unaffected.
  socket.deliver(beaconFrom().bytes, '192.168.0.51');
  assert.equal(module.stats().candidates, 7);
  // One token per ten seconds comes back (6 per minute).
  clock.mono += 10_000;
  socket.deliver(beaconFrom().bytes, '192.168.0.50');
  assert.equal(module.stats().candidates, 8);
  socket.deliver(beaconFrom().bytes, '192.168.0.50');
  assert.equal(module.stats().rateLimitedSource, 5);
});

test('the overall limit caps beacons across all sources', async t => {
  const { module, socket } = harness({ beaconsPerSourcePerMin: 10, beaconsPerMin: 10 });
  t.after(() => module.stop());
  await module.start();
  for (let k = 0; k < 25; k += 1) socket.deliver(beaconFrom().bytes, `192.168.1.${k + 1}`);
  assert.equal(module.stats().candidates, 10);
  assert.equal(module.stats().rateLimitedGlobal, 15);
});

test('rate limits are applied before the datagram is parsed or verified', async t => {
  const { module, socket } = harness({ beaconsPerSourcePerMin: 5, beaconsPerMin: 100 });
  t.after(() => module.stop());
  await module.start();
  // 50,000 junk datagrams from one source: the module parses five of them, and the rest
  // cost one table lookup each.
  const junk = Buffer.from('{"type":"beacon"');
  for (let k = 0; k < 50_000; k += 1) socket.deliver(junk, '192.168.2.2');
  const stats = module.stats();
  assert.equal(stats.datagramsIn, 50_000);
  assert.equal(stats.dropNotCanonical, 5);
  assert.equal(stats.rateLimitedSource, 49_995);
  // The same for valid beacons with a corrupt signature: the signature is verified at
  // most five times (counted as bad signatures), not fifty thousand.
  const text = beaconFrom().bytes.toString('utf8');
  const sig = JSON.parse(text).sig;
  const forged = Buffer.from(text.replace(sig, Buffer.alloc(64, 5).toString('base64')));
  for (let k = 0; k < 1000; k += 1) socket.deliver(forged, '192.168.2.3');
  assert.equal(module.stats().dropBadSignature, 5);
});

test('spoofed sources cannot make the rate limiter grow without bound', async t => {
  const { module, socket } = harness({ maxSources: 8, beaconsPerSourcePerMin: 30, beaconsPerMin: 100_000 });
  t.after(() => module.stop());
  await module.start();
  const junk = Buffer.from('x');
  for (let k = 0; k < 500; k += 1) socket.deliver(junk, `10.${k >> 8}.${k & 255}.1`);
  const stats = module.stats();
  assert.equal(stats.dropNotCanonical, 8);
  assert.equal(stats.rateTableFull, 492);
});

test('a flood of valid beacons from many sources dials no more than the governor allows', async t => {
  const { module, socket, dials } = harness({
    beaconsPerSourcePerMin: 30,
    beaconsPerMin: 100_000,
    governor: new DialGovernor({ monoNow: () => 10_000, rng: () => 0.5, dialsPerSecond: 3 }),
    dial: (address, hint) => {
      dials.push({ address, hint });
      return new Promise(() => {});
    },
  });
  t.after(() => module.stop());
  await module.start();
  for (let k = 0; k < 200; k += 1) socket.deliver(beaconFrom().bytes, `192.168.3.${k + 1}`);
  assert.equal(dials.length, 3, 'the global dial cap, not the number of beacons, decides');
  assert.equal(module.stats().candidates, 200);
  assert.equal(module.stats().dialsDenied, 197);
});

// ---------------------------------------------------------------------------------------
// Dial outcomes, hooks, options
// ---------------------------------------------------------------------------------------

test('a failed dial is counted and puts the IP into backoff', async t => {
  const { module, socket, governor } = harness({
    dial: () => Promise.reject(new HandshakeError('timeout', 'no answer')),
  });
  t.after(() => module.stop());
  await module.start();
  socket.deliver(beaconFrom().bytes, '192.168.4.4');
  await tick();
  assert.equal(module.stats().dialsFailed, 1);
  assert.equal(governor.check('tcp://192.168.4.4:1'), 'backoff');
  socket.deliver(beaconFrom().bytes, '192.168.4.4');
  assert.equal(module.stats().dialsDenied, 1);
});

test('a throwing onCandidate does not stop the dial', async t => {
  const { module, socket, dials } = harness({
    onCandidate: () => {
      throw new Error('hook bug');
    },
  });
  t.after(() => module.stop());
  await module.start();
  socket.deliver(beaconFrom().bytes);
  await tick();
  assert.equal(dials.length, 1);
});

test('constructor options are validated', () => {
  const { options } = harness();
  const bad = [
    { identity: null },
    { networkId: '' },
    { group: '' },
    { port: -1 },
    { port: 70_000 },
    { iface: 5 },
    { listenPort: 'x' },
    { isKnown: undefined },
    { dial: undefined },
    { governor: null },
    { intervalMs: 0 },
    { maxClockSkewMs: -1 },
    { beaconsPerSourcePerMin: 0 },
    { beaconsPerSourcePerMin: 601, beaconsPerMin: 600 },
    { createSocket: 'dgram' },
  ];
  for (const override of bad) {
    assert.throws(() => new MulticastDiscovery({ ...options, ...override }), ConfigError, JSON.stringify(Object.keys(override)));
  }
  assert.throws(() => new MulticastDiscovery({ ...options, networkKey: Buffer.alloc(5) }), err => err.code === 'ERR_CRYPTO');
  assert.throws(() => new MulticastDiscovery());
});

// ---------------------------------------------------------------------------------------
// One test with real sockets. Multicast on the loopback interface is not available on
// every platform, so first a probe with plain dgram sockets (no code of ours) finds out;
// the test is skipped, with the reason, when the platform refuses. When the probe works
// the real test must pass.
// ---------------------------------------------------------------------------------------

const REAL_GROUP = '239.255.67.79';

async function probeLoopbackMulticast() {
  const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer;
  let interval;
  try {
    await new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.bind({ port: 0, address: '127.0.0.1' }, resolve);
    });
    const { port } = receiver.address();
    receiver.addMembership(REAL_GROUP, '127.0.0.1');
    await new Promise((resolve, reject) => {
      sender.once('error', reject);
      sender.bind({ port: 0, address: '127.0.0.1' }, resolve);
    });
    sender.setMulticastInterface('127.0.0.1');
    sender.setMulticastLoopback(true);
    sender.setMulticastTTL(1);
    const got = new Promise(resolve => receiver.once('message', () => resolve(true)));
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 1500);
    });
    interval = setInterval(() => sender.send(Buffer.from('probe'), port, REAL_GROUP, () => {}), 50);
    const arrived = await Promise.race([got, timeout]);
    return arrived ? { ok: true } : { ok: false, reason: 'a datagram sent to the group on 127.0.0.1 never arrived' };
  } catch (err) {
    return { ok: false, reason: `${err.code ?? 'error'}: ${err.message}` };
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    await Promise.all([receiver, sender].map(socket => new Promise(resolve => socket.close(resolve))));
  }
}

test('two instances on real sockets bound to 127.0.0.1 discover each other through the group', async t => {
  const probe = await probeLoopbackMulticast();
  if (!probe.ok) {
    t.skip(`the platform does not deliver multicast on the loopback interface (${probe.reason})`);
    return;
  }

  const make = (port, listenPort) => {
    const dials = [];
    const identity = Identity.generate();
    const module = new MulticastDiscovery({
      identity,
      networkId: NETWORK,
      group: REAL_GROUP,
      port,
      iface: '127.0.0.1',
      listenPort: () => listenPort,
      intervalMs: 25,
      maxClockSkewMs: 300_000,
      beaconsPerSourcePerMin: 6000,
      beaconsPerMin: 60_000,
      allowLoopback: true,
      isKnown: () => false,
      dial: (address, hint) => {
        dials.push({ address, hint });
        return Promise.resolve({ id: hint.id });
      },
      governor: new DialGovernor({ dialsPerSecond: 1000 }),
    });
    return { module, dials, identity };
  };

  const a = make(0, 41_001);
  t.after(() => a.module.stop());
  assert.equal(await a.module.start(), true);
  assert.ok(a.module.port > 0, 'the OS chose a port');
  const b = make(a.module.port, 41_002);
  t.after(() => b.module.stop());
  assert.equal(await b.module.start(), true);

  const deadline = Date.now() + 5000;
  while ((a.dials.length === 0 || b.dials.length === 0) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(a.dials[0], { address: 'tcp://127.0.0.1:41002', hint: { id: b.identity.nodeId, source: 'multicast' } });
  assert.deepEqual(b.dials[0], { address: 'tcp://127.0.0.1:41001', hint: { id: a.identity.nodeId, source: 'multicast' } });
  // Each module also hears its own beacons through the group and ignores them.
  assert.ok(a.module.stats().dropOwn > 0 && b.module.stats().dropOwn > 0);
  assert.equal(a.module.stats().socketErrors, 0);
});
