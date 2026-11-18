/**
 * The web core's Noise implementation (web/core/noise.js) against the same published test
 * vectors as the engine's, and against the engine itself where no vector exists (XXpsk0)
 * and for the patterns ClawNet uses, in both roles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as engineNoise from '../../src/core/crypto/noise.js';
import * as enginePrimitives from '../../src/core/crypto/primitives.js';
import { AuthError, CryptoError, StateError } from '../../src/core/errors.js';
import { fromHex, toHex } from '../../web/core/bytes.js';
import {
  CipherState,
  HandshakeState,
  NOISE_MAX_MESSAGE,
  NOISE_MAX_PLAINTEXT,
  NOISE_PATTERNS,
  protocolName,
} from '../../web/core/noise.js';
import { x25519PublicFromPrivate } from '../../web/core/primitives.js';

const vectorFile = JSON.parse(readFileSync(new URL('../vectors/noise-vectors.json', import.meta.url), 'utf8'));
const SUITE_NAME = /^Noise_([A-Za-z0-9+]+)_25519_ChaChaPoly_SHA256$/;
const EMPTY = new Uint8Array(0);

const keyPair = (privateHex) =>
  privateHex === undefined ? undefined : { privateKey: fromHex(privateHex), publicKey: x25519PublicFromPrivate(fromHex(privateHex)) };
const optionalHex = (value) => (value === undefined ? undefined : fromHex(value));
const singlePsk = (psks) => (psks === undefined || psks.length === 0 ? undefined : fromHex(psks[0]));

function runVector(vector) {
  const pattern = SUITE_NAME.exec(vector.protocol_name)[1];
  const make = (side, initiator) =>
    new HandshakeState({
      pattern,
      initiator,
      prologue: fromHex(vector[`${side}_prologue`]),
      s: keyPair(vector[`${side}_static`]),
      e: keyPair(vector[`${side}_ephemeral`]),
      rs: optionalHex(vector[`${side}_remote_static`]),
      psk: singlePsk(vector[`${side}_psks`]),
    });
  const initiator = make('init', true);
  const responder = make('resp', false);
  const oneWay = /^[NKX](psk\d)?$/.test(pattern);
  let initiatorCiphers = null;
  let responderCiphers = null;
  let checked = 0;
  vector.messages.forEach((message, index) => {
    const payload = fromHex(message.payload);
    if (!initiator.isComplete) {
      const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
      assert.equal(toHex(sender.writeMessage(payload)), message.ciphertext, `message ${index}`);
      assert.deepEqual(receiver.readMessage(fromHex(message.ciphertext)), payload);
      if (initiator.isComplete) {
        if (vector.handshake_hash !== undefined) {
          assert.equal(toHex(initiator.handshakeHash), vector.handshake_hash);
          assert.equal(toHex(responder.handshakeHash), vector.handshake_hash);
        }
        initiatorCiphers = initiator.split();
        responderCiphers = responder.split();
      }
    } else {
      const fromInitiator = oneWay || index % 2 === 0;
      const tx = fromInitiator ? initiatorCiphers.tx : responderCiphers.tx;
      const rx = fromInitiator ? responderCiphers.rx : initiatorCiphers.rx;
      assert.equal(toHex(tx.encryptWithAd(EMPTY, payload)), message.ciphertext, `transport ${index}`);
      assert.deepEqual(rx.decryptWithAd(EMPTY, fromHex(message.ciphertext)), payload);
    }
    checked += 1;
  });
  return checked;
}

test('the web core supports exactly the patterns the engine supports', () => {
  assert.deepEqual([...NOISE_PATTERNS].sort(), [...engineNoise.NOISE_PATTERNS].sort());
  assert.equal(NOISE_MAX_MESSAGE, engineNoise.NOISE_MAX_MESSAGE);
  assert.equal(NOISE_MAX_PLAINTEXT, engineNoise.NOISE_MAX_PLAINTEXT);
  assert.equal(protocolName('XXpsk0'), 'Noise_XXpsk0_25519_ChaChaPoly_SHA256');
});

test('every published vector passes, message by message', () => {
  assert.equal(vectorFile.vectors.length, 51);
  let messages = 0;
  for (const vector of vectorFile.vectors) messages += runVector(vector);
  assert.ok(messages > 51 * 3);
});

/** Drive one engine party and one web party through a handshake with fixed keys. */
function crossHandshake({ pattern, webInitiator, psk, prologue }) {
  const keys = () => {
    const pair = enginePrimitives.x25519GenerateKeyPair();
    return { engine: pair, web: { publicKey: Uint8Array.from(pair.publicKey), privateKey: Uint8Array.from(pair.privateKey) } };
  };
  const initS = keys();
  const respS = keys();
  const initE = keys();
  const respE = keys();
  const common = { pattern, prologue, psk };
  const webSide = new HandshakeState({
    ...common,
    initiator: webInitiator,
    s: webInitiator ? initS.web : respS.web,
    e: webInitiator ? initE.web : respE.web,
    psk: psk === undefined ? undefined : Uint8Array.from(psk),
  });
  const engineSide = new engineNoise.HandshakeState({
    ...common,
    initiator: !webInitiator,
    s: webInitiator ? respS.engine : initS.engine,
    e: webInitiator ? respE.engine : initE.engine,
    psk: psk === undefined ? undefined : Buffer.from(psk),
  });
  const [first, second] = webInitiator ? [webSide, engineSide] : [engineSide, webSide];
  const payloads = [utf8('one'), utf8('two'), utf8('three')];
  let turn = 0;
  while (!first.isComplete) {
    const [sender, receiver] = turn % 2 === 0 ? [first, second] : [second, first];
    const wire = sender.writeMessage(payloads[turn]);
    assert.deepEqual(new Uint8Array(receiver.readMessage(wire)), payloads[turn]);
    turn += 1;
  }
  assert.equal(toHex(webSide.handshakeHash), engineSide.handshakeHash.toString('hex'));
  const web = webSide.split();
  const eng = engineSide.split();
  // Transport both ways, enough records to cross a rekey on each side.
  for (let i = 0; i < 3; i += 1) {
    const a = web.tx.encryptWithAd(EMPTY, utf8(`web ${i}`));
    assert.equal(Buffer.from(eng.rx.decryptWithAd(Buffer.alloc(0), a)).toString(), `web ${i}`);
    const b = eng.tx.encryptWithAd(Buffer.alloc(0), Buffer.from(`engine ${i}`));
    assert.equal(new TextDecoder().decode(web.rx.decryptWithAd(EMPTY, b)), `engine ${i}`);
    web.tx.rekey();
    eng.rx.rekey();
    eng.tx.rekey();
    web.rx.rekey();
  }
  return { remoteSeenByWeb: webSide.remoteStaticKey, expected: webInitiator ? respS.web.publicKey : initS.web.publicKey };
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

for (const pattern of ['XX', 'XXpsk0']) {
  for (const webInitiator of [true, false]) {
    test(`${pattern}: the web core and the engine complete a handshake, web as ${webInitiator ? 'initiator' : 'responder'}`, () => {
      const psk = pattern === 'XXpsk0' ? enginePrimitives.randomBytes(32) : undefined;
      const prologue = utf8('clawnet/1\0test-net');
      const { remoteSeenByWeb, expected } = crossHandshake({ pattern, webInitiator, psk, prologue });
      assert.deepEqual(remoteSeenByWeb, expected);
    });
  }
}

test('XXpsk0: the web core writes the same bytes as the engine for the same keys', () => {
  // With every key fixed, two implementations of one specification must agree on every
  // byte: this is the check that stands in for the missing published vector.
  const fixed = (hex) => {
    const privateKey = fromHex(hex);
    return { privateKey, publicKey: x25519PublicFromPrivate(privateKey) };
  };
  const engineFixed = (hex) => ({ privateKey: Buffer.from(hex, 'hex'), publicKey: enginePrimitives.x25519PublicFromPrivate(Buffer.from(hex, 'hex')) });
  const keys = {
    is: '1111111111111111111111111111111111111111111111111111111111111111',
    ie: '2222222222222222222222222222222222222222222222222222222222222222',
    rs: '3333333333333333333333333333333333333333333333333333333333333333',
    re: '4444444444444444444444444444444444444444444444444444444444444444',
  };
  const psk = '5555555555555555555555555555555555555555555555555555555555555555';
  const prologue = 'clawnet/1\0net';
  const web = [
    new HandshakeState({ pattern: 'XXpsk0', initiator: true, prologue: utf8(prologue), s: fixed(keys.is), e: fixed(keys.ie), psk: fromHex(psk) }),
    new HandshakeState({ pattern: 'XXpsk0', initiator: false, prologue: utf8(prologue), s: fixed(keys.rs), e: fixed(keys.re), psk: fromHex(psk) }),
  ];
  const eng = [
    new engineNoise.HandshakeState({ pattern: 'XXpsk0', initiator: true, prologue: Buffer.from(prologue), s: engineFixed(keys.is), e: engineFixed(keys.ie), psk: Buffer.from(psk, 'hex') }),
    new engineNoise.HandshakeState({ pattern: 'XXpsk0', initiator: false, prologue: Buffer.from(prologue), s: engineFixed(keys.rs), e: engineFixed(keys.re), psk: Buffer.from(psk, 'hex') }),
  ];
  for (let i = 0; i < 3; i += 1) {
    const sender = i % 2;
    const payload = utf8(`payload ${i}`);
    const a = web[sender].writeMessage(payload);
    const b = eng[sender].writeMessage(Buffer.from(payload));
    assert.equal(toHex(a), b.toString('hex'), `message ${i}`);
    web[1 - sender].readMessage(a);
    eng[1 - sender].readMessage(b);
  }
  assert.equal(toHex(web[0].handshakeHash), eng[0].handshakeHash.toString('hex'));
});

test('a wrong pre-shared key fails on the first message, before any key agreement', () => {
  const s = () => {
    const pair = enginePrimitives.x25519GenerateKeyPair();
    return { publicKey: Uint8Array.from(pair.publicKey), privateKey: Uint8Array.from(pair.privateKey) };
  };
  const prologue = utf8('p');
  const initiator = new HandshakeState({ pattern: 'XXpsk0', initiator: true, prologue, s: s(), psk: new Uint8Array(32).fill(1) });
  const responder = new HandshakeState({ pattern: 'XXpsk0', initiator: false, prologue, s: s(), psk: new Uint8Array(32).fill(2) });
  assert.throws(() => responder.readMessage(initiator.writeMessage(EMPTY)), AuthError);
  assert.throws(() => responder.writeMessage(EMPTY), StateError);
});

test('small-order keys are refused where they arrive', () => {
  const pair = enginePrimitives.x25519GenerateKeyPair();
  const s = { publicKey: Uint8Array.from(pair.publicKey), privateKey: Uint8Array.from(pair.privateKey) };
  assert.throws(() => new HandshakeState({ pattern: 'X', initiator: true, prologue: EMPTY, s, rs: new Uint8Array(32) }), CryptoError);
  const responder = new HandshakeState({ pattern: 'XX', initiator: false, prologue: EMPTY, s });
  assert.throws(() => responder.readMessage(new Uint8Array(32)), AuthError);
});

test('CipherState: wrong turn, exhausted nonce, oversized message and rekey', () => {
  const cipher = new CipherState(new Uint8Array(32).fill(7));
  cipher.setNonce(0xffffffffffffffffn);
  assert.throws(() => cipher.encryptWithAd(EMPTY, EMPTY), StateError);
  const fresh = new CipherState(new Uint8Array(32).fill(7));
  assert.throws(() => fresh.encryptWithAd(EMPTY, new Uint8Array(NOISE_MAX_PLAINTEXT + 1)), CryptoError);
  assert.throws(() => fresh.decryptWithAd(EMPTY, new Uint8Array(NOISE_MAX_MESSAGE + 1)), AuthError);
  // Rekey matches the engine's.
  const engine = new engineNoise.CipherState(Buffer.alloc(32, 7));
  fresh.rekey();
  engine.rekey();
  assert.equal(toHex(fresh.encryptWithAd(EMPTY, utf8('x'))), engine.encryptWithAd(Buffer.alloc(0), Buffer.from('x')).toString('hex'));
});
