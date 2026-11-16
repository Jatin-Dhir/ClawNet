/**
 * ClawCast over real ClawNodes on loopback TCP (ARCHITECTURE.md 8.1, 11.5). Everything
 * runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createCastService } from '../../src/cast/channels.js';
import { castDecrypt, channelWireId } from '../../src/core/crypto/envelope.js';
import { AuthError } from '../../src/core/errors.js';
import { startCluster } from '../helpers/cluster.js';

/** Hands its context to the test: the one way to reach the dataset and the identity of a node. */
function createProbeService() {
  let context = null;
  return {
    name: 'probe',
    requires: ['cast'],
    init(ctx) {
      context = ctx;
    },
    stop() {
      context = null;
    },
    api: {
      get ctx() {
        return context;
      },
    },
  };
}

const castServices = () => [createCastService(), createProbeService()];
const castOf = (cluster, i) => cluster.nodes[i].service('cast');
const history = (cluster, i, name) => castOf(cluster, i).history(name, { limit: 500 }).items.reverse();
const textsOf = (cluster, i, name) => history(cluster, i, name).map((item) => item.text);

async function joinAll(cluster, name, indexes = cluster.nodes.map((_, i) => i), options) {
  for (const i of indexes) await castOf(cluster, i).join(name, options);
}

test('a cast published at one end of a three-node line reaches every node once and in order', async (t) => {
  const cluster = await startCluster(t, { size: 3, topology: 'line', services: castServices });
  await cluster.converged();
  await joinAll(cluster, 'ops');
  const sent = Array.from({ length: 30 }, (_, i) => `message ${i + 1}`);
  for (const text of sent) await castOf(cluster, 0).publish('ops', text);
  await cluster.waitFor(() => [1, 2].every((i) => history(cluster, i, 'ops').length === sent.length), { message: 'all 30 casts at both other nodes' });
  for (const i of [0, 1, 2]) {
    assert.deepEqual(textsOf(cluster, i, 'ops'), sent, `node ${i}: every cast, in the order it was published`);
    const items = history(cluster, i, 'ops');
    assert.deepEqual(items.map((item) => item.n), sent.map((_, k) => k + 1));
    assert.ok(items.every((item) => item.origin === cluster.ids[0]));
    assert.equal(cluster.events(i, 'cast.message').length, sent.length, `node ${i}: one event per cast`);
  }
  assert.equal(castOf(cluster, 2).list()[0].messages, sent.length);
  // Everyone publishes: each sender's own order is kept everywhere, and nothing arrives twice.
  await Promise.all([0, 1, 2].map(async (i) => {
    for (let k = 1; k <= 10; k += 1) await castOf(cluster, i).publish('ops', `from ${i} #${k}`);
  }));
  await cluster.waitFor(() => [0, 1, 2].every((i) => history(cluster, i, 'ops').length === 60), { message: 'all 60 casts everywhere' });
  for (const i of [0, 1, 2]) {
    const items = history(cluster, i, 'ops');
    assert.equal(new Set(items.map((item) => `${item.origin}:${item.n}`)).size, 60, `node ${i}: no duplicates`);
    for (const origin of cluster.ids) {
      const numbers = items.filter((item) => item.origin === origin).map((item) => item.n);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), `node ${i}: sender order of ${origin.slice(0, 6)}`);
    }
  }
  for (let i = 0; i < 3; i += 1) assert.deepEqual(cluster.events(i, 'node.error'), []);
});

test('casts published on both sides of a partition are all present everywhere once it heals', async (t) => {
  const cluster = await startCluster(t, { size: 3, topology: 'line', netem: true, services: castServices });
  await cluster.converged();
  await joinAll(cluster, 'ops');
  await castOf(cluster, 0).publish('ops', 'before the cut');
  await cluster.waitFor(() => history(cluster, 2, 'ops').length === 1, { message: 'the first cast across the line' });

  cluster.partition([0, 1], [2]);
  await cluster.converged();
  for (let k = 1; k <= 5; k += 1) {
    await castOf(cluster, 0).publish('ops', `west a${k}`);
    await castOf(cluster, 1).publish('ops', `west b${k}`);
    await castOf(cluster, 2).publish('ops', `east ${k}`);
  }
  await cluster.waitFor(() => history(cluster, 1, 'ops').length === 11, { message: 'the west side to share its casts' });
  assert.equal(history(cluster, 2, 'ops').length, 6, 'the east side holds only its own and the one from before the cut');
  assert.ok(textsOf(cluster, 2, 'ops').every((text) => text === 'before the cut' || text.startsWith('east')));
  assert.ok(textsOf(cluster, 0, 'ops').every((text) => !text.startsWith('east')));

  cluster.heal();
  await cluster.converged({ timeoutMs: 8000 });
  await cluster.waitFor(() => [0, 1, 2].every((i) => history(cluster, i, 'ops').length === 16), { timeoutMs: 10000, message: 'the union everywhere' });
  const expected = ['before the cut', ...[1, 2, 3, 4, 5].flatMap((k) => [`west a${k}`, `west b${k}`, `east ${k}`])].sort();
  for (const i of [0, 1, 2]) {
    assert.deepEqual(textsOf(cluster, i, 'ops').sort(), expected, `node ${i} holds every cast`);
    assert.equal(cluster.events(i, 'cast.message').length, 16, `node ${i}: each cast surfaced once`);
    for (const origin of cluster.ids) {
      const numbers = history(cluster, i, 'ops').filter((item) => item.origin === origin).map((item) => item.n);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), `node ${i}: order per sender`);
    }
  }
});

test('a node without the channel key relays an encrypted cast but cannot read it, and a re-signed ciphertext is refused by members', async (t) => {
  const cluster = await startCluster(t, { size: 3, topology: 'line', netem: true, services: castServices });
  await cluster.converged();
  const key = randomBytes(32);
  await joinAll(cluster, 'vault', [0, 2], { key });
  // The middle node joined the name without the key: another channel, which stays empty.
  await castOf(cluster, 1).join('vault');
  const chan = channelWireId('vault', key);
  const secret = `the safe is behind the clock, ${randomBytes(8).toString('hex')}`;
  await castOf(cluster, 0).publish('vault', secret);
  await cluster.waitFor(() => history(cluster, 2, 'vault').length === 1, { message: 'the member at the far end to read it' });
  assert.equal(history(cluster, 2, 'vault')[0].text, secret);
  assert.equal(history(cluster, 2, 'vault')[0].origin, cluster.ids[0]);

  // The relay carried it, holds ciphertext, and reads nothing.
  const relay = cluster.nodes[1].service('probe').ctx;
  const stored = relay.sync.dataset('cast').get(`${chan}:${cluster.ids[0]}`, 1);
  assert.ok(stored, 'the relay holds the record');
  assert.equal(stored.enc, true);
  assert.equal(Buffer.from(stored.body, 'base64').includes(secret), false);
  assert.equal(stored.body.includes(Buffer.from(secret).toString('base64').slice(0, 12)), false);
  assert.throws(() => castDecrypt({
    channelKey: randomBytes(32),
    fields: { type: 'cast', origin: stored.origin, chan: stored.chan, n: stored.n, ts: stored.ts, enc: true },
    salt: Buffer.from(stored.salt, 'base64'),
    ciphertext: Buffer.from(stored.body, 'base64'),
  }), AuthError);
  assert.equal(castOf(cluster, 1).history('vault').items.length, 0);
  assert.equal(cluster.nodes[1].stats().services.cast.surfaced, 0);
  for (const [i, j] of [[0, 1], [1, 2]]) assert.equal(cluster.link(i, j).contains(secret), false, `the wire between ${i} and ${j} carries no plaintext`);

  // The relay re-signs the member's ciphertext as its own cast. It is a valid record, so it
  // spreads, but no member can open it.
  const before = cluster.nodes[2].stats().services.cast.received;
  const forged = relay.identity.signRecord('cast', { chan, n: 1, ts: stored.ts, enc: true, salt: stored.salt, body: stored.body });
  assert.equal(relay.sync.publish('cast', forged).accepted, true);
  await cluster.waitFor(() => cluster.nodes[2].stats().services.cast.received === before + 1, { message: 'the forged cast to reach the far member' });
  await cluster.waitFor(() => cluster.nodes[2].stats().services.cast.undecryptable === 1, { message: 'the member to refuse it' });
  for (const i of [0, 2]) {
    assert.deepEqual(textsOf(cluster, i, 'vault'), [secret], `node ${i} shows only the genuine cast`);
    assert.equal(cluster.nodes[i].stats().services.cast.surfaced, 1);
  }
  assert.equal(cluster.nodes[0].stats().services.cast.undecryptable, 1);
  assert.equal(cluster.events(2, 'cast.rejected')[0].reason, 'undecryptable');
  assert.equal(cluster.events(2, 'cast.rejected')[0].origin, cluster.ids[1]);
  // And a cast the member publishes afterwards still gets through, under its own counter.
  await castOf(cluster, 2).publish('vault', 'still working');
  await cluster.waitFor(() => history(cluster, 0, 'vault').length === 2, { message: 'a later cast to arrive' });
  assert.deepEqual(textsOf(cluster, 0, 'vault'), [secret, 'still working']);
});
