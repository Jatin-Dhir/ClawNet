# ClawNet threat model

This document says what the engine in `clawnet/` defends, against whom, and what it does
not defend. It describes the design as it is built. Where something is designed but not
built, it says so, and it is not counted as a defence.

Read it with these facts in mind:

- **No external security audit has been done.** Two internal design reviews (cryptography,
  distributed systems) were run against `DESIGN.md` before the networking layers were
  written, and their changes are in `DESIGN.md` section 15. The code has been tested by its
  own authors' tests, on one machine at a time, over loopback.
- **Nothing here has been tested between two machines**, on a real LAN, through a NAT or
  against a real hostile network. The tests include hostile-input cases (malformed frames,
  forged cards, wrong keys, hostile file names), but they are written by the same people who
  wrote the code.
- **The handshake `Noise_XXpsk0` used by private networks has no published test vector**
  (see `PROTOCOL.md` section 3.5). `Noise_XX` and `Noise_X` are checked against published
  vectors.
- Cryptographic primitives are OpenSSL's, through `node:crypto`: X25519, Ed25519,
  ChaCha20-Poly1305, SHA-256, HMAC-SHA256, HKDF-SHA256, and scrypt for the passphrase. The
  engine composes them as Noise patterns and signed, domain-separated messages. It does not
  implement any primitive itself.

## 1. What the engine protects

| Asset | What it is |
| --- | --- |
| Identity keys | The Ed25519 identity key and the two X25519 keys, in `keystore.json`. Whoever holds them is the node. |
| Message and file contents | Chat text, file bytes, and the text of encrypted channels. |
| Metadata | Who talks to whom, when, how much; which nodes exist and how they are connected. |
| Availability | That messages and files get through, and that a node stays responsive. |
| The control API token | A bearer secret in `api-token`. Whoever holds it controls the node (`API.md` section 3). |
| The network key | An optional shared secret that admits a node to a private network. |
| The data directory | Everything above at rest, plus received files. |

## 2. Trust assumptions

- The machine a node runs on, and the user account it runs as, are trusted. The engine does
  not defend against a user who can already read the process's memory or the account's files
  (section 3.6 covers someone who has only the files).
- The operating system's random number generator is good. All keys and nonces come from it.
- Node's `node:crypto` (OpenSSL) is correct.
- Clocks of nodes agree within `limits.maxClockSkewMs`, 5 minutes by default. This is a
  security assumption, not only a convenience: link-state freshness, handshakes, message
  timestamps and beacons are checked against wall-clock time.
- Identity is the key. A NodeId is self-certifying: there is no directory, no certificate
  authority and no way to look up out of band who a NodeId belongs to. If you need to know
  that a NodeId is a particular person's, you must compare it through some other channel.

## 3. Adversaries

For each adversary: what they can do, then what they cannot, given the engine as built.

### 3.1 Passive network observer

Someone who can read packets on a link between two nodes, or on a LAN, and cannot change
them.

**Can:**

- See that two IP addresses exchange TCP traffic, when, how much, and in what rhythm. The
  engine adds no padding and no cover traffic. Keepalives every 10 seconds make a link
  visible even when idle.
- Recognise ClawNet traffic: the handshake has a fixed structure (three length-prefixed
  messages; the first is a bare 32-byte public key) and nothing hides it.
- On a LAN, read every beacon, which is signed but **not encrypted**. A beacon reveals a
  node's NodeId, its identity card (public keys), the network id and its TCP port, and that
  the node is on this LAN at this IP address. A network key adds a MAC to beacons; it does
  not hide their content.
- Estimate message and file sizes from packet sizes, and tell file transfers from chat from
  their volume.

**Cannot:**

- Read the contents of anything sent over a link. Link traffic is Noise `XX` (or `XXpsk0`):
  ChaCha20-Poly1305 under keys from an ephemeral X25519 exchange. The handshake payload
  (identity card, listen addresses, agent, capabilities) is sent encrypted.
- Read message or file content that crosses a link, even in principle, because it is also
  sealed end to end to the destination.
- Decrypt recorded traffic later using a stolen link key: the link keys are ephemeral. They
  **can** decrypt recorded *end-to-end sealed messages* if they later obtain the recipient's
  e2e key (section 5, "no forward secrecy").

Tests record the bytes on proxied loopback links and check that no message text, file
bytes, NodeIds or card fields appear (`test/integration/links.test.js`, `messaging.test.js`,
`files.test.js`, `cast.test.js`). That demonstrates the absence of obvious plaintext on
loopback. It is not a traffic-analysis result.

### 3.2 Active network attacker

Someone who can also inject, drop, delay, reorder and replay packets, and can connect to
any listening node.

**Can:**

- Cut or delay links, send TCP resets, and so deny service to the nodes behind them.
- **Eclipse a node** that has few links or a single bootstrap address. A node dials the
  address it is given and accepts whichever authenticated node answers: dialling does not
  pin the NodeId that is expected at an address. An attacker who controls a node's
  connectivity can supply only attacker-controlled peers. Such an attacker can then drop,
  delay or withhold everything, and can withhold other nodes' routing records. It still
  cannot forge them or read sealed content.
- Connect to any node and complete a handshake as a member of a public network. On a network
  **without a network key**, the responder's identity card, capabilities, listen addresses
  and agent string are sent in the second handshake message, so anyone who can reach the
  port can read them by connecting. That information is also public through gossip, but this
  also means anyone can confirm that a ClawNet node listens at an address. With a network
  key this fails on the first message, and nothing about the responder is sent.
- Hold open handshakes. The cost is bounded: at most 32 inbound handshakes in progress, 4
  per source IP, each with a 10 second deadline.
- Spoof LAN beacons. Each costs the victim a rate-limited dial attempt that ends at the
  authenticated handshake. A recorded real beacon can be replayed until its timestamp leaves
  the clock-skew window.
- Attack through the clock: a node whose clock is moved more than the skew from its
  neighbours' (for example through a spoofed time source) will fail handshakes
  (`clock-skew`) and reject their link-state records, and so be cut off.

**Cannot:**

- Read or modify link traffic undetected, or splice in records: Noise's implicit nonces make
  any dropped, replayed, reordered or altered record fail authentication and close the link.
- Impersonate a node whose NodeId you know. A link's peer proves possession of the link key
  that its identity card binds, by signature, to the identity key the NodeId encodes.
- Man-in-the-middle an end-to-end message. Sealing uses the destination's card, which is
  self-certifying and arrives in a signed record; the sender is authenticated by an identity
  signature over the handshake hash and the content.
- Downgrade anything. There is one protocol version. A node with a network key and a node
  without one simply fail to complete a handshake.
- Replay a sealed message to cause a second delivery: the recipient keeps a persisted
  seen-cache for the whole message lifetime.
- Forge or replay link-state records beyond the freshness window (section 5, "clocks").

### 3.3 Malicious member

A node that can complete the handshake (it holds the network key if there is one, and is not
blocklisted), with a valid identity, which may run modified software.

**Can:**

- See all link-state records and peer records, and so the whole topology it is told about,
  and the identity cards of all nodes.
- Read every cast on every **public** channel. Casts are flooded to every node and every
  node stores them; the body of a public channel is plaintext in the record. Only encrypted
  channels hide content from non-members, and then only from nodes without the channel key.
- Lie about its own links and capabilities. It cannot lie about anyone else's: a link is used
  only when both ends advertise it, and a record is signed by the node it describes.
- Flood. Rate limits bound what it costs the network: per-peer packet and byte budgets,
  `limits.castPerOriginPerMin` casts per origin (about 60 per minute per channel, in 16
  channels, plus a start-up burst), a limit on new origins one neighbour may introduce per
  minute, caps on every per-origin table, and a 25 ms batch and 5 s hold-down on gossip. The
  limits are bounds, not prevention; a determined member can use up its share of every one
  of them.
- Create many identities (a Sybil attack). **Open networks have no defence against this**
  beyond the caps. Many identities linked to one attacker can fill the tables, occupy peer
  slots, fill the cast stream table (streams of channels a node has joined outrank the
  rest, so the table of a node only refuses new streams in channels it merely relays), and
  consume the pending-offer slots of a file receiver (8 per peer, 64 in total) so that a
  real offer gets `busy`. An unanswered offer is declined after 24 hours, so an attacker has
  to keep offering to hold the slots; nothing yet frees a slot for an honest sender sooner.
- Equivocate (publish two different records with one version) or clone another node's
  identity if it has stolen the keys. Both are detected and reported as events
  (`peer.equivocation`, `lsa.equivocation`, `discovery.clone_suspected`); neither is
  prevented.
- Publish undecryptable junk to an encrypted channel. Members cannot open it, but it is
  stored, takes rate budget and slots, and is reported (at most once a second) as
  `cast.rejected`.
- Offer files. A file is written only inside the downloads directory under a sanitised name,
  and with `files.accept = "ask"` (the default) only after the user accepts. With `"auto"`,
  a member can fill the disk up to `files.maxSizeBytes` (4 GiB default) per transfer: the
  engine does not check free disk space.
- As a **forwarder** (section 3.4).

**Cannot:**

- Read a sealed message or a file that is not addressed to it, or forge one from another
  node. It cannot make a node accept an old message again.
- Make a record appear to come from another origin: records are signed by their origin and
  every node checks it.
- Make a receiver write a file outside its downloads directory, or overwrite an existing
  file (names are sanitised, checked for containment and made unique).
- Attract routed traffic by understating its own link costs: the cost of a link is the larger
  of the two values its endpoints advertise.

### 3.4 Malicious forwarder or mailbox

A node on the path of a message, or one that offers to hold messages.

**As a forwarder it can:**

- Read the `DATA` header: destination, message id, hop limit, retry counter, and the packet
  size, and see the previous hop. It does not see the sender in the header, but it can
  usually guess who originated a packet from the topology. **Hiding the sender from
  forwarders is not a goal.**
- Drop, delay, or selectively black-hole traffic for a destination. There is no multipath
  and no way for a sender to tell a black hole from a slow route except that acknowledgements
  do not come back; the sender keeps retransmitting along the same route. If the network has
  another route, the routing protocol finds it only when the forwarder's links stop being
  advertised.
- Replay a packet. It is dropped by forwarders that have seen it in the last 60 seconds and
  by the recipient's seen-cache afterwards.
- Spend other nodes' bandwidth with forged `PROBE` packets (`rsvp` is unauthenticated), up to
  the reply rate limits (20 per second in total, 5 per second per requester).

**As a forwarder it cannot:**

- Read or alter a message: the body is sealed end to end, and the destination and message id
  are in the Noise prologue, so a forwarder cannot re-address or re-label a ciphertext.
- Read the plaintext of a file chunk or learn a file's name or size.
- Truncate a message: the recipient rejects a body whose chunks do not add up to the length
  announced in the authenticated handshake.

**Mailbox.** The design includes mailbox custody. **It is not built.** A node can advertise
`caps.mailbox = true`, but no deposit protocol exists, so nothing is ever deposited with it
and nothing in this section applies. Do not set the flag: it advertises a service the engine
does not provide.

### 3.5 Local unprivileged user

Another user account on the same machine, with no access to the node's files.

**Can:**

- See that a node is running and which TCP, UDP and API ports it listens on.
- Connect to the peer port exactly as a remote attacker can (section 3.2), and to the API
  port. The API refuses requests without the bearer token (`401`), limits failed attempts to
  10 per second, and does not accept the token in a query string.
- If the machine is shared and the data directory permissions are wrong, read the token.

**Cannot:**

- Use the API without the token. The token is created with mode `0600` in a directory with
  mode `0700` on POSIX systems; the engine tightens loose permissions on an existing
  directory and file.
- Cause the node to act through a web page: `Host` is checked against an allowlist (defeats
  DNS rebinding), a cross-origin request is refused before the token is looked at, no CORS
  headers are sent unless configured, the token travels only in an `Authorization` header,
  and the console is served with a restrictive Content-Security-Policy.

**Not verified:** on Windows, POSIX modes do not exist. The token file and the keystore
inherit the access control list of the data directory, and the engine creates the directory
private only "by inheritance". This has not been checked with `icacls`. On Windows, put the
data directory under the user's own profile, which is where the default is.

**Holding the token is full control of the node**, including `POST /files`, which makes the
node read any file the node's user can read and send it to any node. The URL that
`clawnet ui` and `clawnet devnet` print contains the token after `#`; anyone who sees it (a
terminal scrollback, a screen share, a shell history) has full control for as long as the
token file is unchanged.

### 3.6 Someone who steals a data directory

A copy of the files in the data directory, with no running node and no access to the
original machine.

**Without a passphrase** (`init --no-passphrase`): the keystore holds the identity keys and
the storage key in the clear (base64). The thief becomes the node: can sign as it, read every
sealed file, and decrypt recorded end-to-end messages addressed to it. The keystore is
protected by file permissions only, and `init` prints a warning.

**With a passphrase:** the keystore is ChaCha20-Poly1305 under a key from scrypt
(`N = 2^17, r = 8, p = 1`, about 128 MiB per attempt), with the parameters bound into the
associated data. The thief must guess the passphrase offline; the strength of the passphrase
is the only protection. Without it they cannot read the identity keys or any sealed file
(the outbox, conversations, seen ids, channel keys and history, transfer state).

**Either way, these files are not encrypted:**

- `peers.json`, `peer-records.json`: addresses and NodeIds of nodes this node knows, which is
  a record of who it connects to.
- `network-id`, `state.json`, `lsdb-seqs.json`, `runtime.json`, `lock`.
- `config.json`, which holds `networkKey` if you put it there, which admits the thief to a
  private network.
- `api-token`: useful only with access to the API port.
- The downloads directory: received files are ordinary files.
- Files read by `POST /files` are not copied into the data directory.

**Cannot:** use the stolen directory to read other nodes' traffic, and cannot read messages
the node never received. A stolen identity cannot be revoked (section 5).

## 4. What the tests demonstrate

All of this ran on one machine over loopback, in automated tests, and in CI on Linux,
Windows and macOS runners (see `README.md` for what CI has and has not run):

- Wrong network id, wrong network key, a tampered or forged card, a blocklisted node and a
  self-dial are refused (`links.test.js`, `node.test.js`).
- Malformed frames and packets close the link with `protocol` and the peer is refused for a
  period (`links.test.js`).
- Traffic beyond the routed budget is dropped without disconnecting; control traffic keeps
  flowing (`links.test.js`).
- Recorded wire bytes on proxied links contain no plaintext of messages, files or casts
  (`links.test.js`, `messaging.test.js`, `files.test.js`, `cast.test.js`).
- Retransmissions and replayed packets are delivered exactly once, including across a
  restart (`messaging.test.js`, `node.test.js`).
- A re-signed cast ciphertext is refused by members, and a node without the channel key
  relays an encrypted cast it cannot read (`cast.test.js`).
- Hostile file names cannot escape the downloads directory (`files.test.js`).
- A changed source file aborts a transfer (`files.test.js`).
- The API refuses requests without a token, with a foreign `Host`, and with a foreign
  `Origin`, and rate-limits failed authentication (`api.test.js`, `gate-api-server.test.js`).
- Unit tests of each validator, codec, signature check and rate limiter, with hostile input.

It does **not** demonstrate resistance to a real attacker. In particular there is no test
that runs hostile software against a node, no fuzzing run beyond the unit tests'
hand-written cases, no timing-side-channel test, and no test of any property across two
machines.

## 5. Limitations, without softening

These are properties of the design as built. Each is a place where someone could reasonably
expect protection that is not there.

1. **No anonymity.** A forwarder or an observer learns who talks to whom. The sender is not
   named in packet headers, but the topology usually gives it away. A global observer can
   correlate traffic. This is a non-goal.
2. **No forward secrecy for end-to-end messages.** A sealed message uses the sender's and
   the recipient's long-term e2e keys. Anyone who recorded the ciphertext and later gets the
   recipient's e2e private key can read it. (Link traffic does have forward secrecy.)
3. **A leaked channel key exposes the channel's entire stored history, and cannot be
   rotated.** There is no way to remove a member. To stop sharing with someone, abandon the
   channel and make a new one.
4. **Identity cards have no expiry or epoch.** A stolen link key or e2e key cannot be retired
   short of abandoning the identity and making a new one. There is no revocation.
5. **Open networks have no Sybil defence** beyond the caps on tables and rates. A network key
   restricts membership to those who hold the key, with no per-member revocation: if the key
   leaks, everyone must change it.
6. **Public channels are public.** Any node that relays them, which is every node, can read
   their text.
7. **A node accepts whoever answers an address.** Dialling does not pin the expected NodeId.
8. **Clocks matter.** Link-state routing freshness is checked against wall-clock time with a
   skew of 5 minutes by default. A node whose clock is wrong by more than that cannot route
   to or be routed to. A time source under an attacker's control is an attack surface.
9. **No resource accounting beyond rate limits and table caps.** A member can use its share
   of everything. The engine does not check free disk space for incoming files.
10. **Forwarding drops are silent.** A forwarder that drops packets is not detected or routed
    around except through the routing protocol noticing that its links are gone.
11. **The keystore is only as strong as its passphrase, or unprotected without one.** There is
    no hardware key storage, no memory locking and no protection of keys in a running
    process from the user or from the operating system.
12. **The API token is a long-lived bearer secret** with no expiry and no scopes. Rotating it
    means deleting the file and restarting the node.
13. **Mailbox custody is not built.** `caps.mailbox` and the `mailbox` configuration section
    do nothing useful. Messages to an offline node wait in the sender's outbox, which
    survives a restart, and are delivered when the destination returns; the sender must be
    running or restarted for that to happen.
14. **No NAT traversal.** A node behind a NAT is reachable only through connections it
    makes itself, and only by nodes that can reach one it is linked to.
15. **No audit.** See the start of this document.
16. **Everything above assumes the implementation matches the design.** The tests check many
    properties; they do not prove the absence of bugs. A cryptographic or parsing bug in this
    code would not be caught by an outside party, because none has read it.
