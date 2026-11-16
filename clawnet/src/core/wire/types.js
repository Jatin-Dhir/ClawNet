/**
 * Protocol constants shared by every module. No logic lives here.
 *
 * Changing a value in this file changes the wire protocol.
 */

/** Protocol name and version. Part of every handshake prologue and signature domain. */
export const PROTOCOL = 'clawnet/1';

/** Packet type byte. Values below 32 are link-local and are never forwarded. */
export const PacketType = Object.freeze({
  PING: 1,
  PONG: 2,
  BYE: 3,
  GOSSIP: 16,
  SYNC_DIGEST: 17,
  SYNC_REQUEST: 18,
  SYNC_DELTA: 19,
  DATA: 32,
  PROBE: 33,
});

/** Reverse lookup for logs and diagnostics. */
export const PACKET_TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(PacketType).map(([name, value]) => [value, name])),
);

/** True for packet types that are forwarded hop by hop towards `header.dst`. */
export function isRoutedType(type) {
  return type === PacketType.DATA || type === PacketType.PROBE;
}

/** `type` field of signed records. */
export const RecordType = Object.freeze({
  LSA: 'lsa',
  PEER: 'peer',
  CAST: 'cast',
  BEACON: 'beacon',
  RECEIPT: 'receipt',
});

/** First byte of a DATA packet body: how the rest is protected. */
export const SealScheme = Object.freeze({
  /** One-way Noise_X message to the recipient's static key. */
  NOISE_X: 1,
  /** ChaCha20-Poly1305 under a transfer key agreed inside a NOISE_X message. */
  TRANSFER: 2,
});

/** Domain-separation strings. Each signature and each Noise prologue uses exactly one. */
export const Domain = Object.freeze({
  /** Noise prologue prefix for link handshakes. */
  LINK: PROTOCOL,
  /** Noise prologue prefix for end-to-end sealed messages. */
  E2E: `${PROTOCOL}/e2e`,
  /** Signature binding a node's X25519 static key to its Ed25519 identity. */
  STATIC_KEY_BINDING: `${PROTOCOL}/static-key-binding`,
  /** Prefix for signed records; the record type is appended. */
  RECORD_PREFIX: `${PROTOCOL}/record/`,
  /** HKDF info for per-message cast keys. */
  CAST: `${PROTOCOL}/cast`,
  /** Signature by the sender's identity key over the Noise handshake hash of a sealed message. */
  E2E_AUTH: `${PROTOCOL}/e2e-auth`,
  /** HKDF info for the key that authenticates discovery beacons in a private network. */
  BEACON: `${PROTOCOL}/beacon`,
  /** HKDF info for deriving a channel's wire identifier from its key. */
  CHANNEL_ID: `${PROTOCOL}/channel-id`,
  /** Associated-data prefix for file chunks. */
  FILE_CHUNK: `${PROTOCOL}/file-chunk`,
});

/** Noise protocol names in use. */
export const NoiseProtocol = Object.freeze({
  LINK: 'Noise_XX_25519_ChaChaPoly_SHA256',
  // psk0, not psk3: the network key is mixed in before anything else, so a non-member's
  // first message is rejected before any Diffie-Hellman work is done for it.
  LINK_PSK: 'Noise_XXpsk0_25519_ChaChaPoly_SHA256',
  E2E: 'Noise_X_25519_ChaChaPoly_SHA256',
});

/** Hard limits. A peer that exceeds one is disconnected. */
export const Limits = Object.freeze({
  /** Largest packet (type byte through body) accepted from a peer. */
  MAX_PACKET: 1 << 20,
  /** Largest sync or gossip packet a node sends, so control traffic never waits long. */
  MAX_SYNC_PACKET: 64 * 1024,
  /** Largest routed packet a node sends or forwards, so one packet cannot hold a slow link. */
  MAX_ROUTED_PACKET: 128 * 1024,
  /** Largest packet header (canonical JSON) in bytes. */
  MAX_HEADER: 8 * 1024,
  /** Largest Noise message, fixed by the Noise specification. */
  NOISE_MAX_MESSAGE: 65535,
  /** Records per direction between Noise Rekey() calls. */
  REKEY_INTERVAL: 65536,
  /** Upper bound for the hop limit a packet may carry. */
  MAX_TTL: 32,
  /** Largest retransmission counter. */
  MAX_TRY: 255,
  /** Largest cast body in bytes, before base64. */
  MAX_CAST_BODY: 16 * 1024,
  /** Most links an LSA may list. */
  MAX_LSA_LINKS: 256,
  /** Most addresses a peer record may list. */
  MAX_PEER_ADDRS: 16,
});

/**
 * A NodeId: base32 (RFC 4648, lowercase, unpadded) of a 32-byte Ed25519 public key.
 *
 * 52 characters carry 260 bits, so the last character has four unused bits that must be
 * zero: it can only be "a" or "q". Requiring that makes the string a canonical name for
 * the key; otherwise sixteen different strings would name the same node.
 */
export const NODE_ID_PATTERN = /^[a-z2-7]{51}[aq]$/;

/** A message id: 16 random bytes as lowercase hex. */
export const MESSAGE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A channel wire id: 16 bytes as lowercase hex. */
export const CHANNEL_ID_PATTERN = /^[0-9a-f]{32}$/;
