/**
 * End-to-end sealing (DESIGN.md sections 6 and 11).
 *
 * Three ways to protect bytes that cross nodes which must not read them:
 *
 *   - scheme 0x01, sealMessage/openMessage: a one-way Noise_X exchange from the sender's
 *     e2e key to the recipient's e2e key, with the destination and message id bound into
 *     the prologue, and the sender's identity-key signature over the handshake hash and
 *     the message itself in `meta.hs` (DESIGN.md 15.9). Carries messages, acks and file
 *     offers.
 *   - scheme 0x02, sealChunk/openChunk: ChaCha20-Poly1305 under a transfer key that was
 *     itself delivered inside a scheme-1 message. Carries file chunks.
 *   - castEncrypt/castDecrypt: ChaCha20-Poly1305 under a key derived per message from a
 *     shared channel key, bound to the signed fields of its cast record (DESIGN.md 15.24).
 *     Carries broadcast bodies.
 *
 * And one way to authenticate a discovery beacon to the members of a private network:
 * deriveBeaconKey/beaconMac/verifyBeaconMac, HMAC-SHA256 under a key derived from the
 * network key (DESIGN.md 15.23).
 *
 * Nothing here invents a construction: each is a Noise pattern, an Ed25519 signature, an
 * HKDF derivation, or a single AEAD or HMAC call with the inputs DESIGN.md prescribes.
 *
 * Errors: local misuse throws CryptoError. Anything wrong with bytes that came from the
 * network throws AuthError, and only AuthError, so a caller needs exactly one catch.
 */

import { AuthError, CryptoError } from '../errors.js';
import { canonicalBytes, parseCanonical } from '../wire/canonical.js';
import {
  CHANNEL_ID_PATTERN,
  Domain,
  Limits,
  MESSAGE_ID_PATTERN,
  RecordType,
  SealScheme,
} from '../wire/types.js';
import { Identity, isValidNodeId, verifyCard, verifySignature } from './identity.js';
import { HandshakeState, NOISE_MAX_PLAINTEXT } from './noise.js';
import {
  AEAD_NONCE_LENGTH,
  AEAD_TAG_LENGTH,
  HASH_LENGTH,
  KEY_LENGTH,
  SIGNATURE_LENGTH,
  aeadDecrypt,
  aeadEncrypt,
  assertBytes,
  base64Decode,
  base64Encode,
  hkdfExpand,
  hmacSha256,
  randomBytes,
  sha256,
  timingSafeEqual,
} from './primitives.js';

/** Default for openMessage's `maxAgeMs`: the message lifetime of DESIGN.md section 13. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default for openMessage's `maxFutureMs`: tolerated clock skew between two nodes. */
export const DEFAULT_MAX_FUTURE_MS = 5 * 60 * 1000;

/** Length in bytes of a file transfer id. */
export const TRANSFER_ID_LENGTH = 16;

/** Length in bytes of the random salt of an encrypted cast. */
export const CAST_SALT_LENGTH = 32;

/** Largest chunk index a scheme-2 body can carry (the field is a u32). */
export const MAX_CHUNK_INDEX = 0xffffffff;

/** Length in bytes of a beacon MAC (HMAC-SHA256). */
export const BEACON_MAC_LENGTH = HASH_LENGTH;

const EMPTY = Buffer.alloc(0);
const SEPARATOR = Buffer.from([0]);
const ZERO_NONCE = Buffer.alloc(AEAD_NONCE_LENGTH);
const E2E_PATTERN = 'X';
// Keys of `meta` that sealMessage() sets itself.
const RESERVED_META_KEYS = Object.freeze(['card', 'ts', 'hs']);
// A 64-byte signature is always 88 base64 characters, none of which JSON escapes, so a
// stand-in of that length gives the metadata its final length before the handshake whose
// hash the real signature covers has happened.
const HS_STAND_IN = 'A'.repeat(4 * Math.ceil(SIGNATURE_LENGTH / 3));
// The cast record fields bound into encryption (DESIGN.md 15.24); `salt` is added to them.
const CAST_FIELDS = Object.freeze(['type', 'origin', 'chan', 'n', 'ts', 'enc']);

// Scheme 1. Each record is a u16 length and a Noise message; every plaintext chunk but
// the last fills its Noise message completely, so a plaintext has exactly one framing.
const LENGTH_PREFIX = 2;
const CHUNK_PLAINTEXT = NOISE_MAX_PLAINTEXT;
// Noise_X message: e (32) || encrypted s (32 + 16) || encrypted u32 total length (4 + 16).
const HANDSHAKE_LENGTH = 2 * KEY_LENGTH + AEAD_TAG_LENGTH + 4 + AEAD_TAG_LENGTH;
const HANDSHAKE_END = 1 + LENGTH_PREFIX + HANDSHAKE_LENGTH;
const MAX_META_LENGTH = 0xffff;

// Scheme 2: 0x02 || transfer id || u32be index || ciphertext and tag.
const CHUNK_HEADER_LENGTH = 1 + TRANSFER_ID_LENGTH + 4;

/**
 * Seal a message to one recipient (DATA body, scheme 0x01).
 *
 * The plaintext is `u16be(meta length) || meta || content`, where `meta` is canonical JSON
 * of the given object plus `card` (the sender's identity card), `ts` (send time, ms) and
 * `hs`: base64 of the sender's Ed25519 identity-key signature over
 *
 *   utf8(Domain.E2E_AUTH) || 0x00 || h || SHA-256(u32be(len(meta')) || meta' || content)
 *
 * where h is the Noise handshake hash of this message and meta' is the canonical `meta`
 * without `hs` (DESIGN.md 15.9). The signature is what still authenticates the sender to a
 * recipient whose e2e private key has been stolen: with that key alone, anyone can
 * complete a Noise_X handshake that claims any sender's e2e key, and can derive the
 * transport key of a genuine message. Covering h stops the first; covering meta' and the
 * content stops the second, a genuine handshake carrying substituted content.
 *
 * @param {object} params
 * @param {Identity} params.sender             the sending node
 * @param {Uint8Array} params.recipientE2eKey  recipient's 32-byte e2e public key, taken
 *   from an identity card that verifyCard() accepted
 * @param {string} params.dst                  recipient's NodeId, as in the packet header
 * @param {string} params.id                   message id (32 hex characters), as in the
 *   packet header
 * @param {object} params.meta                 plain object with a non-empty string `kind`;
 *   must not contain `card`, `ts` or `hs`
 * @param {Uint8Array} [params.content]        opaque application bytes; default empty
 * @param {(() => number) | number} [params.now] clock, or a time, in ms since the epoch;
 *   default Date.now
 * @returns {Buffer} the sealed body
 * @throws {CryptoError} if an argument is malformed, the recipient key is unusable, or the
 *   sealed body would exceed Limits.MAX_PACKET
 * @throws {import('../errors.js').CanonicalError} if `meta` has no canonical JSON form
 */
export function sealMessage({
  sender,
  recipientE2eKey,
  dst,
  id,
  meta,
  content = EMPTY,
  now = Date.now,
} = {}) {
  if (!(sender instanceof Identity)) throw new CryptoError('sender must be an Identity');
  assertBytes(recipientE2eKey, 'recipient e2e key', KEY_LENGTH);
  if (!isValidNodeId(dst)) throw new CryptoError('dst must be a NodeId');
  if (!isMessageId(id)) throw new CryptoError('id must be 32 lowercase hex characters');
  if (!isPlainObject(meta)) throw new CryptoError('meta must be a plain object');
  // One read of the caller's object, so the length computed below is the length sealed.
  const fields = { ...meta };
  if (typeof fields.kind !== 'string' || fields.kind.length === 0) {
    throw new CryptoError('meta.kind must be a non-empty string');
  }
  if (RESERVED_META_KEYS.some(key => Object.hasOwn(fields, key))) {
    throw new CryptoError('meta must not contain "card", "ts" or "hs": they are set when sealing');
  }
  assertBytes(content, 'content');
  const ts = readClock(now);

  // The signature covers the handshake hash, and the handshake carries the total length,
  // so the length is fixed first with a stand-in of the signature's exact encoded size.
  const metaLength = canonicalBytes({ ...fields, card: sender.card, ts, hs: HS_STAND_IN }).length;
  if (metaLength > MAX_META_LENGTH) {
    throw new CryptoError(`meta must encode to at most ${MAX_META_LENGTH} bytes`);
  }
  const total = LENGTH_PREFIX + metaLength + content.length;
  const chunkCount = Math.ceil(total / CHUNK_PLAINTEXT);
  const bodyLength = HANDSHAKE_END + total + chunkCount * (LENGTH_PREFIX + AEAD_TAG_LENGTH);
  if (bodyLength > Limits.MAX_PACKET) {
    throw new CryptoError('message is too large to seal into one packet');
  }

  const handshake = withKeyPair(sender.e2eKeyPair, s =>
    new HandshakeState({
      pattern: E2E_PATTERN,
      initiator: true,
      prologue: e2ePrologue(dst, id),
      s,
      rs: recipientE2eKey,
    })
  );
  // The total length travels inside the handshake message, authenticated with it.
  const first = handshake.writeMessage(u32(total));
  const unsigned = canonicalBytes({ ...fields, card: sender.card, ts });
  const hs = base64Encode(
    sender.sign(Domain.E2E_AUTH, authInput(handshake.handshakeHash, unsigned, content))
  );
  const metaBytes = canonicalBytes({ ...fields, card: sender.card, ts, hs });
  const plaintext = Buffer.concat([u16(metaBytes.length), metaBytes, content]);
  const { tx } = handshake.split();

  const parts = [Buffer.from([SealScheme.NOISE_X]), u16(first.length), first];
  for (let offset = 0; offset < total; offset += CHUNK_PLAINTEXT) {
    const record = tx.encryptWithAd(EMPTY, plaintext.subarray(offset, offset + CHUNK_PLAINTEXT));
    parts.push(u16(record.length), record);
  }
  return Buffer.concat(parts);
}

/**
 * Open a sealed message addressed to this node (DATA body, scheme 0x01).
 *
 * Succeeds only if all of this holds: the body is in the one canonical framing for its
 * announced length; every Noise message authenticates under a handshake bound to `dst`
 * and `id`; `meta` is canonical JSON with a string `kind` and an integer `ts`; the
 * identity card in `meta` verifies and its e2e key is the Noise static key that sealed
 * the message; `meta.hs` is the card's identity key's signature over this message's
 * handshake hash and over the hash of its `meta` (without `hs`) and content; and `ts`
 * lies within `[now - maxAgeMs, now + maxFutureMs]`.
 *
 * The returned `senderId` is therefore authenticated, and so is everything returned with
 * it, even against someone who holds this node's e2e private key: they can read a genuine
 * message and re-encrypt it, but any change to its `meta` or content breaks the signature.
 * Replay protection is not provided here: the caller keeps a cache of seen (senderId, id)
 * pairs, written only after this function succeeds, and keeps each entry until
 * `ts + maxAgeMs + maxFutureMs` (DESIGN.md 15.10).
 *
 * @param {object} params
 * @param {Identity} params.recipient       this node
 * @param {string} params.dst               destination NodeId from the packet header
 * @param {string} params.id                message id from the packet header
 * @param {Uint8Array} params.body          the sealed body
 * @param {(() => number) | number} [params.now] clock, or a time, in ms since the epoch;
 *   default Date.now
 * @param {number} [params.maxAgeMs]        oldest acceptable `ts`, in ms before now
 * @param {number} [params.maxFutureMs]     newest acceptable `ts`, in ms after now
 * @returns {{ senderId: string, card: object, meta: object, content: Buffer }} `meta` and
 *   `card` are deep-frozen
 * @throws {CryptoError} if `recipient`, `now`, `maxAgeMs` or `maxFutureMs` is malformed
 * @throws {AuthError} for every other failure: a malformed, tampered, misaddressed,
 *   unauthenticated, stale or future-dated message
 */
export function openMessage({
  recipient,
  dst,
  id,
  body,
  now = Date.now,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxFutureMs = DEFAULT_MAX_FUTURE_MS,
} = {}) {
  if (!(recipient instanceof Identity)) throw new CryptoError('recipient must be an Identity');
  const time = readClock(now);
  if (!isDuration(maxAgeMs)) throw new CryptoError('maxAgeMs must be a non-negative integer');
  if (!isDuration(maxFutureMs)) throw new CryptoError('maxFutureMs must be a non-negative integer');
  try {
    return open(recipient, dst, id, body, time, maxAgeMs, maxFutureMs);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // Whatever went wrong was reached through attacker-supplied bytes: fail closed.
    throw new AuthError('sealed message rejected', { cause: err });
  }
}

function open(recipient, dst, id, body, time, maxAgeMs, maxFutureMs) {
  // dst is in the prologue, so a body sealed for another destination would fail anyway;
  // refusing up front also covers a card that lists somebody else's e2e key as its own.
  if (dst !== recipient.nodeId) throw new AuthError('message is not addressed to this node');
  if (!isMessageId(id)) throw new AuthError('message id is malformed');
  if (!(body instanceof Uint8Array)) throw new AuthError('sealed body is not a byte array');
  if (body.length > Limits.MAX_PACKET) throw new AuthError('sealed body is too large');
  const view = Buffer.from(body.buffer, body.byteOffset, body.length);
  if (
    view.length < HANDSHAKE_END ||
    view[0] !== SealScheme.NOISE_X ||
    view.readUInt16BE(1) !== HANDSHAKE_LENGTH
  ) {
    throw new AuthError('sealed body is malformed');
  }

  const handshake = withKeyPair(recipient.e2eKeyPair, s =>
    new HandshakeState({ pattern: E2E_PATTERN, initiator: false, prologue: e2ePrologue(dst, id), s })
  );
  const first = view.subarray(1 + LENGTH_PREFIX, HANDSHAKE_END);
  const total = handshake.readMessage(first).readUInt32BE(0);
  // Checked against the bytes actually present before anything is allocated or decrypted.
  const chunkCount = Math.ceil(total / CHUNK_PLAINTEXT);
  if (
    total < LENGTH_PREFIX ||
    view.length - HANDSHAKE_END !== total + chunkCount * (LENGTH_PREFIX + AEAD_TAG_LENGTH)
  ) {
    throw new AuthError('sealed body does not match its announced length');
  }

  const { rx } = handshake.split();
  const plaintext = Buffer.alloc(total);
  let offset = HANDSHAKE_END;
  for (let done = 0; done < total; done += CHUNK_PLAINTEXT) {
    const recordLength = Math.min(CHUNK_PLAINTEXT, total - done) + AEAD_TAG_LENGTH;
    if (view.readUInt16BE(offset) !== recordLength) {
      throw new AuthError('sealed body is not in canonical framing');
    }
    offset += LENGTH_PREFIX;
    rx.decryptWithAd(EMPTY, view.subarray(offset, offset + recordLength)).copy(plaintext, done);
    offset += recordLength;
  }

  const metaEnd = LENGTH_PREFIX + plaintext.readUInt16BE(0);
  if (metaEnd > total) throw new AuthError('message metadata overruns the message');
  const meta = parseCanonical(plaintext.subarray(LENGTH_PREFIX, metaEnd));
  if (!isPlainObject(meta)) throw new AuthError('message metadata is not an object');
  if (typeof meta.kind !== 'string' || meta.kind.length === 0) {
    throw new AuthError('message metadata has no kind');
  }
  if (!Number.isSafeInteger(meta.ts) || meta.ts < 0) {
    throw new AuthError('message metadata has no valid timestamp');
  }
  const card = verifyCard(meta.card);
  if (!card.ok) throw new AuthError(`sender identity card rejected: ${card.reason}`);
  // This is what authenticates the sender: Noise proved possession of the static key, and
  // the card proves that key belongs to the NodeId.
  if (!timingSafeEqual(card.e2ePublicKey, handshake.remoteStaticKey)) {
    throw new AuthError('message was not sealed with the key on the sender identity card');
  }
  // The e2e key alone does not prove authorship: whoever holds the recipient's e2e private
  // key can complete Noise_X claiming any static key, and can re-encrypt a genuine
  // message's transport records. Only the sender's identity key can sign this session's
  // handshake hash together with what the message says (DESIGN.md 15.9).
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
  if (meta.ts > time + maxFutureMs) {
    throw new AuthError('message timestamp is too far in the future');
  }

  deepFreeze(meta);
  return {
    senderId: card.nodeId,
    card: meta.card,
    meta,
    content: Buffer.from(content),
  };
}

/**
 * The bytes `meta.hs` signs after the domain (DESIGN.md 15.9):
 * `h || SHA-256(u32be(len(meta')) || meta' || content)`. The length prefix keeps the
 * boundary between meta' and the content unambiguous.
 */
function authInput(handshakeHash, unsignedMeta, content) {
  return Buffer.concat([
    handshakeHash,
    sha256(u32(unsignedMeta.length), unsignedMeta, content),
  ]);
}

/**
 * Seal one file chunk (DATA body, scheme 0x02).
 *
 * `body = 0x02 || transferId || u32be(index) || ChaCha20-Poly1305(key, nonce, ad, plaintext)`
 * with nonce = 4 zero bytes || u64be(index) and
 * ad = utf8(Domain.FILE_CHUNK) || 0x00 || transferId || u32be(index).
 *
 * The nonce is the chunk index, so under one key an index must only ever seal one
 * plaintext. Retransmitting the same chunk is fine; sealing different bytes at an index
 * already used with that key is not. Use a fresh random key per transfer.
 *
 * @param {object} params
 * @param {Uint8Array} params.key         32-byte transfer key
 * @param {Uint8Array} params.transferId  16 bytes
 * @param {number} params.index           chunk number, 0 to MAX_CHUNK_INDEX
 * @param {Uint8Array} params.plaintext   chunk bytes
 * @returns {Buffer} the sealed body
 * @throws {CryptoError} if an argument is malformed or the body would exceed Limits.MAX_PACKET
 */
export function sealChunk({ key, transferId, index, plaintext } = {}) {
  assertBytes(key, 'transfer key', KEY_LENGTH);
  assertBytes(transferId, 'transfer id', TRANSFER_ID_LENGTH);
  if (!Number.isInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) {
    throw new CryptoError(`chunk index must be an integer from 0 to ${MAX_CHUNK_INDEX}`);
  }
  assertBytes(plaintext, 'chunk plaintext');
  if (CHUNK_HEADER_LENGTH + plaintext.length + AEAD_TAG_LENGTH > Limits.MAX_PACKET) {
    throw new CryptoError('chunk is too large to seal into one packet');
  }
  const sealed = aeadEncrypt(key, chunkNonce(index), chunkAd(transferId, index), plaintext);
  return Buffer.concat([Buffer.from([SealScheme.TRANSFER]), transferId, u32(index), sealed]);
}

/**
 * Read the transfer id and chunk index of a scheme-2 body without decrypting it, to find
 * the transfer (and so the key) it belongs to. The values are NOT authenticated until
 * openChunk() succeeds.
 *
 * @param {Uint8Array} body
 * @returns {{ transferId: Buffer, index: number }}
 * @throws {AuthError} if the body is not a well-formed scheme-2 body
 */
export function peekChunk(body) {
  if (
    !(body instanceof Uint8Array) ||
    body.length < CHUNK_HEADER_LENGTH + AEAD_TAG_LENGTH ||
    body.length > Limits.MAX_PACKET ||
    body[0] !== SealScheme.TRANSFER
  ) {
    throw new AuthError('chunk body is malformed');
  }
  const view = Buffer.from(body.buffer, body.byteOffset, body.length);
  return {
    transferId: Buffer.from(view.subarray(1, 1 + TRANSFER_ID_LENGTH)),
    index: view.readUInt32BE(1 + TRANSFER_ID_LENGTH),
  };
}

/**
 * Open one file chunk (DATA body, scheme 0x02).
 *
 * @param {object} params
 * @param {Uint8Array} params.key   32-byte transfer key
 * @param {Uint8Array} params.body  the sealed body
 * @returns {{ transferId: Buffer, index: number, plaintext: Buffer }} all authenticated
 * @throws {CryptoError} if the key is not 32 bytes
 * @throws {AuthError} if the body is malformed or does not authenticate under the key
 */
export function openChunk({ key, body } = {}) {
  assertBytes(key, 'transfer key', KEY_LENGTH);
  const { transferId, index } = peekChunk(body);
  const sealed = body.subarray(CHUNK_HEADER_LENGTH);
  const plaintext = aeadDecrypt(key, chunkNonce(index), chunkAd(transferId, index), sealed);
  return { transferId, index, plaintext };
}

/**
 * Encrypt the body of a cast for a keyed channel (DESIGN.md sections 11 and 15.24).
 *
 * With b = canonicalBytes({ type, origin, chan, n, ts, enc, salt: base64(salt) }):
 *
 *   key        = HKDF-SHA256(ikm = channelKey, salt = salt, info = utf8(Domain.CAST) || 0x00 || b)
 *   ciphertext = ChaCha20-Poly1305(key, nonce = 12 zero bytes, ad = b, plaintext)
 *
 * The nonce is zero because every message has its own key: the salt is 32 fresh random
 * bytes chosen here, never by the caller, so no key is ever used twice. Binding the
 * signed record fields means a ciphertext cannot be re-signed by someone else as their
 * own cast, or moved to another channel, counter or time.
 *
 * @param {object} params
 * @param {Uint8Array} params.channelKey  32-byte shared channel key
 * @param {{ type: string, origin: string, chan: string, n: number, ts: number, enc: boolean }}
 *   params.fields  the cast record's fields, exactly these six: `type` "cast", `origin` a
 *   NodeId, `chan` a channel wire id, `n` and `ts` non-negative integers, `enc` true
 * @param {Uint8Array} params.plaintext  at most Limits.MAX_CAST_BODY bytes
 * @returns {{ salt: Buffer, ciphertext: Buffer }} 32-byte salt; ciphertext with 16-byte tag
 * @throws {CryptoError} if an argument is malformed or the plaintext is too large
 */
export function castEncrypt({ channelKey, fields, plaintext } = {}) {
  assertBytes(channelKey, 'channel key', KEY_LENGTH);
  const bound = castFields(fields);
  if (bound === null) {
    throw new CryptoError('cast fields must be exactly { type: "cast", origin, chan, n, ts, enc: true }');
  }
  assertBytes(plaintext, 'cast plaintext');
  if (plaintext.length > Limits.MAX_CAST_BODY) {
    throw new CryptoError(`cast body must be at most ${Limits.MAX_CAST_BODY} bytes`);
  }
  const salt = randomBytes(CAST_SALT_LENGTH);
  const { key, ad } = castKeyAndAd(channelKey, bound, salt);
  return { salt, ciphertext: aeadEncrypt(key, ZERO_NONCE, ad, plaintext) };
}

/**
 * Decrypt the body of a cast from a keyed channel. See castEncrypt() for the construction.
 *
 * @param {object} params
 * @param {Uint8Array} params.channelKey  32-byte shared channel key
 * @param {object} params.fields          the received record's `type`, `origin`, `chan`,
 *   `n`, `ts` and `enc`, exactly as signed
 * @param {Uint8Array} params.salt        the record's 32-byte salt
 * @param {Uint8Array} params.ciphertext  the record's body
 * @returns {Buffer} plaintext
 * @throws {CryptoError} if the channel key is not 32 bytes
 * @throws {AuthError} if the fields, salt or ciphertext are malformed, or the ciphertext
 *   does not authenticate under this key, salt and these fields
 */
export function castDecrypt({ channelKey, fields, salt, ciphertext } = {}) {
  assertBytes(channelKey, 'channel key', KEY_LENGTH);
  try {
    const bound = castFields(fields);
    if (bound === null) throw new AuthError('cast fields are malformed');
    if (!(salt instanceof Uint8Array) || salt.length !== CAST_SALT_LENGTH) {
      throw new AuthError('cast salt is malformed');
    }
    if (
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.length > Limits.MAX_CAST_BODY + AEAD_TAG_LENGTH
    ) {
      throw new AuthError('cast body is malformed');
    }
    const { key, ad } = castKeyAndAd(channelKey, bound, salt);
    return aeadDecrypt(key, ZERO_NONCE, ad, ciphertext);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('cast rejected', { cause: err });
  }
}

/**
 * Key for authenticating discovery beacons on a network with a pre-shared network key
 * (DESIGN.md 15.23): HKDF-SHA256(ikm = networkKey, salt = empty, info = utf8(Domain.BEACON)).
 *
 * The network key is also the Noise psk of the links; the derivation gives the beacon MAC
 * a key of its own, so the two uses never share key material.
 *
 * @param {Uint8Array} networkKey 32 bytes
 * @returns {Buffer} 32-byte beacon key
 * @throws {CryptoError} if the network key is not 32 bytes
 */
export function deriveBeaconKey(networkKey) {
  assertBytes(networkKey, 'network key', KEY_LENGTH);
  return hkdfExpand({
    ikm: networkKey,
    salt: EMPTY,
    info: Buffer.from(Domain.BEACON, 'utf8'),
    length: KEY_LENGTH,
  });
}

/**
 * HMAC-SHA256 of a beacon's bytes under the beacon key.
 *
 * @param {Uint8Array} key   32-byte key from deriveBeaconKey()
 * @param {Uint8Array} bytes the beacon bytes to authenticate
 * @returns {Buffer} BEACON_MAC_LENGTH bytes
 * @throws {CryptoError} if the key is not 32 bytes or `bytes` is not a byte array
 */
export function beaconMac(key, bytes) {
  assertBytes(key, 'beacon key', KEY_LENGTH);
  assertBytes(bytes, 'beacon bytes');
  return hmacSha256(key, bytes);
}

/**
 * Check a beacon MAC, in constant time. Beacon bytes and MAC come from the network, so
 * anything malformed is `false`, never an exception.
 *
 * @param {Uint8Array} key   32-byte key from deriveBeaconKey()
 * @param {unknown} bytes    the received beacon bytes
 * @param {unknown} mac      the received MAC
 * @returns {boolean}
 * @throws {CryptoError} if the key (a local value) is not 32 bytes
 */
export function verifyBeaconMac(key, bytes, mac) {
  assertBytes(key, 'beacon key', KEY_LENGTH);
  if (!(bytes instanceof Uint8Array)) return false;
  if (!(mac instanceof Uint8Array) || mac.length !== BEACON_MAC_LENGTH) return false;
  return timingSafeEqual(hmacSha256(key, bytes), mac);
}

/**
 * Wire identifier of a channel: what forwarders see instead of its name.
 *
 * First 16 bytes of SHA-256(utf8(Domain.CHANNEL_ID) || 0x00 || utf8(name) || 0x00 || k),
 * where k is HKDF-SHA256(channelKey, info = utf8(Domain.CHANNEL_ID), 32 bytes) for a keyed
 * channel and empty for a public one. A keyed channel's id therefore reveals neither its
 * name nor its key to nodes that are not members.
 *
 * The name is used as given: callers that accept names from people should normalise them
 * (for example to NFC) first, or the same visible name can yield two channels.
 *
 * @param {string} name            channel name; non-empty, well-formed, without U+0000
 * @param {Uint8Array} [channelKey] 32-byte channel key; omit for a public channel
 * @returns {string} 32 lowercase hex characters
 * @throws {CryptoError} if the name or key is malformed
 */
export function channelWireId(name, channelKey) {
  // U+0000 is the field separator of the hash input, and two names with lone surrogates
  // would encode to the same UTF-8.
  const usable =
    typeof name === 'string' && name.length > 0 && name.isWellFormed() && !name.includes('\x00');
  if (!usable) {
    throw new CryptoError('channel name must be a non-empty string without NUL characters');
  }
  const domain = Buffer.from(Domain.CHANNEL_ID, 'utf8');
  const parts = [domain, SEPARATOR, Buffer.from(name, 'utf8'), SEPARATOR];
  if (channelKey != null) {
    assertBytes(channelKey, 'channel key', KEY_LENGTH);
    parts.push(hkdfExpand({ ikm: channelKey, info: domain, length: KEY_LENGTH }));
  }
  return sha256(...parts).subarray(0, 16).toString('hex');
}

function e2ePrologue(dst, id) {
  return Buffer.concat([
    Buffer.from(Domain.E2E, 'utf8'),
    SEPARATOR,
    Buffer.from(dst, 'utf8'),
    SEPARATOR,
    Buffer.from(id, 'utf8'),
  ]);
}

function chunkNonce(index) {
  // 4 zero bytes || u64be(index); the index is a u32, so only the last four bytes vary.
  const nonce = Buffer.alloc(AEAD_NONCE_LENGTH);
  nonce.writeUInt32BE(index, AEAD_NONCE_LENGTH - 4);
  return nonce;
}

function chunkAd(transferId, index) {
  return Buffer.concat([Buffer.from(Domain.FILE_CHUNK, 'utf8'), SEPARATOR, transferId, u32(index)]);
}

/**
 * A copy of the six cast fields bound into encryption, or null if they are not exactly
 * those fields with acceptable values. Each field is read once, so what is checked is
 * what gets bound.
 */
function castFields(fields) {
  if (!isPlainObject(fields)) return null;
  const keys = Object.keys(fields);
  if (keys.length !== CAST_FIELDS.length || !CAST_FIELDS.every(key => Object.hasOwn(fields, key))) {
    return null;
  }
  const { type, origin, chan, n, ts, enc } = fields;
  const usable =
    type === RecordType.CAST &&
    isValidNodeId(origin) &&
    typeof chan === 'string' &&
    CHANNEL_ID_PATTERN.test(chan) &&
    isDuration(n) &&
    isDuration(ts) &&
    enc === true;
  return usable ? { type, origin, chan, n, ts, enc } : null;
}

/** The per-cast key and associated data of DESIGN.md 15.24. */
function castKeyAndAd(channelKey, bound, salt) {
  const ad = canonicalBytes({ ...bound, salt: base64Encode(salt) });
  const key = hkdfExpand({
    ikm: channelKey,
    salt,
    info: Buffer.concat([Buffer.from(Domain.CAST, 'utf8'), SEPARATOR, ad]),
    length: KEY_LENGTH,
  });
  return { key, ad };
}

/**
 * Run `use` with a key pair, then overwrite the private half: the getters on Identity hand
 * out copies, and HandshakeState keeps (and later wipes) a copy of its own.
 */
function withKeyPair(pair, use) {
  try {
    return use(pair);
  } finally {
    pair.privateKey.fill(0);
  }
}

function readClock(now) {
  const time = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new CryptoError('clock must give a non-negative integer number of milliseconds');
  }
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

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}
