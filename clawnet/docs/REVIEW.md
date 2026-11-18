# Independent review of the upper layers

On 16 November 2026 two reviewers examined the upper layers of the engine: the peer
manager and secure channel, the messaging layer, discovery, casts, file transfer and the
parts of the node runtime that tie them together. They worked separately. One looked
through a **security** lens (what a hostile peer or member can do to a node), the other
through a **correctness** lens (what goes wrong without an attacker). Each reproduced what
it could with a throwaway program against the real code and said so where it only traced a
path.

Together they reported 11 findings: 1 critical, 1 high, 5 medium and 4 low. None was a
duplicate of another. The critical and the high finding were reproduced again with a test
before anything was changed; both were real. Each fix below comes with a regression test
that fails on the old code. **4 findings are fixed, 7 remain open, none was rejected.**

How to read the status column. *Fixed* means the scenario described no longer works.
*Open* means it still does, with the reason; where a change made it harder, the row says
what changed.

| Severity | Where | What is wrong | Status |
| --- | --- | --- | --- |
| Critical | `src/cast/channels.js`, `spacingProblem` | One cast record for a new stream with a huge counter (up to 2^53-1) made the rate check step down from the counter in jumps of 60, about 10^14 iterations, before the signature was read. Any linked peer could freeze a node's single thread for days with an unsigned record. | **Fixed.** The check now walks the records the stream actually holds (at most one retention window), and a stream with nothing held is not compared at all. Test: `cast-channels.test.js`, "a forged record with a huge counter...". |
| High | `src/vault/file-transfer.js`, `activateReceive` | If a node stopped or crashed while a fully received file was being hashed, the transfer came back after the restart still marked `verifying`, with older progress. It then rejected every chunk and ignored repeated offers until the seven-day expiry. | **Fixed.** A transfer found in `verifying` goes back to `receiving` and asks the sender for what it lacks; if every chunk is held it verifies again at once. Test: `file-transfer.test.js`, "a receiver stopped while it verifies...". |
| Medium | `src/core/transport/secure-channel.js`, BYE branch of `#deliver` | After a received BYE the channel ended its side of the socket but never destroyed it. A peer that sent BYE and then never closed its own side left the socket open for good, outside every limit and untouched by `stop()`, so it could leak one descriptor per connection. | **Fixed.** A remote BYE now arms the same linger timer as a local close, and the socket is destroyed when it runs out. Test: `transport-secure-channel.test.js`, "a peer that says BYE and never closes its socket...". |
| Medium | `src/core/peer/peer-manager.js`, `#runDial`; `src/core/node.js`, discovery dial | Addresses learned from peer exchange and beacons were dialed as if the operator had typed them, so the loopback and link-local check on what a DNS name resolves to was never applied. A member could publish a name that resolves to 127.0.0.1 or a metadata address and have other nodes connect to their own services. | **Fixed** for the restricted-address part: `connect()` takes `learned`, and the node passes it for everything except the operator's bootstrap list. Test: `peer-manager.test.js`, "a learned dial to a DNS name...". **Open:** each DNS name still has its own per-IP dial budget, so wildcard DNS gets around that limit; only the global 5 dials a second applies. `isRestrictedIp` in `tcp.js` also misses 240/4, NAT64 and 6to4 ranges that `address-policy.js` covers; the two classifiers should become one. |
| Medium | `src/core/messaging/reliable.js`, `SeenStore` | The replay cache is bounded. A member that sends as many messages as the cache holds, dated at the edge of the allowed clock skew, pushes out other senders' entries. A recorded message from someone else can then be replayed and delivered a second time. | **Open.** Reproduced by the reviewer. The suggested watermark would refuse every honest message dated before the attacker's messages for up to the clock skew, trading replay for denial of service; a per-sender quota alone does not stop several identities. This needs a design decision, and it is already listed under "Remaining issues" in `OVERNIGHT_REPORT.md`. |
| Medium | `src/cast/channels.js`, stream table | Throwaway identities (16 streams each, 64 identities) fill the cast table's 1024 slots, and sweeping frees a stream only after seven days of silence. A new channel's first cast is then refused. The per-origin cap also stopped counting once 4096 origins were tracked, and counted streams the dataset had already dropped. | **Open, harder.** The table now prefers streams of channels the node has joined, so junk cannot crowd out a channel in use, and the per-origin count is trimmed against the dataset and no longer switches off. Casts for channels the node only relays are still refused when the table is full. That is the Sybil problem the design lists as a non-goal. Test: "a full stream table gives its slots to joined channels...". |
| Medium | `src/core/messaging/reliable.js`, `#e2eKeyOf` | A route to a node can appear before its identity card does, because routes and cards travel in different datasets. In that window `send()` fails with `unknown-destination` instead of queueing. The reviewer saw it in 2 of 5 trials on loopback. | **Open.** Either routes must be reported only once the card is known, or the outbox must be able to seal later; both change a public contract and need a design decision. Already listed under "Remaining issues" in `OVERNIGHT_REPORT.md`. |
| Low | `src/core/peer/peer-manager.js`, `#noteObserved` | With no advertised addresses configured, the node announces the last four IPs that peers claimed to see it at. Four peers with four free identities can replace the real address with chosen ones, and other nodes stop reaching the node through peer exchange. | **Open.** Requiring several peers to agree can itself be forged by several identities, and a safe confirmation rule needs more than a small patch. Operators who set `advertise` are not affected. |
| Low | `src/vault/file-transfer.js`, `onOffer` | Eight throwaway identities, each with eight unanswered offers, hold all 64 offer slots, and every honest offer is refused as `busy`. | **Open, harder.** An unanswered offer is now declined after 24 hours (option `offerTtlMs`) instead of after seven days. An attacker can offer again. Freeing a slot for a newcomer by dropping the biggest holder's oldest offer was tried and left out: it changes what an existing test pins down about the overall limit. Test: "an offer nobody answers is declined...". |
| Low | `src/core/peer/peer-manager.js`, inbound handshakes | An attacker without credentials can hold all 32 inbound handshake slots with idle connections (4 per IP, so 8 addresses, or one IPv6 /64) and every honest inbound link is refused. | **Open.** The fix is a short deadline for message 1, grouping IPv6 by /64 and dropping the oldest silent handshake when the table is full. It was not made here, so the engine keeps its current limits. Dialing out is not affected. |
| Low | `src/core/peer/peer-manager.js`, `#adopt` and `#onLinkClosed` | When two nodes dial each other and one link is replaced, the surviving link raises no link-up. A message whose attempt falls in that window of a few milliseconds goes to "waiting" and is only retried after an unrelated route change, a restart, or expiry. | **Open.** Traced by the reviewer, not reproduced, because the window is a few milliseconds. The fix touches how the node tells the router about replaced links and needs its own tests; the cost of leaving it is a delayed message, not a lost one. |

## What was run

On a Windows machine, over loopback only: the unit, integration and end-to-end suites
(`node --test "test/unit/**/*.test.js" "test/integration/**/*.test.js" "test/e2e/**/*.test.js"`)
were run twice. Both runs gave 1193 tests, 1189 passed, 0 failed, 4 skipped (the POSIX
permission tests, which cannot run on Windows). `npx eslint clawnet` reports no errors and
no warnings.

Six tests were added: two in `cast-channels.test.js`, two in `file-transfer.test.js`, one
in `transport-secure-channel.test.js` and one in `peer-manager.test.js`. The four behind
the fixes (the huge counter, the stuck verification, the BYE socket and the learned DNS
dial) were each run against the old code and failed there. The other two cover the changes
made for open findings: the stream table and the offer time-out.

# Review of the phone node

On 18 November 2026, after the phone web app was built (`docs/DESIGN.md` section 16), two
reviews ran on it, each by a separate AI agent (Claude Sonnet), not by a person:

- a **security** review of the new code: the WebSocket transport, the web app server, the
  configuration and start-up changes, and the browser node in `web/core`. It reproduced
  what it could with throwaway scripts against the real code and said where it only traced
  a path.
- an **interface** review of the app in `web/app`, for accessibility, layout, wording,
  type, colour and polish. Its verdict was "block" for two findings, both fixed below.

Nobody has reviewed this code who did not also help write it, and **nothing has run on a
real phone**.

## Security findings

10 findings: 2 high, 5 medium (one of them medium-to-low), 2 low and 1 informational. **6
are fixed, 3 are partly fixed with the rest open, and 1 is open.**

| Severity | Where | What is wrong | Status |
| --- | --- | --- | --- |
| High | `src/core/transport/websocket.js`, upgrade handling | Node's HTTP server removes its own error handler from a socket before handing it to `upgrade`. A client that sent a refused upgrade (bad origin, path or subprotocol) and then reset the connection raised an uncaught `ECONNRESET` that stopped the node. Anyone who could reach the port could do it. | **Fixed.** Every socket gets an error handler when it connects. Test: `transport-websocket.test.js`, "a client that resets the connection after a refused upgrade...". Run against the old code, it failed with the uncaught `ECONNRESET`. |
| High | `websocket.js`, message reassembly | The message limit counted payload bytes only, so a client could send endless empty fragments; the reviewer took the server to 3.3 GB of memory in 6 seconds from one connection. | **Fixed.** A message may have at most 64 fragments (close code 1009). Tests: "more fragments than allowed, all of them empty..." and "a message in as many fragments as allowed arrives whole". Not run against the old code. |
| Medium | `websocket.js` and `src/gate/webapp-server.js`, before the HTTP request | Node's header deadlines start with the first byte, so sockets that sent nothing stayed open for good; a few machines could fill every slot and keep phones out. | **Fixed.** A silent socket is closed after the handshake deadline (WebSocket port) or 10 seconds (web app server); an upgraded link is not affected. Tests: "a socket that never sends a byte..." in both test files, "an upgraded connection may stay quiet...". |
| Medium | `websocket.js` pongs; `web/core/channel.js` PONG packets | A client that pings without reading made the server queue pongs without limit; a computer could do the same to a phone with ClawNet PINGs, which bypassed the phone's 4 MiB send cap. | **Fixed.** The server skips pongs while 64 KiB wait to be sent; the phone queues nothing but a `BYE` beyond 4 MiB. No test: it needs a client that stops reading at the right moment, which does not run reliably over loopback. |
| Medium | `web/core/messenger.js`, conversations | The cap on conversations never evicted anything (the new conversation sorted last and was then spared), so any sender could add conversations without limit and fill the browser's storage; failed writes were silent and could drop the replay cache and the outbox. | **Fixed.** The least recent conversation is evicted after the new message is added, never the current one; stored conversations are capped at about a million characters; a refused write is counted and the app says so once. Tests: `web-messenger.test.js`. |
| Medium | `web/core/messenger.js`, `web/core/node.js` | The phone had no budget for inbound work. Opening a message costs a key agreement and two signature checks, and a computer could make it check up to 10,000 new records a minute, freezing the page. | **Partly fixed.** At most 20 messages a second are opened (40 at once), and at most 300 new records a minute are accepted from the computer. Test: "messages beyond the opening allowance are dropped...". **Open:** no check of a duplicate body before opening it, and a large sync page is still checked in one go without yielding to the page. |
| Medium to low | `web/core/node.js`, the record tables | Neither table had priorities and peer records' `seq` was unbounded, so a hostile node could publish thousands of invented origins with a huge `seq` and push out real contacts' cards. | **Partly fixed.** The linked computer and remembered nodes (the computers linked to and the nodes messages were exchanged with) take priority when a table is full; a peer record numbered more than the clock skew ahead of the clock is refused; contacts' cards are remembered apart from the tables; saved records keep remembered nodes first. **Open:** the tables can still fill with invented nodes, which pushes out nodes the phone has not talked with yet. This is the Sybil problem the design lists as a non-goal, and the engine was not changed. No test of its own. |
| Low | `web/core/messenger.js`, replay cache | The replay cache holds 5000 entries. After a flood of valid messages, an old recorded message could be replayed and shown again. | **Partly fixed.** A message still in its conversation's history counts as a duplicate: it is acknowledged again and not shown. Test: "a message still in its conversation is not shown twice...". **Open** beyond the history (300 messages per conversation); the engine's open finding above is the same. |
| Low | `src/core/config.js`, listener defaults | Both new listeners bind `0.0.0.0` and do not filter by source address, so a computer with a public address exposes them to the internet. | **Open.** Documented in `THREAT_MODEL.md` (section 3.7, limitation 20). A filter for private addresses was considered and not added: it would refuse phones that reach the computer by a global IPv6 address on the same network, and that trade-off needs a decision. |
| Informational | browser storage, plain HTTP, noble verification | The phone's keys sit unencrypted in browser storage, the app arrives over plain HTTP, and noble's Ed25519 verification is cofactored where OpenSSL's is cofactorless. | **Open, documented.** These are limits of the approach (`THREAT_MODEL.md` section 3.7, limitations 17 and 18; `DESIGN.md` section 16, point 8). |

The reviewer also checked and found sound: the Origin and Host rules (15 hostile cases,
including `null`, user-info tricks, decimal and hex addresses and rebinding-style names),
the web app server (no path traversal, since it looks paths up in a fixed table; nothing
secret served), the app's handling of message text and names (no markup injection), the
control API (unchanged), and the protocol checks (the destination and id bound into the
sealed message, acknowledgements accepted only from the destination, forged records of the
phone's own origin refused).

## Interface findings

The review read the app's code and looked at it at phone size in a Chromium browser.

| Severity | What was wrong | Status |
| --- | --- | --- |
| High | Input fields in a monospace font were 15 pixels, under the 16 at which iPhone Safari zooms the page on focus. | **Fixed:** every field uses the 17-pixel body size. |
| High | "The computer is on a different network" and "The computer does not accept this phone" named no way out. | **Fixed:** each now says what to do (set the phone up again; ask whoever runs the computer to allow it, with where to find the phone's id). |
| Medium | The node list's accessible names replaced the visible text; the conversation announced its whole history on opening; toasts were not announced reliably; a sent or received message did not say who sent it to a screen reader; focus stayed behind when a conversation opened. | **Fixed.** Names come from the visible text plus a hidden state; the message log turns its announcements on after its first drawing; toasts go through the page's announcer; each message carries a hidden "You" or the sender's name; focus moves to the page. The names, the log, the hidden senders and the focus were checked in the browser; no screen reader was used. |
| Medium | The app gave up when the computer was not answering at start, though the phone's identity and messages are on the phone. | **Fixed** in code, not tried in a browser: it opens with the last settings the computer gave and keeps trying to link; with none, it reloads when the network returns. |
| Medium | Copy failures and a few labels were vague; small text in the node list and messages was below the type scale; the link card and the "This phone" page redrew every second. | **Fixed.** |

## What was run for the phone node

On the same Windows machine, over loopback only (Node 26.12). After all the fixes above,
`npm test` gave 1307 tests, 1303 passed, 0 failed, 4 skipped (the POSIX permission tests),
and the 95 tests in the phone-related files passed three more times in a row.
`npx eslint clawnet` reports no errors and no warnings. The page was opened in the Claude
desktop app's Chromium browser at 375 by 812 pixels against two nodes on the same machine:
set-up, the node list, a conversation two hops away (delivered, then answered) and "This
phone" were checked by hand, before and after the interface fixes.

After the fixes, on 18 November 2026, the owner tried it on their iPhone, over their home
Wi-Fi, against a node on their PC started with `--phone`. The PC's node showed an inbound
WebSocket link from the phone's address with the phone's agent (`clawnet-web/0.1.0`) and
no relay, mailbox or transit capability; the phone's message arrived; and the PC's reply
was marked delivered, which needs the phone's acknowledgement. Nothing ran on Android, on
another iPhone, or between two computers.
