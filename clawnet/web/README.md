# The phone web app

A ClawNet node that runs in a phone's browser. A computer node started with
`clawnet start --phone` serves it to phones on the same Wi-Fi; a phone that opens it creates
an identity of its own, links to that computer over WebSocket, and sends and receives
end-to-end encrypted messages like any other node. How to switch it on and its limits are
in `docs/OPERATIONS.md` section 6a; the design is `docs/DESIGN.md` section 16; the wire
details are `docs/PROTOCOL.md` section 3.7; the security limits are
`docs/THREAT_MODEL.md` section 3.7.

## Layout

| Directory | What it holds |
| --- | --- |
| `app/` | The page: `index.html`, `app.css` (its design notes are at the top), `main.js` (views: setup, nodes, conversation, this phone), `icons.js` (Lucide icon shapes), the web manifest and the home-screen icons (drawn by `scripts/make-app-icons.js`). |
| `core/` | The node: a second implementation of the parts of the engine a phone needs, written for the browser. `bytes`, `primitives` (over `vendor/`), `noise` (every Noise pattern the engine supports), `identity`, `schema`, `codec`, `envelope` (sealed messages, scheme `0x01`), `lww` and `sync` (ClawSync), `channel` (the link: handshake, records, keepalive, rekey), `messenger` (reliable messages and conversations), `storage`, and `node` (`PhoneNode`, which ties them together). |
| `vendor/` | The noble cryptography libraries, pinned; see `vendor/README.md`. |

There is no build step. The files are plain ES modules (ES2022: private class fields,
`??=`), loaded as they are. Three engine modules are shared rather than copied:
`src/core/errors.js`, `src/core/wire/types.js` and `src/core/wire/canonical.js`.

## How it is served

`src/gate/webapp-server.js` reads `web/app`, `web/core`, `web/vendor` and the three shared
modules once, when the node starts, and serves them from memory at their paths under
`clawnet/` (`/` is `web/app/index.html`). A changed file is served only after the node
restarts. Every response carries a strict Content-Security-Policy; the app has no inline
script or style. `/config.json` gives the app the network id, whether a network key is
needed and the WebSocket port.

## What a phone stores

Everything is in the browser's `localStorage` for the app's origin, under keys that start
with `clawnet.`: `identity` (the secret keys, unencrypted), `network` (the network id and
key), `seq`, `cards`, `peerRecords`, `outbox`, `seen`, `chats`, and for the page itself
`names`, `read`, `config` and `install-hint`. Deleting the website's data deletes the
identity. If the browser refuses to store (full, or a private window), the app keeps
working from memory and says once that changes will be lost when it closes.

## What a phone does on the network

It advertises `caps = { relay: false, mailbox: false, transit: false }` and no addresses,
so nothing is routed through it and nobody dials it. It links to exactly one computer at a
time, publishes its own link-state and peer records, keeps the network's records through
ClawSync, answers probes, and retries unacknowledged messages while the page is open.
Inbound work is bounded: 20 messages opened a second (40 at once), 300 new records a
minute, 100 conversations of 300 messages and about a million characters in all.

## Testing

- `test/unit/web-core.test.js`, `web-noise.test.js`, `web-sync.test.js`,
  `web-messenger.test.js`, `web-vendor.test.js` run the core under Node.js and compare it
  with the engine: the published Noise vectors, byte-identical handshakes, encodings,
  signatures and sealed messages, sync between the two implementations, and the
  messenger's limits.
- `test/integration/phone.test.js` runs `PhoneNode` under Node.js against real nodes over
  WebSocket: linking, messages both ways, through a second node, offline sends, and the
  checks on the WebSocket port.
- To look at the page on a computer: start a node with `--phone` and open the address it
  prints in a desktop browser, with the browser's device toolbar at phone size.

Besides that, it has run once on a real phone: on 18 November 2026 the owner set it up on
their iPhone, over their home Wi-Fi, against a node on their PC; it linked, and a message
went each way. It has not run on Android.
