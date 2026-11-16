/**
 * LAN discovery beacons: the exact bytes (DESIGN.md sections 8 and 15, item 23).
 *
 * A beacon is one UDP datagram holding the canonical JSON (RFC 8785 restricted as in
 * `core/wire/canonical.js`: keys sorted, integers only, no whitespace) of this record:
 *
 * ```
 * { "card": { "e2e": b64, "id": NodeId, "link": b64, "sig": b64 },
 *   "mac":  b64(32 bytes),            only on a network with a network key
 *   "net":  networkId,
 *   "origin": NodeId,
 *   "port": TCP listen port, 1..65535,
 *   "sig":  b64(64 bytes),
 *   "ts":   wall-clock milliseconds since the epoch,
 *   "type": "beacon" }
 * ```
 *
 * The datagram is at most `BEACON_MAX_BYTES` (2048) bytes. The receiver dials the UDP
 * *source* address of the datagram at TCP port `port`; the beacon does not say where it
 * comes from, because a sender cannot know which of its addresses a receiver can reach.
 *
 * **Signature.** As for every signed record (DESIGN.md section 3):
 * `sig = Ed25519(identity key, utf8("clawnet/1/record/beacon") || 0x00 || M_sig)` where
 * `M_sig` is the canonical JSON of the record without `sig` (and so *with* `mac` when
 * there is one). It binds the node id, the network id, the port and the time, and the
 * card binds the two X25519 keys to the same identity.
 *
 * **MAC** (a network with a network key only). `mac = HMAC-SHA256(K, M_mac)` with
 * `K = deriveBeaconKey(networkKey)` (HKDF-SHA256 of the network key with info
 * `utf8("clawnet/1/beacon")`, see `core/crypto/envelope.js`) and `M_mac` the canonical
 * JSON of the record **without `mac` and without `sig`**, that is of exactly
 * `{ card, net, origin, port, ts, type }`. There is no further prefix: `K` is already
 * separated from every other use of the network key by its derivation.
 *
 * **Verification order.** A receiver on a network with a key checks the MAC *before* the
 * signature: a MAC costs one HMAC, a signature two Ed25519 verifications (beacon and
 * card), so an outsider who does not know the key never makes the receiver do public-key
 * work. A beacon without a MAC is refused on such a network, and a beacon with a MAC is
 * refused on a network without a key (its sender could not complete a link handshake
 * with us anyway).
 *
 * A beacon is not secret and not replay-proof: anyone on the LAN can record one and play
 * it again until its `ts` leaves the clock-skew window. What a replay buys is one wasted
 * dial, which the dial budget and the beacon rate limits bound; the dial itself ends in
 * the authenticated handshake.
 *
 * Pure functions: no sockets, no timers, no clock of their own.
 */

import { beaconMac, verifyBeaconMac } from '../crypto/envelope.js';
import { verifyCard, verifyRecord } from '../crypto/identity.js';
import { base64Decode, base64Encode } from '../crypto/primitives.js';
import { CanonicalError } from '../errors.js';
import { canonicalBytes, parseCanonical } from '../wire/canonical.js';
import { validateBeacon } from '../wire/schema.js';
import { RecordType } from '../wire/types.js';

/** Largest beacon datagram accepted and sent, in bytes. */
export const BEACON_MAX_BYTES = 2048;

const MAC_BYTES = 32;

/**
 * Build the datagram of a beacon.
 *
 * @param {object} options
 * @param {import('../crypto/identity.js').Identity} options.identity the sender
 * @param {string} options.networkId  the network the node belongs to (`net`)
 * @param {number} options.port       TCP port other nodes should dial, 1..65535
 * @param {number} options.ts         wall-clock milliseconds since the epoch
 * @param {Uint8Array | null} [options.beaconKey] `deriveBeaconKey(networkKey)`, or null
 *   or omitted on a network without a key
 * @returns {Buffer} the datagram payload
 * @throws {import('../errors.js').CryptoError} if the identity or key is unusable
 * @throws {RangeError} if the result would not fit in BEACON_MAX_BYTES
 */
export function encodeBeacon({ identity, networkId, port, ts, beaconKey = null }) {
  const fields = { card: identity.card, net: networkId, port, ts };
  if (beaconKey !== null) {
    const macInput = canonicalBytes({ ...fields, origin: identity.nodeId, type: RecordType.BEACON });
    fields.mac = base64Encode(beaconMac(beaconKey, macInput));
  }
  const bytes = canonicalBytes(identity.signRecord(RecordType.BEACON, fields));
  if (bytes.length > BEACON_MAX_BYTES) {
    throw new RangeError(`beacon is ${bytes.length} bytes, limit is ${BEACON_MAX_BYTES}`);
  }
  return bytes;
}

/**
 * Parse and check the shape of a received datagram. No cryptography.
 *
 * @param {unknown} bytes the datagram payload
 * @returns {{ ok: true, beacon: object } | { ok: false, reason: string }} `reason` is
 *   "oversize", "not-canonical" (not canonical JSON: a beacon has exactly one encoding)
 *   or "bad-shape" (not a beacon record: wrong or missing fields, card of another
 *   origin, ...)
 */
export function parseBeacon(bytes) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'not-canonical' };
  if (bytes.length > BEACON_MAX_BYTES) return { ok: false, reason: 'oversize' };
  let record;
  try {
    record = parseCanonical(bytes);
  } catch (err) {
    if (err instanceof CanonicalError) return { ok: false, reason: 'not-canonical' };
    throw err;
  }
  if (!validateBeacon(record).ok) return { ok: false, reason: 'bad-shape' };
  return { ok: true, beacon: record };
}

/**
 * Authenticate a parsed beacon: the MAC first when the network has a key, then the
 * signature of the beacon, then the identity card.
 *
 * @param {object} beacon  a record that `parseBeacon` accepted
 * @param {Uint8Array | null} [beaconKey] `deriveBeaconKey(networkKey)` or null
 * @returns {{ ok: true } | { ok: false, reason: string }} `reason`: "no-mac" (the
 *   network has a key and the beacon carries no MAC), "unexpected-mac" (the opposite),
 *   "bad-mac", "bad-signature" or "bad-card"
 */
export function authenticateBeacon(beacon, beaconKey = null) {
  const hasMac = Object.hasOwn(beacon, 'mac');
  if (beaconKey === null) {
    if (hasMac) return { ok: false, reason: 'unexpected-mac' };
  } else {
    if (!hasMac) return { ok: false, reason: 'no-mac' };
    const { mac, sig: _sig, ...covered } = beacon;
    let macBytes;
    try {
      macBytes = base64Decode(mac, MAC_BYTES);
    } catch {
      return { ok: false, reason: 'bad-mac' };
    }
    if (!verifyBeaconMac(beaconKey, canonicalBytes(covered), macBytes)) {
      return { ok: false, reason: 'bad-mac' };
    }
  }
  if (!verifyRecord(beacon, RecordType.BEACON).ok) return { ok: false, reason: 'bad-signature' };
  if (!verifyCard(beacon.card).ok) return { ok: false, reason: 'bad-card' };
  return { ok: true };
}
