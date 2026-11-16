import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

import {
  BEACON_MAX_BYTES,
  authenticateBeacon,
  encodeBeacon,
  parseBeacon,
} from '../../src/core/discovery/beacon.js';
import { deriveBeaconKey } from '../../src/core/crypto/envelope.js';
import { Identity } from '../../src/core/crypto/identity.js';

// ---------------------------------------------------------------------------------------
// The beacon format is checked against an independent construction: node:crypto and a
// plain key-sorted JSON.stringify (valid canonical JSON for the strings and integers a
// beacon holds), nothing from core/crypto or core/wire.
// ---------------------------------------------------------------------------------------

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(publicKey, message, signature) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  return verify(null, message, key, signature);
}

const without = (record, ...names) => Object.fromEntries(Object.entries(record).filter(([k]) => !names.includes(k)));

const NOW = 1_700_000_000_000;
const alice = Identity.generate();
const networkKey = randomBytes(32);
const beaconKey = deriveBeaconKey(networkKey);

const make = (overrides = {}) =>
  encodeBeacon({ identity: alice, networkId: 'testnet', port: 47470, ts: NOW, beaconKey: null, ...overrides });

test('an open-network beacon is canonical JSON with the documented fields and signature', () => {
  const bytes = make();
  assert.ok(bytes.length < BEACON_MAX_BYTES);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(record), ['card', 'net', 'origin', 'port', 'sig', 'ts', 'type'], 'keys are sorted');
  assert.deepEqual(record.card, alice.card);
  assert.equal(record.net, 'testnet');
  assert.equal(record.origin, alice.nodeId);
  assert.equal(record.port, 47470);
  assert.equal(record.ts, NOW);
  assert.equal(record.type, 'beacon');
  assert.equal(bytes.toString('utf8'), sortedJson(record), 'the datagram is the canonical form of the record');

  // Ed25519 over utf8("clawnet/1/record/beacon") || 0x00 || canonical(record without sig).
  const message = Buffer.concat([
    Buffer.from('clawnet/1/record/beacon', 'utf8'),
    Buffer.from([0]),
    Buffer.from(sortedJson(without(record, 'sig')), 'utf8'),
  ]);
  assert.equal(ed25519Verify(alice.signPublicKey, message, Buffer.from(record.sig, 'base64')), true);
});

test('a private-network beacon carries a MAC over the record without mac and sig, and a signature over the record with it', () => {
  const bytes = make({ beaconKey });
  const record = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(record), ['card', 'mac', 'net', 'origin', 'port', 'sig', 'ts', 'type']);
  assert.equal(bytes.toString('utf8'), sortedJson(record));

  const independentKey = Buffer.from(hkdfSync('sha256', networkKey, Buffer.alloc(0), 'clawnet/1/beacon', 32));
  assert.deepEqual(independentKey, Buffer.from(beaconKey));
  const macInput = Buffer.from(sortedJson(without(record, 'mac', 'sig')), 'utf8');
  const expectedMac = createHmac('sha256', independentKey).update(macInput).digest();
  assert.equal(Buffer.from(record.mac, 'base64').equals(expectedMac), true);
  assert.equal(Buffer.from(record.mac, 'base64').length, 32);

  const signed = Buffer.concat([
    Buffer.from('clawnet/1/record/beacon', 'utf8'),
    Buffer.from([0]),
    Buffer.from(sortedJson(without(record, 'sig')), 'utf8'),
  ]);
  assert.equal(ed25519Verify(alice.signPublicKey, signed, Buffer.from(record.sig, 'base64')), true);
  // The signature covers the mac: the same signature does not verify the record without it.
  const unsigned = Buffer.concat([
    Buffer.from('clawnet/1/record/beacon', 'utf8'),
    Buffer.from([0]),
    Buffer.from(sortedJson(without(record, 'sig', 'mac')), 'utf8'),
  ]);
  assert.equal(ed25519Verify(alice.signPublicKey, unsigned, Buffer.from(record.sig, 'base64')), false);
});

test('a well-formed beacon parses and authenticates, with and without a network key', () => {
  for (const key of [null, beaconKey]) {
    const parsed = parseBeacon(make({ beaconKey: key }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.beacon.origin, alice.nodeId);
    assert.deepEqual(authenticateBeacon(parsed.beacon, key), { ok: true });
  }
});

test('parseBeacon refuses what is not exactly a canonical beacon', () => {
  const good = JSON.parse(make().toString('utf8'));
  const reasons = (value, expected, label) => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    assert.deepEqual(parseBeacon(bytes), { ok: false, reason: expected }, label);
  };
  reasons(Buffer.alloc(BEACON_MAX_BYTES + 1, 0x20), 'oversize', 'oversize');
  reasons('', 'not-canonical', 'empty');
  reasons('not json', 'not-canonical', 'garbage');
  reasons(JSON.stringify(good, null, 2), 'not-canonical', 'whitespace');
  reasons(JSON.stringify({ type: good.type, ...without(good, 'type') }), 'not-canonical', 'keys out of order');
  reasons('{"a":1.5}', 'not-canonical', 'a float');
  assert.deepEqual(parseBeacon('a string'), { ok: false, reason: 'not-canonical' });
  assert.deepEqual(parseBeacon(null), { ok: false, reason: 'not-canonical' });

  const shaped = changes => sortedJson({ ...good, ...changes });
  reasons(sortedJson(without(good, 'port')), 'bad-shape', 'no port');
  reasons(shaped({ port: 0 }), 'bad-shape', 'port 0');
  reasons(shaped({ port: 65536 }), 'bad-shape', 'port too large');
  reasons(shaped({ net: 'bad net!' }), 'bad-shape', 'bad network id');
  reasons(shaped({ type: 'peer' }), 'bad-shape', 'wrong type');
  reasons(shaped({ extra: 1 }), 'bad-shape', 'extra field');
  reasons(shaped({ mac: 'AAAA' }), 'bad-shape', 'short mac');
  reasons(shaped({ ts: -1 }), 'bad-shape', 'negative ts');
  const other = Identity.generate();
  reasons(shaped({ card: other.card }), 'bad-shape', 'card of another node');
  reasons('[]', 'bad-shape', 'not an object');
});

test('on a keyed network the MAC is checked before any public-key work', () => {
  const outsider = Identity.generate();
  // A beacon that is valid in every way except that its sender does not know the key.
  const forged = parseBeacon(
    encodeBeacon({ identity: outsider, networkId: 'testnet', port: 1, ts: NOW, beaconKey: null }),
  ).beacon;
  assert.deepEqual(authenticateBeacon(forged, beaconKey), { ok: false, reason: 'no-mac' });

  // With a MAC under the wrong key, and a signature that is also wrong, the verdict is
  // the MAC's: the signature was never looked at.
  const wrongKey = deriveBeaconKey(randomBytes(32));
  const wrongMac = parseBeacon(
    encodeBeacon({ identity: outsider, networkId: 'testnet', port: 1, ts: NOW, beaconKey: wrongKey }),
  ).beacon;
  assert.deepEqual(authenticateBeacon(wrongMac, beaconKey), { ok: false, reason: 'bad-mac' });
  assert.deepEqual(authenticateBeacon({ ...wrongMac, sig: 'A'.repeat(86) + '==' }, beaconKey), { ok: false, reason: 'bad-mac' });

  // The right key but a broken signature is the signature's verdict.
  const good = parseBeacon(make({ beaconKey })).beacon;
  const badSig = { ...good, sig: Buffer.alloc(64, 7).toString('base64') };
  assert.deepEqual(authenticateBeacon(badSig, beaconKey), { ok: false, reason: 'bad-signature' });
});

test('every covered field is bound by the MAC and the signature', () => {
  const good = parseBeacon(make({ beaconKey })).beacon;
  for (const changes of [{ ts: NOW + 1 }, { port: 47471 }, { net: 'othernet' }]) {
    assert.deepEqual(authenticateBeacon({ ...good, ...changes }, beaconKey), { ok: false, reason: 'bad-mac' }, JSON.stringify(changes));
  }
  // Someone who can sign as the node but does not know the key still cannot make a MAC.
  const reMac = { ...good, mac: Buffer.alloc(32, 1).toString('base64') };
  assert.deepEqual(authenticateBeacon(reMac, beaconKey), { ok: false, reason: 'bad-mac' });
  // And on an open network the same fields are bound by the signature alone.
  const open = parseBeacon(make()).beacon;
  for (const changes of [{ ts: NOW + 1 }, { port: 47471 }, { net: 'othernet' }]) {
    assert.deepEqual(authenticateBeacon({ ...open, ...changes }, null), { ok: false, reason: 'bad-signature' }, JSON.stringify(changes));
  }
});

test('a beacon with a MAC is refused on a network without a key', () => {
  const keyed = parseBeacon(make({ beaconKey })).beacon;
  assert.deepEqual(authenticateBeacon(keyed, null), { ok: false, reason: 'unexpected-mac' });
});

test('a beacon whose card does not verify is refused although the beacon is signed', () => {
  // The identity signs a beacon that carries a card with a damaged binding signature.
  const damaged = { ...alice.card, sig: Buffer.alloc(64, 9).toString('base64') };
  const fake = { ...alice, card: damaged, nodeId: alice.nodeId, signRecord: (type, fields) => alice.signRecord(type, fields) };
  const bytes = encodeBeacon({ identity: fake, networkId: 'testnet', port: 5, ts: NOW, beaconKey: null });
  const parsed = parseBeacon(bytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(authenticateBeacon(parsed.beacon, null), { ok: false, reason: 'bad-card' });
});

test('encodeBeacon refuses to build a beacon that would not fit a datagram', () => {
  assert.throws(() => make({ networkId: 'n'.repeat(2000) }), err => err instanceof Error);
});
