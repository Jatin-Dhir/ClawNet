import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DropReason,
  FORWARD_DEDUPE_TTL_MS,
  Forwarder,
  LOCAL_SELECTORS,
} from '../../src/core/routing/forwarder.js';
import { ConfigError, ProtocolError, StateError } from '../../src/core/errors.js';
import { publicKeyToNodeId } from '../../src/core/crypto/identity.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { PACKET_PREFIX_BYTES, decodePacket, encodePacket } from '../../src/core/wire/codec.js';
import { PacketType } from '../../src/core/wire/types.js';

const node = (n) => publicKeyToNodeId(Buffer.alloc(32, n));
const ME = node(1);
const A = node(2);
const B = node(3);
const C = node(4);
const D = node(5);
const SEALED = Buffer.from([1, 9, 9, 9]);
const TRANSFER = Buffer.from([2, 9, 9, 9]);

let idCounter = 0;
const freshId = () => (idCounter += 1).toString(16).padStart(32, '0');

function data({ dst = D, id = freshId(), ttl = 16, tries = 0, body = SEALED, cust } = {}) {
  const header = { id, dst, ttl, try: tries };
  if (cust !== undefined) header.cust = cust;
  return { type: PacketType.DATA, header, body };
}

function probe({ dst = D, id = freshId(), ttl = 5, n = 5, rsvp = A } = {}) {
  return { type: PacketType.PROBE, header: { id, dst, ttl, rsvp, n }, body: Buffer.alloc(0) };
}

/** A forwarder wired to fakes: a clock, timers, links and an event list. */
function rig(options = {}) {
  const clock = { now: 10_000 };
  const timers = [];
  const routes = new Map();
  const neighbours = new Set();
  const refused = new Set();
  const sent = [];
  const events = [];
  const log = [];
  const rig = {
    clock,
    routes,
    neighbours,
    refused,
    sent,
    events,
    log,
    timers,
    sendHook: null,
    liveTimers: () => timers.filter((timer) => timer.live).length,
    advance(ms) {
      const target = clock.now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        clock.now = Math.max(clock.now, due.at);
        due.live = false;
        due.fn();
      }
      clock.now = target;
    },
    types: (type) => events.filter((event) => event.type === type).map((event) => event.data),
  };
  rig.fwd = new Forwarder({
    selfId: ME,
    nextHop: (dst) => routes.get(dst) ?? null,
    isNeighbour: (id) => neighbours.has(id),
    send: (hop, packet) => {
      if (rig.sendHook !== null) return rig.sendHook(hop, packet);
      if (refused.has(hop)) return false;
      sent.push({ hop, packet });
      return true;
    },
    events: { emit: (type, data) => events.push({ type, data }) },
    monoNow: () => clock.now,
    schedule: (fn, ms) => {
      const timer = { at: clock.now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    log: { warn: (message, fields) => log.push({ message, fields }) },
    ...options,
  });
  return rig;
}

test('a packet for this node goes to the handler for its body scheme', () => {
  const r = rig();
  const got = [];
  for (const selector of ['data.sealed', 'data.transfer', 'probe']) {
    r.fwd.onLocal(selector, (packet, info) => got.push([selector, packet.header.id, info.from]));
  }
  const sealed = data({ dst: ME, body: SEALED });
  const transfer = data({ dst: ME, body: TRANSFER });
  const ping = probe({ dst: ME });
  r.fwd.handle(A, sealed);
  r.fwd.handle(B, transfer);
  r.fwd.handle(C, ping);
  assert.deepEqual(got, [
    ['data.sealed', sealed.header.id, A],
    ['data.transfer', transfer.header.id, B],
    ['probe', ping.header.id, C],
  ]);
  assert.equal(r.fwd.stats().delivered, 3);
  assert.equal(r.sent.length, 0);
});

test('delivery ignores the hop limit, and a scheme-2 packet makes no event', () => {
  const r = rig();
  r.fwd.onLocal('data.sealed', () => {});
  r.fwd.onLocal('data.transfer', () => {});
  r.fwd.handle(A, data({ dst: ME, ttl: 0 }));
  r.fwd.handle(A, data({ dst: ME, ttl: 1, body: TRANSFER }));
  assert.equal(r.fwd.stats().delivered, 2);
  const delivered = r.types('packet.delivered');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'data');
  assert.equal(delivered[0].from, A);
});

test('an empty body, an unknown scheme or a missing handler is a counted drop, not an error', () => {
  const r = rig();
  r.fwd.onLocal('data.sealed', () => {});
  r.fwd.handle(A, data({ dst: ME, body: Buffer.alloc(0) }));
  r.fwd.handle(A, data({ dst: ME, body: Buffer.from([0, 1]) }));
  r.fwd.handle(A, data({ dst: ME, body: Buffer.from([3, 1]) }));
  r.fwd.handle(A, data({ dst: ME, body: TRANSFER }));
  r.fwd.handle(A, probe({ dst: ME }));
  const stats = r.fwd.stats();
  assert.equal(stats.dropped_malformed, 3);
  assert.equal(stats['dropped_no-handler'], 2);
  assert.equal(stats.delivered, 0);
  assert.deepEqual(r.types('packet.dropped').map((e) => e.reason), [
    'malformed', 'malformed', 'malformed', 'no-handler', 'no-handler',
  ]);
});

test('onLocal validates its arguments and null removes a handler', () => {
  const r = rig();
  assert.throws(() => r.fwd.onLocal('nope', () => {}), ConfigError);
  assert.throws(() => r.fwd.onLocal('probe', 'x'), ConfigError);
  assert.deepEqual([...LOCAL_SELECTORS], ['data.sealed', 'data.transfer', 'probe', 'probe.expired']);
  r.fwd.onLocal('data.sealed', () => {});
  r.fwd.onLocal('data.sealed', null);
  r.fwd.handle(A, data({ dst: ME }));
  assert.equal(r.fwd.stats()['dropped_no-handler'], 1);
});

test('a local handler that throws or rejects is contained and counted', async () => {
  const r = rig();
  r.fwd.onLocal('data.sealed', () => {
    throw new Error('boom with secret text');
  });
  r.fwd.onLocal('data.transfer', () => Promise.reject(new Error('later')));
  r.fwd.handle(A, data({ dst: ME }));
  r.fwd.handle(A, data({ dst: ME, body: TRANSFER }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.fwd.stats().handlerErrors, 2);
  assert.equal(JSON.stringify(r.log).includes('secret text'), false);
});

test('forwarding sends the decremented ttl to the next hop and leaves the input alone', () => {
  const r = rig();
  r.routes.set(D, B);
  const packet = data({ ttl: 16, tries: 3, body: Buffer.from([1, 2, 3]) });
  const before = structuredClone(packet.header);
  r.fwd.handle(A, packet);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].hop, B);
  assert.deepEqual(r.sent[0].packet.header, { ...before, ttl: 15 });
  assert.equal(r.sent[0].packet.type, PacketType.DATA);
  assert.deepEqual(r.sent[0].packet.body, Buffer.from([1, 2, 3]));
  assert.deepEqual(packet.header, before);
  const forwarded = r.types('packet.forwarded');
  assert.equal(forwarded.length, 1);
  assert.deepEqual(
    { ttl: forwarded[0].ttl, nextHop: forwarded[0].nextHop, from: forwarded[0].from, dst: forwarded[0].dst },
    { ttl: 15, nextHop: B, from: A, dst: D },
  );
  assert.equal(forwarded[0].bytes, encodePacket({ ...r.sent[0].packet }).length);
});

test('the hop limit: 1 is dropped, 2 is forwarded as 1, 32 as 31', () => {
  const r = rig();
  r.routes.set(D, B);
  r.fwd.handle(A, data({ ttl: 1 }));
  r.fwd.handle(A, data({ ttl: 0 }));
  r.fwd.handle(A, data({ ttl: 2 }));
  r.fwd.handle(A, data({ ttl: 32 }));
  assert.deepEqual(r.sent.map((s) => s.packet.header.ttl), [1, 31]);
  assert.equal(r.fwd.stats().dropped_ttl, 2);
});

test('a probe that runs out of hops is handed to probe.expired and then dropped', () => {
  const r = rig();
  const expired = [];
  r.fwd.onLocal('probe.expired', (packet, info) => expired.push([packet.header.id, packet.header.ttl, info.from]));
  r.routes.set(D, B);
  const last = probe({ ttl: 1, n: 3 });
  r.fwd.handle(A, last);
  r.fwd.handle(A, probe({ ttl: 2, n: 3 }));
  assert.deepEqual(expired, [[last.header.id, 1, A]]);
  assert.equal(r.fwd.stats().dropped_ttl, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].packet.header.ttl, 1);
  assert.equal(r.sent[0].packet.header.n, 3);
  assert.equal(r.sent[0].packet.type, PacketType.PROBE);
});

test('a data packet whose ttl ran out does not touch probe.expired', () => {
  const r = rig();
  let called = 0;
  r.fwd.onLocal('probe.expired', () => {
    called += 1;
  });
  r.fwd.handle(A, data({ ttl: 1 }));
  assert.equal(called, 0);
});

test('a node that does not relay drops packets for others but still delivers its own', () => {
  for (const transit of [false, () => false]) {
    const r = rig({ transit });
    r.routes.set(D, B);
    r.fwd.onLocal('data.sealed', () => {});
    r.fwd.handle(A, data());
    r.fwd.handle(A, data({ dst: ME }));
    assert.equal(r.sent.length, 0);
    assert.equal(r.fwd.stats()['dropped_no-transit'], 1);
    assert.equal(r.fwd.stats().delivered, 1);
  }
  let relay = false;
  const r = rig({ transit: () => relay });
  r.routes.set(D, B);
  r.fwd.handle(A, data());
  relay = true;
  r.fwd.handle(A, data());
  assert.equal(r.sent.length, 1);
});

test('duplicates: the key covers dst, id, try, cust and body, not just the header', () => {
  const r = rig();
  r.routes.set(D, B);
  const id = freshId();
  const first = data({ id, body: Buffer.from([1, 1]) });
  r.fwd.handle(A, first);
  r.fwd.handle(C, data({ id, body: Buffer.from([1, 1]) }));
  assert.equal(r.sent.length, 1, 'identical copy from another neighbour is a duplicate');
  r.fwd.handle(A, data({ id, tries: 1, body: Buffer.from([1, 1]) }));
  assert.equal(r.sent.length, 2, 'a higher try is forwarded again');
  r.fwd.handle(A, data({ id, body: Buffer.from([1, 2]) }));
  assert.equal(r.sent.length, 3, 'same header with another body is forwarded (a junk body cannot burn the id)');
  r.fwd.handle(A, data({ id, body: Buffer.from([1, 1]), cust: C }));
  assert.equal(r.sent.length, 4, 'a different cust is forwarded again');
  r.fwd.handle(A, data({ id, body: Buffer.from([1, 1]), cust: C }));
  assert.equal(r.sent.length, 4);
  r.routes.set(C, B);
  r.fwd.handle(A, data({ id, dst: C, body: Buffer.from([1, 1]) }));
  assert.equal(r.sent.length, 5, 'a different destination is a different packet');
  assert.equal(r.fwd.stats().dropped_duplicate, 2);
});

test('duplicates are counted and reported; entries last 60 seconds', () => {
  const r = rig();
  r.routes.set(D, B);
  const packet = data();
  r.fwd.handle(A, packet);
  r.fwd.handle(A, packet);
  r.fwd.handle(A, packet);
  assert.equal(r.fwd.stats().dropped_duplicate, 2);
  assert.equal(r.types('packet.dropped').filter((e) => e.reason === 'duplicate').length, 2);
  r.advance(FORWARD_DEDUPE_TTL_MS - 1);
  r.fwd.handle(A, packet);
  assert.equal(r.sent.length, 1);
  r.advance(1);
  r.fwd.handle(A, packet);
  assert.equal(r.sent.length, 2, 'after 60 s the same packet is forwarded again');
});

test('a probe is a duplicate by id, destination, requester and n', () => {
  const r = rig();
  r.routes.set(D, B);
  const first = probe({ n: 4, ttl: 4 });
  r.fwd.handle(A, first);
  r.fwd.handle(C, { ...first, header: { ...first.header, ttl: 3 } });
  assert.equal(r.sent.length, 1);
  r.fwd.handle(A, probe({ id: first.header.id, n: 5, ttl: 5 }));
  assert.equal(r.sent.length, 2);
});

test('a destination that is a live direct neighbour is sent to directly', () => {
  const r = rig();
  r.routes.set(D, B);
  r.neighbours.add(D);
  r.fwd.handle(A, data({ dst: D }));
  assert.equal(r.sent[0].hop, D);
  const sent = r.fwd.originate(data({ dst: D }));
  assert.deepEqual(sent, { ok: true, nextHop: D });
  assert.equal(r.sent[1].hop, D);
  r.neighbours.delete(D);
  r.fwd.handle(A, data({ dst: D }));
  assert.equal(r.sent[2].hop, B);
});

test('no route holds the packet; flush releases it when a route appears', () => {
  const r = rig();
  r.fwd.handle(A, data());
  assert.equal(r.sent.length, 0);
  assert.equal(r.fwd.stats().transitQueueLen, 1);
  assert.equal(r.types('packet.queued')[0].reason, 'no-route');
  assert.equal(r.liveTimers(), 1);
  r.fwd.flush();
  assert.equal(r.sent.length, 0, 'still no route');
  r.routes.set(D, B);
  r.fwd.flush();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].packet.header.ttl, 15);
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.equal(r.fwd.stats().transitQueueBytes, 0);
  assert.equal(r.liveTimers(), 0, 'the hold timer is cancelled when the queue is empty');
  assert.equal(r.fwd.stats().forwarded, 1);
});

test('split horizon: a route that points back at the sender queues instead of bouncing', () => {
  const r = rig();
  r.routes.set(D, A);
  r.fwd.handle(A, data());
  assert.equal(r.sent.length, 0);
  assert.equal(r.types('packet.queued')[0].reason, 'split-horizon');
  r.routes.set(D, B);
  r.fwd.flush();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].hop, B);
});

test('back-pressure queues, flush keeps order per next hop', () => {
  const r = rig();
  r.routes.set(D, B);
  r.refused.add(B);
  const ids = [freshId(), freshId(), freshId()];
  for (const id of ids) r.fwd.handle(A, data({ id }));
  assert.equal(r.fwd.stats().transitQueueLen, 3);
  assert.equal(r.types('packet.queued')[0].reason, 'backpressure');
  r.fwd.flush();
  assert.equal(r.sent.length, 0);
  r.refused.delete(B);
  r.fwd.flush();
  assert.deepEqual(r.sent.map((s) => s.packet.header.id), ids);
});

test('a refusal during a flush holds back later packets for that hop only', () => {
  const r = rig();
  const X = node(9);
  r.routes.set(D, B);
  r.routes.set(C, X);
  const refusing = new Set([B, X]);
  const attempts = new Map();
  r.sendHook = (hop, packet) => {
    attempts.set(hop, (attempts.get(hop) ?? 0) + 1);
    if (refusing.has(hop)) return false;
    r.sent.push({ hop, packet });
    return true;
  };
  const first = data({ dst: D });
  const other = data({ dst: C });
  const second = data({ dst: D });
  for (const packet of [first, other, second]) r.fwd.handle(A, packet);
  assert.equal(r.fwd.stats().transitQueueLen, 3);
  refusing.delete(X);
  attempts.clear();
  r.fwd.flush();
  assert.deepEqual(r.sent.map((s) => s.packet.header.id), [other.header.id]);
  assert.equal(attempts.get(B), 1, 'the second packet for B was not even tried');
  assert.equal(attempts.get(X), 1);
  assert.equal(r.fwd.stats().transitQueueLen, 2);
  refusing.clear();
  r.fwd.flush();
  assert.deepEqual(r.sent.slice(1).map((s) => s.packet.header.id), [first.header.id, second.header.id]);
});

test('a send that throws is held like back-pressure and counted', () => {
  const r = rig();
  r.routes.set(D, B);
  r.sendHook = () => {
    throw new Error('link closed');
  };
  r.fwd.handle(A, data());
  assert.equal(r.fwd.stats().sendErrors, 1);
  assert.equal(r.fwd.stats().transitQueueLen, 1);
  assert.equal(r.log.length, 1);
});

test('a held packet is dropped when its hold time is up', () => {
  const r = rig({ transitHoldMs: 30_000 });
  r.fwd.handle(A, data());
  r.advance(10_000);
  r.fwd.handle(A, data());
  assert.equal(r.liveTimers(), 1);
  r.advance(19_999);
  assert.equal(r.fwd.stats().transitQueueLen, 2);
  r.advance(1);
  assert.equal(r.fwd.stats().transitQueueLen, 1);
  assert.equal(r.fwd.stats()['dropped_hold-expired'], 1);
  assert.equal(r.liveTimers(), 1, 'the timer moved to the second packet');
  r.advance(10_000);
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.equal(r.fwd.stats()['dropped_hold-expired'], 2);
  assert.equal(r.liveTimers(), 0);
  assert.equal(r.fwd.stats().transitQueueBytes, 0);
});

test('flush drops a packet whose time is up instead of sending it', () => {
  const r = rig({ transitHoldMs: 1_000 });
  r.fwd.handle(A, data());
  r.clock.now += 1_000;
  r.routes.set(D, B);
  r.fwd.flush();
  assert.equal(r.sent.length, 0);
  assert.equal(r.fwd.stats()['dropped_hold-expired'], 1);
});

test('transit queue bound 1: number of packets', () => {
  const r = rig({ transitQueueMax: 8 });
  for (let i = 0; i < 12; i += 1) r.fwd.handle(node(10 + i), data());
  assert.equal(r.fwd.stats().transitQueueLen, 8);
  assert.equal(r.fwd.stats()['dropped_transit-full'], 4);
});

test('transit queue bound 2: bytes', () => {
  const r = rig({ transitQueueMax: 100, transitQueueMaxBytes: 1_000 });
  const body = Buffer.concat([Buffer.from([1]), Buffer.alloc(299)]);
  for (let i = 0; i < 5; i += 1) r.fwd.handle(node(10 + i), data({ body }));
  const stats = r.fwd.stats();
  assert.ok(stats.transitQueueBytes <= 1_000);
  assert.equal(stats.transitQueueLen, 2);
  assert.equal(stats['dropped_transit-full'], 3);
});

test('transit queue bound 3: a quarter of the queue per previous hop', () => {
  const r = rig({ transitQueueMax: 8 });
  for (let i = 0; i < 6; i += 1) r.fwd.handle(A, data());
  assert.equal(r.fwd.stats().transitQueueLen, 2);
  assert.equal(r.fwd.stats()['dropped_transit-full'], 4);
  r.fwd.handle(B, data());
  assert.equal(r.fwd.stats().transitQueueLen, 3);
  r.routes.set(D, C);
  r.fwd.flush();
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  r.routes.delete(D);
  for (let i = 0; i < 3; i += 1) r.fwd.handle(A, data());
  assert.equal(r.fwd.stats().transitQueueLen, 2, 'the per-neighbour count was released by the flush');
});

test('invalid headers are protocol errors; nothing is forwarded or recorded', () => {
  const r = rig();
  r.routes.set(D, B);
  const ok = data();
  const bad = [
    { ...ok, header: { ...ok.header, extra: 1 } },
    { ...ok, header: { id: ok.header.id, dst: D, ttl: 16 } },
    { ...ok, header: { ...ok.header, id: 'A'.repeat(32) } },
    { ...ok, header: { ...ok.header, id: 'abc' } },
    { ...ok, header: { ...ok.header, dst: 'nope' } },
    { ...ok, header: { ...ok.header, ttl: 33 } },
    { ...ok, header: { ...ok.header, ttl: -1 } },
    { ...ok, header: { ...ok.header, ttl: 1.5 } },
    { ...ok, header: { ...ok.header, try: 256 } },
    { ...ok, header: { ...ok.header, cust: 'x' } },
    { ...ok, header: { ...ok.header, cust: undefined, extra: undefined } },
    { ...ok, header: null },
    { ...ok, header: [] },
    { ...ok, body: 'text' },
    { type: PacketType.PING, header: { n: '0123456789abcdef' }, body: Buffer.alloc(0) },
    { type: 99, header: ok.header, body: ok.body },
    { type: PacketType.PROBE, header: { ...probe().header, ttl: 6, n: 5 }, body: Buffer.alloc(0) },
    { type: PacketType.PROBE, header: probe().header, body: Buffer.from([1]) },
    { type: PacketType.PROBE, header: ok.header, body: Buffer.alloc(0) },
    null,
    'packet',
    undefined,
  ];
  for (const packet of bad) {
    assert.throws(() => r.fwd.handle(A, packet), ProtocolError, JSON.stringify(packet?.header ?? packet));
  }
  assert.equal(r.sent.length, 0);
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.equal(r.fwd.stats().seenEntries, 0);
  assert.throws(() => r.fwd.handle('not-a-node', ok), ConfigError);
});

test('prototype pollution and accessor tricks in a header do not get through', () => {
  const r = rig();
  r.routes.set(D, B);
  const header = JSON.parse(`{"id":"${freshId()}","dst":"${D}","ttl":16,"try":0,"__proto__":{"x":1}}`);
  assert.throws(() => r.fwd.handle(A, { type: PacketType.DATA, header, body: SEALED }), ProtocolError);
  let reads = 0;
  const sneaky = {
    id: freshId(),
    dst: D,
    try: 0,
    get ttl() {
      reads += 1;
      return reads === 1 ? 16 : 999;
    },
  };
  r.fwd.handle(A, { type: PacketType.DATA, header: sneaky, body: SEALED });
  assert.equal(r.sent[0].packet.header.ttl, 15, 'the header that was validated is the one used');
});

test('originate: no route is returned, not queued; a route sends and reports', () => {
  const r = rig();
  const packet = data({ tries: 7 });
  assert.deepEqual(r.fwd.originate(packet), { ok: false, reason: 'no-route' });
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.equal(r.fwd.stats().originated, 0);
  assert.equal(r.fwd.stats().originateNoRoute, 1);
  r.routes.set(D, B);
  const result = r.fwd.originate(packet, { path: [ME, B, D] });
  assert.deepEqual(result, { ok: true, nextHop: B });
  assert.equal(r.sent[0].packet.header.ttl, 16, 'the originator does not decrement');
  const sentEvent = r.types('packet.sent');
  assert.equal(sentEvent.length, 1);
  assert.deepEqual(
    { try: sentEvent[0].try, path: sentEvent[0].path, nextHop: sentEvent[0].nextHop, type: sentEvent[0].type },
    { try: 7, path: [ME, B, D], nextHop: B, type: 'data' },
  );
  assert.equal(r.fwd.stats().originated, 1);
});

test('originate: back-pressure is returned and a bad path is not reported', () => {
  const r = rig();
  r.routes.set(D, B);
  r.refused.add(B);
  assert.deepEqual(r.fwd.originate(data()), { ok: false, reason: 'backpressure' });
  r.refused.clear();
  assert.equal(r.fwd.originate(data(), { path: ['not-a-node'] }).ok, true);
  assert.equal(r.types('packet.sent')[0].path, null);
  assert.equal(r.fwd.originate(probe(), { path: undefined }).ok, true);
  assert.equal(r.types('packet.sent')[1].try, null);
  assert.equal(r.types('packet.sent')[1].type, 'probe');
});

test('originate: scheme-2 packets make no event; self-destination and bad headers throw', () => {
  const r = rig();
  r.routes.set(D, B);
  assert.equal(r.fwd.originate(data({ body: TRANSFER })).ok, true);
  assert.equal(r.types('packet.sent').length, 0);
  assert.equal(r.fwd.stats().originated, 1);
  assert.throws(() => r.fwd.originate(data({ dst: ME })), StateError);
  assert.throws(() => r.fwd.originate({ type: PacketType.DATA, header: { id: 'x' }, body: SEALED }), ConfigError);
  assert.throws(() => r.fwd.originate(null), ConfigError);
});

test('a copy of our own packet that loops back is dropped as a duplicate', () => {
  const r = rig();
  r.routes.set(D, B);
  const packet = data();
  r.fwd.originate(packet);
  r.fwd.handle(B, { ...packet, header: { ...packet.header, ttl: 15 } });
  assert.equal(r.fwd.stats().dropped_duplicate, 1);
  assert.equal(r.sent.length, 1);
});

test('originate again after back-pressure is not a duplicate of itself', () => {
  const r = rig();
  r.routes.set(D, B);
  const packet = data();
  r.refused.add(B);
  assert.equal(r.fwd.originate(packet).ok, false);
  r.refused.clear();
  assert.equal(r.fwd.originate(packet).ok, true);
});

test('MAX_ROUTED_PACKET: oversize is dropped when forwarding and refused when originating', () => {
  const max = 600;
  const r = rig({ maxRoutedPacket: max });
  r.routes.set(D, B);
  const exact = (bodyLength, ttlOut) => {
    const probeData = data({ body: Buffer.alloc(bodyLength, 1) });
    const header = { ...probeData.header, ttl: ttlOut };
    return PACKET_PREFIX_BYTES + canonicalBytes(header).length + bodyLength;
  };
  let fits = max;
  while (exact(fits, 15) > max) fits -= 1;
  r.fwd.handle(A, data({ body: Buffer.alloc(fits, 1) }));
  assert.equal(r.sent.length, 1, 'a packet of exactly the limit is forwarded');
  r.fwd.handle(A, data({ body: Buffer.alloc(fits + 1, 1) }));
  r.fwd.handle(A, data({ body: Buffer.alloc(max + 1, 1) }));
  assert.equal(r.sent.length, 1);
  assert.equal(r.fwd.stats().dropped_oversize, 2);
  assert.deepEqual(r.fwd.originate(data({ body: Buffer.alloc(max, 1) })), { ok: false, reason: 'oversize' });
  assert.equal(r.fwd.stats().dropped_oversize, 3);
  assert.equal(r.fwd.originate(data({ body: Buffer.alloc(fits, 1) })).ok, true);
  assert.equal(r.fwd.stats().seenEntries, 3);
  assert.equal(r.types('packet.dropped').filter((e) => e.reason === 'oversize').length, 3);
});

test('the real limit is Limits.MAX_ROUTED_PACKET, and a packet for us may exceed it', () => {
  const r = rig();
  r.routes.set(D, B);
  const big = Buffer.alloc(128 * 1024, 1);
  r.fwd.handle(A, data({ body: big }));
  assert.equal(r.fwd.stats().dropped_oversize, 1);
  r.fwd.onLocal('data.sealed', () => {});
  r.fwd.handle(A, data({ dst: ME, body: big }));
  assert.equal(r.fwd.stats().delivered, 1);
  assert.equal(r.fwd.originate(data({ body: Buffer.alloc(100 * 1024, 1) })).ok, true);
  assert.equal(decodePacket(encodePacket(r.sent[0].packet)).body.length, 100 * 1024);
});

test('packet events share one budget; the excess is counted in the next sample', () => {
  const r = rig({ packetEventsPerSec: 5 });
  r.routes.set(D, B);
  for (let i = 0; i < 20; i += 1) r.fwd.handle(A, data());
  assert.equal(r.types('packet.forwarded').length, 5);
  assert.equal(r.fwd.stats().forwarded, 20);
  assert.equal(r.fwd.stats().suppressed, 15);
  const sample = r.fwd.takeTrafficSample();
  assert.deepEqual(sample, { originated: 0, forwarded: 20, delivered: 0, queued: 0, dropped: 0, suppressed: 15 });
  assert.deepEqual(r.fwd.takeTrafficSample(), {
    originated: 0, forwarded: 0, delivered: 0, queued: 0, dropped: 0, suppressed: 0,
  });
  r.advance(1_000);
  for (let i = 0; i < 20; i += 1) r.fwd.handle(A, data());
  assert.equal(r.types('packet.forwarded').length, 10, 'the budget refills with time');
  assert.equal(r.fwd.takeTrafficSample().suppressed, 15);
});

test('drops of every reason are counted and add up', () => {
  const r = rig({ transitQueueMax: 4 });
  r.fwd.onLocal('data.sealed', () => {});
  r.fwd.handle(A, data({ ttl: 1 }));
  r.fwd.handle(A, data({ dst: ME, body: Buffer.from([7]) }));
  const dup = data();
  r.fwd.handle(A, dup);
  r.fwd.handle(A, dup);
  const stats = r.fwd.stats();
  assert.equal(stats.dropped, 3);
  const sum = Object.values(DropReason).reduce((n, reason) => n + stats[`dropped_${reason}`], 0);
  assert.equal(sum, stats.dropped);
  for (const [name, value] of Object.entries(stats)) {
    assert.ok(Number.isInteger(value) && value >= 0, `${name} must be a non-negative integer`);
  }
  assert.equal(r.fwd.takeTrafficSample().dropped, 3);
});

test('events are optional', () => {
  const r = rig({ events: undefined });
  r.routes.set(D, B);
  r.fwd.handle(A, data());
  assert.equal(r.sent.length, 1);
});

test('an event bus that throws does not break forwarding', () => {
  const r = rig({ events: { emit: () => { throw new Error('bus down'); } } });
  r.routes.set(D, B);
  r.fwd.handle(A, data());
  assert.equal(r.sent.length, 1);
  assert.equal(r.log.length >= 1, true);
});

test('route lookups that throw or answer nonsense mean no route', () => {
  for (const answer of [() => { throw new Error('x'); }, () => 42, () => 'not-a-node', () => ME, () => undefined]) {
    const r = rig({ nextHop: answer });
    r.fwd.handle(A, data());
    assert.equal(r.sent.length, 0);
    assert.equal(r.fwd.stats().transitQueueLen, 1);
  }
});

test('close cancels the timer, forgets the queue and refuses further use', () => {
  const r = rig();
  r.fwd.handle(A, data());
  assert.equal(r.liveTimers(), 1);
  r.fwd.close();
  r.fwd.close();
  assert.equal(r.liveTimers(), 0);
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.throws(() => r.fwd.handle(A, data()), StateError);
  assert.throws(() => r.fwd.originate(data()), StateError);
  r.fwd.flush();
});

test('constructor rejects missing or malformed options', () => {
  const base = {
    selfId: ME,
    nextHop: () => null,
    send: () => true,
    schedule: () => () => {},
  };
  assert.doesNotThrow(() => new Forwarder(base));
  for (const bad of [
    { selfId: 'x' }, { nextHop: undefined }, { send: undefined }, { schedule: undefined },
    { monoNow: 5 }, { transit: 'yes' }, { events: {} }, { transitHoldMs: 0 },
    { transitQueueMax: -1 }, { transitQueueMaxBytes: NaN }, { packetEventsPerSec: 0 },
    { maxRoutedPacket: 0 }, { isNeighbour: 5 }, { seenEntries: 0 }, { dedupeTtlMs: 0 },
  ]) {
    assert.throws(() => new Forwarder({ ...base, ...bad }), ConfigError, JSON.stringify(bad));
  }
  assert.throws(() => new Forwarder(), ConfigError);
});

test('hostile fuzz: garbage never throws anything but the protocol and config errors', () => {
  const r = rig({ transitQueueMax: 16, transitQueueMaxBytes: 4_000, seenEntries: 64 });
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = (list) => list[rnd(list.length)];
  const ids = [freshId(), freshId(), freshId()];
  const peers = [A, B, C, 'bad-peer'];
  const dsts = [D, C, ME, 'nope', 5, null];
  for (let i = 0; i < 3_000; i += 1) {
    const packet = pick([
      () => data({ dst: pick(dsts), id: pick(ids), ttl: rnd(36) - 2, tries: rnd(260), body: Buffer.alloc(rnd(300), rnd(5)) }),
      () => probe({ dst: pick(dsts), id: pick(ids), ttl: rnd(8), n: rnd(8) }),
      () => ({ type: pick([PacketType.DATA, PacketType.PROBE, 1, 99]), header: pick([{}, [], null, 7, { id: 1 }]), body: pick([SEALED, 'x', null]) }),
      () => pick([null, undefined, 'x', 5, []]),
    ])();
    if (rnd(5) === 0) r.routes.set(D, pick([A, B, C]));
    if (rnd(7) === 0) r.routes.delete(D);
    if (rnd(4) === 0) r.refused.add(B);
    if (rnd(4) === 0) r.refused.delete(B);
    if (rnd(11) === 0) r.fwd.flush();
    if (rnd(13) === 0) r.advance(rnd(40_000));
    try {
      r.fwd.handle(pick(peers), packet);
    } catch (error) {
      assert.ok(error instanceof ProtocolError || error instanceof ConfigError, String(error));
    }
    const stats = r.fwd.stats();
    assert.ok(stats.transitQueueLen <= 16);
    assert.ok(stats.transitQueueBytes <= 4_000);
    assert.ok(stats.seenEntries <= 64);
  }
  r.refused.clear();
  r.routes.set(D, C);
  r.routes.set(C, C);
  r.fwd.flush();
  r.advance(60_000);
  assert.equal(r.fwd.stats().transitQueueLen, 0);
  assert.equal(r.fwd.stats().transitQueueBytes, 0);
  assert.equal(r.liveTimers(), 0);
});
