import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import {
  BEACON_MAC_LENGTH,
  CAST_SALT_LENGTH,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_FUTURE_MS,
  MAX_CHUNK_INDEX,
  TRANSFER_ID_LENGTH,
  beaconMac,
  castDecrypt,
  castEncrypt,
  channelWireId,
  deriveBeaconKey,
  openChunk,
  openMessage,
  peekChunk,
  sealChunk,
  sealMessage,
  verifyBeaconMac,
} from '../../src/core/crypto/envelope.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { HandshakeState } from '../../src/core/crypto/noise.js';
import { x25519, x25519GenerateKeyPair } from '../../src/core/crypto/primitives.js';
import { AuthError, CanonicalError, CryptoError } from '../../src/core/errors.js';
import { CHANNEL_ID_PATTERN, Domain, Limits } from '../../src/core/wire/types.js';

const hex = text => Buffer.from(text, 'hex');
const utf8 = text => Buffer.from(text, 'utf8');
const EMPTY = Buffer.alloc(0);
const NUL = Buffer.from([0]);

/**
 * Validator for assert.throws: the error must be exactly the given class (instances of
 * the sibling classes do not pass) with its stable code, and optionally a given reason.
 */
const thrown = (ErrorClass, code, reason) => err => {
  assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name}, got ${inspect(err)}`);
  assert.equal(err.constructor, ErrorClass);
  assert.equal(err.code, code);
  if (reason !== undefined) assert.match(err.message, reason);
  return true;
};
const AUTH = thrown(AuthError, 'ERR_AUTH');
/** An AuthError for one specific reason, where a test must not pass for a neighbouring one. */
const because = reason => thrown(AuthError, 'ERR_AUTH', reason);
const CRYPTO = thrown(CryptoError, 'ERR_CRYPTO');

const u16 = value => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};
const u32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

/** Plaintext bytes carried by one full Noise transport message: 65535 less the tag. */
const CHUNK = 65519;
/** Noise_X handshake message carrying a 4-byte payload: e, encrypted s, encrypted payload. */
const HANDSHAKE = 32 + 48 + 20;
const NOW = 1_700_000_000_000;

const alice = Identity.generate();
const bob = Identity.generate();
const mallory = Identity.generate();
const MESSAGE_ID = '000102030405060708090a0b0c0d0e0f';

const seal = (overrides = {}) =>
  sealMessage({
    sender: alice,
    recipientE2eKey: bob.e2eKeyPair.publicKey,
    dst: bob.nodeId,
    id: MESSAGE_ID,
    meta: { kind: 'msg' },
    content: utf8('hello bob'),
    now: NOW,
    ...overrides,
  });
const open = (body, overrides = {}) =>
  openMessage({ recipient: bob, dst: bob.nodeId, id: MESSAGE_ID, body, now: NOW, ...overrides });

/** Split a scheme-1 body into its records, checking the outer framing on the way. */
function parseBody(body) {
  assert.equal(body[0], 0x01);
  const records = [];
  let offset = 1;
  while (offset < body.length) {
    const length = body.readUInt16BE(offset);
    records.push({ start: offset, end: offset + 2 + length, length });
    offset += 2 + length;
  }
  assert.equal(offset, body.length);
  return records;
}

/**
 * Where hand-built metadata carries `hs`, it first holds this slot: 88 characters, the
 * length of a base64 Ed25519 signature, so lengths can be fixed before the handshake. The
 * hand-written senders below replace it with a real signature once the handshake hash
 * exists.
 */
const HS_SLOT = '#'.repeat(88);
const HS_FIELD = `"hs":"${HS_SLOT}"`;

/** Put base64(signer.sign(domain, h)) into the HS_SLOT of a plaintext, if it has one. */
function fillSignature(plaintext, signer, domain, h) {
  const at = plaintext.indexOf(utf8(HS_SLOT));
  if (at < 0) return plaintext;
  const signature = utf8(signer.sign(domain, h).toString('base64'));
  assert.equal(signature.length, HS_SLOT.length);
  const filled = Buffer.from(plaintext);
  signature.copy(filled, at);
  return filled;
}

/**
 * The sender side of DESIGN.md section 6, written out independently of envelope.js and
 * with every knob exposed, so tests can play a sender that authenticates correctly but
 * breaks a rule only the recipient can enforce. An HS_SLOT in the plaintext is filled with
 * `signer`'s signature over the handshake hash under `hsDomain`.
 */
function rawSeal({
  senderE2e = alice.e2eKeyPair,
  recipientE2eKey = bob.e2eKeyPair.publicKey,
  dst = bob.nodeId,
  id = MESSAGE_ID,
  plaintext,
  chunkSizes,
  announced = plaintext.length,
  scheme = 0x01,
  lengthPayload = u32(announced),
  signer = alice,
  hsDomain = Domain.E2E_AUTH,
}) {
  const handshake = new HandshakeState({
    pattern: 'Noise_X_25519_ChaChaPoly_SHA256',
    initiator: true,
    prologue: Buffer.concat([utf8('clawnet/1/e2e'), NUL, utf8(dst), NUL, utf8(id)]),
    s: senderE2e,
    rs: recipientE2eKey,
  });
  const first = handshake.writeMessage(lengthPayload);
  const signed = fillSignature(plaintext, signer, hsDomain, handshake.handshakeHash);
  const { tx } = handshake.split();
  const parts = [Buffer.from([scheme]), u16(first.length), first];
  let offset = 0;
  for (const size of chunkSizes) {
    const record = tx.encryptWithAd(EMPTY, signed.subarray(offset, offset + size));
    parts.push(u16(record.length), record);
    offset += size;
  }
  return Buffer.concat(parts);
}

const canonicalChunks = total => {
  const sizes = [];
  for (let left = total; left > 0; left -= CHUNK) sizes.push(Math.min(CHUNK, left));
  return sizes;
};

/** Canonical JSON of a card, keys written in sorted order by hand. */
const cardJson = card =>
  `{"e2e":${JSON.stringify(card.e2e)},"id":${JSON.stringify(card.id)},"link":${JSON.stringify(card.link)},"sig":${JSON.stringify(card.sig)}}`;
const metaJson = (card, rest = '"kind":"msg","ts":' + NOW) => `{"card":${cardJson(card)},${HS_FIELD},${rest}}`;
const plaintextOf = (metaText, content = EMPTY) => {
  const meta = utf8(metaText);
  return Buffer.concat([u16(meta.length), meta, content]);
};

// ---------------------------------------------------------------------------------------
// Scheme 0x01: sealed messages
// ---------------------------------------------------------------------------------------

test('a sealed message round-trips and authenticates its sender', () => {
  const body = seal({ meta: { kind: 'msg', ack: true, thread: { n: 3 } } });
  const opened = open(body);
  assert.deepEqual(Object.keys(opened).sort(), ['card', 'content', 'meta', 'senderId']);
  assert.equal(opened.senderId, alice.nodeId);
  assert.deepEqual(opened.card, alice.card);
  assert.match(opened.meta.hs, /^[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(opened.meta, { kind: 'msg', ack: true, thread: { n: 3 }, card: alice.card, ts: NOW, hs: opened.meta.hs });
  assert.deepEqual(opened.content, utf8('hello bob'));
  // Every seal has its own handshake hash, so its own signature.
  assert.notEqual(open(seal()).meta.hs, open(seal()).meta.hs);
  assert.ok(Object.isFrozen(opened.meta));
  assert.ok(Object.isFrozen(opened.meta.card));
  assert.ok(Object.isFrozen(opened.meta.thread));
});

test('round trips at the chunk boundaries DESIGN.md calls out', () => {
  // Overhead of the plaintext framing for this sender and meta: 2 + len(meta).
  const probe = open(seal({ content: EMPTY }));
  const metaLength = utf8(metaJson(probe.card)).length;
  const overhead = 2 + metaLength;

  const contentSizes = [
    0, 1, 65518, 65519, 65520, 200000,
    // Sizes that put the whole plaintext exactly on, just under and just over a boundary.
    CHUNK - overhead - 1, CHUNK - overhead, CHUNK - overhead + 1,
    2 * CHUNK - overhead - 1, 2 * CHUNK - overhead, 2 * CHUNK - overhead + 1,
  ];
  for (const size of contentSizes) {
    const content = randomBytes(size);
    const body = seal({ content });
    const total = overhead + size;
    const chunkCount = Math.ceil(total / CHUNK);

    // Framing: 0x01, the handshake record, then full records and one last record.
    const records = parseBody(body);
    assert.equal(records.length, 1 + chunkCount, `size ${size}: record count`);
    assert.equal(records[0].length, HANDSHAKE);
    records.slice(1, -1).forEach(record => assert.equal(record.length, 65535, `size ${size}: full record`));
    assert.equal(records.at(-1).length, total - (chunkCount - 1) * CHUNK + 16, `size ${size}: last record`);
    assert.equal(body.length, 1 + 2 + HANDSHAKE + total + chunkCount * (2 + 16));

    const opened = open(body);
    assert.equal(opened.content.length, size);
    assert.ok(opened.content.equals(content), `size ${size}: content`);
    assert.equal(opened.senderId, alice.nodeId);
    assert.equal(opened.meta.ts, NOW);
  }
});

test('openMessage accepts a body built independently from DESIGN.md', () => {
  const content = utf8('built by hand');
  const plaintext = plaintextOf(metaJson(alice.card), content);
  const opened = open(rawSeal({ plaintext, chunkSizes: [plaintext.length] }));
  assert.equal(opened.senderId, alice.nodeId);
  assert.deepEqual(opened.content, content);
  assert.equal(opened.meta.kind, 'msg');

  // And the other way round: what sealMessage() produces has exactly that plaintext layout.
  const large = randomBytes(150000);
  const largePlaintext = plaintextOf(metaJson(alice.card), large);
  const viaRaw = open(rawSeal({ plaintext: largePlaintext, chunkSizes: canonicalChunks(largePlaintext.length) }));
  const viaModule = open(seal({ content: large }));
  assert.ok(viaRaw.content.equals(large));
  // Identical apart from the signature, which covers each seal's own handshake hash.
  assert.notEqual(viaRaw.meta.hs, viaModule.meta.hs);
  assert.deepEqual({ ...viaRaw.meta, hs: '' }, { ...viaModule.meta, hs: '' });
});

test('the sealed body reveals neither content, metadata nor the sender', () => {
  const marker = utf8('PLAINTEXT-MARKER-'.repeat(40));
  const body = seal({ content: marker, meta: { kind: 'file-offer', name: 'secret-plans.txt' } });
  assert.ok(open(body).content.equals(marker));
  for (const needle of [
    marker.subarray(0, 16),
    utf8('file-offer'),
    utf8('secret-plans'),
    utf8(alice.nodeId),
    utf8(alice.card.sig),
    alice.e2eKeyPair.publicKey,
    alice.signPublicKey,
    utf8(bob.nodeId),
  ]) {
    assert.equal(body.includes(needle), false, needle.toString('latin1'));
  }
  // Sealing the same message twice gives unrelated bytes: every seal has a fresh ephemeral key.
  const again = seal({ content: marker, meta: { kind: 'file-offer', name: 'secret-plans.txt' } });
  assert.equal(again.length, body.length);
  assert.notDeepEqual(again.subarray(3, 35), body.subarray(3, 35));
  assert.notDeepEqual(again.subarray(-64), body.subarray(-64));
});

test('every single-bit change to a small sealed body is rejected with AuthError', () => {
  const body = seal({ content: utf8('hi') });
  assert.ok(body.length < 600);
  let rejected = 0;
  for (let i = 0; i < body.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const tampered = Buffer.from(body);
      tampered[i] ^= 1 << bit;
      assert.throws(() => open(tampered), AUTH, `byte ${i} bit ${bit}`);
      rejected += 1;
    }
  }
  assert.equal(rejected, body.length * 8);
  assert.deepEqual(open(body).content, utf8('hi'));
});

test('bit changes across a large, multi-record sealed body are rejected', () => {
  const body = seal({ content: randomBytes(200000) });
  const records = parseBody(body);
  assert.equal(records.length, 5);

  const positions = new Set();
  for (let i = 0; i < 1 + 2 + HANDSHAKE + 8; i += 1) positions.add(i);
  for (let i = 0; i < body.length; i += 257) positions.add(i);
  // Both sides of every record boundary, length prefixes included.
  for (const { start, end } of records) {
    for (let delta = -4; delta < 4; delta += 1) {
      for (const edge of [start, end]) {
        if (edge + delta >= 0 && edge + delta < body.length) positions.add(edge + delta);
      }
    }
  }
  for (let i = body.length - 24; i < body.length; i += 1) positions.add(i);
  assert.ok(positions.size > 900);

  let rejected = 0;
  for (const position of positions) {
    const tampered = Buffer.from(body);
    tampered[position] ^= 1 << (position % 8);
    assert.throws(() => open(tampered), AUTH, `byte ${position}`);
    rejected += 1;
  }
  assert.equal(rejected, positions.size);
  assert.equal(open(body).content.length, 200000);
});

test('truncation is rejected at every byte of a small body and every record boundary of a large one', () => {
  const small = seal({ content: utf8('truncate me') });
  let rejected = 0;
  for (let length = 0; length < small.length; length += 1) {
    assert.throws(() => open(small.subarray(0, length)), AUTH, `length ${length}`);
    rejected += 1;
  }
  assert.equal(rejected, small.length);

  const large = seal({ content: randomBytes(200000) });
  const records = parseBody(large);
  const cuts = new Set();
  for (const { start, end } of records) {
    for (const cut of [start, start + 1, start + 2, start + 3, end - 1, end]) {
      if (cut < large.length) cuts.add(cut);
    }
  }
  assert.ok(cuts.size >= 5 * 5);
  for (const cut of cuts) assert.throws(() => open(large.subarray(0, cut)), AUTH, `cut at ${cut}`);
});

test('appended, dropped, duplicated and reordered records are rejected', () => {
  const body = seal({ content: randomBytes(200000) });
  const records = parseBody(body);
  const slice = record => body.subarray(record.start, record.end);
  const [handshake, first, second, third, last] = records.map(slice);
  assert.deepEqual(Buffer.concat([Buffer.from([1]), handshake, first, second, third, last]), body);

  const assemble = (...parts) => Buffer.concat([Buffer.from([1]), ...parts]);
  const altered = {
    'one extra byte': Buffer.concat([body, Buffer.from([0])]),
    'empty record appended': Buffer.concat([body, u16(0)]),
    'tag-sized record appended': Buffer.concat([body, u16(16), randomBytes(16)]),
    'last record repeated': Buffer.concat([body, last]),
    'full record appended': Buffer.concat([body, first]),
    'last record dropped': assemble(handshake, first, second, third),
    'middle record dropped': assemble(handshake, first, third, last),
    'first record dropped': assemble(handshake, second, third, last),
    'records swapped': assemble(handshake, second, first, third, last),
    'record duplicated in place': assemble(handshake, first, first, third, last),
    'all records dropped': assemble(handshake),
    'handshake repeated': assemble(handshake, handshake, first, second, third, last),
  };
  for (const [why, candidate] of Object.entries(altered)) {
    assert.throws(() => open(candidate), AUTH, why);
  }
});

test('records cannot be spliced between two messages', () => {
  const idA = 'a'.repeat(32);
  const idB = 'b'.repeat(32);
  const a = seal({ id: idA, content: utf8('message a') });
  const b = seal({ id: idB, content: utf8('message b') });
  assert.equal(a.length, b.length);
  const cut = 1 + 2 + HANDSHAKE;
  const spliced = Buffer.concat([a.subarray(0, cut), b.subarray(cut)]);
  assert.throws(() => open(spliced, { id: idA }), AUTH);
  assert.throws(() => open(spliced, { id: idB }), AUTH);
  // Even two seals of the same message under the same id do not mix.
  const a2 = seal({ id: idA, content: utf8('message a') });
  assert.throws(() => open(Buffer.concat([a.subarray(0, cut), a2.subarray(cut)]), { id: idA }), AUTH);
  assert.deepEqual(open(a, { id: idA }).content, utf8('message a'));
});

test('the wrong recipient, destination or message id cannot open a message', () => {
  const body = seal();
  assert.deepEqual(open(body).content, utf8('hello bob'));

  // Another node, whether it claims the packet was for it or for Bob.
  assert.throws(() => openMessage({ recipient: mallory, dst: mallory.nodeId, id: MESSAGE_ID, body, now: NOW }), AUTH);
  assert.throws(() => openMessage({ recipient: mallory, dst: bob.nodeId, id: MESSAGE_ID, body, now: NOW }), AUTH);
  // Bob, with a header that names someone else.
  assert.throws(() => open(body, { dst: mallory.nodeId }), because(/not addressed to this node/));
  assert.throws(() => open(body, { dst: alice.nodeId }), AUTH);
  // Bob, with a relabelled message id.
  assert.throws(() => open(body, { id: MESSAGE_ID.replace(/.$/, '0') }), AUTH);
  assert.throws(() => open(body, { id: 'f'.repeat(32) }), AUTH);

  // The destination is bound cryptographically, not only compared: a body sealed to Bob's
  // key but addressed to Mallory does not open under Bob's own id.
  const misaddressed = seal({ dst: mallory.nodeId });
  assert.throws(() => open(misaddressed), because(/failed authentication/));
  assert.throws(() => open(misaddressed, { dst: mallory.nodeId }), AUTH);
});

test('a sender cannot present someone else as the author', () => {
  const victim = alice;
  const attack = (metaText, senderE2e = mallory.e2eKeyPair) => {
    const plaintext = plaintextOf(metaText, utf8('forged'));
    return rawSeal({ senderE2e, plaintext, chunkSizes: [plaintext.length], signer: mallory });
  };

  // Control: Mallory can of course send as herself.
  const honest = open(attack(metaJson(mallory.card)));
  assert.equal(honest.senderId, mallory.nodeId);
  assert.deepEqual(honest.content, utf8('forged'));

  // Someone else's (perfectly valid) card, sealed with Mallory's key.
  assert.throws(() => open(attack(metaJson(victim.card))), because(/not sealed with the key on the sender identity card/));

  // A card under the victim's id carrying Mallory's keys, signed by Mallory.
  const impostor = { ...mallory.card, id: victim.nodeId };
  assert.throws(() => open(attack(metaJson(impostor))), because(/identity card rejected: bad-signature/));

  // The victim's card with only the e2e key swapped for Mallory's.
  const patched = { ...victim.card, e2e: mallory.card.e2e };
  assert.throws(() => open(attack(metaJson(patched))), because(/identity card rejected: bad-signature/));

  // Mallory's own card but with link and e2e exchanged, sealed with her link key.
  const crossed = { ...mallory.card, link: mallory.card.e2e, e2e: mallory.card.link };
  assert.throws(() => open(attack(metaJson(crossed), mallory.linkKeyPair)), because(/identity card rejected: bad-signature/));

  // No card, a card that is not an object, a card with extra fields.
  assert.throws(() => open(attack(`{"kind":"msg","ts":${NOW}}`)), because(/identity card rejected: not-an-object/));
  assert.throws(() => open(attack(`{"card":"${victim.nodeId}","kind":"msg","ts":${NOW}}`)), because(/identity card rejected: not-an-object/));
  const padded = metaJson(mallory.card).replace('"e2e":', '"admin":true,"e2e":');
  assert.throws(() => open(attack(padded)), because(/identity card rejected: bad-shape/));
});

test('meta.hs must be the card identity key signature over this message handshake hash', () => {
  const plaintext = plaintextOf(metaJson(alice.card), utf8('signed'));
  const sealWith = overrides => rawSeal({ plaintext, chunkSizes: [plaintext.length], ...overrides });
  const wrongSignature = because(/sender signature over the handshake does not verify/);
  const malformed = because(/no well-formed sender signature/);

  // Control: Alice's own signature under the e2e-auth domain.
  const opened = open(sealWith({ signer: alice }));
  assert.equal(opened.senderId, alice.nodeId);
  assert.deepEqual(opened.content, utf8('signed'));

  // Made by a different identity: Mallory, or Bob himself.
  assert.throws(() => open(sealWith({ signer: mallory })), wrongSignature);
  assert.throws(() => open(sealWith({ signer: bob })), wrongSignature);
  // Made by Alice, but for another purpose.
  for (const hsDomain of [Domain.STATIC_KEY_BINDING, `${Domain.RECORD_PREFIX}lsa`, Domain.E2E, 'clawnet/1/e2e-auth2']) {
    assert.throws(() => open(sealWith({ hsDomain })), wrongSignature, hsDomain);
  }
  // Made by Alice for this domain, but over another message's handshake hash: lift the
  // signature out of a genuine message and put it into a new one.
  const lifted = open(seal()).meta.hs;
  const replanted = plaintextOf(metaJson(alice.card).replace(HS_SLOT, lifted), utf8('signed'));
  assert.throws(() => open(rawSeal({ plaintext: replanted, chunkSizes: [replanted.length] })), wrongSignature);

  // Missing or malformed.
  const variants = {
    missing: `{"card":${cardJson(alice.card)},"kind":"msg","ts":${NOW}}`,
    number: `{"card":${cardJson(alice.card)},"hs":7,"kind":"msg","ts":${NOW}}`,
    null: `{"card":${cardJson(alice.card)},"hs":null,"kind":"msg","ts":${NOW}}`,
    empty: `{"card":${cardJson(alice.card)},"hs":"","kind":"msg","ts":${NOW}}`,
    'without padding': metaJson(alice.card).replace(HS_SLOT, lifted.slice(0, 86)),
    '63 bytes': metaJson(alice.card).replace(HS_SLOT, Buffer.alloc(63, 1).toString('base64')),
    '65 bytes': metaJson(alice.card).replace(HS_SLOT, Buffer.alloc(65, 1).toString('base64')),
    'url-safe alphabet': metaJson(alice.card).replace(HS_SLOT, Buffer.from(lifted, 'base64').toString('base64url')),
    hex: metaJson(alice.card).replace(HS_SLOT, Buffer.from(lifted, 'base64').toString('hex')),
  };
  for (const [why, metaText] of Object.entries(variants)) {
    const bytes = plaintextOf(metaText, utf8('signed'));
    assert.throws(() => open(rawSeal({ plaintext: bytes, chunkSizes: [bytes.length] })), malformed, why);
  }
  // 64 zero bytes are well-formed and simply do not verify.
  const zeros = plaintextOf(metaJson(alice.card).replace(HS_SLOT, Buffer.alloc(64).toString('base64')), utf8('signed'));
  assert.throws(() => open(rawSeal({ plaintext: zeros, chunkSizes: [zeros.length] })), wrongSignature);
});

/**
 * A Noise_X sender built from the specification with node:crypto, for an attacker who
 * holds the recipient's e2e PRIVATE key. The "ss" key agreement is
 * DH(sender static, recipient static), which that key computes as well as the sender's
 * would, so the attacker can complete the handshake while claiming any static public key:
 * key-compromise impersonation. `metaText` may contain HS_SLOT, which `sign(h)` fills.
 */
function kciForge({
  claimedStatic,
  recipient,
  stolenPrivate = recipient.e2eKeyPair.privateKey,
  metaText,
  sign,
  content = utf8('forged'),
}) {
  const hash = (...parts) => parts.reduce((h, part) => h.update(part), createHash('sha256')).digest();
  const hmac = (key, ...parts) => parts.reduce((m, part) => m.update(part), createHmac('sha256', key)).digest();
  const chacha = (key, ad, plaintext) => {
    const cipher = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
  const recipientPublic = recipient.e2eKeyPair.publicKey;
  const ephemeral = x25519GenerateKeyPair();
  // The protocol name is 31 bytes, so h starts as the name and one zero byte.
  let h = Buffer.concat([utf8('Noise_X_25519_ChaChaPoly_SHA256'), NUL]);
  let ck = h;
  let k;
  const mixHash = data => {
    h = hash(h, data);
  };
  const mixKey = ikm => {
    const temp = hmac(ck, ikm);
    ck = hmac(temp, Buffer.from([1]));
    k = hmac(temp, ck, Buffer.from([2]));
  };
  // Each encryption directly follows a MixKey, so every nonce here is zero.
  const encryptAndHash = plaintext => {
    const sealed = chacha(k, h, plaintext);
    mixHash(sealed);
    return sealed;
  };

  const plaintextTemplate = plaintextOf(metaText, content);
  mixHash(Buffer.concat([utf8('clawnet/1/e2e'), NUL, utf8(recipient.nodeId), NUL, utf8(MESSAGE_ID)]));
  mixHash(recipientPublic);
  mixHash(ephemeral.publicKey);
  mixKey(x25519(ephemeral.privateKey, recipientPublic));
  const sealedStatic = encryptAndHash(claimedStatic);
  // ss, computed from the recipient's side: DH(recipient private, claimed static public).
  mixKey(x25519(stolenPrivate, claimedStatic));
  const handshake = Buffer.concat([ephemeral.publicKey, sealedStatic, encryptAndHash(u32(plaintextTemplate.length))]);

  let plaintext = plaintextTemplate;
  const at = plaintextTemplate.indexOf(utf8(HS_SLOT));
  if (at >= 0) {
    const signature = utf8(sign(h));
    assert.equal(signature.length, HS_SLOT.length);
    plaintext = Buffer.from(plaintextTemplate);
    signature.copy(plaintext, at);
  }
  const transportKey = hmac(hmac(ck, EMPTY), Buffer.from([1]));
  const record = chacha(transportKey, EMPTY, plaintext);
  return Buffer.concat([Buffer.from([1]), u16(handshake.length), handshake, u16(record.length), record]);
}

test('a thief of the recipient e2e key cannot forge a message from another node (DESIGN.md 15.9)', () => {
  // The attacker has Bob's e2e private key (stolen) and Alice's public card, and nothing
  // of Alice's private keys. Mallory's own identity stands in for whatever keys the
  // attacker owns.
  const forge = (metaText, sign) =>
    kciForge({ claimedStatic: alice.e2eKeyPair.publicKey, recipient: bob, metaText, sign });
  const signedBy = (identity, domain = Domain.E2E_AUTH) => h => identity.sign(domain, h).toString('base64');

  // Control, proving the forgery is otherwise perfect: Noise_X accepts it, the card
  // verifies, and the static key matches the card. Were Alice to sign its handshake hash,
  // it would open as hers. The signature is therefore the only thing in the attacker's way.
  const control = open(forge(metaJson(alice.card), signedBy(alice)));
  assert.equal(control.senderId, alice.nodeId);
  assert.deepEqual(control.content, utf8('forged'));

  const wrongSignature = because(/sender signature over the handshake does not verify/);
  // What the attacker can actually do: sign with keys it owns ...
  assert.throws(() => open(forge(metaJson(alice.card), signedBy(mallory))), wrongSignature);
  // ... reuse a signature Alice made in a genuine message to Bob that it captured (and can
  // read, holding Bob's key) ...
  const captured = open(seal({ content: utf8('genuine') })).meta.hs;
  assert.throws(() => open(forge(metaJson(alice.card), () => captured)), wrongSignature);
  // ... reuse signatures Alice publishes for other purposes ...
  const cardSignature = alice.card.sig;
  const recordSignature = alice.signRecord('lsa', { seq: 1 }).sig;
  assert.throws(() => open(forge(metaJson(alice.card), () => cardSignature)), wrongSignature);
  assert.throws(() => open(forge(metaJson(alice.card), () => recordSignature)), wrongSignature);
  // ... or leave the signature out.
  assert.throws(
    () => open(forge(`{"card":${cardJson(alice.card)},"kind":"msg","ts":${NOW}}`, () => '')),
    because(/no well-formed sender signature/)
  );
  // Without Bob's key (here Mallory's own e2e key in its place) the same construction fails
  // at the Noise layer, even with Alice's signature: the theft is what makes the handshake
  // succeed, and the signature is what still stops the forgery.
  const withoutTheft = kciForge({
    claimedStatic: alice.e2eKeyPair.publicKey,
    recipient: bob,
    stolenPrivate: mallory.e2eKeyPair.privateKey,
    metaText: metaJson(alice.card),
    sign: signedBy(alice),
  });
  assert.throws(() => open(withoutTheft), because(/failed authentication/));
});

test('an authenticated sender still cannot bend the framing', () => {
  const content = randomBytes(1000);
  const plaintext = plaintextOf(metaJson(alice.card), content);
  const total = plaintext.length;
  assert.ok(open(rawSeal({ plaintext, chunkSizes: [total] })).content.equals(content));

  const bent = {
    'short first chunk': { chunkSizes: [10, total - 10] },
    'one byte per chunk at the end': { chunkSizes: [total - 1, 1] },
    'empty chunk appended': { chunkSizes: [total, 0] },
    'empty chunk first': { chunkSizes: [0, total] },
    'announces one byte less': { chunkSizes: [total], announced: total - 1 },
    'announces one byte more': { chunkSizes: [total], announced: total + 1 },
    'announces far more': { chunkSizes: [total], announced: 0xffffffff },
    'announces nothing': { chunkSizes: [total], announced: 0 },
    'announces only what was sent, but less than sealed': { chunkSizes: [total - 5], announced: total },
    'no chunks': { chunkSizes: [] },
    'wrong scheme byte': { chunkSizes: [total], scheme: 0x02 },
    'unknown scheme byte': { chunkSizes: [total], scheme: 0x00 },
    'five-byte length payload': { chunkSizes: [total], lengthPayload: Buffer.concat([u32(total), NUL]) },
    'three-byte length payload': { chunkSizes: [total], lengthPayload: u32(total).subarray(1) },
  };
  for (const [why, overrides] of Object.entries(bent)) {
    assert.throws(() => open(rawSeal({ plaintext, ...overrides })), AUTH, why);
  }
  // The length rule itself fires, before any record is decrypted: these bodies are not
  // merely failing authentication further down.
  for (const why of ['short first chunk', 'empty chunk appended', 'announces one byte less', 'announces far more', 'no chunks']) {
    assert.throws(() => open(rawSeal({ plaintext, ...bent[why] })), because(/does not match its announced length/), why);
  }

  // Empty and one-byte plaintexts authenticate but cannot hold a metadata length.
  assert.throws(() => open(rawSeal({ plaintext: EMPTY, chunkSizes: [] })), AUTH);
  assert.throws(() => open(rawSeal({ plaintext: EMPTY, chunkSizes: [0] })), AUTH);
  assert.throws(() => open(rawSeal({ plaintext: Buffer.from([0]), chunkSizes: [1] })), AUTH);

  // A big plaintext split one byte early: every record authenticates, the framing is not canonical.
  const big = plaintextOf(metaJson(alice.card), randomBytes(70000));
  assert.ok(open(rawSeal({ plaintext: big, chunkSizes: canonicalChunks(big.length) })).content.length === 70000);
  assert.throws(() => open(rawSeal({ plaintext: big, chunkSizes: [CHUNK - 1, big.length - CHUNK + 1] })), because(/not in canonical framing/));
  assert.throws(() => open(rawSeal({ plaintext: big, chunkSizes: [big.length - CHUNK, CHUNK] })), because(/not in canonical framing/));
});

test('metadata must be canonical JSON with a string kind, an integer ts and a valid card', () => {
  // Each variant carries a genuine signature, so it fails for the reason it is named after.
  const card = `${cardJson(alice.card)},${HS_FIELD}`;
  const attempt = metaText => {
    const plaintext = plaintextOf(metaText, utf8('x'));
    return () => open(rawSeal({ plaintext, chunkSizes: [plaintext.length] }));
  };
  assert.deepEqual(attempt(`{"card":${card},"kind":"msg","ts":${NOW}}`)().content, utf8('x'));

  const bad = {
    'whitespace': `{"card":${card}, "kind":"msg","ts":${NOW}}`,
    'keys out of order': `{"kind":"msg","card":${card},"ts":${NOW}}`,
    'duplicate key': `{"card":${card},"kind":"msg","kind":"msg","ts":${NOW}}`,
    'trailing newline': `{"card":${card},"kind":"msg","ts":${NOW}}\n`,
    'not JSON': `{"card":${card},"kind":"msg","ts":${NOW}`,
    'empty': '',
    'an array': `[${card},"msg",${NOW}]`,
    'a string': '"msg"',
    'null': 'null',
    'kind missing': `{"card":${card},"ts":${NOW}}`,
    'kind empty': `{"card":${card},"kind":"","ts":${NOW}}`,
    'kind a number': `{"card":${card},"kind":1,"ts":${NOW}}`,
    'kind an array': `{"card":${card},"kind":["msg"],"ts":${NOW}}`,
    'ts missing': `{"card":${card},"kind":"msg"}`,
    'ts a string': `{"card":${card},"kind":"msg","ts":"${NOW}"}`,
    'ts a float': `{"card":${card},"kind":"msg","ts":${NOW}.5}`,
    'ts an exponent': `{"card":${card},"kind":"msg","ts":1.7e12}`,
    'ts negative': `{"card":${card},"kind":"msg","ts":-1}`,
    'ts null': `{"card":${card},"kind":"msg","ts":null}`,
    'ts beyond the safe range': `{"card":${card},"kind":"msg","ts":9007199254740993}`,
    'card null': `{"card":null,${HS_FIELD},"kind":"msg","ts":${NOW}}`,
  };
  for (const [why, metaText] of Object.entries(bad)) assert.throws(attempt(metaText), AUTH, why);

  // Invalid UTF-8 in the metadata, and a metadata length that overruns the plaintext.
  const invalidUtf8 = Buffer.concat([u16(3), Buffer.from([0x22, 0xff, 0x22])]);
  assert.throws(() => open(rawSeal({ plaintext: invalidUtf8, chunkSizes: [invalidUtf8.length] })), AUTH);
  const good = plaintextOf(metaJson(alice.card));
  const overrun = Buffer.from(good);
  overrun.writeUInt16BE(good.length - 1, 0);
  assert.throws(() => open(rawSeal({ plaintext: overrun, chunkSizes: [overrun.length] })), AUTH);
  const underrun = Buffer.from(good);
  underrun.writeUInt16BE(good.length - 3, 0);
  assert.throws(() => open(rawSeal({ plaintext: underrun, chunkSizes: [underrun.length] })), AUTH);
});

test('stale and future-dated messages are rejected at the configured bounds', () => {
  assert.equal(DEFAULT_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_MAX_FUTURE_MS, 5 * 60 * 1000);
  const body = seal({ now: NOW });

  // Defaults.
  assert.equal(open(body, { now: NOW + DEFAULT_MAX_AGE_MS }).meta.ts, NOW);
  assert.throws(() => open(body, { now: NOW + DEFAULT_MAX_AGE_MS + 1 }), because(/older than the accepted age/));
  assert.equal(open(body, { now: NOW - DEFAULT_MAX_FUTURE_MS }).meta.ts, NOW);
  assert.throws(() => open(body, { now: NOW - DEFAULT_MAX_FUTURE_MS - 1 }), because(/too far in the future/));

  // Explicit bounds, inclusive on both sides.
  assert.equal(open(body, { now: NOW + 1000, maxAgeMs: 1000 }).meta.ts, NOW);
  assert.throws(() => open(body, { now: NOW + 1001, maxAgeMs: 1000 }), AUTH);
  assert.throws(() => open(body, { now: NOW + 1, maxAgeMs: 0 }), AUTH);
  assert.equal(open(body, { now: NOW - 50, maxFutureMs: 50 }).meta.ts, NOW);
  assert.throws(() => open(body, { now: NOW - 51, maxFutureMs: 50 }), AUTH);
  assert.throws(() => open(body, { now: NOW - 1, maxFutureMs: 0 }), AUTH);
  assert.equal(open(body, { now: NOW, maxAgeMs: 0, maxFutureMs: 0 }).meta.ts, NOW);

  // The clock may be a function or a number, on both sides.
  const viaClock = seal({ now: () => NOW + 5 });
  assert.equal(open(viaClock, { now: () => NOW + 5 }).meta.ts, NOW + 5);
  // Without an injected clock the system clock is used.
  const before = Date.now();
  const live = openMessage({ recipient: bob, dst: bob.nodeId, id: MESSAGE_ID, body: seal({ now: undefined }) });
  assert.ok(live.meta.ts >= before && live.meta.ts <= Date.now());

  // A sender cannot smuggle its own timestamp, card or signature past sealMessage.
  assert.throws(() => seal({ meta: { kind: 'msg', ts: 1 } }), CRYPTO);
  assert.throws(() => seal({ meta: { kind: 'msg', card: mallory.card } }), CRYPTO);
  assert.throws(() => seal({ meta: { kind: 'msg', hs: open(seal()).meta.hs } }), CRYPTO);
  assert.throws(() => seal({ meta: { kind: 'msg', hs: undefined } }), CRYPTO);
});

test('sealMessage validates its arguments', () => {
  const bad = [
    [{ sender: undefined }, 'no sender'],
    [{ sender: alice.toSecret() }, 'sender not an Identity'],
    [{ sender: { nodeId: alice.nodeId, card: alice.card, e2eKeyPair: alice.e2eKeyPair } }, 'sender look-alike'],
    [{ recipientE2eKey: undefined }, 'no recipient key'],
    [{ recipientE2eKey: bob.card.e2e }, 'recipient key as base64'],
    [{ recipientE2eKey: Buffer.alloc(31) }, 'short recipient key'],
    [{ recipientE2eKey: Buffer.alloc(32) }, 'small-order recipient key'],
    [{ dst: undefined }, 'no dst'],
    [{ dst: bob.nodeId.toUpperCase() }, 'uppercase dst'],
    [{ dst: bob.nodeId.slice(0, 51) }, 'short dst'],
    [{ id: undefined }, 'no id'],
    [{ id: MESSAGE_ID.toUpperCase() }, 'uppercase id'],
    [{ id: MESSAGE_ID.slice(1) }, 'short id'],
    [{ id: hex(MESSAGE_ID) }, 'id as bytes'],
    [{ meta: undefined }, 'no meta'],
    [{ meta: 'msg' }, 'meta as text'],
    [{ meta: ['msg'] }, 'meta as array'],
    [{ meta: {} }, 'meta without kind'],
    [{ meta: { kind: '' } }, 'empty kind'],
    [{ meta: { kind: 7 } }, 'numeric kind'],
    [{ meta: { kind: 'msg', note: 'x'.repeat(70000) } }, 'meta beyond 65535 bytes'],
    [{ content: 'text' }, 'content as text'],
    [{ content: null }, 'null content'],
    [{ content: Buffer.alloc(Limits.MAX_PACKET) }, 'content that cannot fit a packet'],
    [{ now: 1.5 }, 'fractional clock'],
    [{ now: () => NaN }, 'clock returning NaN'],
    [{ now: -1 }, 'negative clock'],
    [{ now: '1700000000000' }, 'clock as text'],
  ];
  for (const [overrides, why] of bad) assert.throws(() => seal(overrides), CRYPTO, why);
  assert.throws(() => sealMessage(), CRYPTO);
  assert.throws(() => seal({ meta: { kind: 'msg', ratio: 0.5 } }), CanonicalError);

  // The largest body that fits is accepted and still opens.
  const overhead = 2 + utf8(metaJson(alice.card)).length;
  const records = Math.ceil(Limits.MAX_PACKET / 65537);
  const largest = Limits.MAX_PACKET - (1 + 2 + HANDSHAKE) - records * 18 - overhead;
  const body = seal({ content: Buffer.alloc(largest, 0x61) });
  assert.equal(body.length, Limits.MAX_PACKET);
  assert.equal(open(body).content.length, largest);
  assert.throws(() => seal({ content: Buffer.alloc(largest + 1) }), CRYPTO);
});

test('openMessage separates local misuse (CryptoError) from bad input (AuthError)', () => {
  const body = seal();
  for (const overrides of [
    { recipient: undefined },
    { recipient: bob.toSecret() },
    { recipient: { nodeId: bob.nodeId, e2eKeyPair: bob.e2eKeyPair } },
    { now: 1.5 },
    { now: () => 'now' },
    { maxAgeMs: -1 },
    { maxAgeMs: Infinity },
    { maxAgeMs: '1000' },
    { maxFutureMs: -1 },
    { maxFutureMs: 0.5 },
  ]) {
    assert.throws(() => open(body, overrides), CRYPTO, inspect(overrides, { depth: 0 }));
  }
  assert.throws(() => openMessage(), CRYPTO);

  for (const [candidate, why] of [
    [undefined, 'missing'],
    [null, 'null'],
    [body.toString('base64'), 'text'],
    [[...body], 'array'],
    [EMPTY, 'empty'],
    [Buffer.from([1]), 'scheme byte only'],
    [Buffer.alloc(body.length), 'zeros'],
    [randomBytes(body.length), 'random'],
    [Buffer.alloc(Limits.MAX_PACKET + 1, 1), 'over the packet limit'],
  ]) {
    assert.throws(() => open(candidate), AUTH, why);
  }
  for (const id of [undefined, null, 7, MESSAGE_ID.toUpperCase(), `${MESSAGE_ID}0`]) {
    assert.throws(() => open(body, { id }), AUTH);
  }
  for (const dst of [undefined, null, 7, bob.nodeId.toUpperCase(), bob.signPublicKey]) {
    assert.throws(() => open(body, { dst }), AUTH);
  }
  // A Uint8Array that is a window into a larger buffer opens like a Buffer.
  const padded = Buffer.concat([randomBytes(7), body, randomBytes(5)]);
  const window = new Uint8Array(padded.buffer, padded.byteOffset + 7, body.length);
  assert.deepEqual(open(window).content, utf8('hello bob'));
});

// ---------------------------------------------------------------------------------------
// Scheme 0x02: file chunks
// ---------------------------------------------------------------------------------------

const TRANSFER_KEY = Buffer.alloc(32, 0x42);
const TRANSFER_ID = hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');

/** Scheme 2 exactly as DESIGN.md states it, straight from node:crypto. */
function referenceChunk(key, transferId, indexHex, plaintext) {
  const nonce = hex(`0000000000000000${indexHex}`);
  const ad = Buffer.concat([utf8('clawnet/1/file-chunk'), NUL, transferId, hex(indexHex)]);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([0x02]), transferId, hex(indexHex), sealed]);
}

test('a sealed chunk has the documented layout and opens again', () => {
  assert.equal(TRANSFER_ID_LENGTH, 16);
  assert.equal(MAX_CHUNK_INDEX, 0xffffffff);
  const plaintext = utf8('chunk payload');
  const cases = [
    [0, '00000000'],
    [1, '00000001'],
    [0x01020304, '01020304'],
    [0xffffffff, 'ffffffff'],
  ];
  for (const [index, indexHex] of cases) {
    const body = sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index, plaintext });
    assert.deepEqual(body, referenceChunk(TRANSFER_KEY, TRANSFER_ID, indexHex, plaintext), indexHex);
    assert.equal(body.length, 1 + 16 + 4 + plaintext.length + 16);
    assert.deepEqual(peekChunk(body), { transferId: TRANSFER_ID, index });
    assert.deepEqual(openChunk({ key: TRANSFER_KEY, body }), { transferId: TRANSFER_ID, index, plaintext });
  }
  // Sealing is deterministic, so a retransmitted chunk is byte-identical.
  assert.deepEqual(
    sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 5, plaintext }),
    sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 5, plaintext })
  );
});

test('chunks round-trip at sizes from empty to the default file chunk and beyond', () => {
  for (const size of [0, 1, 32 * 1024, 65536, 300000]) {
    const plaintext = randomBytes(size);
    const body = sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 7, plaintext });
    assert.equal(body.length, 21 + size + 16);
    assert.equal(size > 32 && body.includes(plaintext.subarray(0, 32)), false);
    const opened = openChunk({ key: TRANSFER_KEY, body: new Uint8Array(body) });
    assert.ok(opened.plaintext.equals(plaintext), `size ${size}`);
    assert.equal(opened.index, 7);
  }
});

test('every single-bit change to a sealed chunk is rejected', () => {
  const body = sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 3, plaintext: utf8('chunk payload') });
  let rejected = 0;
  for (let i = 0; i < body.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const tampered = Buffer.from(body);
      tampered[i] ^= 1 << bit;
      assert.throws(() => openChunk({ key: TRANSFER_KEY, body: tampered }), AUTH, `byte ${i} bit ${bit}`);
      rejected += 1;
    }
  }
  assert.equal(rejected, body.length * 8);
  for (let length = 0; length < body.length; length += 1) {
    assert.throws(() => openChunk({ key: TRANSFER_KEY, body: body.subarray(0, length) }), AUTH, `length ${length}`);
  }
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: Buffer.concat([body, NUL]) }), AUTH);
});

test('a chunk cannot be moved to another index, transfer or key', () => {
  const otherId = hex('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
  const three = sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 3, plaintext: utf8('chunk three') });
  const four = sealChunk({ key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 4, plaintext: utf8('chunk four!') });
  const foreign = sealChunk({ key: TRANSFER_KEY, transferId: otherId, index: 3, plaintext: utf8('chunk three') });
  assert.equal(three.length, four.length);
  const header = 21;

  // Headers exchanged: each body now claims the other's index.
  const threeAsFour = Buffer.concat([four.subarray(0, header), three.subarray(header)]);
  const fourAsThree = Buffer.concat([three.subarray(0, header), four.subarray(header)]);
  assert.deepEqual(peekChunk(threeAsFour), { transferId: TRANSFER_ID, index: 4 });
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: threeAsFour }), AUTH);
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: fourAsThree }), AUTH);

  // Transfer ids exchanged between two transfers that happen to share a key.
  const relabelled = Buffer.concat([foreign.subarray(0, header), three.subarray(header)]);
  assert.deepEqual(peekChunk(relabelled).transferId, otherId);
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: relabelled }), AUTH);
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: Buffer.concat([three.subarray(0, header), foreign.subarray(header)]) }), AUTH);

  // Another key, and a scheme-1 body where a chunk is expected.
  assert.throws(() => openChunk({ key: Buffer.alloc(32, 0x43), body: three }), AUTH);
  assert.throws(() => openChunk({ key: TRANSFER_KEY, body: seal() }), AUTH);
  assert.throws(() => peekChunk(seal()), AUTH);

  // The originals are untouched and still open.
  assert.deepEqual(openChunk({ key: TRANSFER_KEY, body: three }).plaintext, utf8('chunk three'));
  assert.deepEqual(openChunk({ key: TRANSFER_KEY, body: four }).plaintext, utf8('chunk four!'));
  assert.deepEqual(openChunk({ key: TRANSFER_KEY, body: foreign }).transferId, otherId);
});

test('chunk functions validate their arguments', () => {
  const good = { key: TRANSFER_KEY, transferId: TRANSFER_ID, index: 0, plaintext: utf8('x') };
  const body = sealChunk(good);
  const bad = [
    { key: undefined },
    { key: Buffer.alloc(31) },
    { key: TRANSFER_KEY.toString('hex') },
    { transferId: undefined },
    { transferId: Buffer.alloc(15) },
    { transferId: Buffer.alloc(17) },
    { transferId: TRANSFER_ID.toString('hex') },
    { index: undefined },
    { index: -1 },
    { index: 1.5 },
    { index: 2 ** 32 },
    { index: '0' },
    { index: 0n },
    { plaintext: undefined },
    { plaintext: 'x' },
    { plaintext: Buffer.alloc(Limits.MAX_PACKET) },
  ];
  for (const overrides of bad) assert.throws(() => sealChunk({ ...good, ...overrides }), CRYPTO, inspect(overrides, { depth: 0 }));
  assert.throws(() => sealChunk(), CRYPTO);
  assert.throws(() => openChunk(), CRYPTO);
  assert.throws(() => openChunk({ key: Buffer.alloc(16), body }), CRYPTO);
  assert.throws(() => openChunk({ key: 'k'.repeat(32), body }), CRYPTO);
  for (const candidate of [undefined, null, 'body', [...body], EMPTY, Buffer.alloc(36, 2), Buffer.alloc(Limits.MAX_PACKET + 1, 2)]) {
    assert.throws(() => peekChunk(candidate), AUTH);
    assert.throws(() => openChunk({ key: TRANSFER_KEY, body: candidate }), AUTH);
  }
  // 37 bytes is the shortest well-formed body: header, empty ciphertext, tag.
  const empty = sealChunk({ ...good, plaintext: EMPTY });
  assert.equal(empty.length, 37);
  assert.deepEqual(openChunk({ key: TRANSFER_KEY, body: empty }).plaintext, EMPTY);
});

// ---------------------------------------------------------------------------------------
// Casts
// ---------------------------------------------------------------------------------------

const CHANNEL_KEY = Buffer.alloc(32, 0x07);
const CHAN = '0123456789abcdef0123456789abcdef';
const CAST = Object.freeze({ type: 'cast', origin: alice.nodeId, chan: CHAN, n: 12, ts: NOW, enc: true });

/** DESIGN.md 15.24 written out with node:crypto and canonical JSON typed by hand. */
function referenceCast(channelKey, fields, salt, plaintext) {
  const bound = utf8(
    `{"chan":"${fields.chan}","enc":true,"n":${fields.n},"origin":"${fields.origin}",` +
      `"salt":"${salt.toString('base64')}","ts":${fields.ts},"type":"cast"}`
  );
  const info = Buffer.concat([utf8('clawnet/1/cast'), NUL, bound]);
  const key = Buffer.from(hkdfSync('sha256', channelKey, salt, info, 32));
  const cipher = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
  cipher.setAAD(bound, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

test('cast encryption is bound to its record: HKDF info and associated data carry the fields', () => {
  const plaintext = utf8('to the whole channel');
  const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext });
  assert.equal(CAST_SALT_LENGTH, 32);
  assert.equal(salt.length, 32);
  assert.equal(ciphertext.length, plaintext.length + 16);
  assert.equal(ciphertext.includes(plaintext.subarray(0, 8)), false);
  assert.deepEqual(ciphertext, referenceCast(CHANNEL_KEY, CAST, salt, plaintext));

  assert.deepEqual(castDecrypt({ channelKey: CHANNEL_KEY, fields: CAST, salt, ciphertext }), plaintext);
  // Field order is irrelevant: the fields are canonicalised.
  const reordered = Object.fromEntries(Object.entries(CAST).reverse());
  assert.deepEqual(castDecrypt({ channelKey: CHANNEL_KEY, fields: reordered, salt, ciphertext }), plaintext);
  // A record that went through JSON, as every received cast does, still decrypts.
  assert.deepEqual(castDecrypt({ channelKey: CHANNEL_KEY, fields: JSON.parse(JSON.stringify(CAST)), salt, ciphertext }), plaintext);
});

test('every cast gets a fresh salt, so the zero nonce never repeats under one key', () => {
  const plaintext = utf8('same message');
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext });
    seen.add(salt.toString('hex'));
    seen.add(ciphertext.toString('hex'));
  }
  assert.equal(seen.size, 128);
  // Empty bodies work, and so does the largest body a cast may have.
  for (const size of [0, Limits.MAX_CAST_BODY]) {
    const body = randomBytes(size);
    const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext: body });
    assert.equal(ciphertext.length, size + 16);
    assert.deepEqual(castDecrypt({ channelKey: CHANNEL_KEY, fields: CAST, salt, ciphertext }), body);
  }
});

test('a cast re-labelled with another origin, counter, channel or time does not decrypt', () => {
  const plaintext = utf8('members only');
  const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext });
  const good = { channelKey: CHANNEL_KEY, fields: CAST, salt, ciphertext };
  assert.deepEqual(castDecrypt(good), plaintext);

  // Each of these is a well-formed record a non-member could sign as its own (or replay
  // under another label) without knowing the channel key. Each fails at the AEAD tag.
  const relabelled = {
    'another origin (re-signed by a non-member)': { ...CAST, origin: mallory.nodeId },
    'another counter': { ...CAST, n: 13 },
    'counter zero': { ...CAST, n: 0 },
    'another channel': { ...CAST, chan: 'f'.repeat(32) },
    'another timestamp': { ...CAST, ts: NOW + 1 },
    'an earlier timestamp': { ...CAST, ts: NOW - 60000 },
  };
  for (const [why, fields] of Object.entries(relabelled)) {
    assert.throws(() => castDecrypt({ ...good, fields }), because(/failed authentication/), why);
  }
  // The salt is bound as well, in the HKDF salt and in the bound fields.
  const flip = (buffer, index = 0) => {
    const copy = Buffer.from(buffer);
    copy[index] ^= 1;
    return copy;
  };
  assert.throws(() => castDecrypt({ ...good, salt: flip(salt) }), because(/failed authentication/));
  const otherSalt = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext }).salt;
  assert.throws(() => castDecrypt({ ...good, salt: otherSalt }), because(/failed authentication/));
  assert.throws(() => castDecrypt({ ...good, channelKey: flip(CHANNEL_KEY) }), because(/failed authentication/));

  let rejected = 0;
  for (let i = 0; i < ciphertext.length; i += 1) {
    assert.throws(() => castDecrypt({ ...good, ciphertext: flip(ciphertext, i) }), AUTH, `byte ${i}`);
    rejected += 1;
  }
  assert.equal(rejected, ciphertext.length);
});

test('castDecrypt treats every malformed received value as AuthError', () => {
  const plaintext = utf8('members only');
  const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext });
  const good = { channelKey: CHANNEL_KEY, fields: CAST, salt, ciphertext };
  const { enc: _enc, ...withoutEnc } = CAST;
  const malformedFields = {
    'enc false': { ...CAST, enc: false },
    'enc missing': withoutEnc,
    'type lsa': { ...CAST, type: 'lsa' },
    'an extra field': { ...CAST, extra: 1 },
    'the salt as a field': { ...CAST, salt: salt.toString('base64') },
    'the body as a field': { ...CAST, body: ciphertext.toString('base64') },
    'non-canonical origin': { ...CAST, origin: `${alice.nodeId.slice(0, 51)}b` },
    'uppercase channel': { ...CAST, chan: CHAN.toUpperCase() },
    'short channel': { ...CAST, chan: CHAN.slice(1) },
    'fractional counter': { ...CAST, n: 1.5 },
    'negative counter': { ...CAST, n: -1 },
    'counter as text': { ...CAST, n: '12' },
    'timestamp beyond the safe range': { ...CAST, ts: 2 ** 53 },
    'empty object': {},
    'not an object': 'cast',
    null: null,
    array: [CAST],
  };
  for (const [why, fields] of Object.entries(malformedFields)) {
    assert.throws(() => castDecrypt({ ...good, fields }), because(/cast fields are malformed/), why);
  }
  const malformed = {
    'a short salt': { salt: salt.subarray(0, 31) },
    'a long salt': { salt: Buffer.concat([salt, NUL]) },
    'salt as base64': { salt: salt.toString('base64') },
    'no salt': { salt: undefined },
    'truncated ciphertext': { ciphertext: ciphertext.subarray(0, ciphertext.length - 1) },
    'ciphertext shorter than a tag': { ciphertext: ciphertext.subarray(0, 15) },
    'empty ciphertext': { ciphertext: EMPTY },
    'ciphertext as text': { ciphertext: ciphertext.toString('base64') },
    'no ciphertext': { ciphertext: undefined },
    'a ciphertext beyond the cast body limit': { ciphertext: Buffer.alloc(Limits.MAX_CAST_BODY + 17) },
  };
  for (const [why, overrides] of Object.entries(malformed)) {
    assert.throws(() => castDecrypt({ ...good, ...overrides }), AUTH, why);
  }
});

test('cast functions validate their local arguments', () => {
  const plaintext = utf8('x');
  const { salt, ciphertext } = castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext });
  for (const channelKey of [undefined, null, Buffer.alloc(31), Buffer.alloc(33), CHANNEL_KEY.toString('hex')]) {
    assert.throws(() => castEncrypt({ channelKey, fields: CAST, plaintext }), CRYPTO);
    assert.throws(() => castDecrypt({ channelKey, fields: CAST, salt, ciphertext }), CRYPTO);
  }
  for (const fields of [undefined, null, 'cast', [CAST], new Map(Object.entries(CAST)), {}, { ...CAST, enc: false }, { ...CAST, n: 1.5 }, { ...CAST, salt: 'x' }]) {
    assert.throws(() => castEncrypt({ channelKey: CHANNEL_KEY, fields, plaintext }), CRYPTO, inspect(fields));
  }
  assert.throws(() => castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext: 'x' }), CRYPTO);
  assert.throws(() => castEncrypt({ channelKey: CHANNEL_KEY, fields: CAST, plaintext: Buffer.alloc(Limits.MAX_CAST_BODY + 1) }), CRYPTO);
  assert.throws(() => castEncrypt(), CRYPTO);
  assert.throws(() => castDecrypt(), CRYPTO);
});

// ---------------------------------------------------------------------------------------
// Beacon MAC (DESIGN.md 15.23)
// ---------------------------------------------------------------------------------------

const NETWORK_KEY = Buffer.alloc(32, 0x5a);

test('deriveBeaconKey is HKDF-SHA256 with an empty salt and the beacon domain as info', () => {
  const key = deriveBeaconKey(NETWORK_KEY);
  assert.equal(key.length, 32);
  assert.deepEqual(key, Buffer.from(hkdfSync('sha256', NETWORK_KEY, EMPTY, utf8('clawnet/1/beacon'), 32)));
  // RFC 5869 written out: PRK = HMAC(empty salt, IKM); OKM = HMAC(PRK, info || 0x01).
  const prk = createHmac('sha256', EMPTY).update(NETWORK_KEY).digest();
  assert.deepEqual(key, createHmac('sha256', prk).update(utf8('clawnet/1/beacon')).update(Buffer.from([1])).digest());
  // A key of its own: not the network key, and different for another network key.
  assert.notDeepEqual(key, NETWORK_KEY);
  assert.notDeepEqual(deriveBeaconKey(Buffer.alloc(32, 0x5b)), key);
  assert.deepEqual(deriveBeaconKey(new Uint8Array(NETWORK_KEY)), key);
  for (const value of [undefined, null, Buffer.alloc(31), Buffer.alloc(33), NETWORK_KEY.toString('hex')]) {
    assert.throws(() => deriveBeaconKey(value), CRYPTO, inspect(value));
  }
});

test('beaconMac is HMAC-SHA256 and verifyBeaconMac accepts exactly that MAC', () => {
  const key = deriveBeaconKey(NETWORK_KEY);
  const beacon = utf8('{"type":"beacon","port":47470}');
  const mac = beaconMac(key, beacon);
  assert.equal(BEACON_MAC_LENGTH, 32);
  assert.equal(mac.length, BEACON_MAC_LENGTH);
  assert.deepEqual(mac, createHmac('sha256', key).update(beacon).digest());
  assert.equal(verifyBeaconMac(key, beacon, mac), true);
  assert.equal(verifyBeaconMac(key, new Uint8Array(beacon), new Uint8Array(mac)), true);

  let rejected = 0;
  for (let i = 0; i < mac.length; i += 1) {
    const tampered = Buffer.from(mac);
    tampered[i] ^= 1 << (i % 8);
    assert.equal(verifyBeaconMac(key, beacon, tampered), false, `mac byte ${i}`);
    rejected += 1;
  }
  assert.equal(rejected, 32);
  const altered = Buffer.from(beacon);
  altered[5] ^= 1;
  assert.equal(verifyBeaconMac(key, altered, mac), false);
  assert.equal(verifyBeaconMac(key, Buffer.concat([beacon, NUL]), mac), false);
  // A non-member's key, and the network key used directly instead of the derived one.
  assert.equal(verifyBeaconMac(deriveBeaconKey(Buffer.alloc(32, 0x5b)), beacon, mac), false);
  assert.equal(verifyBeaconMac(key, beacon, beaconMac(NETWORK_KEY, beacon)), false);
  // Malformed received values are false, never an exception.
  for (const value of [undefined, null, 'mac', mac.toString('hex'), mac.subarray(0, 31), Buffer.concat([mac, NUL]), EMPTY, [...mac]]) {
    assert.equal(verifyBeaconMac(key, beacon, value), false, inspect(value));
  }
  for (const value of [undefined, null, beacon.toString(), [...beacon]]) {
    assert.equal(verifyBeaconMac(key, value, mac), false, inspect(value));
  }
  // The key is local: a malformed one is a programming error.
  for (const bad of [undefined, Buffer.alloc(31), 'k'.repeat(32)]) {
    assert.throws(() => beaconMac(bad, beacon), CRYPTO);
    assert.throws(() => verifyBeaconMac(bad, beacon, mac), CRYPTO);
  }
  assert.throws(() => beaconMac(key, 'beacon'), CRYPTO);
});

// ---------------------------------------------------------------------------------------
// Channel wire ids
// ---------------------------------------------------------------------------------------

test('channelWireId matches the formula, including independently computed answers', () => {
  // Computed with Python's hashlib and hmac from the definition in the assignment.
  assert.equal(channelWireId('general'), '587a92dd9809976985c393a0bceb18bb');
  assert.equal(channelWireId('general', CHANNEL_KEY), 'f7b92b7097203668d11d49e4fb477af0');
  const accented = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)}`;
  assert.equal(channelWireId(accented), '92b5da24b993f1620836d598008a55b4');

  // And again here, with HKDF written out as HMAC (RFC 5869 with the default zero salt).
  const reference = (name, key) => {
    const domain = utf8('clawnet/1/channel-id');
    const hash = createHash('sha256').update(domain).update(NUL).update(utf8(name)).update(NUL);
    if (key !== undefined) {
      const prk = createHmac('sha256', Buffer.alloc(32)).update(key).digest();
      hash.update(createHmac('sha256', prk).update(domain).update(Buffer.from([1])).digest());
    }
    return hash.digest().subarray(0, 16).toString('hex');
  };
  for (const name of ['general', 'a', 'ops/alerts', accented, 'x'.repeat(500)]) {
    for (const key of [undefined, CHANNEL_KEY, Buffer.alloc(32), randomBytes(32)]) {
      const id = channelWireId(name, key);
      assert.equal(id, reference(name, key), name);
      assert.match(id, CHANNEL_ID_PATTERN);
    }
  }
});

test('channelWireId separates names, keys, and keyed from public channels', () => {
  const ids = new Set([
    channelWireId('general'),
    channelWireId('general', CHANNEL_KEY),
    channelWireId('general', Buffer.alloc(32, 0x08)),
    channelWireId('General'),
    channelWireId('general '),
    channelWireId('genera'),
    channelWireId('l', CHANNEL_KEY),
  ]);
  assert.equal(ids.size, 7);
  assert.equal(channelWireId('general', null), channelWireId('general'));
  assert.equal(channelWireId('general', new Uint8Array(CHANNEL_KEY)), channelWireId('general', CHANNEL_KEY));
  // The id of a keyed channel gives away neither the key nor the name.
  const id = hex(channelWireId('general', CHANNEL_KEY));
  assert.equal(id.includes(utf8('general')), false);
  assert.equal(CHANNEL_KEY.includes(id.subarray(0, 4)), false);

  for (const name of ['', 'a\x00b', '\x00', String.fromCharCode(0xd83d), undefined, null, 7, utf8('general'), ['general']]) {
    assert.throws(() => channelWireId(name), CRYPTO, inspect(name));
  }
  for (const key of [Buffer.alloc(31), Buffer.alloc(33), CHANNEL_KEY.toString('hex'), 7, {}]) {
    assert.throws(() => channelWireId('general', key), CRYPTO, inspect(key));
  }
});
