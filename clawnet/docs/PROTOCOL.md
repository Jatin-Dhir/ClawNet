# ClawNet wire protocol, version `clawnet/1`

This is the wire-level reference for the protocol the engine in `clawnet/` speaks. It is
written from the code, not from the design: where it differs from `DESIGN.md` or
`ARCHITECTURE.md`, the code is what is described here, and the difference is a bug in one
of the documents. The code that defines each part is named at the start of its section.

There are two implementations: the engine, and since 18 November 2026 the browser node in
`web/core`, which implements what a phone needs (sections 2 to 7, 9 and 10 for the `lsa`
and `peer` datasets). The second was written by the same author from this document and the
engine's code, so agreement between them is evidence, not independent proof. The test
vectors in `test/vectors/` check the Noise handshakes `XX` and `X` and canonical JSON
against outside sources. The handshake `XXpsk0`, which private networks use for links,
has no published vector; see section 3.5.

Contents: 1 conventions · 2 identity and signatures · 3 the link · 4 packets and frames ·
5 link-local packets · 6 routed packets · 7 sealed messages · 8 file chunks ·
9 signed records · 10 ClawSync · 11 beacons · 12 ClawCast · 13 file transfer ·
14 limits · 15 what is not specified.

## 1. Conventions

**Protocol name.** `clawnet/1` (`PROTOCOL` in `src/core/wire/types.js`). It is part of every
Noise prologue and of every signature domain, so a node speaking another version fails the
handshake instead of misreading packets.

**Integers on the wire** are big-endian: `u16be`, `u32be`. `||` is concatenation.

**Canonical JSON** (`src/core/wire/canonical.js`) is RFC 8785 restricted to a subset that
is easy to reproduce:

- object keys are printable ASCII (0x20 to 0x7e), sorted by byte value;
- numbers are integers in the IEEE-754 safe range, in plain decimal; floats are an error;
- strings are well-formed Unicode (no lone surrogates) with the escaping of
  `JSON.stringify`;
- no whitespace; nesting at most 32 containers deep;
- the key `__proto__` is refused.

A receiver parses canonical JSON with a parser that re-encodes the value and compares it
with the input, so a value has exactly one accepted encoding. Anything else is rejected.

**Base64** is RFC 4648 with padding. Decoders are strict: a string that does not re-encode
to itself is rejected.

**NodeId.** 52 characters, the unpadded lowercase RFC 4648 base32 of a 32-byte Ed25519
public key. The 52nd character carries four unused bits that must be zero, so the pattern
is `^[a-z2-7]{51}[aq]$` and each key has one spelling. Public keys of small order are
refused.

**Other identifiers.** Message id, channel wire id, transfer id: 16 random bytes as 32
lowercase hex characters. Network id: 1 to 64 characters of `[A-Za-z0-9._-]`. Agent string:
1 to 64 printable ASCII characters. Address: `tcp://host:port`, at most 300 characters;
host is an IPv4 literal, a bracketed IPv6 literal or a DNS name (a name whose last label
is numeric is refused); port is 1 to 65535 in plain decimal.

**Strictness.** Every validator in `src/core/wire/schema.js` rejects unknown fields,
missing fields, wrong types and out-of-range values, and refuses `__proto__` at any depth.
The one exception is the `meta` of a sealed message of a kind that belongs to a service:
the transport-level fields are checked, and the rest is the service's to check.

**Time.** Timestamps (`ts`) and sequence numbers that are wall-clock based are
milliseconds since the Unix epoch. Intervals and expiry inside a node use a monotonic
clock and never appear on the wire.

## 2. Identity and signatures

Code: `src/core/crypto/identity.js`, `src/core/crypto/primitives.js`.

Each node holds an Ed25519 **identity key** and two X25519 keys: a **link key** (the static
key of link handshakes) and an **e2e key** (the static key that end-to-end messages are
sealed to). The three are independent. The NodeId encodes the identity public key.

**Signing.** Every signature is Ed25519 over `utf8(domain) || 0x00 || payload`. A domain
contains no zero byte, so no payload of one domain can be read as another's. Signature
verification is Node's (OpenSSL's) Ed25519; verification is refused outright for a public
key of small order.

| Domain string | Signs |
| --- | --- |
| `clawnet/1/static-key-binding` | an identity card (below) |
| `clawnet/1/record/<type>` | a signed record of that type (section 9) |
| `clawnet/1/e2e-auth` | a sealed message's authentication (section 7) |

Further strings that separate other uses of a key or hash: `clawnet/1` (link prologue),
`clawnet/1/e2e` (sealed-message prologue), `clawnet/1/cast` (cast key derivation),
`clawnet/1/beacon` (beacon MAC key), `clawnet/1/channel-id` (channel wire id),
`clawnet/1/file-chunk` (chunk associated data).

**Identity card.**

```
card = { "id": NodeId, "link": b64(32), "e2e": b64(32), "sig": b64(64) }
sig  = Ed25519-Sign(identity key,
         utf8("clawnet/1/static-key-binding") || 0x00 || link public key || e2e public key)
```

The card binds both X25519 keys to the identity. A card verifies if `id` is a valid NodeId,
`sig` verifies under the key `id` encodes, and the two keys are well-formed. A card has no
expiry or epoch.

**Capabilities.** `caps = { "relay": bool, "mailbox": bool, "transit": bool }`. In v1 `relay`
is only a dial preference. `transit: false` keeps a node out of other nodes' routes as an
intermediate hop. `mailbox` is advertised if configured; the engine has no mailbox service
(section 15).

## 3. The link

Code: `src/core/transport/secure-channel.js`, `src/core/crypto/noise.js`,
`src/core/peer/peer-manager.js`.

A link is one TCP connection. Everything on it after the TCP handshake is a Noise
handshake followed by Noise transport records.

### 3.1 Handshake pattern

| Network | Noise protocol name |
| --- | --- |
| no network key | `Noise_XX_25519_ChaChaPoly_SHA256` |
| `networkKey` configured | `Noise_XXpsk0_25519_ChaChaPoly_SHA256` |

The primitives are X25519, ChaCha20-Poly1305 and SHA-256. With a network key the 32-byte
key is the Noise pre-shared key, mixed in first (`psk0`): a node without the key fails on
the first message, before any Diffie-Hellman result is used and before the responder has
sent anything about itself.

**Prologue** = `utf8("clawnet/1") || 0x00 || utf8(networkId)`. The static key is the
node's link key.

Each handshake message is sent as `u16be length || noise message`. There are three:

```
-> e                       payload: empty
<- e, ee, s, es            payload: handshake payload of the responder
-> s, se                   payload: handshake payload of the initiator
```

### 3.2 Handshake payload

Canonical JSON, validated by `validateHandshakePayload`:

```
{ "v": 1, "card": card, "net": networkId, "agent": string,
  "caps": caps, "listen": [Address, ... at most 16],
  "observed": IP literal | null, "ts": ms }
```

`observed` is the remote IP address of the socket as the sender sees it (an IPv4-mapped IPv6
address is written as IPv4), or null. A peer can lie about it; the worst outcome is a wasted
dial somewhere else.

### 3.3 Checks, in order

Each side checks the other's payload as follows. The `HandshakeError` reason of each failure
is in brackets.

1. The payload is canonical JSON and an object (`bad-payload`).
2. `v` is 1 (`version`).
3. The payload matches the schema (`bad-payload`).
4. `net` equals the local network id (`network-mismatch`).
5. The Noise remote static key equals `card.link` (`key-mismatch`).
6. The card verifies (`bad-card`).
7. `|ts - now|` is at most `limits.maxClockSkewMs`, default 5 minutes (`clock-skew`).
8. The owner's admission policy: not this node itself (`self`), not on the blocklist
   (`blocked`), on the allowlist if one is set (`not-allowed`), below the peer limit
   (`full`), and not a duplicate link (`duplicate`).

A Noise decryption failure is `noise`; a wrong network id, a wrong network key, a different
protocol version and tampering all look like this and cannot be told apart. A stream that
ends is `closed`; the deadline (`timers.handshakeTimeoutMs`) is `handshake-timeout`.

### 3.4 Admission confirmation

The first frame the responder sends on the encrypted stream is the verdict: a `PING` with a
fresh nonce if the initiator is admitted, or `BYE {reason}` if it is refused. The initiator
considers the link up only after reading it, so a refused initiator never believes it has
a link.

### 3.5 What has and has not been checked

`XX` and `X` are verified against published Noise test vectors from two independent
implementations (`test/vectors/NOISE-VECTORS.md`). `XXpsk0` is not: neither vector source
contains it. It is built from the same tokens and the `psk` rules that the vectors for
`NNpsk0`, `KKpsk0` and `XXpsk3` do verify, and a hand-written transcription of the
specification in the test file agrees with it byte for byte. That last check shares the
author's reading of the specification and is not independent verification.

### 3.6 Transport

After the handshake each side has a sending and a receiving cipher state. The byte stream
in each direction is a sequence of **records**:

```
record = u16be length || ChaCha20-Poly1305 ciphertext (plaintext at most 65519 bytes, 16-byte tag)
```

The decrypted records are concatenated into a byte stream that carries **frames**
(section 4). A frame may span several records. Noise's implicit nonces make a dropped,
replayed or reordered record fail authentication, which closes the link.

**Rekey.** Each direction calls Noise `Rekey()` after every 65536 records.

**Send scheduling.** A link has three strict priority classes: control (`PING`, `PONG`,
`BYE`, sync and gossip), then acknowledgements, then data. The scheduler switches class
only at frame boundaries. Acks and data share a 4 MiB queue (acks may use a further quarter
of it, so data is refused first); control has its own 4 MiB bound, and overflowing it means
the peer has stopped reading and closes the link with reason `overflow`.

**Duplicate links.** At most one link per NodeId is active. If two links come up and were
initiated from opposite sides with handshakes that began within one handshake timeout of
each other, the two 32-byte identity public keys are compared as unsigned bytes and the link
initiated by the node with the smaller key is kept; the other gets `BYE {reason:"duplicate"}`.
Otherwise the newer authenticated link replaces the older (`BYE {reason:"replaced"}`).

**Receive budgets.** Control packets and routed packets are charged to separate token
buckets (`limits.peerPacketsPerSec`, `peerBytesPerSec` for control; `dataPacketsPerSec`,
`dataBytesPerSec` for routed). Control traffic over budget pauses reading from the link
until the bucket refills; it does not disconnect. A routed packet over budget is dropped and
counted, and the neighbour is not disconnected, because it may only be relaying someone
else's flood. Breaking a hard limit of the codec (section 4) disconnects.

### 3.7 Links over WebSocket

Code: `src/core/transport/websocket.js` (server), `web/core/channel.js` (the browser's side).

A browser cannot open a TCP connection, so a node can also accept links over WebSocket
(RFC 6455) on a separate, opt-in port (`websocket.enabled`, default port 47471). A WebSocket
link is the same link: sections 3.1 to 3.6 apply unchanged.

- **Upgrade.** `GET /` over HTTP/1.1 with `Upgrade: websocket`, `Connection: Upgrade`,
  `Sec-WebSocket-Version: 13`, a `Sec-WebSocket-Key` of 16 bytes in base64, and the
  subprotocol `clawnet.1` among those offered (`Sec-WebSocket-Protocol`), which the server
  echoes. No extension is negotiated. Refusals are plain HTTP: 400, 403 (Origin), 404
  (path), 405, 426 (version, with `Sec-WebSocket-Version: 13`); a request that is not an
  upgrade gets 426.
- **Origin.** A request without `Origin` is not from a browser and is admitted like a TCP
  connection. One with `Origin` is admitted if the origin is listed in
  `websocket.allowedOrigins`, or if it is the node's own web app: same host name as the
  request's `Host`, the web app's port, and a host name that is an IP address,
  `localhost`, a `.local` or `.home.arpa` name, or one of `webapp.allowedHosts`.
- **Mapping.** Binary messages carry the bytes of the link stream in order: the
  handshake's `u16be length || Noise message` and then the transport records, exactly as on
  TCP. Message boundaries have no meaning; a sender may split or join the stream as it
  likes. Text messages are refused (close 1003). The browser sends each handshake message
  and each record as one message.
- **Frames.** Client frames must be masked and minimally length-encoded, with the RSV bits
  clear; control frames are at most 125 bytes and unfragmented; a message is at most
  256 KiB (close 1009). Pings are answered with pongs; liveness is the link's own PING and
  PONG (section 5). A close frame is answered with one, and the connection ends. Any
  violation sends a close frame with the RFC's code and ends the connection.
- **Limits before the handshake.** At most 8 sockets per IP address and 96 in total on the
  port (`peers.max` plus 32), request headers within the handshake timeout and 8 KiB. After
  the upgrade the peer manager's limits apply as for TCP.
- **What a browser node announces.** `listen: []`, `observed: null` (a browser cannot see
  the socket's address), `caps: { relay: false, mailbox: false, transit: false }`, agent
  `clawnet-web/0.1.0`. The link is reported with `transport: "ws"` in `link.up` and in the
  peer list; `addr` is the TCP connection underneath, `tcp://ip:port`.

## 4. Packets and frames

Code: `src/core/wire/codec.js`, `src/core/wire/types.js`.

A **frame** carries one packet: `u32be length || packet`, with `length` from 1 to
1 MiB (1048576). A frame that declares length 0 or more than the limit is a protocol
violation.

A **packet**:

```
packet = u8 type | u8 flags (must be 0) | u16be headerLen | header | body
```

`header` is canonical JSON of an object, at most 8192 bytes. `body` is the rest. The whole
packet is at most 1 MiB. A receiver rejects an unknown type, non-zero flags, a header that
runs past the end or is not canonical JSON, and anything over a limit; a peer that sends
such a packet is disconnected.

| Type | Value | Class | Header | Body |
| --- | --- | --- | --- | --- |
| `PING` | 1 | link-local | `{ "n": 16 hex }` | empty |
| `PONG` | 2 | link-local | `{ "n": 16 hex }` | empty |
| `BYE` | 3 | link-local | `{ "reason": ^[a-z-]{1,32}$ }` | empty |
| `GOSSIP` | 16 | link-local | `{ "n", "set" }` | record batch |
| `SYNC_DIGEST` | 17 | link-local | see section 10 | list |
| `SYNC_REQUEST` | 18 | link-local | see section 10 | list |
| `SYNC_DELTA` | 19 | link-local | `{ "n", "set" }` | record batch |
| `DATA` | 32 | routed | `{ "id", "dst", "ttl", "try" }` and optional `"cust"` | sealed body |
| `PROBE` | 33 | routed | `{ "id", "dst", "ttl", "rsvp", "n" }` | empty |

Link-local packets (types below 32) are exchanged between two directly connected peers and
never forwarded.

**Send limits.** A node never sends a link-local packet above 64 KiB, or a routed packet
above 128 KiB (131072 bytes), so no packet occupies a slow link for long. The 1 MiB limit
is what a receiver accepts.

## 5. Link-local packets

**`PING` / `PONG`.** The header is `{ "n": <16 lowercase hex characters, 8 random bytes> }`.
A `PONG` echoes the nonce of the `PING` it answers, so a peer cannot answer a ping it has
not seen and a round-trip time cannot be faked low. The responder's admission confirmation
(section 3.4) is a `PING` with a fresh nonce. Any authenticated record received on a link
proves the peer alive, not only a `PONG`. Round-trip time is measured with a monotonic
clock and smoothed (weight 0.125 per sample); the link cost is the smoothed value in
milliseconds, at least 1 and at most 65535, with a penalty for missed keepalives.

**`BYE`.** The sender is closing the link. Reasons on the wire: `shutdown`, `manual`,
`duplicate`, `replaced`, `full`, `blocked`, `not-allowed`, `self`, `timeout`, `protocol`. A
received reason outside this list is treated as `unknown`.

Reasons that never travel in a `BYE`, used locally in events: `connect-failed`,
`connect-timeout`, `handshake-timeout`, `closed`, `noise`, `bad-payload`, `version`,
`network-mismatch`, `key-mismatch`, `bad-card`, `clock-skew`, `refused`; and for a link that
ends without one: `auth` (a record failed authentication), `eof`, `socket`, `overflow`.

`GOSSIP` and the three `SYNC_*` types are section 10.

## 6. Routed packets

Code: `src/core/routing/forwarder.js`, `src/core/routing/lsdb.js`, `src/core/routing/spf.js`.

### 6.1 `DATA`

```
header = { "id": 32 hex, "dst": NodeId, "ttl": 0..32, "try": 0..255 }   plus optional "cust": NodeId
body   = u8 scheme || ...            (sections 7 and 8)
```

The header is all a forwarder can read. The sender is not in it. That is not anonymity: a
forwarder knows the previous hop, the hop count and the whole topology.

- `ttl`: the originator sends `limits.ttl` (default 16). The destination delivers whatever
  the `ttl`. Any other node computes `ttl - 1`; if the result is below 1 it drops the
  packet (reason `ttl`), otherwise forwards it with the decremented value. A conforming
  node never transmits `ttl = 0`; the schema accepts it and it is dropped at the first
  forwarder.
- `try`: the originator's transmission counter modulo 256.
- `cust`: names a mailbox that is delivering a packet out of custody. Forwarders treat it as
  opaque. The engine never sets it (section 15).
- Body byte 0 selects the destination's handler: `0x01` goes to the message handler,
  `0x02` to the transfer handler. An empty body or unknown scheme is dropped at the
  destination as `malformed`.

### 6.2 Forwarding rules

1. A packet whose `dst` is the local node goes to its handler.
2. Duplicate suppression: the forwarder keeps `SHA-256(tag || dst || id || try || cust || body)`
   (tag `d` for `DATA`, `p` for `PROBE`) for 60 seconds (`timers.forwardDedupeTtlMs`) and
   drops a packet whose hash it holds. The hash includes the body, so one packet cannot
   cancel a later retransmission and a junk body cannot burn an id. The check comes before
   the `ttl` decrement.
3. Nodes with `caps.transit = false` do not forward for others (`no-transit`).
4. A destination that is a live direct neighbour is sent to directly, whatever the
   shortest-path computation says.
5. Otherwise the packet goes to the next hop of the route to `dst`. A packet whose next hop
   is the neighbour it came from is held, not bounced (`split-horizon`).
6. With no route, the packet is held in a bounded transit queue (`limits.transitQueueMax`
   entries, 32 MiB, and at most a quarter of the entries from any one previous hop) for up to `timers.transitHoldMs`
   (30 s) and then dropped (`hold-expired`). The queue is flushed when routes change, a link
   comes up or a link drains.
7. A packet over the routed send limit is dropped, not forwarded (`oversize`).

Drop reasons reported by the forwarder: `ttl`, `duplicate`, `no-transit`, `transit-full`,
`hold-expired`, `malformed`, `no-handler`, `oversize`. The messenger adds `auth` for a body
that failed to open.

### 6.3 Link-state routing

Routes are computed by Dijkstra over a graph built from signed LSAs (section 9.1). A link is
used only if both of its endpoints currently advertise it; the cost used is the larger of
the two advertised values, so a node cannot attract traffic by understating its own side.
Routes are recomputed on every database change, debounced by `timers.spfDebounceMs` (50 ms).

LSA rules:

- `seq` is `max(previous + 1, wall-clock ms)` and is persisted, so a restarted node
  advertises a higher sequence.
- A node issues at most one LSA per `timers.lsaMinIntervalMs` (5 s) and refreshes it every
  `timers.lsaRefreshMs` (60 s). Cost is re-advertised only when it has moved by more than
  25 percent and more than 10 ms.
- An LSA expires `timers.lsaMaxAgeMs` (210 s) after local receipt. The highest `seq` seen
  for an origin is remembered for `timers.lsaTombstoneMs` (24 h) after expiry.
- **Freshness is checked against wall-clock time.** An LSA whose `seq` is more than
  `lsaMaxAgeMs + maxClockSkewMs` behind the local clock, or more than `maxClockSkewMs` ahead
  of it, is rejected. Two nodes whose clocks differ by more than the skew will not route to
  each other.
- A node that sees an LSA of its own origin with a `seq` at or above its own jumps past it
  and re-originates. A second node persistently doing the same is reported as a cloned
  identity.
- Every per-origin table is capped (`limits.maxOrigins`, 10000); a neighbour may introduce
  only `limits.newOriginsPerPeerPerMin` previously unknown origins per minute.

### 6.4 `PROBE`

```
header = { "id": 32 hex, "dst": NodeId, "ttl": 0..32, "rsvp": NodeId, "n": 1..32 }   body empty
```

`rsvp` is the node that wants the answer; `n` is the `ttl` the originator set and is never
modified, so the hop index of a node is `n - ttl + 1` for the `ttl` it received. A probe
with `ttl > n` is malformed. The destination answers with a sealed, unreliable `probe-reply`
(section 7.5) carrying `at: "dst"`; a forwarder at which `ttl` runs out answers with
`at: "expired"`. A probe is unauthenticated, so `rsvp` can be forged: replies are limited to
20 per second in total and 5 per second per `rsvp`, and a node without the card of `rsvp`
stays silent. Ping is one probe with `n = limits.ttl`; traceroute sends probes with
`n = 1, 2, 3, ...`.

## 7. Sealed messages (`DATA` body scheme `0x01`)

Code: `src/core/crypto/envelope.js`, `src/core/messaging/reliable.js`.

### 7.1 Construction

A sealed message is a one-way `Noise_X_25519_ChaChaPoly_SHA256` exchange from the sender's
e2e key to the recipient's e2e key, with prologue

```
utf8("clawnet/1/e2e") || 0x00 || utf8(dst) || 0x00 || utf8(id)
```

so a forwarder cannot re-address or re-label a ciphertext. Body layout:

```
body = 0x01 || u16be(len M0) || M0 || { u16be(len Mi) || Mi }*
```

`M0` is the Noise handshake message, 100 bytes: ephemeral key (32), encrypted static key
(32 + 16) and an encrypted payload, `u32be(total plaintext length)` (4 + 16). Each `Mi` is a
Noise transport message from the sender's cipher state. Every chunk except the last carries
exactly 65519 plaintext bytes, so there is one valid framing for a plaintext. The recipient
rejects a body whose chunks do not add up to the announced length, which is what stops
truncation.

### 7.2 Plaintext

```
plaintext = u16be(len meta) || meta || content
meta      = canonical JSON { "kind", "card", "ts", "hs", ...kind-specific }
```

- `kind`: `^[a-z0-9-]{1,32}$`, selects the handler.
- `card`: the sender's identity card. `ts`: send time in ms.
- `hs`: base64 of the sender's identity-key signature (domain `clawnet/1/e2e-auth`) over
  `h || SHA-256(u32be(len meta') || meta' || content)`, where `h` is the Noise handshake
  hash and `meta'` is the canonical `meta` without `hs`. The signature covers the content as
  well as `h`, because the holder of the recipient's e2e key can derive the transport keys
  of a genuine message and could otherwise substitute its content.
- `meta` is at most 8 KiB. `limits.maxMessageBytes` (98304) bounds meta plus content so the
  sealed message fits one routed packet; chat text is at most 16384 bytes.

### 7.3 What the recipient checks

All of these, or the message is rejected with one undifferentiated error:

1. `dst` equals the local NodeId; `id` is 32 hex characters; the body is at most 1 MiB.
2. The framing is the canonical one for the announced length.
3. Every Noise message authenticates under the prologue bound to `dst` and `id`.
4. `meta` is canonical JSON with a string `kind` and an integer `ts`.
5. `meta.card` verifies and its `e2e` key equals the Noise remote static key.
6. `meta.hs` verifies under the card's identity key.
7. `ts` lies within `[now - messageLifetime, now + maxClockSkew]` (7 days back, 5 minutes
   forward).

**Replay.** Noise_X messages can be replayed by anyone who recorded them. The recipient
keeps a seen-cache keyed by (authenticated sender, `id`), written only after the whole body
verifies and the handler has run, persisted across restarts, and keeps each entry until
`ts + lifetime + skew`. A replay is therefore a known duplicate or expired. Without the
sender in the key, anyone who saw an id in a header could burn it before the real message
arrived.

### 7.4 Reliability

A `msg` carries `ack: true`; the recipient answers with a sealed `ack` naming the id. The
sender retransmits with the same `id` and an incremented `try`, with jittered exponential
backoff from `timers.retransmitMinMs` (2 s) to `retransmitMaxMs` (15 min), until acked or
`limits.messageLifetimeMs` (7 days) passes. At most 4 unacknowledged messages are in flight
per destination. An ack counts only if its authenticated sender is the message's
destination. The recipient delivers each (sender, id) once and re-acks duplicates, at most
one re-ack per `retransmitMinMs / 2`. An unknown kind is acked and not handled; a handler
that fails is not acked. Delivery to a handler is exactly-once without a crash and
at-least-once across one.

### 7.5 Kinds

| Kind | Reliable | `meta` fields besides `kind`, `card`, `ts`, `hs` | Content |
| --- | --- | --- | --- |
| `msg` | yes | `ack: true` | UTF-8 text, 1 to 16384 bytes |
| `ack` | no | `id`: the acknowledged message id | empty |
| `probe-reply` | no | `re`: probe id, `n`, `hop`, `at`: `"dst"` or `"expired"` | empty |
| `file-offer` | yes | `tid`, `name`, `size`, `chunk`, `sha256`, `key` | empty |
| `file-accept` | yes | `tid`, `base`, `ranges`, `win` | empty |
| `file-reject` | yes | `tid`, `reason` | empty |
| `file-sack` | no | `tid`, `base`, `ranges`, `win` | empty |
| `file-done` | yes | `tid`, `ok`, `reason?` | empty |
| `file-cancel` | yes | `tid`, `reason` | empty |

`ack` is a reserved meta field of the messenger for any kind that wants an acknowledgement.
`msg` and `ack` are reserved: no service may register them. Details of the file kinds are
in section 13.

## 8. File chunks (`DATA` body scheme `0x02`)

```
body = 0x02 || transferId (16) || u32be(index) || ChaCha20-Poly1305 ciphertext and tag
nonce = 4 zero bytes || u64be(index)
ad    = utf8("clawnet/1/file-chunk") || 0x00 || transferId || u32be(index)
```

The key is the 32-byte transfer key that travelled in the `file-offer`. The `DATA` header of
a chunk has a fresh random `id`, `try: 0` and the usual `ttl`. Chunks are not individually
acknowledged and not retransmitted by the messenger; section 13 describes how the receiver
asks for gaps. A chunk's nonce is its index, so one transfer key must never seal two
different plaintexts for one index; section 13 says how the sender enforces that.

## 9. Signed records

Signed records are canonical JSON objects with `type`, `origin` (NodeId) and `sig`. The
signature is Ed25519 over `utf8("clawnet/1/record/" + type) || 0x00 || canonical JSON of the
record without "sig"`. Code: `src/core/crypto/identity.js`, `src/core/wire/schema.js`.

### 9.1 `lsa`

```
{ "type": "lsa", "origin": NodeId, "seq": 1.., "ts": ms,
  "links": [ { "peer": NodeId, "cost": 1..65535 }, ... at most 256 ],
  "caps": caps, "sig": b64(64) }
```

A link may not name the origin and may not appear twice. Dataset: `lsa`, key `origin`,
version `seq`.

### 9.2 `peer`

```
{ "type": "peer", "origin": NodeId, "seq": 1.., "ts": ms,
  "addrs": [Address, ... at most 16], "caps": caps, "card": card, "sig": b64(64) }
```

`card.id` must equal `origin`. Peer records are how nodes learn the identity card of nodes
they are not linked to, which is what sealing a message to them needs; every node therefore
publishes one even with an empty `addrs`. Dataset `peer`, key `origin`, version `seq`.

The addresses a node announces are the configured `advertise` list, or else
`tcp://<ip>:<listen port>` for up to 4 of the most recent distinct `observed` values peers
reported. A signature on a peer record proves who said it, not that the address is theirs.

### 9.3 `cast`

```
{ "type": "cast", "origin": NodeId, "chan": 32 hex, "n": 1.., "ts": ms, "enc": bool,
  "body": base64, "sig": b64(64) }    plus "salt": b64(32) exactly when "enc" is true
```

Section 12.

### 9.4 `beacon`

Section 11.

### 9.5 `receipt`

```
{ "type": "receipt", "origin": NodeId, "id": 32 hex, "ts": ms, "sig": b64(64) }
```

The schema and the `receipt` dataset name exist so that every node floods receipts for a
future mailbox service. Nothing in this engine produces or consumes one (section 15).

## 10. ClawSync

Code: `src/sync/antientropy.js`, `src/sync/datasets.js`. This section folds in
`src/sync/SYNC-WIRE.md`, which has the same content with a worked example.

All synchronised data is self-authenticating signed records, so it does not matter which
peer relays them. Every node carries all four datasets, whether or not it uses them,
because flooding goes through every node.

| Dataset | Kind | Key or stream | Version or index | Bound |
| --- | --- | --- | --- | --- |
| `lsa` | last-writer-wins (LWW) | `origin` | `seq` | 10000 entries |
| `peer` | LWW | `origin` | `seq` | 10000 entries |
| `cast` | log | `chan + ":" + origin` | `n` | 64 per stream, 1024 streams |
| `receipt` | LWW | `origin + ":" + id` | `ts` | 20000 entries |

### 10.1 Common definitions

- **Dataset name** `set`: `^[a-z][a-z0-9-]{0,31}$`.
- **Key / stream id**: 1 to 128 printable ASCII characters without the space, ordered by byte
  value.
- **Record** on the wire: its canonical JSON, at most `MAX_RECORD` = 65464 bytes.
- **Record hash**: `SHA-256(canonical JSON of the record)`, signature included. A digest
  carries its first 8 bytes as 16 lowercase hex characters, written `h(record)`.
- **Record batch** (body of `GOSSIP`, `SYNC_DELTA`): `n` frames of `u32be length || record`,
  each length in 2..`MAX_RECORD`; the frames fill the body exactly. Header
  `{ "n": 1..1024, "set": name }`.
- **List** (body of `SYNC_DIGEST`, `SYNC_REQUEST`): one canonical JSON array of at most 1024
  elements; empty is `[]`.
- **Cursor**: an LWW key, or for a log `[stream, index]` with index in 0..2^53-1. In a header
  `null` means the start (`after`), the end (`upto`) or the whole page (`next`).
- **Summary**: SHA-256 of the canonical JSON list of every digest entry of a dataset in
  ascending order, 64 lowercase hex characters. Two nodes with equal summaries have nothing
  to exchange.

Limits: `MAX_ITEMS` 1024 (records per batch, entries per digest page, items per request),
`MAX_RECORD` 65464, `MAX_SYNC_PACKET` 65536 (what a node sends), `MAX_BODY` 1040380 (what a
receiver accepts), `MAX_RANGES` 32 (ranges in one log digest entry of a page). A sender
builds a batch of as many records as fit in `maxBytesPerPacket - 4 - 64` bytes and at most
`maxRecordsPerPacket` (256), and a digest page or request list within
`maxBytesPerPacket - 4 - 1024` bytes.

### 10.2 `GOSSIP` and `SYNC_DELTA`

Both carry records for one dataset and are processed identically; `GOSSIP` is the eager push
of records the sender has just accepted, `SYNC_DELTA` carries records sent in an
anti-entropy round. For each record in order the receiver:

1. drops it silently if its origin is refused by the blocklist or allowlist;
2. if its key or stream is new here, spends one unit of the sending peer's new-key budget
   (`newKeysPerMinute`, default 10000, refilled continuously) and drops it silently when the
   budget is spent;
3. offers it to the dataset, which applies cheap tests first (position in the total order,
   whether the index is held or pruned, whether there is room) and the full validation,
   including the signature, last.

Then: stored records are queued for `GOSSIP` to every other peer (batched for
`timers.gossipBatchMs`, 25 ms); old, duplicate, pruned, unstorable or tie-losing records are
dropped silently and not forwarded, which is what ends a flood; a malformed or invalid
record is dropped, ends processing of the packet and reports the peer (`invalid-record`).
A packet for a dataset the receiver does not run is ignored.

**Hold-down.** Per key at most one record is flooded per interval (5 s for LSAs): a record
accepted during an interval replaces any waiting record of that key and is flooded when the
interval ends. Every record is still stored on acceptance.

**Total order.** A higher version wins; at equal version the record with the greater record
hash wins and is flooded again. Two valid records of one key and one version are
equivocation by their origin and are reported as an event.

### 10.3 `SYNC_DIGEST` (17)

Sent only by the initiator of a round. A **summary** opens each dataset of a round:

```
header { "round": 1.., "set": name, "sum": 64 hex }   body []
```

A **page** states the sender's digest of a range:

```
header { "round", "set", "after": cursor|null, "upto": cursor|null, "hint"?: {...} }
body   list of digest entries, ascending, all inside (after, upto]
```

If both are given `after` is strictly before `upto`. A page is a complete statement about
its range: the sender holds exactly the listed entries there. The first entry after `after`
is always included, so paging advances.

**LWW entries:** `[key, version, h(record)]`, or `[key, version, 1]` for a tombstone (the
sender removed its record at that version and does not want that version or older again).
Hint `{ "min": version }`, present only at capacity: the sender can accept a record for a key
it does not hold only if its version exceeds `min`.

**Log entries:** `[stream, floor, high]`, `[stream, floor, high, ranges]` or
`[stream, floor, high, ranges, top]`. Indices at or below `floor` are pruned; every index in
`(floor, high]` is held; `ranges` (1 to 32 `[from, to]` pairs, ascending) is what is held
above `high`; `top` is present only if more ranges exist than were listed, and is then the
newest held index; such an entry is the last of its page and the page ends at the end of the
last range listed (`upto = [stream, end]`). Hint (mandatory for logs): `{ "win": n }`, the
retention window, optionally `"full": true` when the sender cannot track another stream.

### 10.4 `SYNC_REQUEST` (18)

The answer to one `SYNC_DIGEST`; exactly one is sent per digest, after the `SYNC_DELTA` (if
any) of the same page.

```
header { "round", "set", "next": cursor|null, "stop"?: "same"|"set"|"round" }
```

- Answer to a summary: `stop: "same"` if the responder's summary equals the one received
  (the dataset is done), `"set"` if it does not run the dataset, `"round"` if it declines the
  round; otherwise `next: null` and body `[]`, telling the initiator to send pages.
- Answer to a page: `next` is `null` if the whole page was processed, or the cursor up to
  and including which it was; it must lie strictly after the page's `after` and not after its
  `upto`. Body: request items in ascending order, each at or before `next`: an LWW key the
  page listed as a record; or a log range `[stream, from, to]` inside what the entry
  advertised and, after a restart cursor, above it. A request can never name anything the
  initiator did not offer in that page.

The receiver of a page compares it with its own state, key by key, records by
`(version, hash prefix)`:

| Sender's entry | Receiver holds | Action |
| --- | --- | --- |
| none | a record | push it (with `min`: only if its version exceeds `min`) |
| `[k, v, h]` | a later record | push it |
| `[k, v, h]` | an earlier record | want `k` |
| `[k, v, h]` | an equal record | nothing |
| `[k, v, h]` | nothing, or a tombstone below `v` | want `k` |
| `[k, v, h]` | a tombstone at or above `v` | nothing |
| `[k, v, 1]` | a record of version above `v` | push it |
| `[k, v, 1]` | anything else | nothing |

Two records whose hashes share the first 8 bytes compare equal; that needs a deliberate
64-bit collision by the origin itself and only delays convergence of that key.

For logs, per stream in ascending order, with `newest` the highest index either side holds:
push each held index the sender lacks and will keep (above its `floor`, above
`newest - win`, not in `(floor, high]` or a range); want, as ranges, each index the sender
holds that the receiver lacks and will keep (above the receiver's floor and above `newest`
minus the receiver's window). Floors keep pruning stable: an index at or below a floor is
never requested by the node that pruned it.

### 10.5 A round

A round is started by one node on link-up and then every `timers.syncIntervalMs` (20 s) with
a random peer. It is push-pull and stop-and-wait: one packet outstanding. For each dataset the
initiator sends a summary; if the responder's is the same the dataset is done, otherwise the
initiator walks its digest in pages. The responder pushes missing records in a `SYNC_DELTA`
and answers with a `SYNC_REQUEST`; the initiator sends the wanted records and continues with
a new page whose `after` is the cursor of the last record it sent, else `next`, else the
page's `upto`. Between converged nodes a round costs one summary and one answer per dataset.

Rules that bound a round:

- A responder pushes each position at most once per round and serves one round per peer at
  a time. A digest with a lower `round` is ignored; a higher `round` starts a new round
  unless the previous one began less than `minRoundIntervalMs` (default 1000 ms) ago, in
  which case it is declined with `stop: "round"`.
- An initiator accepts a `SYNC_REQUEST` only for its outstanding digest (same `round` and
  `set`), sends at most `maxRoundSteps` (4096) digests per round, shrinks pages down to 8
  entries while the responder completes little of each, and abandons a round with no reply
  for `roundTimeoutMs` (default 10 s). There are no retransmissions.
- Both ends may start a round on link-up; the node whose id is smaller starts it.

### 10.6 Violations

A receiver that detects one drops the packet, abandons the round and reports the peer, which
is then disconnected (`BYE {reason:"protocol"}`) and refused for `timers.redialMaxMs` (60 s by default). Reasons:
`bad-header`, `bad-body`, `bad-record` (not canonical JSON), `invalid-record` (not an object,
malformed key, version or stream, or failing the dataset's validation such as a bad
signature), `bad-digest`, `bad-hint`, `bad-cursor`, `bad-request`, `bad-range`. Not
violations and never reported: records that are old, duplicate, pruned, unstorable, refused
by origin policy or over the new-key budget; a valid record that loses an equal-version tie;
packets for a dataset the receiver does not run; a stale `SYNC_REQUEST` or `SYNC_DIGEST`. A
dataset check may also mark a refusal *soft* (well-formed and correctly signed but not
acceptable here and now, for example because of this node's clock or a quota): such a record
is dropped without blaming the peer. Schema and signature failures are always hard.

## 11. Beacons

Code: `src/core/discovery/beacon.js`, `src/core/discovery/multicast.js`.

A beacon is one UDP datagram of at most 2048 bytes, sent to the IPv4 multicast group
`239.255.67.78` port 47470 with multicast TTL 1 (it does not leave the local network), every
`timers.beaconIntervalMs` (5 s). It is the canonical JSON of

```
{ "type": "beacon", "origin": NodeId, "ts": ms, "port": 1..65535, "net": networkId,
  "card": card, "sig": b64(64) }    plus "mac": b64(32) on a network with a network key
```

The receiver dials the UDP **source address** of the datagram at TCP `port`. The beacon does
not say where it comes from, because a sender cannot know which of its addresses a receiver
can reach.

**Signature:** the record signature of section 9 over the record including `mac` and
excluding `sig`.

**MAC** (network key only): `mac = HMAC-SHA256(K, canonical JSON of {card, net, origin, port,
ts, type})`, with `K = HKDF-SHA256(networkKey, salt empty, info utf8("clawnet/1/beacon"), 32
bytes)`. A receiver on a network with a key checks the MAC before the signature, so an
outsider never makes it do public-key work. A beacon without a MAC is refused on such a
network and a beacon with a MAC is refused on a network without a key.

A receiver drops a beacon whose `|ts - now|` exceeds the clock skew, rate-limits beacons per
source address (`limits.beaconsPerSourcePerMin`, 30) and in total (`limits.beaconsPerMin`,
600) before any signature check, and ignores beacons from a NodeId already connected or in
backoff. A beacon is neither secret nor replay-proof until its `ts` leaves the skew window; a
replay buys one wasted dial, and every dial ends in the authenticated handshake. Addresses
learned from beacons or peer records that are loopback, unspecified, multicast or link-local
are not dialed unless `discovery.allowLoopback` is set.

## 12. ClawCast

Code: `src/cast/channels.js`, `src/core/crypto/envelope.js`.

A **channel** is a name (`^[a-z0-9][a-z0-9._-]{0,63}$`) and optionally a 32-byte key. Its
**wire id** is the first 16 bytes of
`SHA-256(utf8("clawnet/1/channel-id") || 0x00 || utf8(name) || 0x00 || k)`, hex-encoded, with
`k = HKDF-SHA256(channelKey, info utf8("clawnet/1/channel-id"), 32 bytes)` for a keyed channel
and empty for a public one. A keyed channel's id reveals neither its name nor its key to
nodes that are not members. Forwarders see only the wire id.

A cast is a `cast` record (section 9.3) in the `cast` log dataset, flooded and synchronised
by ClawSync by every node whether or not it joined the channel. `n` is a per-origin,
per-channel counter starting at 1, giving ordered, duplicate-free delivery per sender. The
body is the UTF-8 text (at most 16384 bytes) base64-encoded; for an encrypted channel the
body is the ciphertext and tag (at most 16400 bytes before base64) and `salt` is 32 random
bytes.

**Encryption.** Let `fields = { type, origin, chan, n, ts, enc: true }` (the signed fields)
and `ad = canonical JSON of fields plus salt (base64)`. The key is
`HKDF-SHA256(channelKey, salt, info = utf8("clawnet/1/cast") || 0x00 || ad, 32 bytes)` and the
body is ChaCha20-Poly1305 with a zero nonce, associated data `ad`. A fresh salt per message
gives a fresh key, so the zero nonce cannot repeat under one key. Binding the key and data to
the record means a non-member cannot re-sign a member's ciphertext as its own.

**Admission rules** (the dataset's check function). Schema and signature are hard failures.
Soft failures: a `ts` older than the message lifetime or beyond the clock skew, and the rate
limit. The rate limit is a function of signed content so that nodes holding the same records
reach the same verdict: with `K = limits.castPerOriginPerMin` (default 60, capped at 63, one
below the 64-record retention window), a record `n` is admitted only if `ts(n) - ts(n - jK)`
is at least `j` minutes for every held record `n - jK`, `ts(n + jK) - ts(n)` likewise for
every held `n + jK`, and `n` is not more than `K` past the newest held index. A record none of
whose neighbours is held cannot be judged and is admitted, so an honest record is never
refused whatever the order of arrival; a hostile origin is held to about `K` per minute per
stream plus one start-up burst. Two nodes can disagree about a hostile origin's records,
depending on arrival order, never about an honest one's. An origin may have at most 16
channels (streams) open in the dataset.

## 13. File transfer

Code: `src/vault/file-transfer.js`. Offers, acceptances, verdicts and acknowledgements are
sealed messages (section 7); chunks are scheme-2 packets (section 8).

**`file-offer`** (reliable) meta: `tid` (32 hex), `name` (1 to 255 UTF-8 bytes, well-formed),
`size` (non-negative integer), `chunk` (1 to 1032192; a receiver refuses an offer above
114688, the plaintext that fits a routed packet, with `file-reject` reason `invalid`),
`sha256` (base64 of the whole file's SHA-256), `key` (base64 of a random 32-byte transfer
key). A file has at most 2^20 chunks.

**`file-accept`** (reliable) and **`file-sack`** (unreliable) meta: `tid`, `base` (every chunk
below it is held), `ranges` (up to 64 ascending, disjoint `[from, to]` pairs of held chunks
above `base` and within 2048 of it), and `win` (the receiver's credit window, 1 to 1024).
`file-accept` carries the receiver's progress at the moment it accepts, so a receiver that restarted with part of the file on disk tells the sender what it already holds.

**`file-reject`** meta: `tid`, `reason` in `denied`, `busy`, `too-large`, `invalid`.
**`file-done`** meta: `tid`, `ok`, and for a failure `reason` in `hash`, `io`.
**`file-cancel`** meta: `tid`, `reason` in `user`, `source-changed`, `io`, `expired`; a cancel
from the peer with a reason other than `user` ends the receiving side as failed.

**Flow control** is receiver-driven credit. The sender may have chunk `i` in flight only if
`i < base + win`. The receiver's window starts at 4, grows by one with every acknowledgement
that advances `base`, is halved when a hole persists while later chunks arrive or when
nothing arrives for a stall interval, and never exceeds `files.window` (default 32). The
receiver acknowledges after every `min(8, ceil(win / 2))` new chunks and on a timer. The
sender retransmits chunks the sack shows missing.

**One key, one plaintext.** When the sender prepares the offer it records a 16-byte
truncated SHA-256 of every chunk and keeps the list (sealed on disk). Before sealing a chunk
it re-reads the chunk and compares; on a mismatch it aborts with `source-changed`, because
a chunk's nonce is its index and one key must never encrypt two different plaintexts. A new
`send` of the same file is a new transfer with a new key.

**Completion.** The receiver writes chunks to `<name>.<tid prefix>.part` inside the downloads
directory, verifies the whole-file SHA-256 against the offer, and only then moves the file
under its final, sanitised name. Progress is persisted (every 64 chunks or one second), so an
interrupted transfer resumes without resending what was acknowledged.

## 14. Limits

| Limit | Value | Enforced for |
| --- | --- | --- |
| Frame / packet | 1 MiB | every receiver; disconnect |
| Packet header | 8192 bytes | every receiver; disconnect |
| Noise record plaintext | 65519 bytes | Noise |
| Link-local packet a node sends | 64 KiB | sender |
| Routed packet a node sends or forwards | 128 KiB | sender, forwarder |
| `ttl` | 1 to 32, default 16 | forwarder |
| `try` | 0 to 255 | schema |
| Sealed `meta` | 8 KiB | sealing |
| Sealed message (meta and content) | `limits.maxMessageBytes`, 98304 | sender |
| Chat text, cast text | 16384 bytes | services |
| LSA links / peer record addresses | 256 / 16 | schema |
| Sync records per batch / entries per page | 1024 | schema |
| Sync record | 65464 bytes | sync |
| Handshake and beacon clock skew | `limits.maxClockSkewMs`, 5 min | handshake, beacons, LSAs, messages |
| Beacon datagram | 2048 bytes | multicast |
| File chunks per transfer | 2^20 | file transfer |

## 15. What is not specified

- **Mailbox custody.** `DATA.cust`, the `receipt` record and dataset, `caps.mailbox`, the
  `mailbox` configuration section and the messenger's custody hooks (`setCustodian`, the
  outbox's `custodian` and `custodyState` fields) exist. The service that would use them,
  designed in `ARCHITECTURE.md` section 8.3 (`custody-deposit` and `custody-result` messages,
  deposit quotas, receipts), has not been built, so no wire format for it is defined here.
- **NAT traversal, relays for unreachable nodes, other transports.** TCP direct dial, LAN
  multicast, and inbound WebSocket for browsers (section 3.7) only.
- **Version negotiation.** The handshake has a single version, 1. There is no mechanism for
  two versions to coexist on one link.
- **Anything about a second implementation.** The wire format is defined by this code.
