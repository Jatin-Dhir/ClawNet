import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { format, inspect } from 'node:util';

import {
  Identity,
  RECORD_TYPE_PATTERN,
  isValidNodeId,
  nodeIdToPublicKey,
  publicKeyToNodeId,
  shortId,
  verifyCard,
  verifyRecord,
  verifySignature,
} from '../../src/core/crypto/identity.js';
import { HandshakeState } from '../../src/core/crypto/noise.js';
import { base32Decode, x25519 } from '../../src/core/crypto/primitives.js';
import { CanonicalError, CryptoError } from '../../src/core/errors.js';
import { Domain, NODE_ID_PATTERN, RecordType } from '../../src/core/wire/types.js';

const hex = text => Buffer.from(text, 'hex');
const utf8 = text => Buffer.from(text, 'utf8');
const b64 = bytes => Buffer.from(bytes).toString('base64');

/** A fixed identity: the Ed25519 seed is RFC 8032 test 1, the X25519 keys are RFC 7748 6.1. */
const SECRET = Object.freeze({
  signSeed: hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
  linkPrivate: hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
  e2ePrivate: hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'),
});
const KNOWN = Object.freeze({
  signPublic: hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
  // base32 of signPublic, computed with Python's base64.b32encode.
  nodeId: '25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena',
  linkPublic: hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'),
  e2ePublic: hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'),
});

/**
 * Ed25519 straight from node:crypto, so expected signatures do not come from the module
 * under test.
 */
function referenceSign(seed, message) {
  const key = createPrivateKey({
    key: Buffer.concat([hex('302e020100300506032b657004220420'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return nodeSign(null, message, key);
}

function referencePublic(seed) {
  const key = createPrivateKey({
    key: Buffer.concat([hex('302e020100300506032b657004220420'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
}

const domainSeparated = (domain, bytes) => Buffer.concat([utf8(domain), Buffer.from([0]), bytes]);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Base32 decoding of a 52-character string that keeps the first 256 bits and ignores the
 * four spare bits, written with BigInt so it shares nothing with primitives.js. It shows
 * which strings a careless decoder would map to the same key.
 */
function laxBase32Decode(text) {
  let value = 0n;
  for (const char of text) value = (value << 5n) | BigInt(BASE32.indexOf(char));
  return Buffer.from((value >> 4n).toString(16).padStart(64, '0'), 'hex');
}

/** The 15 strings other than `nodeId` that differ from it only in the four spare bits. */
function nonCanonicalSpellings(nodeId) {
  const dataBit = BASE32.indexOf(nodeId.at(-1)) & 0x10;
  return Array.from({ length: 15 }, (_, i) => nodeId.slice(0, 51) + BASE32[dataBit | (i + 1)]);
}

/** Every spelling in which a secret could leak into text. */
function spellings(secret) {
  const hexText = secret.toString('hex');
  return [
    hexText,
    hexText.toUpperCase(),
    hexText.match(/../g).join(' '),
    hexText.match(/../g).join(':'),
    secret.toString('base64'),
    secret.toString('base64url'),
    secret.toString('latin1'),
    [...secret].join(','),
    [...secret].join(', '),
  ];
}

function assertNoSecrets(text, secrets, label) {
  for (const secret of secrets) {
    for (const spelling of spellings(secret)) {
      assert.ok(!text.includes(spelling), `${label} leaks a secret`);
    }
  }
}

test('generate() creates three independent keys and a NodeId that is the identity key', () => {
  const identity = Identity.generate();
  assert.match(identity.nodeId, NODE_ID_PATTERN);
  assert.equal(identity.nodeId.length, 52);
  assert.equal(isValidNodeId(identity.nodeId), true);
  assert.equal(identity.signPublicKey.length, 32);
  assert.equal(publicKeyToNodeId(identity.signPublicKey), identity.nodeId);
  assert.deepEqual(nodeIdToPublicKey(identity.nodeId), identity.signPublicKey);

  const secret = identity.toSecret();
  assert.deepEqual(Object.keys(secret).sort(), ['e2ePrivate', 'linkPrivate', 'signSeed']);
  const keys = [secret.signSeed, secret.linkPrivate, secret.e2ePrivate];
  for (const key of keys) assert.equal(key.length, 32);
  assert.equal(new Set(keys.map(key => key.toString('hex'))).size, 3);
  assert.notDeepEqual(identity.linkKeyPair.publicKey, identity.e2eKeyPair.publicKey);
  assert.deepEqual(identity.linkKeyPair.privateKey, secret.linkPrivate);
  assert.deepEqual(identity.e2eKeyPair.privateKey, secret.e2ePrivate);

  const other = Identity.generate();
  assert.notEqual(other.nodeId, identity.nodeId);
  assert.notDeepEqual(other.toSecret().linkPrivate, secret.linkPrivate);
});

test('fromSecret() derives the published public keys and NodeId', () => {
  const identity = Identity.fromSecret(SECRET);
  assert.deepEqual(identity.signPublicKey, KNOWN.signPublic);
  assert.equal(identity.nodeId, KNOWN.nodeId);
  assert.deepEqual(identity.linkKeyPair, { publicKey: KNOWN.linkPublic, privateKey: SECRET.linkPrivate });
  assert.deepEqual(identity.e2eKeyPair, { publicKey: KNOWN.e2ePublic, privateKey: SECRET.e2ePrivate });
  assert.deepEqual(identity.toSecret(), { ...SECRET });
  // The link key pair really is an X25519 pair: RFC 7748 section 6.1 shared secret.
  assert.equal(
    x25519(identity.linkKeyPair.privateKey, identity.e2eKeyPair.publicKey).toString('hex'),
    '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'
  );
});

test('toSecret() and fromSecret() round-trip an identity exactly', () => {
  const original = Identity.generate();
  const restored = Identity.fromSecret(original.toSecret());
  assert.equal(restored.nodeId, original.nodeId);
  assert.deepEqual(restored.card, original.card);
  assert.deepEqual(restored.linkKeyPair, original.linkKeyPair);
  assert.deepEqual(restored.e2eKeyPair, original.e2eKeyPair);
  assert.deepEqual(restored.sign('test/domain', utf8('x')), original.sign('test/domain', utf8('x')));
  // Typed arrays are as good as Buffers.
  const typed = Object.fromEntries(Object.entries(original.toSecret()).map(([k, v]) => [k, new Uint8Array(v)]));
  assert.equal(Identity.fromSecret(typed).nodeId, original.nodeId);
});

test('an identity cannot be changed through anything it hands out', () => {
  const secret = { signSeed: Buffer.from(SECRET.signSeed), linkPrivate: Buffer.from(SECRET.linkPrivate), e2ePrivate: Buffer.from(SECRET.e2ePrivate) };
  const identity = Identity.fromSecret(secret);
  for (const key of Object.values(secret)) key.fill(0);
  identity.toSecret().signSeed.fill(0);
  identity.linkKeyPair.privateKey.fill(0);
  identity.linkKeyPair.publicKey.fill(0);
  identity.e2eKeyPair.privateKey.fill(0);
  identity.signPublicKey.fill(0);
  assert.deepEqual(identity.toSecret(), { ...SECRET });
  assert.deepEqual(identity.linkKeyPair.publicKey, KNOWN.linkPublic);
  assert.deepEqual(identity.signPublicKey, KNOWN.signPublic);

  assert.ok(Object.isFrozen(identity));
  assert.throws(() => {
    identity.nodeId = 'x';
  }, TypeError);
  assert.throws(() => {
    identity.card.id = 'x';
  }, TypeError);
  assert.throws(() => {
    identity.extra = 1;
  }, TypeError);
  assert.equal(identity.nodeId, KNOWN.nodeId);
  assert.equal(identity.card.id, KNOWN.nodeId);
});

test('fromSecret() and the constructor refuse malformed secrets', () => {
  const err = { name: 'CryptoError', code: 'ERR_CRYPTO' };
  const bad = [
    undefined,
    null,
    'secret',
    {},
    { ...SECRET, signSeed: undefined },
    { ...SECRET, linkPrivate: undefined },
    { ...SECRET, e2ePrivate: undefined },
    { ...SECRET, signSeed: SECRET.signSeed.subarray(0, 31) },
    { ...SECRET, linkPrivate: Buffer.alloc(33) },
    { ...SECRET, e2ePrivate: SECRET.e2ePrivate.toString('hex') },
    { ...SECRET, signSeed: SECRET.signSeed.toString('base64') },
    { ...SECRET, linkPrivate: [...SECRET.linkPrivate] },
    // One key per protocol: no two roles may share key bytes.
    { ...SECRET, e2ePrivate: Buffer.from(SECRET.linkPrivate) },
    { ...SECRET, linkPrivate: Buffer.from(SECRET.signSeed) },
    { ...SECRET, e2ePrivate: Buffer.from(SECRET.signSeed) },
  ];
  for (const secret of bad) assert.throws(() => Identity.fromSecret(secret), err, inspect(secret));
  assert.throws(() => new Identity(), err);
  assert.throws(() => new Identity(Symbol('Identity.factory'), SECRET), err);
});

test('the identity card is the DESIGN.md binding of both X25519 keys to the NodeId', () => {
  const identity = Identity.fromSecret(SECRET);
  const card = identity.card;
  assert.deepEqual(Object.keys(card).sort(), ['e2e', 'id', 'link', 'sig']);
  assert.equal(card.id, KNOWN.nodeId);
  assert.equal(card.link, b64(KNOWN.linkPublic));
  assert.equal(card.e2e, b64(KNOWN.e2ePublic));
  // signature = Ed25519(identity key, utf8("clawnet/1/static-key-binding") || 0x00 || link || e2e)
  const expected = referenceSign(
    SECRET.signSeed,
    Buffer.concat([utf8('clawnet/1/static-key-binding'), Buffer.from([0]), KNOWN.linkPublic, KNOWN.e2ePublic])
  );
  assert.equal(card.sig, b64(expected));

  assert.ok(Object.isFrozen(card));
  assert.equal(identity.card, card, 'the card is built once');
  // It survives the trip through JSON that every card makes on the wire.
  assert.deepEqual(verifyCard(JSON.parse(JSON.stringify(card))), {
    ok: true,
    nodeId: KNOWN.nodeId,
    linkPublicKey: KNOWN.linkPublic,
    e2ePublicKey: KNOWN.e2ePublic,
  });
});

test('verifyCard rejects every way a card can be wrong', () => {
  const alice = Identity.generate();
  const mallory = Identity.generate();
  const card = alice.card;
  assert.equal(verifyCard(card).ok, true);

  const flipped = text => {
    const bytes = Buffer.from(text, 'base64');
    bytes[0] ^= 1;
    return b64(bytes);
  };
  const cases = [
    // Mallory's keys under Alice's name: the classic impersonation.
    [{ ...mallory.card, id: alice.nodeId }, 'bad-signature'],
    // Alice's keys under Mallory's name, with Alice's signature.
    [{ ...card, id: mallory.nodeId }, 'bad-signature'],
    [{ ...card, link: mallory.card.link }, 'bad-signature'],
    [{ ...card, e2e: mallory.card.e2e }, 'bad-signature'],
    [{ ...card, link: card.e2e, e2e: card.link }, 'bad-signature'],
    [{ ...card, sig: flipped(card.sig) }, 'bad-signature'],
    [{ ...card, sig: mallory.card.sig }, 'bad-signature'],
    [{ ...card, link: flipped(card.link) }, 'bad-signature'],
    [{ ...card, sig: b64(Buffer.alloc(64)) }, 'bad-signature'],
    [{ ...card, sig: b64(Buffer.from(card.sig, 'base64').subarray(0, 63)) }, 'bad-encoding'],
    [{ ...card, sig: b64(Buffer.concat([Buffer.from(card.sig, 'base64'), Buffer.alloc(1)])) }, 'bad-encoding'],
    [{ ...card, sig: card.sig.replace(/=+$/, '') }, 'bad-encoding'],
    [{ ...card, sig: ` ${card.sig}` }, 'bad-encoding'],
    [{ ...card, link: card.link.replace(/=$/, '') }, 'bad-encoding'],
    [{ ...card, link: b64(Buffer.alloc(31)) }, 'bad-encoding'],
    [{ ...card, e2e: b64(Buffer.alloc(33)) }, 'bad-encoding'],
    [{ ...card, e2e: Buffer.from(card.e2e, 'base64').toString('base64url') }, 'bad-encoding'],
    [{ ...card, link: Buffer.from(card.link, 'base64') }, 'bad-encoding'],
    [{ ...card, sig: 12 }, 'bad-encoding'],
    [{ ...card, id: card.id.toUpperCase() }, 'bad-id'],
    [{ ...card, id: card.id.slice(0, 51) }, 'bad-id'],
    [{ ...card, id: `${card.id.slice(0, 51)}b` }, 'bad-id'],
    [{ ...card, id: 7 }, 'bad-id'],
    [{ ...card, extra: 1 }, 'bad-shape'],
    [{ ...card, caps: {} }, 'bad-shape'],
    [{ id: card.id, link: card.link, e2e: card.e2e }, 'bad-shape'],
    [{ id: card.id, link: card.link, sig: card.sig, key: card.e2e }, 'bad-shape'],
    [{}, 'bad-shape'],
    [null, 'not-an-object'],
    [undefined, 'not-an-object'],
    ['card', 'not-an-object'],
    [[card.id, card.link, card.e2e, card.sig], 'not-an-object'],
    [new Map(Object.entries(card)), 'not-an-object'],
  ];
  for (const [candidate, reason] of cases) {
    assert.deepEqual(verifyCard(candidate), { ok: false, reason }, `${reason}: ${inspect(candidate)}`);
  }
});

test('verifyCard rejects a card whose signature was made for another purpose', () => {
  const identity = Identity.fromSecret(SECRET);
  const binding = Buffer.concat([KNOWN.linkPublic, KNOWN.e2ePublic]);
  const base = { id: KNOWN.nodeId, link: b64(KNOWN.linkPublic), e2e: b64(KNOWN.e2ePublic) };
  const signatures = {
    'no domain at all': referenceSign(SECRET.signSeed, binding),
    'a record domain': identity.sign(`${Domain.RECORD_PREFIX}peer`, binding),
    'domain without the separator': referenceSign(SECRET.signSeed, Buffer.concat([utf8(Domain.STATIC_KEY_BINDING), binding])),
    'keys in the other order': identity.sign(Domain.STATIC_KEY_BINDING, Buffer.concat([KNOWN.e2ePublic, KNOWN.linkPublic])),
  };
  for (const [why, signature] of Object.entries(signatures)) {
    assert.deepEqual(verifyCard({ ...base, sig: b64(signature) }), { ok: false, reason: 'bad-signature' }, why);
  }
  // Control: the right domain over the right bytes is what the card carries.
  assert.equal(b64(identity.sign(Domain.STATIC_KEY_BINDING, binding)), identity.card.sig);
  assert.equal(verifyCard({ ...base, sig: identity.card.sig }).ok, true);
});

test('verifyCard rejects one key used for both link and e2e, even when properly signed', () => {
  const signature = referenceSign(
    SECRET.signSeed,
    domainSeparated(Domain.STATIC_KEY_BINDING, Buffer.concat([KNOWN.linkPublic, KNOWN.linkPublic]))
  );
  const card = { id: KNOWN.nodeId, link: b64(KNOWN.linkPublic), e2e: b64(KNOWN.linkPublic), sig: b64(signature) };
  assert.deepEqual(verifyCard(card), { ok: false, reason: 'key-reuse' });
});

test('sign() produces domain-separated Ed25519 signatures that verifySignature() checks', () => {
  const identity = Identity.fromSecret(SECRET);
  const other = Identity.generate();
  const bytes = utf8('payload');
  const signature = identity.sign('clawnet/1/test', bytes);
  assert.equal(signature.length, 64);
  // Exactly Ed25519 over utf8(domain) || 0x00 || bytes.
  assert.deepEqual(signature, referenceSign(SECRET.signSeed, Buffer.concat([utf8('clawnet/1/test'), Buffer.from([0]), bytes])));

  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', bytes, signature), true);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', new Uint8Array(bytes), new Uint8Array(signature)), true);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/tesT', bytes, signature), false);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', utf8('payloae'), signature), false);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', Buffer.alloc(0), signature), false);
  assert.equal(verifySignature(other.nodeId, 'clawnet/1/test', bytes, signature), false);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', bytes, other.sign('clawnet/1/test', bytes)), false);
  // Moving a byte across the separator changes what was signed.
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/tes', utf8('tpayload'), signature), false);
  assert.equal(verifySignature(identity.nodeId, 'clawnet/1/test', bytes, referenceSign(SECRET.signSeed, bytes)), false);
  // Non-ASCII domains are encoded as UTF-8.
  const accented = `caf${String.fromCodePoint(0xe9)}`;
  assert.deepEqual(identity.sign(accented, bytes), referenceSign(SECRET.signSeed, Buffer.concat([hex('636166c3a900'), bytes])));
  assert.equal(verifySignature(identity.nodeId, accented, bytes, identity.sign(accented, bytes)), true);
});

test('sign() refuses unusable domains and verifySignature() never throws', () => {
  const identity = Identity.generate();
  const bytes = utf8('payload');
  const signature = identity.sign('d', bytes);
  const badDomains = ['', 'a\x00b', '\x00', 'trailing\x00', String.fromCharCode(0xd800), undefined, null, 7, utf8('d'), ['d']];
  for (const domain of badDomains) {
    assert.throws(() => identity.sign(domain, bytes), { name: 'CryptoError', code: 'ERR_CRYPTO' }, inspect(domain));
    assert.equal(verifySignature(identity.nodeId, domain, bytes, signature), false);
  }
  for (const value of ['payload', undefined, null, 7, [1, 2]]) {
    assert.throws(() => identity.sign('d', value), CryptoError);
    assert.equal(verifySignature(identity.nodeId, 'd', value, signature), false);
    assert.equal(verifySignature(identity.nodeId, 'd', bytes, value), false);
    assert.equal(verifySignature(value, 'd', bytes, signature), false);
  }
  assert.equal(verifySignature(identity.nodeId.toUpperCase(), 'd', bytes, signature), false);
  assert.equal(verifySignature(identity.nodeId, 'd', bytes, signature.subarray(0, 63)), false);
  assert.equal(verifySignature(identity.nodeId, 'd', bytes, signature), true);
});

test('signRecord() signs the canonical form under the record domain', () => {
  const identity = Identity.fromSecret(SECRET);
  const record = identity.signRecord('lsa', { seq: 7, links: [], ts: 1700000000000 });
  assert.deepEqual(Object.keys(record).sort(), ['links', 'origin', 'seq', 'sig', 'ts', 'type']);
  assert.equal(record.type, 'lsa');
  assert.equal(record.origin, KNOWN.nodeId);
  assert.equal(record.seq, 7);

  // The canonical JSON is written out by hand here, not produced by canonical.js.
  const canonical = `{"links":[],"origin":"${KNOWN.nodeId}","seq":7,"ts":1700000000000,"type":"lsa"}`;
  const expected = referenceSign(SECRET.signSeed, Buffer.concat([utf8('clawnet/1/record/lsa'), Buffer.from([0]), utf8(canonical)]));
  assert.equal(record.sig, b64(expected));
  assert.deepEqual(verifyRecord(record), { ok: true });
  assert.deepEqual(verifyRecord(record, 'lsa'), { ok: true });
  assert.deepEqual(verifyRecord(record, RecordType.LSA), { ok: true });
});

test('a signed record is a deep-frozen copy of what was signed', () => {
  const identity = Identity.generate();
  const fields = { seq: 1, links: [{ peer: Identity.generate().nodeId, cost: 3 }], caps: { transit: true } };
  const record = identity.signRecord('lsa', fields);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.links));
  assert.ok(Object.isFrozen(record.links[0]));
  assert.ok(Object.isFrozen(record.caps));
  assert.notEqual(record.links, fields.links);
  // Changing the input afterwards cannot invalidate the record.
  fields.links[0].cost = 99;
  fields.links.push({ peer: 'x', cost: 1 });
  assert.equal(record.links.length, 1);
  assert.equal(record.links[0].cost, 3);
  assert.deepEqual(verifyRecord(record), { ok: true });
  assert.deepEqual(fields.seq, 1, 'the caller object is not modified');
  assert.ok(!('sig' in fields) && !('origin' in fields));
});

test('verifyRecord accepts a record however its keys are ordered or transported', () => {
  const identity = Identity.generate();
  const record = identity.signRecord('peer', { seq: 3, ts: 5, addrs: ['127.0.0.1:1'], caps: { mailbox: false }, card: identity.card });
  const viaJson = JSON.parse(JSON.stringify(record));
  assert.deepEqual(verifyRecord(viaJson, 'peer'), { ok: true });
  const reversed = Object.fromEntries(Object.entries(record).reverse());
  assert.notDeepEqual(Object.keys(reversed), Object.keys(record));
  assert.deepEqual(verifyRecord(reversed), { ok: true });
  const bare = Object.assign(Object.create(null), record);
  assert.deepEqual(verifyRecord(bare), { ok: true });
});

test('verifyRecord rejects every way a record can be wrong', () => {
  const alice = Identity.generate();
  const mallory = Identity.generate();
  const record = alice.signRecord('lsa', { seq: 9, links: [{ peer: mallory.nodeId, cost: 4 }], ts: 100 });
  assert.deepEqual(verifyRecord(record), { ok: true });

  const sigBytes = Buffer.from(record.sig, 'base64');
  const flippedSig = Buffer.from(sigBytes);
  flippedSig[10] ^= 4;
  const cases = [
    [{ ...record, seq: 10 }, undefined, 'bad-signature'],
    [{ ...record, links: [] }, undefined, 'bad-signature'],
    [{ ...record, links: [{ peer: mallory.nodeId, cost: 5 }] }, undefined, 'bad-signature'],
    [{ ...record, extra: true }, undefined, 'bad-signature'],
    [{ origin: record.origin, type: record.type, seq: record.seq, links: record.links, sig: record.sig }, undefined, 'bad-signature'],
    // Relabelled: same content, another type. The domain differs, and so does the content.
    [{ ...record, type: 'peer' }, undefined, 'bad-signature'],
    [{ ...record, type: 'peer' }, 'peer', 'bad-signature'],
    // Re-attributed to someone else.
    [{ ...record, origin: mallory.nodeId }, undefined, 'bad-signature'],
    [{ ...record, sig: b64(flippedSig) }, undefined, 'bad-signature'],
    [{ ...record, sig: mallory.signRecord('lsa', { seq: 9, links: record.links, ts: 100 }).sig }, undefined, 'bad-signature'],
    [record, 'peer', 'wrong-type'],
    [record, 'LSA', 'wrong-type'],
    [record, 7, 'wrong-type'],
    [record, null, 'wrong-type'],
    [{ ...record, type: 'LSA' }, undefined, 'bad-type'],
    [{ ...record, type: '' }, undefined, 'bad-type'],
    [{ ...record, type: 'ls a' }, undefined, 'bad-type'],
    [{ ...record, type: 'lsa\x00' }, undefined, 'bad-type'],
    [{ ...record, type: 'a'.repeat(33) }, undefined, 'bad-type'],
    [{ ...record, type: 7 }, undefined, 'bad-type'],
    [{ ...record, type: undefined }, undefined, 'bad-type'],
    [{ ...record, origin: record.origin.toUpperCase() }, undefined, 'bad-origin'],
    [{ ...record, origin: `${record.origin.slice(0, 51)}c` }, undefined, 'bad-origin'],
    [{ ...record, origin: undefined }, undefined, 'bad-origin'],
    [{ ...record, origin: alice.signPublicKey }, undefined, 'bad-origin'],
    [{ ...record, sig: undefined }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: b64(sigBytes.subarray(0, 63)) }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: b64(Buffer.concat([sigBytes, Buffer.alloc(1)])) }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: record.sig.replace(/==$/, '') }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: sigBytes.toString('base64url') }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: sigBytes.toString('hex') }, undefined, 'bad-sig-encoding'],
    [{ ...record, sig: sigBytes }, undefined, 'bad-sig-encoding'],
    [{ ...record, seq: 1.5 }, undefined, 'not-canonical'],
    [{ ...record, seq: 2 ** 60 }, undefined, 'not-canonical'],
    [{ ...record, note: undefined }, undefined, 'not-canonical'],
    [{ ...record, when: new Date(0) }, undefined, 'not-canonical'],
    [{ ...record, note: String.fromCharCode(0xdc00) }, undefined, 'not-canonical'],
    [null, undefined, 'not-an-object'],
    [undefined, undefined, 'not-an-object'],
    ['record', undefined, 'not-an-object'],
    [[record], undefined, 'not-an-object'],
    [new Map(Object.entries(record)), undefined, 'not-an-object'],
  ];
  for (const [candidate, expectedType, reason] of cases) {
    assert.deepEqual(verifyRecord(candidate, expectedType), { ok: false, reason }, `${reason}: ${inspect(candidate, { depth: 0 })}`);
  }
});

test('verify functions report "malformed" instead of throwing on hostile objects', () => {
  const identity = Identity.generate();
  const record = identity.signRecord('lsa', { seq: 1 });
  const explosive = (source, key) => {
    const copy = { ...source };
    Object.defineProperty(copy, key, {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    return copy;
  };
  assert.deepEqual(verifyRecord(explosive(record, 'seq')), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyCard(explosive(identity.card, 'id')), { ok: false, reason: 'malformed' });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(verifyRecord(revoked.proxy).ok, false);
  assert.equal(verifyCard(revoked.proxy).ok, false);
});

test('signRecord() refuses reserved fields, bad types and non-canonical values', () => {
  const identity = Identity.generate();
  const err = { name: 'CryptoError', code: 'ERR_CRYPTO' };
  for (const key of ['type', 'origin', 'sig']) {
    assert.throws(() => identity.signRecord('lsa', { seq: 1, [key]: 'x' }), err, key);
    assert.throws(() => identity.signRecord('lsa', { seq: 1, [key]: undefined }), err, key);
  }
  for (const type of ['', 'LSA', 'ls a', 'lsa/x', 'lsa\x00', '1sa', 'a'.repeat(33), undefined, null, 7]) {
    assert.throws(() => identity.signRecord(type, { seq: 1 }), err, inspect(type));
    assert.equal(typeof type === 'string' && RECORD_TYPE_PATTERN.test(type), false);
  }
  for (const fields of [undefined, null, 'seq', [1], new Map(), new (class Fields {})()]) {
    assert.throws(() => identity.signRecord('lsa', fields), err, inspect(fields));
  }
  assert.throws(() => identity.signRecord('lsa', { seq: 1.5 }), CanonicalError);
  assert.throws(() => identity.signRecord('lsa', { seq: undefined }), CanonicalError);
  assert.throws(() => identity.signRecord('lsa', { when: new Date() }), CanonicalError);
  // Every record type the protocol defines is accepted.
  for (const type of Object.values(RecordType)) {
    assert.deepEqual(verifyRecord(identity.signRecord(type, { seq: 1 }), type), { ok: true });
  }
});

test('a NodeId has exactly one valid spelling', () => {
  const nodeId = KNOWN.nodeId;
  assert.equal(isValidNodeId(nodeId), true);
  assert.deepEqual(nodeIdToPublicKey(nodeId), KNOWN.signPublic);
  assert.equal(publicKeyToNodeId(new Uint8Array(KNOWN.signPublic)), nodeId);

  // 52 base32 characters hold 260 bits. The last character has four spare bits, so 16
  // strings decode to every key; DESIGN.md 15.1 makes only the one with zero spare bits valid.
  const respellings = nonCanonicalSpellings(nodeId);
  assert.equal(respellings.length, 15);
  assert.equal(new Set(respellings).size, 15);
  const record = Identity.fromSecret(SECRET).signRecord('peer', { seq: 1 });
  for (const candidate of respellings) {
    // Each really is the same key: a decoder that ignored the spare bits would say so.
    assert.deepEqual(laxBase32Decode(candidate), KNOWN.signPublic, candidate);
    assert.doesNotMatch(candidate, NODE_ID_PATTERN);
    assert.equal(isValidNodeId(candidate), false, candidate);
    assert.throws(() => nodeIdToPublicKey(candidate), { name: 'CryptoError', code: 'ERR_CRYPTO' }, candidate);
    assert.throws(() => base32Decode(candidate), { name: 'CryptoError', message: 'base32 input has non-zero trailing bits' }, candidate);
    // A card or a record naming its signer by a respelled id is refused before the
    // signature is even looked at, although the signature itself is genuine.
    assert.deepEqual(verifyCard({ ...Identity.fromSecret(SECRET).card, id: candidate }), { ok: false, reason: 'bad-id' });
    assert.deepEqual(verifyRecord({ ...record, origin: candidate }), { ok: false, reason: 'bad-origin' });
    assert.equal(verifySignature(candidate, 'd', utf8('x'), Identity.fromSecret(SECRET).sign('d', utf8('x'))), false);
    assert.equal(shortId(candidate), '????????');
  }
  // Controls: the canonical spelling passes every one of the same checks.
  assert.deepEqual(laxBase32Decode(nodeId), KNOWN.signPublic);
  assert.deepEqual(base32Decode(nodeId), KNOWN.signPublic);
  assert.equal(verifyCard(Identity.fromSecret(SECRET).card).ok, true);
  assert.deepEqual(verifyRecord(record), { ok: true });
  assert.equal(verifySignature(nodeId, 'd', utf8('x'), Identity.fromSecret(SECRET).sign('d', utf8('x'))), true);
  // The same holds for a key whose canonical id ends in "q" (top data bit set).
  const qKey = Buffer.alloc(32, 0xff);
  const qId = publicKeyToNodeId(qKey);
  assert.equal(qId.at(-1), 'q');
  for (const candidate of nonCanonicalSpellings(qId)) {
    assert.deepEqual(laxBase32Decode(candidate), qKey);
    assert.equal(isValidNodeId(candidate), false, candidate);
    assert.throws(() => nodeIdToPublicKey(candidate), CryptoError);
  }

  const invalid = [nodeId.toUpperCase(), nodeId.slice(1), `${nodeId}a`, `${nodeId.slice(0, 51)}1`, `${nodeId.slice(0, 51)}=`, ` ${nodeId.slice(1)}`, '', undefined, null, 52, KNOWN.signPublic, [nodeId]];
  for (const value of invalid) {
    assert.equal(isValidNodeId(value), false, inspect(value));
    assert.throws(() => nodeIdToPublicKey(value), CryptoError);
  }
  assert.throws(() => publicKeyToNodeId(Buffer.alloc(31)), CryptoError);
  assert.throws(() => publicKeyToNodeId(nodeId), CryptoError);
  // The all-zero and all-one keys are well-formed ids (whether a key is usable is a
  // separate question, answered by signature verification).
  assert.equal(publicKeyToNodeId(Buffer.alloc(32)), 'a'.repeat(52));
  assert.equal(isValidNodeId('a'.repeat(52)), true);
  assert.equal(isValidNodeId(publicKeyToNodeId(Buffer.alloc(32, 0xff))), true);
});

test('shortId abbreviates anything shaped like a NodeId and masks everything else', () => {
  assert.equal(shortId(KNOWN.nodeId), '25njqamc');
  const generated = Identity.generate().nodeId;
  assert.equal(shortId(generated), generated.slice(0, 8));
  // A non-canonical spelling of a valid key is not a NodeId and is masked like any other text.
  const respelled = `${KNOWN.nodeId.slice(0, 51)}b`;
  assert.equal(isValidNodeId(respelled), false);
  assert.equal(shortId(respelled), '????????');

  const masked = [
    '',
    'short',
    KNOWN.nodeId.slice(0, 8),
    KNOWN.nodeId.toUpperCase(),
    `${KNOWN.nodeId}\n`,
    `${KNOWN.nodeId}a`,
    `\n${KNOWN.nodeId.slice(1)}`,
    `\x1b[31m${KNOWN.nodeId.slice(5)}`,
    `<script>${KNOWN.nodeId.slice(8)}`,
    undefined,
    null,
    5,
    {},
    [KNOWN.nodeId],
    KNOWN.signPublic,
  ];
  for (const value of masked) assert.equal(shortId(value), '????????', inspect(value));
});

test('private keys never appear when an Identity is printed, serialised or reported in errors', () => {
  const identity = Identity.fromSecret(SECRET);
  const secrets = [SECRET.signSeed, SECRET.linkPrivate, SECRET.e2ePrivate];

  const dumps = {
    inspect: inspect(identity),
    'inspect, everything on': inspect(identity, { depth: null, showHidden: true, getters: true, showProxy: true }),
    'inspect nested': inspect({ node: { identity } }, { depth: null, getters: true }),
    'inspect in array': inspect([identity], { showHidden: true }),
    '%o': format('%o', identity),
    '%O': format('%O', identity),
    '%s': format('%s', identity),
    '%j': format('%j', identity),
    String: String(identity),
    template: `${identity}`,
    concatenation: 'id: ' + identity,
    toString: identity.toString(),
    JSON: JSON.stringify(identity),
    'JSON nested': JSON.stringify({ identity, list: [identity] }, null, 2),
    'JSON of own keys': JSON.stringify(Object.fromEntries(Reflect.ownKeys(identity).map(key => [String(key), identity[key]]))),
    'own descriptors': inspect(Object.getOwnPropertyDescriptors(identity), { depth: null }),
    'error with identity as cause': inspect(new Error('failed', { cause: identity }), { depth: null }),
    'console-style': format('identity', identity, { identity }),
  };
  for (const [label, text] of Object.entries(dumps)) assertNoSecrets(text, secrets, label);
  // The dumps are not vacuous: they do identify the node.
  assert.equal(dumps.inspect, 'Identity <25njqamc>');
  assert.equal(dumps.String, `Identity(${KNOWN.nodeId})`);
  assert.deepEqual(JSON.parse(dumps.JSON), { nodeId: KNOWN.nodeId, card: { ...identity.card } });
  assert.deepEqual(Reflect.ownKeys(identity), []);
  // structuredClone copies no private state either.
  assert.deepEqual(structuredClone(identity), {});

  // Error paths that handle the private keys.
  const errors = [];
  const capture = fn => {
    try {
      fn();
    } catch (err) {
      errors.push(err);
      return;
    }
    assert.fail('expected an error');
  };
  capture(() => identity.sign('', utf8('x')));
  capture(() => identity.sign('d', 'not bytes'));
  capture(() => identity.signRecord('lsa', { type: 'x' }));
  capture(() => identity.signRecord('lsa', { seq: 1.5 }));
  capture(() => identity.signRecord('BAD', {}));
  capture(() => Identity.fromSecret({ ...SECRET, e2ePrivate: Buffer.from(SECRET.linkPrivate) }));
  capture(() => Identity.fromSecret({ ...SECRET, signSeed: Buffer.concat([SECRET.signSeed, SECRET.signSeed]) }));
  capture(() => Identity.fromSecret({ ...SECRET, linkPrivate: SECRET.linkPrivate.toString('hex') }));
  // The key pairs in use: a small-order peer key, and a pair that does not match.
  capture(() => x25519(identity.linkKeyPair.privateKey, Buffer.alloc(32)));
  capture(
    () =>
      new HandshakeState({
        pattern: 'XX',
        initiator: true,
        prologue: Buffer.alloc(0),
        s: { publicKey: KNOWN.e2ePublic, privateKey: SECRET.linkPrivate },
      })
  );
  capture(
    () =>
      new HandshakeState({
        pattern: 'X',
        initiator: true,
        prologue: Buffer.alloc(0),
        s: identity.e2eKeyPair,
        rs: Buffer.alloc(32),
      })
  );
  // A handshake that fails after the private key has been used in a key agreement.
  capture(() => {
    const handshake = new HandshakeState({
      pattern: 'X',
      initiator: false,
      prologue: Buffer.alloc(0),
      s: identity.e2eKeyPair,
    });
    handshake.readMessage(Buffer.alloc(100, 9));
  });
  assert.equal(errors.length, 12);
  for (const err of errors) {
    assertNoSecrets(`${err.message}\n${err.stack}\n${inspect(err, { depth: null, showHidden: true })}`, secrets, err.message);
  }
});

test('the reference helpers in this file agree with the module on public data', () => {
  // Guards the guards: if referenceSign() or referencePublic() were wrong, the
  // known-answer tests above would be comparing against garbage.
  assert.deepEqual(referencePublic(SECRET.signSeed), KNOWN.signPublic);
  assert.equal(
    referenceSign(SECRET.signSeed, Buffer.alloc(0)).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
  );
});
