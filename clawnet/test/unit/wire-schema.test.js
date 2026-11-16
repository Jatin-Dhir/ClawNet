import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCard,
  validateCaps,
  validateAddress,
  parseAddress,
  formatAddress,
  validateHandshakePayload,
  validateDataHeader,
  validateProbeHeader,
  validateLsa,
  validatePeerRecord,
  validateCast,
  validateBeacon,
  validateReceipt,
  validateRecord,
  validatePingHeader,
  validatePongHeader,
  validateByeHeader,
  validateMeta,
  MetaKind,
  isNodeId,
  isNetworkId,
  isIpLiteral,
  isDnsName,
  isBase64Bytes,
  MAX_ADDRESS_LENGTH,
} from '../../src/core/wire/schema.js';
import { WireError } from '../../src/core/errors.js';
import { Limits } from '../../src/core/wire/types.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, unpadded: the NodeId encoding. */
function base32(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** A deterministic, well-formed NodeId. Different seeds give different ids. */
function nodeId(seed) {
  return base32(Buffer.alloc(32, seed));
}

const b64 = (length, fill = 7) => Buffer.alloc(length, fill).toString('base64');

const A = nodeId(1);
const B = nodeId(2);
const C = nodeId(255);
const MSG_ID = '00112233445566778899aabbccddeeff';
const SIG = b64(64);

const card = (id = A) => ({ id, link: b64(32, 1), e2e: b64(32, 2), sig: SIG });
const caps = () => ({ relay: true, mailbox: false, transit: true });

const handshake = () => ({
  v: 1,
  card: card(),
  net: 'clawnet-main',
  agent: 'clawnet/0.1.0 (node)',
  caps: caps(),
  listen: ['tcp://192.0.2.1:47470', 'tcp://[2001:db8::1]:47470'],
  observed: '198.51.100.7',
  ts: 1763251200000,
});
const dataHeader = () => ({ id: MSG_ID, dst: B, ttl: 16, try: 0 });
const probeHeader = () => ({ id: MSG_ID, dst: B, ttl: 16, rsvp: A, n: 16 });
const lsa = () => ({
  type: 'lsa',
  origin: A,
  seq: 1763251200000,
  ts: 1763251200000,
  links: [
    { peer: B, cost: 12 },
    { peer: C, cost: 65535 },
  ],
  caps: caps(),
  sig: SIG,
});
const peerRecord = () => ({
  type: 'peer',
  origin: A,
  seq: 5,
  ts: 0,
  addrs: ['tcp://node.example.org:47470'],
  caps: caps(),
  card: card(A),
  sig: SIG,
});
const plainCast = () => ({
  type: 'cast',
  origin: A,
  chan: 'ffeeddccbbaa99887766554433221100',
  n: 1,
  ts: 1763251200000,
  enc: false,
  body: Buffer.from('hello').toString('base64'),
  sig: SIG,
});
const sealedCast = () => ({ ...plainCast(), enc: true, salt: b64(32, 9), body: b64(16 + 5) });
const beacon = () => ({
  type: 'beacon',
  origin: A,
  ts: 1763251200000,
  port: 47470,
  net: 'clawnet-main',
  card: card(A),
  sig: SIG,
});
const receipt = () => ({ type: 'receipt', origin: A, id: MSG_ID, ts: 1763251200000, sig: SIG });
const NONCE = '0123456789abcdef';
const msgMeta = () => ({ kind: 'msg', card: card(A), ts: 1763251200000, hs: SIG, ack: true });
const ackMeta = () => ({ kind: 'ack', card: card(B), ts: 1763251200000, hs: SIG, id: MSG_ID });
const otherMeta = () => ({
  kind: 'file-offer',
  card: card(A),
  ts: 1763251200000,
  hs: SIG,
  ack: true,
  tid: MSG_ID,
  files: [{ name: 'a.txt', size: 5 }],
  opts: { deep: { x: [1, 'two', null, false] } },
});

const OK = { ok: true };
const bad = (reason) => ({ ok: false, reason });

/** Return a copy of `value` with `edit` applied, so fixtures are never shared. */
function mutate(make, edit) {
  const value = make();
  edit(value);
  return value;
}

/** Values no validator may accept in place of an object. */
const NON_OBJECTS = [undefined, null, true, 0, 1, 'x', [], [1], () => {}, Symbol('s'), 10n, new Map(), new Date(0), Buffer.alloc(2)];

test('the test fixtures themselves are well-formed', () => {
  assert.equal(A.length, 52);
  assert.match(A, /^[a-z2-7]{52}$/);
  assert.notEqual(A, B);
  // Known vector: 32 zero bytes are 52 "a" characters.
  assert.equal(base32(Buffer.alloc(32)), 'a'.repeat(52));
});

test('isNodeId accepts canonical ids and rejects everything else', () => {
  assert.equal(isNodeId('a'.repeat(52)), true);
  assert.equal(isNodeId(base32(Buffer.alloc(32, 0xff))), true);
  for (let seed = 0; seed < 256; seed += 1) assert.equal(isNodeId(nodeId(seed)), true, `seed ${seed}`);

  const rejected = [
    'a'.repeat(51),
    'a'.repeat(53),
    '',
    'A'.repeat(52),
    `${'a'.repeat(51)}1`,
    `${'a'.repeat(51)}=`,
    `${'a'.repeat(50)} a`,
    `${'a'.repeat(52)}\n`,
    undefined,
    null,
    52,
    ['a'.repeat(52)],
  ];
  for (const value of rejected) assert.equal(isNodeId(value), false, String(value));
});

test('isNodeId rejects the non-canonical spellings of a key', () => {
  // The last character carries one key bit and four padding bits that must be zero,
  // so of the 32 possible last characters only "a" and "q" are valid.
  const stem = 'a'.repeat(51);
  const accepted = [...BASE32].filter((ch) => isNodeId(stem + ch));
  assert.deepEqual(accepted, ['a', 'q']);
  assert.deepEqual(validateDataHeader({ ...dataHeader(), dst: `${stem}b` }), bad('data.dst: bad format'));
});

test('isBase64Bytes is strict about alphabet, padding, length and stray bits', () => {
  assert.equal(isBase64Bytes(b64(32), 32), true);
  assert.equal(isBase64Bytes(b64(64), 64), true);
  assert.equal(isBase64Bytes('', 0), true);
  assert.equal(isBase64Bytes('QQ==', 1), true);

  assert.equal(isBase64Bytes(b64(31), 32), false, 'too few bytes');
  assert.equal(isBase64Bytes(b64(33), 32), false, 'too many bytes');
  assert.equal(isBase64Bytes(b64(32).slice(0, -1), 32), false, 'missing padding');
  assert.equal(isBase64Bytes(`${b64(32).slice(0, -1)} `, 32), false, 'space');
  assert.equal(isBase64Bytes(b64(32, 0xff).replaceAll('/', '_'), 32), false, 'url-safe alphabet');
  assert.equal(isBase64Bytes(Buffer.alloc(32, 0xfb).toString('base64url').padEnd(44, '='), 32), false);
  // "QR==" decodes to the same byte as "QQ==" in a lenient decoder: stray bits set.
  assert.equal(isBase64Bytes('QR==', 1), false, 'non-zero trailing bits');
  assert.equal(isBase64Bytes('Q===', 1), false);
  assert.equal(isBase64Bytes('=QQ=', 1), false);
  assert.equal(isBase64Bytes(Buffer.alloc(32), 32), false, 'not a string');
  assert.equal(isBase64Bytes(null, 0), false);
});

test('validateCard accepts a well-formed card', () => {
  assert.deepEqual(validateCard(card()), OK);
});

test('validateCard rejects malformed cards with a stable reason', () => {
  const cases = [
    [mutate(card, (c) => delete c.id), 'card.id: missing'],
    [mutate(card, (c) => delete c.link), 'card.link: missing'],
    [mutate(card, (c) => delete c.e2e), 'card.e2e: missing'],
    [mutate(card, (c) => delete c.sig), 'card.sig: missing'],
    [mutate(card, (c) => (c.id = 7)), 'card.id: not a string'],
    [mutate(card, (c) => (c.id = 'A'.repeat(52))), 'card.id: bad format'],
    [mutate(card, (c) => (c.link = b64(31))), 'card.link: wrong length'],
    [mutate(card, (c) => (c.link = b64(33))), 'card.link: wrong length'],
    [mutate(card, (c) => (c.e2e = b64(64))), 'card.e2e: wrong length'],
    [mutate(card, (c) => (c.e2e = b64(30))), 'card.e2e: wrong length'],
    [mutate(card, (c) => (c.e2e = '')), 'card.e2e: wrong length'],
    [mutate(card, (c) => (c.e2e = `${'A'.repeat(42)}B=`)), 'card.e2e: bad base64'],
    [mutate(card, (c) => (c.e2e = `${'A'.repeat(43)}*`)), 'card.e2e: bad base64'],
    [mutate(card, (c) => (c.e2e = Buffer.alloc(32))), 'card.e2e: not a string'],
    [mutate(card, (c) => (c.sig = b64(32))), 'card.sig: wrong length'],
    [mutate(card, (c) => (c.sig = `${'A'.repeat(85)}B==`)), 'card.sig: bad base64'],
    [mutate(card, (c) => (c.extra = 1)), 'card.extra: unknown field'],
    [mutate(card, (c) => (c.name = 'mallory')), 'card.name: unknown field'],
  ];
  for (const [value, reason] of cases) assert.deepEqual(validateCard(value), bad(reason), reason);
  for (const value of NON_OBJECTS) assert.deepEqual(validateCard(value), bad('card: not an object'));
});

test('validateCaps requires exactly three booleans', () => {
  assert.deepEqual(validateCaps(caps()), OK);
  assert.deepEqual(validateCaps({ relay: false, mailbox: false, transit: false }), OK);
  assert.deepEqual(validateCaps({ relay: true, mailbox: false }), bad('caps.transit: missing'));
  assert.deepEqual(validateCaps({ ...caps(), relay: 1 }), bad('caps.relay: not a boolean'));
  assert.deepEqual(validateCaps({ ...caps(), mailbox: 'false' }), bad('caps.mailbox: not a boolean'));
  assert.deepEqual(validateCaps({ ...caps(), transit: null }), bad('caps.transit: not a boolean'));
  assert.deepEqual(validateCaps({ ...caps(), admin: true }), bad('caps.admin: unknown field'));
  for (const value of NON_OBJECTS) assert.deepEqual(validateCaps(value), bad('caps: not an object'));
});

test('validateAddress accepts IPv4, bracketed IPv6 and DNS hosts', () => {
  const accepted = [
    'tcp://127.0.0.1:1',
    'tcp://192.0.2.1:47470',
    'tcp://255.255.255.255:65535',
    'tcp://[::1]:47470',
    'tcp://[2001:db8::1]:80',
    'tcp://[::ffff:192.0.2.1]:47470',
    'tcp://[FE80::A]:9',
    'tcp://localhost:47470',
    'tcp://node-1.example.org:47470',
    'tcp://EXAMPLE.Org:47470',
    'tcp://a.b.c.d.e:10',
    'tcp://1a.example:10',
    `tcp://${'a'.repeat(63)}.example:10`,
  ];
  for (const address of accepted) assert.deepEqual(validateAddress(address), OK, address);
});

test('validateAddress rejects malformed addresses with a specific reason', () => {
  const cases = [
    ['127.0.0.1:47470', 'address: bad scheme'],
    ['udp://127.0.0.1:47470', 'address: bad scheme'],
    ['TCP://127.0.0.1:47470', 'address: bad scheme'],
    [' tcp://127.0.0.1:47470', 'address: bad scheme'],
    ['tcp:/127.0.0.1:47470', 'address: bad scheme'],
    ['', 'address: bad scheme'],
    ['tcp://127.0.0.1', 'address: bad port'],
    ['tcp://127.0.0.1:', 'address: bad port'],
    ['tcp://127.0.0.1:0', 'address: bad port'],
    ['tcp://127.0.0.1:65536', 'address: bad port'],
    ['tcp://127.0.0.1:99999', 'address: bad port'],
    ['tcp://127.0.0.1:047470', 'address: bad port'],
    ['tcp://127.0.0.1:0x50', 'address: bad port'],
    ['tcp://127.0.0.1:80 ', 'address: bad port'],
    ['tcp://127.0.0.1:+80', 'address: bad port'],
    ['tcp://127.0.0.1:8e1', 'address: bad port'],
    ['tcp://127.0.0.1:80/path', 'address: bad port'],
    ['tcp://[::1]', 'address: bad port'],
    ['tcp://[::1]47470', 'address: bad port'],
    ['tcp://[::1]:', 'address: bad port'],
    ['tcp://:47470', 'address: bad host'],
    ['tcp://256.0.0.1:47470', 'address: bad host'],
    ['tcp://1.2.3:47470', 'address: bad host'],
    ['tcp://127.1:47470', 'address: bad host'],
    ['tcp://2130706433:47470', 'address: bad host'],
    ['tcp://0x7f.0.0.1:47470', 'address: bad host'],
    ['tcp://example.0x7f:47470', 'address: bad host'],
    ['tcp://010.0.0.1:47470', 'address: bad host'],
    ['tcp://::1:47470', 'address: bad host'],
    ['tcp://[::1:47470', 'address: bad host'],
    ['tcp://[127.0.0.1]:47470', 'address: bad host'],
    ['tcp://[fe80::1%eth0]:47470', 'address: bad host'],
    ['tcp://[::g]:47470', 'address: bad host'],
    ['tcp://[]:47470', 'address: bad host'],
    ['tcp://exa_mple.org:47470', 'address: bad host'],
    ['tcp://-example.org:47470', 'address: bad host'],
    ['tcp://example-.org:47470', 'address: bad host'],
    ['tcp://example..org:47470', 'address: bad host'],
    ['tcp://example.org.:47470', 'address: bad host'],
    ['tcp://.example.org:47470', 'address: bad host'],
    ['tcp://user@example.org:47470', 'address: bad host'],
    ['tcp://exam ple.org:47470', 'address: bad host'],
    ['tcp://example.org/x:47470', 'address: bad host'],
    [`tcp://${'a'.repeat(64)}.example:47470`, 'address: bad host'],
    [`tcp://b${String.fromCodePoint(0xfc)}cher.example:47470`, 'address: bad host'],
    [`tcp://example.org${String.fromCodePoint(0)}:47470`, 'address: bad host'],
  ];
  for (const [address, reason] of cases) {
    assert.deepEqual(validateAddress(address), bad(reason), JSON.stringify(address));
    assert.equal(parseAddress(address), null, JSON.stringify(address));
  }
  for (const value of [undefined, null, 5, {}, ['tcp://127.0.0.1:1'], true]) {
    assert.deepEqual(validateAddress(value), bad('address: not a string'));
    assert.equal(parseAddress(value), null);
  }
});

test('validateAddress enforces the DNS name and total length limits', () => {
  const label = 'a'.repeat(63);
  const name253 = `${label}.${label}.${label}.${'b'.repeat(61)}`;
  assert.equal(name253.length, 253);
  assert.deepEqual(validateAddress(`tcp://${name253}:47470`), OK);
  assert.equal(isDnsName(name253), true);

  const name254 = `${label}.${label}.${label}.${'b'.repeat(62)}`;
  assert.equal(name254.length, 254);
  assert.deepEqual(validateAddress(`tcp://${name254}:47470`), bad('address: bad host'));
  assert.equal(isDnsName(name254), false);

  const tooLong = `tcp://${'a.'.repeat(150)}example:1`;
  assert.ok(tooLong.length > MAX_ADDRESS_LENGTH);
  assert.deepEqual(validateAddress(tooLong), bad('address: too long'));
  // A megabyte of junk is rejected on length alone.
  assert.deepEqual(validateAddress(`tcp://${'a'.repeat(1 << 20)}`), bad('address: too long'));
});

test('parseAddress returns the host without brackets and a numeric port', () => {
  assert.deepEqual(parseAddress('tcp://192.0.2.1:47470'), { host: '192.0.2.1', port: 47470 });
  assert.deepEqual(parseAddress('tcp://[2001:db8::1]:1'), { host: '2001:db8::1', port: 1 });
  assert.deepEqual(parseAddress('tcp://Node.Example.org:65535'), { host: 'Node.Example.org', port: 65535 });
});

test('formatAddress is the inverse of parseAddress', () => {
  assert.equal(formatAddress('192.0.2.1', 47470), 'tcp://192.0.2.1:47470');
  assert.equal(formatAddress('2001:db8::1', 47470), 'tcp://[2001:db8::1]:47470');
  assert.equal(formatAddress('::', 1), 'tcp://[::]:1');
  assert.equal(formatAddress('example.org', 65535), 'tcp://example.org:65535');
  for (const address of ['tcp://10.1.2.3:9', 'tcp://[::ffff:10.1.2.3]:9', 'tcp://a-b.example:9']) {
    const { host, port } = parseAddress(address);
    assert.equal(formatAddress(host, port), address);
  }
});

test('formatAddress refuses to build an invalid address', () => {
  const cases = [
    ['192.0.2.1', 0],
    ['192.0.2.1', 65536],
    ['192.0.2.1', 80.5],
    ['192.0.2.1', '80'],
    ['192.0.2.1', NaN],
    ['', 80],
    ['[::1]', 80],
    ['fe80::1%eth0', 80],
    ['exa mple.org', 80],
    ['example.org:80', 80],
    ['1.2.3', 80],
    ['a'.repeat(5000), 80],
    [null, 80],
    [undefined, 80],
    [{ toString: () => '192.0.2.1' }, 80],
  ];
  for (const [host, port] of cases) {
    assert.throws(
      () => formatAddress(host, port),
      (err) => err instanceof WireError && err.code === 'ERR_WIRE',
      `${String(host).slice(0, 20)} ${port}`,
    );
  }
});

test('isIpLiteral, isDnsName and isNetworkId', () => {
  for (const ip of ['0.0.0.0', '127.0.0.1', '::', '::1', '2001:db8::1', '::ffff:1.2.3.4']) {
    assert.equal(isIpLiteral(ip), true, ip);
  }
  for (const value of ['[::1]', 'fe80::1%1', '1.2.3', '1.2.3.4.5', 'localhost', '', ' 1.2.3.4', null, 4]) {
    assert.equal(isIpLiteral(value), false, String(value));
  }
  assert.equal(isDnsName('localhost'), true);
  assert.equal(isDnsName('xn--bcher-kva.example'), true);
  assert.equal(isDnsName('127.0.0.1'), false, 'an IPv4 literal is not a DNS name');
  assert.equal(isDnsName('999'), false);
  assert.equal(isDnsName(''), false);
  assert.equal(isDnsName(undefined), false);

  for (const net of ['clawnet-main', 'a', 'A.b_c-9', 'x'.repeat(64)]) assert.equal(isNetworkId(net), true, net);
  for (const net of ['', 'x'.repeat(65), 'has space', 'slash/', 'new\nline', 'caf' + String.fromCodePoint(0xe9), 5, null]) {
    assert.equal(isNetworkId(net), false, String(net));
  }
});

test('validateHandshakePayload accepts a well-formed payload', () => {
  assert.deepEqual(validateHandshakePayload(handshake()), OK);
  assert.deepEqual(validateHandshakePayload({ ...handshake(), listen: [], observed: null, ts: 0 }), OK);
  assert.deepEqual(validateHandshakePayload({ ...handshake(), observed: '2001:db8::2' }), OK);
  const full = Array.from({ length: Limits.MAX_PEER_ADDRS }, (_, i) => `tcp://10.0.0.${i + 1}:47470`);
  assert.deepEqual(validateHandshakePayload({ ...handshake(), listen: full }), OK);
});

test('validateHandshakePayload rejects every malformed field', () => {
  const tooMany = Array.from({ length: Limits.MAX_PEER_ADDRS + 1 }, (_, i) => `tcp://10.0.0.${i + 1}:47470`);
  const cases = [
    [(p) => delete p.v, 'handshake.v: missing'],
    [(p) => (p.v = 2), 'handshake.v: unsupported version'],
    [(p) => (p.v = 0), 'handshake.v: unsupported version'],
    [(p) => (p.v = '1'), 'handshake.v: not an integer'],
    [(p) => (p.v = 1.5), 'handshake.v: not an integer'],
    [(p) => delete p.card, 'handshake.card: missing'],
    [(p) => (p.card = null), 'handshake.card: not an object'],
    [(p) => (p.card.link = 'short'), 'handshake.card.link: wrong length'],
    [(p) => (p.card.x = 1), 'handshake.card.x: unknown field'],
    [(p) => (p.net = ''), 'handshake.net: bad format'],
    [(p) => (p.net = 'x'.repeat(65)), 'handshake.net: bad format'],
    [(p) => (p.net = 'bad net'), 'handshake.net: bad format'],
    [(p) => (p.net = 9), 'handshake.net: not a string'],
    [(p) => (p.agent = ''), 'handshake.agent: bad format'],
    [(p) => (p.agent = 'x'.repeat(65)), 'handshake.agent: bad format'],
    [(p) => (p.agent = 'tab\there'), 'handshake.agent: bad format'],
    [(p) => (p.agent = 'line\nbreak'), 'handshake.agent: bad format'],
    [(p) => (p.agent = 'del' + String.fromCodePoint(0x7f)), 'handshake.agent: bad format'],
    [(p) => (p.agent = 'caf' + String.fromCodePoint(0xe9)), 'handshake.agent: bad format'],
    [(p) => (p.agent = null), 'handshake.agent: not a string'],
    [(p) => (p.caps = { relay: true }), 'handshake.caps.mailbox: missing'],
    [(p) => (p.caps.transit = 0), 'handshake.caps.transit: not a boolean'],
    [(p) => (p.listen = 'tcp://10.0.0.1:1'), 'handshake.listen: not an array'],
    [(p) => (p.listen = { 0: 'tcp://10.0.0.1:1', length: 1 }), 'handshake.listen: not an array'],
    [(p) => (p.listen = tooMany), 'handshake.listen: too many items'],
    [(p) => (p.listen[1] = 'tcp://10.0.0.1:0'), 'handshake.listen[1]: bad port'],
    [(p) => (p.listen[0] = 42), 'handshake.listen[0]: not a string'],
    [(p) => delete p.observed, 'handshake.observed: missing'],
    [(p) => (p.observed = undefined), 'handshake.observed: not a string'],
    [(p) => (p.observed = 'example.org'), 'handshake.observed: bad format'],
    [(p) => (p.observed = '[::1]'), 'handshake.observed: bad format'],
    [(p) => (p.observed = '10.0.0.1:80'), 'handshake.observed: bad format'],
    [(p) => (p.observed = 0), 'handshake.observed: not a string'],
    [(p) => (p.ts = -1), 'handshake.ts: out of range'],
    [(p) => (p.ts = 1.5), 'handshake.ts: not an integer'],
    [(p) => (p.ts = 2 ** 53), 'handshake.ts: not an integer'],
    [(p) => (p.ts = '0'), 'handshake.ts: not an integer'],
    [(p) => (p.ts = NaN), 'handshake.ts: not an integer'],
    [(p) => (p.token = 'x'), 'handshake.token: unknown field'],
  ];
  for (const [edit, reason] of cases) {
    assert.deepEqual(validateHandshakePayload(mutate(handshake, edit)), bad(reason), reason);
  }
  for (const value of NON_OBJECTS) {
    assert.deepEqual(validateHandshakePayload(value), bad('handshake: not an object'));
  }
});

test('validateDataHeader accepts the documented shape and bounds', () => {
  assert.deepEqual(validateDataHeader(dataHeader()), OK);
  assert.deepEqual(validateDataHeader({ ...dataHeader(), cust: C }), OK);
  assert.deepEqual(validateDataHeader({ ...dataHeader(), ttl: 0, try: 0 }), OK);
  assert.deepEqual(validateDataHeader({ ...dataHeader(), ttl: Limits.MAX_TTL, try: Limits.MAX_TRY }), OK);
});

test('validateDataHeader rejects malformed headers', () => {
  const cases = [
    [(h) => delete h.id, 'data.id: missing'],
    [(h) => (h.id = MSG_ID.toUpperCase()), 'data.id: bad format'],
    [(h) => (h.id = MSG_ID.slice(1)), 'data.id: bad format'],
    [(h) => (h.id = `${MSG_ID}0`), 'data.id: bad format'],
    [(h) => (h.id = `${MSG_ID.slice(0, 31)}g`), 'data.id: bad format'],
    [(h) => (h.id = 5), 'data.id: not a string'],
    [(h) => delete h.dst, 'data.dst: missing'],
    [(h) => (h.dst = A.slice(1)), 'data.dst: bad format'],
    [(h) => (h.dst = null), 'data.dst: not a string'],
    [(h) => delete h.ttl, 'data.ttl: missing'],
    [(h) => (h.ttl = -1), 'data.ttl: out of range'],
    [(h) => (h.ttl = Limits.MAX_TTL + 1), 'data.ttl: out of range'],
    [(h) => (h.ttl = 1.5), 'data.ttl: not an integer'],
    [(h) => (h.ttl = '16'), 'data.ttl: not an integer'],
    [(h) => (h.ttl = Infinity), 'data.ttl: not an integer'],
    [(h) => delete h.try, 'data.try: missing'],
    [(h) => (h.try = -1), 'data.try: out of range'],
    [(h) => (h.try = Limits.MAX_TRY + 1), 'data.try: out of range'],
    [(h) => (h.try = true), 'data.try: not an integer'],
    [(h) => (h.cust = 'nobody'), 'data.cust: bad format'],
    [(h) => (h.cust = undefined), 'data.cust: not a string'],
    [(h) => (h.src = A), 'data.src: unknown field'],
    [(h) => (h.rsvp = A), 'data.rsvp: unknown field'],
  ];
  for (const [edit, reason] of cases) {
    assert.deepEqual(validateDataHeader(mutate(dataHeader, edit)), bad(reason), reason);
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validateDataHeader(value), bad('data: not an object'));
});

test('validateProbeHeader accepts the documented shape and rejects deviations', () => {
  assert.deepEqual(validateProbeHeader(probeHeader()), OK);
  assert.deepEqual(validateProbeHeader({ ...probeHeader(), ttl: 0, n: Limits.MAX_TTL }), OK);

  const cases = [
    [(h) => delete h.rsvp, 'probe.rsvp: missing'],
    [(h) => (h.rsvp = 'x'), 'probe.rsvp: bad format'],
    [(h) => delete h.n, 'probe.n: missing'],
    [(h) => (h.n = 0), 'probe.n: out of range'],
    // n is the ttl the originator set; forwarders only ever lower ttl below it.
    [(h) => (h.n = 15), 'probe.ttl: out of range'],
    [(h) => (h.n = Limits.MAX_TTL + 1), 'probe.n: out of range'],
    [(h) => (h.n = 1.25), 'probe.n: not an integer'],
    [(h) => (h.ttl = 33), 'probe.ttl: out of range'],
    [(h) => (h.id = ''), 'probe.id: bad format'],
    [(h) => (h.dst = 3), 'probe.dst: not a string'],
    [(h) => (h.try = 0), 'probe.try: unknown field'],
    [(h) => (h.cust = A), 'probe.cust: unknown field'],
  ];
  for (const [edit, reason] of cases) {
    assert.deepEqual(validateProbeHeader(mutate(probeHeader, edit)), bad(reason), reason);
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validateProbeHeader(value), bad('probe: not an object'));
});

test('PING and PONG headers carry exactly a 16-hex-character nonce', () => {
  assert.deepEqual(validatePingHeader({ n: NONCE }), OK);
  assert.deepEqual(validatePongHeader({ n: 'ffffffffffffffff' }), OK);
  const cases = [
    [{}, 'n: missing'],
    [{ n: 1 }, 'n: not a string'],
    [{ n: 0 }, 'n: not a string'],
    [{ n: NONCE.toUpperCase() }, 'n: bad format'],
    [{ n: NONCE.slice(1) }, 'n: bad format'],
    [{ n: `${NONCE}0` }, 'n: bad format'],
    [{ n: `${NONCE}\n` }, 'n: bad format'],
    [{ n: 'x'.repeat(1 << 20) }, 'n: bad format'],
    [{ n: NONCE, ts: 1 }, 'ts: unknown field'],
  ];
  for (const [header, reason] of cases) {
    assert.deepEqual(validatePingHeader(header), bad(`ping.${reason}`), reason);
    assert.deepEqual(validatePongHeader(header), bad(`pong.${reason}`), reason);
  }
  for (const value of NON_OBJECTS) {
    assert.deepEqual(validatePingHeader(value), bad('ping: not an object'));
    assert.deepEqual(validatePongHeader(value), bad('pong: not an object'));
  }
});

test('BYE headers carry exactly a short lowercase reason', () => {
  for (const reason of ['duplicate', 'not-allowed', 'x', 'a'.repeat(32)]) {
    assert.deepEqual(validateByeHeader({ reason }), OK, reason);
  }
  const cases = [
    [{}, 'bye.reason: missing'],
    [{ reason: '' }, 'bye.reason: bad format'],
    [{ reason: 'a'.repeat(33) }, 'bye.reason: bad format'],
    [{ reason: 'Shutdown' }, 'bye.reason: bad format'],
    [{ reason: 'time out' }, 'bye.reason: bad format'],
    [{ reason: 7 }, 'bye.reason: not a string'],
    [{ reason: 'manual', detail: 'x' }, 'bye.detail: unknown field'],
  ];
  for (const [header, reason] of cases) assert.deepEqual(validateByeHeader(header), bad(reason), reason);
});

test('validateMeta checks msg and ack exactly', () => {
  assert.equal(MetaKind.MSG, 'msg');
  assert.equal(MetaKind.ACK, 'ack');
  assert.deepEqual(validateMeta(msgMeta()), OK);
  assert.deepEqual(validateMeta({ ...msgMeta(), ack: false }), OK);
  assert.deepEqual(validateMeta(ackMeta()), OK);

  const msgCases = [
    [(m) => delete m.ack, 'meta.ack: missing'],
    [(m) => (m.ack = 1), 'meta.ack: not a boolean'],
    [(m) => delete m.hs, 'meta.hs: missing'],
    [(m) => (m.hs = b64(63)), 'meta.hs: wrong length'],
    [(m) => (m.card.id = 'x'), 'meta.card.id: bad format'],
    [(m) => (m.ts = -1), 'meta.ts: out of range'],
    [(m) => (m.ts = 1.5), 'meta.ts: not an integer'],
    [(m) => (m.id = MSG_ID), 'meta.id: unknown field'],
    [(m) => (m.text = 'hi'), 'meta.text: unknown field'],
  ];
  for (const [edit, reason] of msgCases) assert.deepEqual(validateMeta(mutate(msgMeta, edit)), bad(reason), reason);

  const ackCases = [
    [(m) => delete m.id, 'meta.id: missing'],
    [(m) => (m.id = MSG_ID.toUpperCase()), 'meta.id: bad format'],
    [(m) => (m.ack = true), 'meta.ack: unknown field'],
    [(m) => (m.re = MSG_ID), 'meta.re: unknown field'],
    [(m) => delete m.card, 'meta.card: missing'],
  ];
  for (const [edit, reason] of ackCases) assert.deepEqual(validateMeta(mutate(ackMeta, edit)), bad(reason), reason);
});

test('validateMeta checks only the reserved fields of service-owned kinds', () => {
  assert.deepEqual(validateMeta(otherMeta()), OK);
  assert.deepEqual(validateMeta(mutate(otherMeta, (m) => delete m.ack)), OK);
  const cases = [
    [(m) => (m.ack = 'yes'), 'meta.ack: not a boolean'],
    [(m) => delete m.hs, 'meta.hs: missing'],
    [(m) => (m.card = null), 'meta.card: not an object'],
    [(m) => (m.kind = 'File-Offer'), 'meta.kind: bad format'],
    [(m) => (m.kind = 'k'.repeat(33)), 'meta.kind: bad format'],
    [(m) => (m.kind = ''), 'meta.kind: bad format'],
    [(m) => (m.kind = 3), 'meta.kind: not a string'],
    [(m) => delete m.kind, 'meta.kind: missing'],
    [(m) => (m.size = 1.5), 'meta.size: invalid'],
    [(m) => (m.when = new Date(0)), 'meta.when: invalid'],
    [(m) => (m.fn = () => {}), 'meta.fn: invalid'],
  ];
  for (const [edit, reason] of cases) {
    assert.deepEqual(validateMeta(mutate(otherMeta, edit)), bad(reason), reason);
  }
  // Extra fields with harmless names that hold harmless values are fine, and a key that
  // cannot be reported is not echoed.
  assert.deepEqual(validateMeta(mutate(otherMeta, (m) => (m['bad key'] = { y: 1 }))), OK);
  assert.deepEqual(validateMeta(mutate(otherMeta, (m) => (m['bad key'] = 1n))), bad('meta: invalid'));
  // "constructor" and friends are ordinary unknown kinds, not inherited validators.
  for (const kind of ['constructor', 'tostring', 'hasownproperty']) {
    assert.deepEqual(validateMeta({ ...otherMeta(), kind }), OK, kind);
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validateMeta(value), bad('meta: not an object'));
});

test('validateMeta bounds the work spent on service-owned fields', () => {
  let deep = 1;
  for (let i = 0; i < 40; i += 1) deep = { d: deep };
  assert.deepEqual(validateMeta({ ...otherMeta(), deep }), bad('meta.deep: too deep'));

  const wide = { ...otherMeta(), wide: Array.from({ length: 20000 }, () => 0) };
  assert.deepEqual(validateMeta(wide), bad('meta.wide: too large'));

  // A self-referencing value with fan-out would take 2^32 steps without the shared budget.
  const loop = {};
  loop.a = loop;
  loop.b = loop;
  const started = process.hrtime.bigint();
  const result = validateMeta({ ...otherMeta(), loop });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.ok, false);
  assert.match(result.reason, /^meta\.loop: too (?:deep|large)$/);
  assert.ok(elapsedMs < 1000, `took ${elapsedMs.toFixed(0)} ms`);

  const getter = otherMeta();
  Object.defineProperty(getter, 'boom', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.deepEqual(validateMeta(getter), bad('meta: invalid'));
});

test('validateLsa accepts well-formed advertisements, including the limits', () => {
  assert.deepEqual(validateLsa(lsa()), OK);
  assert.deepEqual(validateLsa({ ...lsa(), links: [] }), OK);
  assert.deepEqual(validateLsa({ ...lsa(), seq: Number.MAX_SAFE_INTEGER, ts: 0 }), OK);
  // 256 distinct peers, none of them the origin (seeds 2..257 wrap, so use two bytes).
  const links = Array.from({ length: Limits.MAX_LSA_LINKS }, (_, i) => {
    const key = Buffer.alloc(32, 0x80);
    key.writeUInt16BE(i, 0);
    return { peer: base32(key), cost: 1 + i };
  });
  assert.equal(new Set(links.map((l) => l.peer)).size, Limits.MAX_LSA_LINKS);
  assert.deepEqual(validateLsa({ ...lsa(), links }), OK);
});

test('validateLsa rejects malformed advertisements', () => {
  const tooMany = Array.from({ length: Limits.MAX_LSA_LINKS + 1 }, (_, i) => {
    const key = Buffer.alloc(32, 0x80);
    key.writeUInt16BE(i, 0);
    return { peer: base32(key), cost: 1 };
  });
  const cases = [
    [(r) => (r.type = 'peer'), 'lsa.type: unexpected value'],
    [(r) => delete r.type, 'lsa.type: missing'],
    [(r) => (r.origin = 'me'), 'lsa.origin: bad format'],
    [(r) => (r.seq = 0), 'lsa.seq: out of range'],
    [(r) => (r.seq = -5), 'lsa.seq: out of range'],
    [(r) => (r.seq = 2 ** 53), 'lsa.seq: not an integer'],
    [(r) => (r.seq = '1'), 'lsa.seq: not an integer'],
    [(r) => (r.ts = -1), 'lsa.ts: out of range'],
    [(r) => delete r.links, 'lsa.links: missing'],
    [(r) => (r.links = {}), 'lsa.links: not an array'],
    [(r) => (r.links = tooMany), 'lsa.links: too many items'],
    [(r) => (r.links[1] = null), 'lsa.links[1]: not an object'],
    [(r) => (r.links[1] = [B, 1]), 'lsa.links[1]: not an object'],
    [(r) => delete r.links[0].peer, 'lsa.links[0].peer: missing'],
    [(r) => (r.links[0].peer = 'nope'), 'lsa.links[0].peer: bad format'],
    [(r) => (r.links[1].cost = 0), 'lsa.links[1].cost: out of range'],
    [(r) => (r.links[1].cost = 65536), 'lsa.links[1].cost: out of range'],
    [(r) => (r.links[1].cost = 1.5), 'lsa.links[1].cost: not an integer'],
    [(r) => (r.links[1].cost = '12'), 'lsa.links[1].cost: not an integer'],
    [(r) => (r.links[0].rtt = 3), 'lsa.links[0].rtt: unknown field'],
    [(r) => (r.links[1].peer = B), 'lsa.links[1].peer: duplicate'],
    [(r) => (r.links[1].peer = A), 'lsa.links[1].peer: is origin'],
    [(r) => (r.links[0].peer = A), 'lsa.links[0].peer: is origin'],
    [(r) => (r.caps.relay = 'yes'), 'lsa.caps.relay: not a boolean'],
    [(r) => delete r.sig, 'lsa.sig: missing'],
    [(r) => (r.sig = b64(63)), 'lsa.sig: wrong length'],
    [(r) => (r.sig = `${SIG.slice(0, 87)}!`), 'lsa.sig: bad base64'],
    [(r) => (r.note = 'hi'), 'lsa.note: unknown field'],
  ];
  for (const [edit, reason] of cases) assert.deepEqual(validateLsa(mutate(lsa, edit)), bad(reason), reason);
  for (const value of NON_OBJECTS) assert.deepEqual(validateLsa(value), bad('lsa: not an object'));
});

test('validateLsa reports the index of the failing link', () => {
  const record = lsa();
  record.links = [
    { peer: nodeId(10), cost: 1 },
    { peer: nodeId(11), cost: 1 },
    { peer: nodeId(12), cost: 1 },
    { peer: nodeId(13), cost: 70000 },
  ];
  assert.deepEqual(validateLsa(record), bad('lsa.links[3].cost: out of range'));
});

test('validatePeerRecord accepts well-formed records and rejects malformed ones', () => {
  assert.deepEqual(validatePeerRecord(peerRecord()), OK);
  assert.deepEqual(validatePeerRecord({ ...peerRecord(), addrs: [] }), OK);

  const tooMany = Array.from({ length: Limits.MAX_PEER_ADDRS + 1 }, (_, i) => `tcp://10.0.0.${i + 1}:1`);
  const cases = [
    [(r) => (r.type = 'lsa'), 'peer.type: unexpected value'],
    [(r) => (r.origin = 1), 'peer.origin: not a string'],
    [(r) => (r.seq = 0), 'peer.seq: out of range'],
    [(r) => (r.ts = null), 'peer.ts: not an integer'],
    [(r) => (r.addrs = null), 'peer.addrs: not an array'],
    [(r) => (r.addrs = tooMany), 'peer.addrs: too many items'],
    [(r) => (r.addrs = ['http://example.org:80']), 'peer.addrs[0]: bad scheme'],
    [(r) => (r.addrs = ['tcp://10.0.0.1:1', 'tcp://bad host:1']), 'peer.addrs[1]: bad host'],
    [(r) => delete r.caps, 'peer.caps: missing'],
    [(r) => delete r.card, 'peer.card: missing'],
    [(r) => (r.card.sig = ''), 'peer.card.sig: wrong length'],
    [(r) => (r.card.id = B), 'peer.card.id: does not match origin'],
    [(r) => (r.origin = B), 'peer.card.id: does not match origin'],
    [(r) => (r.sig = 12), 'peer.sig: not a string'],
    [(r) => (r.links = []), 'peer.links: unknown field'],
  ];
  for (const [edit, reason] of cases) {
    assert.deepEqual(validatePeerRecord(mutate(peerRecord, edit)), bad(reason), reason);
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validatePeerRecord(value), bad('peer: not an object'));
});

test('validateCast accepts plain and encrypted casts', () => {
  assert.deepEqual(validateCast(plainCast()), OK);
  assert.deepEqual(validateCast(sealedCast()), OK);
  assert.deepEqual(validateCast({ ...plainCast(), body: '' }), OK);
  assert.deepEqual(validateCast({ ...sealedCast(), body: b64(16) }), OK, 'tag only: empty plaintext');
});

test('validateCast enforces the body size limit exactly', () => {
  const max = Limits.MAX_CAST_BODY;
  assert.deepEqual(validateCast({ ...plainCast(), body: b64(max) }), OK);
  // 16385 and 16386 bytes encode to the same text length as 16384, so only the decoded
  // length can tell them apart.
  assert.equal(b64(max + 1).length, b64(max).length);
  assert.deepEqual(validateCast({ ...plainCast(), body: b64(max + 1) }), bad('cast.body: too long'));
  assert.deepEqual(validateCast({ ...plainCast(), body: b64(max + 2) }), bad('cast.body: too long'));
  assert.deepEqual(validateCast({ ...plainCast(), body: b64(max + 3) }), bad('cast.body: too long'));
  assert.deepEqual(validateCast({ ...plainCast(), body: 'A'.repeat(1 << 20) }), bad('cast.body: too long'));

  assert.deepEqual(validateCast({ ...sealedCast(), body: b64(max + 16) }), OK);
  assert.deepEqual(validateCast({ ...sealedCast(), body: b64(max + 17) }), bad('cast.body: too long'));
  // The extra 16 bytes are for the tag only: a plain cast may not use them.
  assert.deepEqual(validateCast({ ...plainCast(), body: b64(max + 16) }), bad('cast.body: too long'));
});

test('validateCast ties salt to enc and rejects malformed casts', () => {
  const cases = [
    [plainCast, (r) => (r.salt = b64(32)), 'cast.salt: unexpected'],
    [sealedCast, (r) => delete r.salt, 'cast.salt: missing'],
    [sealedCast, (r) => (r.salt = b64(16)), 'cast.salt: wrong length'],
    [sealedCast, (r) => (r.salt = null), 'cast.salt: not a string'],
    [sealedCast, (r) => (r.salt = `${'A'.repeat(42)}B=`), 'cast.salt: bad base64'],
    [sealedCast, (r) => (r.body = b64(15)), 'cast.body: too short'],
    [sealedCast, (r) => (r.body = ''), 'cast.body: too short'],
    [plainCast, (r) => (r.enc = 'false'), 'cast.enc: not a boolean'],
    [plainCast, (r) => (r.enc = 0), 'cast.enc: not a boolean'],
    [plainCast, (r) => delete r.enc, 'cast.enc: missing'],
    [plainCast, (r) => (r.body = 'aGVsbG8'), 'cast.body: bad base64'],
    [plainCast, (r) => (r.body = 'aGVsbG8*'), 'cast.body: bad base64'],
    [plainCast, (r) => (r.body = 'aGVsbG9='), 'cast.body: bad base64'],
    [plainCast, (r) => (r.body = 'aGVs bG8='), 'cast.body: bad base64'],
    [plainCast, (r) => (r.body = 'aGVsbG8-'), 'cast.body: bad base64'],
    [plainCast, (r) => (r.body = Buffer.from('hello')), 'cast.body: not a string'],
    [plainCast, (r) => delete r.body, 'cast.body: missing'],
    [plainCast, (r) => (r.chan = 'general'), 'cast.chan: bad format'],
    [plainCast, (r) => (r.chan = r.chan.toUpperCase()), 'cast.chan: bad format'],
    [plainCast, (r) => (r.n = 0), 'cast.n: out of range'],
    [plainCast, (r) => (r.n = 1.5), 'cast.n: not an integer'],
    [plainCast, (r) => (r.ts = -1), 'cast.ts: out of range'],
    [plainCast, (r) => (r.origin = undefined), 'cast.origin: not a string'],
    [plainCast, (r) => (r.sig = b64(65)), 'cast.sig: wrong length'],
    [plainCast, (r) => (r.type = 'broadcast'), 'cast.type: unexpected value'],
    [plainCast, (r) => (r.nonce = 'AAAA'), 'cast.nonce: unknown field'],
  ];
  for (const [make, edit, reason] of cases) {
    assert.deepEqual(validateCast(mutate(make, edit)), bad(reason), reason);
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validateCast(value), bad('cast: not an object'));
});

test('validateBeacon accepts well-formed beacons and rejects malformed ones', () => {
  assert.deepEqual(validateBeacon(beacon()), OK);
  assert.deepEqual(validateBeacon({ ...beacon(), port: 1 }), OK);
  assert.deepEqual(validateBeacon({ ...beacon(), port: 65535 }), OK);
  assert.deepEqual(validateBeacon({ ...beacon(), mac: b64(32, 3) }), OK, 'private-network beacon');
  assert.deepEqual(validateRecord({ ...beacon(), mac: b64(32, 3) }), OK);

  const cases = [
    [(r) => (r.mac = b64(31)), 'beacon.mac: wrong length'],
    [(r) => (r.mac = b64(33)), 'beacon.mac: wrong length'],
    [(r) => (r.mac = `${b64(32).slice(0, 42)}!=`), 'beacon.mac: bad base64'],
    [(r) => (r.mac = null), 'beacon.mac: not a string'],
    [(r) => (r.port = 0), 'beacon.port: out of range'],
    [(r) => (r.port = 65536), 'beacon.port: out of range'],
    [(r) => (r.port = '47470'), 'beacon.port: not an integer'],
    [(r) => delete r.port, 'beacon.port: missing'],
    [(r) => (r.net = 'has space'), 'beacon.net: bad format'],
    [(r) => (r.net = ''), 'beacon.net: bad format'],
    [(r) => (r.card.id = C), 'beacon.card.id: does not match origin'],
    [(r) => (r.card = 'card'), 'beacon.card: not an object'],
    [(r) => (r.ts = 1e300), 'beacon.ts: not an integer'],
    [(r) => (r.type = 'lsa'), 'beacon.type: unexpected value'],
    [(r) => (r.addr = '10.0.0.1'), 'beacon.addr: unknown field'],
    [(r) => (r.seq = 1), 'beacon.seq: unknown field'],
  ];
  for (const [edit, reason] of cases) assert.deepEqual(validateBeacon(mutate(beacon, edit)), bad(reason), reason);
  for (const value of NON_OBJECTS) assert.deepEqual(validateBeacon(value), bad('beacon: not an object'));
});

test('validateReceipt accepts well-formed receipts and rejects malformed ones', () => {
  assert.deepEqual(validateReceipt(receipt()), OK);
  const cases = [
    [(r) => (r.id = 'abc'), 'receipt.id: bad format'],
    [(r) => delete r.id, 'receipt.id: missing'],
    [(r) => (r.origin = ''), 'receipt.origin: bad format'],
    [(r) => (r.ts = '1'), 'receipt.ts: not an integer'],
    [(r) => (r.sig = undefined), 'receipt.sig: not a string'],
    [(r) => (r.type = 'ack'), 'receipt.type: unexpected value'],
    [(r) => (r.dst = B), 'receipt.dst: unknown field'],
  ];
  for (const [edit, reason] of cases) assert.deepEqual(validateReceipt(mutate(receipt, edit)), bad(reason), reason);
  for (const value of NON_OBJECTS) assert.deepEqual(validateReceipt(value), bad('receipt: not an object'));
});

test('validateRecord dispatches on the record type', () => {
  for (const make of [lsa, peerRecord, plainCast, sealedCast, beacon, receipt]) {
    assert.deepEqual(validateRecord(make()), OK, make.name);
  }
  // The failure is reported by the validator of the claimed type.
  assert.deepEqual(validateRecord({ ...lsa(), seq: 0 }), bad('lsa.seq: out of range'));
  assert.deepEqual(validateRecord({ ...receipt(), id: 'x' }), bad('receipt.id: bad format'));
  assert.deepEqual(validateRecord({ ...peerRecord(), type: 'lsa' }), bad('lsa.addrs: unknown field'));
  assert.deepEqual(validateRecord({ ...beacon(), type: 'receipt' }), bad('receipt.port: unknown field'));
});

test('validateRecord rejects missing, unknown and hostile record types', () => {
  assert.deepEqual(validateRecord({ origin: A, sig: SIG }), bad('record.type: missing'));
  for (const type of ['', 'LSA', 'lsa ', 'ack', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(validateRecord({ ...lsa(), type }), bad('record.type: unknown'), type);
  }
  for (const type of [null, 1, true, ['lsa'], { toString: () => 'lsa' }]) {
    assert.deepEqual(validateRecord({ ...lsa(), type }), bad('record.type: not a string'));
  }
  for (const value of NON_OBJECTS) assert.deepEqual(validateRecord(value), bad('record: not an object'));
  // An inherited "type" is not a field of the record.
  assert.deepEqual(validateRecord(Object.create({ type: 'lsa' })), bad('record: not an object'));
});

test('unknown field names are only echoed when they are short and harmless', () => {
  assert.deepEqual(validateCaps({ ...caps(), ok_1: 1 }), bad('caps.ok_1: unknown field'));
  const hostile = ['x'.repeat(33), 'a b', 'a.b', 'a\nb', '<script>', '', 'caf' + String.fromCodePoint(0xe9), 'x'.repeat(100000)];
  for (const key of hostile) {
    const result = validateCaps({ ...caps(), [key]: 1 });
    assert.deepEqual(result, bad('caps: unknown field'), JSON.stringify(key.slice(0, 20)));
  }
});

test('a "__proto__" key parsed from JSON is refused, not treated as a prototype', () => {
  const parsed = JSON.parse(`{"relay":true,"mailbox":false,"transit":true,"__proto__":{"admin":true}}`);
  assert.deepEqual(Object.keys(parsed), ['relay', 'mailbox', 'transit', '__proto__']);
  assert.deepEqual(validateCaps(parsed), bad('caps.__proto__: forbidden key'));
  const nested = JSON.parse(JSON.stringify(dataHeader()).replace('{', '{"__proto__":{"cust":"x"},'));
  assert.deepEqual(validateDataHeader(nested), bad('data.__proto__: forbidden key'));
});

test('"__proto__" is refused at every depth by every validator', () => {
  const inject = (make, at) => {
    const value = make();
    const target = at(value);
    Object.defineProperty(target, '__proto__', { value: {}, enumerable: true, configurable: true, writable: true });
    return value;
  };
  const cases = [
    [validateHandshakePayload, handshake, (v) => v.card, 'handshake.card.__proto__: forbidden key'],
    [validateHandshakePayload, handshake, (v) => v.caps, 'handshake.caps.__proto__: forbidden key'],
    [validateLsa, lsa, (v) => v.links[1], 'lsa.links[1].__proto__: forbidden key'],
    [validateRecord, peerRecord, (v) => v.card, 'peer.card.__proto__: forbidden key'],
    [validateRecord, beacon, (v) => v, 'beacon.__proto__: forbidden key'],
    [validateRecord, receipt, (v) => v, 'receipt.__proto__: forbidden key'],
    [validatePingHeader, () => ({ n: NONCE }), (v) => v, 'ping.__proto__: forbidden key'],
    [validateMeta, msgMeta, (v) => v.card, 'meta.card.__proto__: forbidden key'],
    [validateMeta, otherMeta, (v) => v, 'meta.__proto__: forbidden key'],
    [validateMeta, otherMeta, (v) => v.files[0], 'meta.files: forbidden key'],
    [validateMeta, otherMeta, (v) => v.opts.deep, 'meta.opts: forbidden key'],
  ];
  for (const [validate, make, at, reason] of cases) {
    assert.deepEqual(validate(inject(make, at)), bad(reason), reason);
  }
  // The same through the JSON parser, which is how such a key arrives from a peer.
  const text = JSON.stringify(otherMeta()).replace('"deep":{', '"deep":{"__proto__":{"admin":true},');
  assert.deepEqual(validateMeta(JSON.parse(text)), bad('meta.opts: forbidden key'));
});

test('fields must be own properties; inherited values are not accepted', () => {
  const inherited = Object.create(null);
  Object.assign(inherited, { relay: true, mailbox: false });
  assert.deepEqual(validateCaps(inherited), bad('caps.transit: missing'));
  inherited.transit = true;
  assert.deepEqual(validateCaps(inherited), OK, 'objects without a prototype are plain objects');

  class Caps {
    constructor() {
      Object.assign(this, caps());
    }
  }
  assert.deepEqual(validateCaps(new Caps()), bad('caps: not an object'));
});

test('a polluted Object.prototype cannot stand in for a missing field', (t) => {
  // If some other code in the process is tricked into writing to Object.prototype, a
  // record must still carry every field itself.
  Object.defineProperty(Object.prototype, 'transit', { value: true, configurable: true });
  t.after(() => {
    delete Object.prototype.transit;
  });
  assert.equal({}.transit, true, 'the pollution is in effect');
  assert.deepEqual(validateCaps({ relay: true, mailbox: false }), bad('caps.transit: missing'));
  assert.deepEqual(validateCaps(caps()), OK);
});

test('symbol keys and non-enumerable properties count as unknown fields', () => {
  const withSymbol = { ...caps(), [Symbol('hidden')]: 1 };
  assert.deepEqual(validateCaps(withSymbol), bad('caps: unknown field'));
  const withHidden = caps();
  Object.defineProperty(withHidden, 'admin', { value: true, enumerable: false });
  assert.deepEqual(validateCaps(withHidden), bad('caps.admin: unknown field'));
});

test('validators never throw, even for values that fight back', () => {
  const throwingGetter = {};
  for (const key of ['relay', 'mailbox', 'transit']) {
    Object.defineProperty(throwingGetter, key, {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
  }
  assert.deepEqual(validateCaps(throwingGetter), bad('caps: invalid'));

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
  const validators = [
    validateCard, validateCaps, validateAddress, validateHandshakePayload, validateDataHeader,
    validateProbeHeader, validateLsa, validatePeerRecord, validateCast, validateBeacon,
    validateReceipt, validateRecord, validatePingHeader, validatePongHeader, validateByeHeader,
    validateMeta,
  ];
  for (const validate of validators) {
    const result = validate(hostileProxy);
    assert.equal(result.ok, false, validate.name);
    assert.equal(typeof result.reason, 'string', validate.name);
  }

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const validate of validators) assert.equal(validate(revoked.proxy).ok, false, validate.name);
});

test('reasons stay short for every rejection in this file', () => {
  const samples = [
    validateLsa(mutate(lsa, (r) => (r.links[1].cost = 0))),
    validateHandshakePayload(mutate(handshake, (p) => (p.card.sig = 'x'.repeat(100000)))),
    validateCast({ ...plainCast(), body: 'x'.repeat(1 << 21) }),
    validateAddress(`tcp://${'x'.repeat(1 << 21)}:1`),
    validatePeerRecord(mutate(peerRecord, (r) => (r.addrs[0] = 'y'.repeat(5000)))),
  ];
  for (const result of samples) {
    assert.equal(result.ok, false);
    assert.ok(result.reason.length <= 64, result.reason);
    assert.match(result.reason, /^[a-z]+(?:\.[A-Za-z0-9_]+|\[[0-9]+\])*: [a-z0-9 ]+$/);
  }
});

test('the success verdict cannot be modified by a caller', () => {
  const first = validateCaps(caps());
  assert.throws(() => {
    first.ok = false;
  }, TypeError);
  assert.deepEqual(validateCaps(caps()), OK);
});

test('validation does not modify its input', () => {
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };
  const pairs = [
    [handshake, validateHandshakePayload],
    [dataHeader, validateDataHeader],
    [probeHeader, validateProbeHeader],
    [lsa, validateRecord],
    [peerRecord, validateRecord],
    [sealedCast, validateRecord],
    [beacon, validateRecord],
    [receipt, validateRecord],
  ];
  for (const [make, validate] of pairs) {
    // A deep-frozen input makes any write throw (ESM is strict mode), and a throw
    // inside a validator would surface as a rejection.
    const value = deepFreeze(make());
    const before = JSON.stringify(value);
    assert.deepEqual(validate(value), OK, make.name);
    assert.equal(JSON.stringify(value), before, make.name);
  }
});

test('a large hostile LSA is rejected quickly', () => {
  // 100000 links: the array bound is checked before any item is looked at.
  const links = Array.from({ length: 100000 }, () => ({ peer: B, cost: 1 }));
  const started = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    assert.deepEqual(validateLsa({ ...lsa(), links }), bad('lsa.links: too many items'));
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5000, `took ${elapsedMs.toFixed(0)} ms`);
});
