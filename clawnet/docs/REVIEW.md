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
