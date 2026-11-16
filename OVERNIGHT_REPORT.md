# Overnight report: ClawNet

Branch `claude/overnight-mesh-engine`, 16 November 2026. `main` is untouched.

The short version: this repository held a marketing and community website and no
networking code. It now also holds a working peer-to-peer engine under [`clawnet/`](clawnet/README.md),
with a console, that passes 1,182 tests on one machine over loopback. It has never run
between two machines.

## 1. Original repository condition

- A React 18 / Vite 7 / Tailwind / Supabase single-page site ("ProjectClawNet"): landing
  page, community hub, missions, admin dashboard, tool pages. About 19,500 lines.
- "ClawNet Core", "ClawView" and "PortLock" existed only as animated SVG demos on the
  tool pages. There was no engine, no protocol and no Three.js anywhere in the repository.
- `npm test` printed "Tests coming soon" and exited 0.
- The pre-commit hook ran `npm audit`, which failed on a moderate advisory, so no commit
  could pass the repository's own hook.
- `netlify.toml` pinned Node 18, which Vite 7 cannot run on.
- The site built and linted (0 errors, 23 warnings).

The owner has since confirmed that the website is a separate project kept here as a
backup, and that no other repository holds earlier ClawNet engine code (all 35
repositories on the account were checked).

## 2. Major architectural findings and decisions

- **Everything ClawNet lives under `clawnet/`** with its own `package.json`. Nothing there
  imports from the website, so the directory can move to its own repository unchanged.
- **Zero runtime dependencies** in the engine: Node.js 22 or later, `node:` built-ins only.
  The console (`clawnet/console`) depends on React, Three.js and Vite and nothing else.
- **No invented cryptography.** Links use Noise XX (XXpsk0 with a network key); end-to-end
  messages use Noise X plus an Ed25519 signature over the handshake hash and the content;
  primitives are X25519, ChaCha20-Poly1305, SHA-256 and Ed25519 from OpenSSL via
  `node:crypto`.
- **Signed link-state routing**, chosen because the same database gives every node the
  topology the console draws. Gossip push plus anti-entropy pull synchronises it.
- **The design was reviewed before the networking layers were built**, by two independent
  reviewers (cryptography; distributed systems). They found real problems. The 27 changes
  adopted are section 15 of [`clawnet/docs/DESIGN.md`](clawnet/docs/DESIGN.md).

## 3. Features implemented

| Area | State |
| --- | --- |
| Cryptographic node identities | Built. Ed25519 identity; separate X25519 link and e2e keys bound by one signature. |
| Authenticated peer connections | Built. Noise XX / XXpsk0, identity-card checks, allow and block lists. |
| End-to-end encrypted messaging | Built. Forwarders cannot read or forge; sender is signed. |
| Multi-hop forwarding | Built and tested through an intermediate node. |
| Adaptive routing | Built. Cost follows measured round-trip time; routes move when a link slows or dies. |
| Peer discovery | Built: bootstrap peers, peer exchange, signed LAN multicast beacons. Multicast has only run on the loopback interface. |
| Offline message queue | Built. Persisted outbox; survives a restart of the sender. |
| Connection recovery | Built. Jittered backoff redial, per-address dial budget. |
| Duplicate suppression | Built at two levels (forwarder, recipient); replay cache persisted. |
| Gossip synchronisation | Built (ClawSync). |
| Broadcast channels | Built (ClawCast), optional channel keys. |
| Encrypted file transfer | Built (ClawVault): chunked, resumable, SHA-256 verified. |
| Topology visualisation and live monitoring | Built (ClawView), driven only by what the node reports. |
| Diagnostics | Built: end-to-end ping, traceroute, counters, event stream. |
| Control API and CLI | Built. `clawnet devnet` starts several local nodes. |
| Relay infrastructure | Partly. Every node forwards. **Mailbox custody (store-and-forward through a relay) is designed but not built.** |

## 4. Files created and modified

152 files changed, about 77,900 lines added, on this branch.

- Created under `clawnet/`: engine source 29,700 lines; tests 31,000 lines (38 unit, 10
  integration, 3 end-to-end test files); console source 3,900 lines; documentation 6,900
  lines (`README`, `DESIGN`, `ARCHITECTURE`, `PROTOCOL`, `API`, `THREAT_MODEL`,
  `OPERATIONS`).
- Created: `.github/workflows/clawnet.yml`, `.gitattributes`, this report.
- Website files modified, all tooling: `package.json` (a dependency override so the hook
  passes; real test scripts; Node engine), `netlify.toml` (Node 22), `eslint.config.js`
  (rules for `clawnet/`), `.gitignore`, and one section added to the root `README.md`.
  No website page or component was changed.

## 5. Bugs discovered and fixed

- The pre-commit hook could not pass (`npm audit`): fixed with a scoped dependency override.
- Netlify pinned a Node version the build tool does not support: now Node 22.
- Found by design review and fixed before or during the build:
  - a private-network handshake that revealed a node's identity to non-members;
  - replay protection that anyone who saw a message id could defeat;
  - cast ciphertexts that a non-member could re-sign as its own;
  - a routing rule that let one member pin others into a forwarding loop;
  - peer records that could make the whole network dial a victim's address.
- Found during the build: the sender signature covered only the handshake hash, so the
  holder of a recipient's key could have swapped a genuine message's content. It now covers
  the content too.
- Found by CI after everything passed locally:
  - the CLI could not resolve a shortened node id for a peer that was offline or briefly
    missing from the topology, even with a conversation open with it (fixed in the code);
  - two file-transfer tests gave up before real disk work had finished on a slow runner;
  - a shutdown test assumed the order of events on the stream;
  - an end-to-end test sent a message before the destination's identity card had arrived.
- A test that passed or failed depending on which of two random records hashed higher.
- An atomic file replace that could fail with `EPERM` on Windows under load.
- A race in the refused-peer integration test.

## 6. Tests executed and their results

On this machine (Windows 11, Node 26), run by the orchestrator, not just reported by the
agents that wrote the code:

- `npm test` in `clawnet/`: **1,186 tests, 1,182 pass, 0 fail, 4 skipped**, twice in a row,
  about 25 s per run. The skips are POSIX-only permission checks and a symlink check.
- The Noise implementation passes published test vectors (cacophony and snow) for XX,
  XXpsk3 and X, message by message.
- `npx eslint clawnet`: 0 errors, 0 warnings.

On GitHub Actions, the last code change (`0f3d27c`) passed everything: lint, the console
build, and the full suite on Linux, Windows and macOS with Node 22 and 24. It took four
runs to get there. The first runs on the finished product failed on machines slower than
this one, in ways the local runs never showed; section 5 lists what they found.

## 7. Build and runtime verification

- The console builds (`npm run build` in `clawnet/console`) with no warnings.
- A five-node ring devnet was started as five separate processes on `127.0.0.1`. Through
  the console of one node, in the desktop app's built-in browser: the topology matched the
  ring, a message sent from one console appeared in another's, a file transfer completed,
  and the topology changed when nodes were stopped. Screenshots were taken.
- The end-to-end tests start three node processes through the CLI and pass a message from
  the first to the third through the second.
- The website still builds (`npm run build`) and lints as before.

## 8. Git commits created

21 code commits, from `9c9d220` (repair the commit hook and build toolchain) to `0f3d27c`
(the last of three fixes CI prompted), plus the commits that add and update this report. `git log main..claude/overnight-mesh-engine` lists them; each is one logical unit
(crypto, wire, routing and sync, storage, transport, discovery, forwarding, node runtime,
casts and files, API and CLI, console, docs).

## 9. Changes pushed

Everything is pushed to `origin/claude/overnight-mesh-engine`. Nothing was pushed to
`main`, nothing was force-pushed, and no pull request was opened.

## 10. Remaining issues

- **No independent code review of the transport, node runtime, API or console.** The
  design was reviewed twice and the routing module once; the other foundation modules were
  self-reviewed by the engineers who finished them. A planned final review was not run
  because the usage ceiling for this session was reached.
- The private-network handshake (XXpsk0) has no published test vector in either source. It
  is cross-checked against the specification only.
- The CLI has no commands for channels or file transfer yet. The API and console do.
- A node's identity card travels by peer exchange and can arrive a moment after a route
  to it exists. Until it does, sending to that node fails with `unknown_destination`
  rather than waiting.
- CI found five timing assumptions in the tests in its first runs. The suite is green
  now, but it has only been run a handful of times on slow machines; more may surface.
- If two nodes dial each other at almost exactly the handshake timeout apart, both links
  can close; the redial recovers.
- While a peer is being throttled its keepalives are not read, so its link cost rises.
- The replay cache is bounded: a flood of valid messages from many identities can evict
  older entries before they expire.
- The website's `package-lock.json` is still gitignored, so its builds are not reproducible.

## 11. Known limitations

- **Single machine only.** Every test uses `127.0.0.1`. No two machines have exchanged a
  packet, real LAN multicast has not been exercised, and there is no NAT traversal.
- No forward secrecy for stored messages; identity cards cannot be rotated or revoked;
  channel keys cannot be rotated; sender anonymity is not provided; open networks have no
  defence against one participant creating many identities beyond per-origin caps.
- Link-state routing stores every node's advertisement on every node: suitable for tens to
  low thousands of nodes.
- The console was checked in one Chromium-based browser. Reduced-motion and the fallback
  for missing WebGL exist in code but were not exercised in a browser.
- Nothing here has had an external security audit. [`clawnet/docs/THREAT_MODEL.md`](clawnet/docs/THREAT_MODEL.md)
  says what each kind of attacker can and cannot do.

## 12. Running it

Requires Node.js 22.12 or later. The engine needs no install step.

```bash
cd clawnet
npm test                                   # the whole suite

cd console && npm install && npm run build # once, to build the console into clawnet/ui
cd ..
node bin/clawnet.js devnet --nodes 5 --topology ring
```

`devnet` prints, for each node, a console URL with its token in the fragment. Open one.
From another shell, against any node's data directory (the path is printed):

```bash
node bin/clawnet.js --data-dir <dir>/node-0 status
node bin/clawnet.js --data-dir <dir>/node-0 topology
node bin/clawnet.js --data-dir <dir>/node-0 send <id-prefix> hello
node bin/clawnet.js --data-dir <dir>/node-2 inbox <id-prefix>
node bin/clawnet.js --data-dir <dir>/node-0 trace <id-prefix>
```

A node that listens beyond loopback will cause a firewall prompt on Windows; devnet never
does. Single-node start-up, configuration and running as a service are in
[`clawnet/README.md`](clawnet/README.md) and [`clawnet/docs/OPERATIONS.md`](clawnet/docs/OPERATIONS.md).

## 13. Recommended next priorities

1. Run it between two real machines on a LAN, then across the internet through a
   publicly reachable node. This is the largest unverified claim.
2. An independent security review of `core/transport/secure-channel.js`, `core/node.js`
   and `gate/api-server.js`.
3. Obtain or generate an independently verified vector for XXpsk0, or switch private
   networks to a pattern that has one.
4. Build mailbox custody, so peers that are never online together can exchange messages.
5. CLI commands for channels and files; identity-card rotation; channel-key rotation.
6. Decide whether the engine should move to its own repository.
