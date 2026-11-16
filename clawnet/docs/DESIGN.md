# ClawNet engine — design decisions

This is the authoritative design for the ClawNet node engine (`clawnet/`). It records
*what was decided and why*. `ARCHITECTURE.md` maps it onto modules, `PROTOCOL.md` is the
wire-level reference, `THREAT_MODEL.md` states what the design does and does not defend.

Where code and this document disagree, that is a bug in one of them: fix it and say which.

## 1. Goals and non-goals

ClawNet is a peer-to-peer overlay network. Nodes find each other, authenticate each
other, and exchange messages and files without any central service. A message may cross
several nodes to reach its destination; nodes in the middle forward it without being able
to read it.

Goals, in priority order:

1. **Real networking.** Real sockets, real cryptography, independent processes. Nothing
   in the engine is simulated; the UI shows only what the engine reports.
2. **Supportable security claims.** Every guarantee we state is one the design actually
   provides. No invented cryptography: Noise Protocol Framework patterns built from
   X25519, ChaCha20-Poly1305, SHA-256 and Ed25519 as provided by OpenSSL via `node:crypto`,
   verified against published Noise test vectors.
3. **Works when the network does not.** Disconnection, partition and restart are normal
   conditions, not errors.
4. **Small trusted base.** Zero runtime dependencies in the engine. Node.js >= 22.

Non-goals for v1: anonymity against a global observer, NAT hole punching, radio (LoRa)
transports, post-quantum key exchange, forward secrecy for stored messages, Sybil
resistance in open networks. These are listed as limitations, not hidden.

## 2. Module map

| Product name | Directory | Responsibility |
| --- | --- | --- |
| ClawNet Core | `src/core/` | identity, crypto, wire format, transport, peers, discovery, routing, reliable messaging, diagnostics, the `ClawNode` runtime |
| ClawSync | `src/sync/` | gossip push and anti-entropy pull for signed records |
| ClawCast | `src/cast/` | broadcast channels |
| ClawGate | `src/gate/` | relay and mailbox custody; the local control API that UIs and the CLI use |
| ClawVault | `src/vault/` | key storage at rest, durable stores, encrypted file transfer |
| ClawView | `../src/clawview/` | React + Three.js console served by ClawGate |

Layering rule: `core/crypto`, `core/wire`, `core/routing`, `vault/store`, `sync` contain no
socket or timer code of their own. They take injected `now()`, `send()`, `verify()`
functions. This keeps them unit-testable without a network and keeps I/O in
`core/transport`, `core/peer`, `core/discovery` and `core/node.js`.

## 3. Identity

- Each node has a long-term **Ed25519 identity key** and a long-term **X25519 static key**.
- **NodeId** = RFC 4648 base32 (lowercase, no padding) of the 32-byte Ed25519 public key:
  52 characters matching `^[a-z2-7]{52}$`. The id *is* the key, so any signature can be
  checked from the id alone and there is no directory to poison.
- **Identity card** binds the X25519 key to the identity (the libp2p-noise construction):

  ```
  card = { "id": NodeId, "dh": b64(x25519 public key), "sig": b64(signature) }
  signature = Ed25519-Sign(identity key, utf8("clawnet/1/static-key-binding") || 0x00 || x25519 public key)
  ```

- Binary values inside JSON are RFC 4648 base64 with padding. Decoders are strict: a value
  that does not re-encode to the same string is rejected.
- **Signed records** (LSAs, peer records, casts, beacons) are JSON objects with `type`,
  `origin` (NodeId) and `sig`. The signature covers
  `utf8("clawnet/1/record/" + type) || 0x00 || canonical-json(record without "sig")`.
- **Canonical JSON** is RFC 8785 (JCS) restricted to: ASCII object keys, integers in the
  IEEE-754 safe range only (no floats), no lone surrogates. See `src/core/wire/canonical.js`.
  PortLock implements the same rules so the two projects can verify each other's signatures.

## 4. Link security (node to node)

Every TCP link runs `Noise_XX_25519_ChaChaPoly_SHA256`. If the network has a pre-shared
network key the pattern is `Noise_XXpsk3_25519_ChaChaPoly_SHA256` and nodes without the key
cannot complete the handshake.

- Prologue: `utf8("clawnet/1") || 0x00 || utf8(networkId)`. Nodes on different networks or
  protocol versions fail the handshake instead of talking past each other.
- Message 1 (`-> e`) carries an empty payload. Messages 2 and 3 carry a handshake payload:
  `{ v, card, net, agent, caps, listen, observed, ts }` as canonical JSON.
- After the handshake each side checks that the Noise remote static key equals `card.dh`
  and that the card signature verifies. Only then is the peer's NodeId trusted. Then:
  reject self-connections, reject blocklisted ids, enforce the allowlist if one is set.
- Transport: each record is `u16be length || Noise transport message` (<= 65535 bytes). The
  decrypted records form a byte stream that carries `u32be length || packet` frames, so
  packets larger than one Noise message are split across records.
- Each direction calls Noise `Rekey()` after every 65536 records.
- TCP gives ordering; Noise's implicit nonces make any replayed, dropped or reordered
  record fail authentication, which closes the link.
- Simultaneous dials produce two links. The link initiated by the node with the smaller
  NodeId is kept; the other is closed with `BYE {reason:"duplicate"}`.

## 5. Packets

```
packet = u8 type | u8 flags (0) | u16be headerLen | header (canonical JSON) | body (bytes)
```

Link-local packets (never forwarded): `PING`, `PONG`, `BYE`, `GOSSIP`, `SYNC_DIGEST`,
`SYNC_REQUEST`, `SYNC_DELTA`. Routed packets: `DATA`, `PROBE`.

Limits enforced by every node: packet <= 1 MiB, header <= 8 KiB, per-peer token buckets for
packets and bytes, bounded queues everywhere. A peer that sends a malformed packet is
disconnected.

## 6. End-to-end messages

A `DATA` packet's header is all that a forwarding node can read:

```
{ "id": 32 hex chars, "dst": NodeId, "ttl": 1..32, "try": 0..255 }   (+ optional "cust": NodeId)
```

The **sender is not in the header.** Forwarders learn the destination and the previous
hop, not the originator.

The body is `u8 scheme || ...`:

- scheme `0x01` — a `Noise_X_25519_ChaChaPoly_SHA256` one-way message to the recipient's
  static key, with prologue `utf8("clawnet/1/e2e") || 0x00 || utf8(dst) || 0x00 || utf8(id)`.
  Binding `dst` and `id` means a forwarder cannot re-address or re-label a ciphertext.
  Plaintext is `u16be metaLen || meta (canonical JSON) || content`. `meta` always contains
  `kind`, `card` (the sender's identity card) and `ts`. The recipient checks that the Noise
  remote static key equals `meta.card.dh` and that the card verifies; that authenticates
  the sender.
- scheme `0x02` — ChaCha20-Poly1305 under a transfer key that was itself delivered inside a
  scheme-1 message (used for file chunks; see section 11).

What this provides: confidentiality and integrity against forwarders, and sender
authentication to the recipient. What it does not: forward secrecy (compromise of the
recipient's static key exposes recorded traffic), protection against key-compromise
impersonation, or hiding of destination, size and timing from forwarders.

**Replay.** Noise_X messages can be replayed by anyone who recorded them. The recipient
keeps a seen-cache keyed by `id` for the whole message lifetime (default 7 days) and
rejects `ts` older than that lifetime, so a replay is either a known duplicate or expired.

**Reliability.** A `msg` carries `ack: true`; the recipient answers with a sealed `ack`
naming the id. The sender retransmits with the same `id` and an incremented `try` using
exponential backoff until acked or expired.

**Duplicate suppression** happens at two levels: forwarders drop a `(id, try)` pair they
have already forwarded (kills transient loops and duplicate links without breaking
retransmission); the recipient delivers each `id` once and re-acks duplicates.

## 7. Routing

Signed link-state routing. Chosen over distance-vector because the same database gives
every node the topology that ClawView draws, and because each advertisement is signed by
the node it describes.

- **LSA** `{ type:"lsa", origin, seq, ts, links:[{peer, cost}], caps, sig }`. `seq` is
  `max(previous + 1, Date.now())`, persisted, so a restarted node always advertises a
  higher sequence. A node remembers the highest `seq` seen per origin for 24 h even after
  the LSA itself expires, so an old LSA cannot be replayed back in.
- LSAs are refreshed every 60 s and expire 210 s after *local receipt* (no dependence on
  synchronized clocks).
- A link is used only if **both** endpoints currently advertise it. A node can lie about
  its own links, not about anyone else's.
- Cost = smoothed keepalive RTT in milliseconds, minimum 1, with a penalty for missed
  keepalives. Re-advertised when it moves by more than 25 % or 10 ms. This is the
  adaptive part: routes follow measured link quality and change when links degrade or die.
- Routes are Dijkstra over the confirmed graph, recomputed (debounced 50 ms) on every LSDB
  change. Nodes with `caps.transit = false` are never used as intermediate hops.
- Forwarding: decrement `ttl`, drop at 0, drop already-seen `(id, try)`, send to next hop.
  With no route a forwarder holds the packet in a small bounded transit queue for up to
  30 s, then drops it; the originator's retransmission covers the loss.

Scaling limit: every node stores every LSA. This is appropriate for tens to low thousands
of nodes, and is documented as such.

## 8. Discovery

Three independent mechanisms; all end in the same authenticated handshake, so a forged
discovery message can waste a dial but cannot impersonate anyone.

1. **LAN multicast.** Signed beacons to `239.255.67.78:47470` announcing NodeId and TCP
   listen port. Receivers dial the UDP source address.
2. **Bootstrap peers.** A configured list, dialed at start and whenever the node has too
   few peers.
3. **Peer exchange.** Signed peer records `{ type:"peer", origin, seq, ts, addrs, caps, card, sig }`
   spread by ClawSync. A node below its target peer count dials addresses it has learned.

## 9. ClawSync

All synchronized data is self-authenticating signed records, so it does not matter which
peer relays them.

- **Eager push.** A record that is new to a node is forwarded to every other neighbor
  (batched for 25 ms). Old or duplicate records stop there.
- **Anti-entropy.** On link-up and then every 20 s with a random neighbor: exchange digests
  (latest `seq` per origin for last-writer-wins data; contiguous ranges for logs), then
  send what the other side lacks and request what we lack. Bounded batch sizes with
  continuation.

Datasets: peer records (LWW), LSAs (LWW), cast logs (append-only per channel and origin),
custody receipts. This is what makes partitions heal: once any link exists between two
halves, digests reconcile them.

## 10. Queues, custody, recovery

- **Outbox.** Every reliable message is persisted, already sealed, until acked or expired.
  No route means the message waits; an LSDB change that makes the destination reachable
  triggers an immediate attempt. Survives restart.
- **Mailbox custody (ClawGate).** A node with `caps.mailbox` accepts deposits: the sender
  hands it the sealed packet for an unreachable destination. The mailbox forwards it when
  the destination appears. The destination acks the originator end to end and sends the
  mailbox a signed receipt so it can purge. Quotas are enforced per depositor and overall.
  The mailbox never sees plaintext.
- **Connection recovery.** Known peers are persisted. Lost links are redialed with
  exponential backoff and jitter (1 s to 60 s). A new link triggers an immediate sync,
  which converges the LSDB, which flushes the outbox.

## 11. ClawCast and file transfer

- **Casts** are signed records `{ type:"cast", origin, chan, n, ts, enc, salt?, body, sig }`
  flooded and synchronized by ClawSync. `n` is a per-origin, per-channel counter, giving
  ordered, duplicate-free delivery per sender. A channel may have a shared 32-byte key;
  then `body` is ChaCha20-Poly1305 under `HKDF(channel key, salt = 32 random bytes)` with a
  zero nonce (fresh key per message, so nonce reuse cannot occur). Every node enforces a
  per-origin rate limit and a 16 KiB body limit.
- **Files.** The sender's `file-offer` (a reliable scheme-1 message) carries name, size,
  SHA-256, chunk size and a random 32-byte transfer key. Chunks are scheme-2 packets:
  ChaCha20-Poly1305 with nonce = chunk index and associated data = transfer id and index.
  The receiver selectively acknowledges, the sender retransmits gaps, and the receiver
  verifies the whole-file SHA-256 before the file leaves its `.part` name. Partial state is
  persisted, so an interrupted transfer resumes instead of restarting. File names are
  sanitized and writes are confined to the configured downloads directory.

## 12. Local control API

HTTP on `127.0.0.1` only by default. Every `/api/` request needs a bearer token (32 random
bytes, stored in the data directory with owner-only permissions). `Host` is checked
against an allowlist to defeat DNS rebinding. No CORS headers by default. Live events are
a `text/event-stream` read with `fetch` so the token travels in a header, never in a URL.
The same server serves the built ClawView console.

## 13. Defaults

| Setting | Default |
| --- | --- |
| Peer TCP port | 47470 |
| Multicast group / port | 239.255.67.78 / 47470 |
| API port | 47480 (loopback) |
| Keepalive / peer timeout | 10 s / 30 s |
| Handshake timeout | 10 s |
| Redial backoff | 1 s to 60 s, jitter 20 % |
| LSA refresh / max age | 60 s / 210 s |
| Sync interval | 20 s |
| Retransmit backoff | 2 s to 60 s |
| Message lifetime | 7 days |
| Hop limit (ttl) | 16 |
| Target / max peers | 8 / 64 |
| File chunk | 32 KiB |

Every timer is configuration, so tests run the real code paths with short intervals
rather than faking them.

## 14. Testing rules

- Tests bind to `127.0.0.1` with port `0`. Never a fixed port, never `0.0.0.0`.
- Each test uses its own temporary data directory and closes every node it starts.
- Integration tests use real TCP sockets between real `ClawNode` instances. A loopback
  TCP proxy (`test/helpers/netem.js`) adds latency, blackholes or cuts links, and records
  the bytes on the wire so tests can assert that plaintext never appears there.
- End-to-end tests start separate OS processes through the CLI.
- Everything here runs on one machine. No test in this repository demonstrates
  multi-machine operation, and the documentation must not say otherwise.
