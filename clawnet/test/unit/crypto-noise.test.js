import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

import {
  CipherState,
  HandshakeState,
  NOISE_MAX_MESSAGE,
  NOISE_MAX_PLAINTEXT,
  NOISE_PATTERNS,
  protocolName,
} from '../../src/core/crypto/noise.js';
import { x25519, x25519PublicFromPrivate } from '../../src/core/crypto/primitives.js';
import { AuthError, CryptoError, StateError } from '../../src/core/errors.js';
import { Limits, NoiseProtocol } from '../../src/core/wire/types.js';

const vectorFile = JSON.parse(
  readFileSync(new URL('../vectors/noise-vectors.json', import.meta.url), 'utf8')
);

const hex = text => Buffer.from(text, 'hex');
const utf8 = text => Buffer.from(text, 'utf8');
const EMPTY = Buffer.alloc(0);
const SUITE_NAME = /^Noise_([A-Za-z0-9+]+)_25519_ChaChaPoly_SHA256$/;

const optionalHex = value => (value === undefined ? undefined : hex(value));
const keyPair = privateHex =>
  privateHex === undefined
    ? undefined
    : { privateKey: hex(privateHex), publicKey: x25519PublicFromPrivate(hex(privateHex)) };

function singlePsk(psks) {
  if (psks === undefined || psks.length === 0) return undefined;
  assert.equal(psks.length, 1, 'only single-psk patterns are supported');
  return hex(psks[0]);
}

/** Small-order points on Curve25519, as listed by libsodium. */
const LOW_ORDER_POINTS = [
  '00'.repeat(32),
  `01${'00'.repeat(31)}`,
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  `ec${'ff'.repeat(30)}7f`,
  `ed${'ff'.repeat(30)}7f`,
  `ee${'ff'.repeat(30)}7f`,
].map(hex);

// ---------------------------------------------------------------------------------------
// Published test vectors. Every message of every vector, in both directions.
// ---------------------------------------------------------------------------------------

/**
 * Drive both parties through one published vector. Returns how many handshake and
 * transport messages were compared, so callers can assert that the checks really ran.
 */
function runVector(vector) {
  const pattern = SUITE_NAME.exec(vector.protocol_name)[1];
  const initiator = new HandshakeState({
    pattern,
    initiator: true,
    prologue: hex(vector.init_prologue),
    s: keyPair(vector.init_static),
    e: keyPair(vector.init_ephemeral),
    rs: optionalHex(vector.init_remote_static),
    psk: singlePsk(vector.init_psks),
  });
  const responder = new HandshakeState({
    pattern,
    initiator: false,
    prologue: hex(vector.resp_prologue),
    s: keyPair(vector.resp_static),
    e: keyPair(vector.resp_ephemeral),
    rs: optionalHex(vector.resp_remote_static),
    psk: singlePsk(vector.resp_psks),
  });
  const oneWay = /^[NKX](psk\d)?$/.test(pattern);

  let handshakeMessages = 0;
  let transportMessages = 0;
  let initiatorCiphers = null;
  let responderCiphers = null;

  vector.messages.forEach((message, index) => {
    const where = `${vector.protocol_name} message ${index}`;
    const payload = hex(message.payload);
    if (!initiator.isComplete) {
      const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
      const written = sender.writeMessage(payload);
      assert.equal(written.toString('hex'), message.ciphertext, `${where}: handshake ciphertext`);
      assert.deepEqual(receiver.readMessage(hex(message.ciphertext)), payload, `${where}: handshake payload`);
      handshakeMessages += 1;
      assert.equal(initiator.isComplete, responder.isComplete, `${where}: both finish together`);
      if (initiator.isComplete) {
        if (vector.handshake_hash !== undefined) {
          assert.equal(initiator.handshakeHash.toString('hex'), vector.handshake_hash, `${where}: initiator hash`);
          assert.equal(responder.handshakeHash.toString('hex'), vector.handshake_hash, `${where}: responder hash`);
        }
        assert.deepEqual(initiator.handshakeHash, responder.handshakeHash);
        initiatorCiphers = initiator.split();
        responderCiphers = responder.split();
      }
      return;
    }
    // Transport phase. After a one-way pattern only the initiator sends (section 7.4);
    // otherwise the parties keep alternating.
    const fromInitiator = oneWay || index % 2 === 0;
    const tx = fromInitiator ? initiatorCiphers.tx : responderCiphers.tx;
    const rx = fromInitiator ? responderCiphers.rx : initiatorCiphers.rx;
    assert.equal(tx.encryptWithAd(EMPTY, payload).toString('hex'), message.ciphertext, `${where}: transport ciphertext`);
    assert.deepEqual(rx.decryptWithAd(EMPTY, hex(message.ciphertext)), payload, `${where}: transport payload`);
    transportMessages += 1;
  });

  // The static keys each side ends up attributing to the other.
  const expectStatic = (handshake, privateHex, who) => {
    if (privateHex === undefined) assert.equal(handshake.remoteStaticKey, null, who);
    else assert.deepEqual(handshake.remoteStaticKey, x25519PublicFromPrivate(hex(privateHex)), who);
  };
  expectStatic(initiator, vector.resp_static, 'initiator view of responder static');
  expectStatic(responder, vector.init_static, 'responder view of initiator static');
  if (vector.init_remote_static !== undefined) {
    assert.equal(x25519PublicFromPrivate(hex(vector.resp_static)).toString('hex'), vector.init_remote_static);
  }
  return { handshakeMessages, transportMessages };
}

for (const vector of vectorFile.vectors) {
  test(`published vector: ${vector.source} ${vector.protocol_name}`, () => {
    const { handshakeMessages, transportMessages } = runVector(vector);
    assert.equal(handshakeMessages + transportMessages, vector.messages.length);
    assert.ok(handshakeMessages >= 1 && handshakeMessages <= 3);
    assert.ok(transportMessages >= 1, 'vector must exercise the transport ciphers after split');
  });
}

/**
 * Supported patterns for which neither pinned source publishes a vector. Each one is listed
 * in NOISE-VECTORS.md with the reason; the test below fails if a vector for it is ever
 * added to the file, so that the entry is then removed and the vector actually runs.
 */
const WITHOUT_PUBLISHED_VECTOR = ['XXpsk0'];

test('the vector file covers what it must', () => {
  const vectors = vectorFile.vectors;
  const names = source => vectors.filter(v => v.source === source).map(v => SUITE_NAME.exec(v.protocol_name)[1]);
  assert.equal(vectors.length, 51);

  // Every supported pattern has a vector from cacophony, with a handshake hash, except the
  // ones listed as having none anywhere.
  const verified = NOISE_PATTERNS.filter(name => !WITHOUT_PUBLISHED_VECTOR.includes(name));
  assert.equal(verified.length, NOISE_PATTERNS.length - WITHOUT_PUBLISHED_VECTOR.length);
  assert.deepEqual([...names('cacophony')].sort(), [...verified].sort());
  for (const name of WITHOUT_PUBLISHED_VECTOR) {
    assert.ok(NOISE_PATTERNS.includes(name), name);
    assert.ok(!names('cacophony').includes(name) && !names('snow').includes(name), name);
  }
  for (const vector of vectors.filter(v => v.source === 'cacophony')) {
    assert.match(vector.handshake_hash, /^[0-9a-f]{64}$/, vector.protocol_name);
  }
  // The patterns ClawNet uses. XXpsk0 (private networks) has no published vector; the
  // tokens and rules it is made of are covered by NNpsk0, NKpsk0, KNpsk0, KKpsk0 (psk first
  // in the first message, then "e") and by XX and XXpsk3 (the XX tokens, with and without
  // the psk rule for "e").
  for (const required of ['XX', 'X', 'XXpsk3', 'NNpsk0', 'NKpsk0', 'KNpsk0', 'KKpsk0']) {
    assert.ok(names('cacophony').includes(required), required);
  }
  // A second, unrelated implementation agrees on every fundamental pattern.
  const fundamental = NOISE_PATTERNS.filter(name => !name.includes('psk'));
  assert.equal(fundamental.length, 15);
  assert.deepEqual([...names('snow')].sort(), [...fundamental].sort());

  for (const source of ['cacophony', 'snow']) {
    const entry = vectorFile.sources[source];
    assert.match(entry.url, /^https:\/\/raw\.githubusercontent\.com\/.+\/[0-9a-f]{40}\/.+/);
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.match(entry.retrieved, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.license.length > 0);
  }
});

// ---------------------------------------------------------------------------------------
// Behaviour around the vectors: failure paths, ordering, limits.
// Fixed keys make transcripts reproducible, so a tampered message can be replayed into a
// fresh HandshakeState for every position.
// ---------------------------------------------------------------------------------------

const fixedPair = fill => {
  const privateKey = Buffer.alloc(32, fill);
  return { privateKey, publicKey: x25519PublicFromPrivate(privateKey) };
};
const KEYS = {
  initiatorStatic: fixedPair(0x11),
  initiatorEphemeral: fixedPair(0x22),
  responderStatic: fixedPair(0x33),
  responderEphemeral: fixedPair(0x44),
};
const PROLOGUE = utf8('clawnet/1\x00testnet');
const PSK = Buffer.alloc(32, 0x55);

const xxInitiator = (overrides = {}) =>
  new HandshakeState({
    pattern: 'XX',
    initiator: true,
    prologue: PROLOGUE,
    s: KEYS.initiatorStatic,
    e: KEYS.initiatorEphemeral,
    ...overrides,
  });
const xxResponder = (overrides = {}) =>
  new HandshakeState({
    pattern: 'XX',
    initiator: false,
    prologue: PROLOGUE,
    s: KEYS.responderStatic,
    e: KEYS.responderEphemeral,
    ...overrides,
  });
const xInitiator = (overrides = {}) =>
  new HandshakeState({
    pattern: 'X',
    initiator: true,
    prologue: PROLOGUE,
    s: KEYS.initiatorStatic,
    rs: KEYS.responderStatic.publicKey,
    ...overrides,
  });
const xResponder = (overrides = {}) =>
  new HandshakeState({ pattern: 'X', initiator: false, prologue: PROLOGUE, s: KEYS.responderStatic, ...overrides });

/** A complete XX handshake with fixed keys; returns the three messages and both parties. */
function xxTranscript(initiatorOverrides, responderOverrides) {
  const initiator = xxInitiator(initiatorOverrides);
  const responder = xxResponder(responderOverrides);
  const m1 = initiator.writeMessage(utf8('one'));
  assert.deepEqual(responder.readMessage(m1), utf8('one'));
  const m2 = responder.writeMessage(utf8('two'));
  assert.deepEqual(initiator.readMessage(m2), utf8('two'));
  const m3 = initiator.writeMessage(utf8('three'));
  assert.deepEqual(responder.readMessage(m3), utf8('three'));
  return { initiator, responder, m1, m2, m3 };
}

function transportPair() {
  const { initiator, responder } = xxTranscript();
  return { a: initiator.split(), b: responder.split() };
}

/** ChaCha20-Poly1305 straight from node:crypto, with the nonce given as literal bytes. */
function chachaPoly(key, nonceHex, ad, plaintext) {
  const cipher = createCipheriv('chacha20-poly1305', key, hex(nonceHex), { authTagLength: 16 });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function assertUnusable(handshake) {
  assert.throws(() => handshake.writeMessage(EMPTY), StateError);
  assert.throws(() => handshake.readMessage(Buffer.alloc(64)), StateError);
  assert.throws(() => handshake.split(), StateError);
  assert.throws(() => handshake.handshakeHash, StateError);
  assert.equal(handshake.isComplete, false);
  assert.equal(handshake.remoteStaticKey, null);
}

test('protocolName builds the names ClawNet uses and refuses anything unsupported', () => {
  assert.equal(protocolName('XX'), 'Noise_XX_25519_ChaChaPoly_SHA256');
  assert.equal(protocolName('XXpsk0'), 'Noise_XXpsk0_25519_ChaChaPoly_SHA256');
  assert.equal(protocolName('XXpsk3'), 'Noise_XXpsk3_25519_ChaChaPoly_SHA256');
  assert.equal(protocolName('X'), 'Noise_X_25519_ChaChaPoly_SHA256');
  assert.equal(protocolName('XX'), NoiseProtocol.LINK);
  assert.equal(protocolName('XXpsk0'), NoiseProtocol.LINK_PSK);
  assert.equal(protocolName('X'), NoiseProtocol.E2E);
  // A complete name is accepted as well, so the constants in wire/types.js can be passed.
  for (const name of Object.values(NoiseProtocol)) assert.equal(protocolName(name), name);
  for (const name of NOISE_PATTERNS) assert.match(protocolName(name), SUITE_NAME);

  const unsupported = ['', 'xx', 'XX1', 'XXpsk4', 'XXpsk', 'xxpsk0', 'XXpsk0+psk3', 'XXpsk3+psk0', 'NNpsk1', 'XXfallback', 'Noise_XX_448_AESGCM_SHA512', 'Noise_XXpsk0_448_ChaChaPoly_SHA256', 'Noise_XX', 'toString', '__proto__', undefined, null, 7, ['XX']];
  for (const name of unsupported) {
    assert.throws(() => protocolName(name), { name: 'CryptoError', code: 'ERR_CRYPTO' }, inspect(name));
    assert.throws(() => new HandshakeState({ pattern: name, initiator: true, prologue: EMPTY }), CryptoError);
  }
});

test('the message limit is the one the specification and the wire layer use', () => {
  assert.equal(NOISE_MAX_MESSAGE, 65535);
  assert.equal(NOISE_MAX_MESSAGE, Limits.NOISE_MAX_MESSAGE);
  assert.equal(NOISE_MAX_PLAINTEXT, 65519);
});

test('a full XX handshake authenticates both static keys and yields matching ciphers', () => {
  const { initiator, responder, m1, m2, m3 } = xxTranscript();
  assert.equal(m1.length, 32 + 3);
  assert.equal(m2.length, 32 + 48 + 3 + 16);
  assert.equal(m3.length, 48 + 5 + 16);
  // Message 1 is in the clear by design; later payloads are not.
  assert.ok(m1.includes(utf8('one')));
  assert.ok(!m2.includes(utf8('two')));
  assert.ok(!m3.includes(utf8('three')));
  assert.ok(!m3.includes(KEYS.initiatorStatic.publicKey));

  assert.ok(initiator.isComplete && responder.isComplete);
  assert.deepEqual(initiator.remoteStaticKey, KEYS.responderStatic.publicKey);
  assert.deepEqual(responder.remoteStaticKey, KEYS.initiatorStatic.publicKey);
  assert.equal(initiator.handshakeHash.length, 32);
  assert.deepEqual(initiator.handshakeHash, responder.handshakeHash);

  const a = initiator.split();
  const b = responder.split();
  for (const cipher of [a.tx, a.rx, b.tx, b.rx]) {
    assert.ok(cipher instanceof CipherState);
    assert.equal(cipher.hasKey(), true);
    assert.equal(cipher.nonce, 0n);
  }
  const ad = utf8('ad');
  assert.deepEqual(b.rx.decryptWithAd(ad, a.tx.encryptWithAd(ad, utf8('to responder'))), utf8('to responder'));
  assert.deepEqual(a.rx.decryptWithAd(ad, b.tx.encryptWithAd(ad, utf8('to initiator'))), utf8('to initiator'));
  // The two directions use different keys: a party cannot read back what it sent.
  assert.throws(() => a.rx.decryptWithAd(ad, a.tx.encryptWithAd(ad, utf8('loop'))), AuthError);
});

test('getters hand out copies, not the internal buffers', () => {
  const { initiator } = xxTranscript();
  initiator.remoteStaticKey.fill(0);
  initiator.handshakeHash.fill(0);
  assert.deepEqual(initiator.remoteStaticKey, KEYS.responderStatic.publicKey);
  assert.notDeepEqual(initiator.handshakeHash, Buffer.alloc(32));
});

test('the remote static key is null until the message carrying it has been read', () => {
  const initiator = xxInitiator();
  const responder = xxResponder();
  assert.equal(initiator.remoteStaticKey, null);
  responder.readMessage(initiator.writeMessage());
  assert.equal(responder.remoteStaticKey, null);
  initiator.readMessage(responder.writeMessage());
  assert.deepEqual(initiator.remoteStaticKey, KEYS.responderStatic.publicKey);
  assert.equal(responder.remoteStaticKey, null);
  responder.readMessage(initiator.writeMessage());
  assert.deepEqual(responder.remoteStaticKey, KEYS.initiatorStatic.publicKey);
});

test('without a fixed ephemeral every handshake uses a fresh one', () => {
  const first = xxInitiator({ e: undefined }).writeMessage();
  const second = xxInitiator({ e: undefined }).writeMessage();
  assert.equal(first.length, 32);
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(first, KEYS.initiatorEphemeral.publicKey);

  const sealOnce = () => {
    const handshake = xInitiator();
    const message = handshake.writeMessage(utf8('same payload'));
    return { message, hash: handshake.handshakeHash };
  };
  const a = sealOnce();
  const b = sealOnce();
  assert.notDeepEqual(a.message, b.message);
  assert.notDeepEqual(a.hash, b.hash);
});

test('a one-way handshake gives the initiator only tx and the responder only rx', () => {
  const initiator = xInitiator();
  const responder = xResponder();
  const message = initiator.writeMessage(utf8('sealed'));
  assert.equal(message.length, 32 + 48 + 6 + 16);
  assert.ok(!message.includes(KEYS.initiatorStatic.publicKey));
  assert.deepEqual(responder.readMessage(message), utf8('sealed'));
  assert.deepEqual(responder.remoteStaticKey, KEYS.initiatorStatic.publicKey);
  const sending = initiator.split();
  const receiving = responder.split();
  assert.equal(sending.rx, null);
  assert.equal(receiving.tx, null);
  assert.deepEqual(receiving.rx.decryptWithAd(EMPTY, sending.tx.encryptWithAd(EMPTY, utf8('more'))), utf8('more'));
});

test('a flipped bit anywhere in handshake message 2 or 3 is rejected and kills the handshake', () => {
  const { m1, m2, m3 } = xxTranscript();
  let rejected = 0;
  for (let i = 0; i < m2.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const initiator = xxInitiator();
      assert.deepEqual(initiator.writeMessage(utf8('one')), m1);
      const tampered = Buffer.from(m2);
      tampered[i] ^= 1 << bit;
      assert.throws(() => initiator.readMessage(tampered), { name: 'AuthError', code: 'ERR_AUTH' }, `m2 byte ${i} bit ${bit}`);
      if (bit === 0) assertUnusable(initiator);
      rejected += 1;
    }
  }
  assert.equal(rejected, m2.length * 8);

  rejected = 0;
  for (let i = 0; i < m3.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const responder = xxResponder();
      responder.readMessage(m1);
      assert.deepEqual(responder.writeMessage(utf8('two')), m2);
      const tampered = Buffer.from(m3);
      tampered[i] ^= 1 << bit;
      assert.throws(() => responder.readMessage(tampered), { name: 'AuthError', code: 'ERR_AUTH' }, `m3 byte ${i} bit ${bit}`);
      if (bit === 0) assertUnusable(responder);
      rejected += 1;
    }
  }
  assert.equal(rejected, m3.length * 8);
});

test('truncated or extended handshake messages are rejected', () => {
  const { m1, m2, m3 } = xxTranscript();
  let rejected = 0;
  for (let length = 0; length <= m2.length + 1; length += 1) {
    if (length === m2.length) continue;
    const initiator = xxInitiator();
    initiator.writeMessage(utf8('one'));
    const altered = length < m2.length ? m2.subarray(0, length) : Buffer.concat([m2, Buffer.from([0])]);
    assert.throws(() => initiator.readMessage(altered), AuthError, `m2 length ${length}`);
    assertUnusable(initiator);
    rejected += 1;
  }
  assert.equal(rejected, m2.length + 1);

  rejected = 0;
  for (let length = 0; length <= m3.length + 1; length += 1) {
    if (length === m3.length) continue;
    const responder = xxResponder();
    responder.readMessage(m1);
    responder.writeMessage(utf8('two'));
    const altered = length < m3.length ? m3.subarray(0, length) : Buffer.concat([m3, Buffer.from([0])]);
    assert.throws(() => responder.readMessage(altered), AuthError, `m3 length ${length}`);
    rejected += 1;
  }
  assert.equal(rejected, m3.length + 1);

  // Message 1 of XX has no payload tag, but it must still contain a whole public key.
  for (const length of [0, 1, 31]) {
    const responder = xxResponder();
    assert.throws(() => responder.readMessage(m1.subarray(0, length)), AuthError);
    assertUnusable(responder);
  }
});

test('tampering with the unencrypted first message surfaces at the next message', () => {
  const { m1 } = xxTranscript();
  for (const index of [0, 31, 32, m1.length - 1]) {
    const initiator = xxInitiator();
    initiator.writeMessage(utf8('one'));
    const responder = xxResponder();
    const tampered = Buffer.from(m1);
    tampered[index] ^= 0x80;
    // The responder cannot tell: nothing in message 1 is authenticated yet.
    responder.readMessage(tampered);
    const m2 = responder.writeMessage(utf8('two'));
    // The initiator can: its transcript hash no longer matches the responder's.
    assert.throws(() => initiator.readMessage(m2), AuthError, `m1 byte ${index}`);
    assertUnusable(initiator);
  }
});

test('a message from another session is rejected', () => {
  // A genuine message 2, produced by the real responder for the default initiator.
  const { m2 } = xxTranscript();

  // Replayed into a session of the same initiator that used a different ephemeral key:
  // same static keys, same prologue, same payloads, yet the transcript differs.
  const otherSession = xxInitiator({ e: fixedPair(0x77) });
  otherSession.writeMessage(utf8('one'));
  assert.throws(() => otherSession.readMessage(m2), { name: 'AuthError', code: 'ERR_AUTH' });
  assertUnusable(otherSession);

  // Control: the session it was made for accepts it.
  const sameSession = xxInitiator();
  sameSession.writeMessage(utf8('one'));
  assert.deepEqual(sameSession.readMessage(m2), utf8('two'));
});

test('a different prologue makes the handshake fail', () => {
  const other = utf8('clawnet/1\x00othernet');
  // XX: the first authenticated message is message 2.
  const initiator = xxInitiator({ prologue: other });
  const responder = xxResponder();
  responder.readMessage(initiator.writeMessage(utf8('one')));
  const m2 = responder.writeMessage(utf8('two'));
  assert.throws(() => initiator.readMessage(m2), { name: 'AuthError', code: 'ERR_AUTH' });
  assertUnusable(initiator);

  // X: the only message is authenticated.
  const sealed = xInitiator({ prologue: other }).writeMessage(utf8('sealed'));
  const opener = xResponder();
  assert.throws(() => opener.readMessage(sealed), AuthError);
  assertUnusable(opener);

  // Control: with matching prologues the very same flow succeeds.
  assert.deepEqual(xResponder({ prologue: other }).readMessage(sealed), utf8('sealed'));
  // An empty prologue is a prologue like any other.
  const blank = xInitiator({ prologue: EMPTY }).writeMessage(utf8('sealed'));
  assert.deepEqual(xResponder({ prologue: EMPTY }).readMessage(blank), utf8('sealed'));
  assert.throws(() => xResponder().readMessage(blank), AuthError);
});

test('XXpsk3 completes only when both sides hold the same pre-shared key', () => {
  const run = (initiatorPsk, responderPsk) => {
    const initiator = xxInitiator({ pattern: 'XXpsk3', psk: initiatorPsk });
    const responder = xxResponder({ pattern: 'XXpsk3', psk: responderPsk });
    // The key is mixed in at the end of message 3, so the first two messages pass.
    assert.deepEqual(responder.readMessage(initiator.writeMessage(utf8('one'))), utf8('one'));
    assert.deepEqual(initiator.readMessage(responder.writeMessage(utf8('two'))), utf8('two'));
    return { initiator, responder, m3: initiator.writeMessage(utf8('three')) };
  };

  const good = run(PSK, Buffer.from(PSK));
  assert.deepEqual(good.responder.readMessage(good.m3), utf8('three'));
  assert.deepEqual(good.initiator.handshakeHash, good.responder.handshakeHash);
  const a = good.initiator.split();
  const b = good.responder.split();
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, a.tx.encryptWithAd(EMPTY, utf8('hello'))), utf8('hello'));

  const wrong = Buffer.from(PSK);
  wrong[31] ^= 1;
  const bad = run(PSK, wrong);
  assert.throws(() => bad.responder.readMessage(bad.m3), { name: 'AuthError', code: 'ERR_AUTH' });
  assertUnusable(bad.responder);
});

test('a node without the network key cannot complete a handshake with one that has it', () => {
  for (const pattern of ['XXpsk0', 'XXpsk3']) {
    // Outsider initiates with plain XX towards a psk node: rejected at the first message.
    const outsider = xxInitiator();
    const member = xxResponder({ pattern, psk: PSK });
    assert.throws(() => member.readMessage(outsider.writeMessage(utf8('one'))), AuthError, pattern);
    assertUnusable(member);

    // Member initiates towards an outsider: the outsider's reply does not authenticate.
    const memberInitiator = xxInitiator({ pattern, psk: PSK });
    const outsiderResponder = xxResponder();
    outsiderResponder.readMessage(memberInitiator.writeMessage(utf8('one')));
    const reply = outsiderResponder.writeMessage(utf8('two'));
    assert.throws(() => memberInitiator.readMessage(reply), AuthError, pattern);
    assertUnusable(memberInitiator);
  }
});

test('XXpsk0 completes only with the same pre-shared key, and fails at the first message without it', () => {
  const pair = (initiatorPsk, responderPsk) => ({
    initiator: xxInitiator({ pattern: 'XXpsk0', psk: initiatorPsk }),
    responder: xxResponder({ pattern: 'XXpsk0', psk: responderPsk }),
  });

  const good = pair(PSK, Buffer.from(PSK));
  const m1 = good.initiator.writeMessage(utf8('one'));
  // psk0 keys the cipher before the first payload: e, then the payload under a tag.
  assert.equal(m1.length, 32 + 3 + 16);
  assert.ok(!m1.includes(utf8('one')));
  assert.deepEqual(good.responder.readMessage(m1), utf8('one'));
  const m2 = good.responder.writeMessage(utf8('two'));
  assert.equal(m2.length, 32 + 48 + 3 + 16);
  assert.deepEqual(good.initiator.readMessage(m2), utf8('two'));
  assert.deepEqual(good.responder.readMessage(good.initiator.writeMessage(utf8('three'))), utf8('three'));
  assert.deepEqual(good.initiator.handshakeHash, good.responder.handshakeHash);
  assert.deepEqual(good.initiator.remoteStaticKey, KEYS.responderStatic.publicKey);
  assert.deepEqual(good.responder.remoteStaticKey, KEYS.initiatorStatic.publicKey);
  const a = good.initiator.split();
  const b = good.responder.split();
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, a.tx.encryptWithAd(EMPTY, utf8('hello'))), utf8('hello'));
  assert.deepEqual(a.rx.decryptWithAd(EMPTY, b.tx.encryptWithAd(EMPTY, utf8('back'))), utf8('back'));

  // DESIGN.md 15.4: a non-member is refused at its first message, which carries no
  // Diffie-Hellman token, so the responder has done no DH work and has sent nothing (its
  // identity card would travel in message 2).
  for (const bit of [0, 7, 255]) {
    const wrong = Buffer.from(PSK);
    wrong[bit >> 3] ^= 1 << (bit & 7);
    const bad = pair(wrong, PSK);
    assert.throws(() => bad.responder.readMessage(bad.initiator.writeMessage(utf8('one'))), { name: 'AuthError', code: 'ERR_AUTH' }, `psk bit ${bit}`);
    assertUnusable(bad.responder);
  }
  // Even an empty first message carries a tag that a non-member cannot produce.
  const empty = pair(Buffer.alloc(32, 0x56), PSK);
  const emptyM1 = empty.initiator.writeMessage();
  assert.equal(emptyM1.length, 48);
  assert.throws(() => empty.responder.readMessage(emptyM1), AuthError);

  // psk0 and psk3 are different protocols: the name is hashed into the transcript.
  const psk3 = xxResponder({ pattern: 'XXpsk3', psk: PSK });
  const psk0Initiator = xxInitiator({ pattern: 'XXpsk0', psk: PSK });
  assert.throws(() => psk3.readMessage(psk0Initiator.writeMessage(EMPTY)), AuthError);
});

/**
 * Noise_XXpsk0_25519_ChaChaPoly_SHA256 written out from the specification (sections 5 and
 * 9) with SHA-256, HMAC and ChaCha20-Poly1305 straight from node:crypto. It shares no code
 * with noise.js. This is an independent transcription, NOT a published test vector: it
 * catches a table or ordering mistake in the engine, but it rests on the same reading of
 * the specification. `mixEphemeralKey: false` drops the section 9.2 rule that an "e" token
 * in a psk handshake is followed by MixKey(e), to show that the engine applies the rule.
 */
function handRolledXXpsk0({ psk, prologue, keys, payloads, mixEphemeralKey = true }) {
  const hash = (...parts) => parts.reduce((h, part) => h.update(part), createHash('sha256')).digest();
  const hmac = (key, ...parts) => parts.reduce((m, part) => m.update(part), createHmac('sha256', key)).digest();
  const hkdf = (ck, ikm, outputs) => {
    const temp = hmac(ck, ikm);
    const out = [hmac(temp, Buffer.from([1]))];
    for (let i = 2; i <= outputs; i += 1) out.push(hmac(temp, out.at(-1), Buffer.from([i])));
    return out;
  };
  const nonceOf = n => {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(n), 4);
    return nonce.toString('hex');
  };
  // The name is 36 bytes, longer than the hash, so h starts as its hash.
  let h = hash(utf8('Noise_XXpsk0_25519_ChaChaPoly_SHA256'));
  let ck = h;
  let k = null;
  let n = 0;
  const mixHash = data => {
    h = hash(h, data);
  };
  const mixKey = ikm => {
    [ck, k] = hkdf(ck, ikm, 2);
    n = 0;
  };
  const mixKeyAndHash = ikm => {
    let tempH;
    [ck, tempH, k] = hkdf(ck, ikm, 3);
    mixHash(tempH);
    n = 0;
  };
  const encryptAndHash = plaintext => {
    const sealed = k === null ? Buffer.from(plaintext) : chachaPoly(k, nonceOf(n), h, plaintext);
    if (k !== null) n += 1;
    mixHash(sealed);
    return sealed;
  };
  const ephemeral = publicKey => {
    mixHash(publicKey);
    if (mixEphemeralKey) mixKey(publicKey);
    return publicKey;
  };
  const dh = (pair, publicKey) => x25519(pair.privateKey, publicKey);
  const { initiatorStatic: si, initiatorEphemeral: ei, responderStatic: sr, responderEphemeral: er } = keys;

  mixHash(prologue);
  // -> psk, e
  mixKeyAndHash(psk);
  const m1 = Buffer.concat([ephemeral(ei.publicKey), encryptAndHash(payloads[0])]);
  // <- e, ee, s, es
  const m2parts = [ephemeral(er.publicKey)];
  mixKey(dh(er, ei.publicKey));
  m2parts.push(encryptAndHash(sr.publicKey));
  mixKey(dh(ei, sr.publicKey));
  m2parts.push(encryptAndHash(payloads[1]));
  // -> s, se
  const m3parts = [encryptAndHash(si.publicKey)];
  mixKey(dh(si, er.publicKey));
  m3parts.push(encryptAndHash(payloads[2]));
  const [k1, k2] = hkdf(ck, EMPTY, 2);
  return { messages: [m1, Buffer.concat(m2parts), Buffer.concat(m3parts)], h, k1, k2 };
}

test('XXpsk0 agrees byte for byte with an independent transcription of the specification', () => {
  const payloads = [utf8('one'), utf8('two'), utf8('three')];
  const reference = handRolledXXpsk0({ psk: PSK, prologue: PROLOGUE, keys: KEYS, payloads });

  const initiator = xxInitiator({ pattern: 'XXpsk0', psk: PSK });
  const responder = xxResponder({ pattern: 'XXpsk0', psk: PSK });
  const written = [];
  written.push(initiator.writeMessage(payloads[0]));
  assert.deepEqual(responder.readMessage(written[0]), payloads[0]);
  written.push(responder.writeMessage(payloads[1]));
  assert.deepEqual(initiator.readMessage(written[1]), payloads[1]);
  written.push(initiator.writeMessage(payloads[2]));
  assert.deepEqual(responder.readMessage(written[2]), payloads[2]);
  written.forEach((message, i) => assert.equal(message.toString('hex'), reference.messages[i].toString('hex'), `message ${i + 1}`));
  assert.deepEqual(initiator.handshakeHash, reference.h);
  assert.deepEqual(responder.handshakeHash, reference.h);

  // Split: the first key carries initiator-to-responder traffic, the second the reverse.
  const a = initiator.split();
  const b = responder.split();
  const ad = utf8('ad');
  assert.deepEqual(a.tx.encryptWithAd(ad, utf8('i->r')), chachaPoly(reference.k1, '000000000000000000000000', ad, utf8('i->r')));
  assert.deepEqual(b.tx.encryptWithAd(ad, utf8('r->i')), chachaPoly(reference.k2, '000000000000000000000000', ad, utf8('r->i')));

  // Without the section 9.2 rule, the very first message already differs, so the engine is
  // shown to apply it rather than to agree by accident.
  const withoutRule = handRolledXXpsk0({ psk: PSK, prologue: PROLOGUE, keys: KEYS, payloads, mixEphemeralKey: false });
  assert.deepEqual(withoutRule.messages[0].subarray(0, 32), written[0].subarray(0, 32));
  assert.notDeepEqual(withoutRule.messages[0], written[0]);
});

test('calls out of turn throw StateError and leave the handshake intact', () => {
  const initiator = xxInitiator();
  const responder = xxResponder();
  const err = { name: 'StateError', code: 'ERR_STATE' };

  assert.throws(() => initiator.readMessage(Buffer.alloc(64)), err);
  assert.throws(() => responder.writeMessage(EMPTY), err);
  assert.throws(() => initiator.split(), err);
  assert.throws(() => initiator.handshakeHash, err);

  const m1 = initiator.writeMessage(utf8('one'));
  assert.throws(() => initiator.writeMessage(utf8('again')), err);
  responder.readMessage(m1);
  assert.throws(() => responder.readMessage(m1), err);

  const m2 = responder.writeMessage(utf8('two'));
  assert.throws(() => responder.writeMessage(utf8('again')), err);
  initiator.readMessage(m2);
  assert.throws(() => initiator.readMessage(m2), err);
  assert.throws(() => responder.split(), err);

  // None of the misplaced calls damaged anything: the handshake still completes.
  responder.readMessage(initiator.writeMessage(utf8('three')));
  assert.ok(initiator.isComplete && responder.isComplete);
  assert.throws(() => initiator.writeMessage(EMPTY), err);
  assert.throws(() => initiator.readMessage(m2), err);
  assert.throws(() => responder.readMessage(m1), err);

  const ciphers = initiator.split();
  assert.ok(ciphers.tx.hasKey());
  // A second split would hand out a second copy of the same keys and counters.
  assert.throws(() => initiator.split(), err);
  assert.equal(initiator.handshakeHash.length, 32);
});

test('handshake messages are limited to 65535 bytes', () => {
  // XX message 1 is a public key plus the payload.
  const initiator = xxInitiator();
  assert.throws(() => initiator.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 32 + 1)), { name: 'CryptoError', code: 'ERR_CRYPTO' });
  // Refusing an oversized payload happens before any state changes.
  const m1 = initiator.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 32, 0xab));
  assert.equal(m1.length, NOISE_MAX_MESSAGE);

  const responder = xxResponder();
  assert.equal(responder.readMessage(m1).length, NOISE_MAX_MESSAGE - 32);
  // XX message 2: public key, encrypted static key, payload and its tag.
  const overhead = 32 + 48 + 16;
  assert.throws(() => responder.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - overhead + 1)), CryptoError);
  const m2 = responder.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - overhead, 0xcd));
  assert.equal(m2.length, NOISE_MAX_MESSAGE);
  assert.deepEqual(initiator.readMessage(m2), Buffer.alloc(NOISE_MAX_MESSAGE - overhead, 0xcd));

  const reader = xxResponder();
  assert.throws(() => reader.readMessage(Buffer.alloc(NOISE_MAX_MESSAGE + 1)), AuthError);
  assertUnusable(reader);
});

test('small-order public keys are rejected wherever they enter a handshake', () => {
  const onArrival = {
    name: 'AuthError',
    code: 'ERR_AUTH',
    message: 'handshake message carries an unusable public key',
  };
  const ixResponder = () =>
    new HandshakeState({ pattern: 'IX', initiator: false, prologue: PROLOGUE, s: KEYS.responderStatic });
  // Control: IX message 1 is `e, s` with both keys in the clear, and honest keys pass.
  const honest = Buffer.concat([KEYS.initiatorEphemeral.publicKey, KEYS.initiatorStatic.publicKey]);
  const control = ixResponder();
  assert.deepEqual(control.readMessage(honest), EMPTY);
  assert.deepEqual(control.remoteStaticKey, KEYS.initiatorStatic.publicKey);

  let cases = 0;
  for (const listed of LOW_ORDER_POINTS) {
    // X25519 ignores the top bit of a public key, so both spellings must be refused.
    for (const topBit of [0x00, 0x80]) {
      const point = Buffer.from(listed);
      point[31] |= topBit;

      // As the initiator's ephemeral key in XX message 1. The responder would first compute
      // with it while writing its own reply; it is refused when it arrives instead, so the
      // failure is an AuthError from readMessage like every other bad message.
      const responder = xxResponder();
      assert.throws(() => responder.readMessage(point), onArrival);
      assertUnusable(responder);

      // As the responder's ephemeral key in XX message 2.
      const initiator = xxInitiator();
      initiator.writeMessage();
      assert.throws(() => initiator.readMessage(Buffer.concat([point, Buffer.alloc(80)])), onArrival);
      assertUnusable(initiator);

      // As a static key carried by a message.
      const receiver = ixResponder();
      const message = Buffer.concat([KEYS.initiatorEphemeral.publicKey, point]);
      assert.throws(() => receiver.readMessage(message), onArrival);
      assertUnusable(receiver);

      // As the recipient's static key when sealing with X: refused before anything is sent.
      assert.throws(() => xInitiator({ rs: point }), { name: 'CryptoError', code: 'ERR_CRYPTO' });

      // As the sender's ephemeral key when opening with X.
      const opener = xResponder();
      assert.throws(() => opener.readMessage(Buffer.concat([point, Buffer.alloc(70)])), onArrival);
      assertUnusable(opener);
      cases += 5;
    }
  }
  assert.equal(cases, 70);
});

/**
 * A Noise_X sender written out from the specification with HMAC, SHA-256 and
 * ChaCha20-Poly1305 straight from node:crypto: it shares no handshake code with noise.js.
 * `staticPublic` is sent as the static key and `ssOutput` is used as the result of the
 * `ss` key agreement, so a test can play a sender whose "static key" is a small-order
 * point. Such a sender needs no private key: every key agreement with that point is zero.
 */
function handRolledNoiseX({ ephemeral, staticPublic, ssOutput, recipientPublic, prologue, payload }) {
  const hash = (...parts) => parts.reduce((h, part) => h.update(part), createHash('sha256')).digest();
  const hmac = (key, ...parts) => parts.reduce((m, part) => m.update(part), createHmac('sha256', key)).digest();
  // The name is 31 bytes, so h starts as the name padded with one zero byte.
  let h = Buffer.concat([utf8('Noise_X_25519_ChaChaPoly_SHA256'), Buffer.alloc(1)]);
  let ck = h;
  let k = null;
  const mixHash = data => {
    h = hash(h, data);
  };
  const mixKey = input => {
    const temp = hmac(ck, input);
    ck = hmac(temp, Buffer.from([1]));
    k = hmac(temp, ck, Buffer.from([2]));
  };
  // Every encryption here directly follows a MixKey, so its nonce is always zero.
  const encryptAndHash = plaintext => {
    const sealed = chachaPoly(k, '000000000000000000000000', h, plaintext);
    mixHash(sealed);
    return sealed;
  };
  mixHash(prologue);
  mixHash(recipientPublic);
  mixHash(ephemeral.publicKey);
  mixKey(x25519(ephemeral.privateKey, recipientPublic));
  const sealedStatic = encryptAndHash(staticPublic);
  mixKey(ssOutput);
  return Buffer.concat([ephemeral.publicKey, sealedStatic, encryptAndHash(payload)]);
}

test('a sender whose encrypted static key has small order cannot seal a message', () => {
  const recipientPublic = KEYS.responderStatic.publicKey;
  const base = { ephemeral: KEYS.initiatorEphemeral, recipientPublic, prologue: PROLOGUE, payload: utf8('sealed') };

  // Control: with an honest static key the hand-rolled sender produces, byte for byte,
  // what noise.js produces, and the message opens.
  const honest = handRolledNoiseX({
    ...base,
    staticPublic: KEYS.initiatorStatic.publicKey,
    ssOutput: x25519(KEYS.initiatorStatic.privateKey, recipientPublic),
  });
  assert.deepEqual(honest, xInitiator({ e: KEYS.initiatorEphemeral }).writeMessage(utf8('sealed')));
  const opener = xResponder();
  assert.deepEqual(opener.readMessage(honest), utf8('sealed'));
  assert.deepEqual(opener.remoteStaticKey, KEYS.initiatorStatic.publicKey);

  // The forgery: a small-order "static key" and the all-zero secret that goes with it. It
  // is internally consistent, so only the rule against such keys can stop it.
  let rejected = 0;
  for (const point of LOW_ORDER_POINTS) {
    const forged = handRolledNoiseX({ ...base, staticPublic: point, ssOutput: Buffer.alloc(32) });
    assert.equal(forged.length, honest.length);
    const victim = xResponder();
    assert.throws(() => victim.readMessage(forged), {
      name: 'AuthError',
      code: 'ERR_AUTH',
      message: 'handshake message carries an unusable public key',
    });
    assertUnusable(victim);
    rejected += 1;
  }
  assert.equal(rejected, 7);
});

test('the constructor demands exactly the keys the pattern uses', () => {
  const base = { pattern: 'XX', initiator: true, prologue: PROLOGUE, s: KEYS.initiatorStatic };
  assert.doesNotThrow(() => new HandshakeState(base));
  const err = { name: 'CryptoError', code: 'ERR_CRYPTO' };
  const refused = [
    [undefined, 'no options'],
    [{ ...base, s: undefined }, 'missing static key'],
    [{ ...base, rs: KEYS.responderStatic.publicKey }, 'XX learns the remote static key itself'],
    [{ ...base, re: KEYS.responderEphemeral.publicKey }, 'remote ephemeral supplied'],
    [{ ...base, psk: PSK }, 'psk for a pattern without one'],
    [{ ...base, pattern: 'XXpsk3' }, 'psk pattern without psk'],
    [{ ...base, pattern: 'XXpsk3', psk: Buffer.alloc(31) }, 'short psk'],
    [{ ...base, pattern: 'XXpsk3', psk: PSK.toString('hex') }, 'psk as text'],
    [{ ...base, prologue: undefined }, 'missing prologue'],
    [{ ...base, prologue: 'clawnet/1' }, 'prologue as text'],
    [{ ...base, initiator: undefined }, 'missing role'],
    [{ ...base, initiator: 1 }, 'role not boolean'],
    [{ ...base, s: KEYS.initiatorStatic.privateKey }, 'static key not a pair'],
    [{ ...base, s: { publicKey: KEYS.initiatorStatic.publicKey } }, 'pair without private half'],
    [{ ...base, s: { publicKey: Buffer.alloc(31), privateKey: KEYS.initiatorStatic.privateKey } }, 'short public half'],
    [{ ...base, s: { publicKey: KEYS.responderStatic.publicKey, privateKey: KEYS.initiatorStatic.privateKey } }, 'mismatched pair'],
    [{ ...base, e: { publicKey: KEYS.responderStatic.publicKey, privateKey: KEYS.initiatorEphemeral.privateKey } }, 'mismatched ephemeral pair'],
    [{ pattern: 'NN', initiator: true, prologue: PROLOGUE, s: KEYS.initiatorStatic }, 'static key for NN'],
    [{ pattern: 'N', initiator: true, prologue: PROLOGUE, s: KEYS.initiatorStatic, rs: KEYS.responderStatic.publicKey }, 'static key for the N initiator'],
    [{ pattern: 'X', initiator: true, prologue: PROLOGUE, s: KEYS.initiatorStatic }, 'X initiator without recipient key'],
    [{ pattern: 'X', initiator: true, prologue: PROLOGUE, s: KEYS.initiatorStatic, rs: Buffer.alloc(33) }, 'long recipient key'],
    [{ pattern: 'X', initiator: false, prologue: PROLOGUE, s: KEYS.responderStatic, rs: KEYS.initiatorStatic.publicKey }, 'X responder given the sender key'],
    [{ pattern: 'X', initiator: false, prologue: PROLOGUE }, 'X responder without its own key'],
  ];
  for (const [options, why] of refused) {
    assert.throws(() => new HandshakeState(options), err, why);
  }
});

test('typed arrays are accepted wherever bytes are expected', () => {
  const u8 = buffer => new Uint8Array(buffer);
  const initiator = new HandshakeState({
    pattern: 'X',
    initiator: true,
    prologue: u8(PROLOGUE),
    s: { publicKey: u8(KEYS.initiatorStatic.publicKey), privateKey: u8(KEYS.initiatorStatic.privateKey) },
    rs: u8(KEYS.responderStatic.publicKey),
  });
  const message = initiator.writeMessage(u8(utf8('typed')));
  assert.ok(Buffer.isBuffer(message));
  const payload = xResponder().readMessage(u8(message));
  assert.ok(Buffer.isBuffer(payload));
  assert.deepEqual(payload, utf8('typed'));
  for (const value of ['text', undefined, null, 7, [1, 2]]) {
    if (value !== undefined) assert.throws(() => xxInitiator().writeMessage(value), CryptoError);
    assert.throws(() => xxResponder().readMessage(value), CryptoError);
  }
});

test('transport: tampered ciphertext, tag and associated data are rejected', () => {
  const { a, b } = transportPair();
  const ad = utf8('header');
  const sealed = a.tx.encryptWithAd(ad, utf8('transport payload'));
  assert.equal(sealed.length, 17 + 16);

  let rejected = 0;
  for (let i = 0; i < sealed.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const tampered = Buffer.from(sealed);
      tampered[i] ^= 1 << bit;
      assert.throws(() => b.rx.decryptWithAd(ad, tampered), { name: 'AuthError', code: 'ERR_AUTH' }, `byte ${i} bit ${bit}`);
      rejected += 1;
    }
  }
  assert.equal(rejected, sealed.length * 8);
  assert.throws(() => b.rx.decryptWithAd(utf8('headeR'), sealed), AuthError);
  assert.throws(() => b.rx.decryptWithAd(EMPTY, sealed), AuthError);
  assert.throws(() => b.rx.decryptWithAd(ad, sealed.subarray(0, sealed.length - 1)), AuthError);
  assert.throws(() => b.rx.decryptWithAd(ad, sealed.subarray(0, 15)), AuthError);
  assert.throws(() => b.rx.decryptWithAd(ad, EMPTY), AuthError);

  // A failed decryption does not advance the nonce: the genuine message still opens.
  assert.equal(b.rx.nonce, 0n);
  assert.deepEqual(b.rx.decryptWithAd(ad, sealed), utf8('transport payload'));
  assert.equal(b.rx.nonce, 1n);
});

test('transport: replayed, reordered and dropped messages are rejected', () => {
  const { a, b } = transportPair();
  const first = a.tx.encryptWithAd(EMPTY, utf8('first'));
  const second = a.tx.encryptWithAd(EMPTY, utf8('second'));
  const third = a.tx.encryptWithAd(EMPTY, utf8('third'));
  assert.notDeepEqual(first.subarray(0, 5), a.tx.encryptWithAd(EMPTY, utf8('first')).subarray(0, 5));

  assert.throws(() => b.rx.decryptWithAd(EMPTY, second), AuthError);
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, first), utf8('first'));
  assert.throws(() => b.rx.decryptWithAd(EMPTY, first), AuthError);
  assert.throws(() => b.rx.decryptWithAd(EMPTY, third), AuthError);
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, second), utf8('second'));
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, third), utf8('third'));
});

test('transport messages are limited to 65535 bytes', () => {
  const { a, b } = transportPair();
  assert.throws(() => a.tx.encryptWithAd(EMPTY, Buffer.alloc(NOISE_MAX_PLAINTEXT + 1)), { name: 'CryptoError', code: 'ERR_CRYPTO' });
  assert.equal(a.tx.nonce, 0n);
  const largest = a.tx.encryptWithAd(EMPTY, Buffer.alloc(NOISE_MAX_PLAINTEXT, 0x5a));
  assert.equal(largest.length, NOISE_MAX_MESSAGE);
  assert.throws(() => b.rx.decryptWithAd(EMPTY, Buffer.alloc(NOISE_MAX_MESSAGE + 1)), AuthError);
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, largest), Buffer.alloc(NOISE_MAX_PLAINTEXT, 0x5a));
});

test('the nonce is 4 zero bytes then the counter as 64 bits little-endian', () => {
  const key = Buffer.alloc(32, 7);
  const ad = utf8('ad');
  const plaintext = utf8('nonce encoding');
  const cases = [
    [0n, '000000000000000000000000'],
    [1n, '000000000100000000000000'],
    [0x0102030405060708n, '000000000807060504030201'],
    [2n ** 32n, '000000000000000001000000'],
    [2n ** 64n - 2n, '00000000feffffffffffffff'],
  ];
  for (const [counter, nonceHex] of cases) {
    const cipher = new CipherState(key);
    cipher.setNonce(counter);
    assert.deepEqual(cipher.encryptWithAd(ad, plaintext), chachaPoly(key, nonceHex, ad, plaintext), nonceHex);
    assert.equal(cipher.nonce, counter + 1n);
  }
  // The counter increments by one per message, for decryption as well.
  const sender = new CipherState(key);
  sender.setNonce(0x0102030405060708n);
  sender.encryptWithAd(ad, plaintext);
  const next = sender.encryptWithAd(ad, plaintext);
  assert.deepEqual(next, chachaPoly(key, '000000000907060504030201', ad, plaintext));
  const receiver = new CipherState(key);
  receiver.setNonce(0x0102030405060709n);
  assert.deepEqual(receiver.decryptWithAd(ad, next), plaintext);
  assert.equal(receiver.nonce, 0x010203040506070an);
  // A plain number is accepted for small values.
  receiver.setNonce(5);
  assert.equal(receiver.nonce, 5n);
});

test('the reserved nonce 2^64-1 is never used for a message', () => {
  const key = Buffer.alloc(32, 9);
  const cipher = new CipherState(key);
  cipher.setNonce(2n ** 64n - 2n);
  const last = cipher.encryptWithAd(EMPTY, utf8('last message'));
  assert.equal(cipher.nonce, 2n ** 64n - 1n);
  const exhausted = { name: 'StateError', code: 'ERR_STATE' };
  assert.throws(() => cipher.encryptWithAd(EMPTY, utf8('one too many')), exhausted);
  assert.throws(() => cipher.decryptWithAd(EMPTY, last), exhausted);
  assert.equal(cipher.nonce, 2n ** 64n - 1n);

  for (const value of [-1, -1n, 2n ** 64n, 1.5, NaN, '5', undefined, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cipher.setNonce(value), { name: 'CryptoError', code: 'ERR_CRYPTO' }, String(value));
  }
});

test('rekey replaces the key as the specification defines and keeps the nonce', () => {
  const key = Buffer.alloc(32, 3);
  const ad = utf8('ad');
  const plaintext = utf8('rekey');
  // REKEY(k): the first 32 bytes of ENCRYPT(k, 2^64-1, empty, 32 zero bytes).
  const expectedKey = chachaPoly(key, '00000000ffffffffffffffff', EMPTY, Buffer.alloc(32)).subarray(0, 32);
  assert.notDeepEqual(expectedKey, key);

  const cipher = new CipherState(key);
  cipher.setNonce(5);
  const before = cipher.encryptWithAd(ad, plaintext);
  assert.deepEqual(before, chachaPoly(key, '000000000500000000000000', ad, plaintext));
  cipher.rekey();
  assert.equal(cipher.nonce, 6n);
  cipher.setNonce(5);
  const after = cipher.encryptWithAd(ad, plaintext);
  assert.deepEqual(after, chachaPoly(expectedKey, '000000000500000000000000', ad, plaintext));
  assert.notDeepEqual(after, before);

  // Rekeying twice is not the same as rekeying once.
  const twice = new CipherState(key);
  twice.rekey();
  twice.rekey();
  twice.setNonce(5);
  assert.notDeepEqual(twice.encryptWithAd(ad, plaintext), after);
});

test('both ends stay in sync across rekeys, and a one-sided rekey breaks the link', () => {
  const { a, b } = transportPair();
  const exchange = (text, tx = a.tx, rx = b.rx) =>
    assert.deepEqual(rx.decryptWithAd(EMPTY, tx.encryptWithAd(EMPTY, utf8(text))), utf8(text));

  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 3; i += 1) exchange(`round ${round} message ${i}`);
    a.tx.rekey();
    b.rx.rekey();
  }
  exchange('after three rekeys');
  assert.equal(a.tx.nonce, 10n);
  assert.equal(b.rx.nonce, 10n);
  // The other direction has its own key and was not touched.
  exchange('reverse direction', b.tx, a.rx);

  a.tx.rekey();
  const sealed = a.tx.encryptWithAd(EMPTY, utf8('sender rekeyed alone'));
  assert.throws(() => b.rx.decryptWithAd(EMPTY, sealed), AuthError);
  // Once the receiver catches up, the very same message opens.
  b.rx.rekey();
  assert.deepEqual(b.rx.decryptWithAd(EMPTY, sealed), utf8('sender rekeyed alone'));
});

test('a CipherState without a key passes data through, as the specification requires', () => {
  const cipher = new CipherState();
  assert.equal(cipher.hasKey(), false);
  assert.deepEqual(cipher.encryptWithAd(utf8('ad'), utf8('clear')), utf8('clear'));
  assert.deepEqual(cipher.decryptWithAd(utf8('ad'), utf8('clear')), utf8('clear'));
  assert.equal(cipher.nonce, 0n);
  assert.throws(() => cipher.rekey(), StateError);
  assert.throws(() => cipher.encryptWithAd(EMPTY, Buffer.alloc(NOISE_MAX_MESSAGE + 1)), CryptoError);

  assert.equal(new CipherState(Buffer.alloc(32)).hasKey(), true);
  for (const key of [Buffer.alloc(31), Buffer.alloc(33), 'k'.repeat(32), null, 32]) {
    assert.throws(() => new CipherState(key), CryptoError);
  }
  const keyed = new CipherState(Buffer.alloc(32, 1));
  assert.throws(() => keyed.encryptWithAd('ad', utf8('x')), CryptoError);
  assert.throws(() => keyed.encryptWithAd(EMPTY, 'x'), CryptoError);
  assert.throws(() => keyed.decryptWithAd(EMPTY, 'x'), CryptoError);
  assert.equal(keyed.nonce, 0n);
});

test('the constructor copies its key, so later changes to the caller buffer do not matter', () => {
  const key = Buffer.alloc(32, 4);
  const cipher = new CipherState(key);
  const reference = new CipherState(Buffer.alloc(32, 4));
  key.fill(0);
  assert.deepEqual(cipher.encryptWithAd(EMPTY, utf8('x')), reference.encryptWithAd(EMPTY, utf8('x')));
});

test('no key material shows up when Noise objects are printed or serialised', () => {
  const { initiator, responder } = xxTranscript();
  const ciphers = initiator.split();
  // Each secret in the spellings a dump could use: hex, base64, and the spaced hex of
  // util.inspect(buffer).
  const secretStrings = [
    KEYS.initiatorStatic.privateKey,
    KEYS.initiatorEphemeral.privateKey,
    KEYS.responderStatic.privateKey,
    KEYS.responderEphemeral.privateKey,
    PSK,
  ].flatMap(key => [key.toString('hex'), key.toString('base64'), key.toString('hex').match(/../g).join(' ')]);
  const pskHandshake = xxInitiator({ pattern: 'XXpsk3', psk: PSK });
  pskHandshake.writeMessage();
  // The last entry is keyed with the same bytes as the initiator's static private key.
  const objects = [initiator, responder, ciphers, ciphers.tx, xxInitiator(), pskHandshake, new CipherState(Buffer.alloc(32, 0x11))];
  const dumps = objects.flatMap(value => [
    // getters: true makes inspect call every accessor, the widest view there is.
    inspect(value, { depth: null, showHidden: true, getters: true }),
    JSON.stringify(value),
    String(value),
  ]);
  assert.equal(dumps.length, 21);
  for (const dump of dumps) {
    for (const secret of secretStrings) assert.ok(!dump.includes(secret), dump);
  }
  // Public values may appear; this proves the dumps above are not simply empty.
  const publicDump = inspect(initiator, { depth: null, showHidden: true, getters: true });
  assert.ok(publicDump.includes('HandshakeState'));
});
