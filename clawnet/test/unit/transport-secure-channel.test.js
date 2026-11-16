import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';

import { Identity } from '../../src/core/crypto/identity.js';
import { HandshakeState } from '../../src/core/crypto/noise.js';
import { HandshakeError, WireError } from '../../src/core/errors.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { PacketType } from '../../src/core/wire/types.js';
import {
  RECORD_PLAINTEXT_MAX,
  SendPriority,
  establishChannel,
} from '../../src/core/transport/secure-channel.js';
import { createNetem } from '../helpers/netem.js';

const NET = 'test-net';
const alice = Identity.generate();
const bob = Identity.generate();
const carol = Identity.generate();
const mallory = Identity.generate();
const NETWORK_KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const CAPS = { relay: true, mailbox: false, transit: true };

const options = (identity, overrides = {}) => ({
  identity,
  networkId: NET,
  networkKey: null,
  buildLocal: () => ({ agent: 'test/1', caps: CAPS, listen: ['tcp://127.0.0.1:4000'] }),
  authorize: () => null,
  handshakeTimeoutMs: 2000,
  maxClockSkewMs: 60_000,
  ...overrides,
});

const rejectsWith = reason => err => {
  assert.ok(err instanceof HandshakeError, `expected HandshakeError, got ${err}`);
  assert.equal(err.reason, reason);
  return true;
};

async function waitFor(predicate, { timeoutMs = 3000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A connected pair of loopback sockets. */
async function tcpPair(t) {
  const server = net.createServer();
  await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const accepted = new Promise(resolve => server.once('connection', resolve));
  const client = net.connect({ host: '127.0.0.1', port: server.address().port });
  await new Promise(resolve => client.once('connect', resolve));
  const serverSide = await accepted;
  server.close();
  t.after(() => {
    client.destroy();
    serverSide.destroy();
  });
  return { client, server: serverSide };
}

/** Both ends of a handshake over the given streams; results are settled outcomes. */
function handshake(clientStream, serverStream, { a = {}, b = {} } = {}) {
  return Promise.allSettled([
    establishChannel({ ...options(alice, a), stream: clientStream, initiator: true }),
    establishChannel({ ...options(bob, b), stream: serverStream, initiator: false }),
  ]);
}

async function linkPair(t, sides = {}, streams = null) {
  const { client, server } = streams ?? (await tcpPair(t));
  const [ra, rb] = await handshake(client, server, sides);
  assert.equal(ra.status, 'fulfilled', ra.reason?.stack);
  assert.equal(rb.status, 'fulfilled', rb.reason?.stack);
  t.after(() => {
    ra.value.destroy();
    rb.value.destroy();
  });
  return { ca: ra.value, cb: rb.value };
}

/** Start a channel and collect what it delivers. */
function collect(channel) {
  const got = { packets: [], closes: [] };
  channel.onPacket = packet => got.packets.push({ type: packet.type, header: packet.header, body: Buffer.from(packet.body) });
  channel.onClose = info => got.closes.push(info);
  channel.start();
  return got;
}

/**
 * Two in-memory Duplex streams joined together. `up(chunk)` and `down(chunk)` decide what
 * the other side receives for each written chunk (default: the chunk itself), delivered
 * asynchronously and in order.
 */
function memoryPair({ up = c => [c], down = c => [c] } = {}) {
  const make = () =>
    new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const out = this.hook(Buffer.from(chunk));
        setImmediate(() => {
          for (const piece of out) if (!this.peer.destroyed) this.peer.push(piece);
        });
        callback();
      },
      final(callback) {
        setImmediate(() => this.peer.push(null));
        callback();
      },
      destroy(err, callback) {
        setImmediate(() => this.peer.destroy());
        callback(err);
      },
    });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  a.hook = up;
  b.hook = down;
  return { client: a, server: b };
}

/** A hook that cuts the stream into `u16be length || message` units and lets `tamper` rewrite them. */
function messageHook(tamper) {
  let buffered = Buffer.alloc(0);
  let index = 0;
  return chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const out = [];
    while (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
      const length = buffered.readUInt16BE(0);
      const message = buffered.subarray(0, 2 + length);
      buffered = buffered.subarray(2 + length);
      out.push(...tamper(index, Buffer.from(message)));
      index += 1;
    }
    return out;
  };
}

// ---------------------------------------------------------------------- raw Noise peers

const prologue = (networkId = NET) => Buffer.concat([Buffer.from('clawnet/1'), Buffer.from([0]), Buffer.from(networkId)]);
const frameOf = message => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(message.length);
  return Buffer.concat([prefix, message]);
};

/** Reads u16-framed messages from a socket. */
function messageReader(socket) {
  let buffered = Buffer.alloc(0);
  const waiters = [];
  const wake = () => {
    while (waiters.length > 0 && buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
      const length = buffered.readUInt16BE(0);
      const message = buffered.subarray(2, 2 + length);
      buffered = buffered.subarray(2 + length);
      waiters.shift().resolve(Buffer.from(message));
    }
  };
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('closed'));
  });
  return () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    wake();
  });
}

const payloadOf = (identity, overrides = {}) => ({
  v: 1, card: identity.card, net: NET, agent: 'raw/1', caps: CAPS, listen: [], observed: null, ts: Date.now(), ...overrides,
});

/** A responder written from the specification that sends `payloadBytes` in message 2. */
async function rawResponder(socket, { linkKeyPair = bob.linkKeyPair, payloadBytes }) {
  const next = messageReader(socket);
  const hs = new HandshakeState({ pattern: 'XX', initiator: false, prologue: prologue(), s: linkKeyPair });
  hs.readMessage(await next());
  socket.write(frameOf(hs.writeMessage(payloadBytes)));
  return { hs, next };
}

/**
 * An initiator written from the specification: completes the handshake with a valid
 * payload for `identity`, reads the admission confirmation, and hands back its ciphers so
 * the test can send arbitrary records.
 */
async function rawInitiator(socket, identity = mallory) {
  const next = messageReader(socket);
  const hs = new HandshakeState({ pattern: 'XX', initiator: true, prologue: prologue(), s: identity.linkKeyPair });
  socket.write(frameOf(hs.writeMessage(Buffer.alloc(0))));
  hs.readMessage(await next());
  socket.write(frameOf(hs.writeMessage(canonicalBytes(payloadOf(identity)))));
  const { tx, rx } = hs.split();
  const confirmation = rx.decryptWithAd(Buffer.alloc(0), await next());
  return { tx, rx, next, confirmation };
}

const packetBytes = (type, headerText, body = Buffer.alloc(0)) => {
  const header = Buffer.from(headerText);
  const out = Buffer.alloc(4 + header.length + body.length);
  out[0] = type;
  out.writeUInt16BE(header.length, 2);
  header.copy(out, 4);
  body.copy(out, 4 + header.length);
  return out;
};
const frameBytes = packet => {
  const out = Buffer.alloc(4 + packet.length);
  out.writeUInt32BE(packet.length);
  packet.copy(out, 4);
  return out;
};

// ---------------------------------------------------------------------- handshake

test('XX and XXpsk0 handshakes complete and both ends agree on who and what', async t => {
  for (const networkKey of [null, NETWORK_KEY]) {
    const { ca, cb } = await linkPair(t, { a: { networkKey }, b: { networkKey } });
    assert.equal(ca.remoteId, bob.nodeId);
    assert.equal(cb.remoteId, alice.nodeId);
    assert.ok(ca.handshakeHash.equals(cb.handshakeHash));
    assert.equal(ca.handshakeHash.length, 32);
    assert.deepEqual(ca.remoteCard, bob.card);
    assert.deepEqual(cb.remoteCard, alice.card);
    assert.equal(ca.remotePayload.agent, 'test/1');
    assert.deepEqual(cb.remotePayload.listen, ['tcp://127.0.0.1:4000']);
    // Each side reports the IP it saw the other at.
    assert.equal(ca.remotePayload.observed, '127.0.0.1');
    assert.equal(cb.remotePayload.observed, '127.0.0.1');
    assert.ok(Object.isFrozen(ca.remotePayload) && Object.isFrozen(ca.remotePayload.card));
    assert.ok(ca.initiator && !cb.initiator);
    assert.ok(ca.handshakeRttMs >= 0 && cb.handshakeRttMs >= 0);
    assert.deepEqual(ca.remoteAddress.host, '127.0.0.1');

    const ga = collect(ca);
    const gb = collect(cb);
    assert.equal(ca.send({ type: PacketType.GOSSIP, header: { from: 'a' }, body: Buffer.from('to bob') }), true);
    assert.equal(cb.send({ type: PacketType.GOSSIP, header: { from: 'b' }, body: Buffer.from('to alice') }), true);
    await waitFor(() => ga.packets.length === 1 && gb.packets.length === 1);
    assert.deepEqual(gb.packets[0].header, { from: 'a' });
    assert.equal(gb.packets[0].body.toString(), 'to bob');
    assert.equal(ga.packets[0].body.toString(), 'to alice');
  }
});

test('a wrong network id or a wrong or missing network key never completes', async t => {
  const cases = [
    { name: 'network id', a: { networkId: 'other-net' }, b: {} },
    { name: 'wrong key', a: { networkKey: NETWORK_KEY }, b: { networkKey: OTHER_KEY } },
    { name: 'initiator lacks key', a: {}, b: { networkKey: NETWORK_KEY } },
    { name: 'responder lacks key', a: { networkKey: NETWORK_KEY }, b: {} },
  ];
  for (const { name, a, b } of cases) {
    const { client, server } = await tcpPair(t);
    const [ra, rb] = await handshake(client, server, { a, b });
    assert.equal(ra.status, 'rejected', name);
    assert.equal(rb.status, 'rejected', name);
    const reasons = [ra.reason.reason, rb.reason.reason];
    // The side that detects the mismatch says "noise"; the other sees the stream end.
    assert.ok(reasons.includes('noise'), `${name}: ${reasons}`);
    for (const reason of reasons) assert.ok(['noise', 'closed'].includes(reason), `${name}: ${reason}`);
  }
});

test('with a network key a non-member is rejected at message 1 and learns nothing', async t => {
  const { client, server } = await tcpPair(t);
  const received = [];
  client.on('data', chunk => received.push(chunk));
  const outcome = establishChannel({ ...options(bob, { networkKey: NETWORK_KEY }), stream: server, initiator: false });
  // A member-less initiator: plain XX message 1 to an XXpsk0 responder.
  const hs = new HandshakeState({ pattern: 'XXpsk0', initiator: true, prologue: prologue(), s: mallory.linkKeyPair, psk: OTHER_KEY });
  client.write(frameOf(hs.writeMessage(Buffer.alloc(0))));
  await assert.rejects(outcome, rejectsWith('noise'));
  await waitFor(() => client.destroyed || client.readableEnded, { message: 'connection closed' });
  assert.equal(Buffer.concat(received).length, 0, 'the responder sent nothing to a non-member');
});

test('each payload check fails with its own reason', async t => {
  const run = async payloadBytes => {
    const { client, server } = await tcpPair(t);
    const raw = rawResponder(server, { payloadBytes });
    const outcome = establishChannel({ ...options(alice), stream: client, initiator: true });
    outcome.catch(() => {});
    await raw;
    return outcome;
  };
  const canonical = overrides => canonicalBytes(payloadOf(bob, overrides));

  // Card signed by another identity: the link key matches, the signature does not.
  await assert.rejects(run(canonical({ card: { ...bob.card, sig: mallory.card.sig } })), rejectsWith('bad-card'));
  // A valid card of a third node presented with bob's static key.
  await assert.rejects(run(canonical({ card: carol.card })), rejectsWith('key-mismatch'));
  // Not canonical JSON: a space after the brace.
  const text = canonical({}).toString();
  await assert.rejects(run(Buffer.from(`{ ${text.slice(1)}`)), rejectsWith('bad-payload'));
  // Unknown field.
  await assert.rejects(run(canonical({ extra: 1 })), rejectsWith('bad-payload'));
  // Not an object at all.
  await assert.rejects(run(Buffer.from('[1]')), rejectsWith('bad-payload'));
  // Another version.
  await assert.rejects(run(canonical({ v: 2 })), rejectsWith('version'));
  // Timestamp outside the allowed skew, both directions.
  await assert.rejects(run(canonical({ ts: Date.now() - 10 * 60_000 })), rejectsWith('clock-skew'));
  await assert.rejects(run(canonical({ ts: Date.now() + 10 * 60_000 })), rejectsWith('clock-skew'));
  // Control: the same raw responder with an honest payload is accepted up to admission.
  const { client, server } = await tcpPair(t);
  const raw = rawResponder(server, { payloadBytes: canonical({}) });
  const outcome = establishChannel({ ...options(alice, { handshakeTimeoutMs: 300 }), stream: client, initiator: true });
  await raw;
  // The raw responder never confirms, so the honest initiator times out waiting for it.
  await assert.rejects(outcome, rejectsWith('handshake-timeout'));
});

test('the network id in the payload must match even under the right prologue', async t => {
  // Only a peer that ignores the prologue rule could send this; the check still holds.
  const { client, server } = await tcpPair(t);
  const raw = rawResponder(server, { payloadBytes: canonicalBytes(payloadOf(bob, { net: 'elsewhere' })) });
  const outcome = establishChannel({ ...options(alice), stream: client, initiator: true });
  await raw;
  await assert.rejects(outcome, rejectsWith('network-mismatch'));
});

test('authorize refusals: the initiator sees the responder reason and never resolves', async t => {
  {
    const { client, server } = await tcpPair(t);
    const seen = [];
    const [ra, rb] = await handshake(client, server, {
      b: { authorize: peer => { seen.push(peer); return 'blocked'; } },
    });
    assert.equal(ra.status, 'rejected');
    assert.equal(ra.reason.reason, 'blocked');
    assert.equal(ra.reason.peer, bob.nodeId);
    assert.equal(rb.reason.reason, 'blocked');
    assert.equal(rb.reason.peer, alice.nodeId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, alice.nodeId);
    assert.equal(seen[0].initiator, false);
    assert.deepEqual(seen[0].card, alice.card);
  }
  {
    // The initiator refuses after message 2 and never sends message 3.
    const { client, server } = await tcpPair(t);
    const [ra, rb] = await handshake(client, server, { a: { authorize: () => 'self' } });
    assert.equal(ra.reason.reason, 'self');
    assert.equal(rb.reason.reason, 'closed');
  }
  {
    // A reason outside the known list arrives as "refused".
    const { client, server } = await tcpPair(t);
    const [ra] = await handshake(client, server, { b: { authorize: () => 'weird-reason' } });
    assert.equal(ra.reason.reason, 'refused');
  }
});

test('handshake deadline, a stream closed mid-handshake, and garbage as message 1', async t => {
  {
    const { client } = await tcpPair(t);
    const started = Date.now();
    await assert.rejects(
      establishChannel({ ...options(alice, { handshakeTimeoutMs: 100 }), stream: client, initiator: true }),
      rejectsWith('handshake-timeout'),
    );
    assert.ok(Date.now() - started < 1000);
    assert.ok(client.destroyed);
  }
  {
    const { server } = await tcpPair(t);
    await assert.rejects(
      establishChannel({ ...options(bob, { handshakeTimeoutMs: 100 }), stream: server, initiator: false }),
      rejectsWith('handshake-timeout'),
    );
  }
  {
    const { client, server } = await tcpPair(t);
    const outcome = establishChannel({ ...options(alice), stream: client, initiator: true });
    server.once('data', () => server.destroy());
    await assert.rejects(outcome, rejectsWith('closed'));
  }
  {
    const { client, server } = await tcpPair(t);
    const outcome = establishChannel({ ...options(bob), stream: server, initiator: false });
    client.write(Buffer.from([0, 5, 1, 2, 3, 4, 5]));
    await assert.rejects(outcome, rejectsWith('noise'));
  }
});

// ---------------------------------------------------------------------- record layer

test('packets of every interesting size round-trip, including the largest sendable', async t => {
  const { ca, cb } = await linkPair(t);
  collect(ca);
  const gb = collect(cb);
  const linkMax = 64 * 1024 - 4 - 2; // GOSSIP with header "{}"
  const routedMax = 128 * 1024 - 4 - 2;
  const cases = [
    [PacketType.GOSSIP, 0], [PacketType.GOSSIP, 1], [PacketType.GOSSIP, RECORD_PLAINTEXT_MAX],
    [PacketType.GOSSIP, RECORD_PLAINTEXT_MAX + 1], [PacketType.GOSSIP, linkMax],
    [PacketType.DATA, routedMax],
  ];
  const bodies = cases.map(([, size]) => Buffer.alloc(size, size % 251));
  cases.forEach(([type], i) => assert.ok(ca.send({ type, header: {}, body: bodies[i] })));
  await waitFor(() => gb.packets.length === cases.length);
  gb.packets.forEach((packet, i) => {
    assert.equal(packet.type, cases[i][0]);
    assert.ok(packet.body.equals(bodies[i]), `size ${cases[i][1]}`);
  });
  // One byte more than each send limit is refused locally (codec.assertSendable).
  assert.throws(() => ca.send({ type: PacketType.GOSSIP, header: {}, body: Buffer.alloc(linkMax + 1) }), WireError);
  assert.throws(() => ca.send({ type: PacketType.DATA, header: {}, body: Buffer.alloc(routedMax + 1) }), WireError);
});

test('thousands of packets in both directions arrive in order', async t => {
  const { ca, cb } = await linkPair(t);
  const ga = collect(ca);
  const gb = collect(cb);
  const count = 3000;
  for (let i = 0; i < count; i += 1) {
    assert.ok(ca.send({ type: PacketType.GOSSIP, header: { i } }));
    assert.ok(cb.send({ type: PacketType.DATA, header: { i }, body: Buffer.alloc(i % 300) }));
  }
  await waitFor(() => ga.packets.length === count && gb.packets.length === count, { timeoutMs: 8000 });
  gb.packets.forEach((p, i) => assert.equal(p.header.i, i));
  ga.packets.forEach((p, i) => {
    assert.equal(p.header.i, i);
    assert.equal(p.body.length, i % 300);
  });
});

test('delivery is correct when the transport hands over one byte at a time', async t => {
  const bytes = chunk => [...chunk].map(b => Buffer.from([b]));
  const { ca, cb } = await linkPair(t, {}, memoryPair({ up: bytes, down: bytes }));
  const ga = collect(ca);
  const gb = collect(cb);
  const big = Buffer.alloc(70_000, 3);
  ca.send({ type: PacketType.GOSSIP, header: { n: 1 } });
  ca.send({ type: PacketType.DATA, header: { n: 2 }, body: big });
  cb.send({ type: PacketType.GOSSIP, header: { n: 3 }, body: Buffer.from('back') });
  await waitFor(() => gb.packets.length === 2 && ga.packets.length === 1, { timeoutMs: 8000 });
  assert.deepEqual(gb.packets.map(p => p.header.n), [1, 2]);
  assert.ok(gb.packets[1].body.equals(big));
  assert.equal(ga.packets[0].body.toString(), 'back');
  assert.equal(ca.remoteAddress, null);
  assert.equal(ca.remotePayload.observed, null);
});

test('a flipped bit, a dropped, replayed or reordered record each close the link with "auth"', async t => {
  // Initiator-to-responder units: 0 = message 1, 1 = message 3, then transport records.
  // Expected: the packets delivered before the record that fails.
  const attacks = {
    flip: [[0], (i, m) => {
      if (i === 3) m[m.length - 1] ^= 1;
      return [m];
    }],
    drop: [[0], (i, m) => (i === 3 ? [] : [m])],
    replay: [[0, 1], (i, m) => (i === 3 ? [m, m] : [m])],
    swap: [[0], (() => {
      let held = null;
      return (i, m) => {
        if (i === 3) {
          held = m;
          return [];
        }
        if (i === 4) return [m, held];
        return [m];
      };
    })()],
  };
  for (const [name, [expected, tamper]] of Object.entries(attacks)) {
    const { ca, cb } = await linkPair(t, {}, memoryPair({ up: messageHook(tamper) }));
    collect(ca);
    const gb = collect(cb);
    for (let i = 0; i < 4; i += 1) {
      ca.send({ type: PacketType.GOSSIP, header: { i } });
      await tick();
      await tick();
    }
    await waitFor(() => gb.closes.length === 1, { message: name });
    assert.deepEqual(gb.closes[0], { reason: 'auth', remote: false }, name);
    // Everything before the failing record was delivered, nothing after it.
    assert.deepEqual(gb.packets.map(p => p.header.i), expected, name);
  }
});

test('malformed records, frames and packets close the link with "protocol" and a BYE', async t => {
  const cases = {
    'short record': null,
    'zero-length frame': Buffer.from([0, 0, 0, 0]),
    'oversized frame': (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(2 * 1024 * 1024);
      return b;
    })(),
    'unknown packet type': frameBytes(packetBytes(99, '{}')),
    'non-canonical header': frameBytes(packetBytes(PacketType.GOSSIP, '{ "a":1}')),
    'non-zero flags': (() => {
      const p = packetBytes(PacketType.GOSSIP, '{}');
      p[1] = 1;
      return frameBytes(p);
    })(),
    'malformed BYE': frameBytes(packetBytes(PacketType.BYE, '{"reason":"NOT VALID"}')),
  };
  for (const [name, plaintext] of Object.entries(cases)) {
    const { client, server } = await tcpPair(t);
    const responder = establishChannel({ ...options(bob), stream: server, initiator: false });
    const raw = await rawInitiator(client);
    const cb = await responder;
    t.after(() => cb.destroy());
    const got = collect(cb);
    assert.equal(raw.confirmation.readUInt32BE(0) > 0, true);
    if (plaintext === null) {
      client.write(Buffer.from([0, 10, ...Buffer.alloc(10)]));
    } else {
      client.write(frameOf(raw.tx.encryptWithAd(Buffer.alloc(0), plaintext)));
    }
    await waitFor(() => got.closes.length === 1, { message: name });
    assert.deepEqual(got.closes[0], { reason: 'protocol', remote: false }, name);
    assert.equal(got.packets.length, 0, name);
    // The peer is told why.
    const bye = raw.rx.decryptWithAd(Buffer.alloc(0), await raw.next());
    assert.ok(bye.includes(Buffer.from('{"reason":"protocol"}')), name);
  }
});

test('with a tiny rekey interval hundreds of records stay in sync in both directions', async t => {
  const { ca, cb } = await linkPair(t, { a: { rekeyInterval: 4 }, b: { rekeyInterval: 4 } });
  const ga = collect(ca);
  const gb = collect(cb);
  for (let i = 0; i < 300; i += 1) {
    ca.send({ type: PacketType.GOSSIP, header: { i } });
    cb.send({ type: PacketType.GOSSIP, header: { i } });
    await tick();
    await tick();
  }
  await waitFor(() => ga.packets.length === 300 && gb.packets.length === 300, { timeoutMs: 8000 });
  assert.deepEqual(gb.packets.map(p => p.header.i), [...Array(300).keys()]);
  const sa = ca.stats();
  const sb = cb.stats();
  assert.ok(sa.recordsOut >= 200, `records out ${sa.recordsOut}`);
  assert.equal(sa.rekeysOut, Math.floor(sa.recordsOut / 4));
  assert.equal(sb.rekeysIn, Math.floor(sb.recordsIn / 4));
  assert.equal(sa.recordsOut, sb.recordsIn);
  assert.ok(sa.rekeysIn > 40 && sb.rekeysOut > 40);
});

test('backpressure: a paused reader fills the bounded queue, control still queues, and all arrives after resume', async t => {
  const bound = 1024 * 1024;
  const { ca, cb } = await linkPair(t, { a: { maxQueueBytes: bound } });
  const gb = collect(cb);
  let drains = 0;
  ca.onDrain = () => {
    drains += 1;
  };
  collect(ca);
  cb.pauseReading();
  const body = Buffer.alloc(100_000, 1);
  let accepted = 0;
  let refused = false;
  for (let i = 0; i < 2000 && !refused; i += 1) {
    if (ca.send({ type: PacketType.DATA, header: { i }, body })) accepted += 1;
    else refused = true;
    assert.ok(ca.queuedBytes <= bound + bound / 4);
    if (i % 4 === 3) await tick();
  }
  assert.ok(refused, 'send returned false once the queue was full');
  assert.ok(ca.queuedBytes <= bound);
  assert.ok(ca.queuedBytes > bound / 2);
  // Acks still have their reserve, and control is outside the bound entirely.
  assert.equal(ca.send({ type: PacketType.DATA, header: { ack: 1 } }, { priority: SendPriority.ACK }), true);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: { control: 1 } }), true);
  cb.resumeReading();
  await waitFor(() => gb.packets.length === accepted + 2, { timeoutMs: 10_000 });
  assert.ok(drains >= 1, 'onDrain fired');
  assert.equal(gb.packets.filter(p => p.type === PacketType.DATA && p.header.i !== undefined).length, accepted);
});

test('a control frame queued behind many data frames is sent before the remaining data', async t => {
  const { ca, cb } = await linkPair(t, { a: { maxQueueBytes: 16 * 1024 * 1024 } });
  const gb = collect(cb);
  collect(ca);
  for (let i = 0; i < 60; i += 1) ca.send({ type: PacketType.DATA, header: { i }, body: Buffer.alloc(100_000) });
  ca.send({ type: PacketType.DATA, header: { ack: true } }, { priority: SendPriority.ACK });
  ca.send({ type: PacketType.GOSSIP, header: { control: true } });
  await waitFor(() => gb.packets.length === 62, { timeoutMs: 8000 });
  const controlAt = gb.packets.findIndex(p => p.header.control === true);
  const ackAt = gb.packets.findIndex(p => p.header.ack === true);
  assert.ok(controlAt <= 1, `control arrived at position ${controlAt}`);
  assert.ok(ackAt <= 2 && ackAt > controlAt, `ack arrived at position ${ackAt}`);
});

test('a control queue that overflows closes the link with "overflow"', async t => {
  const { ca, cb } = await linkPair(t, { a: { maxControlBytes: 1000 } });
  const ga = collect(ca);
  const gb = collect(cb);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: {}, body: Buffer.alloc(400) }), true);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: {}, body: Buffer.alloc(400) }), true);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: {}, body: Buffer.alloc(400) }), false);
  assert.deepEqual(ga.closes, [{ reason: 'overflow', remote: false }]);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: {} }), false);
  await waitFor(() => gb.closes.length === 1);
  assert.equal(gb.closes[0].remote, true);
});

test('close("shutdown") reaches the peer as a remote shutdown, exactly once', async t => {
  const { ca, cb } = await linkPair(t);
  const ga = collect(ca);
  const gb = collect(cb);
  ca.send({ type: PacketType.GOSSIP, header: { last: true } });
  await ca.close('shutdown');
  await waitFor(() => gb.closes.length === 1);
  assert.deepEqual(gb.closes[0], { reason: 'shutdown', remote: true });
  assert.deepEqual(ga.closes, [{ reason: 'shutdown', remote: false }]);
  assert.equal(ca.send({ type: PacketType.GOSSIP, header: {} }), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(gb.closes.length, 1);
  assert.equal(ga.closes.length, 1);
});

test('a peer that says BYE and never closes its socket does not keep ours open', async t => {
  const streams = memoryPair();
  // The peer never reads our end of stream: its side stays open however long we wait.
  const push = streams.client.push.bind(streams.client);
  streams.client.push = chunk => (chunk === null ? false : push(chunk));
  const { ca, cb } = await linkPair(t, {}, streams);
  const gb = collect(cb);
  collect(ca);
  ca.send({ type: PacketType.BYE, header: { reason: 'shutdown' } });
  await waitFor(() => gb.closes.length === 1);
  assert.deepEqual(gb.closes[0], { reason: 'shutdown', remote: true });
  assert.equal(streams.server.destroyed, false, 'the linger is still running');
  await waitFor(() => streams.server.destroyed, { timeoutMs: 3000, message: 'the stream to be destroyed after the linger' });
});

test('the bytes on the wire contain no NodeId, no card field and no packet body', async t => {
  const server = net.createServer();
  await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const netem = await createNetem({ target: { host: '127.0.0.1', port: server.address().port } });
  t.after(() => netem.close());
  const accepted = new Promise(resolve => server.once('connection', resolve));
  const client = net.connect({ host: '127.0.0.1', port: netem.port });
  await new Promise(resolve => client.once('connect', resolve));
  const { ca, cb } = await linkPair(t, {}, { client, server: await accepted });
  const ga = collect(ca);
  const gb = collect(cb);
  const marker = 'PLAINTEXT-MARKER-0123456789-abcdef';
  ca.send({ type: PacketType.DATA, header: { tag: marker }, body: Buffer.from(marker) });
  cb.send({ type: PacketType.GOSSIP, header: {}, body: Buffer.from(marker.repeat(3)) });
  await waitFor(() => ga.packets.length === 1 && gb.packets.length === 1);
  assert.ok(netem.stats().bytesUp > 0 && netem.stats().bytesDown > 0);
  for (const needle of [alice.nodeId, bob.nodeId, alice.card.link, alice.card.e2e, alice.card.sig,
    bob.card.link, bob.card.e2e, bob.card.sig, marker, `"net":"${NET}"`]) {
    assert.equal(netem.contains(needle), false, needle);
  }
  // The capture is real: the recording grows with traffic.
  assert.ok(netem.recorded().length > 200);
});
