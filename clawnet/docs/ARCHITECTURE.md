# ClawNet engine — architecture

`DESIGN.md` says what was decided and why. This document maps it onto modules: files,
exported signatures, who may import whom, events, timers, bounds and tests. It is the
contract the wave 2 and wave 3 engineers build against. `API.md` is the contract for the
local control API and for ClawView.

Wave 1 modules (`core/crypto`, `core/wire`, `core/events.js`, `core/config.js`,
`core/routing/{lsdb,spf,metric}.js`, `core/messaging/dedupe.js`, `vault/store.js`,
`vault/keystore.js`, `sync/`) are specified by their own JSDoc and are only referenced
here. Where this document and DESIGN.md disagree, DESIGN.md wins and this document has a
bug. Section 13 lists every point where DESIGN.md was silent and a decision was taken here.

Contents: 1 conventions · 2 layers · 3 data directory · 4 protocol details fixed here ·
5 wave 2 modules · 6 service contract · 7 node lifecycle · 8 wave 3 modules ·
9 event catalogue · 10 test helpers · 11 end-to-end flows · 12 bounds summary ·
13 decisions.

## 1. Conventions

**Words.** MUST, MUST NOT and MAY are used in the RFC 2119 sense. Signatures are written
as JavaScript with JSDoc-style types; `T | null` means the value is present and may be
null, `name?` means the property may be absent.

**Shared types.**

| Type | Meaning |
| --- | --- |
| `NodeId` | 52-character string, `NODE_ID_PATTERN` |
| `Address` | `"tcp://host:port"` as accepted by `validateAddress` |
| `Ms` | integer milliseconds; a point in time is milliseconds since the Unix epoch |
| `Packet` | `{ type: number, header: object, body?: Buffer }`, exactly what `encodePacket` takes and `decodePacket` returns |
| `Card` | identity card object, see `core/crypto/identity.js` |
| `Cancel` | `() => void`, idempotent |
| `Schedule` | `(fn: () => void, ms: number) => Cancel` |

**Clocks.** Every class takes `now: () => Ms` (wall clock, default `Date.now`). Anything
that is persisted, signed or compared with a peer's value uses `now()`. Round-trip times
are measured with `performance.now()` and only inside `core/transport` and `core/peer`.

**Timers.** Only `core/transport`, `core/peer`, `core/discovery/multicast.js`,
`gate/api-server.js` and `core/node.js` call `setTimeout`/`setInterval`. Every other
module takes an injected `schedule: Schedule` (the same shape `SyncEngine` uses) and arms
at most one pending timer per concern (the earliest deadline), re-arming when that
deadline changes. `ClawNode` passes a `schedule` backed by its `TimerSet` (section 5.9),
which catches exceptions and cancels everything at stop. Unit tests pass a fake.

**Errors.** Only the classes in `core/errors.js` are thrown on purpose.

| Situation | Class |
| --- | --- |
| TCP connect failed or timed out, any handshake failure, peer refused | `HandshakeError(reason)` with a reason from section 4.1 |
| Peer broke the protocol after the handshake | `ProtocolError` (the link is closed with `BYE {reason:"protocol"}`) |
| Operation impossible now: node not running, unknown peer, unknown destination, outbox full, limit reached | `StateError`; the message starts with a stable kebab-case token followed by `": "`, for example `unknown-destination: no identity card known for …`. Callers branch on `err.message.split(':')[0]` only where this document names the token |
| Bad argument from a local caller | `ConfigError` |
| Disk failure | `StoreError` |

No error message, log line or event ever contains key material, a passphrase, the API
token or message plaintext.

**Events.** Modules receive the node's `EventBus` as `events` and emit only the events
listed for them in section 9. Event data is plain JSON: byte strings are base64, ids are
strings, numbers are finite. Per-packet events are rate-capped (section 5.6).

**Stats.** Every stateful class has `stats(): object`, a flat object whose values are
non-negative integers (counters since start, or current gauges). `ClawNode#stats()`
nests them by module name. Names are listed with each module.

**Constants.** `config.js` rejects unknown keys, so a bound that has no configuration key
is an exported `const` in the module that enforces it and a constructor option of the same
meaning (camelCase) so tests can lower it. Timers without a key are derived from an
existing key by a formula stated here, so short test timers shrink them too.

**Logging.** `ClawNode` creates one logger: `log.debug|info|warn|error(msg: string,
fields?: object)`, one JSON object per line on stderr (`{ ts, level, mod, msg, ...fields }`),
filtered by `config.log.level`. Modules receive `log` already bound to their module name.
A module MUST work when `log` is omitted.

**Files this document adds.** A few files are introduced here that a wave brief may not
name: `core/discovery/pex.js`, `core/storage.js`, `src/index.js`, `core/diag/diag.js`,
`core/diag/counters.js`, the `src/cli/*` files and `bin/clawnet.js`. Each belongs to the
owner of the module it is listed under. `Router` deliberately lives in
`core/routing/forwarder.js` and `ConversationStore` in `core/messaging/reliable.js` so
that no cross-engineer import path depends on an unnamed file.

## 2. Layers

A module may import only from layers below its own, plus the exceptions in the last
column. Nothing imports upwards, and nothing in `src/core`, `src/sync` or `src/vault`
imports from `src/cast`, `src/gate` or `src/cli`.

| Layer | Modules | I/O allowed | May import |
| --- | --- | --- | --- |
| 0 | `core/errors.js`, `core/wire/types.js`, `core/wire/canonical.js` | none | nothing |
| 1 | `core/crypto/*`, `core/wire/codec.js`, `core/wire/schema.js`, `core/events.js`, `core/config.js`, `core/routing/lsdb.js`, `spf.js`, `metric.js`, `core/messaging/dedupe.js`, `sync/*`, `vault/store.js`, `vault/keystore.js` | files in `vault/*` and `config.js` only | layer 0; layer 1 as wave 1 defined |
| 2 | `core/transport/tcp.js`, `core/transport/secure-channel.js` | sockets, timers | layers 0-1 |
| 3 | `core/peer/address-book.js`, `core/peer/peer-manager.js` | timers (peer-manager) | layers 0-2 |
| 4 | `core/discovery/*`, `core/routing/forwarder.js`, `core/messaging/reliable.js`, `core/storage.js` | UDP and timers in `multicast.js`; files in `storage.js`; none in the others | layers 0-1 only. They reach peers and each other through injected functions, never by import. `storage.js` imports `vault/store.js` and `vault/keystore.js` |
| 5 | `core/node.js`, `src/index.js` | timers | layers 0-4 |
| 6 | `cast/channels.js`, `vault/file-transfer.js`, `gate/relay.js`, `core/diag/*` | files in `file-transfer.js`; no sockets, no timers | layers 0-1 only. Everything else arrives through the `ServiceContext` (section 6). Services never import `core/node.js`, layers 2-4, or one another |
| 6 | `gate/api-server.js` | HTTP socket, timers, static files | layers 0-1; the node arrives as `ctx.node` |
| 7 | `src/cli/*`, `bin/clawnet.js` | process, stdio, child processes | everything |

The DESIGN.md rule ("`core/crypto`, `core/wire`, `core/routing`, `vault/store`, `sync`
contain no socket or timer code") is extended: `core/routing/forwarder.js`,
`core/messaging/reliable.js`, `core/discovery/pex.js`, `core/discovery/bootstrap.js`,
`core/peer/address-book.js` and all layer 6 protocol services are also free of sockets and
of timers of their own. A reviewer checks it with:

```
grep -nE "setTimeout|setInterval|node:net|node:dgram|node:http" src   # only the files allowed above may match
```

## 3. Data directory

`resolveDataDir()` picks the directory; `ensurePrivateDir` creates it. Everything the node
persists lives here.

```
<dataDir>/
  lock                  pid of the owning process; exclusive create; see 7.1
  runtime.json          { pid, boot, nodeId, listen, api, startedAt }; removed on clean stop
  config.json           optional; read by loadConfig
  keystore.json         Keystore; secret = signSeed || linkPrivate || e2ePrivate (96 bytes)
  api-token             64 lowercase hex characters and "\n", mode 0600 (gate/api-server.js)
  state.json            plain  JsonFile  { lsaSeq, peerSeq }
  peers.json            plain  JsonFile  address book
  peer-records.json     plain  JsonFile  signed peer records (the card directory)
  seen.log              plain  AppendLog { id, at } for every delivered message id
  outbox.log            sealed log       outbox index
  outbox/<id>           sealed blobs     one encoded DATA packet per outbox entry
  conversations.log     sealed log       chat messages and their state changes
  services/<name>/...   storage of service <name>, through ctx.storage
  downloads/            default files.downloadsDir
```

"Plain" files hold only public or non-sensitive data. "Sealed" files are encrypted with
the keystore's `storageKey` (section 5.8). The keystore is never recreated automatically
once it exists: a keystore that fails to open aborts `start()`.

## 4. Protocol details fixed here

These complete DESIGN.md sections 4 to 11 where two implementers would otherwise have to
guess. They will be folded into `PROTOCOL.md`.

### 4.1 Link-local packets and reasons

All three have an empty body; a non-empty body, a missing field or an extra field is a
protocol violation.

| Type | Header | Meaning |
| --- | --- | --- |
| `PING` | `{ "n": integer 0..2^53-1 }` | keepalive request. `n` = 0 is the admission confirmation (5.2) and is never answered. `n` >= 1 increases by one per ping on a link |
| `PONG` | `{ "n": integer 1..2^53-1 }` | answer to the `PING` with the same `n`, sent immediately |
| `BYE` | `{ "reason": string matching ^[a-z-]{1,32}$ }` | the sender is closing the link |

`BYE` reasons, also used as `HandshakeError.reason` and in `link.down`:
`shutdown`, `manual`, `duplicate` (the other link between the two nodes is kept),
`replaced` (a newer link from the same initiator took over), `full`, `blocked`,
`not-allowed`, `self`, `timeout`, `protocol`. A received reason outside this list is
reported as `unknown`.

Further `HandshakeError` reasons that never travel in a `BYE`: `connect-failed`,
`connect-timeout`, `handshake-timeout`, `closed` (socket ended mid-handshake), `noise`
(a handshake message failed to decrypt: wrong network key, wrong network id, wrong
protocol version, or tampering; the four are indistinguishable by design), `bad-payload`,
`version`, `network-mismatch`, `key-mismatch` (Noise static key differs from `card.link`),
`bad-card`, `clock-skew`, `refused` (the responder closed with an unknown reason).

Reasons a link can end with besides a `BYE` reason: `auth` (a record failed
authentication), `eof` (TCP closed without `BYE`), `socket` (I/O error).

### 4.2 Routed packets

`ttl`. The originator sends `ttl = config.limits.ttl`. A node that receives a routed
packet whose `dst` is itself delivers it whatever the `ttl`. Any other node computes
`ttl - 1`; if that is less than 1 the packet is dropped (reason `ttl`), otherwise it is
forwarded carrying the decremented value. A conforming node therefore never transmits
`ttl = 0`; `validateDataHeader` accepts it, and it is dropped at the first forwarder.

`try`. The originator's transmission counter modulo 256: `try = attempt & 0xff`, where
`attempt` starts at 0. Seven days of 60-second retransmissions exceed 255, so the counter
wraps; this is safe because the forward seen-cache lifetime (below) is far shorter than
the 512 seconds the counter needs at minimum to wrap.

`cust`. Present only on a `DATA` packet that a mailbox is delivering out of custody; it
names that mailbox. Forwarders treat it as opaque. See 8.3.

Forward duplicate key. A forwarder's seen-cache key is
`"d:" + id + ":" + try + ":" + (cust ?? "")` for `DATA` and `"p:" + id` for `PROBE`.
Including `cust` lets a mailbox retransmit with its own `try` counter without colliding
with the originator's. The cache holds `config.limits.seenCacheEntries` entries for
`2 * config.timers.transitHoldMs`.

`DATA` body scheme. Byte 0 selects the local handler at the destination: `0x01` goes to
`ReliableMessenger`, `0x02` to the handler registered as `data.transfer`. A forwarder
never looks at the body. An empty body or an unknown scheme is dropped at the destination
(reason `malformed`), with no penalty to the previous hop, which could not have known.

### 4.3 Sealed messages (scheme 1)

`meta` is the canonical JSON object inside the sealed plaintext. Reserved keys:

| Key | Set by | Meaning |
| --- | --- | --- |
| `kind` | sender | string matching `^[a-z0-9-]{1,32}$`; selects the handler |
| `card`, `ts` | `sealMessage` | sender's identity card and send time |
| `ack` | `ReliableMessenger` | `true` when the sender wants a sealed `ack`; absent otherwise |
| `re` | sender | in `ack`, `probe-reply` and `custody-result`: the 32-hex id being answered |

All other keys belong to the kind. `meta` is at most 8192 bytes encoded
(`MAX_META_BYTES`), `content` at most 983040 bytes (`MAX_SEALED_CONTENT`, 960 KiB), which
keeps every sealed packet under `Limits.MAX_PACKET`.

Kinds registry (the complete v1 set; a kind is handled by exactly one module):

| Kind | Reliable | Owner | `meta` fields besides the reserved ones | `content` |
| --- | --- | --- | --- | --- |
| `ack` | no | `core/messaging/reliable.js` | `re` | empty |
| `msg` | yes | `core/messaging/reliable.js` (`ConversationStore`) | none | UTF-8 text, 1..16384 bytes |
| `custody-deposit` | yes | `gate/relay.js` | `ref`: id of the inner packet, `dst`: NodeId, `exp`: Ms | the encoded inner `DATA` packet |
| `custody-result` | yes | `gate/relay.js` | `re`: inner id, `ok`: boolean, `reason?`: string | empty |
| `file-offer` | yes | `vault/file-transfer.js` | `tid`, `name`, `size`, `sha256`, `chunk`, `key` | empty |
| `file-accept` | yes | same | `tid`, `base`, `ranges` | empty |
| `file-reject` | yes | same | `tid`, `reason` | empty |
| `file-sack` | no | same | `tid`, `base`, `ranges` | empty |
| `file-done` | yes | same | `tid`, `ok`: boolean, `reason?` | empty |
| `file-cancel` | yes | same | `tid`, `reason` | empty |
| `probe-reply` | no | `core/diag/diag.js` | `re`: probe id, `n`, `hop`, `at`: `"dst"` or `"expired"` | empty |

A handler MUST validate every `meta` field it reads (type, range, length) and ignore the
message on any violation. A handler MUST be idempotent per message `id` (7.3).

### 4.4 PROBE

DESIGN.md names `PROBE` as a routed packet and leaves its use open. Decided here:

- Header `{ id, dst, ttl, rsvp, n }`, empty body. `rsvp` is the NodeId that wants the
  answer (the originator). `n` is the `ttl` the originator set and is never modified, so
  the hop index of any node on the path is `n - ttl + 1` where `ttl` is the value it
  received. A probe with `ttl > n` is malformed.
- The destination answers with `at: "dst"`. A forwarder at which the `ttl` runs out
  answers with `at: "expired"`. Both answers are sealed, unreliable `probe-reply`
  messages to `rsvp` with `hop = n - ttl + 1`. The reply is authenticated by its seal, so
  a hop cannot be forged by anyone else.
- A node that has no identity card for `rsvp` cannot seal a reply and stays silent.
- `PROBE` is unauthenticated, so `rsvp` can be forged. Replies are therefore rate limited
  at every node: 20 per second in total and 5 per second per `rsvp` (token buckets, burst
  equal to the rate). Excess probes are dropped silently.
- Ping is one probe with `n = config.limits.ttl`. Traceroute is probes with
  `n = 1, 2, 3, …` until an answer has `at: "dst"` or `n` exceeds `config.limits.ttl`.

### 4.5 Synchronized datasets

Every node carries all four datasets, whether or not it uses them, because ClawSync
floods through every node. Names are wire-visible and fixed.

| Name | Class | Owner | Key or stream | Version or index | Bound |
| --- | --- | --- | --- | --- | --- |
| `lsa` | `LwwDataset` | `core/routing/forwarder.js` (`Router`) | `origin` | `seq` | 10000 entries |
| `peer` | `LwwDataset` | `core/discovery/pex.js` | `origin` | `seq` | 10000 entries |
| `cast` | `LogDataset` | `cast/channels.js` | `chan + ":" + origin` | `n` | 64 per stream, 1024 streams |
| `receipt` | `LwwDataset` | `gate/relay.js` | `origin + ":" + id` | `ts` | 20000 entries |

Each owner pins its own records (`pin(key)`), so eviction never removes what this node
originates. The eviction and retention rules themselves are those of `sync/datasets.js`:
an `LwwDataset` at capacity evicts its lowest unpinned version; `remove(key)` leaves a
floor that keeps the removed version from coming back; a `LogDataset` keeps a sliding
window per stream and refuses new streams when full until the owner calls `dropStream`.

**Check functions: hard and soft failures.** A dataset's `check(record)` returns a
`CheckVerdict` (`sync/datasets.js`), and its two kinds of refusal must not be confused:

- A **hard** failure means the relaying peer sent something no correct node would relay:
  the record fails its schema validator or its signature. `check` returns
  `{ ok: false, reason }`. The dataset marks the offer `invalid`, the `SyncEngine`
  reports the peer through `onError`, and the node closes the link.
- A **soft** failure means the record is well-formed and correctly signed but this node
  will not take it now: a rate limit, a quota, a timestamp outside this node's window.
  `check` returns `{ ok: false, reason, soft: true }`. The record is dropped quietly and
  not forwarded, and the peer is not blamed. The same record may be offered again in a
  later anti-entropy round; that is accepted, bounded cost.

Every check function in this document states for each test whether it is hard or soft.
Schema and signature are always hard; everything that depends on this node's clock,
counters or quotas is always soft, because two honest nodes can disagree about it.

`ClawNode` installs this `SyncEngine.onError(peerId, reason, detail)` policy: penalize
the peer (`PeerManager#penalize`: link closed with `BYE {reason:"protocol"}`, no
re-admission for the penalty period) and emit `sync.peer_error`.

A check function never refuses a record merely for being old or already known: the
datasets test that themselves, before calling `check`, so replays cost no signature
verification. Check functions are pure except for reading rate-limit state; they consume
rate-limit tokens only in `onAccept`, never in `check`.

### 4.6 The addresses a node announces

`ownAddresses()` is used both for the handshake payload's `listen` and for the peer
record's `addrs`:

1. If `config.advertise` is non-empty: exactly that list.
2. Otherwise: `tcp://<ip>:<bound listen port>` for each of the up to 4 most recent
   distinct values of `observed` that peers reported in handshakes (kept in memory by
   `PeerManager`). Before the first handshake the list is empty.

The value a node puts in `observed` is the remote IP of the socket, with an IPv4-mapped
IPv6 address (`::ffff:a.b.c.d`) rewritten to `a.b.c.d`. A peer can lie about `observed`;
the worst outcome is that other nodes waste a dial, since every dial ends in the
authenticated handshake.

### 4.7 The card directory

Sealing to a node needs its e2e key, which is in its identity card. A node learns cards
from handshakes (linked peers) and from `peer` records (everyone else). Every node
therefore always publishes a `peer` record, even with an empty `addrs`. Sending to a
NodeId whose card is unknown fails with `StateError("unknown-destination: …")`; nothing
is queued, because the outbox holds only sealed packets.

## 5. Wave 2 modules

Each module section gives: responsibility, files, imports, exports with semantics, events,
timers, bounds, tests. "Imports" lists what the module may import beyond layer 0; anything
else it needs is injected through the constructor.

### 5.1 `core/transport/tcp.js`

**Responsibility.** Opens the TCP listener and makes outbound TCP connections with a
deadline. It knows nothing about Noise, packets or peers.

**Files.** `src/core/transport/tcp.js`, `test/unit/transport-tcp.test.js`.
**Imports.** `node:net`, `core/errors.js`, `core/wire/schema.js` (`parseAddress`).

```js
export async function listenTcp({ host, port, onSocket, onError })
  // -> { address: { host: string, port: number }, close(): Promise<void> }
export function dialTcp({ host, port, timeoutMs, signal })   // -> Promise<net.Socket>
export function normalizeIp(address)                          // -> string
```

- `listenTcp` resolves once listening; `address.port` is the bound port (tests pass 0). A
  bind failure rejects with `StateError("listen-failed: …")`. `onSocket(socket)` is called
  for every accepted connection. `close()` stops accepting and resolves when the listener
  is closed; it does not touch accepted sockets.
- `dialTcp` rejects with `HandshakeError("connect-timeout")` after `timeoutMs`, with
  `HandshakeError("connect-failed")` on any socket error (the OS error is `cause`), and
  with `HandshakeError("closed")` when `signal` aborts. A DNS name is resolved by
  `net.connect`. No socket is left open on rejection.
- Every socket, both directions: `setNoDelay(true)`, `allowHalfOpen` false, no idle
  timeout (the peer layer has its own keepalive).
- `normalizeIp` rewrites `::ffff:a.b.c.d` to `a.b.c.d` and strips an IPv6 zone id.

**Events.** None. **Timers.** The dial deadline only. **Bounds.** None of its own; the
peer manager limits concurrent sockets.

**Tests.** Listen on `127.0.0.1:0` and dial it; dial a closed port (`connect-failed`);
dial with a 1 ms deadline against a listener that never accepts fast enough or an aborted
signal; `close()` while a dial is pending; `normalizeIp` cases.

### 5.2 `core/transport/secure-channel.js`

**Responsibility.** Runs the Noise XX / XXpsk3 link handshake over a connected stream,
verifies the remote identity, and then provides an authenticated, encrypted, ordered
packet stream with rekeying and backpressure. It is the only module that turns socket
bytes into packets.

**Files.** `src/core/transport/secure-channel.js`,
`test/unit/transport-secure-channel.test.js`.
**Imports.** `core/crypto/noise.js`, `core/crypto/identity.js` (`verifyCard`),
`core/crypto/primitives.js`, `core/wire/codec.js`, `core/wire/schema.js`,
`core/wire/canonical.js`, `core/wire/types.js`, `core/errors.js`.

```js
export const RECORD_PLAINTEXT_MAX = 65519;          // NOISE_MAX_PLAINTEXT of core/crypto/noise.js
export const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export async function establishChannel({
  stream,              // connected Duplex (a net.Socket in production)
  initiator,           // boolean
  identity,            // Identity
  networkId,           // string
  networkKey,          // Buffer(32) | null  -> XXpsk3 when set
  buildLocal,          // (observed: string | null) => { agent, caps, listen: Address[] }
  authorize,           // ({ id, card, payload, initiator }) => string | null
  now, handshakeTimeoutMs, maxClockSkewMs,
  maxQueueBytes, rekeyInterval,        // defaults above and Limits.REKEY_INTERVAL
})  // -> Promise<SecureChannel>; rejects with HandshakeError

export class SecureChannel {
  remoteId; remoteCard; remotePayload;   // verified; payload is frozen
  initiator; handshakeHash; handshakeRttMs;
  remoteAddress;                         // { host, port } | null (null for a non-socket stream)
  onPacket; onClose; onDrain;            // assigned by the owner before start()
  start(): void
  send(packet: Packet, { control = false } = {}): boolean
  pauseReading(): void
  resumeReading(): void
  get queuedBytes(): number
  close(reason?: string, { lingerMs = 500 } = {}): Promise<void>
  destroy(): void
  stats(): object
}
```

**Handshake.** Each handshake message travels as `u16be length || noise message`.
Prologue: `utf8(Domain.LINK) || 0x00 || utf8(networkId)`. Static key: `identity.linkKeyPair`.

1. Initiator sends message 1 with an empty payload.
2. Responder sends message 2 with its handshake payload
   `{ v: 1, card, net: networkId, agent, caps, listen, observed, ts: now() }` as canonical
   JSON. `agent`, `caps`, `listen` come from `buildLocal(observed)`; the responder calls
   `buildLocal(null)`. `observed` is `normalizeIp(stream.remoteAddress)` or null.
3. Initiator verifies the payload (below). On failure it destroys the stream without
   sending message 3 and rejects. On success it sends message 3 with its own payload,
   built with `buildLocal(payload.observed)`.
4. Both sides `split()`. The responder verifies the initiator's payload.
5. **Admission confirmation.** The responder's first frame on the encrypted stream is
   either `BYE {reason}` (refused; it then ends the stream and rejects with
   `HandshakeError(reason)`) or `PING {n: 0}` (admitted; it resolves). The initiator reads
   that first frame before resolving: `PING {n: 0}` resolves (the frame is consumed, not
   delivered and not answered), `BYE` rejects with `HandshakeError(reason)` (`refused` if
   the reason is not in the list of 4.1), anything else rejects with `protocol`. This step
   exists because in XX the responder learns who is calling only in message 3; without it
   a refused initiator would briefly believe it had a link.

Payload verification, in this order, each failure mapped to a `HandshakeError` reason:

| Step | Check | Reason |
| --- | --- | --- |
| 1 | `parseCanonical(payload bytes)` succeeds and yields an object | `bad-payload` |
| 2 | `v` is the integer 1 | `version` |
| 3 | `validateHandshakePayload` | `bad-payload` |
| 4 | `net === networkId` | `network-mismatch` |
| 5 | `base64Decode(card.link, 32)` equals the Noise remote static key (`timingSafeEqual`) | `key-mismatch` |
| 6 | `verifyCard(card).ok` | `bad-card` |
| 7 | `abs(ts - now()) <= maxClockSkewMs` | `clock-skew` |
| 8 | `authorize({ id: card.id, card, payload, initiator })` returns null | the returned string |

A Noise failure at any message is `noise`; a stream end is `closed`; the deadline
(`handshakeTimeoutMs`, covering all five steps) is `handshake-timeout`. On every
rejection the stream is destroyed. `handshakeRttMs` is the time from writing message 1 to
reading message 2 (initiator) or from writing message 2 to reading message 3 (responder).

**Record layer.** After the handshake:

- Outgoing packets are encoded (`encodePacket`), framed (`encodeFrame`) and appended to
  one of two FIFO queues: control (`control: true`; used for `PING`, `PONG`, `BYE`) and
  normal. A flush, scheduled with `setImmediate`, concatenates queued frames (control
  first, switching only at frame boundaries, never inside a frame), cuts the bytes into
  records of at most `RECORD_PLAINTEXT_MAX` bytes, encrypts each with the sending
  `CipherState` (empty associated data) and writes `u16be length || ciphertext`. It stops
  when `stream.write` returns false and continues on `drain`.
- `send` returns false, and queues nothing, when the channel is closed or when
  `queuedBytes` plus the frame would exceed `maxQueueBytes`; control frames are exempt
  from the bound. `onDrain()` is called when `queuedBytes` falls below half the bound
  after having exceeded it.
- Incoming: read `u16be length`; a length below 17 (no plaintext) or a ciphertext that
  fails authentication closes the channel (`protocol` and `auth` respectively). Plaintext
  goes through one `FrameDecoder`; each frame through `decodePacket`. A `WireError`
  closes with `protocol`. `BYE` is consumed here: the channel closes and `onClose`
  reports the peer's reason with `remote: true`. Every other packet goes to
  `onPacket(packet)`. `packet.body` is a view into the receive buffer and is valid
  indefinitely, but pins up to one frame of memory while referenced.
- **Rekey.** Each direction counts its transport records from 0 after `split()` (the
  confirmation frame's record is record 0 of the responder's sending direction). After
  processing a record with index `i` where `(i + 1) % rekeyInterval === 0`, the sender
  calls `rekey()` on its sending cipher and the receiver on its receiving cipher, before
  the next record. The nonce counter is not reset (Noise `Rekey()` leaves it alone).
- `pauseReading()` / `resumeReading()` pause the stream; frames already decoded may still
  be delivered.
- `close(reason)` queues `BYE {reason}` as control when a reason is given, flushes, ends
  the stream, waits up to `lingerMs` for it to close and then destroys it. `destroy()`
  closes immediately. `onClose({ reason, remote, error? })` is called exactly once, after
  which `send` returns false. `reason` is a `BYE` reason, or `auth`, `protocol`, `eof`,
  `socket`.

**Stats.** `recordsIn`, `recordsOut`, `packetsIn`, `packetsOut`, `bytesIn`, `bytesOut`
(ciphertext bytes on the wire), `rekeysIn`, `rekeysOut`, `sendRefused`, `queuedBytes`.

**Events.** None; the peer manager reports link events.
**Timers.** Handshake deadline, close linger. **Bounds.** Send queue `maxQueueBytes`;
receive memory one record plus one frame (1 MiB) plus one chunk.

**Tests.** Over real loopback TCP and over an in-memory duplex pair that can delay, split,
reorder and corrupt bytes:
- XX and XXpsk3 handshakes complete; both sides agree on `handshakeHash`, see each other's
  NodeId and payload.
- Each verification step fails with its reason: wrong network id and wrong or missing
  network key (`noise`), a card signed by another identity (`bad-card`), a valid card of a
  third node presented with our own static key (`key-mismatch`), non-canonical payload,
  unknown payload field, `ts` outside the skew, `authorize` refusal on each side (the
  initiator must observe the responder's reason through the confirmation frame and never
  resolve).
- Handshake deadline with a silent peer; stream closed at each step; garbage as message 1.
- Packets of 0 bytes body, 1 byte, 65519, 65520 and the largest legal packet round-trip;
  thousands of packets in both directions arrive in order; delivery is correct when the
  transport hands over one byte at a time.
- A flipped bit, a dropped record, a replayed record and two swapped records each close
  the channel with `auth`.
- With `rekeyInterval: 4`, a few hundred records in each direction stay in sync.
- Backpressure: with the reader paused, `send` eventually returns false, `queuedBytes`
  never exceeds the bound, control frames still queue, and after `resumeReading`
  everything queued arrives and `onDrain` fires.
- A control frame queued behind many normal frames is transmitted before the remaining
  normal frames.
- `close("shutdown")` is seen by the peer as `{ reason: "shutdown", remote: true }`.
- Wire privacy: the bytes captured between the two ends contain neither NodeId, nor either
  card's base64 fields, nor a known packet body.

### 5.3 `core/peer/address-book.js`

**Responsibility.** Remembers which addresses are worth dialing, which node was last
reached at each, and how the last attempts went. It is data and ordering only: it never
dials and holds no timers.

**Files.** `src/core/peer/address-book.js`, `test/unit/address-book.test.js`.
**Imports.** `core/wire/schema.js` (`validateAddress`), `core/wire/types.js`, `core/errors.js`.

```js
export const AddressSource = Object.freeze({
  MANUAL: 'manual', BOOTSTRAP: 'bootstrap', MULTICAST: 'multicast', PEX: 'pex', HANDSHAKE: 'handshake',
});

export class AddressBook {
  constructor({ doc, now, maxEntries = 4096 })   // doc: a Doc (5.8) with defaults { v: 1, entries: [] }
  async load(): Promise<void>
  async flush(): Promise<void>
  add(addr, { id = null, source }): boolean       // true if the address is new
  setAddressesFor(id, addrs, source): void        // replaces the set of addresses that `source` gave for `id`
  bind(addr, id): void                            // a dial to addr reached node id
  markSuccess(addr, id): void
  markFailure(addr, reason): void
  defer(addr, until: Ms): void                    // not persisted
  remove(addr): boolean
  markSelf(addr): void                            // remove and never accept again in this process
  get(addr): AddressEntry | null
  addressesOf(id): Address[]
  entries(): AddressEntry[]
  candidates({ exclude, sources, prefer, limit }): AddressEntry[]
  get size(): number
}
```

`AddressEntry`: `{ addr, id: NodeId | null, sources: string[], addedAt, lastOkAt: Ms | null,
lastFailAt: Ms | null, fails: number, lastError: string | null, nextAttemptAt: Ms }`.
`sources` is a sorted set; an entry is **static** when it contains `manual` or `bootstrap`.
`fails` counts consecutive failures and is reset by `markSuccess`. `nextAttemptAt` is
runtime-only (0 after a load).

- `candidates` returns entries with `nextAttemptAt <= now()`, with at least one source in
  `sources`, whose `id` is not in `exclude` (entries with `id === null` always qualify),
  at most one entry per known `id` (the one with the fewest fails), ordered by: static
  first, then `prefer(id) === true`, then fewer `fails`, then more recent `lastOkAt`, then
  `addr`. At most `limit`.
- `add` and `setAddressesFor` ignore invalid addresses and addresses marked as self.
- Eviction when `maxEntries` is exceeded: never a static entry; first the entry with the
  most `fails`, ties by oldest `lastOkAt` (never-reached first). Independently, a
  non-static entry with `fails >= 10` whose `lastOkAt` is null or older than 24 hours is
  dropped by `markFailure`.
- Every mutation except `defer` schedules a save through `doc.update`. Losing the file
  loses nothing that discovery will not find again.

**Events.** None (the callers emit `discovery.candidate`).
**Bounds.** `maxEntries`; 16 addresses per id (`Limits.MAX_PEER_ADDRS`, oldest dropped).

**Tests.** Persistence round trip through a real `JsonFile` in a temp dir; ordering of
`candidates` for every tie-break; `exclude` and one-per-id; backoff via `defer`; `bind`
moving an address from one id to another; eviction never removes static entries; the
10-failure rule; self addresses are refused forever; garbage in the loaded file (unknown
fields, bad addresses, wrong types) is dropped without throwing.

### 5.4 `core/peer/peer-manager.js`

**Responsibility.** Owns every link: dials and accepts, applies admission policy and
duplicate-link resolution, runs keepalive and RTT measurement, enforces per-peer rate
limits, and redials with backoff. Everything above it sends and receives packets by
NodeId and never sees a socket.

**Files.** `src/core/peer/peer-manager.js`, `test/unit/peer-manager.test.js`.
**Imports.** `core/transport/*`, `core/routing/metric.js`, `core/wire/*`, `core/errors.js`.
`AddressBook`, `EventBus` and `Identity` are injected.

```js
export class PeerManager {
  constructor({
    identity, config, events, addressBook, now, rng = Math.random, log,
    ownAddresses,      // () => Address[]                       (4.6; the node composes it)
    preferPeer,        // (id) => boolean                        (true for caps.relay nodes)
    advertisedCost,    // (id) => number | null                  (cost in our current LSA)
    onLinkUp,          // (peer: PeerInfo) => void
    onLinkDown,        // (peer: PeerInfo, { reason, remote }) => void
    onLinkCost,        // (id, cost) => void    when the cost should be re-advertised
    onPacket,          // (id, packet: Packet) => void   every packet except PING/PONG/BYE
    onObserved,        // () => void            the set of observed own addresses changed
  })
  async start(): Promise<{ host, port }>     // opens the listener, starts maintenance
  async stop(): Promise<void>                // BYE "shutdown" to every link, closes everything
  get listenAddress(): { host, port } | null
  connect(addr, { sticky = true } = {}): Promise<PeerInfo>
  disconnect(id, { reason = 'manual', forget = true } = {}): Promise<boolean>
  penalize(id, why): void
  send(id, packet, { control = false } = {}): boolean
  isLinked(id): boolean
  get(id): PeerInfo | null
  list(): PeerInfo[]
  dialing(): DialInfo[]
  links(): Array<{ peer: NodeId, cost: number }>
  cardOf(id): Card | null                    // linked peers only
  observedAddresses(): string[]              // up to 4 most recent distinct IPs
  get size(): number
  stats(): object
}
```

`PeerInfo` (a fresh plain object on every call): `{ id, linkId, direction: "in" | "out",
addr: Address, agent, caps, listen: Address[], since: Ms, rttMs: number | null,
srttMs: number | null, cost, misses, lastRxAt: Ms, packetsIn, packetsOut, bytesIn,
bytesOut, queuedBytes, throttled: boolean, sticky: boolean }`. `addr` is the remote socket
address. `DialInfo`: `{ addr, id: NodeId | null, source, since: Ms, attempt }`.

**Admission.** `authorize` (passed to `establishChannel`) refuses, in order: `self`
(remote id equals ours; the dialed address is passed to `addressBook.markSelf`),
`blocked` (in `config.peers.block`, or in the penalty box), `not-allowed`
(`config.peers.allow` is non-empty and does not contain the id), `full` (responder only:
`size >= config.peers.max` and there is no existing link to that id).

**Duplicate links.** At most one link per remote NodeId is *active*. When a handshake
completes for a node that already has a link:

- both links were initiated by the same side: the new link becomes active and the old one
  is closed with `BYE {reason:"replaced"}`;
- otherwise the link whose initiator has the smaller NodeId (plain string comparison)
  stays or becomes active, and the other is closed with `BYE {reason:"duplicate"}`.

Both ends apply the same rule to the same pair of links and so close the same one.
`link.up` is emitted when a node gets its first active link and `link.down` when it has
none left; replacing one link by another emits neither. A close with `duplicate` or
`replaced` is not a failure and schedules no redial.

**Link up.** On admission: `metric = new LinkMetric(); metric.sample(channel.handshakeRttMs)`;
`addressBook.markSuccess` (outbound) or `add(listen[i], { id, source: "handshake" })`
(inbound); record `payload.observed`; `channel.start()`; `onLinkUp`; `link.up`.

**Keepalive.** Per link, every `timers.keepaliveMs` (first one after a uniformly random
delay in `[0, keepaliveMs)`): if the previous `PING` is unanswered call `metric.miss()`;
then send `PING {n}` as control. A `PONG {n}` matching the outstanding ping gives
`metric.sample(elapsed)`; any other `PONG` is ignored. A received `PING {n >= 1}` is
answered at once with `PONG {n}` as control; `PING {n: 0}` after admission is a protocol
violation. After every sample or miss: emit `link.metric`, and if
`metric.shouldAdvertise(advertisedCost(id))` call `onLinkCost(id, metric.cost)`. A link on
which nothing at all was received for `timers.peerTimeoutMs` is closed with
`BYE {reason:"timeout"}`.

**Rate limiting.** Two token buckets per link for received traffic: packets
(`limits.peerPacketsPerSec`, burst one second's worth) and bytes
(`limits.peerBytesPerSec`, burst one second's worth but at least `2 * Limits.MAX_PACKET`).
Every received packet is charged. When a bucket goes negative the link's reading is paused
(`pauseReading`) until both are non-negative again, so TCP pushes back on the sender;
`link.throttled` is emitted at most once per second per link. Exceeding a rate never
closes a link; breaking a hard limit of `Limits` does (the codec throws).

**Protocol violations.** If `onPacket` throws a `ClawNetError` with code `ERR_PROTOCOL`,
`ERR_WIRE` or `ERR_CANONICAL`, or the peer manager itself sees a malformed
`PING`/`PONG`, it calls `penalize(id, why)`: close with `BYE {reason:"protocol"}` and put
the id in the penalty box for `timers.redialMaxMs` (no inbound admission, no dialing).
Any other exception from `onPacket` is reported as `internal.error` and the link stays.

**Dialing.** A maintenance pass runs every `timers.redialMinMs` and after every link-down:

1. Nothing if `size >= peers.max`.
2. Sticky entries (source `manual`, created by `connect`) that are not linked, not being
   dialed and due are always dialed.
3. While `size + dialing < peers.target`: take `addressBook.candidates` with sources
   `bootstrap`, `multicast`, plus `pex` and `handshake` when `config.discovery.pex` is
   true, excluding linked and dialing ids, with `prefer = preferPeer`.
4. At most `MAX_CONCURRENT_DIALS = 4` dials are in flight.

After a failed dial or a lost link, the address is deferred by
`min(redialMaxMs, redialMinMs * 2^(fails-1)) * (1 + redialJitter * (2 * rng() - 1))`.
Special cases: refused with `full`: `redialMaxMs`; `blocked` or `not-allowed`:
`10 * redialMaxMs`; a link that lasted at least `peerTimeoutMs` resets `fails` first, so
the first redial comes after about `redialMinMs`.

`connect(addr)` validates the address (`ConfigError`), adds it as `manual`, dials at once
and resolves with the `PeerInfo` when the node is linked (also when the handshake ends
in `duplicate` because a link to that node already exists). It rejects with the
`HandshakeError`, or with `StateError("peer-limit: …")` when the node is at `peers.max`.
With `sticky: true` the address keeps being redialed until `disconnect(id, { forget: true })`,
which also removes the node's `manual` sources.

**Inbound limits.** At most `MAX_PENDING_INBOUND = 32` inbound handshakes at a time and
`MAX_PENDING_PER_IP = 4` per remote IP; connections beyond that are destroyed on accept.

**Events.** `peer.dialing`, `peer.dial_failed`, `peer.refused`, `link.up`, `link.down`,
`link.metric`, `link.throttled` (section 9).
**Timers.** `keepaliveMs`, `peerTimeoutMs`, `handshakeTimeoutMs` (also the TCP connect
deadline), `redialMinMs`, `redialMaxMs`, `redialJitter`.
**Bounds.** `peers.max` links; 32 pending inbound; 4 dials; penalty box 1024 ids.
**Stats.** `links`, `dialing`, `dialsStarted`, `dialsFailed`, `handshakesIn`,
`handshakesRefused`, `linksOpened`, `linksClosed`, `duplicatesResolved`, `penalties`,
`packetsIn`, `packetsOut`, `bytesIn`, `bytesOut`, `throttleEvents`, `sendRefused`.

**Tests.** Two or three real `PeerManager`s on loopback with short timers:
- link up on both sides with the right `PeerInfo`; packets flow by NodeId; `stop()` gives
  the other side `link.down` with reason `shutdown`.
- Simultaneous dials end with exactly one active link on each side, the same one; no
  `link.down` is emitted; no redial follows.
- A node restarts and redials while the other still holds the stale link: `replaced`.
- `self`, `blocked`, `not-allowed`, `full`: the dialer's `connect` rejects with that
  reason and neither side emits `link.up`.
- Keepalive: RTT samples arrive; with a 30 ms netem latency the cost converges near 60;
  blackholing the link raises `misses` and then closes with `timeout` within
  `peerTimeoutMs` plus one keepalive.
- Redial: after a cut, attempts follow the backoff schedule (assert on `peer.dialing`
  timestamps with tolerance) and the link returns after `heal()`.
- Rate limit: a peer sending faster than the bucket is paused, not disconnected, and all
  its packets still arrive.
- A handler throwing `ProtocolError` closes the link with `protocol` and blocks
  re-admission for the penalty period; a handler throwing `TypeError` does not.
- Target maintenance: with three bootstrap addresses and `target: 2` exactly two are
  dialed; a sticky address is redialed above target.
- 40 simultaneous inbound connections that never speak are capped at 32 and time out.

### 5.5 `core/discovery/`

**Responsibility.** Finds addresses to dial by three independent means and feeds them to
the address book; it also holds the card directory. It never creates a link itself: every
discovered address ends in the peer manager's authenticated handshake.

**Files.** `src/core/discovery/multicast.js`, `bootstrap.js`, `pex.js`;
`test/unit/discovery-multicast.test.js`, `discovery-pex.test.js`.
**Imports.** `core/crypto/identity.js` (`verifyRecord`, `verifyCard`), `core/wire/*`,
`sync/datasets.js` (`pex.js` only), `node:dgram` (`multicast.js` only), `core/errors.js`.

```js
// multicast.js
export const BEACON_MAX_BYTES = 2048;
export class MulticastDiscovery {
  constructor({ identity, networkId, group, port, iface, listenPort, intervalMs,
                maxClockSkewMs, isLinked, onCandidate, events, now, createSocket, log })
  async start(): Promise<void>
  async stop(): Promise<void>
  stats(): object
}

// bootstrap.js
export class BootstrapDiscovery {
  constructor({ addresses, addressBook, events })
  start(): void       // add every address with source "bootstrap"
  kick(): void        // defer(addr, 0) for every bootstrap address
}

// pex.js
export class PeerExchange {
  constructor({ identity, caps, ownAddresses, addressBook, doc, state, pex, maxClockSkewMs,
                events, now, log })
  get dataset(): LwwDataset                  // name "peer"
  async load(): Promise<void>                // re-offer persisted records (they are re-verified)
  attach(publish): void                      // publish: (record) => { accepted }
  refresh(): boolean                         // publish our record if its content changed
  noteCard(card): void                       // a card verified in a handshake
  cardOf(id): Card | null
  recordOf(id): object | null
  async flush(): Promise<void>
  stats(): object
}
```

**Multicast.** One IPv4 UDP socket (`reuseAddr: true`), bound to `port` on `iface` (or the
wildcard address when `iface` is null), member of `group`, multicast TTL 1, loopback on.
Every `intervalMs` it sends the canonical JSON bytes of a signed beacon
`{ type: "beacon", origin, ts: now(), port: listenPort(), net: networkId, card, sig }`.
On a datagram: drop if larger than `BEACON_MAX_BYTES`; `parseCanonical`; `validateBeacon`;
drop if `net !== networkId`, if `origin` is ours, if `abs(ts - now()) > maxClockSkewMs`,
or if `isLinked(origin)`; take a token from the verification bucket (50 per second; drop
if empty); `verifyRecord(beacon, "beacon")` and `verifyCard(beacon.card)`; then
`onCandidate({ id: origin, addr: formatAddress(sourceIp, beacon.port), card })`. The node
wires `onCandidate` to `addressBook.add(addr, { id, source: "multicast" })`,
`pex.noteCard(card)` and, for a new address, `discovery.candidate`. Socket errors
(no multicast route, permission) are logged once, counted, and disable multicast; they
never fail the node. `createSocket` defaults to `dgram.createSocket` and exists for tests.

**Bootstrap.** `config.discovery.bootstrap` addresses are static entries; the peer
manager's maintenance pass dials them whenever the node is below target. The node calls
`kick()` when its last link goes down.

**Peer exchange.** `dataset` is an `LwwDataset` named `peer` with `key = origin`,
`version = seq`, `maxEntries = 10000`.
- `check(record)`: `validatePeerRecord`, then `verifyRecord(record, "peer")`, then
  `verifyCard(record.card)`; each failure is hard. `ts > now() + maxClockSkewMs` is soft
  (`future`).
- `onAccept(record, { isNew, from })` for a foreign origin:
  `addressBook.setAddressesFor(origin, addrs, "pex")`, schedule a save, emit `peer.record`.
- Our own record: `{ type: "peer", origin, seq, ts, addrs: ownAddresses(), caps, card }`
  with `seq = max(state.peerSeq + 1, now())`, persisted in `state.json` before publishing.
  `refresh()` publishes only when `addrs` or `caps` differ from the last published record
  or nothing was published yet in this process. The node calls it at start and whenever
  `onObserved` fires. Our key is pinned. If a record of ours with a higher `seq` arrives
  from the network, `peerSeq` is raised past it and `refresh()` publishes again.
- `cardOf(id)`: the card noted from a handshake or beacon, else the card in the node's
  peer record, else null.
- `doc` is `peer-records.json` with `{ v: 1, records: [] }`; saves are coalesced.
- With `pex: false` records are still accepted, relayed and used as the card directory;
  only the peer manager stops dialing `pex` and `handshake` addresses.

**Events.** `discovery.candidate`, `discovery.error`, `peer.record`.
**Timers.** `timers.beaconIntervalMs` (inside `multicast.js`).
**Bounds.** Datagram 2048 bytes; 50 signature checks per second; 10000 peer records.

**Tests.**
- Multicast with an injected fake socket: a valid beacon yields one candidate with the
  datagram's source IP and the beacon's port; wrong network, own origin, bad signature,
  card of another node, stale `ts`, oversize, non-canonical bytes and a linked origin each
  yield none; the verification bucket caps work under a flood; a socket error disables
  the module without throwing.
- One real-socket test on an ephemeral port chosen per test (first socket binds port 0,
  the others reuse the number) with `iface: "127.0.0.1"`: two instances see each other.
  It is skipped, with the reason logged, when the platform refuses multicast on loopback.
- Pex with real identities: a valid record is accepted and its addresses reach the
  address book; a record with a forged signature, a card of another identity, or a card
  whose id differs from the origin is a hard failure; a future `ts` is soft; an older
  `seq` does not replace a newer one; our own record is republished with a higher `seq`
  when addresses change and not otherwise; a network copy of our record with a higher
  `seq` makes the next one higher still; records survive a reload and are re-verified.

### 5.6 `core/routing/forwarder.js`

Two classes: `Router` is the control plane (LSDB, our LSA, shortest paths), `Forwarder`
the data plane (per-packet decisions and the transit queue).

**Responsibility.** `Router` keeps the link-state database in step with ClawSync,
originates this node's LSA, and computes the routing table. `Forwarder` decides for every
routed packet whether to deliver, forward, queue or drop it.

**Files.** `src/core/routing/forwarder.js`, `test/unit/routing-router.test.js`,
`test/unit/routing-forwarder.test.js`.
**Imports.** `core/routing/lsdb.js`, `spf.js`, `core/messaging/dedupe.js`,
`core/crypto/identity.js` (`verifyRecord`), `core/wire/schema.js`, `core/wire/types.js`,
`sync/datasets.js`, `core/errors.js`.

```js
export const TRANSIT_MAX_BYTES = 32 * 1024 * 1024;
export const PACKET_EVENTS_PER_SEC = 200;

export class Router {
  constructor({ identity, caps, state, links, isLinked, events, now, schedule, log,
                timers,          // { lsaRefreshMs, lsaMaxAgeMs, lsaTombstoneMs, spfDebounceMs }
                maxOrigins = 10000 })
  get dataset(): LwwDataset            // name "lsa"
  attach(publish): void                // publish: (record) => { accepted }
  start(): void                        // originate, arm refresh and sweep
  stop(): void
  linkUp(id): void
  linkDown(id): void
  linkCost(id): void
  advertisedCost(id): number | null
  nextHop(dst): NodeId | null
  isReachable(dst): boolean
  route(dst): Route | null             // { nextHop, cost, hops, path }
  routes(): Route[]                    // each with dst; nearest first
  caps(id): { relay, mailbox, transit } | null
  nodeIds(): NodeId[]                  // every origin with a current LSA
  topology(): TopologySnapshot
  onRoutesChanged(listener): Cancel    // listener({ rev, reachable: NodeId[], unreachable: NodeId[] })
  get rev(): number
  stats(): object
}

export class Forwarder {
  constructor({ selfId, transit, nextHop, send, events, now, schedule, log,
                ttl, transitHoldMs, transitQueueMax, transitQueueMaxBytes = TRANSIT_MAX_BYTES,
                seenEntries, packetEventsPerSec = PACKET_EVENTS_PER_SEC })
  handle(from: NodeId, packet: Packet): void          // a routed packet received from a peer
  originate(packet: Packet, { path } = {}): { ok: true, nextHop } | { ok: false, reason }
  onLocal(selector, handler): void                    // 'data.sealed' | 'data.transfer' | 'probe' | 'probe.expired'
  flush(): void                                       // try the transit queue again
  takeTrafficSample(): object                         // deltas since the last call, for traffic.sample
  stats(): object
}
```

**Router: database.** `state` is the `state.json` Doc. The router constructs
`new Lsdb({ selfId, validate: validateLsa, verify, now, maxAgeMs: timers.lsaMaxAgeMs,
tombstoneMs: timers.lsaTombstoneMs, maxOrigins })` and an `LwwDataset` named `lsa`
(`key = origin`, `version = seq`, `maxEntries = maxOrigins`):

- `check(record)`: `validateLsa`, then `verifyRecord(record, "lsa")`; both hard. A record
  that passes is remembered in a `WeakSet`; the `verify` function given to the `Lsdb`
  returns true for records in that set and otherwise verifies, so a signature is checked
  once.
- `onAccept(record, { from })`: for a record that this node did not publish itself, call
  `lsdb.upsert(record)` and record the local receipt time. A result of
  `own-origin-newer` raises `state.lsaSeq` to at least `result.seq` and originates at
  once (reason `superseded`). Other refusals are counted and otherwise ignored. Emit
  `lsa.accepted` when the database accepted it.
- Expiry keeps the two in step. When the database expires an LSA, the router calls
  `dataset.remove(origin)`: the dataset then holds a floor at that `seq`, advertises it,
  and refuses the same or an older LSA from any peer, exactly as the database's tombstone
  does. When the database has forgotten the tombstone (`lsdb.highestSeq(origin) === 0`,
  after `lsaTombstoneMs`), the router calls `dataset.forget(origin)`. It tracks the
  expired origins for this in a set bounded by `maxOrigins`. Our own key is never removed.

**Router: our LSA.** `originate(reason)`:
`seq = max(state.lsaSeq + 1, now())`; save it; `links` = `links()` sorted by peer id (if
more than `Limits.MAX_LSA_LINKS`, the cheapest ones); sign
`{ seq, ts: now(), links, caps }` as record type `lsa`; `lsdb.setLocal`; `publish`; pin
our key; remember each advertised cost for `advertisedCost`; emit `lsa.originated`.
Triggers: `start` (`start`), the refresh timer (`refresh`), `linkUp` (`link-up`),
`linkDown` (`link-down`), `linkCost` (`cost`). At most one origination per
`spfDebounceMs`: the first trigger originates immediately, later ones inside the window
are coalesced into one origination at its end.

**Router: routes.** The database's `onChange` schedules one recomputation after
`spfDebounceMs`; `linkDown` recomputes synchronously. A recomputation runs
`computeRoutes({ graph: lsdb.graph(), selfId, transit: (id) => lsdb.caps(id)?.transit === true })`,
increments `rev`, diffs against the previous result, emits `routes.changed` and
`topology.changed` (only when something differs), and calls the listeners.

`nextHop(dst)`: the route's `nextHop` if that neighbour is linked; otherwise `dst` itself
if `isLinked(dst)`; otherwise null. The second case covers the moments after a link comes
up and before both LSAs have confirmed it. `isReachable(dst)` is `nextHop(dst) !== null`.
`reachable` and `unreachable` in the listener call are computed on this effective
function, and `linkUp`/`linkDown` call the listeners immediately when they change it.
`route(dst).path` starts with our id and ends with `dst`.

**Router: sweep.** Every `max(100, floor(lsaMaxAgeMs / 10))` ms: `lsdb.expire()`, emit
`lsa.expired` per removed origin, and update the dataset's floors as described.

`TopologySnapshot`: `{ rev, self, nodes: TopologyNode[], links: TopologyLink[] }`, with the
field definitions of `API.md` section 6 (`GET /topology`). `links` contains every pair
that at least one current LSA advertises; `state` is `confirmed` when both do. The router
fills everything it knows; `ClawNode#topology()` completes each node with `linked`, with
`addrs` from the peer record, and adds linked peers that have no LSA yet (their `caps`
come from the handshake, `seq` is null).

**Forwarder: `handle(from, packet)`.** Throws `ProtocolError` (so the peer manager
penalizes `from`) when the header fails `validateDataHeader` / `validateProbeHeader`, or
a probe has `ttl > n`. Otherwise:

1. `dst === selfId`: local delivery. `DATA` with body byte 0 equal to 1 goes to the
   `data.sealed` handler, 2 to `data.transfer`, anything else is dropped (`malformed`).
   `PROBE` goes to `probe`. No handler registered: dropped (`no-handler`). Emit
   `packet.delivered`. Stop.
2. If the forward key (4.2) is in the seen-cache: drop (`duplicate`). Otherwise add it.
3. `ttl - 1 < 1`: drop (`ttl`); a `PROBE` is first handed to the `probe.expired` handler.
4. `transit === false` (our own `caps.transit`): drop (`no-transit`).
5. `hop = nextHop(dst)`. If `hop` is null, or equals `from` (the route points back where
   the packet came from, a transient disagreement), go to 7 with reason `no-route` or
   `split-horizon`.
6. `send(hop, { type, header: { ...header, ttl: ttl - 1 }, body })`. True: emit
   `packet.forwarded`. False: go to 7 with reason `backpressure`.
7. Transit queue: if it holds `transitQueueMax` entries or `transitQueueMaxBytes` bytes,
   or already holds `transitQueueMax / 4` entries received from `from`: drop
   (`transit-full`). Otherwise queue with deadline `now() + transitHoldMs` and emit
   `packet.queued`.

`flush()` (called by the node on `routes.changed`, `link.up` and channel drain) retries
queued packets in arrival order through steps 5 and 6; a packet whose deadline has passed
is dropped (`hold-expired`). One scheduled timer wakes at the earliest deadline.

**Forwarder: `originate(packet)`.** For packets this node creates. Adds the forward key
to the seen-cache (so a copy looping back is dropped), looks up `nextHop(dst)`, sends, and
emits `packet.sent`. It never queues: `{ ok: false, reason: "no-route" }` or
`"backpressure"` is returned to the caller, which has its own retry logic. `dst === selfId`
throws `StateError("self-destination: …")`.

**Packet events.** `packet.sent`, `packet.forwarded`, `packet.delivered`, `packet.queued`
and `packet.dropped` share one token bucket of `packetEventsPerSec`; when it is empty the
event is not emitted and is counted as `suppressed` in the next traffic sample. No
per-packet event is emitted for scheme-2 `DATA` at its origin or destination (a file
transfer would drown the bus; `file.progress` and `traffic.sample` report it).

**Events.** `lsa.originated`, `lsa.accepted`, `lsa.expired`, `routes.changed`,
`topology.changed`, `packet.*`.
**Timers.** `lsaRefreshMs`, `lsaMaxAgeMs` (sweep), `spfDebounceMs`, `transitHoldMs`.
**Bounds.** 10000 origins; transit queue by count, bytes and per previous hop; forward
seen-cache `limits.seenCacheEntries` for `2 * transitHoldMs`.
**Stats.** Router: `lsdbSize`, `lsaOriginated`, `lsaAccepted`, `lsaRefused`, `lsaExpired`,
`spfRuns`, `routes`, `rev`. Forwarder: `originated`, `forwarded`, `delivered`, `queued`,
`transitQueueLen`, `transitQueueBytes`, and one `dropped_<reason>` per drop reason.

**Tests.** No sockets; `send`, `schedule` and `now` are fakes; LSAs are signed with real
identities.
- Router: after `linkUp` the LSA lists the link; two routers fed each other's LSAs through
  their datasets confirm the link and each has a route; `nextHop` returns a linked
  neighbour before any LSA exists; `linkDown` removes routes synchronously; a cost change
  below the threshold triggers nothing (the peer manager's job) and `linkCost` triggers
  one origination; ten triggers inside the debounce window give two originations; the
  refresh raises `seq` without `topology.changed`; expiry removes the origin from routes
  and from the dataset, a replay of the expired LSA is refused by the dataset (`removed`)
  without a signature check while the tombstone lasts, a newer LSA of that origin is
  accepted, and after `lsaTombstoneMs` the floor is forgotten; a forged LSA is a hard check failure and
  never reaches the database; a network LSA of ours with a higher `seq` makes the next
  origination higher; `seq` survives a restart through `state`; `transit: false` nodes
  are not used as intermediate hops; a signature is verified once per accepted LSA
  (count calls through an injected verifier).
- Forwarder: every step of `handle` in isolation: delivery by scheme, duplicate drop,
  ttl expiry (and the `probe.expired` hand-off), `no-transit`, forwarding with the
  decremented `ttl`, split horizon queues instead of bouncing, backpressure queues,
  queue release on `flush()` in order, `hold-expired`, the three queue bounds, a header
  with an unknown field throws `ProtocolError`, `originate` with and without a route,
  the same `(id, try)` forwarded once but a higher `try` forwarded again, the same
  `(id, try)` with a different `cust` forwarded again, and the event rate cap.

### 5.7 `core/messaging/reliable.js`

**Responsibility.** `ReliableMessenger` seals outgoing messages, keeps them in a durable
outbox and retransmits until acknowledged or expired; for incoming sealed messages it
authenticates, suppresses duplicates, dispatches by kind and acknowledges.
`ConversationStore` is the `msg` kind: the chat history the API shows.

**Files.** `src/core/messaging/reliable.js`, `test/unit/messaging-reliable.test.js`,
`test/unit/messaging-conversations.test.js`.
**Imports.** `core/crypto/envelope.js`, `core/crypto/primitives.js`,
`core/messaging/dedupe.js`, `core/wire/*`, `core/errors.js`.

```js
export const MAX_META_BYTES = 8192;
export const MAX_SEALED_CONTENT = 983040;
export const MAX_TEXT_BYTES = 16384;

export class ReliableMessenger {
  constructor({ identity, cardOf, originate, isReachable, routePath, events, now, rng, schedule, log,
                index,          // Log   (outbox.log)
                bodies,         // Blobs (outbox/)
                seenLog,        // Log   (seen.log)
                ttl, messageLifetimeMs, maxClockSkewMs, retransmitMinMs, retransmitMaxMs,
                outboxMaxEntries, outboxMaxBytes, seenCacheEntries })
  async open(): Promise<void>            // load outbox and seen ids; schedule attempts
  async close(): Promise<void>           // flush; no further sends
  async send(dst, { kind, meta = {}, content = EMPTY, reliable = true, lifetimeMs, custody = true })
                                         // -> { id, state: 'sent' | 'waiting' | 'dropped' }
  onKind(kind, handler): Cancel          // handler(message: InboundMessage) => void | Promise<void>
  handleData(packet, { from }): void     // the forwarder's 'data.sealed' handler
  routesChanged({ reachable }): void
  pending(): OutboxEntry[]
  get(id): OutboxEntry | null
  packetOf(id): Promise<Buffer | null>   // the encoded DATA packet as last transmitted
  setCustodian(id, custodian, state): void      // state: 'pending' | 'accepted' | 'refused' | null
  cancel(id): boolean
  stats(): object
}

export class ConversationStore {
  constructor({ selfId, messenger, log, events, now, maxPerPeer = 1000, maxPeers = 1000 })
  async open(): Promise<void>
  async close(): Promise<void>
  async send(to, text): Promise<ChatMessage>
  list(): ConversationSummary[]
  messages(peer, { before, limit = 50 } = {}): { items: ChatMessage[], nextBefore: number | null }
}
```

`OutboxEntry`: `{ id, dst, kind, bytes, createdAt, expiresAt, attempts, nextAttemptAt: Ms | null,
state: "waiting" | "backoff", custodian: NodeId | null, custodyState, custody: boolean }`.
`InboundMessage`: `{ id, from: NodeId, card, kind, meta, content: Buffer, ts, receivedAt,
prevHop: NodeId | null, viaCustody: NodeId | null }`. `ChatMessage` and
`ConversationSummary` are defined in `API.md` section 7.

**Sending.** `send`:
1. `kind` must match the pattern of 4.3; `meta` must not contain a reserved key;
   encoded `meta` at most `MAX_META_BYTES`; `content` at most `MAX_SEALED_CONTENT`;
   `dst` a NodeId other than ours. Violations throw `ConfigError`.
2. `card = cardOf(dst)`; null throws `StateError("unknown-destination: …")`.
3. `id` = 16 random bytes as hex. `body = sealMessage({ sender: identity,
   recipientE2eKey, dst, id, meta: { ...meta, kind, ...(reliable ? { ack: true } : {}) },
   content, now: now() })`. Header `{ id, dst, ttl, try: 0 }`.
4. Unreliable: `originate` once; return `sent` or `dropped`. Nothing is stored.
5. Reliable: if the outbox is at `outboxMaxEntries` or `outboxMaxBytes`, throw
   `StateError("outbox-full: …")`. Otherwise `bodies.put(id, encoded packet)`, then
   `index.append({ op: "add", id, dst, kind, createdAt, expiresAt, bytes, custody })`,
   await both, emit `message.queued`, attempt, and return.

**Attempts.** An attempt sets `try = attempts & 0xff`, calls `originate` (passing
`routePath(dst)` so `packet.sent` can carry the predicted path), and:
- sent: `attempts += 1`, emit `message.sent`, state `backoff`, next attempt after
  `min(retransmitMaxMs, retransmitMinMs * 2^(attempts-1)) * (0.9 + 0.2 * rng())`;
- `no-route`: state `waiting` with no timer; emit `message.waiting` on the transition;
- `backpressure`: retry after `retransmitMinMs / 4`, not counted as an attempt.

`routesChanged({ reachable })` attempts at once every entry whose `dst` is in `reachable`,
whatever its state. An entry past `expiresAt` (`createdAt + (lifetimeMs ??
messageLifetimeMs)`) is removed and `message.expired` emitted. After a restart `attempts`
resumes from a random value in 0..255 so that forwarders' seen-caches from before the
restart are unlikely to match. Bodies of at most 4096 bytes stay in memory; larger ones
are read from `bodies` for each attempt.

**Outbox files.** `index` records: `add` (above), `{ op: "cust", id, custodian, state }`,
`{ op: "del", id, why }` with `why` one of `acked`, `expired`, `cancelled`. On `open` the
log is replayed, blobs without a live entry are deleted, entries without a blob are
dropped, and the log is rewritten when it holds more than 1000 dead records and more dead
than live ones. A removal appends `del` and then deletes the blob.

**Receiving.** `handleData(packet, { from })`:
1. If `id` is in the seen-cache: this is a duplicate. If the re-ack gate (a second
   `SeenCache`, lifetime `retransmitMinMs / 2`) accepts the id, open the message; if it
   opens and `meta.ack === true`, send an `ack`. Emit `message.duplicate`. Stop.
2. If `id` is being processed (in-flight set, at most 1024 ids; beyond that drop with
   reason `busy`): stop.
3. `openMessage({ recipient: identity, dst: selfId, id, body, now: now(),
   maxAgeMs: messageLifetimeMs, maxFutureMs: maxClockSkewMs })`. An `AuthError` drops the
   packet (`packet.dropped`, reason `auth`). The previous hop is not penalized, and the id
   is **not** recorded as seen, so a forged packet cannot block the genuine one.
4. `kind === "ack"`: if an outbox entry with `id === meta.re` exists and its `dst` equals
   the authenticated sender, remove it (`del`, `acked`) and emit `message.acked`;
   otherwise count `ackMismatch`. Record the ack's own id as seen. Stop.
5. Otherwise call the kind's handler and await it. No handler: emit `message.unhandled`
   and continue as if it had succeeded (the ack means "this node has it", not "something
   processed it"). A handler that throws or rejects: emit `message.handler_error`, forget
   the in-flight mark, stop without acking; the sender will retransmit.
6. Record the id as seen (memory, and `seenLog.append({ id, at })`), emit
   `message.received`, and if `meta.ack === true` send
   `send(sender, { kind: "ack", meta: { re: id }, reliable: false })`.

The seen-cache holds `seenCacheEntries` ids for `messageLifetimeMs + maxClockSkewMs`. It
is rebuilt from `seen.log` on `open` (expired lines dropped, log rewritten when more than
half of it is expired).

`viaCustody` is `packet.header.cust ?? null`. `prevHop` is `from`.

**ConversationStore.** Registers the `msg` handler: text must be valid UTF-8 of 1 to
`MAX_TEXT_BYTES` bytes, otherwise the message is ignored. A message whose id is already
stored is ignored (idempotence). Listens on the bus for `message.sent` (first one only),
`message.acked`, `message.expired` and `custody.deposited` to move outgoing messages
through `queued`, `sent`, `custody`, `delivered`, `expired`, emitting `chat.state`; emits
`chat.message` for every new message in either direction. Log records:
`{ op: "msg", seq, id, peer, direction, text, ts, at }` and `{ op: "state", id, state, at }`.
In memory it keeps the newest `maxPerPeer` messages for at most `maxPeers` peers (least
recently active peer evicted); the log is rewritten to match when it holds more than twice
the retained records.

**Events.** `message.queued`, `message.sent`, `message.waiting`, `message.acked`,
`message.expired`, `message.cancelled`, `message.received`, `message.duplicate`,
`message.unhandled`, `message.handler_error`, `chat.message`, `chat.state`.
**Timers.** `retransmitMinMs`, `retransmitMaxMs`, `limits.messageLifetimeMs`.
**Bounds.** Outbox entries and bytes; 16 MiB of bodies in memory; seen-cache entries;
1024 in-flight ids; conversation retention.
**Stats.** `outboxEntries`, `outboxBytes`, `waiting`, `sent`, `retransmits`, `acked`,
`expired`, `received`, `duplicates`, `authFailures`, `ackMismatch`, `handlerErrors`,
`seenEntries`.

**Tests.** Two messengers joined by a fake `originate` that can drop, delay, duplicate and
reorder; real identities; real `AppendLog`/blobs in a temp dir.
- A reliable message is delivered once to its handler and acked; the outbox empties.
- Lost data packet and lost ack: retransmission with increasing `try`, the handler still
  runs once, the duplicate is re-acked, and at most one re-ack per gate interval.
- Backoff schedule matches the formula (fake clock); `try` wraps at 256.
- No route: `waiting`; `routesChanged` triggers an immediate attempt.
- Expiry removes the entry and emits `message.expired`.
- Restart: close and reopen with the same files; pending messages are retransmitted,
  delivered ids are still suppressed; an orphan blob is removed; a torn last log line is
  tolerated.
- An ack from a node other than the destination, and an ack replayed by a third party,
  do not remove the entry.
- A body with any flipped bit, a body sealed for another `dst` or `id`, and a stale `ts`
  are dropped as `auth` and do not poison the seen-cache: the genuine packet with the same
  id is still delivered afterwards.
- A handler that rejects is retried on the next retransmission; an unknown kind is acked.
- `unknown-destination`, `outbox-full`, oversize content and reserved meta keys.
- Conversations: both directions recorded, state transitions, paging with `before`,
  duplicate ids ignored, invalid UTF-8 ignored, retention, reload from the log.

### 5.8 `core/storage.js`

**Responsibility.** Gives the node and its services named documents, logs and blob
directories under the data directory, encrypted at rest with the keystore's storage key
unless declared plain. It confines every path to the data directory.

**Files.** `src/core/storage.js`, `test/unit/storage.test.js`.
**Imports.** `vault/store.js`, `vault/keystore.js` (`seal`, `open`),
`core/wire/canonical.js`, `core/crypto/primitives.js` (base64), `core/errors.js`.

```js
export class NodeStorage {
  constructor({ dir, storageKey, now, onRecovered })      // onRecovered({ file, movedTo })
  scope(name): NodeStorage                                // rooted at <dir>/<name>, created 0700
  doc(name, { defaults, validate, sealed = true }): Doc
  log(name, { sealed = true, fsync = 'batch' }): Log
  blobs(name): Blobs
  path(...parts): string                                  // absolute, inside dir, or StoreError
  async closeAll(): Promise<void>                         // flush docs, close logs
}
```

- `Doc` has exactly the interface of `JsonFile`: `load()`, `data`, `update(mutator)`,
  `save()`, `flush()`. `Log` has exactly the interface of `AppendLog`: `open()`,
  `append(record)`, `read()`, `rewrite(records)`, `flush()`, `close()`, `stats`. A plain
  `Doc`/`Log` **is** a `JsonFile`/`AppendLog`, so modules and their unit tests can be
  handed either.
- `Blobs`: `put(key, bytes): Promise<void>` (atomic, durable when it resolves),
  `get(key): Promise<Buffer | null>`, `delete(key): Promise<void>`,
  `keys(): Promise<string[]>`. Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Names match `^[a-z0-9][a-z0-9-]{0,31}$`. Files: `<name>.json`, `<name>.log`,
  directory `<name>/`.
- Sealed formats. Doc file: `{ "v": 1, "b": base64(seal(storageKey, canonicalBytes(data),
  utf8("doc:" + name))) }`. Log line: `{ "b": base64(seal(storageKey,
  canonicalBytes(record), utf8("log:" + name))) }`. Blob file:
  `seal(storageKey, bytes, utf8("blob:" + name + ":" + key))`. Sealed docs and records
  must therefore be canonical-JSON data (integers only).
- A sealed log line that fails to open is skipped and counted like a corrupt line. A
  sealed doc that fails to open is quarantined like a corrupt `JsonFile`: moved aside,
  defaults used, `onRecovered` called (the node emits `store.recovered`).
- The random-nonce bound of `seal` applies per storage key; a node writes far fewer than
  2^32 sealed items in its life.

**Tests.** Round trips for sealed and plain docs, logs and blobs; the files on disk do not
contain a known plaintext marker; a doc, a log line and a blob moved to another name or
key fail to open (the associated data binds them); a tampered doc is quarantined and
reported; a tampered log line is skipped and counted; `path("..", "x")` and absolute
paths are refused; `closeAll` flushes pending updates.

### 5.9 `core/node.js` and `src/index.js`

**Responsibility.** `ClawNode` constructs every module above, connects them to each other
with plain functions, owns all scheduled work, runs the service lifecycle and exposes the
public API that the control API, the CLI and the tests use. It contains wiring and policy
glue only: no protocol logic that could live in a lower module.

**Files.** `src/core/node.js`, `src/index.js`, `test/helpers/netem.js`,
`test/helpers/cluster.js`, `test/integration/*.test.js` (section 10).
**Imports.** Everything in layers 0 to 4.

```js
export class TimerSet {
  constructor({ onError })                      // onError(error, label)
  schedule(fn, ms, label?): Cancel              // one-shot
  every(fn, ms, label?): Cancel                 // repeating; next run is scheduled after fn returns
  cancelAll(): void                             // also refuses new timers afterwards
  get size(): number
}

export class ClawNode {
  constructor({ config, dataDir, passphrase, services = [], now = Date.now, rng = Math.random, logger })
  use(service): this                            // before start() only
  async start(): Promise<void>
  async stop({ reason = 'requested' } = {}): Promise<void>      // idempotent
  get state(): 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
  get id(): NodeId                              // after start()
  get boot(): string                            // 8 hex characters, new for every process start
  get events(): EventBus
  get config(): object                          // the frozen validated config
  get dataDir(): string
  get listenAddress(): { host, port } | null

  status(): object                              // API.md GET /status
  identityInfo(): object                        // API.md GET /identity
  configView(): object                          // config with secrets redacted
  listPeers(): PeerInfo[]
  listDialing(): DialInfo[]
  listKnownAddresses(): AddressEntry[]
  connect(addr): Promise<PeerInfo>
  disconnect(id): Promise<boolean>
  topology(): TopologySnapshot
  routes(): Route[]
  nodeDetail(id): object | null                 // LSA, peer record, route
  send(dst, options): Promise<{ id, state }>    // ReliableMessenger#send
  sendMessage(to, text): Promise<ChatMessage>
  conversations(): ConversationSummary[]
  conversation(peer, { before, limit }): { items, nextBefore }
  outbox(): OutboxEntry[]
  stats(): object                               // { node, peers, router, forwarder, messaging, services: { name: … } }
                                                // node: { syncPeerErrors, internalErrors, timers }
  syncStats(): object                           // SyncEngine#stats()
  service(name): object | null                  // that service's `api`
  apiRoutes(): ApiRoute[]                       // routes registered through ctx.api
}
```

`src/index.js` re-exports `ClawNode`, `TimerSet`, `loadConfig`, `defaultConfig`,
`validateConfig`, `resolveDataDir`, `Keystore`, `Identity`, the error classes and the
constants of `core/wire/types.js`. It does not import any service module.

**Wiring.** The complete set of connections `ClawNode` makes:

| From | To | When |
| --- | --- | --- |
| `PeerManager.onPacket`, types `GOSSIP`, `SYNC_*` | `sync.handlePacket(id, packet)` | always |
| `PeerManager.onPacket`, types `DATA`, `PROBE` | `forwarder.handle(id, packet)` | always |
| `PeerManager.onLinkUp` | `pex.noteCard`, `router.linkUp`, `sync.addPeer`, `forwarder.flush` | in this order |
| `PeerManager.onLinkDown` | `sync.removePeer`, `router.linkDown`, `bootstrap.kick()` if no link is left | in this order |
| `PeerManager.onLinkCost` | `router.linkCost` | |
| `PeerManager.onObserved` | `pex.refresh()` | |
| `PeerManager` channel drain | `forwarder.flush()` | |
| `Router.onRoutesChanged` | `forwarder.flush()`, `messenger.routesChanged`, then service listeners | |
| `Forwarder.onLocal('data.sealed')` | `messenger.handleData` | |
| `SyncEngine.send` | `peers.send(id, packet)` | |
| `SyncEngine.onError` | policy of 4.5 | |
| `Router.attach`, `PeerExchange.attach` | `(record) => sync.publish(name, record)` | after the engine exists |
| `Forwarder.nextHop`, `Messenger.isReachable` | `router.nextHop`, `router.isReachable` | |
| `Messenger.cardOf` | `pex.cardOf` | |
| `PeerManager.preferPeer` | `(id) => router.caps(id)?.relay === true \|\| pex.recordOf(id)?.caps.relay === true` | |

`SyncEngine` options: `self: nodeId`, `limits: DEFAULT_SYNC_LIMITS` (256 records,
256 KiB, 4096 pending per peer), `gossipBatchMs: timers.gossipBatchMs`, `schedule` from
the `TimerSet`, `minRoundIntervalMs: min(1000, floor(timers.syncIntervalMs / 2))`,
`roundTimeoutMs: min(10000, max(1000, 4 * timers.syncIntervalMs))`; `tick()` every
`timers.syncIntervalMs`.

**Node-owned timers.** `sync.tick` (`syncIntervalMs`); traffic sample every 500 ms
(`TRAFFIC_SAMPLE_MS`): emits `traffic.sample` from `forwarder.takeTrafficSample()` and
per-link counter deltas, only when something moved. Everything else is scheduled by the
modules through the injected `schedule`.

**Tests.** Section 10.3 lists the integration tests; they are this module's test plan.
## 6. Service registration contract

Cast, file transfer, relay, diagnostics and the control API are **services**. A service is
a plain object handed to `ClawNode` (constructor option `services` or `use()`); it gets
everything it needs from the `ServiceContext` passed to `init`. Adding a service never
requires an edit to `node.js`.

```js
/**
 * @typedef {object} Service
 * @property {string} name            unique, ^[a-z][a-z0-9-]{0,31}$
 * @property {string[]} [requires]    names of services that must be present; they are initialized and started first
 * @property {(ctx: ServiceContext) => void | Promise<void>} init
 * @property {() => void | Promise<void>} [start]
 * @property {() => void | Promise<void>} [stop]
 * @property {() => object} [stats]   flat counters, shown under stats().services[name]
 * @property {object} [api]           what node.service(name) returns
 */
```

Each service module exports one factory and nothing the node needs to know about:

| Module | Factory | Service name |
| --- | --- | --- |
| `core/diag/diag.js` | `createDiagService(options?)` | `diag` |
| `cast/channels.js` | `createCastService(options?)` | `cast` |
| `vault/file-transfer.js` | `createFileTransferService(options?)` | `files` |
| `gate/relay.js` | `createRelayService(options?)` | `relay` |
| `gate/api-server.js` | `createApiService(options?)` | `api` |

`src/cli/standard.js` exports `standardServices(): Service[]`, the five in the order of
the table; the CLI, the devnet launcher and the test cluster use it. Because all four
datasets must exist on every node (4.5), a node meant to join a real network always
includes `cast` and `relay`.

**Phases.** `init` runs before any socket is open and before the `SyncEngine` exists. It
is the only place where handlers, datasets and API routes may be registered; registering
later, or registering a second handler for the same kind, selector or route, throws
`StateError`. `start` runs when the listener is open and the engine exists; from then on
`ctx.sync.publish`, `ctx.messaging.send` and `ctx.packets.originate` work (earlier they
throw `StateError("not-started: …")`). `stop` runs before links are closed, in reverse
order, and must flush whatever the service persists. A service's failure in `init` or
`start` fails `node.start()`.

```js
/**
 * @typedef {object} ServiceContext
 * @property {string} service                     this service's name
 * @property {NodeId} nodeId
 * @property {string} boot
 * @property {object} config                      frozen, validated
 * @property {{ nodeId, card, signRecord(type, fields), sign(domain, bytes) }} identity
 *                                                signing only; no access to secret keys
 * @property {EventBus} events
 * @property {object} log
 * @property {() => Ms} now
 * @property {() => number} rng
 * @property {Schedule} schedule                  one-shot timer owned by the node
 * @property {(fn, ms) => Cancel} every           repeating timer owned by the node
 * @property {NodeStorage} storage                scoped to <dataDir>/services/<name>
 * @property {object} messaging                   sealed messages, below
 * @property {object} packets                     routed packets, below
 * @property {object} sync                        datasets, below
 * @property {object} routing                     read-only routing view, below
 * @property {object} peers                       { isLinked(id), list(): PeerInfo[] }
 * @property {object} directory                   { cardOf(id): Card | null, e2eKeyOf(id): Buffer | null }
 * @property {object} api                         route registration, below
 * @property {ClawNode} node                      the node's public API; intended for the api service
 */
```

| Handle | Members | Notes |
| --- | --- | --- |
| `ctx.messaging` | `send(dst, options)`, `onKind(kind, handler)`, `pending()`, `get(id)`, `packetOf(id)`, `setCustodian(id, custodian, state)` | exactly the `ReliableMessenger` methods of 5.7. `onKind` refuses the kinds `ack` and `msg` |
| `ctx.packets` | `originate(packet, { path }?)`, `onLocal(selector, handler)` | `Forwarder` methods. Selectors open to services: `data.transfer`, `probe`, `probe.expired`. Handler: `(packet: Packet, { from: NodeId }) => void` |
| `ctx.sync` | `addDataset(dataset)`, `publish(name, record): { accepted }`, `dataset(name)` | `addDataset` in `init` only. The dataset's `name` must be one of 4.5 |
| `ctx.routing` | `nextHop(dst)`, `isReachable(dst)`, `route(dst)`, `routes()`, `caps(id)`, `nodeIds()`, `onRoutesChanged(listener): Cancel` | `Router` methods |
| `ctx.api` | `route(method, path, handler, { summary }?)`, `reply(status, body)`, `error(status, code, message, details?)` | below |

**API routes.** `ctx.api.route("POST", "/channels/:name/messages", handler)` registers a
route under `/api/v1`. `method` is `GET`, `POST` or `DELETE`; a path segment starting
with `:` is a parameter. The handler is `async (req) => result` with
`req = { params, query, body, signal }`: `params` and `query` are objects of strings
(percent-decoded), `body` is the parsed JSON object or null, `signal` aborts when the
client disconnects. The result is a JSON value sent with status 200, or
`ctx.api.reply(status, body)` for another 2xx status. To fail, throw
`ctx.api.error(status, code, message, details?)` (an `Error` carrying `status` and
`apiCode`), or let a `ClawNetError` escape: the API server maps it as `API.md` section 4
says. Routes are collected by the node (`node.apiRoutes()`) and served by the `api`
service if it is present; a service works the same when it is not.

**What a service must not do.** Import another service or any layer 2-5 module; open
sockets (except `api`); create timers other than through `ctx.schedule` / `ctx.every`;
write outside `ctx.storage` (except `files`, which also writes to
`config.files.downloadsDir`); keep a reference to anything in `ctx` after `stop`.

## 7. Node lifecycle

### 7.1 Start

`start()` is legal once, in state `new`. Each step either completes or the steps already
taken are undone in reverse, the state becomes `failed` and the error is rethrown.

1. State `starting`. `ensurePrivateDir(dataDir)`. Take the lock: create `<dataDir>/lock`
   exclusively with our pid. If it exists and names a live process, fail with
   `StateError("locked: …")`; if that process is gone, replace it.
2. Open the keystore (`Keystore.open`); if the file does not exist, create it from
   `Identity.generate()` (encrypted when `passphrase` was given). Build the `Identity`
   from the 96-byte secret. A keystore that exists but does not open fails the start.
3. Create `NodeStorage` with the storage key. Load `state.json`, the address book and
   the peer records. Emit `store.recovered` for every file that had to be quarantined.
4. Construct, without starting anything: `PeerExchange`, `Router`, `Forwarder`,
   `ReliableMessenger` (`open()`: outbox and seen ids), `ConversationStore` (`open()`),
   `PeerManager`, `BootstrapDiscovery`, `MulticastDiscovery` (if enabled).
5. Sort the services so that every service follows those it `requires` (otherwise
   registration order); a missing or cyclic requirement fails the start. Call each
   `init(ctx)`.
6. Construct the `SyncEngine` with the datasets `lsa`, `peer` and those the services
   added. A dataset of 4.5 that no service registered is created by the node as a
   relay-only instance with the default check of its record type (schema validator and
   `verifyRecord`), so the node still floods correctly. Call `router.attach`,
   `pex.attach`.
7. `router.start()` (our first LSA) and `pex.refresh()` (our peer record).
8. `peers.start()`: the TCP listener opens.
9. Call each service's `start()` in order. The control API binds here. Then write
   `runtime.json`; its `api` field is `node.service("api")?.url ?? null`.
10. `bootstrap.start()`, `multicast.start()`, start the node-owned timers. The peer
    manager's first maintenance pass begins dialing.
11. State `running`. Emit `node.started`.

Nothing is sent to any peer before step 8, and no link can come up before every handler
is registered.

### 7.2 Stop

`stop()` is idempotent; concurrent calls share one promise. Each step is attempted even if
an earlier one threw; errors are collected, reported as `internal.error`, and the first
is rethrown at the end. The whole sequence has a deadline of 5 seconds
(`STOP_TIMEOUT_MS`); on expiry, sockets and timers are destroyed and the stores are still
flushed.

1. State `stopping`. Emit `node.stopping`.
2. Stop discovery (multicast socket closed, no more dials) and close the TCP listener.
3. Call each service's `stop()` in reverse order. The control API closes its listener and
   its event streams last among the services, so a client sees `node.stopping`.
4. `sync.flush()`, then `peers.stop()`: every link gets `BYE {reason:"shutdown"}`, up to
   500 ms to drain, then its socket is destroyed.
5. `timers.cancelAll()`.
6. Close the stores: messenger (outbox index, seen log), conversations, router and pex
   state, address book, then `storage.closeAll()`.
7. Remove `runtime.json` and `lock`. State `stopped`. Emit `node.stopped`.

`SIGINT` and `SIGTERM` handling lives in the CLI, which calls `stop()`.

### 7.3 Crash safety

A crash is a process kill or power loss at any instant. For each piece of state: what can
be lost, and why that is acceptable.

| State | Written | After a crash |
| --- | --- | --- |
| Keystore | once, atomically | intact or absent; never half-written |
| `state.json` (`lsaSeq`, `peerSeq`) | coalesced saves | may be behind. The next `seq` is `max(saved + 1, now())`, which is higher unless the clock also went backwards; in that case the network's copy arrives as `own-origin-newer` and the sequence jumps past it |
| Outbox | blob (durable) then index append (`fsync: "batch"`) | a message accepted in the last few milliseconds may be missing: `send()` has returned but the index record was not yet synced. A removal may be missing: the message is sent again and the recipient suppresses and re-acks it |
| Seen ids | append after the handler returns | an id may be missing, so a retransmission that arrives after the restart is delivered a second time. Therefore **every kind handler must be idempotent per message id** |
| Conversations | append (`batch`) | the last messages may be missing; an incoming one is then redelivered by retransmission because its ack was not sent or its id not recorded |
| Address book, peer records | coalesced saves | rediscovered |
| Cast counters `n` | `flush()` before the record is published | never reused. If the file is lost entirely, the counter resumes above the highest `n` of ours that the network returns |
| Mailbox deposits | blob then index append, before `custody-result` is sent | a deposit is either acknowledged and stored, or not acknowledged and deposited again |
| File transfer progress | `.part` data fsynced, then the bitmap saved | the bitmap may be behind the data (chunks are fetched again), never ahead of it |
| A file that could not be parsed or opened | moved aside as `<name>.corrupt-<timestamp>` | the node starts from defaults and emits `store.recovered`; nothing is deleted |

Across a crash, delivery of a sealed message to its handler is at-least-once; without a
crash it is exactly-once.

## 8. Wave 3 modules

Unit tests of a service use a fake `ServiceContext` (`test/helpers/fake-context.js`, owned
by whoever writes the first wave 3 test, kept to the shape of section 6: in-memory
`messaging` that delivers between contexts with optional loss, a fake `schedule`, a real
`NodeStorage` in a temp dir). Integration tests use the cluster helper (10.2).

### 8.1 `cast/channels.js` (ClawCast)

**Responsibility.** Publishes and receives broadcast messages on named channels, with
optional shared-key encryption, on top of the `cast` log dataset that every node relays.
It enforces the per-origin rate limit that keeps a flooded medium usable.

**Files.** `src/cast/channels.js`, `test/unit/cast-channels.test.js`,
`test/integration/cast.test.js`.
**Imports.** `core/crypto/envelope.js` (`castEncrypt`, `castDecrypt`, `channelWireId`),
`core/crypto/identity.js` (`verifyRecord`), `core/crypto/primitives.js`,
`core/wire/schema.js`, `core/wire/types.js`, `sync/datasets.js`, `core/errors.js`.

```js
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_STREAMS_PER_ORIGIN = 16;
export function createCastService({ maxPerStream = 64, maxStreams = 1024, historyPerChannel = 1000 } = {})

// service.api
list(): ChannelInfo[]
join(name, { key } = {}): Promise<ChannelInfo>      // key: Buffer(32) | undefined
leave(name): Promise<boolean>
publish(name, text): Promise<CastMessage>
history(name, { before, limit = 50 } = {}): { items: CastMessage[], nextBefore: number | null }
```

`ChannelInfo` and `CastMessage` are defined in `API.md` section 7.

- **Dataset.** `LogDataset` named `cast`, `stream = chan + ":" + origin`, `index = n`.
- **`check(record)`**, in this order: `validateCast` (hard); the origin's token bucket is
  empty (soft, `rate`); `verifyRecord(record, "cast")` (hard);
  `ts > now() + limits.maxClockSkewMs` (soft, `future`);
  `ts < now() - limits.messageLifetimeMs` (soft, `expired`); the record would open a new
  stream for an origin that already has `MAX_STREAMS_PER_ORIGIN` streams (soft,
  `streams`). The bucket is checked before the signature so that a flood costs no
  signature work.
- **Stream slots.** A `LogDataset` never evicts a stream by itself. Every
  `timers.retransmitMaxMs` the service calls `dropStream` for each stream whose newest
  held record has `ts < now() - limits.messageLifetimeMs`; `check` no longer admits such
  records, so the stream is not fetched back. This frees the slots of channels and
  publishers that have gone quiet.
- **Rate limit.** One token bucket per origin: capacity
  `4 * limits.castPerOriginPerMin`, refilled at `limits.castPerOriginPerMin` per minute,
  at most 10000 origins tracked (least recently used dropped). A token is taken in
  `onAccept` when `isNew`. The burst allowance lets a healed partition deliver history;
  what does not fit is offered again by anti-entropy and accepted as the bucket refills.
  Local publishing is stricter: at most `limits.castPerOriginPerMin` in any 60 seconds,
  so an honest node never exhausts its bucket elsewhere.
- **Join.** `chan = channelWireId(name, key)`. Joining a joined name with the same key is
  a no-op; with a different key it throws `StateError("already-joined: …")`. Joined
  channels live in the sealed doc `channels`:
  `{ v: 1, channels: [{ name, key: base64 | null, chan, nextN, joinedAt }] }`. After
  joining, records of that `chan` already in the dataset are surfaced.
- **Publish.** Requires a joined channel (`StateError("not-joined: …")`), text of 1 to
  `Limits.MAX_CAST_BODY` UTF-8 bytes (`ConfigError`), and the local rate
  (`StateError("rate-limited: …")`). `n = max(channel.nextN, highest n of our stream in
  the dataset + 1)`; store `nextN = n + 1` and `await doc.flush()` **before** publishing.
  With a key: `header = { chan, n, origin, ts }`,
  `{ salt, ciphertext } = castEncrypt({ channelKey, header, plaintext })`,
  record fields `{ chan, n, ts, enc: true, salt: base64, body: base64(ciphertext) }`.
  Without: `{ chan, n, ts, enc: false, body: base64(plaintext) }`. Sign with
  `ctx.identity.signRecord("cast", fields)` and `ctx.sync.publish("cast", record)`.
  Binding `origin` into the associated data means a non-member cannot re-publish a
  member's ciphertext under its own name.
- **Surface.** In `onAccept` with `isNew`, if `chan` belongs to a joined channel: a keyed
  channel takes only `enc: true` records that decrypt; an open channel takes only
  `enc: false`. The plaintext must be valid UTF-8. Anything else is counted and ignored
  (but still relayed, as for channels this node has not joined). A surfaced message is
  appended to the sealed log `history` (`{ seq, chan, origin, n, ts, text, at }`, unique
  per `(chan, origin, n)`) and announced with `cast.message`.
- **Leave.** Removes the channel and its history. The node keeps relaying the channel.
- History keeps the newest `historyPerChannel` messages per channel.

**Events.** `cast.joined`, `cast.left`, `cast.message`, `cast.rejected` (at most one per
second).
**Timers.** The stream sweep (`timers.retransmitMaxMs`, through `ctx.every`); buckets are
computed from `now()`.
**Bounds.** Dataset 64 records per stream, 1024 streams, 16 streams per origin; body
16 KiB; history per channel. Worst-case memory of the dataset is
`maxStreams * maxPerStream * ~22 KiB` (about 1.4 GiB), reachable only by 64 or more
colluding identities sustaining the rate limit for hours; the same identities can occupy
every stream slot for as long as they keep publishing. Both follow from the absence of
Sybil resistance, a stated non-goal.
**Routes.** `GET /channels`, `POST /channels`, `DELETE /channels/:name`,
`POST /channels/:name/messages`, `GET /channels/:name/messages`.
**Stats.** `joined`, `published`, `received`, `surfaced`, `undecryptable`, `rateRejected`,
`streamRejected`, `historyEntries`.

**Tests.** Unit, over `test/helpers/simnet.js` with several cast services:
- a cast reaches every node and is surfaced exactly once on every node that joined;
- per-sender order: `n` strictly increasing; out-of-order arrival surfaces all;
- keyed channel: members read; a node that joined the same name without the key or with
  another key sees nothing; a non-member still relays; `enc: false` records and garbage
  ciphertext injected under the keyed `chan` are not surfaced; a member's ciphertext
  copied into a record signed by another identity does not decrypt;
- a forged signature and a schema violation are hard failures (the relaying peer is
  reported); over-rate, future `ts`, expired `ts` and the 17th stream of one origin are
  soft: not stored, not forwarded, nobody reported; a stream whose newest record expired
  is dropped by the sweep and not fetched back;
- a burst of 4 times the per-minute limit passes, the next record is rejected, and it is
  accepted after the bucket refills;
- `n` survives a restart (never reused); with the `channels` doc deleted, the next publish
  uses an `n` above what the dataset returns;
- partition, casts on both sides, heal: both sides hold the union;
- join backfills from the dataset; leave removes history; history paging and retention;
  local rate limit; invalid UTF-8.
Integration: a three-node line; a keyed cast from one end is read at the other; the
middle node, not joined, never surfaces it; the netem capture contains no plaintext.

### 8.2 `vault/file-transfer.js`

**Responsibility.** Sends a file to one node and receives files from others: offer,
acceptance policy, encrypted chunks with selective acknowledgement and retransmission,
whole-file verification, and resumption after interruption or restart. It never writes
outside the downloads directory and never trusts a peer-supplied name.

**Files.** `src/vault/file-transfer.js`, `test/unit/file-transfer.test.js`,
`test/integration/files.test.js`.
**Imports.** `core/crypto/envelope.js` (`sealChunk`, `openChunk`, `peekChunk`),
`core/crypto/primitives.js`, `core/wire/types.js`, `core/wire/schema.js`,
`core/errors.js`, `node:fs/promises`, `node:path`, `node:crypto` (streaming SHA-256).

```js
export const MAX_CHUNKS = 1 << 20;
export const SACK_MAX_RANGES = 64;
export const SACK_EVERY = 8;
export function sanitizeFileName(name): string
export function createFileTransferService({ maxActive = 8, maxPendingOffers = 64, maxPendingPerPeer = 8, keep = 200 } = {})

// service.api
send(to, path, { name } = {}): Promise<Transfer>
list(): Transfer[]
get(tid): Transfer | null
accept(tid): Promise<Transfer>
reject(tid): Promise<Transfer>
cancel(tid): Promise<Transfer>
```

`Transfer` is defined in `API.md` section 7. States, sending side: `preparing` (hashing),
`offered`, `sending`, `paused`, `completed`, `rejected`, `cancelled`, `failed`. Receiving
side: `offered`, `receiving`, `paused`, `verifying`, `completed`, `rejected`, `cancelled`,
`failed`.

**Messages.** All are sealed kinds (4.3). `tid` is 16 random bytes as 32 hex characters.

| Kind | Fields | Rules |
| --- | --- | --- |
| `file-offer` | `tid`, `name` (1..255 UTF-8 bytes), `size` (0..2^53-1), `sha256` (base64, 32 bytes), `chunk` (1..1032192, the upper bound of `files.chunkSize`), `key` (base64, 32 bytes) | receiver also requires `size <= files.maxSizeBytes` and `ceil(size / chunk) <= MAX_CHUNKS` |
| `file-accept`, `file-sack` | `tid`, `base` (integer >= 0), `ranges` (at most 64 pairs `[from, to]`, inclusive, ascending, disjoint, `from > base`) | every chunk below `base` is held, plus the ranges |
| `file-reject` | `tid`, `reason`: `denied`, `busy`, `too-large`, `invalid` | |
| `file-done` | `tid`, `ok`, `reason?`: `hash`, `io` | |
| `file-cancel` | `tid`, `reason`: `user`, `source-changed`, `io`, `expired` | |

A message about a transfer is honoured only when its authenticated sender is that
transfer's peer. Messages for unknown transfers are ignored.

**Chunks.** `DATA` packets with a fresh random `id`, `try: 0`, body
`sealChunk({ key, transferId, index, plaintext })`, sent with `ctx.packets.originate`.
Chunk `i` covers bytes `[i * chunk, min(size, (i + 1) * chunk))`. Because the nonce is the
chunk index, a retransmitted chunk must be byte-identical: before every read the sender
compares the file's size and modification time with those recorded at `send()` and on any
difference fails the transfer (`source-changed`) instead of sending.

**Sender.**
1. `send`: the path must be a regular file of at most `files.maxSizeBytes` and the
   destination's card must be known; the transfer is created in state `preparing` and
   `send` resolves with it. In the background the file is hashed, the transfer persisted
   and the `file-offer` sent (reliable); state `offered`, `file.offered`.
2. `file-accept`: record what the receiver holds; state `sending`; pump.
3. Pump: while fewer than `files.window` chunks are outstanding (sent, not yet covered by
   a sack) and the destination is reachable, send the lowest chunk that is neither held
   by the receiver nor outstanding. A failed `originate` stops the pump; it resumes on
   `onRoutesChanged` or after `retransmitMinMs / 4`.
4. `file-sack`: update what the receiver holds. A chunk below the highest acknowledged
   index that is still missing and was sent more than `retransmitMinMs / 2` ago is no
   longer outstanding (it will be sent again). Pump.
5. Stall: if chunks are outstanding and no sack arrived for the stall interval
   (`retransmitMinMs`, doubling up to `retransmitMaxMs`, reset by any sack), all
   outstanding chunks become unsent and the pump runs. After three stalls in a row the
   state is `paused` and the `file-offer` is sent again (same `tid`, new message id); a
   `file-accept` or `file-sack` resumes.
6. `file-done`: `completed` or `failed`. `file-reject`: `rejected`. `file-cancel`:
   `cancelled`.

**Receiver.**
1. `file-offer` for a new `tid`: validate; over `maxPendingOffers` or `maxPendingPerPeer`
   reply `file-reject` `busy`; `files.accept === "deny"` reply `denied`; `"auto"` accept;
   `"ask"` state `offered` and emit `file.incoming`.
   For a known `tid` from the same peer: if receiving or paused, reply `file-accept` with
   what is held (this is how a sender resumes); if completed, reply `file-done` again.
2. Accept: the target is `<downloadsDir>/<sanitized name>` made unique by appending
   ` (1)`, ` (2)`, …; data goes to `<target>.<first 8 of tid>.part`, created exclusively.
   Send `file-accept` (reliable) with what is held; state `receiving`.
3. A chunk (`data.transfer` handler): `peekChunk`, find the transfer, `openChunk` with its
   key. Drop silently when the transfer is unknown or not receiving, authentication
   fails, `index >= chunks`, or the plaintext length is not exactly the expected length
   of that chunk. Write at its offset, mark it. Send `file-sack` (unreliable) after every
   `SACK_EVERY` new chunks, or `min(200, retransmitMinMs / 4)` ms after the first
   unreported chunk, or on a duplicate chunk (at most one sack per that interval).
4. Progress is persisted every 64 chunks or one second: fsync the `.part` file, then save
   the bitmap (`ctx.storage.blobs("bitmaps")`) and the transfer record (sealed doc
   `transfers`, which also holds the key).
5. All chunks held: `verifying`; hash the file. Match: fsync, rename to the target, state
   `completed`, send `file-done { ok: true }`. Mismatch: delete the `.part`, `failed`,
   send `file-done { ok: false, reason: "hash" }`.
6. No chunk for the stall interval while incomplete: send `file-accept` again with what
   is held (same backoff as the sender's stall).

**Restart.** On `start`, transfers are reloaded. An incoming transfer in `receiving`
reopens its `.part` (if it is gone, the bitmap is reset) and sends `file-accept`. An
outgoing transfer in `offered`, `sending` or `paused` re-checks its source file and sends
`file-offer` again. A transfer with no progress for `limits.messageLifetimeMs` fails with
`expired`.

**`sanitizeFileName`.** Take the part after the last `/` or `\`; remove control
characters and `<>:"|?*`; trim spaces and dots at both ends; if the stem (before the
first dot, case-insensitive) is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`,
`COM1`-`COM9`, `LPT1`-`LPT9`) prefix `_`; cut to 200 UTF-8 bytes without splitting a
character, keeping the extension; an empty result becomes `file`. After joining with the
downloads directory the resolved path must still be inside it, otherwise the offer is
rejected as `invalid`.

**Events.** `file.offered`, `file.incoming`, `file.accepted`, `file.rejected`,
`file.progress` (at most 4 per second per transfer), `file.paused`, `file.resumed`,
`file.completed`, `file.failed`, `file.cancelled`.
**Timers.** Derived from `retransmitMinMs` and `retransmitMaxMs` as stated; `files.window`
and `files.chunkSize` shape the flow.
**Bounds.** `maxActive` running transfers per direction (further accepted ones wait in
`paused`); pending offers; `MAX_CHUNKS` (a 128 KiB bitmap at most); `keep` finished
transfers listed.
**Routes.** `POST /files`, `GET /files`, `GET /files/:id`, `POST /files/:id/accept`,
`POST /files/:id/reject`, `POST /files/:id/cancel`.
**Stats.** `active`, `offersIn`, `offersOut`, `completedIn`, `completedOut`, `failed`,
`chunksSent`, `chunksResent`, `chunksReceived`, `chunksDuplicate`, `chunksRejected`,
`bytesSent`, `bytesReceived`.

**Tests.** Unit with two services joined by a fake context that can drop, reorder and
duplicate chunks and messages:
- sizes 0, 1, chunk - 1, chunk, chunk + 1 and several megabytes of random data arrive
  byte-identical; the `.part` name is gone and the target exists only after verification;
- 20 % chunk loss, reordering and duplication still complete, with retransmissions
  counted; lost sacks are tolerated;
- the window is respected (never more than `files.window` outstanding);
- resume: stop the receiver service mid-transfer, start a new one on the same storage,
  the transfer completes and chunks held before the restart are not sent again; the same
  for a restarted sender; the same when all messages are dropped for a while (`paused`
  then `resumed`);
- a wrong offered hash ends in `failed` and no file; `ask`, `auto`, `deny`; reject;
  cancel from each side removes the `.part`;
- hostile offers: size over the limit, `chunk: 1` with a huge size, bad key or hash
  length, 100 offers from one peer (`busy`), a name table including `../../x`,
  `..\\..\\x`, `CON.txt`, a name of dots, 300 bytes, control characters;
- hostile chunks: wrong key, index out of range, wrong length, unknown transfer, a chunk
  body with its index or transfer id altered; a control message from a node that is not
  the transfer's peer is ignored;
- the source file modified during the transfer fails with `source-changed`;
- two files with the same name do not overwrite each other.
Integration over real nodes with netem: a multi-megabyte file across a three-node line;
the link is cut mid-transfer and healed, and the transfer completes without restarting
from zero (assert on `chunksSent`); the receiving node is stopped and restarted
mid-transfer; the capture at the middle link contains none of the file's bytes.

### 8.3 `gate/relay.js` (mailbox custody)

**Responsibility.** Lets a sender deposit sealed packets for an unreachable destination
with a mailbox node, and lets a mailbox node store them, forward them when the
destination appears, and purge them on the destination's signed receipt. It also owns the
`receipt` dataset that every node relays.

**Files.** `src/gate/relay.js`, `test/unit/relay.test.js`,
`test/integration/custody.test.js`.
**Imports.** `core/crypto/identity.js` (`verifyRecord`), `core/crypto/primitives.js`,
`core/wire/codec.js`, `core/wire/schema.js`, `core/wire/types.js`,
`core/messaging/dedupe.js`, `sync/datasets.js`, `core/errors.js`.

```js
export const MAX_CUSTODY_PACKET = 983040;
export function createRelayService({ maxCustodiansPerMessage = 2 } = {})
// service.api
mailbox(): MailboxView          // API.md GET /mailbox
```

The service has three roles. The first two are active on every node; the third only when
`config.caps.mailbox` is true.

**Role 1: depositor.** Every `retransmitMinMs` and on every `onRoutesChanged`, look at
`ctx.messaging.pending()`. An entry is deposited when all of these hold: `custody` is
true; its destination is not reachable; it was created at least `retransmitMinMs` ago;
its packet is at most `MAX_CUSTODY_PACKET` bytes; `custodyState` is null, or `refused`
with fewer than `maxCustodiansPerMessage` custodians tried; and a custodian exists: a
reachable node with `caps.mailbox === true` that is neither this node, nor the
destination, nor one that refused this message. The cheapest route wins, ties by smaller
NodeId. Then:
`ctx.messaging.send(custodian, { kind: "custody-deposit", meta: { ref: id, dst, exp: expiresAt },
content: await packetOf(id), custody: false, lifetimeMs: expiresAt - now() })` and
`setCustodian(id, custodian, "pending")`. A `custody-result` from that custodian sets
`accepted` (emit `custody.deposited`) or `refused` (emit `custody.refused`). The sender
keeps the message in its own outbox either way and still delivers it directly if the
destination becomes reachable; the recipient suppresses the duplicate.

Deposits are wrapped in a sealed message, rather than marked in the `DATA` header,
because the mailbox must know who is depositing to enforce a per-depositor quota, and a
`DATA` header carries no sender.

**Role 2: recipient.** On `message.received` and `message.duplicate` events with
`viaCustody` not null, once per message id: publish
`ctx.identity.signRecord("receipt", { id, ts: now() })` to the `receipt` dataset and emit
`custody.receipt`.

**Role 3: mailbox.** Handler for `custody-deposit` (when `caps.mailbox` is false it
answers `{ ok: false, reason: "not-a-mailbox" }`):
1. Validate: `ref` is a message id, `dst` a NodeId other than ours, `exp` a safe integer
   in the future; `content` decodes (`decodePacket`) to a `DATA` packet whose header
   passes `validateDataHeader`, has `id === ref`, `dst === meta.dst`, no `cust`, and
   whose body starts with `0x01`; size at most `MAX_CUSTODY_PACKET`. Otherwise `invalid`.
2. If a receipt for `(dst, ref)` is already in the dataset: answer ok, store nothing.
3. Key `ref + "-" + first 16 hex of sha256(content)`. If already stored: answer ok.
   (Keying by content as well as id means a forwarder that saw the id cannot occupy the
   slot with garbage.)
4. Quotas: `mailbox.maxBytesPerDepositor` for the authenticated depositor
   (`quota-depositor`), `mailbox.maxEntries` and `mailbox.maxBytesTotal` (`quota-total`).
5. `blobs("deposits").put(key, content)`, append `{ op: "add", key, id, dst, depositor,
   bytes, storedAt, exp: min(exp, now() + limits.messageLifetimeMs) }` to the sealed log
   `mailbox`, await both, then answer `{ re: ref, ok: true }` (reliable, `custody: false`)
   and emit `custody.stored`.

Forwarding: when a destination with deposits becomes reachable, and then with the backoff
`min(retransmitMaxMs, retransmitMinMs * 2^tries)` while it stays reachable, originate the
stored packet with header `{ id, dst, ttl: limits.ttl, try: tries & 0xff, cust: ourId }`;
emit `custody.forwarded`. Purge (delete blob, append `{ op: "del", key, why }`, emit
`custody.purged`) when a receipt with `origin === dst` and the same `id` is accepted
(`receipt`), or `exp` passes (`expired`). Only the destination's signature releases a
deposit.

**`receipt` dataset.** `LwwDataset`, `key = origin + ":" + id`, `version = ts`,
`maxEntries = 20000`. `check`: `validateReceipt` and `verifyRecord(record, "receipt")`
(hard); `ts > now() + maxClockSkewMs` (soft, `future`);
`ts < now() - limits.messageLifetimeMs` (soft, `expired`). Every `retransmitMaxMs` the
service calls `remove(key)` for entries with
`ts < now() - messageLifetimeMs - 2 * maxClockSkewMs`; the floor that `remove` leaves
keeps peers from offering them again.

**Events.** `custody.deposited`, `custody.refused`, `custody.stored`, `custody.forwarded`,
`custody.purged`, `custody.receipt`.
**Timers.** `retransmitMinMs` (depositor sweep, forwarding backoff base),
`retransmitMaxMs` (backoff cap, receipt sweep).
**Bounds.** The three `config.mailbox` quotas; 20000 receipts; 2 custodians per message;
bodies live on disk, the index in memory.
**Routes.** `GET /mailbox`.
**Stats.** `depositsSent`, `depositsAccepted`, `depositsRefused`, `stored`, `storedBytes`,
`forwarded`, `purgedReceipt`, `purgedExpired`, `receiptsPublished`, `receiptsHeld`.

**Tests.** Unit with fake contexts for a depositor, a mailbox and a destination:
- an unreachable destination leads to exactly one deposit after `retransmitMinMs`, with
  the cheapest mailbox; a `custody-deposit` message itself is never deposited;
- the mailbox answers only after the deposit is on disk; a restarted mailbox still holds
  and forwards it;
- forwarding starts when the destination becomes reachable, carries `cust`, repeats with
  backoff, and stops on the receipt;
- a receipt signed by any node other than the destination, or for another id, purges
  nothing; a receipt arriving before the deposit makes the deposit a no-op;
- quotas: per depositor and total, each with its reason, and the depositor then tries
  the next mailbox but never more than two;
- the same deposit twice is stored once; different content under the same id is stored
  separately and does not replace the first;
- invalid deposits (not a packet, wrong type, `dst` mismatch, id mismatch, scheme 2, a
  `cust` already present, oversize, expired) are refused as `invalid`;
- a non-mailbox node answers `not-a-mailbox`;
- expiry purges; the stored blob, read back with the storage key, is the sealed packet
  and nothing else.
Integration: nodes A, M (mailbox) and B. B is stopped; A sends; `custody.deposited`
appears on A; A is stopped; B starts and links to M; B's handler runs once; M purges
after the receipt; A restarts and its outbox empties after its retransmission is
re-acked.

### 8.4 `core/diag/`

**Responsibility.** Ping and traceroute over `PROBE` packets, and the counter view that
turns module statistics into totals and rates. It answers other nodes' probes within a
strict rate limit.

**Files.** `src/core/diag/diag.js`, `src/core/diag/counters.js`,
`test/unit/diag.test.js`, `test/unit/diag-counters.test.js`, `test/integration/diag.test.js`.
**Imports.** `core/crypto/primitives.js` (`randomBytes`), `core/wire/types.js`,
`core/wire/schema.js`, `core/errors.js`.

```js
// diag.js
export function createDiagService({ maxPending = 256, repliesPerSec = 20, repliesPerRsvpPerSec = 5 } = {})
// service.api
ping(dst, { count = 4, intervalMs = 1000, timeoutMs = 5000 } = {}): Promise<PingResult>
traceroute(dst, { maxHops, timeoutMs = 3000 } = {}): Promise<TraceResult>
counters(): CountersSnapshot

// counters.js
export class Counters {
  constructor({ source, now, windowMs = 10000 })     // source: () => nested stats object
  sample(): void                                     // called every second by the service
  snapshot(): CountersSnapshot
}
```

`PingResult`, `TraceResult` and `CountersSnapshot` are defined in `API.md` section 7.

- A probe is `ctx.packets.originate({ type: PacketType.PROBE, header: { id, dst, ttl: n,
  rsvp: ourId, n }, body: EMPTY })`. No route: that probe counts as lost.
- `ping` sends `count` (1..100) probes with `n = limits.ttl`, `intervalMs` (>= 10) apart,
  each waiting `timeoutMs` for a `probe-reply` with `re` equal to its id, `at: "dst"` and
  authenticated sender `dst`. Emits `diag.ping` per probe.
- `traceroute` sends one probe per `n` from 1 to `maxHops` (default and maximum
  `limits.ttl`), sequentially, each waiting `timeoutMs`. A reply's authenticated sender is
  the hop; a timeout is an unknown hop. It ends at the first `at: "dst"` reply. Emits
  `diag.trace_hop` per hop.
- Replies to unknown or already answered probe ids are ignored. Pending probes are
  bounded by `maxPending` (`StateError("busy: …")` beyond).
- Answering: the `probe` handler replies `at: "dst"`, the `probe.expired` handler replies
  `at: "expired"`, both as `ctx.messaging.send(rsvp, { kind: "probe-reply",
  meta: { re: id, n, hop: n - ttl + 1, at }, reliable: false })`, subject to the two
  token buckets of 4.4 and silently skipped when the card of `rsvp` is unknown.
- `Counters` flattens `ctx.node.stats()` to dotted names (`forwarder.forwarded`),
  samples once per second, and reports for each name the total and the rate per second
  over `windowMs`.

**Events.** `diag.ping`, `diag.trace_hop`.
**Timers.** One-second counter sample (`ctx.every`); per-probe timeouts.
**Bounds.** 256 pending probes; reply buckets; 1024 tracked `rsvp` ids.
**Routes.** `POST /diag/ping`, `POST /diag/traceroute`, `GET /diag/counters`.
**Stats.** `probesSent`, `repliesReceived`, `probesAnswered`, `probesRateLimited`,
`probesUnanswerable`.

**Tests.** Unit with fake contexts: reply matching, timeouts, a reply from the wrong node
ignored, a replayed reply ignored, hop arithmetic for every `ttl`, both rate limits,
unknown `rsvp` card, `busy`; counters totals and rates with a fake clock. Integration: on
a four-node line, ping from one end to the other succeeds with `hops: 3` and a plausible
RTT under a known netem latency; traceroute lists the three hops in order; after cutting
the last link, ping reports loss and traceroute stops at the last reachable hop; a
`transit: false` node in the middle is routed around.

### 8.5 `gate/api-server.js`

**Responsibility.** Serves the local control API of `API.md` and the built ClawView
console over HTTP on loopback, and nothing else. It authenticates every API request,
defeats DNS rebinding and cross-site requests, and streams the EventBus to clients.

**Files.** `src/gate/api-server.js`, `test/unit/api-server.test.js`,
`test/integration/api.test.js`.
**Imports.** `node:http`, `node:fs/promises`, `node:path`, `core/crypto/primitives.js`
(`randomBytes`, `timingSafeEqual`, `sha256`), `core/wire/schema.js`, `core/wire/types.js`,
`vault/store.js` (`atomicWriteFile`), `core/errors.js`.

```js
export const MAX_BODY_BYTES = 65536;
export const SSE_KEEPALIVE_MS = 15000;
export const MAX_EVENT_STREAMS = 16;
export function createApiService({ uiDir, sseKeepAliveMs = SSE_KEEPALIVE_MS } = {})
// service.api
address: { host, port } | null     // bound address after start
url: string | null                 // "http://127.0.0.1:47480"
tokenPath: string
```

- `init`: with `config.api.enabled === false` the service does nothing at all. Otherwise
  it registers the core routes of `API.md` (status, identity, peers, topology, messages,
  outbox, config, events, diagnostics that need only the node, shutdown) through
  `ctx.api.route`, implemented with `ctx.node` methods only.
- `start`: read `<dataDir>/api-token`, or create it (32 random bytes as 64 hex characters,
  `atomicWriteFile` with mode 0600). Bind `config.api.host:config.api.port`. Emit
  `api.listening`. The node writes the bound address into `runtime.json` (7.1 step 9).
- Request handling order, every request: Host check; then for `/api/` paths: CORS
  preflight, Origin check, bearer token, route lookup, body parsing, handler; for other
  paths: static files when `config.api.serveUi`. The exact rules and status codes are
  `API.md` sections 2 to 4 and are normative.
- Static files come from `uiDir` (default `<package root>/ui`): `GET` and `HEAD` only,
  path resolved and confined to `uiDir`, a fixed extension-to-type table, `index.html`
  for any path without a file extension, the security headers of `API.md` section 2. A
  missing `uiDir` answers 404 on every non-API path.
- Event streams: one bus listener per stream, a per-stream queue bounded to 1 MiB (on
  overflow the stream is closed; the client resumes), at most `MAX_EVENT_STREAMS` at
  once, keep-alive comments every `sseKeepAliveMs`.
- `stop`: stop accepting, end every event stream, close idle connections, destroy the
  rest after one second.
- Server hardening: header timeout 10 s, request timeout 30 s (event streams exempt), at
  most 64 concurrent connections, bodies over `MAX_BODY_BYTES` rejected while reading.

**Events.** `api.listening`, `api.denied` (at most one per second).
**Timers.** Keep-alive comments; Node's own HTTP timeouts.
**Bounds.** As listed.
**Stats.** `requests`, `denied_host`, `denied_origin`, `denied_token`, `errors`,
`streamsOpen`, `streamsOpened`, `streamsOverflowed`, `eventsSent`.

**Tests.** Against a real node on `127.0.0.1:0`, using `node:http` requests so that any
header can be set:
- no token, wrong token, token of the wrong length: 401; token in a query string is not
  accepted; the right token: 200;
- `Host: evil.example`, `Host: 127.0.0.1.evil.example`, a missing Host: 403, for API and
  static paths alike; the allowed hosts with and without the port: accepted;
- `Origin: http://evil.example` on GET and POST: 403 and no `Access-Control-*` header;
  an origin in `corsOrigins`: allowed with the exact headers; preflight for both;
- every endpoint of `API.md`: success shape, validation errors (unknown field, wrong
  type, bad NodeId), 404 and 405;
- body over 64 KiB: 413; invalid JSON: 400; wrong content type: 415;
- event stream: events arrive in order with ids; `Last-Event-ID` resumes without loss or
  duplication; an id from another boot, and one older than the ring buffer, yield
  `stream.gap`; type filters; keep-alive comments (with a short interval); a stalled
  client is cut at the queue bound; the 17th stream gets 503; `POST /shutdown` stops the
  node and ends the streams;
- static: `index.html`, a nested asset, `..%2f` traversal attempts (404), security
  headers present, the token never appears in any static response;
- `api.host` not loopback without `allowRemote` is refused by config; the token file has
  owner-only permissions on POSIX.

### 8.6 `src/cli/` and `bin/clawnet.js`

**Responsibility.** The `clawnet` command: creates identities, runs a node in the
foreground, talks to a running node through the control API, and launches a local
multi-node development network. It contains no protocol logic.

**Files.** `bin/clawnet.js` (calls `main(process.argv.slice(2))`), `src/cli/main.js`
(argument parsing with `node:util` `parseArgs`, dispatch, exit codes),
`src/cli/commands.js`, `src/cli/client.js` (`ApiClient`), `src/cli/devnet.js`,
`src/cli/standard.js`; `test/e2e/cli.test.js`, `test/e2e/devnet.test.js`.
**Imports.** Everything.

```js
// standard.js
export function standardServices(): Service[]
// client.js
export class ApiClient {
  constructor({ url, token })
  static fromDataDir(dataDir): Promise<ApiClient>      // reads runtime.json and api-token
  request(method, path, body?): Promise<any>           // throws an Error with .status and .code from the error body
  events({ types, lastEventId, signal }): AsyncIterable<{ id, type, event }>
}
// devnet.js
export async function startDevnet({ nodes, baseDir, topology = 'ring', ui = false, onReady })
  // -> { nodes: [{ index, nodeId, dataDir, listen, api, pid }], stop(): Promise<void> }
```

Global options: `--data-dir <dir>` (else `resolveDataDir`), `--json` (machine output: one
JSON document on stdout). Exit codes: 0 success, 1 failure, 2 usage error, 3 the node is
not running.

| Command | Does |
| --- | --- |
| `init [--passphrase-file <f>] [--no-passphrase]` | create the data dir, config defaults and keystore; print the NodeId. Refuses to overwrite. Without either flag it prompts on a TTY and warns when the keystore is left unencrypted |
| `start [--listen host:port] [--api-port n] [--bootstrap addr]... [--network id] [--network-key-file f] [--no-multicast] [--passphrase-file f]` | run a node in the foreground with `standardServices()`. When ready, prints one line `{"event":"ready","nodeId":…,"listen":"tcp://…","api":"http://…","dataDir":…}` on stdout. `SIGINT`/`SIGTERM` stop it cleanly. The passphrase comes from the file, else `CLAWNET_PASSPHRASE`, else a TTY prompt |
| `passwd` | `Keystore.changePassphrase` |
| `status`, `id`, `peers`, `topology`, `routes`, `outbox`, `counters`, `config` | GET the matching endpoint and print it |
| `connect <addr>`, `disconnect <id>` | peers endpoints |
| `send <id> <text>`, `inbox [<id>]` | messages endpoints |
| `channels`, `join <name> [--key <b64> \| --new-key]`, `leave <name>`, `cast <name> <text>`, `history <name>` | channels endpoints; `--new-key` generates 32 random bytes and prints them once |
| `send-file <id> <path>`, `transfers`, `accept <tid>`, `reject <tid>`, `cancel <tid>` | files endpoints |
| `ping <id> [-c n]`, `trace <id>` | diagnostics endpoints |
| `events [--types a,b]` | follow the event stream, one JSON event per line |
| `token` | print the API token |
| `ui` | print `http://<host>:<port>/#token=<token>`; with `--open` launch the browser |
| `stop` | `POST /shutdown` and wait until `runtime.json` is gone |
| `devnet --nodes <n> [--topology line\|ring\|star\|mesh] [--base-dir d] [--ui]` | start `n` child nodes and stay in the foreground until interrupted |

Node ids on the command line may be abbreviated to any unique prefix of at least 8
characters among the ids in the topology and peer list; the CLI resolves it, the API
takes full ids only.

**Devnet.** Creates `baseDir/node-<i>` for each node, runs `init --no-passphrase` in each,
reads the node ids, then writes each `config.json` with `listen` on `127.0.0.1` port 0,
the API on port 0, multicast disabled, `discovery.pex` false and `peers.allow` set to the
node's neighbours in the chosen topology, so the topology is exactly the one asked for.
It starts node 0, reads its `ready` line, and starts the others with `--bootstrap`
addresses of their lower-numbered neighbours. `stop()` sends `SIGTERM` (on Windows,
`POST /shutdown`) and kills what has not exited after five seconds. With `--ui` it prints
the `ui` link of every node.

**Tests** (end to end, separate OS processes, own temp dirs, ports from the `ready` line):
`init` then `start` then `status` then `stop`, checking exit codes and that `runtime.json`
and `lock` are gone; `init` twice refuses; a wrong passphrase fails to start with exit 1
and no stack trace; a second `start` on the same data dir fails with the lock message; a
three-node devnet line: `send` from node 0 to node 2 appears in node 2's `inbox`, `trace`
shows node 1 in the middle, `cast` reaches all; killing node 1 with `SIGKILL` leaves the
message in node 0's `outbox`, and restarting node 1 delivers it; `events` prints
`link.up`; a client command against a stopped node exits 3.

## 9. Event catalogue

This is the complete list of EventBus event types. A module emits only the events listed
for it. Every event is `{ seq, ts, type, data }`; the table gives `data`. All of them are
visible on the control API's event stream, so a field added here is an API change and
must be added to `API.md` section 8 as well; this section is the normative one.

Conventions: `peer`, `origin`, `dst`, `from`, `nextHop`, `custodian`, `depositor` are
NodeIds; `id` is a 32-hex message or packet id unless stated; `addr` is an `Address`;
times and durations are milliseconds; `type` inside packet events is `"data"` or
`"probe"`. Lists inside events are capped at 500 items; when a list was cut the event
carries `truncated: true`.

The node constructs the bus with `capacity: 5000`.

**Node** (`core/node.js`, `core/events.js`, `core/storage.js`)

| Event | Data |
| --- | --- |
| `node.started` | `{ nodeId, boot, agent, networkId, listen: Address \| null }` |
| `node.stopping` | `{ reason }` |
| `node.stopped` | `{}` |
| `internal.error` | `{ where, code: string \| null, message }` (an exception caught in a timer, handler or stop step) |
| `internal.listener_error` | defined by `core/events.js` |
| `store.recovered` | `{ file, movedTo }` |
| `sync.peer_error` | `{ peer, reason, detail }` (a protocol violation reported by `SyncEngine`, for example `invalid-record`; the link is closed) |
| `traffic.sample` | `{ intervalMs, links: [{ peer, packetsIn, packetsOut, bytesIn, bytesOut }], forwarder: { originated, forwarded, delivered, queued, dropped }, suppressed }` deltas since the previous sample; only links with activity are listed; not emitted when everything is zero |

**Peers** (`core/peer/peer-manager.js`)

| Event | Data |
| --- | --- |
| `peer.dialing` | `{ addr, peer: NodeId \| null, source, attempt }` |
| `peer.dial_failed` | `{ addr, peer: NodeId \| null, reason, retryInMs }` |
| `peer.refused` | `{ addr, peer, direction: "in" \| "out", reason }` (`self`, `blocked`, `not-allowed`, `full`) |
| `link.up` | `{ peer, linkId, direction, addr, agent, caps, rttMs, cost }` |
| `link.down` | `{ peer, linkId, reason, remote: boolean, durationMs }` |
| `link.metric` | `{ peer, rttMs: number \| null, srttMs, cost, misses }` (`rttMs` null for a miss) |
| `link.throttled` | `{ peer, by: "packets" \| "bytes" }` |

**Discovery** (`core/discovery/*`)

| Event | Data |
| --- | --- |
| `discovery.candidate` | `{ addr, peer: NodeId \| null, source }` (a new address entered the book) |
| `discovery.error` | `{ source: "multicast", message }` |
| `peer.record` | `{ peer, seq, addrs: Address[], caps }` (a newer peer record was accepted) |

**Routing** (`core/routing/forwarder.js`)

| Event | Data |
| --- | --- |
| `lsa.originated` | `{ seq, links: number, reason }` |
| `lsa.accepted` | `{ origin, seq, changed: boolean, from: NodeId \| null }` |
| `lsa.expired` | `{ origin }` |
| `routes.changed` | `{ rev, total, reachable: NodeId[], unreachable: NodeId[], changed: number }` (`reachable`/`unreachable` are the differences; `changed` counts destinations whose next hop or cost changed) |
| `topology.changed` | `{ rev, full: boolean, nodesAdded: [{ id, caps }], nodesUpdated: [{ id, caps }], nodesRemoved: NodeId[], linksAdded: Link[], linksUpdated: Link[], linksRemoved: [{ a, b }] }` with `Link = { a, b, costAB: number \| null, costBA: number \| null, state: "confirmed" \| "half" }` and `a < b`. `full: true` (lists empty) means the difference was too large: fetch the snapshot |
| `packet.sent` | `{ id, type, dst, nextHop, try: number \| null, bytes, path: NodeId[] \| null }` (originated here; `path` is this node's predicted route, self first) |
| `packet.forwarded` | `{ id, type, dst, from, nextHop, ttl, bytes }` (`ttl` as sent on) |
| `packet.delivered` | `{ id, type, from, bytes }` (arrived for this node) |
| `packet.queued` | `{ id, type, dst, from, reason, queued: number }` (`no-route`, `split-horizon`, `backpressure`) |
| `packet.dropped` | `{ id, type, dst, from: NodeId \| null, reason }` (`ttl`, `duplicate`, `no-transit`, `transit-full`, `hold-expired`, `malformed`, `no-handler`, `auth`, `busy`) |

**Messaging** (`core/messaging/reliable.js`)

| Event | Data |
| --- | --- |
| `message.queued` | `{ id, dst, kind, bytes }` |
| `message.sent` | `{ id, dst, kind, attempt, nextHop }` (every transmission; `attempt` starts at 1) |
| `message.waiting` | `{ id, dst, kind }` (no route; emitted on the transition) |
| `message.acked` | `{ id, dst, kind, attempts, elapsedMs }` |
| `message.expired` | `{ id, dst, kind }` |
| `message.cancelled` | `{ id, dst, kind }` |
| `message.received` | `{ id, from, kind, bytes, prevHop, viaCustody: NodeId \| null }` |
| `message.duplicate` | `{ id, prevHop, viaCustody: NodeId \| null }` |
| `message.unhandled` | `{ id, from, kind }` |
| `message.handler_error` | `{ id, from, kind, message }` |
| `chat.message` | `{ message: ChatMessage }` (new, either direction) |
| `chat.state` | `{ id, peer, state }` (an outgoing chat message changed state) |

**ClawCast** (`cast/channels.js`)

| Event | Data |
| --- | --- |
| `cast.joined` | `{ name, chan, encrypted: boolean }` |
| `cast.left` | `{ name, chan }` |
| `cast.message` | `{ message: CastMessage }` (surfaced in a joined channel, ours included) |
| `cast.rejected` | `{ origin, chan, reason }` |

**Files** (`vault/file-transfer.js`)

| Event | Data |
| --- | --- |
| `file.offered`, `file.incoming`, `file.accepted`, `file.rejected`, `file.completed`, `file.failed`, `file.cancelled` | `{ transfer: Transfer }` |
| `file.progress` | `{ id, direction, bytesDone, size, chunksDone, chunks, rateBps }` (`id` is the transfer id) |
| `file.paused` | `{ id, reason }` (`unreachable`, `stalled`, `queued`) |
| `file.resumed` | `{ id }` |

**Custody** (`gate/relay.js`)

| Event | Data |
| --- | --- |
| `custody.deposited` | `{ id, dst, custodian }` (our message was accepted by a mailbox) |
| `custody.refused` | `{ id, dst, custodian, reason }` |
| `custody.stored` | `{ id, dst, depositor, bytes }` (we, as mailbox, took a deposit) |
| `custody.forwarded` | `{ id, dst, try }` |
| `custody.purged` | `{ id, dst, reason: "receipt" \| "expired" }` |
| `custody.receipt` | `{ id, custodian }` (we published a receipt for a message that reached us out of custody) |

**Diagnostics and API** (`core/diag/diag.js`, `gate/api-server.js`)

| Event | Data |
| --- | --- |
| `diag.ping` | `{ dst, seq, id, rttMs: number \| null, hops: number \| null }` |
| `diag.trace_hop` | `{ dst, n, node: NodeId \| null, rttMs: number \| null, reached: boolean }` |
| `api.listening` | `{ host, port }` |
| `api.denied` | `{ reason: "host" \| "origin" \| "token", remote }` |

No event carries message text except `chat.message` and `cast.message`, which exist to
feed the local UI and are reachable only with the API token.

## 10. Test helpers

Rules of DESIGN.md section 14 apply to everything here: loopback only, port 0, one temp
directory per node (`test/helpers/tmp.js`), every node and proxy closed by the test.

### 10.1 `test/helpers/netem.js`

A loopback TCP proxy standing in front of one node's listener. A link "through netem" is
made by dialing the proxy instead of the node.

```js
export async function createNetem({ target, latencyMs = 0, jitterMs = 0, record = true, maxRecordBytes = 16 * 1024 * 1024 })
  // target: { host, port } or an Address; resolves to a Netem listening on 127.0.0.1:0

class Netem {
  address: Address                    // "tcp://127.0.0.1:<port>": what the dialing node connects to
  port: number
  setLatency(ms, jitterMs = 0): void  // per direction; byte order is always preserved
  blackhole(on = true, { direction = 'both' } = {}): void   // 'up' (dialer to target), 'down', 'both'
  cut(): void                         // destroy every connection now and refuse new ones
  heal(): void                        // accept again and stop blackholing
  get connections(): number
  recorded(direction = 'both'): Buffer        // bytes seen, in arrival order per direction ('both' = up then down)
  contains(needle: Buffer | string): boolean  // searched in each direction's whole byte stream
  clearRecording(): void
  stats(): { accepted, refused, bytesUp, bytesDown, droppedUp, droppedDown }
  close(): Promise<void>
}
```

- Latency delays each chunk by `latencyMs` plus a uniform value in `[0, jitterMs]`, never
  delivering a chunk before an earlier one of the same direction.
- A blackhole reads and discards; the TCP connections stay open, so the nodes notice only
  through their keepalive. Discarded bytes are still recorded.
- `cut()` resets connections, so both nodes see a socket error at once; while cut, new
  connections are accepted and immediately destroyed.
- Recording stops silently at `maxRecordBytes` per direction (`stats()` still counts).
- `contains` is how tests assert that plaintext, NodeIds and keys never appear on the
  wire. It is only meaningful for strings long enough not to occur by chance (16 bytes
  or more).

### 10.2 `test/helpers/cluster.js`

```js
export const FAST_TIMERS = Object.freeze({
  keepaliveMs: 200, peerTimeoutMs: 800, handshakeTimeoutMs: 2000,
  redialMinMs: 100, redialMaxMs: 1000, redialJitter: 0.2,
  lsaRefreshMs: 1000, lsaMaxAgeMs: 3500, lsaTombstoneMs: 60000, spfDebounceMs: 10,
  syncIntervalMs: 300, gossipBatchMs: 5,
  retransmitMinMs: 200, retransmitMaxMs: 2000, transitHoldMs: 2000, beaconIntervalMs: 200,
});

export async function startCluster(t, {
  size,
  topology = 'none',          // 'none' | 'line' | 'ring' | 'star' | 'mesh' | [[i, j], ...]
  netem = false,              // true: every edge goes through its own Netem
  config,                     // (i) => partial config merged over the defaults below
  services,                   // (i) => Service[]; default: none (core only)
  start = true,
})  // -> Cluster

class Cluster {
  nodes: ClawNode[]
  ids: NodeId[]
  dirs: string[]
  link(i, j): Netem | null                       // the proxy on that edge, if any
  connect(i, j, { netem = false } = {}): Promise<Netem | null>   // i dials j
  disconnect(i, j): Promise<void>
  partition(groupA: number[], groupB: number[]): void   // cut every proxied edge between the groups
  heal(): void
  addNode(overrides?): Promise<number>           // returns its index
  stopNode(i): Promise<void>
  restartNode(i): Promise<ClawNode>              // same data dir, same identity, new port
  waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, message } = {}): Promise<void>
  waitForEvent(i, type, predicate?, { timeoutMs = 5000 } = {}): Promise<BusEvent>
  converged({ timeoutMs = 5000 } = {}): Promise<void>
  close(): Promise<void>                         // also registered with t.after
}
```

- Node defaults: `listen` and `api` on `127.0.0.1` port 0, `api.enabled` false unless the
  test supplies the api service, multicast disabled, `discovery.pex` false,
  `discovery.bootstrap` empty, `timers: FAST_TIMERS`, no passphrase, a fresh temp dir.
  With these, the only links are the ones the test creates with `connect`, which uses
  `node.connect(addr)` (sticky), so the topology is exact and edges through a proxy stay
  through it.
- For each edge `[i, j]` of the topology, node `i` dials node `j`.
- `partition` requires the crossing edges to be proxied and throws otherwise.
- `restartNode` re-creates proxies whose target port changed and reconnects the node's
  edges.
- `converged` waits until every running node has a route to every other running node
  that is connected to it through running nodes and uncut edges, and none to the others.
- `waitFor` throws an error that includes `message` and each node's `status()` on timeout.

### 10.3 Integration tests of wave 2 (`test/integration/`)

Real nodes over loopback TCP; these are the test plan of `core/node.js`.

| File | Must prove |
| --- | --- |
| `link.test.js` | two nodes link and see each other's id, agent and caps; different `networkId` and different or missing `networkKey` never link and never emit `link.up`; allow list, block list and self-dial are refused with their reasons; simultaneous dials leave one link; `stop()` is seen as `shutdown` |
| `routing.test.js` | on a line of four, every node has routes to the other three with the right next hop and hop count; with two paths, added latency on one moves the route to the other within a few keepalives and moves it back when the latency is removed; a cut link reroutes; a `transit: false` node carries no transit traffic but stays reachable; LSAs of a stopped node expire and its routes go |
| `messaging.test.js` | a message from A to C through B is delivered once and acked; `packet.forwarded` appears on B; B's events and the capture on both links contain no plaintext; with B's onward link blackholed the message is retransmitted with a growing `try` and arrives after `heal()`; with no route it waits in the outbox and leaves at once when the route appears; unknown destination fails synchronously |
| `restart.test.js` | a sender stopped with a pending message delivers it after restart; a receiver restarted between delivery and a retransmission does not deliver twice; a restarted node advertises a higher LSA `seq` and its neighbours redial; a corrupted `state.json` and a truncated `outbox.log` are recovered with `store.recovered` and the node starts |
| `partition.test.js` | two triangles joined by one proxied edge: after `partition` each side drops routes to the other and messages across wait; after `heal` the LSDBs converge, the outboxes drain, and every message is delivered exactly once |
| `discovery.test.js` | with `pex` on, a node bootstrapped to one peer learns and dials others until it reaches `peers.target`; peer records of unlinked nodes arrive, so a message can be sealed to a node two hops away |
| `hostile.test.js` | a test peer built from `establishChannel` that then sends a packet with an unknown type, an invalid `DATA` header, an oversized frame, a non-canonical header, and a forged LSA is disconnected each time with `protocol` and refused for the penalty period; a flood above the rate limit is throttled and the node stays responsive to a third node |
| `wire-privacy.test.js` | across a session with a handshake, chat, a cast and LSAs, the captured bytes contain neither NodeId, nor any card field, nor the network id, nor any message text |

## 11. End-to-end flows

Module names in brackets say who does the step.

### 11.1 Link handshake (A dials B)

1. [A peer-manager] The maintenance pass picks `tcp://B` from the address book, emits
   `peer.dialing`, and calls `dialTcp`.
2. [B peer-manager] Accepts the socket if fewer than 32 inbound handshakes are pending and
   fewer than 4 from that IP; starts `establishChannel` as responder.
3. [A secure-channel] Sends Noise message 1 (`e`, empty payload).
4. [B secure-channel] Sends message 2 (`e, ee, s, es`) with B's payload; `observed` is A's
   IP as B sees it.
5. [A secure-channel] Decrypts, verifies B's payload (5.2 table): canonical, version,
   schema, network, static key equals `card.link`, card signature, clock skew.
   [A peer-manager] `authorize`: not self, not blocked, allowed. On refusal A closes the
   socket and the flow ends with `peer.dial_failed` or `peer.refused`.
6. [A secure-channel] Sends message 3 (`s, se`, and `psk` with a network key) with A's
   payload, whose `listen` already uses the `observed` value B reported. Both sides split.
7. [B secure-channel] Verifies A's payload the same way. [B peer-manager] `authorize`
   additionally checks capacity. Refusal: B sends `BYE {reason}` and closes; A's
   `connect` rejects with that reason; neither side emits `link.up`.
8. [B secure-channel] Sends `PING {n: 0}`; resolves. [A secure-channel] Reads it; resolves.
9. [both peer-managers] Duplicate-link resolution (5.4). Create the `LinkMetric`, seed it
   with the handshake RTT, update the address book, start the channel, emit `link.up`.
10. [both nodes] `onLinkUp`: `pex.noteCard`; `router.linkUp` originates a new LSA;
    `sync.addPeer` starts an anti-entropy round, which exchanges LSAs and peer records;
    `forwarder.flush`.
11. [both routers] Each receives the other's LSA through the `lsa` dataset; the link is
    now advertised by both ends; SPF runs after `spfDebounceMs`; `routes.changed` and
    `topology.changed` are emitted; the messenger attempts anything waiting for a
    destination that became reachable.
12. [both peer-managers] Keepalive `PING`/`PONG` begins; every sample emits `link.metric`
    and may trigger a re-advertisement.

### 11.2 A routed message with its ack (A to C through B)

1. [A api or caller] `node.sendMessage(C, text)`. [A conversations] validates the text and
   calls `messenger.send(C, { kind: "msg", content })`.
2. [A messenger] Looks up C's card, generates `id`, seals (Noise X to C's e2e key,
   prologue binding `dst` and `id`, `meta = { kind: "msg", ack: true, card, ts }`), stores
   the packet blob and the outbox record, emits `message.queued`.
3. [A messenger -> forwarder] `originate({ type: DATA, header: { id, dst: C, ttl: 16, try: 0 }, body })`.
   The forwarder records the forward key, finds next hop B, sends; `packet.sent` (with
   the predicted path `[A, B, C]`) and `message.sent` are emitted; the retransmission
   timer is armed.
4. [B peer-manager -> forwarder] `handle(A, packet)`: header valid; `dst` is not B; key
   not seen; `ttl` 16 becomes 15; B is a transit node; next hop C is linked and is not A;
   sends; `packet.forwarded`. B never parses the body.
5. [C forwarder] `dst` is C: `packet.delivered`; body byte 0 is 1: `messenger.handleData`.
6. [C messenger] `id` not seen and not in flight; `openMessage` verifies framing, length,
   that the Noise static key equals `meta.card.e2e`, the card signature and `ts`; the
   sender is now authenticated as A. Calls the `msg` handler.
7. [C conversations] Stores the message, emits `chat.message`.
8. [C messenger] Records `id` as seen (memory and `seen.log`), emits `message.received`,
   and sends an unreliable sealed `ack` with `meta.re = id` to A; it travels C, B, A like
   any `DATA` packet, with its own id.
9. [A messenger] Opens the ack; its authenticated sender is the entry's `dst`; removes the
   entry and blob; emits `message.acked`. [A conversations] state `delivered`,
   `chat.state`.

### 11.3 A retransmission

1. As 11.2 steps 1 to 3, but the packet is lost after B (link down, blackhole, or a full
   transit queue).
2. [A messenger] After about `retransmitMinMs` (2 s, jittered 10 %) with no ack: attempt 2
   with `try: 1`, same `id` and same body. `message.sent { attempt: 2 }`.
3. [B forwarder] The key `(id, 1, "")` is new, so B forwards it even though it forwarded
   `(id, 0, "")`. A copy of `try: 0` that was merely delayed and arrives later at some
   node that already saw it is dropped as `duplicate`.
4. Further attempts follow at about 4 s, 8 s, … up to `retransmitMaxMs`, until the ack
   arrives or the message expires after `messageLifetimeMs` (`message.expired`).
5. If instead the data arrived and the **ack** was lost: [C messenger] receives `try: 1`,
   finds `id` in the seen-cache, does not call the handler again, re-opens the packet to
   authenticate the sender, and sends a fresh `ack` (at most one per
   `retransmitMinMs / 2`); `message.duplicate` is emitted.
6. If A has no route at an attempt, the entry becomes `waiting` and no `try` is consumed;
   the next `routes.changed` that makes C reachable triggers an attempt at once.

### 11.4 Custody deposit and delivery (A to B through mailbox M)

1. [A messenger] A sends a reliable message to B. B is unreachable: the entry is `waiting`.
2. [A relay] At the next sweep after `retransmitMinMs`, the entry qualifies. M is the
   cheapest reachable node advertising `caps.mailbox`. A sends M a reliable sealed
   `custody-deposit` whose content is the encoded packet for B, and marks the entry
   `pending` with custodian M.
3. [M messenger -> relay] The deposit is opened; its authenticated sender A is the
   depositor. M validates the inner packet, checks A's quota and the totals, writes the
   blob and the index record, then sends A a reliable `custody-result { ok: true }` and
   emits `custody.stored`. M cannot read the inner body: it is sealed to B.
4. [A relay] Marks the entry `accepted`; `custody.deposited`; the chat state becomes
   `custody`. A keeps the message in its outbox and may now go offline.
5. [M relay] When `routes.changed` reports B reachable, M originates the stored packet
   with header `{ id, dst: B, ttl, try: 0, cust: M }`; `custody.forwarded`. It repeats
   with backoff while B stays reachable and no receipt has arrived.
6. [B forwarder -> messenger] Delivered and opened exactly as in 11.2; the handler runs;
   `message.received { viaCustody: M }`. B sends the usual sealed `ack` to A; if A is
   unreachable the ack is simply dropped.
7. [B relay] Because `viaCustody` is set, B signs `{ type: "receipt", origin: B, id, ts }`
   and publishes it to the `receipt` dataset; ClawSync floods it.
8. [M relay] The receipt arrives through the dataset; its origin equals the deposit's
   `dst` and the id matches: M deletes the deposit; `custody.purged { reason: "receipt" }`.
9. [A messenger] When A is back and B is reachable, A's own retransmission reaches B; B
   sees a duplicate and re-acks; A removes the entry; `message.acked`.

### 11.5 A cast

1. [A cast] `publish("ops", text)`: channel joined, rate allowed, `n` taken and flushed to
   disk; with a channel key the text is encrypted under a fresh per-message key with
   `{ chan, n, origin, ts }` as associated data; the record is signed and published to the
   `cast` dataset. A appends it to its history and emits `cast.message`.
2. [A sync] The record is new locally, so it is queued for every neighbour and sent as
   `GOSSIP` after `gossipBatchMs`.
3. [B sync -> cast] B's dataset has no index `n` for that stream: `check` runs (schema,
   rate bucket, signature, time, stream count). Accepted as new: a token is taken from
   A's bucket, the record is stored and forwarded to every neighbour except the one it
   came from. B has not joined the channel, so nothing is surfaced.
4. [C cast] C has joined with the key: the record decrypts, the text is valid UTF-8, it is
   appended to C's history, `cast.message` is emitted.
5. [every sync] A node that already holds the record does not forward it again; that ends
   the flood. A node that missed the gossip (packet loss, or it joined later) gets the
   record in an anti-entropy round, when its digest for that stream shows a lower
   high-water mark.
6. A node that joins the channel later surfaces the records its dataset still holds.

### 11.6 A file transfer with resume (A sends to B)

1. [A files] `send(B, path)`: stat and hash the file (`preparing`), create `tid` and a
   random key, persist, send a reliable `file-offer`; `file.offered`.
2. [B files] Validates the offer. Policy `ask`: state `offered`, `file.incoming`; the user
   accepts through the API. B creates the `.part` file and sends a reliable `file-accept`
   with `base: 0`.
3. [A files] State `sending`. Sends up to `files.window` chunks as scheme-2 `DATA`
   packets; each is encrypted under the transfer key with its index as nonce.
4. [forwarders] Route the chunks like any `DATA` packet; they see ids, the destination
   and sizes, nothing else.
5. [B files] Authenticates each chunk, writes it at its offset, and every 8 chunks (or
   after a short delay) sends an unreliable `file-sack`; `file.progress`. Every 64 chunks
   or second it fsyncs the data and saves its bitmap.
6. [A files] Each sack slides the window; chunks reported missing below the highest
   acknowledged index are sent again.
7. **Interruption.** The path breaks. [A files] no sack for the stall interval: outstanding
   chunks are marked unsent; after three stalls the transfer is `paused` and the offer is
   sent again as a reliable message (it waits in the outbox). [B files] no chunks: it
   sends `file-accept` with its current `base` and `ranges`, also reliable.
8. **Or B restarts.** B reloads the transfer and its bitmap, reopens the `.part`, and
   sends `file-accept` with what it holds.
9. **Resume.** When the path returns, the outboxes drain. A receives `file-accept`
   (directly, or as the answer to its repeated offer), learns exactly which chunks B
   holds, and continues from there; `file.resumed`. Nothing B already holds is sent again.
10. [B files] All chunks held: `verifying`; the SHA-256 of the whole file matches the
    offer; the file is fsynced and renamed from `.part` to its final name;
    `file.completed`; reliable `file-done { ok: true }`.
11. [A files] `completed`. On a hash mismatch B deletes the `.part` and both sides end in
    `failed`.

### 11.7 Healing a partition

Start: two groups X and Y, internally connected, with no link between them.

1. [each side] Links between the groups are gone: `link.down`; the routers originate LSAs
   without them at once, so routes to the other side disappear (`routes.changed`); within
   `lsaMaxAgeMs` the other side's LSAs expire (`lsa.expired`) and only their `seq`
   remains, as a tombstone in the LSDB and a floor in the dataset.
2. [messengers] Messages for the other side are `waiting` in the outbox; with a mailbox
   on the same side they are also deposited (11.4). Casts and receipts accumulate on each
   side.
3. [peer-managers] The lost addresses are redialed with backoff from 1 s up to 60 s.
4. A dial succeeds: one link x-y exists (11.1). [x, y routers] originate LSAs listing it.
5. [x, y sync] `addPeer` starts anti-entropy at once. Digests are exchanged for all four
   datasets: each side sends the LSAs, peer records, casts and receipts the other lacks,
   in several packets if needed.
6. [x, y sync] Every record that is new to x or y is gossiped on to their other
   neighbours, so each side's records flood through the other side.
7. [all routers] As LSAs arrive the confirmed graph joins up; SPF runs;
   `topology.changed` and `routes.changed` report the other side reachable.
8. [all messengers] `routesChanged` triggers an immediate attempt for every waiting
   message whose destination is back; acks return; outboxes drain.
9. [mailboxes] Deposits for destinations that became reachable are forwarded; receipts
   flood back; deposits are purged.
10. [cast] Each side surfaces the other's casts as the log dataset fills in; per-sender
    order is preserved by `n`.
11. [files] Paused transfers resume (11.6 step 9).
12. Anything a gossip packet missed is repaired by the periodic anti-entropy round
    (`syncIntervalMs`) with a random neighbour.

## 12. Bounds summary

Every queue and table in waves 2 and 3, and what bounds it.

| Resource | Bound | Enforced by |
| --- | --- | --- |
| Links | `peers.max` | peer-manager |
| Pending inbound handshakes | 32, 4 per IP | peer-manager |
| Concurrent dials | 4 | peer-manager |
| Per-link send queue | 4 MiB (control frames exempt) | secure-channel |
| Per-link receive rate | `limits.peerPacketsPerSec`, `limits.peerBytesPerSec` (throttled) | peer-manager |
| Packet, header, frame | `Limits.MAX_PACKET`, `Limits.MAX_HEADER` (disconnect) | codec |
| Address book | 4096 entries, 16 addresses per node | address-book |
| Penalty box | 1024 ids | peer-manager |
| Beacon verification | 50 per second, 2048-byte datagrams | multicast |
| LSDB and `lsa` dataset | 10000 origins | router |
| Peer records | 10000 | pex |
| Transit queue | `limits.transitQueueMax` entries, 32 MiB, a quarter per previous hop, `timers.transitHoldMs` | forwarder |
| Forward seen-cache | `limits.seenCacheEntries`, `2 * transitHoldMs` | forwarder |
| Packet events | 200 per second | forwarder |
| Outbox | `limits.outboxMaxEntries`, `limits.outboxMaxBytes`; 16 MiB of bodies in memory | messenger |
| Delivered-id cache | `limits.seenCacheEntries`, message lifetime plus skew | messenger |
| In-flight inbound messages | 1024 | messenger |
| Conversations | 1000 messages per peer, 1000 peers | conversations |
| Sync packets | 256 records, 256 KiB, 4096 pending per peer | node (SyncEngine limits) |
| Casts | 64 per stream, 1024 streams, 16 streams per origin, `limits.castPerOriginPerMin` | cast |
| Cast history | 1000 per joined channel | cast |
| Transfers | 8 active per direction, 64 pending offers (8 per peer), 2^20 chunks, `files.maxSizeBytes` | files |
| Mailbox | `mailbox.maxEntries`, `maxBytesTotal`, `maxBytesPerDepositor` | relay |
| Receipts | 20000 | relay |
| Probe replies | 20 per second, 5 per requester; 256 pending probes | diag |
| API | 64 KiB bodies, 64 connections, 16 event streams, 1 MiB per stream queue | api-server |
| Event ring buffer | 5000 events | node |

## 13. Decisions

Where DESIGN.md was silent or ambiguous, this document decided. Each is binding for
waves 2 and 3 and should be folded into DESIGN.md or PROTOCOL.md.

1. **`ttl` handling.** Destination delivers regardless of `ttl`; a forwarder drops when
   `ttl - 1 < 1`. On-wire `ttl` is 1..32 as DESIGN.md says; the schema's 0 is tolerated
   and dropped at the first forwarder. (4.2)
2. **Forwarder check order.** Duplicate check before the `ttl` decrement (DESIGN.md lists
   them the other way round); the observable difference is only which drop reason a
   duplicate with an exhausted `ttl` gets, and it keeps a replayed probe from triggering
   repeated expiry replies. (5.6)
3. **`try` wraps modulo 256**, and the forward duplicate key is `(id, try, cust)`. (4.2)
4. **Split horizon.** A packet whose next hop is the neighbour it came from is queued,
   not bounced. (5.6)
5. **Direct neighbours are reachable without a confirmed route**, covering the gap
   between link-up and LSA confirmation. (5.6)
6. **Admission confirmation frame** (`PING {n: 0}` or `BYE`) after the Noise handshake, so
   a refused initiator never sees a link. (5.2)
7. **Duplicate links**: the smaller-initiator rule of DESIGN.md, extended with "same
   initiator: newer replaces older (`replaced`)" for a peer that restarted. (5.4)
8. **Rate limits throttle, hard limits disconnect.** Exceeding a token bucket pauses
   reading from that link. (5.4)
9. **Control frames have priority** on a link and are exempt from the send-queue bound,
   so bulk traffic cannot cause a keepalive timeout. (5.2)
10. **Announced addresses** come from `advertise`, else from the IPs peers report in
    `observed`. (4.6)
11. **Every node publishes a peer record**; peer records are the card directory; sending
    to a node whose card is unknown fails immediately. (4.7)
12. **Dial policy by source**: manual addresses are sticky; bootstrap, multicast and
    exchanged addresses are dialed only below `peers.target`; `discovery.pex = false`
    stops dialing exchanged and handshake-learned addresses but not record relaying. (5.4)
13. **`caps.relay`** has no protocol effect in v1: it is advertised and used only as a
    dial preference. (5.4)
14. **LSA tombstones in ClawSync**: an expired LSA is removed from the `lsa` dataset with
    `remove()`, whose floor mirrors the LSDB tombstone, and the floor is forgotten when
    the tombstone is. (5.6)
15. **Hard and soft check failures** in datasets: schema and signature are hard and get
    the relaying peer disconnected; clock, rate and quota tests are soft. (4.5)
16. **All four datasets on every node**; the node creates relay-only instances for
    datasets whose service is absent. (7.1)
17. **PROBE semantics**: `n` is the initial `ttl`; replies are sealed `probe-reply`
    messages; replies are rate limited. (4.4)
18. **Sealed-message conventions**: reserved meta keys, the `ack` flag in `meta`, the
    kinds registry, the size limits. (4.3)
19. **Acks are sent after the handler succeeds**; an unknown kind is acked; a failed
    handler is not. Handlers must be idempotent. (5.7, 7.3)
20. **A forged packet does not poison the delivered-id cache**: ids are recorded only
    after authentication and handling. (5.7)
21. **Custody deposits are sealed `custody-deposit` messages**, not marked `DATA` packets;
    `cust` appears only on the mailbox's delivery leg; receipts are a flooded dataset;
    deposits are keyed by id and content hash. (8.3)
22. **Cast rate limit** is a per-origin token bucket on arrival with a burst of four
    minutes' worth, consumed only for new records; over-limit records are soft-rejected.
    Cast associated data is `{ chan, n, origin, ts }`. Cast bodies are UTF-8 text. (8.1)
23. **File transfer wire details**: message kinds, sack format, window and stall rules,
    resume by repeated offer or accept, the source-file change check, name sanitizing. (8.2)
24. **Storage at rest**: which files are sealed with the storage key and how. (3, 5.8)
25. **Keystore secret layout**: `signSeed || linkPrivate || e2ePrivate`, 96 bytes. (3)
26. **Bounds without configuration keys** are module constants with constructor
    overrides; timers without keys are derived from existing keys. (1)
27. **Packet events are rate-capped** and file chunks produce no per-packet events at
    their endpoints; `traffic.sample` carries the totals. (5.6)
28. **Error classes**: connection and handshake failures are `HandshakeError`; API errors
    are plain errors carrying `status` and `apiCode`, since `errors.js` has no class for
    either. (1, 6)

### What this document relies on in wave 1 modules

Wave 1 was written in parallel with this document. These are the properties of the
wave 1 sources that the designs above depend on, read from the code as it stood when
this document was finished. If one of them changes, the section named with it changes too.

| Property | Where | Used by |
| --- | --- | --- |
| `offer` runs the duplicate, stale, floor and capacity tests before `check` | `sync/datasets.js` | 4.5: replays cost no signature check and no rate token |
| `CheckVerdict.soft` makes a refusal quiet; only `invalid` offers reach `onError(peerId, reason, detail)` | `sync/datasets.js`, `sync/antientropy.js` | 4.5, the cast, relay and pex check functions |
| `onAccept` receives the same record object that `check` saw | `sync/datasets.js` | 5.6: the router's verified-once `WeakSet` (without it the LSDB verifies again: correct, slower) |
| `LwwDataset.remove` leaves a floor, `forget` drops it, `pin` protects a key | `sync/datasets.js` | 5.6 expiry, 8.3 receipt sweep |
| `LogDataset` refuses new streams when full and never evicts one; `streams()`, `topOf()`, `range()`, `dropStream()` exist | `sync/datasets.js` | 8.1 stream slots, join backfill, the `n` counter |
| A record is at most 64 KiB of canonical JSON (`SyncWire.MAX_RECORD`) | `sync/antientropy.js` | a cast with a 16 KiB body, a 256-link LSA and a 16-address peer record all fit |
| Packets for a dataset the node does not run are counted, not faults | `sync/antientropy.js` | nodes with different service sets can still link (7.1 step 6 makes this rare) |
| `Lsdb.upsert` tests staleness before the signature, never installs our own origin, reports `own-origin-newer` with `seq`; `highestSeq` is 0 when nothing is known; our own LSA ages and is kept alive by `setLocal` | `core/routing/lsdb.js` | 5.6 |
| `computeRoutes` returns `path` from this node to the destination inclusive, and iterates nearest first | `core/routing/spf.js` | 5.6, `GET /topology/routes` |
| An unmeasured `LinkMetric` costs the maximum; the handshake RTT is fed in as the first sample | `core/routing/metric.js` | 5.4 link up |
| `validateConfig` accepts timers down to 1 ms, port 0 for `listen.port` and `api.port`, `peers.target` 0, and an IPv4 `discovery.multicast.interface` | `core/config.js` | 10.2 `FAST_TIMERS` and cluster defaults |
| `Identity.toSecret()` returns `{ signSeed, linkPrivate, e2ePrivate }`, three 32-byte keys | `core/crypto/identity.js` | 3: the 96-byte keystore secret |
| `EventBus.emit` refuses data that is not plain JSON (class instances such as `Buffer`, non-finite numbers) | `core/events.js` | 1: event data conventions |
| `AppendLog` records are at most 8 MiB, `JsonFile` documents 64 MiB | `vault/store.js` | 5.7 and 8.3 keep packet bodies in blobs, not in logs |
