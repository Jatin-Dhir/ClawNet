/**
 * Wire compatibility of the web core's foundations with the engine: the byte encoders,
 * the primitives, identities and records, the validators, the packet codec and sealed
 * messages. Each test feeds both implementations the same input and requires the same
 * output, or has one produce what the other consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isIPv4 as nodeIsIPv4, isIPv6 as nodeIsIPv6 } from 'node:net';

import * as engineEnvelope from '../../src/core/crypto/envelope.js';
import * as engineIdentity from '../../src/core/crypto/identity.js';
import * as enginePrimitives from '../../src/core/crypto/primitives.js';
import { AuthError } from '../../src/core/errors.js';
import * as engineCodec from '../../src/core/wire/codec.js';
import * as engineSchema from '../../src/core/wire/schema.js';
import { PacketType } from '../../src/core/wire/types.js';
import * as bytes from '../../web/core/bytes.js';
import * as webCodec from '../../web/core/codec.js';
import * as webEnvelope from '../../web/core/envelope.js';
import * as webIdentity from '../../web/core/identity.js';
import * as webPrimitives from '../../web/core/primitives.js';
import * as webSchema from '../../web/core/schema.js';

const hex = (value) => Buffer.from(value).toString('hex');

function pairOfIdentities() {
  const engine = engineIdentity.Identity.generate();
  const secret = engine.toSecret();
  const web = webIdentity.Identity.fromSecret({
    signSeed: Uint8Array.from(secret.signSeed),
    linkPrivate: Uint8Array.from(secret.linkPrivate),
    e2ePrivate: Uint8Array.from(secret.e2ePrivate),
  });
  return { engine, web };
}

// ------------------------------------------------------------------------------- bytes

test('base64 and base32 encode exactly as the engine does, for every length up to 70', () => {
  for (let n = 0; n <= 70; n += 1) {
    const data = nodeRandomBytes(n);
    assert.equal(bytes.base64Encode(data), enginePrimitives.base64Encode(data));
    assert.deepEqual(bytes.base64Decode(enginePrimitives.base64Encode(data)), new Uint8Array(data));
    assert.equal(bytes.base32Encode(data), enginePrimitives.base32Encode(data));
    assert.deepEqual(bytes.base32Decode(enginePrimitives.base32Encode(data)), new Uint8Array(data));
  }
});

test('the strict decoders refuse what the engine refuses', () => {
  const base64Cases = [
    '', 'A', 'AA', 'AAA', 'AA==', 'AB==', 'AAA=', 'AAB=', 'AAAA', 'A===', '====', 'AA=A', 'AA ==', ' AA==',
    'AA==\n', 'AAAAAA==', '-_==', 'Zg==', 'Zh==', 'Zm8=', 'Zm9=', 'Zm9v', 'Zm9vYg', 'Zm9vYg==', 'Zm9vYh==', 'Zm9vYmE=',
    'Zm9vYmF=', 'éAA=', 'AA==AA==',
  ];
  for (const text of base64Cases) {
    const engine = attempt(() => hex(enginePrimitives.base64Decode(text)));
    const web = attempt(() => hex(bytes.base64Decode(text)));
    assert.deepEqual(web, engine, `base64 ${JSON.stringify(text)}`);
  }
  const base32Cases = ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'aaaaaaaa', 'AAAA', 'ab=', 'my', 'mz', 'mzxq', 'mzxw6', 'mzxw7', '1234'];
  for (const text of base32Cases) {
    const engine = attempt(() => hex(enginePrimitives.base32Decode(text)));
    const web = attempt(() => hex(bytes.base32Decode(text)));
    assert.deepEqual(web, engine, `base32 ${JSON.stringify(text)}`);
  }
  for (let i = 0; i < 2000; i += 1) {
    const text = randomText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=', 1 + (i % 12));
    assert.deepEqual(attempt(() => hex(bytes.base64Decode(text))), attempt(() => hex(enginePrimitives.base64Decode(text))), text);
  }
});

function attempt(fn) {
  try {
    return { ok: fn() };
  } catch {
    return { error: true };
  }
}

function randomText(alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------- primitives

test('hashes, HMAC, HKDF and the AEAD give the engine\'s bytes', () => {
  for (let i = 0; i < 20; i += 1) {
    const a = nodeRandomBytes(i * 7);
    const key = nodeRandomBytes(32);
    assert.equal(hex(webPrimitives.sha256(a, a)), hex(enginePrimitives.sha256(a, a)));
    assert.equal(hex(webPrimitives.hmacSha256(key, a)), hex(enginePrimitives.hmacSha256(key, a)));
    const info = nodeRandomBytes(i);
    for (const salt of [undefined, Buffer.alloc(0), nodeRandomBytes(32)]) {
      const params = { ikm: key, salt, info, length: 32 + i };
      assert.equal(hex(webPrimitives.hkdfExpand(params)), hex(enginePrimitives.hkdfExpand(params)));
    }
    const nonce = nodeRandomBytes(12);
    const sealed = webPrimitives.aeadEncrypt(key, nonce, info, a);
    assert.equal(hex(sealed), hex(enginePrimitives.aeadEncrypt(key, nonce, info, a)));
    assert.equal(hex(enginePrimitives.aeadDecrypt(key, nonce, info, sealed)), hex(a));
    const tampered = Uint8Array.from(sealed);
    tampered[0] ^= 1;
    assert.throws(() => webPrimitives.aeadDecrypt(key, nonce, info, tampered), AuthError);
  }
});

test('Ed25519 signatures are byte-identical to OpenSSL\'s and verify across', () => {
  for (let i = 0; i < 10; i += 1) {
    const { privateKey, publicKey } = enginePrimitives.ed25519GenerateKeyPair();
    const message = nodeRandomBytes(i * 13);
    const web = webPrimitives.ed25519Sign(Uint8Array.from(privateKey), message);
    assert.equal(hex(web), hex(enginePrimitives.ed25519Sign(privateKey, message)));
    assert.ok(enginePrimitives.ed25519Verify(publicKey, message, Buffer.from(web)));
    assert.ok(webPrimitives.ed25519Verify(Uint8Array.from(publicKey), message, web));
    const wrong = Uint8Array.from(web);
    wrong[5] ^= 4;
    assert.equal(webPrimitives.ed25519Verify(Uint8Array.from(publicKey), message, wrong), false);
  }
  // Keys of small order are refused by both, whatever the signature.
  for (const point of ['00'.repeat(32), `01${'00'.repeat(31)}`, `ec${'ff'.repeat(30)}7f`]) {
    const key = Buffer.from(point, 'hex');
    assert.equal(webPrimitives.ed25519HasSmallOrder(key), enginePrimitives.ed25519HasSmallOrder(key));
    assert.equal(webPrimitives.ed25519Verify(key, Buffer.alloc(1), new Uint8Array(64)), false);
  }
});

test('X25519 agrees with OpenSSL, and refuses the same small-order points', () => {
  const a = enginePrimitives.x25519GenerateKeyPair();
  const b = webPrimitives.x25519GenerateKeyPair();
  assert.equal(hex(webPrimitives.x25519(b.privateKey, a.publicKey)), hex(enginePrimitives.x25519(a.privateKey, Buffer.from(b.publicKey))));
  assert.equal(hex(webPrimitives.x25519PublicFromPrivate(a.privateKey)), hex(a.publicKey));
  for (let i = 0; i < 300; i += 1) {
    const point = nodeRandomBytes(32);
    if (i < 7) point.fill(0, 0, 32).set([i], 0);
    assert.equal(webPrimitives.x25519HasSmallOrder(point), enginePrimitives.x25519HasSmallOrder(point));
  }
  assert.throws(() => webPrimitives.x25519(b.privateKey, new Uint8Array(32)));
});

// ------------------------------------------------------------------------------ identity

test('the same secret gives the same NodeId and a byte-identical identity card', () => {
  for (let i = 0; i < 5; i += 1) {
    const { engine, web } = pairOfIdentities();
    assert.equal(web.nodeId, engine.nodeId);
    assert.deepEqual({ ...web.card }, { ...engine.card });
    assert.ok(engineIdentity.verifyCard(web.card).ok);
    assert.ok(webIdentity.verifyCard(engine.card).ok);
  }
  const fresh = webIdentity.Identity.generate();
  assert.ok(engineIdentity.verifyCard(fresh.card).ok);
  assert.ok(engineIdentity.isValidNodeId(fresh.nodeId));
});

test('signed records are byte-identical and verify across', () => {
  const { engine, web } = pairOfIdentities();
  const fields = { seq: 1763337600000, ts: 1763337600000, links: [{ peer: engine.nodeId === 'x' ? 'y' : webIdentity.Identity.generate().nodeId, cost: 3 }], caps: { relay: false, mailbox: false, transit: false } };
  const a = web.signRecord('lsa', fields);
  const b = engine.signRecord('lsa', fields);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.ok(engineIdentity.verifyRecord(a, 'lsa').ok);
  assert.ok(webIdentity.verifyRecord(b, 'lsa').ok);
  const tampered = { ...b, seq: b.seq + 1 };
  assert.deepEqual(webIdentity.verifyRecord(tampered, 'lsa'), engineIdentity.verifyRecord(tampered, 'lsa'));
  const cases = [null, [], {}, { ...b, sig: 'x' }, { ...b, origin: 'nope' }, { ...b, type: 'Peer' }, { ...b, type: 'peer' }];
  for (const record of cases) {
    assert.deepEqual(webIdentity.verifyRecord(record, 'lsa'), engineIdentity.verifyRecord(record, 'lsa'));
  }
  const badCards = [null, {}, { ...engine.card, extra: 1 }, { ...engine.card, id: `${engine.card.id.slice(0, 51)}b` }, { ...engine.card, link: engine.card.e2e }, { ...engine.card, sig: engine.card.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }];
  for (const card of badCards) assert.deepEqual(webIdentity.verifyCard(card), engineIdentity.verifyCard(card));
});

// ------------------------------------------------------------------------------- schema

test('IP literal checks match node:net on edge cases and random strings', () => {
  const cases = [
    '1.2.3.4', '01.2.3.4', '1.2.3', '256.1.1.1', '::', '::1', 'fe80::1%eth0', '::ffff:1.2.3.4', '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7::', '1::8', '::ffff:01.2.3.4', '1:2:3:4:5:6:1.2.3.4', '[::1]', '0.0.0.0', '255.255.255.255', '1.2.3.4 ',
    ' ::1', '::1%', 'fe80::1%', '1:2:3:4:5:6:7:8:9', '12345::1', 'g::1', '::1.2.3.4', ':', ':::', '1::2::3', 'FE80::ABCD',
    '::ffff:255.255.255.255', '1:2:3:4:5::1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', 'a:b:c:d:e:f:a:b', '0:0:0:0:0:0:0:0', '',
  ];
  for (const value of cases) {
    assert.equal(webSchema.isIPv4(value), nodeIsIPv4(value), value);
    assert.equal(webSchema.isIPv6(value), nodeIsIPv6(value), value);
  }
  for (let i = 0; i < 20000; i += 1) {
    const value = randomText('0123456789abcdef:.%', 1 + (i % 24));
    assert.equal(webSchema.isIPv6(value), nodeIsIPv6(value), value);
    assert.equal(webSchema.isIPv4(value), nodeIsIPv4(value), value);
  }
});

test('the validators give the engine\'s verdict and reason on the same values', () => {
  const { engine } = pairOfIdentities();
  const other = engineIdentity.Identity.generate();
  const payload = {
    v: 1, card: engine.card, net: 'clawnet-main', agent: 'clawnet/0.1.0', caps: { relay: true, mailbox: false, transit: true },
    listen: ['tcp://192.168.1.20:47470', 'tcp://[fe80::1]:1', 'tcp://my-pc.local:47470'], observed: '192.168.1.30', ts: 1,
  };
  const lsa = engine.signRecord('lsa', { seq: 5, ts: 5, links: [{ peer: other.nodeId, cost: 10 }], caps: { relay: true, mailbox: false, transit: true } });
  const peer = engine.signRecord('peer', { seq: 5, ts: 5, addrs: [], caps: { relay: false, mailbox: false, transit: false }, card: engine.card });
  const meta = { kind: 'msg', card: engine.card, ts: 1, hs: 'A'.repeat(88), ack: true };
  const mutations = (base) => [
    base, null, [], 'x', { ...base, extra: 1 }, { ...base, __proto__: null }, JSON.parse('{"__proto__":1}'),
    ...Object.keys(base).flatMap((key) => {
      const { [key]: _drop, ...rest } = base;
      return [rest, { ...base, [key]: null }, { ...base, [key]: 'x' }, { ...base, [key]: -1 }, { ...base, [key]: [] }, { ...base, [key]: {} }, { ...base, [key]: 2 ** 60 }];
    }),
  ];
  const pairs = [
    ['validateHandshakePayload', payload],
    ['validateLsa', lsa],
    ['validatePeerRecord', peer],
    ['validateMeta', meta],
    ['validateMeta', { kind: 'ack', card: engine.card, ts: 1, hs: 'A'.repeat(88), id: 'a'.repeat(32) }],
    ['validateMeta', { kind: 'file-offer', card: engine.card, ts: 1, hs: 'A'.repeat(88), tid: 'x', nested: { a: [1, 2, { b: true }] } }],
    ['validateDataHeader', { id: 'a'.repeat(32), dst: other.nodeId, ttl: 16, try: 0 }],
    ['validatePingHeader', { n: '0123456789abcdef' }],
    ['validateByeHeader', { reason: 'shutdown' }],
    ['validateCard', engine.card],
    ['validateCaps', { relay: true, mailbox: false, transit: true }],
  ];
  let compared = 0;
  for (const [name, base] of pairs) {
    for (const value of mutations(base)) {
      assert.deepEqual(webSchema[name](value), engineSchema[name](value), `${name} ${JSON.stringify(value)?.slice(0, 80)}`);
      compared += 1;
    }
  }
  assert.ok(compared > 300);
  const addresses = ['tcp://1.2.3.4:1', 'tcp://1.2.3.4:0', 'tcp://1.2.3.4:65536', 'tcp://[::1]:5', 'tcp://[::1]5', 'tcp://a.b:1',
    'tcp://1.2.3:1', 'tcp://0x7f.1:1', 'udp://1.2.3.4:1', 'tcp://-a.b:1', 'tcp://a..b:1', `tcp://${'a'.repeat(64)}.b:1`, 'tcp://[fe80::1%eth0]:1', 'tcp://h:01'];
  for (const address of addresses) assert.deepEqual(webSchema.validateAddress(address), engineSchema.validateAddress(address), address);
});

// -------------------------------------------------------------------------------- codec

test('packets encode to the same bytes and decode the same way', () => {
  const packets = [
    { type: PacketType.PING, header: { n: '0123456789abcdef' } },
    { type: PacketType.BYE, header: { reason: 'shutdown' } },
    { type: PacketType.GOSSIP, header: { n: 1, set: 'lsa' }, body: nodeRandomBytes(40) },
    { type: PacketType.DATA, header: { id: 'b'.repeat(32), dst: engineIdentity.Identity.generate().nodeId, ttl: 16, try: 3 }, body: nodeRandomBytes(500) },
  ];
  for (const packet of packets) {
    const web = webCodec.encodePacket(packet);
    const engine = engineCodec.encodePacket(packet);
    assert.equal(hex(web), hex(engine));
    const back = webCodec.decodePacket(engine);
    assert.equal(back.type, packet.type);
    assert.deepEqual(back.header, packet.header);
    assert.equal(hex(back.body), hex(packet.body ?? Buffer.alloc(0)));
    assert.equal(hex(webCodec.encodeFrame(web)), hex(engineCodec.encodeFrame(engine)));
  }
  const malformed = [Buffer.from([1]), Buffer.from([99, 0, 0, 2, 123, 125]), Buffer.from([1, 1, 0, 2, 123, 125]), Buffer.from([1, 0, 0, 9, 123, 125]), Buffer.from([1, 0, 0, 3, 123, 32, 125])];
  for (const bad of malformed) {
    assert.throws(() => webCodec.decodePacket(bad));
    assert.throws(() => engineCodec.decodePacket(bad));
  }
  // Frames split at every byte boundary come out whole.
  const stream = Buffer.concat(packets.map((packet) => engineCodec.encodeFrame(engineCodec.encodePacket(packet))));
  const decoder = new webCodec.FrameDecoder();
  const frames = [];
  for (let i = 0; i < stream.length; i += 1) frames.push(...decoder.push(stream.subarray(i, i + 1)));
  assert.equal(frames.length, packets.length);
  assert.throws(() => new webCodec.FrameDecoder().push(Uint8Array.of(0, 0, 0, 0)));
});

// ----------------------------------------------------------------------------- envelope

for (const size of [0, 5, 65000, 70000]) {
  test(`sealed messages open across implementations (content of ${size} bytes)`, () => {
    const alice = pairOfIdentities();
    const bob = pairOfIdentities();
    const id = hex(nodeRandomBytes(16));
    const content = nodeRandomBytes(size);
    const meta = { kind: 'msg', ack: true };
    const fromWeb = webEnvelope.sealMessage({ sender: alice.web, recipientE2eKey: bob.web.e2eKeyPair.publicKey, dst: bob.web.nodeId, id, meta, content });
    const opened = engineEnvelope.openMessage({ recipient: bob.engine, dst: bob.engine.nodeId, id, body: Buffer.from(fromWeb) });
    assert.equal(opened.senderId, alice.engine.nodeId);
    assert.equal(hex(opened.content), hex(content));
    assert.equal(opened.meta.ack, true);
    const fromEngine = engineEnvelope.sealMessage({ sender: bob.engine, recipientE2eKey: alice.engine.e2eKeyPair.publicKey, dst: alice.engine.nodeId, id, meta, content });
    const openedByWeb = webEnvelope.openMessage({ recipient: alice.web, dst: alice.web.nodeId, id, body: new Uint8Array(fromEngine) });
    assert.equal(openedByWeb.senderId, bob.web.nodeId);
    assert.equal(hex(openedByWeb.content), hex(content));
    assert.equal(fromWeb.length, fromEngine.length, 'same framing, same length');
  });
}

test('a sealed message is refused by both for the wrong id, wrong recipient or one flipped bit', () => {
  const alice = pairOfIdentities();
  const bob = pairOfIdentities();
  const id = hex(nodeRandomBytes(16));
  const body = webEnvelope.sealMessage({ sender: alice.web, recipientE2eKey: bob.web.e2eKeyPair.publicKey, dst: bob.web.nodeId, id, meta: { kind: 'msg', ack: true }, content: Buffer.from('hi') });
  assert.throws(() => engineEnvelope.openMessage({ recipient: bob.engine, dst: bob.engine.nodeId, id: hex(nodeRandomBytes(16)), body: Buffer.from(body) }), AuthError);
  assert.throws(() => webEnvelope.openMessage({ recipient: alice.web, dst: alice.web.nodeId, id, body }), AuthError);
  for (const index of [0, 1, 5, 60, body.length - 1]) {
    const flipped = Uint8Array.from(body);
    flipped[index] ^= 1;
    assert.throws(() => webEnvelope.openMessage({ recipient: bob.web, dst: bob.web.nodeId, id, body: flipped }), AuthError);
    assert.throws(() => engineEnvelope.openMessage({ recipient: bob.engine, dst: bob.engine.nodeId, id, body: Buffer.from(flipped) }), AuthError);
  }
  const old = engineEnvelope.sealMessage({ sender: alice.engine, recipientE2eKey: bob.engine.e2eKeyPair.publicKey, dst: bob.engine.nodeId, id, meta: { kind: 'msg', ack: true }, now: Date.now() - 8 * 24 * 3600 * 1000 });
  assert.throws(() => webEnvelope.openMessage({ recipient: bob.web, dst: bob.web.nodeId, id, body: new Uint8Array(old) }), AuthError);
});
