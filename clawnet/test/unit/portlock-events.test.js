/**
 * PortLock security events: the proof that PortLock (Python) and ClawNet (JavaScript)
 * reach the same verdict on the same bytes. `test/vectors/portlock-security-events.json`
 * is a copy of PortLock's own vector file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

import {
  SECURITY_EVENT_DOMAIN,
  SecurityEventReason,
  securityEventSigningInput,
  verifySecurityEvent,
} from '../../src/integrations/portlock-events.js';
import { ed25519PublicFromPrivate, ed25519Sign } from '../../src/core/crypto/primitives.js';
import { canonicalBytes } from '../../src/core/wire/canonical.js';
import { ConfigError } from '../../src/core/errors.js';

const vectors = JSON.parse(readFileSync(new URL('../vectors/portlock-security-events.json', import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

test('the vector file is the one this suite was written against', () => {
  assert.equal(vectors.envelope_version, 1);
  assert.equal(vectors.valid.length, 3);
  assert.equal(vectors.invalid.length, 26);
  assert.equal(vectors.signing.domain_utf8, SECURITY_EVENT_DOMAIN);
});

test('every valid vector verifies, and ClawNet reproduces its canonical bytes, signing input and signature', () => {
  for (const vector of vectors.valid) {
    const result = verifySecurityEvent(vector.event);
    assert.deepEqual(result, { ok: true, reason: null, key: vector.public_key_b64 }, vector.name);

    // Steps 1 to 4 of the vector file's checklist.
    const { sig, ...unsigned } = vector.event;
    assert.equal(canonicalBytes(unsigned).toString('base64'), vector.canonical_b64, vector.name);
    assert.equal(canonicalBytes(unsigned).toString('utf8'), vector.canonical_utf8, vector.name);
    const input = securityEventSigningInput(vector.event);
    assert.equal(input.toString('base64'), vector.signing_input_b64, vector.name);
    assert.equal(input.subarray(0, 26).toString('hex'), vectors.signing.prefix_hex);
    assert.equal(sha256(input).toString('hex'), vector.signing_input_sha256, vector.name);
    assert.equal(sig.key, vector.public_key_b64);
    assert.equal(sig.value, vector.signature_b64);

    // Step 6: Ed25519 is deterministic, so signing the same bytes gives the same signature.
    const seed = Buffer.from(vector.seed_hex, 'hex');
    assert.equal(ed25519PublicFromPrivate(seed).toString('hex'), vector.public_key_hex, vector.name);
    assert.equal(ed25519Sign(seed, input).toString('hex'), vector.signature_hex, vector.name);
  }
});

test('every invalid vector is rejected, for the reason PortLock gives', () => {
  for (const vector of vectors.invalid) {
    const result = verifySecurityEvent(vector.event);
    assert.equal(result.ok, false, vector.name);
    assert.equal(result.reason, vector.expect, vector.name);
  }
});

test('the verdict does not depend on key order or on a deep copy of the event', () => {
  for (const vector of vectors.valid) {
    const reversed = Object.fromEntries(Object.entries(clone(vector.event)).reverse());
    assert.equal(verifySecurityEvent(reversed).ok, true, vector.name);
  }
});

test('tampered copies: changing any signed member of any valid event is rejected', () => {
  const changers = [
    (value) => (typeof value === 'string' ? `${value}x` : value),
    (value) => (Number.isInteger(value) ? value + 1 : value),
    (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value, extra: 1 } : value),
  ];
  let attempts = 0;
  for (const vector of vectors.valid) {
    for (const member of Object.keys(vector.event)) {
      if (member === 'sig') continue;
      for (const change of changers) {
        const event = clone(vector.event);
        const changed = change(event[member]);
        if (JSON.stringify(changed) === JSON.stringify(event[member])) continue;
        event[member] = changed;
        attempts += 1;
        assert.equal(verifySecurityEvent(event).ok, false, `${vector.name}: ${member}`);
      }
    }
  }
  assert.ok(attempts >= 20, `only ${attempts} tampered copies were tried`);
});

test('tampered copies: every single-bit change to the signature or the key fails', () => {
  for (const vector of vectors.valid) {
    const signature = Buffer.from(vector.event.sig.value, 'base64');
    for (let byte = 0; byte < signature.length; byte += 1) {
      for (const bit of [0, 7]) {
        const flipped = Buffer.from(signature);
        flipped[byte] ^= 1 << bit;
        const event = clone(vector.event);
        event.sig.value = flipped.toString('base64');
        assert.equal(verifySecurityEvent(event).ok, false, `${vector.name}: signature byte ${byte} bit ${bit}`);
      }
    }
    const key = Buffer.from(vector.event.sig.key, 'base64');
    for (let byte = 0; byte < key.length; byte += 1) {
      const flipped = Buffer.from(key);
      flipped[byte] ^= 1;
      const event = clone(vector.event);
      event.sig.key = flipped.toString('base64');
      assert.equal(verifySecurityEvent(event).ok, false, `${vector.name}: key byte ${byte}`);
    }
  }
});

test('tampered copies: a signature moved to another event, and a key swapped for another valid one, fail', () => {
  const [first, second] = vectors.valid;
  const moved = clone(second.event);
  moved.sig = clone(first.event.sig);
  assert.deepEqual(verifySecurityEvent(moved), { ok: false, reason: 'signature_mismatch' });
  const rekeyed = clone(first.event);
  rekeyed.sig.key = second.event.sig.key;
  assert.deepEqual(verifySecurityEvent(rekeyed), { ok: false, reason: 'signature_mismatch' });
});

test('every member is required, and no member may be added anywhere in the envelope', () => {
  const base = vectors.valid[0].event;
  for (const member of Object.keys(base)) {
    const event = clone(base);
    delete event[member];
    const expected = member === 'sig' ? SecurityEventReason.NOT_SIGNED : SecurityEventReason.MALFORMED;
    assert.deepEqual(verifySecurityEvent(event), { ok: false, reason: expected }, `missing ${member}`);
  }
  for (const path of [[], ['source'], ['sig']]) {
    const event = clone(base);
    const holder = path.reduce((object, key) => object[key], event);
    holder.unexpected = 1;
    assert.equal(verifySecurityEvent(event).reason, SecurityEventReason.MALFORMED, `extra member under ${path.join('.') || 'event'}`);
  }
  const chained = clone(vectors.valid[1].event);
  chained.chain.extra = 0;
  assert.equal(verifySecurityEvent(chained).reason, SecurityEventReason.MALFORMED);
});

test('member types and ranges are enforced (step 2)', () => {
  const base = vectors.valid[1].event;
  const cases = {
    'v is a string': (e) => { e.v = '1'; },
    'v is 2': (e) => { e.v = 2; },
    'id too short': (e) => { e.id = e.id.slice(1); },
    'id not hex': (e) => { e.id = 'g'.repeat(32); },
    'ts negative': (e) => { e.ts = -1; },
    'ts a float': (e) => { e.ts = 1.5; },
    'ts above 2^53-1': (e) => { e.ts = 2 ** 53; },
    'source not an object': (e) => { e.source = 'portlock'; },
    'product is another product': (e) => { e.source.product = 'other'; },
    'version empty': (e) => { e.source.version = ''; },
    'version with a control character': (e) => { e.source.version = '0.2\n0'; },
    'version too long': (e) => { e.source.version = 'v'.repeat(65); },
    'host empty': (e) => { e.source.host = ''; },
    'host too long': (e) => { e.source.host = 'h'.repeat(256); },
    'host with NUL': (e) => { e.source.host = 'lab\u0000'; },
    'type without a dot': (e) => { e.type = 'service'; },
    'type in upper case': (e) => { e.type = 'Device.connected'; },
    'type too long': (e) => { e.type = `a.${'b'.repeat(63)}`; },
    'severity unknown': (e) => { e.severity = 'fatal'; },
    'subject an array': (e) => { e.subject = []; },
    'data null': (e) => { e.data = null; },
    'chain a string': (e) => { e.chain = 'x'; },
    'chain seq negative': (e) => { e.chain.seq = -1; },
    'chain hash upper case': (e) => { e.chain.hash = e.chain.hash.toUpperCase(); },
    'chain hash short': (e) => { e.chain.hash = e.chain.hash.slice(2); },
    'sig an array': (e) => { e.sig = []; },
    'sig.alg other': (e) => { e.sig.alg = 'ed448'; },
    'sig.key a number': (e) => { e.sig.key = 7; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const event = clone(base);
    mutate(event);
    const result = verifySecurityEvent(event);
    assert.deepEqual(result, { ok: false, reason: SecurityEventReason.MALFORMED }, name);
  }
});

test('events that cannot be canonicalised are malformed, never an exception', () => {
  const base = vectors.valid[0].event;
  const nested = (depth) => {
    let value = {};
    for (let i = 0; i < depth; i += 1) value = { a: value };
    return value;
  };
  const cases = {
    'nesting of 40 levels': (e) => { e.data = nested(40); },
    'a non-ASCII object key': (e) => { e.data = { [`schl${String.fromCodePoint(0xfc)}ssel`]: 1 }; },
    'a float in data': (e) => { e.data = { x: 0.5 }; },
    'an unsafe integer in data': (e) => { e.data = { x: 2 ** 53 }; },
    'a lone surrogate in data': (e) => { e.data = { x: '\ud800' }; },
    'undefined in data': (e) => { e.data = { x: undefined }; },
    'a function in data': (e) => { e.data = { x: () => 1 }; },
    'a __proto__ key': (e) => { e.data = JSON.parse('{"__proto__": 1}'); },
    'more than 256 KiB': (e) => { e.data = { blob: 'x'.repeat(262144) }; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const event = clone(base);
    mutate(event);
    assert.deepEqual(verifySecurityEvent(event), { ok: false, reason: SecurityEventReason.MALFORMED }, name);
  }
});

test('anything that is not an event object is not signed; nothing throws', () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); }, has() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  for (const value of [undefined, null, 0, 'text', true, [], [vectors.valid[0].event], () => 1, Buffer.alloc(4), new Map()]) {
    assert.deepEqual(verifySecurityEvent(value), { ok: false, reason: SecurityEventReason.NOT_SIGNED });
  }
  assert.equal(verifySecurityEvent(hostile).ok, false);
});

test('public keys of small order and non-canonical y are refused before any signature is looked at (step 4)', () => {
  const rule = vectors.signing.refused_public_keys;
  const base = vectors.valid[0].event;
  const withKey = (keyBytes) => {
    const event = clone(base);
    event.sig.key = Buffer.from(keyBytes).toString('base64');
    return event;
  };
  for (const hex of rule.small_order_y_hex) {
    const y = Buffer.from(hex, 'hex');
    assert.equal(verifySecurityEvent(withKey(y)).reason, SecurityEventReason.WEAK_KEY, hex);
    // The sign of x is the top bit; a point and its negative are both of small order.
    const negative = Buffer.from(y);
    negative[31] |= 0x80;
    assert.equal(verifySecurityEvent(withKey(negative)).reason, SecurityEventReason.WEAK_KEY, `${hex} with the sign bit`);
  }
  // y >= p is a second spelling of another point; so is y + p for the two smallest y.
  const prime = Buffer.from(rule.field_prime_hex_le, 'hex');
  assert.equal(verifySecurityEvent(withKey(prime)).reason, SecurityEventReason.BAD_KEY_ENCODING);
  const allOnes = Buffer.alloc(32, 0xff);
  assert.equal(verifySecurityEvent(withKey(allOnes)).reason, SecurityEventReason.BAD_KEY_ENCODING);
  const aboveIdentity = Buffer.from(prime);
  aboveIdentity[0] += 1;
  assert.equal(verifySecurityEvent(withKey(aboveIdentity)).reason, SecurityEventReason.BAD_KEY_ENCODING);
});

test('base64 must be the one canonical spelling, and the key is judged before the signature', () => {
  const base = vectors.valid[0].event;
  const lax = {
    'key with a newline': (e) => { e.sig.key = `${e.sig.key}\n`; },
    'key without padding': (e) => { e.sig.key = e.sig.key.replace(/=+$/, ''); },
    'key in the URL-safe alphabet': (e) => { e.sig.key = e.sig.key.replaceAll('+', '-').replaceAll('/', '_') + 'x'; },
    'key of 33 bytes': (e) => { e.sig.key = Buffer.alloc(33, 1).toString('base64'); },
    'key empty': (e) => { e.sig.key = ''; },
  };
  for (const [name, mutate] of Object.entries(lax)) {
    const event = clone(base);
    mutate(event);
    assert.equal(verifySecurityEvent(event).reason, SecurityEventReason.BAD_KEY_ENCODING, name);
  }
  const sigLax = {
    'signature with a newline': (e) => { e.sig.value = `${e.sig.value}\n`; },
    'signature of 65 bytes': (e) => { e.sig.value = Buffer.alloc(65, 1).toString('base64'); },
    'signature empty': (e) => { e.sig.value = ''; },
  };
  for (const [name, mutate] of Object.entries(sigLax)) {
    const event = clone(base);
    mutate(event);
    assert.equal(verifySecurityEvent(event).reason, SecurityEventReason.BAD_SIGNATURE_ENCODING, name);
  }
  const both = clone(base);
  both.sig.key = '!!';
  both.sig.value = '!!';
  assert.equal(verifySecurityEvent(both).reason, SecurityEventReason.BAD_KEY_ENCODING);
});

test('a signature scalar not below the group order is refused (S + L), on every valid event', () => {
  const groupOrder = 2n ** 252n + 27742317777372353535851937790883648493n;
  for (const vector of vectors.valid) {
    const signature = Buffer.from(vector.event.sig.value, 'base64');
    let s = 0n;
    for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(signature[i]);
    const bumped = s + groupOrder;
    assert.ok(bumped < 2n ** 256n);
    const malleable = Buffer.from(signature);
    for (let i = 0; i < 32; i += 1) malleable[32 + i] = Number((bumped >> BigInt(8 * i)) & 0xffn);
    const event = clone(vector.event);
    event.sig.value = malleable.toString('base64');
    assert.deepEqual(verifySecurityEvent(event), { ok: false, reason: SecurityEventReason.SIGNATURE_MISMATCH }, vector.name);
  }
});

test('trusted keys: an enrolled key passes, any other valid signer is untrusted, and a malformed list is a ConfigError', () => {
  const [first, second] = vectors.valid;
  assert.equal(verifySecurityEvent(first.event, { trustedKeys: [first.public_key_b64] }).ok, true);
  assert.equal(verifySecurityEvent(first.event, { trustedKeys: [Buffer.from(first.public_key_hex, 'hex')] }).ok, true);
  assert.equal(verifySecurityEvent(first.event, { trustedKeys: new Set([second.public_key_b64, first.public_key_b64]) }).ok, true);
  assert.deepEqual(verifySecurityEvent(first.event, { trustedKeys: [second.public_key_b64] }), { ok: false, reason: 'untrusted_key' });
  assert.deepEqual(verifySecurityEvent(first.event, { trustedKeys: [] }), { ok: false, reason: 'untrusted_key' });
  assert.throws(() => verifySecurityEvent(first.event, { trustedKeys: ['not base64!'] }), ConfigError);
  assert.throws(() => verifySecurityEvent(first.event, { trustedKeys: [Buffer.alloc(31)] }), ConfigError);
  // An event that is broken for another reason is reported as that, trusted key or not.
  const broken = clone(first.event);
  broken.data = { changed: 1 };
  assert.equal(verifySecurityEvent(broken, { trustedKeys: [first.public_key_b64] }).reason, 'signature_mismatch');
});

test('the audit chain a signed event points into is reproduced with ClawNet canonical JSON', () => {
  const chain = vectors.audit_chain;
  let previous = Buffer.from(chain.genesis_hash, 'hex');
  assert.equal(sha256(Buffer.from('portlock-audit-v1')).toString('hex'), chain.genesis_hash);
  let macKey = Buffer.from(chain.initial_key_hex, 'hex');
  let head = null;
  for (const entry of chain.records) {
    const { record } = entry;
    const body = {
      seq: record.seq,
      ts: record.ts,
      event_type: record.event_type,
      severity: record.severity,
      actor: record.actor,
      device_fp: record.device_fp,
      data: record.data,
    };
    const hashed = canonicalBytes(body);
    assert.equal(hashed.toString('utf8'), entry.hashed_body_utf8, `record ${record.seq}`);
    assert.equal(previous.toString('hex'), record.prev_hash, `record ${record.seq}`);
    const hash = sha256(previous, hashed);
    assert.equal(hash.toString('hex'), record.hash, `record ${record.seq}`);
    macKey = sha256(Buffer.from(chain.ratchet_domain), macKey);
    assert.equal(macKey.toString('hex'), entry.mac_key_hex, `record ${record.seq}`);
    assert.equal(createHmac('sha256', macKey).update(hash).digest('hex'), record.mac, `record ${record.seq}`);
    previous = hash;
    head = { seq: record.seq, hash: record.hash };
  }
  // The third valid vector is the signed event for the third record: its checkpoint is
  // the head of the log and its id is derived from the host label and that hash.
  const event = vectors.valid[1].event;
  assert.deepEqual(event.chain, head);
  assert.equal(verifySecurityEvent(event).ok, true);
  const id = sha256(Buffer.from('portlock/1/event-id'), Buffer.from([0]), Buffer.from(event.source.host), Buffer.from([0]), Buffer.from(head.hash, 'hex'));
  assert.equal(id.subarray(0, 16).toString('hex'), event.id);
});
