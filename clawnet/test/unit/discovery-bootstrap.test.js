import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BootstrapDiscovery, MAX_BOOTSTRAP_ADDRESSES } from '../../src/core/discovery/bootstrap.js';
import { DialGovernor } from '../../src/core/discovery/dial-governor.js';
import { ConfigError, HandshakeError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

const A = 'tcp://203.0.113.1:47470';
const B = 'tcp://203.0.113.2:47470';
const C = 'tcp://203.0.113.3:47470';

/**
 * A bootstrap module whose dial the test controls: `behaviour(address)` returns what the
 * dial does ("ok", "fail" or an object to resolve with).
 */
function setup({ addresses = [A, B, C], target = 2, dialsPerSecond = 1000, behaviour = () => 'ok' } = {}) {
  const clock = { now: 1000 };
  const dials = [];
  const known = new Set();
  let peers = 0;
  const events = new EventBus();
  const governor = new DialGovernor({ monoNow: () => clock.now, rng: () => 0.5, dialsPerSecond });
  const dial = (address, hint) => {
    dials.push({ address, hint });
    const what = behaviour(address);
    if (what === 'fail') return Promise.reject(new HandshakeError('timeout', 'no answer'));
    if (what === 'ok') return Promise.resolve({ id: `id-of-${address}` });
    return Promise.resolve(what);
  };
  const module = new BootstrapDiscovery({
    addresses,
    dial,
    governor,
    isKnown: id => known.has(id),
    peerCount: () => peers,
    targetPeers: target,
    events,
  });
  return {
    module,
    dials,
    known,
    clock,
    governor,
    events,
    setPeers: n => {
      peers = n;
    },
  };
}

test('start dials every bootstrap address, whatever the peer count', async () => {
  const { module, dials, events, setPeers } = setup();
  setPeers(5);
  assert.equal(module.start(), 3);
  assert.deepEqual(dials.map(d => d.address), [A, B, C]);
  assert.deepEqual(dials.map(d => d.hint), Array(3).fill({ id: null, source: 'bootstrap' }));
  assert.deepEqual(events.recent({ types: ['discovery.candidate'] }).map(e => e.data), [
    { addr: A, peer: null, source: 'bootstrap' },
    { addr: B, peer: null, source: 'bootstrap' },
    { addr: C, peer: null, source: 'bootstrap' },
  ]);
  await settle();
  assert.equal(module.stats().dialsOk, 3);
  // A second start dials again but does not repeat the announcement.
  module.start();
  assert.equal(events.recent({ types: ['discovery.candidate'] }).length, 3);
});

test('duplicate addresses are dialed once and the list is bounded and validated', () => {
  const { module, dials } = setup({ addresses: [A, A, B] });
  assert.deepEqual(module.addresses, [A, B]);
  module.start();
  assert.equal(dials.length, 2);

  const base = { dial: () => {}, governor: new DialGovernor(), isKnown: () => false, peerCount: () => 0, targetPeers: 1 };
  assert.throws(() => new BootstrapDiscovery({ ...base, addresses: ['http://x:1'] }), ConfigError);
  assert.throws(() => new BootstrapDiscovery({ ...base, addresses: ['tcp://host'] }), ConfigError);
  assert.throws(() => new BootstrapDiscovery({ ...base, addresses: 'tcp://203.0.113.1:1' }), ConfigError);
  const tooMany = Array.from({ length: MAX_BOOTSTRAP_ADDRESSES + 1 }, (_, k) => `tcp://203.0.113.1:${k + 1}`);
  assert.throws(() => new BootstrapDiscovery({ ...base, addresses: tooMany }), ConfigError);
  assert.doesNotThrow(() => new BootstrapDiscovery({ ...base, addresses: tooMany.slice(1) }));
  for (const override of [{ dial: 1 }, { isKnown: null }, { peerCount: undefined }, { governor: null }, { targetPeers: -1 }, { targetPeers: 1.5 }]) {
    assert.throws(() => new BootstrapDiscovery({ ...base, addresses: [A], ...override }), ConfigError, JSON.stringify(Object.keys(override)));
  }
  assert.throws(() => new BootstrapDiscovery(), ConfigError);
});

test('bootstrap addresses are the operator\'s own: loopback is dialed', () => {
  const { module, dials } = setup({ addresses: ['tcp://127.0.0.1:50000', 'tcp://localhost:50001', 'tcp://[::1]:50002'] });
  assert.equal(module.start(), 3);
  assert.deepEqual(dials.map(d => d.address), ['tcp://127.0.0.1:50000', 'tcp://localhost:50001', 'tcp://[::1]:50002']);
});

test('start is held back by the global dial rate, and later passes pick up the rest', async () => {
  const { module, dials, clock, setPeers } = setup({ dialsPerSecond: 2, target: 3 });
  assert.equal(module.start(), 2);
  assert.deepEqual(dials.map(d => d.address), [A, B]);
  assert.equal(module.stats().dialsDenied, 1);
  await settle();
  // The two that were dialed answered ("linked" in a real node); the third is next.
  setPeers(2);
  clock.now += 1000;
  assert.equal(module.maintain(), 1);
  assert.equal(dials.at(-1).address, C);
});

test('maintain dials only as many addresses as the node is short of its target', async () => {
  const { module, dials, setPeers } = setup({ target: 2 });
  setPeers(2);
  assert.equal(module.maintain(), 0, 'at target');
  setPeers(5);
  assert.equal(module.maintain(), 0, 'above target');
  assert.equal(dials.length, 0);

  setPeers(0);
  assert.equal(module.maintain(), 2, 'three addresses, target two: exactly two');
  assert.equal(dials.length, 2);
  await settle();
  setPeers(1);
  assert.equal(module.maintain(), 1);
  assert.equal(dials.length, 3);
});

test('maintain takes the addresses in turn, so a dead one does not starve the rest', async () => {
  const { module, dials, clock, setPeers } = setup({ target: 1, behaviour: address => (address === A ? 'fail' : 'ok') });
  setPeers(0);
  assert.equal(module.maintain(), 1);
  assert.equal(dials[0].address, A);
  await settle();
  assert.equal(module.stats().dialsFailed, 1);
  // A is in backoff; the next pass moves on to B rather than waiting for A.
  clock.now += 1;
  assert.equal(module.maintain(), 1);
  assert.equal(dials[1].address, B);
  await settle();
  // Once the backoff of A is over it gets its turn again, after C.
  clock.now += 5000;
  assert.equal(module.maintain(), 1);
  assert.equal(dials[2].address, C);
  assert.equal(module.maintain(), 1);
  assert.equal(dials[3].address, A);
});

test('an address whose node is linked, dialed or in backoff is not dialed again', async () => {
  const { module, dials, known, setPeers } = setup({ addresses: [A, B], target: 2 });
  module.start();
  await settle();
  assert.equal(dials.length, 2);
  // Both answered; the peer manager still lists them.
  known.add(`id-of-${A}`);
  known.add(`id-of-${B}`);
  setPeers(0);
  assert.equal(module.maintain(), 0);
  // A link is lost: only that address is dialed again.
  known.delete(`id-of-${B}`);
  assert.equal(module.maintain(), 1);
  assert.equal(dials.at(-1).address, B);
  assert.equal(dials.at(-1).hint.id, `id-of-${B}`, 'the hint names who answered last time');
});

test('an isKnown that throws counts as known', async () => {
  const governor = new DialGovernor();
  const module = new BootstrapDiscovery({
    addresses: [A],
    dial: () => Promise.resolve({ id: 'x' }),
    governor,
    isKnown: () => {
      throw new Error('peer manager is down');
    },
    peerCount: () => 0,
    targetPeers: 1,
  });
  module.start();
  await settle();
  assert.equal(module.maintain(), 0);
});

test('kick forgets the backoff and dials at once', async () => {
  const { module, dials, governor, setPeers } = setup({ addresses: [A, B], target: 1, behaviour: () => 'fail' });
  setPeers(0);
  module.start();
  await settle();
  assert.equal(dials.length, 2);
  assert.equal(governor.check(A), 'backoff');
  assert.equal(module.maintain(), 0, 'both are backing off');
  assert.equal(module.kick(), 1, 'the last link is gone: do not wait');
  assert.equal(dials.length, 3);
  assert.equal(dials.at(-1).address, A);
  assert.equal(module.stats().kicks, 1);
});

test('a dial function that fails is counted and never leaves an unhandled rejection', async t => {
  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const { module } = setup({ behaviour: () => 'fail' });
  module.start();
  await settle();
  await settle();
  assert.equal(module.stats().dialsFailed, 3);
  assert.deepEqual(rejections, []);
});
