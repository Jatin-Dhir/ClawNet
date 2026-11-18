/**
 * End-to-end sealing of the web core (DATA body scheme 0x01): a port of sealMessage and
 * openMessage from the engine's `src/core/crypto/envelope.js`. The web core does not
 * transfer files or read casts, so schemes 0x02 and the cast functions are not ported.
 *
 *   body      = 0x01 || u16be(len M0) || M0 || { u16be(len Mi) || Mi }*
 *   M0        = Noise_X handshake from the sender's e2e key to the recipient's e2e key,
 *               prologue utf8("clawnet/1/e2e") || 0x00 || utf8(dst) || 0x00 || utf8(id),
 *               payload u32be(total plaintext length)
 *   plaintext = u16be(len meta) || meta || content, chunks of exactly 65519 bytes but the last
 *   meta.hs   = Ed25519 by the sender's identity key over
 *               utf8("clawnet/1/e2e-auth") || 0x00 || h || SHA-256(u32be(len meta') || meta' || content)
 *
 * Errors: local misuse throws CryptoError; anything wrong with received bytes throws
 * AuthError, and only AuthError.
 */

import { AuthError, CryptoError } from '../../src/core/errors.js';
import { Domain, Limits, MESSAGE_ID_PATTERN, SealScheme } from '../../src/core/wire/types.js';
import { concat, readU16, readU32, u16, u32, utf8 } from './bytes.js';
import { canonicalBytes, parseCanonical } from './codec.js';
import { Identity, deepFreeze, isValidNodeId, verifyCard, verifySignature } from './identity.js';
import { HandshakeState, NOISE_MAX_PLAINTEXT } from './noise.js';
import { AEAD_TAG_LENGTH, KEY_LENGTH, SIGNATURE_LENGTH, assertBytes, base64Decode, base64Encode, sha256, timingSafeEqual } from './primitives.js';

export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FUTURE_MS = 5 * 60 * 1000;

const EMPTY = new Uint8Array(0);
const SEPARATOR = Uint8Array.of(0);
const E2E_PATTERN = 'X';
const RESERVED_META_KEYS = Object.freeze(['card', 'ts', 'hs']);
const HS_STAND_IN = 'A'.repeat(4 * Math.ceil(SIGNATURE_LENGTH / 3));
const LENGTH_PREFIX = 2;
const CHUNK_PLAINTEXT = NOISE_MAX_PLAINTEXT;
const HANDSHAKE_LENGTH = 2 * KEY_LENGTH + AEAD_TAG_LENGTH + 4 + AEAD_TAG_LENGTH;
const HANDSHAKE_END = 1 + LENGTH_PREFIX + HANDSHAKE_LENGTH;
const MAX_META_LENGTH = 0xffff;

/**
 * Seal a message to one recipient.
 *
 * @param {object} params
 * @param {Identity} params.sender
 * @param {Uint8Array} params.recipientE2eKey from a card verifyCard() accepted
 * @param {string} params.dst
 * @param {string} params.id 32 lowercase hex characters
 * @param {object} params.meta with a non-empty string `kind`; no `card`, `ts` or `hs`
 * @param {Uint8Array} [params.content]
 * @param {(() => number) | number} [params.now]
 * @returns {Uint8Array} the sealed body
 */
export function sealMessage({ sender, recipientE2eKey, dst, id, meta, content = EMPTY, now = Date.now } = {}) {
  if (!(sender instanceof Identity)) throw new CryptoError('sender must be an Identity');
  assertBytes(recipientE2eKey, 'recipient e2e key', KEY_LENGTH);
  if (!isValidNodeId(dst)) throw new CryptoError('dst must be a NodeId');
  if (!isMessageId(id)) throw new CryptoError('id must be 32 lowercase hex characters');
  if (!isPlainObject(meta)) throw new CryptoError('meta must be a plain object');
  const fields = { ...meta };
  if (typeof fields.kind !== 'string' || fields.kind.length === 0) throw new CryptoError('meta.kind must be a non-empty string');
  if (RESERVED_META_KEYS.some((key) => Object.hasOwn(fields, key))) {
    throw new CryptoError('meta must not contain "card", "ts" or "hs": they are set when sealing');
  }
  assertBytes(content, 'content');
  const ts = readClock(now);

  const metaLength = canonicalBytes({ ...fields, card: sender.card, ts, hs: HS_STAND_IN }).length;
  if (metaLength > MAX_META_LENGTH) throw new CryptoError(`meta must encode to at most ${MAX_META_LENGTH} bytes`);
  const total = LENGTH_PREFIX + metaLength + content.length;
  const chunkCount = Math.ceil(total / CHUNK_PLAINTEXT);
  const bodyLength = HANDSHAKE_END + total + chunkCount * (LENGTH_PREFIX + AEAD_TAG_LENGTH);
  if (bodyLength > Limits.MAX_PACKET) throw new CryptoError('message is too large to seal into one packet');

  const s = sender.e2eKeyPair;
  let handshake;
  try {
    handshake = new HandshakeState({ pattern: E2E_PATTERN, initiator: true, prologue: e2ePrologue(dst, id), s, rs: recipientE2eKey });
  } finally {
    s.privateKey.fill(0);
  }
  const first = handshake.writeMessage(u32(total));
  const unsigned = canonicalBytes({ ...fields, card: sender.card, ts });
  const hs = base64Encode(sender.sign(Domain.E2E_AUTH, authInput(handshake.handshakeHash, unsigned, content)));
  const metaBytes = canonicalBytes({ ...fields, card: sender.card, ts, hs });
  const plaintext = concat(u16(metaBytes.length), metaBytes, content);
  const { tx } = handshake.split();
  const parts = [Uint8Array.of(SealScheme.NOISE_X), u16(first.length), first];
  for (let offset = 0; offset < total; offset += CHUNK_PLAINTEXT) {
    const record = tx.encryptWithAd(EMPTY, plaintext.subarray(offset, offset + CHUNK_PLAINTEXT));
    parts.push(u16(record.length), record);
  }
  return concat(...parts);
}

/**
 * Open a sealed message addressed to this node. All the engine's checks, in its order.
 *
 * @returns {{ senderId: string, card: object, meta: object, content: Uint8Array }}
 * @throws {AuthError} for anything wrong with the message
 */
export function openMessage({ recipient, dst, id, body, now = Date.now, maxAgeMs = DEFAULT_MAX_AGE_MS, maxFutureMs = DEFAULT_MAX_FUTURE_MS } = {}) {
  if (!(recipient instanceof Identity)) throw new CryptoError('recipient must be an Identity');
  const time = readClock(now);
  if (!isDuration(maxAgeMs)) throw new CryptoError('maxAgeMs must be a non-negative integer');
  if (!isDuration(maxFutureMs)) throw new CryptoError('maxFutureMs must be a non-negative integer');
  try {
    return open(recipient, dst, id, body, time, maxAgeMs, maxFutureMs);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('sealed message rejected', { cause: err });
  }
}

function open(recipient, dst, id, body, time, maxAgeMs, maxFutureMs) {
  if (dst !== recipient.nodeId) throw new AuthError('message is not addressed to this node');
  if (!isMessageId(id)) throw new AuthError('message id is malformed');
  if (!(body instanceof Uint8Array)) throw new AuthError('sealed body is not a byte array');
  if (body.length > Limits.MAX_PACKET) throw new AuthError('sealed body is too large');
  if (body.length < HANDSHAKE_END || body[0] !== SealScheme.NOISE_X || readU16(body, 1) !== HANDSHAKE_LENGTH) {
    throw new AuthError('sealed body is malformed');
  }
  const s = recipient.e2eKeyPair;
  let handshake;
  try {
    handshake = new HandshakeState({ pattern: E2E_PATTERN, initiator: false, prologue: e2ePrologue(dst, id), s });
  } finally {
    s.privateKey.fill(0);
  }
  const total = readU32(handshake.readMessage(body.subarray(1 + LENGTH_PREFIX, HANDSHAKE_END)), 0);
  const chunkCount = Math.ceil(total / CHUNK_PLAINTEXT);
  if (total < LENGTH_PREFIX || body.length - HANDSHAKE_END !== total + chunkCount * (LENGTH_PREFIX + AEAD_TAG_LENGTH)) {
    throw new AuthError('sealed body does not match its announced length');
  }
  const { rx } = handshake.split();
  const plaintext = new Uint8Array(total);
  let offset = HANDSHAKE_END;
  for (let done = 0; done < total; done += CHUNK_PLAINTEXT) {
    const recordLength = Math.min(CHUNK_PLAINTEXT, total - done) + AEAD_TAG_LENGTH;
    if (readU16(body, offset) !== recordLength) throw new AuthError('sealed body is not in canonical framing');
    offset += LENGTH_PREFIX;
    plaintext.set(rx.decryptWithAd(EMPTY, body.subarray(offset, offset + recordLength)), done);
    offset += recordLength;
  }

  const metaEnd = LENGTH_PREFIX + readU16(plaintext, 0);
  if (metaEnd > total) throw new AuthError('message metadata overruns the message');
  const meta = parseCanonical(plaintext.subarray(LENGTH_PREFIX, metaEnd));
  if (!isPlainObject(meta)) throw new AuthError('message metadata is not an object');
  if (typeof meta.kind !== 'string' || meta.kind.length === 0) throw new AuthError('message metadata has no kind');
  if (!Number.isSafeInteger(meta.ts) || meta.ts < 0) throw new AuthError('message metadata has no valid timestamp');
  const card = verifyCard(meta.card);
  if (!card.ok) throw new AuthError(`sender identity card rejected: ${card.reason}`);
  if (!timingSafeEqual(card.e2ePublicKey, handshake.remoteStaticKey)) {
    throw new AuthError('message was not sealed with the key on the sender identity card');
  }
  let signature;
  try {
    signature = base64Decode(meta.hs, SIGNATURE_LENGTH);
  } catch (cause) {
    throw new AuthError('message has no well-formed sender signature', { cause });
  }
  const content = plaintext.subarray(metaEnd);
  const { hs: _signature, ...unsignedMeta } = meta;
  const signed = authInput(handshake.handshakeHash, canonicalBytes(unsignedMeta), content);
  if (!verifySignature(card.nodeId, Domain.E2E_AUTH, signed, signature)) {
    throw new AuthError('sender signature over the handshake and content does not verify');
  }
  if (meta.ts < time - maxAgeMs) throw new AuthError('message is older than the accepted age');
  if (meta.ts > time + maxFutureMs) throw new AuthError('message timestamp is too far in the future');
  deepFreeze(meta);
  return { senderId: card.nodeId, card: meta.card, meta, content: Uint8Array.from(content) };
}

function authInput(handshakeHash, unsignedMeta, content) {
  return concat(handshakeHash, sha256(u32(unsignedMeta.length), unsignedMeta, content));
}

function e2ePrologue(dst, id) {
  return concat(utf8(Domain.E2E), SEPARATOR, utf8(dst), SEPARATOR, utf8(id));
}

function readClock(now) {
  const time = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(time) || time < 0) throw new CryptoError('clock must give a non-negative integer number of milliseconds');
  return time;
}

function isDuration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isMessageId(value) {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
