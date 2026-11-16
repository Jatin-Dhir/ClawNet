import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HostClass,
  budgetKey,
  checkLearnedAddress,
  classifyHost,
  classifyIp,
  isDialableIp,
} from '../../src/core/discovery/address-policy.js';
import { DialGovernor } from '../../src/core/discovery/dial-governor.js';
import { BoundedSet, KeyedTokenBuckets, TokenBucket } from '../../src/core/discovery/rate-limit.js';
import { ConfigError, HandshakeError } from '../../src/core/errors.js';

// ---------------------------------------------------------------------------------------
// Address policy (DESIGN.md 15.22)
// ---------------------------------------------------------------------------------------

test('classifyIp refuses loopback, unspecified, multicast, link-local and reserved addresses', () => {
  const refused = {
    '127.0.0.1': HostClass.LOOPBACK,
    '127.255.255.254': HostClass.LOOPBACK,
    '0.0.0.0': HostClass.UNSPECIFIED,
    '0.1.2.3': HostClass.UNSPECIFIED,
    '224.0.0.1': HostClass.MULTICAST,
    '239.255.67.78': HostClass.MULTICAST,
    '169.254.10.20': HostClass.LINK_LOCAL,
    '255.255.255.255': HostClass.RESERVED,
    '240.0.0.1': HostClass.RESERVED,
    '::1': HostClass.LOOPBACK,
    '::': HostClass.UNSPECIFIED,
    'ff02::1': HostClass.MULTICAST,
    fe80: HostClass.RESERVED,
    'fe80::1': HostClass.LINK_LOCAL,
    'febf::1': HostClass.LINK_LOCAL,
  };
  for (const [ip, expected] of Object.entries(refused)) assert.equal(classifyIp(ip), expected, ip);
});

test('classifyIp judges IPv6 addresses that embed an IPv4 address by the embedded one', () => {
  const embedded = {
    '::ffff:127.0.0.1': HostClass.LOOPBACK,
    '::ffff:7f00:1': HostClass.LOOPBACK,
    '::127.0.0.1': HostClass.LOOPBACK,
    '64:ff9b::7f00:1': HostClass.LOOPBACK,
    '2002:7f00:1::': HostClass.LOOPBACK,
    '::ffff:169.254.1.1': HostClass.LINK_LOCAL,
    '::ffff:224.0.0.1': HostClass.MULTICAST,
    '::ffff:0.0.0.0': HostClass.UNSPECIFIED,
    '::ffff:10.1.2.3': null,
    '64:ff9b::808:808': null,
  };
  for (const [ip, expected] of Object.entries(embedded)) assert.equal(classifyIp(ip), expected, ip);
});

test('classifyIp allows private and public addresses, and fails closed on garbage', () => {
  for (const ip of ['10.0.0.1', '192.168.1.5', '172.16.0.1', '8.8.8.8', '2001:db8::1', '2606:4700::1111', 'fec0::1', 'fc00::1']) {
    assert.equal(classifyIp(ip), null, ip);
  }
  for (const junk of ['', 'not an ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '::g', 7, null, undefined]) {
    assert.equal(classifyIp(junk), HostClass.RESERVED, String(junk));
  }
});

test('classifyHost handles DNS names as well as literals', () => {
  assert.equal(classifyHost('localhost'), HostClass.LOOPBACK);
  assert.equal(classifyHost('LocalHost'), HostClass.LOOPBACK);
  assert.equal(classifyHost('app.localhost'), HostClass.LOOPBACK);
  assert.equal(classifyHost('printer.local'), HostClass.LINK_LOCAL);
  assert.equal(classifyHost('intranet'), HostClass.UNQUALIFIED);
  assert.equal(classifyHost('node1.example.com'), null);
  assert.equal(classifyHost('127.0.0.1'), HostClass.LOOPBACK);
  assert.equal(classifyHost('203.0.113.9'), null);
  assert.equal(classifyHost(''), HostClass.RESERVED);
  assert.equal(classifyHost(undefined), HostClass.RESERVED);
});

test('isDialableIp is the same policy for a transport that has resolved a name', () => {
  assert.equal(isDialableIp('127.0.0.1'), false);
  assert.equal(isDialableIp('10.0.0.2'), true);
  assert.equal(isDialableIp('127.0.0.1', { allowLoopback: true }), true);
  assert.equal(isDialableIp('not an ip'), false);
});

test('budgetKey gives one key per IP, however it is spelled', () => {
  assert.equal(budgetKey('10.0.0.1'), '10.0.0.1');
  assert.equal(budgetKey('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(budgetKey('::ffff:a00:1'), '10.0.0.1');
  assert.equal(budgetKey('2001:db8::1'), budgetKey('2001:0DB8:0:0:0:0:0:1'));
  assert.equal(budgetKey('2001:db8::1'), '20010db8000000000000000000000001');
  assert.notEqual(budgetKey('2001:db8::1'), budgetKey('2001:db8::2'));
  assert.equal(budgetKey('Node.Example.COM'), 'name:node.example.com');
});

test('checkLearnedAddress applies the policy unless allowLoopback is set', () => {
  assert.deepEqual(checkLearnedAddress('tcp://203.0.113.9:47470'), {
    ok: true,
    host: '203.0.113.9',
    port: 47470,
    key: '203.0.113.9',
  });
  assert.deepEqual(checkLearnedAddress('tcp://127.0.0.1:47470'), { ok: false, reason: 'loopback' });
  assert.deepEqual(checkLearnedAddress('tcp://[::1]:47470'), { ok: false, reason: 'loopback' });
  assert.deepEqual(checkLearnedAddress('tcp://0.0.0.0:1'), { ok: false, reason: 'unspecified' });
  assert.deepEqual(checkLearnedAddress('tcp://224.1.1.1:1'), { ok: false, reason: 'multicast' });
  assert.deepEqual(checkLearnedAddress('tcp://169.254.1.1:1'), { ok: false, reason: 'link-local' });
  assert.deepEqual(checkLearnedAddress('tcp://localhost:1'), { ok: false, reason: 'loopback' });
  assert.deepEqual(checkLearnedAddress('tcp://[::ffff:127.0.0.1]:1'), { ok: false, reason: 'loopback' });
  assert.equal(checkLearnedAddress('tcp://127.0.0.1:47470', { allowLoopback: true }).ok, true);
  for (const bad of ['http://1.2.3.4:5', 'tcp://1.2.3.4:0', 'tcp://1.2.3.4', 'tcp://', '', null, 5, {}]) {
    assert.deepEqual(checkLearnedAddress(bad), { ok: false, reason: 'invalid' }, String(bad));
  }
});

// ---------------------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------------------

test('a token bucket allows its burst, then the refill rate, and survives a clock step', () => {
  const bucket = new TokenBucket({ capacity: 3, perSecond: 2 });
  assert.deepEqual([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)], [true, true, true, false]);
  assert.equal(bucket.take(400), false, '0.8 tokens');
  assert.equal(bucket.take(500), true, 'one token after 500 ms');
  assert.equal(bucket.take(500), false);
  assert.equal(bucket.isFull(500), false);
  assert.equal(bucket.isFull(5000), true);
  // Never more than the capacity, however long it has been idle.
  assert.deepEqual([bucket.take(1_000_000), bucket.take(1_000_000), bucket.take(1_000_000), bucket.take(1_000_000)], [true, true, true, false]);
  // A reading that goes backwards neither refills nor locks the bucket.
  const stepped = new TokenBucket({ capacity: 1, perSecond: 1 });
  assert.equal(stepped.take(10_000), true);
  assert.equal(stepped.take(5_000), false);
  assert.equal(stepped.take(6_000), true, 'measures from the new reading');
});

test('token bucket options are validated', () => {
  for (const bad of [{ capacity: 0, perSecond: 1 }, { capacity: 1, perSecond: 0 }, { capacity: NaN, perSecond: 1 }, { capacity: 1, perSecond: Infinity }]) {
    assert.throws(() => new TokenBucket(bad), ConfigError, JSON.stringify(bad));
  }
});

test('keyed buckets limit per key, forget full ones and never grow beyond maxKeys', () => {
  const buckets = new KeyedTokenBuckets({ capacity: 2, perSecond: 1, maxKeys: 3 });
  assert.equal(buckets.take('a', 0), 'ok');
  assert.equal(buckets.take('a', 0), 'ok');
  assert.equal(buckets.take('a', 0), 'limited');
  assert.equal(buckets.take('b', 0), 'ok');
  assert.equal(buckets.take('c', 0), 'ok');
  assert.equal(buckets.size, 3);
  // A fourth source finds the table full: a, b and c have not refilled.
  assert.equal(buckets.take('d', 0), 'table-full');
  assert.equal(buckets.size, 3);
  // Later b and c are full again (one token used, one second per token), a is not.
  assert.equal(buckets.take('d', 1500), 'ok');
  assert.equal(buckets.size, 2, 'full buckets were dropped to make room');
  assert.equal(buckets.take('a', 1500), 'ok');
  assert.throws(() => new KeyedTokenBuckets({ capacity: 1, perSecond: 1, maxKeys: 0 }), ConfigError);
});

test('a bounded set forgets its oldest member', () => {
  const set = new BoundedSet(2);
  assert.equal(set.add('a'), true);
  assert.equal(set.add('a'), false);
  assert.equal(set.add('b'), true);
  assert.equal(set.add('c'), true);
  assert.equal(set.size, 2);
  assert.equal(set.add('a'), true, 'a was forgotten');
  assert.throws(() => new BoundedSet(0), ConfigError);
});

// ---------------------------------------------------------------------------------------
// DialGovernor
// ---------------------------------------------------------------------------------------

/** A governor on a clock the test moves, with a dial the test settles by hand. */
function setup(options = {}) {
  const clock = { now: 1_000 };
  const calls = [];
  const governor = new DialGovernor({
    monoNow: () => clock.now,
    rng: () => 0.5, // spread of exactly 1: backoffs are the plain schedule
    dialsPerSecond: 100,
    ...options,
  });
  const dial = (address, hint) =>
    new Promise((resolve, reject) => {
      calls.push({ address, hint, resolve, reject });
    });
  return { clock, calls, governor, dial };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a dial passes its address and a frozen hint to the injected function', async () => {
  const { governor, calls, dial } = setup();
  const result = governor.attempt('tcp://203.0.113.5:47470', { id: 'node-a', source: 'pex' }, dial);
  assert.equal(result.started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, 'tcp://203.0.113.5:47470');
  assert.deepEqual(calls[0].hint, { id: 'node-a', source: 'pex' });
  assert.ok(Object.isFrozen(calls[0].hint));
  calls[0].resolve({ id: 'node-a' });
  assert.deepEqual(await result.done, { ok: true, value: { id: 'node-a' } });
  assert.equal(governor.stats().inFlight, 0);
});

test('one attempt per IP at a time, whatever port or NodeId claims it', async () => {
  const { governor, calls, dial } = setup();
  const first = governor.attempt('tcp://203.0.113.5:1000', { id: 'a', source: 'pex' }, dial);
  assert.equal(first.started, true);
  // Same IP, another port and another NodeId: the same budget.
  assert.deepEqual(governor.attempt('tcp://203.0.113.5:2000', { id: 'b', source: 'pex' }, dial), { started: false, reason: 'in-flight' });
  assert.deepEqual(governor.attempt('tcp://[::ffff:203.0.113.5]:2000', { id: 'c', source: 'multicast' }, dial), { started: false, reason: 'in-flight' });
  assert.equal(governor.check('tcp://203.0.113.5:3000'), 'in-flight');
  // Another IP is independent.
  assert.equal(governor.attempt('tcp://203.0.113.6:1000', { id: 'a', source: 'pex' }, dial).started, true);
  assert.equal(calls.length, 2);
  calls[0].resolve();
  await first.done;
  assert.equal(governor.check('tcp://203.0.113.5:3000'), null);
  assert.equal(governor.stats().deniedInFlight, 2);
});

test('a failed dial backs the IP off exponentially, for every NodeId and port', async () => {
  const { governor, calls, dial, clock } = setup();
  const delays = [];
  for (let k = 0; k < 8; k += 1) {
    const result = governor.attempt('tcp://203.0.113.5:1000', { id: 'a', source: 'pex' }, dial);
    assert.equal(result.started, true, `attempt ${k}`);
    calls[k].reject(new HandshakeError('timeout', 'no answer'));
    assert.equal((await result.done).ok, false);
    // Find the length of the backoff by probing the clock.
    const start = clock.now;
    assert.equal(governor.check('tcp://203.0.113.5:9999'), 'backoff');
    let waited = 0;
    while (governor.check('tcp://203.0.113.5:9999') !== null) {
      clock.now += 1;
      waited += 1;
    }
    delays.push(waited);
    assert.equal(clock.now - start, waited);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  // A success clears the history.
  const ok = governor.attempt('tcp://203.0.113.5:1000', { id: 'a', source: 'pex' }, dial);
  calls[8].resolve();
  await ok.done;
  const again = governor.attempt('tcp://203.0.113.5:1000', { id: 'a', source: 'pex' }, dial);
  calls[9].reject(new Error('refused'));
  await again.done;
  clock.now += 999;
  assert.equal(governor.check('tcp://203.0.113.5:1000'), 'backoff');
  clock.now += 1;
  assert.equal(governor.check('tcp://203.0.113.5:1000'), null, 'back to the first step of the schedule');
});

test('refusals that will not change back off for longer', async () => {
  const { governor, calls, dial, clock } = setup({ backoffMinMs: 100, backoffMaxMs: 1000 });
  const cases = [['full', 100], ['blocked', 1000], ['not-allowed', 1000], ['self', 1000], ['whatever', 100]];
  let index = 0;
  for (const [reason, expected] of cases) {
    const address = `tcp://203.0.113.${10 + index}:1`;
    const result = governor.attempt(address, { id: null, source: 'multicast' }, dial);
    calls[index].reject(new HandshakeError(reason, 'refused'));
    await result.done;
    index += 1;
    clock.now += expected - 1;
    assert.equal(governor.check(address), 'backoff', `${reason} still backing off`);
    clock.now += 1;
    assert.equal(governor.check(address), null, `${reason} released`);
  }
});

test('backoff is jittered by the injected random source', async () => {
  const { governor, calls, dial, clock } = setup({ rng: () => 1, jitter: 0.2 });
  const result = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, dial);
  calls[0].reject(new Error('x'));
  await result.done;
  clock.now += 1199;
  assert.equal(governor.check('tcp://203.0.113.5:1'), 'backoff');
  clock.now += 1;
  assert.equal(governor.check('tcp://203.0.113.5:1'), null, '1000 ms * 1.2');
});

test('the global rate cap limits dials per second across all addresses', async () => {
  const { governor, calls, dial, clock } = setup({ dialsPerSecond: 2 });
  const results = [1, 2, 3].map(k => governor.attempt(`tcp://203.0.113.${k}:1`, { id: null, source: 'pex' }, dial));
  assert.deepEqual(results.map(r => r.started), [true, true, false]);
  assert.equal(results[2].reason, 'rate');
  assert.equal(calls.length, 2);
  clock.now += 499;
  assert.equal(governor.attempt('tcp://203.0.113.3:1', { id: null, source: 'pex' }, dial).reason, 'rate');
  clock.now += 1;
  assert.equal(governor.attempt('tcp://203.0.113.3:1', { id: null, source: 'pex' }, dial).started, true);
  // A denied attempt used no token of its own: the IP-level denials do not drain the cap.
  const busy = governor.attempt('tcp://203.0.113.1:2', { id: null, source: 'pex' }, dial);
  assert.equal(busy.reason, 'in-flight');
  assert.equal(governor.stats().deniedRate, 2);
  for (const call of calls) call.resolve();
  await settle();
});

test('a dial that never settles is given up on, and its late result changes nothing', async () => {
  const { governor, calls, dial, clock } = setup({ maxInFlightMs: 5000, backoffMinMs: 10, backoffMaxMs: 10 });
  const stuck = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, dial);
  clock.now += 4999;
  assert.equal(governor.check('tcp://203.0.113.5:1'), 'in-flight');
  clock.now += 1;
  // Released as a failure, with the short backoff of this test.
  assert.equal(governor.check('tcp://203.0.113.5:1'), 'backoff');
  clock.now += 10;
  const second = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, dial);
  assert.equal(second.started, true);
  // The first dial finally succeeds; the second must stay in flight.
  calls[0].resolve();
  await stuck.done;
  assert.equal(governor.check('tcp://203.0.113.5:1'), 'in-flight');
  assert.equal(governor.stats().staleInFlight, 1);
  calls[1].resolve();
  await second.done;
  assert.equal(governor.check('tcp://203.0.113.5:1'), null);
});

test('a dial function that throws or returns a plain value is handled', async () => {
  const { governor, clock } = setup();
  const thrown = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, () => {
    throw new TypeError('boom');
  });
  assert.equal(thrown.started, true);
  const outcome = await thrown.done;
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof TypeError);
  assert.equal(governor.check('tcp://203.0.113.5:1'), 'backoff');
  clock.now += 1000;
  const plain = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, () => ({ id: 'x' }));
  assert.deepEqual(await plain.done, { ok: true, value: { id: 'x' } });
});

test('forgive clears the backoff of an IP, and invalid addresses are refused', async () => {
  const { governor, calls, dial } = setup();
  const result = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'bootstrap' }, dial);
  calls[0].reject(new Error('down'));
  await result.done;
  assert.equal(governor.check('tcp://203.0.113.5:2'), 'backoff');
  governor.forgive('tcp://203.0.113.5:2');
  assert.equal(governor.check('tcp://203.0.113.5:2'), null);
  governor.forgive('garbage');
  assert.deepEqual(governor.attempt('garbage', { id: null, source: 'pex' }, dial), { started: false, reason: 'invalid' });
  assert.equal(governor.check('tcp://1.2.3.4:0'), 'invalid');
});

test('the failure table stays within maxTracked however many IPs fail', async () => {
  const { governor, calls, dial, clock } = setup({ maxTracked: 4, dialsPerSecond: 1000 });
  for (let k = 0; k < 40; k += 1) {
    clock.now += 1;
    const result = governor.attempt(`tcp://198.51.100.${k + 1}:1`, { id: null, source: 'pex' }, dial);
    calls[k].reject(new Error('x'));
    await result.done;
  }
  assert.ok(governor.stats().tracked <= 4);
  // The newest failures are the ones remembered.
  assert.equal(governor.check('tcp://198.51.100.40:1'), 'backoff');
  assert.equal(governor.check('tcp://198.51.100.1:1'), null);
});

test('a clock that steps backwards cannot lock an IP out for long', async () => {
  const { governor, calls, dial, clock } = setup({ backoffMinMs: 1000, backoffMaxMs: 1000 });
  clock.now = 10_000_000;
  const result = governor.attempt('tcp://203.0.113.5:1', { id: null, source: 'pex' }, dial);
  calls[0].reject(new Error('x'));
  await result.done;
  clock.now = 0; // the backoff now lies 10 million milliseconds ahead
  assert.equal(governor.check('tcp://203.0.113.5:1'), null);
});

test('governor options are validated', () => {
  const bad = [
    { dialsPerSecond: 0 },
    { backoffMinMs: 0 },
    { backoffMinMs: 500, backoffMaxMs: 100 },
    { jitter: 2 },
    { maxTracked: 0 },
    { monoNow: 5 },
    { maxInFlightMs: 0 },
  ];
  for (const override of bad) assert.throws(() => new DialGovernor(override), ConfigError, JSON.stringify(override));
  assert.doesNotThrow(() => new DialGovernor());
});

test('the discovery index exports what the node runtime wires up', async () => {
  const index = await import('../../src/core/discovery/index.js');
  for (const name of [
    'BootstrapDiscovery',
    'DialGovernor',
    'MulticastDiscovery',
    'PeerExchange',
    'encodeBeacon',
    'parseBeacon',
    'authenticateBeacon',
    'checkLearnedAddress',
    'isDialableIp',
  ]) {
    assert.equal(typeof index[name], 'function', name);
  }
  assert.equal(index.PEER_DATASET, 'peer');
  assert.equal(index.BEACON_MAX_BYTES, 2048);
});
