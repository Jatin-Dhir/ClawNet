/**
 * The diagnostics service against a fake service context: probe matching, timeouts, hop
 * arithmetic, answer rate limits and the routes. Timers are a hand-driven fake, so no test
 * waits for real time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDiagService } from '../../src/core/diag/diag.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { ConfigError, StateError } from '../../src/core/errors.js';
import { PacketType } from '../../src/core/wire/types.js';

const SELF = Identity.generate().nodeId;
const DST = Identity.generate().nodeId;
const HOP1 = Identity.generate().nodeId;
const HOP2 = Identity.generate().nodeId;
const OTHER = Identity.generate().nodeId;
const TTL = 16;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A context with a clock that only moves when the test says so. */
function setup({ options, originate, cards = new Set([OTHER, DST, HOP1]) } = {}) {
  const clock = { at: 5000 };
  const timers = [];
  const emitted = [];
  const sent = [];
  const probes = [];
  const handlers = {};
  const routes = new Map();
  const everys = [];
  const stats = { forwarder: { forwarded: 3 } };
  const service = createDiagService({ monoNow: () => clock.at, ...options });
  const ctx = {
    nodeId: SELF,
    config: { limits: { ttl: TTL } },
    now: () => clock.at,
    events: { emit: (type, data) => emitted.push({ type, data }) },
    schedule: (fn, ms) => {
      const timer = { at: clock.at + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    every: (fn, ms) => {
      everys.push({ fn, ms });
      return () => {};
    },
    messaging: {
      onKind: (kind, handler) => {
        handlers[kind] = handler;
      },
      send: async (dst, message) => {
        sent.push({ dst, ...message });
        return { id: 'x', state: 'sent' };
      },
    },
    packets: {
      onLocal: (selector, handler) => {
        handlers[selector] = handler;
      },
      originate: (packet) => {
        probes.push(packet);
        return originate === undefined ? { ok: true, nextHop: HOP1 } : originate(packet);
      },
    },
    directory: { cardOf: (id) => (cards.has(id) ? { id } : null) },
    api: {
      route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      error: (status, code, message, details) => Object.assign(new Error(message), { status, apiCode: code, details }),
      reply: (status, body) => ({ status, body }),
    },
    node: { stats: () => stats },
  };
  service.init(ctx);
  service.start();
  /** Move the clock and run every timer that has become due, in order. */
  const advance = async (ms) => {
    const target = clock.at + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      clock.at = Math.max(clock.at, due.at);
      due.fn();
      await flush();
    }
    clock.at = target;
    await flush();
  };
  const reply = (from, meta) => handlers['probe-reply']({ from, meta, id: 'r', kind: 'probe-reply', content: Buffer.alloc(0) });
  return { service, ctx, clock, emitted, sent, probes, handlers, routes, everys, advance, reply, stats };
}

const probeMeta = (probe, extra = {}) => ({ re: probe.header.id, n: probe.header.n, hop: probe.header.n, at: 'dst', ...extra });

test('init registers the reply kind, both probe handlers and three routes; start samples counters every second', () => {
  const { handlers, routes, everys } = setup();
  assert.deepEqual(Object.keys(handlers).sort(), ['probe', 'probe-reply', 'probe.expired']);
  assert.deepEqual([...routes.keys()], ['POST /diag/ping', 'POST /diag/traceroute', 'GET /diag/counters']);
  assert.deepEqual(everys.map((entry) => entry.ms), [1000]);
});

test('ping sends one probe per count with the originator as rsvp and n equal to the ttl, and matches replies by id', async () => {
  const { service, probes, reply, advance, emitted, clock } = setup();
  const pending = service.api.ping(DST, { count: 3, intervalMs: 100, timeoutMs: 1000 });
  await flush();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].type, PacketType.PROBE);
  assert.deepEqual(Object.keys(probes[0].header).sort(), ['dst', 'id', 'n', 'rsvp', 'ttl']);
  assert.deepEqual([probes[0].header.dst, probes[0].header.rsvp, probes[0].header.ttl, probes[0].header.n], [DST, SELF, TTL, TTL]);
  assert.match(probes[0].header.id, /^[0-9a-f]{32}$/);
  assert.equal(probes[0].body.length, 0);

  // Probes leave at t = 0, 100 and 200 ms; the first is answered after 12 ms, the second
  // after 8 ms, the third never.
  clock.at += 12;
  reply(DST, probeMeta(probes[0], { hop: 3 }));
  await advance(88);
  clock.at += 8;
  reply(DST, probeMeta(probes[1], { hop: 3 }));
  await advance(92);
  await advance(1000);
  const result = await pending;
  assert.equal(result.dst, DST);
  assert.equal(result.sent, 3);
  assert.equal(result.received, 2);
  assert.equal(result.lossPct, 33.3);
  assert.deepEqual(result.rttMs, { min: 8, avg: 10, max: 12 });
  assert.deepEqual(result.probes.map((p) => [p.seq, p.rttMs, p.hops]), [[1, 12, 3], [2, 8, 3], [3, null, null]]);
  assert.deepEqual(result.probes.map((p) => p.id), probes.map((p) => p.header.id));
  const pings = emitted.filter((entry) => entry.type === 'diag.ping').map((entry) => entry.data);
  assert.deepEqual(pings.map((p) => [p.seq, p.rttMs, p.hops]), [[1, 12, 3], [2, 8, 3], [3, null, null]]);
  assert.ok(pings.every((p) => p.dst === DST));
});

test('replies that do not belong are ignored: wrong sender, replay, unknown id, wrong n, bad hop, bad at', async () => {
  const { service, probes, reply, advance } = setup();
  const pending = service.api.ping(DST, { count: 1, timeoutMs: 500 });
  await flush();
  const [probe] = probes;
  reply(OTHER, probeMeta(probe));                                   // "dst" from a node that is not the destination
  reply(DST, probeMeta(probe, { re: 'f'.repeat(32) }));             // an id nobody sent
  reply(DST, probeMeta(probe, { re: 'not an id' }));
  reply(DST, probeMeta(probe, { n: probe.header.n - 1 }));          // wrong n
  reply(DST, probeMeta(probe, { hop: 0 }));
  reply(DST, probeMeta(probe, { hop: probe.header.n + 1 }));
  reply(DST, probeMeta(probe, { hop: 1.5 }));
  reply(DST, probeMeta(probe, { at: 'somewhere' }));
  reply(DST, { re: probe.header.id });                              // missing fields
  reply(DST, probeMeta(probe, { at: 'expired' }));                  // the destination never reports an expiry
  assert.equal(service.stats().repliesReceived, 0);
  assert.equal(service.stats().repliesIgnored, 10);

  reply(DST, probeMeta(probe, { hop: 2 }));
  reply(DST, probeMeta(probe, { hop: 2 }));                         // a replay of the accepted reply
  await advance(0);
  const result = await pending;
  assert.equal(result.received, 1);
  assert.equal(service.stats().repliesReceived, 1);
  assert.equal(service.stats().repliesIgnored, 11);
});

test('an expiry reply does not count as a ping answer', async () => {
  const { service, probes, reply, advance } = setup();
  const pending = service.api.ping(DST, { count: 1, timeoutMs: 500 });
  await flush();
  reply(HOP1, probeMeta(probes[0], { at: 'expired' }));
  await advance(0);
  const result = await pending;
  assert.deepEqual([result.received, result.lossPct, result.rttMs], [0, 100, null]);
});

test('a probe that cannot be sent is lost at once, without waiting for the timeout', async () => {
  const { service, advance } = setup({ originate: () => ({ ok: false, reason: 'no-route' }) });
  const pending = service.api.ping(DST, { count: 2, intervalMs: 10, timeoutMs: 60000 });
  // Only the 10 ms between the two probes passes; the 60 s timeout is never waited for.
  await flush();
  await advance(10);
  const result = await pending;
  assert.deepEqual([result.sent, result.received, result.lossPct], [2, 0, 100]);
  assert.equal(service.stats().probesUnsendable, 2);
  const thrown = setup({ originate: () => { throw new StateError('self-destination'); } });
  assert.equal((await thrown.service.api.ping(DST, { count: 1 })).received, 0);
});

test('traceroute asks for n = 1, 2, 3 in turn, reports the node that answered each and stops at the destination', async () => {
  const { service, probes, reply, advance, emitted, clock } = setup();
  const pending = service.api.traceroute(DST, { timeoutMs: 500 });
  await flush();
  assert.equal(probes.length, 1);
  assert.deepEqual([probes[0].header.ttl, probes[0].header.n], [1, 1]);
  clock.at += 4;
  reply(HOP1, probeMeta(probes[0], { at: 'expired', hop: 1 }));
  await flush();
  assert.equal(probes.length, 2);
  assert.deepEqual([probes[1].header.ttl, probes[1].header.n], [2, 2]);
  clock.at += 5;
  reply(HOP2, probeMeta(probes[1], { at: 'expired', hop: 2 }));
  await flush();
  clock.at += 6;
  reply(DST, probeMeta(probes[2], { at: 'dst', hop: 3 }));
  await advance(0);
  const result = await pending;
  assert.deepEqual(result, {
    dst: DST,
    reached: true,
    hops: [{ n: 1, node: HOP1, rttMs: 4 }, { n: 2, node: HOP2, rttMs: 5 }, { n: 3, node: DST, rttMs: 6 }],
  });
  assert.equal(probes.length, 3, 'no probe beyond the destination');
  assert.deepEqual(emitted.filter((e) => e.type === 'diag.trace_hop').map((e) => [e.data.n, e.data.node, e.data.reached]), [
    [1, HOP1, false], [2, HOP2, false], [3, DST, true],
  ]);
});

test('traceroute rejects an expiry that claims the wrong hop or comes from the destination, and gives up after three silent hops', async () => {
  const { service, probes, reply, advance } = setup();
  const pending = service.api.traceroute(DST, { timeoutMs: 200 });
  await flush();
  reply(HOP1, probeMeta(probes[0], { at: 'expired', hop: 1 }));     // hop 1 answers
  await flush();
  reply(HOP2, probeMeta(probes[1], { at: 'expired', hop: 1 }));     // n = 2 but claims hop 1: ignored
  reply(DST, probeMeta(probes[1], { at: 'expired', hop: 2 }));      // the destination never expires a probe
  await advance(200);                                              // hop 2 times out
  await advance(200);                                              // hop 3
  await advance(200);                                              // hop 4: three silent hops in a row
  const result = await pending;
  assert.equal(result.reached, false);
  assert.deepEqual(result.hops.map((hop) => [hop.n, hop.node]), [[1, HOP1], [2, null], [3, null], [4, null]]);
  assert.equal(probes.length, 4);
});

test('traceroute with no route ends after three unsendable hops', async () => {
  const { service } = setup({ originate: () => ({ ok: false, reason: 'no-route' }) });
  const result = await service.api.traceroute(DST);
  assert.deepEqual(result.hops.map((hop) => hop.n), [1, 2, 3]);
  assert.equal(result.reached, false);
});

test('a probe is answered with its hop number: n - ttl + 1, for every n and every ttl', async () => {
  const { handlers, sent, clock } = setup({ options: { repliesPerSec: 1_000_000, repliesPerRsvpPerSec: 1_000_000 } });
  let counter = 0;
  for (let n = 1; n <= 32; n += 1) {
    for (let ttl = 1; ttl <= n; ttl += 1) {
      counter += 1;
      clock.at += 1;
      handlers.probe({ type: PacketType.PROBE, header: { id: counter.toString(16).padStart(32, '0'), dst: SELF, ttl, rsvp: OTHER, n }, body: Buffer.alloc(0) }, { from: HOP1 });
      const message = sent.at(-1);
      assert.deepEqual(message.meta, { re: counter.toString(16).padStart(32, '0'), n, hop: n - ttl + 1, at: 'dst' });
      assert.equal(message.reliable, false);
      assert.equal(message.kind, 'probe-reply');
      assert.equal(message.dst, OTHER);
    }
  }
  clock.at += 1;
  handlers['probe.expired']({ type: PacketType.PROBE, header: { id: 'a'.repeat(32), dst: DST, ttl: 1, rsvp: OTHER, n: 5 }, body: Buffer.alloc(0) }, { from: HOP1 });
  assert.deepEqual(sent.at(-1).meta, { re: 'a'.repeat(32), n: 5, hop: 5, at: 'expired' });
});

test('answers are limited per rsvp and in total, and the buckets refill with time', () => {
  const { handlers, sent, clock, service } = setup({ options: { repliesPerSec: 8, repliesPerRsvpPerSec: 3 } });
  const probe = (rsvp, i) => handlers.probe({ type: PacketType.PROBE, header: { id: i.toString(16).padStart(32, '0'), dst: SELF, ttl: 5, rsvp, n: 5 }, body: Buffer.alloc(0) }, { from: HOP1 });
  for (let i = 1; i <= 10; i += 1) probe(OTHER, i);
  assert.equal(sent.length, 3, 'the per-rsvp budget (five in production, three here) caps one originator');
  assert.equal(service.stats().probesRateLimited, 7);
  clock.at += 1000;
  probe(OTHER, 20);
  probe(OTHER, 21);
  assert.equal(sent.length, 5, 'tokens came back after a second');
});

test('the total budget is shared by every rsvp', () => {
  const cards = new Set();
  const rsvps = Array.from({ length: 12 }, () => Identity.generate().nodeId);
  for (const id of rsvps) cards.add(id);
  const { handlers, sent, service } = setup({ options: { repliesPerSec: 8, repliesPerRsvpPerSec: 3 }, cards });
  rsvps.forEach((rsvp, i) => handlers.probe({ type: PacketType.PROBE, header: { id: (i + 1).toString(16).padStart(32, '0'), dst: SELF, ttl: 5, rsvp, n: 5 }, body: Buffer.alloc(0) }, { from: HOP1 }));
  assert.equal(sent.length, 8);
  assert.equal(service.stats().probesRateLimited, 4);
});

test('a probe from an originator whose card is unknown is not answered and costs no budget', () => {
  const stranger = Identity.generate().nodeId;
  const { handlers, sent, service } = setup({ options: { repliesPerSec: 2, repliesPerRsvpPerSec: 2 } });
  for (let i = 1; i <= 20; i += 1) {
    handlers.probe({ type: PacketType.PROBE, header: { id: i.toString(16).padStart(32, '0'), dst: SELF, ttl: 3, rsvp: stranger, n: 3 }, body: Buffer.alloc(0) }, { from: HOP1 });
  }
  assert.equal(sent.length, 0);
  assert.equal(service.stats().probesUnanswerable, 20);
  assert.equal(service.stats().probesRateLimited, 0);
  handlers.probe({ type: PacketType.PROBE, header: { id: 'b'.repeat(32), dst: SELF, ttl: 3, rsvp: OTHER, n: 3 }, body: Buffer.alloc(0) }, { from: HOP1 });
  assert.equal(sent.length, 1, 'a known originator still gets its answer');
});

test('too many probes at once are refused as busy, and the slots come back when they finish', async () => {
  const { service, advance } = setup({ options: { maxPending: 4 } });
  const first = service.api.ping(DST, { count: 3, timeoutMs: 100, intervalMs: 10 });
  await assert.rejects(service.api.ping(DST, { count: 2 }), (error) => error instanceof StateError && error.message.startsWith('busy:'));
  await advance(10_000);
  await first;
  const again = service.api.ping(DST, { count: 4, timeoutMs: 100, intervalMs: 10 });
  await advance(1000);
  assert.equal((await again).sent, 4);
});

test('arguments are validated before anything is sent', async () => {
  const { service, probes } = setup();
  const bad = [
    ['nope', {}], [SELF, {}], [DST, { count: 0 }], [DST, { count: 101 }], [DST, { count: 1.5 }],
    [DST, { intervalMs: 9 }], [DST, { timeoutMs: 99 }], [DST, { timeoutMs: 60001 }],
  ];
  for (const [dst, options] of bad) {
    await assert.rejects(service.api.ping(dst, options), ConfigError, JSON.stringify([dst, options]));
  }
  await assert.rejects(service.api.traceroute(DST, { maxHops: 0 }), ConfigError);
  await assert.rejects(service.api.traceroute(DST, { maxHops: TTL + 1 }), ConfigError);
  await assert.rejects(service.api.traceroute(SELF), ConfigError);
  assert.equal(probes.length, 0);
  assert.throws(() => createDiagService({ maxPending: 0 }), ConfigError);
  assert.throws(() => createDiagService({ repliesPerSec: 1.5 }), ConfigError);
  assert.throws(() => createDiagService({ monoNow: 3 }), ConfigError);
});

test('stop releases a waiting ping as lost, and the service refuses work afterwards', async () => {
  const { service } = setup();
  const pending = service.api.ping(DST, { count: 5, intervalMs: 1000, timeoutMs: 60000 });
  await flush();
  service.stop();
  const result = await pending;
  assert.equal(result.received, 0);
  assert.ok(result.sent >= 1 && result.sent <= 5);
  await assert.rejects(service.api.ping(DST), (error) => error instanceof StateError && error.message.startsWith('not-running:'));
  assert.throws(() => service.api.counters(), StateError);
});

test('counters reflect the node statistics and move', async () => {
  const { service, stats, advance } = setup();
  stats.forwarder.forwarded = 3;
  await advance(1000);
  assert.equal(service.api.counters().totals['forwarder.forwarded'], 3);
  stats.forwarder.forwarded = 13;
  const snapshot = service.api.counters();
  assert.equal(snapshot.totals['forwarder.forwarded'], 13);
});

test('the routes validate their body and pass the arguments through', async () => {
  const { service, routes, advance, reply, probes } = setup();
  const ping = routes.get('POST /diag/ping');
  const trace = routes.get('POST /diag/traceroute');
  const failure = (promise) => Promise.resolve(promise).then(() => assert.fail('expected a rejection'), (error) => error);
  for (const body of [null, [], {}, { to: 'x' }, { to: SELF }, { to: DST, extra: 1 }, { to: DST, count: 0 }, { to: DST, count: '3' }, { to: DST, intervalMs: 5 }, { to: DST, timeoutMs: 70000 }]) {
    const error = await failure(ping({ body, signal: new AbortController().signal }));
    assert.deepEqual([error.status, error.apiCode], [400, 'invalid_request'], JSON.stringify(body));
  }
  for (const body of [null, { to: 'x' }, { to: DST, maxHops: 0 }, { to: DST, maxHops: TTL + 1 }, { to: DST, timeoutMs: 1 }, { to: DST, junk: true }]) {
    assert.equal((await failure(trace({ body, signal: new AbortController().signal }))).apiCode, 'invalid_request', JSON.stringify(body));
  }
  const running = ping({ body: { to: DST, count: 1, timeoutMs: 100 }, signal: new AbortController().signal });
  await flush();
  reply(DST, probeMeta(probes[0], { hop: 4 }));
  await advance(0);
  const result = await running;
  assert.equal(result.probes[0].hops, 4);
  assert.equal(service.stats().pings, 1);
  assert.equal(typeof routes.get('GET /diag/counters')({ query: {} }).at, 'number');
  assert.equal((await failure(Promise.resolve().then(() => routes.get('GET /diag/counters')({ query: { a: '1' } })))).status, 400);
});

test('a request that is aborted stops sending further probes', async () => {
  const { service, probes, advance } = setup();
  const controller = new AbortController();
  const pending = service.api.ping(DST, { count: 5, intervalMs: 100, timeoutMs: 100, signal: controller.signal });
  await flush();
  controller.abort();
  await advance(10_000);
  const result = await pending;
  assert.equal(probes.length, 1);
  assert.equal(result.sent, 1);
});
