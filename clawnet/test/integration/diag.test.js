/**
 * Ping and traceroute between real ClawNodes over loopback TCP, with a known latency
 * injected on every link by the netem proxy. Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDiagService } from '../../src/core/diag/diag.js';
import { startCluster } from '../helpers/cluster.js';

const LATENCY_MS = 15;
const diag = () => [createDiagService()];

async function line(t, size = 4, config = {}) {
  const cluster = await startCluster(t, { size, topology: 'line', netem: true, services: diag, config: () => config });
  for (let i = 0; i < size - 1; i += 1) cluster.link(i, i + 1).setLatency(LATENCY_MS);
  await cluster.converged();
  return cluster;
}

test('ping across a four-node line reports three hops and a round trip no shorter than the injected latency', async (t) => {
  const cluster = await line(t);
  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[3], { count: 3, intervalMs: 20, timeoutMs: 3000 });
  assert.equal(ping.dst, cluster.ids[3]);
  assert.deepEqual([ping.sent, ping.received, ping.lossPct], [3, 3, 0]);
  assert.deepEqual(ping.probes.map((probe) => probe.hops), [3, 3, 3]);
  assert.ok(ping.probes.every((probe, i) => probe.seq === i + 1 && /^[0-9a-f]{32}$/.test(probe.id)));
  // Three links, each crossed twice, each crossing delayed by LATENCY_MS.
  const floor = 6 * LATENCY_MS * 0.8;
  assert.ok(ping.rttMs.min >= floor, `min ${ping.rttMs.min} ms is at least ${floor} ms`);
  assert.ok(ping.rttMs.max < 1500, `max ${ping.rttMs.max} ms is plausible`);
  assert.ok(ping.rttMs.min <= ping.rttMs.avg && ping.rttMs.avg <= ping.rttMs.max);
  assert.ok(ping.probes.every((probe) => probe.rttMs >= floor));

  const events = cluster.events(0, 'diag.ping');
  assert.deepEqual(events.map((event) => [event.dst, event.seq, event.hops]), [[cluster.ids[3], 1, 3], [cluster.ids[3], 2, 3], [cluster.ids[3], 3, 3]]);
  // Every node on the way and the destination counted what it did.
  assert.equal(cluster.nodes[3].stats().services.diag.probesAnswered, 3);
  assert.equal(cluster.nodes[0].stats().services.diag.repliesReceived, 3);
});

test('traceroute lists the three hops in order, each named by the node that answered', async (t) => {
  const cluster = await line(t);
  const trace = await cluster.nodes[0].service('diag').traceroute(cluster.ids[3], { timeoutMs: 2000 });
  assert.equal(trace.reached, true);
  assert.deepEqual(trace.hops.map((hop) => [hop.n, hop.node]), [[1, cluster.ids[1]], [2, cluster.ids[2]], [3, cluster.ids[3]]]);
  const rtts = trace.hops.map((hop) => hop.rttMs);
  assert.ok(rtts.every((rtt) => rtt > 0));
  assert.ok(rtts[0] >= 2 * LATENCY_MS * 0.8 && rtts[2] >= 6 * LATENCY_MS * 0.8, `${rtts}`);
  assert.ok(rtts[0] < rtts[2], 'a farther hop takes longer');
  assert.deepEqual(cluster.events(0, 'diag.trace_hop').map((event) => [event.n, event.node, event.reached]), [
    [1, cluster.ids[1], false], [2, cluster.ids[2], false], [3, cluster.ids[3], true],
  ]);
  // The middle nodes answered about themselves and forwarded the rest; nothing sealed to them was read.
  assert.equal(cluster.nodes[1].stats().services.diag.probesAnswered, 1);
  assert.equal(cluster.nodes[2].stats().services.diag.probesAnswered, 1);
});

test('ping and traceroute to a neighbour take one hop', async (t) => {
  const cluster = await line(t, 2);
  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[1], { count: 2, intervalMs: 10 });
  assert.deepEqual([ping.received, ping.probes.map((probe) => probe.hops)], [2, [1, 1]]);
  const trace = await cluster.nodes[0].service('diag').traceroute(cluster.ids[1]);
  assert.deepEqual([trace.reached, trace.hops.map((hop) => hop.node)], [true, [cluster.ids[1]]]);
});

test('when the last link goes silent, ping reports loss and traceroute stops at the last reachable hop', async (t) => {
  // A long peer timeout keeps the silent link looking alive for the whole test, however slow the machine.
  const cluster = await line(t, 4, { timers: { peerTimeoutMs: 6000 } });
  cluster.link(2, 3).blackhole();
  // The routes still exist for a moment (the silence has not yet been noticed), so the probes are sent and lost.
  const trace = await cluster.nodes[0].service('diag').traceroute(cluster.ids[3], { timeoutMs: 500 });
  assert.equal(trace.reached, false);
  assert.deepEqual(trace.hops.slice(0, 2).map((hop) => hop.node), [cluster.ids[1], cluster.ids[2]], 'the two reachable hops answered');
  assert.ok(trace.hops.slice(2).every((hop) => hop.node === null && hop.rttMs === null), 'then silence');
  assert.ok(trace.hops.length >= 3 && trace.hops.length <= 5, 'it gives up after three silent hops');

  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[3], { count: 2, intervalMs: 10, timeoutMs: 400 });
  assert.deepEqual([ping.sent, ping.received, ping.lossPct, ping.rttMs], [2, 0, 100, null]);
  assert.deepEqual(ping.probes.map((probe) => [probe.rttMs, probe.hops]), [[null, null], [null, null]]);
});

test('once the route is gone a ping is lost at once and a traceroute has nothing to ask', async (t) => {
  const cluster = await line(t);
  cluster.link(2, 3).cut();
  await cluster.waitFor(() => !cluster.nodes[0].routes().some((route) => route.dst === cluster.ids[3]), { message: 'the route to the far node to expire' });
  const started = Date.now();
  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[3], { count: 2, intervalMs: 10, timeoutMs: 5000 });
  assert.equal(ping.received, 0);
  assert.ok(Date.now() - started < 1000, 'it did not wait for the 5 s timeout');
  const trace = await cluster.nodes[0].service('diag').traceroute(cluster.ids[3], { timeoutMs: 5000 });
  assert.equal(trace.reached, false);
  assert.ok(Date.now() - started < 2000);
  // The nodes that are still there can be pinged.
  assert.equal((await cluster.nodes[0].service('diag').ping(cluster.ids[2], { count: 1 })).received, 1);
});

test('a node that does not relay is routed around, and the traceroute shows the other way round', async (t) => {
  const ring = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const cluster = await startCluster(t, {
    size: 4, topology: ring, services: diag,
    config: (i) => (i === 1 ? { caps: { transit: false } } : {}),
  });
  await cluster.converged();
  const path = cluster.nodes[0].routes().find((route) => route.dst === cluster.ids[2]).path;
  assert.deepEqual(path, [cluster.ids[0], cluster.ids[3], cluster.ids[2]], 'the route avoids the node that does not relay');
  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[2], { count: 2, intervalMs: 10 });
  assert.deepEqual([ping.received, ping.probes.map((probe) => probe.hops)], [2, [2, 2]]);
  const trace = await cluster.nodes[0].service('diag').traceroute(cluster.ids[2]);
  assert.deepEqual(trace.hops.map((hop) => hop.node), [cluster.ids[3], cluster.ids[2]]);
  // The silent node is itself reachable: it is only not used as a hop for others.
  assert.equal((await cluster.nodes[0].service('diag').ping(cluster.ids[1], { count: 1 })).received, 1);
  assert.equal(cluster.events(1, 'packet.forwarded').filter((event) => event.type === 'probe').length, 0, 'the node that does not relay forwarded no probe');
});

test('probes cannot be used to flood a node: answers are rate limited and the excess is dropped silently', async (t) => {
  const cluster = await startCluster(t, { size: 2, topology: 'line', services: () => [createDiagService({ repliesPerRsvpPerSec: 3, repliesPerSec: 50 })] });
  await cluster.converged();
  const ping = await cluster.nodes[0].service('diag').ping(cluster.ids[1], { count: 12, intervalMs: 10, timeoutMs: 600 });
  assert.equal(ping.sent, 12);
  assert.ok(ping.received >= 3 && ping.received <= 6, `${ping.received} answered out of 12 with a budget of 3 per second`);
  assert.ok(cluster.nodes[1].stats().services.diag.probesRateLimited >= 6);
});
