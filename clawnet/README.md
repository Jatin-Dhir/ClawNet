# ClawNet engine

ClawNet is a peer-to-peer overlay network written in Node.js with no runtime dependencies.
Nodes find each other on a LAN or through configured addresses, authenticate each other with
public-key identities, and exchange end-to-end encrypted messages, broadcast channels and
files, with nodes in the middle forwarding what they cannot read. Each node has a local HTTP
control API and a browser console (ClawView) that show what the node actually does and nothing
else.

This directory holds the engine, its tests, its documentation and the console. The website in
the repository root is a separate project that shares the repository; nothing here imports
from it.

## What works today

- **Links.** Authenticated, encrypted TCP links between nodes (Noise `XX`, or `XXpsk0` with a
  network key), with keepalive, round-trip measurement, redial with backoff and duplicate-link
  resolution.
- **Discovery.** Bootstrap addresses, peer exchange through signed peer records, and signed LAN
  multicast beacons.
- **Routing.** Signed link-state routing with route costs that follow measured link quality,
  multi-hop forwarding, and recovery from cut links and partitions through ClawSync
  anti-entropy.
- **Messages.** End-to-end encrypted, acknowledged chat messages that survive restarts, are
  retried for up to 7 days, and are delivered once.
- **Channels (ClawCast).** Named broadcast channels, public or encrypted with a shared key,
  flooded and synchronised through every node.
- **Files.** Encrypted file transfer with receiver-driven flow control, resume after an
  interrupted link, and whole-file SHA-256 verification before the file appears.
- **Diagnostics.** Ping, traceroute and counters across the network.
- **Control API and console.** A bearer-token HTTP API on loopback with a live event stream,
  the `clawnet` command line, and a React console with a 3D topology map, built from
  `console/` into `ui/`.
- **Devnet.** `clawnet devnet` starts several real nodes, as separate processes, on one
  machine.
- **Phones, through a web app.** `clawnet start --phone` lets a phone on the same Wi-Fi
  join as a node of its own: the computer serves a web app (Safari on iPhone, Chrome on
  Android) and accepts its links over WebSocket. The phone has its own keys and sends and
  receives end-to-end encrypted messages while the app is open. Off by default; see "A
  phone on your Wi-Fi" below.

Not built: the mailbox (custody) service, which would hold messages for offline nodes
(it is designed in `docs/ARCHITECTURE.md` section 8.3; until it exists, a message to an
offline node waits in the sender's outbox); NAT traversal; command-line commands for channels
and file transfer (use the API or the console); changing a passphrase or rotating an identity.

## What has been verified, and what has not

**Demonstrated.**

- Unit tests of most modules, including hostile and malformed input (about 1,300 tests). The
  link-state router has no unit tests of its own; it is exercised through real nodes.
- The phone's browser code against the engine: published Noise vectors, a `Noise_XXpsk0`
  handshake byte-identical to the engine's, cross-checks of every encoding and check, and
  interoperability tests in which that code, run under Node, links to real nodes over
  WebSocket and exchanges messages both ways. The app itself was clicked through in a
  Chromium browser at phone size against nodes on the same machine.
- **The phone app on a real phone, once.** On 18 November 2026 the owner set it up on their
  iPhone over their home Wi-Fi, against a node on their PC: it linked, and a message went
  each way, the reply acknowledged by the phone.
- Integration tests that start several real nodes in one process, joined by real TCP sockets
  on `127.0.0.1`, through a loopback proxy that adds latency, cuts links and records the bytes
  on the wire. They check, for example, delivery across partitions, rerouting around failures,
  exactly-once delivery across restarts, and that no message text or file bytes appear in the
  recorded traffic.
- End-to-end tests that start separate operating-system processes through the `clawnet`
  command and the HTTP API, including `devnet`.
- A CI workflow (`.github/workflows/clawnet.yml`) that runs the test suite on Ubuntu, Windows
  and macOS runners with Node 22 and 24, and lints. Its run for the commit "Node runtime and
  multi-node integration tests" passed on all six runner and Node combinations and on lint.
  The command line, control API, channels, file transfer and console were added after that
  commit; this was written before CI had run on them, so check the workflow's latest run
  rather than relying on this paragraph.
- The commands in this file and in `docs/OPERATIONS.md` were run by hand on one Windows 11
  machine with Node 26.12 (a version outside the CI matrix).
- `Noise_XX`, `Noise_X` and the canonical JSON encoding agree with published or shared test
  vectors (`test/vectors/`).

**Not demonstrated.**

- **Any two computers talking to each other.** Every test, and every command above, ran on
  one machine over loopback. The only traffic between two devices recorded here is the one
  phone try above.
- **Real LAN multicast.** The beacon code is tested with a fake datagram socket; no test has
  sent a multicast datagram.
- **NAT.** Not supported and not tested.
- **The `XXpsk0` handshake against published vectors.** Private networks use it; no published
  vector for it exists. It is built from parts that are verified, and a hand-written copy of
  the specification agrees with it, which shares the author's reading of the specification
  (`docs/PROTOCOL.md` section 3.5).
- **An external security audit.** None has been done (`docs/THREAT_MODEL.md`).
- Behaviour on Linux or macOS beyond what the CI runs show, and a real Ctrl+C in a console.
- Any property of the console in Firefox or Safari, or on a phone.
- **The phone app beyond that one try.** Not on Android, not on another iPhone, not with
  a phone linked to one computer and messaging a node on another, and no hostile case.

## Requirements

- Node.js 22.12 or later.
- Nothing to install for the engine. Building the console needs `npm install` in `console/`
  (React, three and Vite; they are not needed to run a node).

## Quick start

All of these were run from this directory (`clawnet/`) in a POSIX shell (Git Bash on
Windows). Replace `<dir>` with a directory of your choice.

**A single node.**

```
node bin/clawnet.js --version
node bin/clawnet.js -d <dir> init --no-passphrase
node bin/clawnet.js -d <dir> start --listen 127.0.0.1:0 --api-port 0 --no-multicast
```

`init --no-passphrase` leaves the keystore unencrypted (use `--passphrase-file <file>` for a
real node). `start` runs in the foreground and prints one line when ready:

```
{"event":"ready","nodeId":"rg2z...fuhga","listen":"tcp://127.0.0.1:56902","api":"http://127.0.0.1:56903","phone":{"websocket":null,"webapp":null},"dataDir":"..."}
```

In another shell:

```
node bin/clawnet.js -d <dir> status
node bin/clawnet.js -d <dir> stop
```

**Three nodes on this machine.** `devnet` makes a temporary directory, initialises and starts
the nodes (all listeners on `127.0.0.1`, no multicast) and waits until every node has a route
to every other:

```
node bin/clawnet.js devnet --nodes 3 --base-dir <dir>
```

It prints each node's short id, its peer address, its process id and a console URL such as
`http://127.0.0.1:50483/#token=<64 hex characters>`. Leave it running; use another shell.

**Send a message.** Use a node's data directory (`<dir>/node-0`) and another node's id (the
short id from the devnet output, at least 8 characters):

```
node bin/clawnet.js -d <dir>/node-0 send <id-of-node-1> hello
node bin/clawnet.js -d <dir>/node-1 inbox
node bin/clawnet.js -d <dir>/node-0 ping <id-of-node-1>
node bin/clawnet.js -d <dir>/node-0 trace <id-of-node-1>
```

The message shows in node 1's inbox as `received` and in node 0's as `delivered`.

**Send a file.** There is no command for it yet; use the HTTP API. Each node's API address is
in its `runtime.json` and its token in `api-token`. With `A` and `B` the API addresses and
`TA` and `TB` the tokens of nodes 0 and 1, and `ID1` the full id of node 1 (from
`GET /api/v1/identity`):

```
curl -s -X POST -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
     -d "{\"to\":\"$ID1\",\"path\":\"/path/to/file\"}" $A/api/v1/files
curl -s -H "Authorization: Bearer $TB" $B/api/v1/files
curl -s -X POST -H "Authorization: Bearer $TB" $B/api/v1/files/<transfer-id>/accept
```

The receiver's default is to ask, so the transfer waits in state `offered` until it is
accepted; the file then appears in `<dir>/node-1/downloads/`. A 3 MB file sent through the
API this way arrived with the same SHA-256 (compared by hand). The same works in the console's Files view.

**The console.** `ui/` holds a built console. To rebuild it:

```
cd console && npm install && npm run build
```

(The build was run for this document; `npm install` was not, because the dependencies were
already installed.) Then open a node's console URL, from the devnet output or from
`node bin/clawnet.js -d <dir>/node-0 ui`, in a browser. The token after `#` is read once and
removed from the address bar. Anyone who has that URL controls the node.

**Stop the devnet.** `node bin/clawnet.js -d <dir>/node-0 stop` (and `node-1`, `node-2`);
`devnet` exits when the last node has stopped.

**A phone on your Wi-Fi.** Start a node with phone support:

```
node bin/clawnet.js -d <dir> start --phone
```

It prints, on standard error, the addresses a phone can open, such as
`http://192.168.1.20:47490/`. Windows may ask whether Node.js may use the network: allow
it on private networks. On the phone, on the same Wi-Fi, open that address; on an iPhone,
add it to the home screen first (Share, Add to Home Screen) and set it up from there. The
phone creates its own identity, links to the computer and lists the nodes it can reach.
Send it a message from the computer with `send <phone's id> hello` (its id is under "This
phone" in the app); its replies show in `inbox`. Limits: it works only while the app is
open, only through a computer on the same Wi-Fi, and the page arrives over plain HTTP, so
use it on a network you trust. If the phone cannot open the address, the usual causes
(Windows treating the Wi-Fi as a public network, a guest network, a firewall rule refused
earlier) are listed in `docs/OPERATIONS.md` section 6a; the security limits are in
`docs/THREAT_MODEL.md` section 3.7.

**The tests.**

```
npm test
npx eslint clawnet      # from the repository root
```

`npm test` runs `node --test` over `test/unit`, `test/integration` and `test/e2e`; it takes
about half a minute and every test binds `127.0.0.1` with port 0. The test and lint figures
change as the code does, so they are not recorded here.

## Module map

| Directory | Responsibility |
| --- | --- |
| `src/core/crypto/` | identities, Noise handshakes, sealed messages, signatures, primitives over `node:crypto` |
| `src/core/wire/` | canonical JSON, packet codec, schema validators, protocol constants |
| `src/core/transport/` | TCP, the WebSocket server for browsers (RFC 6455), and the secure channel (Noise handshake, records, send scheduling) |
| `src/core/peer/` | the peer manager (links, admission, keepalive, redial) and the address book |
| `src/core/discovery/` | LAN beacons, bootstrap, peer exchange, dial budgets |
| `src/core/routing/` | link-state database, shortest paths, link metric, the forwarder |
| `src/core/messaging/` | reliable end-to-end messages, duplicate suppression, chat conversations |
| `src/core/diag/` | ping, traceroute, counters |
| `src/core/node.js` | `ClawNode`: wires every module, runs services, owns the timers and the router |
| `src/core/config.js`, `events.js`, `storage.js` | configuration, the event bus, storage under the data directory |
| `src/sync/` | ClawSync: gossip and anti-entropy for signed records |
| `src/cast/` | ClawCast: broadcast channels |
| `src/vault/` | ClawVault: keystore, durable stores, encrypted file transfer |
| `src/gate/` | ClawGate: the control API and console server (`api-server.js`) and the phone web app server (`webapp-server.js`); the relay and mailbox service is not built |
| `src/integrations/` | a verifier for signed security events from PortLock, a separate project; not used by the node |
| `src/services.js` | the services a node starts by default |
| `src/cli/`, `bin/clawnet.js` | the `clawnet` command and the devnet launcher |
| `console/` | ClawView source (React, three, Vite); builds into `ui/` |
| `web/` | the phone web app: `app/` (the page), `core/` (a browser node, a second implementation of identities, Noise, links, sync and messages), `vendor/` (the noble cryptography libraries, pinned); see `web/README.md` |
| `scripts/` | vendoring the noble libraries, drawing the app's icons |
| `test/` | `unit/`, `integration/` (real nodes over loopback), `e2e/` (separate processes), `helpers/`, `vectors/` |

## Limitations

The security limitations are listed without softening in `docs/THREAT_MODEL.md`. The ones to
know first:

- No anonymity; forwarders see who talks to whom.
- Sealed messages have no forward secrecy.
- A channel key cannot be rotated and members cannot be removed.
- A stolen key cannot be revoked; identities have no expiry.
- Open networks have no defence against one party creating many identities.
- Wall clocks must agree within 5 minutes or nodes cannot route to each other.
- Keys are protected by a passphrase you choose, or by file permissions only.
- Every node stores every link-state record, which suits tens to low thousands of nodes.
- Mailbox custody is not built; there is no NAT traversal; no code has had an external review.
- A phone is a node only while its app is open, only through a computer on the same Wi-Fi,
  and its app arrives over plain HTTP; its keys live in that phone's browser storage, with
  no backup.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | the design decisions and why; section 15 records the changes adopted after design review and wins over everything else |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | modules, signatures, bounds, events and flows, with a status table of what is built |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | the wire-level reference |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | assets, adversaries, what the design does and does not defend |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | data directory, configuration, running, backup, upgrading, troubleshooting |
| [`docs/API.md`](docs/API.md) | the local control API and event stream |
| [`console/README.md`](console/README.md) | building and developing the console |
| [`web/README.md`](web/README.md) | the phone web app: how it is built, served and tested |
| [`web/vendor/README.md`](web/vendor/README.md) | the vendored cryptography: versions, hashes, audits, how to update |
