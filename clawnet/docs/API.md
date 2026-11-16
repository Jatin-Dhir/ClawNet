# ClawNet local control API

The contract between a running node and its local clients: the `clawnet` CLI, the ClawView
console and scripts. It is served by `gate/api-server.js` (ARCHITECTURE.md section 8.5).
Design rationale is in DESIGN.md section 12.

Contents: 1 basics · 2 Host, Origin and the served console · 3 authentication ·
4 errors · 5 conventions · 6 endpoints · 7 types · 8 event stream · 9 building a live
view.

## 1. Basics

- Base URL: `http://127.0.0.1:47480/api/v1` (`config.api.host`, `config.api.port`). Plain
  HTTP/1.1. The API listens on loopback only unless `config.api.allowRemote` is true; in
  that case the token crosses the network in clear text, and the operator is responsible
  for a tunnel.
- Everything under `/api/` needs the bearer token (section 3). Everything else is the
  static ClawView console (section 2.3) and needs no token.
- Requests with a body send `Content-Type: application/json` and a JSON object of at most
  65536 bytes. Unknown fields are rejected. Responses are
  `Content-Type: application/json; charset=utf-8` with `Cache-Control: no-store`, except
  the event stream.
- Methods: `GET` reads, `POST` acts, `DELETE` removes. `HEAD` and `OPTIONS` are only
  answered as described in section 2.
- The version is in the path. A change that removes or renames a field, endpoint or
  event creates `/api/v2`; additions do not. Clients MUST ignore fields and event types
  they do not know.
- The API is the node. A node without the `api` service, or with `config.api.enabled`
  false, has no control API.

## 2. Host, Origin and the served console

### 2.1 Host rule (every request, API and static)

Let `port` be the port the server is bound to. A request is served only if it has exactly
one `Host` header whose lowercased value equals `h:port` for some `h` in
`config.api.allowedHosts` (default `127.0.0.1`, `localhost`, `[::1]`), or equals `h`
alone when `port` is 80. Requests in absolute form (`GET http://…`) are refused.

Otherwise: `403` with error code `forbidden_host` and no other processing. This is what
defeats DNS rebinding: a hostile page that makes its own domain resolve to `127.0.0.1`
still sends its own domain in `Host`.

### 2.2 Origin rule and CORS (`/api/` only)

Browsers attach `Origin` to cross-origin requests and to same-origin requests that are
not `GET` or `HEAD`.

- No `Origin` header: allowed (CLI, scripts, same-origin `GET`).
- `Origin` equal to `http://` followed by the request's validated `Host` value:
  same-origin, allowed, no CORS headers.
- `Origin` exactly equal to an entry of `config.api.corsOrigins` (default: none): allowed,
  and the response carries `Access-Control-Allow-Origin: <that origin>` and
  `Vary: Origin`.
- Anything else, including `Origin: null`: `403 forbidden_origin`, before the token is
  looked at.
- If `Sec-Fetch-Site` is present with the value `cross-site` and the origin is not in
  `corsOrigins`: `403 forbidden_origin`.

Preflight: `OPTIONS` with `Origin` in `corsOrigins` and an
`Access-Control-Request-Method` header gets `204` with
`Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: GET, POST, DELETE`,
`Access-Control-Allow-Headers: Authorization, Content-Type, Last-Event-ID`,
`Access-Control-Max-Age: 600`, `Vary: Origin`, and needs no token. Any other `OPTIONS`
is `403 forbidden_origin`. `Access-Control-Allow-Origin: *` and
`Access-Control-Allow-Credentials` are never sent.

The token, not the Origin rule, is the access control: the API uses no cookies, so a
foreign page cannot make an authenticated request. The Origin rule stops such a page from
even probing.

### 2.3 The served console

When `config.api.serveUi` is true, `GET` and `HEAD` requests outside `/api/` serve the
built ClawView files. A path with a file extension serves that file or `404`; any other
path serves `index.html` (client-side routing). Every static response carries:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-cache
```

The server never writes the token into any static response.

When the console has not been built (the directory is missing, or has no `index.html`),
every non-API path answers `404` with a plain-text page (`text/plain`) that says so and
points at the API; the API itself is unaffected. Only extensions of a fixed table (html,
js, css, json, svg, png, jpg, gif, webp, ico, fonts, wasm and a few more) are served, and a
file name with a dot as its first character, a backslash, a colon or a NUL is always 404.

## 3. Authentication

The token is 32 random bytes written as 64 lowercase hexadecimal characters, created on
first start in `<dataDir>/api-token` (owner-only permissions) and stable across restarts.
Deleting the file and restarting the node rotates it.

Every `/api/` request (except a CORS preflight) carries:

```
Authorization: Bearer 5f1c…64 hex characters…a9
```

A missing, malformed or wrong token gets `401` with code `unauthorized` and
`WWW-Authenticate: Bearer realm="clawnet"`. The comparison is constant-time. The token is
accepted only in this header: never in a query string, a cookie or a body.

**How clients get the token.**

- CLI and scripts on the same machine read `<dataDir>/api-token`; the CLI never prints
  it, except inside the console URL below. `<dataDir>/runtime.json` holds the API's actual
  address (`api`) and the process id (`pid`), which matters when the port is 0.
- **ClawView, served by the node**, gets it through the URL fragment. `clawnet ui` prints
  (and with `--open` opens) `http://127.0.0.1:47480/#token=<token>`. On load the console:
  1. reads `location.hash`; if it contains `token=`, stores the value in `sessionStorage`
     under `clawnet.token` and immediately calls
     `history.replaceState(null, "", location.pathname)` so the fragment leaves the
     address bar and the history entry;
  2. otherwise uses the value in `sessionStorage`;
  3. otherwise shows a field to paste the token;
  4. validates with `GET /api/v1/status`; on `401` it clears the stored value and goes to 3.

  A fragment is not sent to the server, does not appear in `Referer`, and is not logged
  by the node. The console keeps the token in memory and `sessionStorage` only (never
  `localStorage`, never a query string) and sends it only in the `Authorization` header
  of same-origin requests.

Holding the token is full control of the node: it can read conversations, send as the
node, and make the node read any file its user can read (`POST /files`).

## 4. Errors

Every non-2xx response from `/api/` has this body:

```json
{ "error": { "code": "unknown_destination", "message": "no identity card known for that node", "details": { "to": "mapwpitksl5fu25ovrrpfckxsac3j7hjanbmbsckknvbwhsfc4va" } } }
```

`code` is stable and is what clients branch on. `message` is for people and may change.
`details` is optional and code-specific.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | a field is missing, unknown, of the wrong type or out of range; `details: { field, problem }` |
| 400 | `invalid_json` | the body is not a JSON object |
| 400 | `invalid_file` | `POST /files`: `details.reason` is `not-found`, `not-a-file` or `too-large` |
| 401 | `unauthorized` | section 3 |
| 403 | `forbidden_host`, `forbidden_origin` | section 2 |
| 404 | `not_found` | unknown path, or the addressed peer, channel, transfer or node does not exist |
| 404 | `unknown_destination` | no identity card is known for the destination NodeId |
| 404 | `not_joined` | the channel is not joined |
| 405 | `method_not_allowed` | the path exists with other methods; `Allow` header lists them |
| 409 | `already_joined` | joining a joined channel with a different key |
| 409 | `invalid_state` | the transfer is not in a state that allows the action |
| 409 | `peer_limit` | the node is at `peers.max` |
| 409 | `conflict` | any other operation that is impossible in the current state |
| 413 | `body_too_large` | body over 65536 bytes |
| 415 | `unsupported_media_type` | a body without `Content-Type: application/json` |
| 429 | `rate_limited` | cast publishing rate exceeded, or the server's own limits (below); `details: { retryInMs }` |
| 500 | `internal` | a bug; the message is generic, the detail is in the node's log |
| 500 | `storage` | a disk operation failed |
| 502 | `connect_failed` | `POST /peers/connect`: `details.reason` is a handshake reason (ARCHITECTURE.md 4.1) |
| 503 | `outbox_full` | the outbox is at its configured limit |
| 503 | `busy` | too many concurrent diagnostics |
| 503 | `too_many_streams` | 16 event streams are already open |
| 503 | `not_running` | the node is starting or stopping |

How the server derives these from engine errors (normative for `gate/api-server.js`): an
error carrying `status` and `apiCode` (made with `ctx.api.error`) is used as is. A
`StateError` whose message starts with a token and `": "` maps to the code with hyphens
turned into underscores, with the status of the table above, or `409` if the code is not
in the table. `HandshakeError` is `502 connect_failed` with `details.reason`.
`ConfigError`, `CryptoError`, `CanonicalError` and `WireError` are `400 invalid_request`.
`StoreError` is `500 storage`. Anything else is `500 internal`.

**The server's own rate limits.** An authenticated client may make 200 requests per second
(a burst of 400), and failed authentications are limited to 10 per second (a burst of 20).
Beyond that the answer is `429 rate_limited` with `Retry-After` (whole seconds) and
`details: { retryInMs }`. The limits are separate, so someone else's wrong tokens never
lock out the holder of the right one: a request with the right token is not counted
against the failure budget. Event streams count once, when they open.

## 5. Conventions

| Type | JSON form |
| --- | --- |
| `NodeId` | string of 52 characters, the canonical lowercase base32 of a public key: `^[a-z2-7]{51}[aq]$` |
| `Address` | string `tcp://host:port` |
| `Ms` | integer: milliseconds, or milliseconds since the Unix epoch for a point in time |
| `Id` | string of 32 lowercase hex characters (message, packet or transfer id) |
| `Base64` | RFC 4648 with padding |

- Field tables below give `name: type`. `T | null` is always present and may be null.
  `T?` may be absent.
- **Paging.** List endpoints that page take `limit` (default 50, maximum 500) and
  `before` (an integer cursor). They return items newest first and
  `nextBefore: integer | null`; pass it as `before` to get older items; null means there
  are none.
- **Snapshot position.** Every response that is a snapshot of changing state includes
  `asOf: { boot: string, seq: integer }`: the node's boot id and the sequence number of
  the last event emitted before the snapshot was taken. A client that also follows the
  event stream applies only events with `seq` greater than `asOf.seq` on top of the
  snapshot (section 9).
- Long example values are shortened with `…`. Real values are full length.

Example ids used below: A = `fxl7tt5ojvwq5qk5m7nd6ekswwt4hjukrlt2qwnkyns2kmreelga`
(this node), B = `mapwpitksl5fu25ovrrpfckxsac3j7hjanbmbsckknvbwhsfc4va`,
C = `v5lj76hrnxzwb4die5j65gbjlhis646zpsg4lvyqteji7invg5iq`. In examples they are written
`"fxl7…elga"`, `"mapw…c4va"`, `"v5lj…g5iq"`.

## 6. Endpoints

All paths are relative to `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | node summary |
| GET | `/identity` | this node's identity |
| GET | `/peers` | links and dials in progress |
| GET | `/peers/known` | the address book |
| POST | `/peers/connect` | dial an address |
| POST | `/peers/{id}/disconnect` | close a link |
| GET | `/topology` | nodes and links |
| GET | `/topology/routes` | this node's routing table |
| GET | `/topology/nodes/{id}` | one node in detail |
| POST | `/messages` | send a chat message |
| GET | `/conversations` | conversation list |
| GET | `/conversations/{id}` | messages with one node |
| GET | `/outbox` | undelivered reliable messages |
| GET | `/channels` | joined channels |
| POST | `/channels` | join a channel |
| DELETE | `/channels/{name}` | leave a channel |
| POST | `/channels/{name}/messages` | publish to a channel |
| GET | `/channels/{name}/messages` | channel history |
| POST | `/files` | offer a file |
| GET | `/files` | transfers |
| GET | `/files/{id}` | one transfer |
| POST | `/files/{id}/accept`, `/reject`, `/cancel` | act on a transfer |
| POST | `/diag/ping` | ping a node |
| POST | `/diag/traceroute` | trace the path to a node |
| GET | `/diag/counters` | counters and rates |
| GET | `/diag/events` | recent events from the ring buffer |
| GET | `/diag/sync` | ClawSync statistics |
| GET | `/mailbox` | **not implemented**: always `404 not_found` (section 6.9) |
| GET | `/config` | effective configuration, secrets redacted |
| POST | `/shutdown` | stop the node |
| GET | `/events` | live event stream (section 8) |

The chat endpoints (`/messages`, `/conversations`) exist only when the `messages` service
is installed, and the channel, file, ping, traceroute and counter endpoints only when the
corresponding service is (`cast`, `files`, `diag`); otherwise they are `404 not_found`.
`GET /status` lists the installed services. The `clawnet` command starts a node with
`messages`, `diag`, `cast`, `files` and `api` (`defaultServices()` in `src/services.js`).
There is no `relay` service: it was designed (ARCHITECTURE.md section 8.3) and has not been
built, so `GET /mailbox` and the custody events of section 8.5 do not exist.

### 6.1 `GET /status`

| Field | Type | Meaning |
| --- | --- | --- |
| `nodeId` | NodeId | |
| `shortId` | string | first 8 characters of `nodeId` |
| `agent` | string | `clawnet/<version>` |
| `networkId` | string | |
| `state` | string | `starting`, `running`, `stopping` |
| `boot` | string | 8 hex characters, new at every process start |
| `startedAt`, `now` | Ms | |
| `uptimeMs` | Ms | |
| `listen` | Address \| null | the bound peer listener |
| `addresses` | Address[] | what this node announces to others |
| `caps` | `{ relay, mailbox, transit }` booleans | |
| `peers` | `{ linked, dialing, known, target, max }` integers | |
| `routing` | `{ rev, nodes, reachable, lsaSeq }` integers | `nodes` includes this node |
| `messaging` | `{ outbox, outboxBytes, waiting }` integers | |
| `events` | `{ lastSeq, oldestSeq }` integers | range held by the ring buffer |
| `services` | string[] | |
| `asOf` | `{ boot, seq }` | |

```json
{
  "nodeId": "fxl7…elga", "shortId": "fxl7tt5o", "agent": "clawnet/0.1.0",
  "networkId": "clawnet-main", "state": "running", "boot": "9f2c1a7b",
  "startedAt": 1794787200000, "now": 1794787323456, "uptimeMs": 123456,
  "listen": "tcp://0.0.0.0:47470", "addresses": ["tcp://192.168.1.20:47470"],
  "caps": { "relay": true, "mailbox": false, "transit": true },
  "peers": { "linked": 2, "dialing": 0, "known": 5, "target": 8, "max": 64 },
  "routing": { "rev": 41, "nodes": 3, "reachable": 2, "lsaSeq": 1794787320113 },
  "messaging": { "outbox": 1, "outboxBytes": 612, "waiting": 0 },
  "events": { "lastSeq": 1042, "oldestSeq": 1 },
  "services": ["messages", "diag", "cast", "files", "api"],
  "asOf": { "boot": "9f2c1a7b", "seq": 1042 }
}
```

### 6.2 `GET /identity`

| Field | Type | Meaning |
| --- | --- | --- |
| `nodeId`, `shortId` | | |
| `signPublicKey` | Base64 | the 32-byte Ed25519 public key that `nodeId` encodes |
| `card` | `{ id, link, e2e, sig }` | identity card: NodeId, two Base64 X25519 public keys, Base64 signature |
| `keystoreEncrypted` | boolean | false means the keys are protected by file permissions only |
| `addresses` | Address[] | |

```json
{
  "nodeId": "fxl7…elga", "shortId": "fxl7tt5o",
  "signPublicKey": "Ldf5z65NbQ7BXWfaPxFStafDpoqK56hZqsNlpTIkIsw=",
  "card": { "id": "fxl7…elga", "link": "YB9nomqS…FFyo=", "e2e": "r1af+PFt…N1E=", "sig": "AHPsJm1P…HdMg==" },
  "keystoreEncrypted": true,
  "addresses": ["tcp://192.168.1.20:47470"]
}
```

No private key is ever returned by any endpoint.

### 6.3 Peers

**`GET /peers`** returns `{ peers: PeerInfo[], dialing: DialInfo[], asOf }`.

`PeerInfo`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | NodeId | |
| `linkId` | string | a decimal number that increases with every link this node makes; treat it as opaque |
| `direction` | `"in"` \| `"out"` | who dialed |
| `addr` | Address | remote socket address |
| `agent` | string | |
| `caps` | `{ relay, mailbox, transit }` | as stated in the handshake |
| `listen` | Address[] | addresses the peer announced |
| `since` | Ms | link established |
| `rttMs` | number \| null | last keepalive round trip |
| `srttMs` | number \| null | smoothed |
| `cost` | integer | 1..65535, what this node advertises for the link |
| `misses` | integer | consecutive unanswered keepalives |
| `lastRxAt` | Ms | |
| `packetsIn`, `packetsOut`, `bytesIn`, `bytesOut` | integer | since the link came up |
| `queuedBytes` | integer | waiting to be sent |
| `throttled` | boolean | reading paused by the rate limit |
| `sticky` | boolean | created by `POST /peers/connect`; redialed until disconnected |

`DialInfo`: `{ addr: Address, id: NodeId | null, source: string, since: Ms, attempt: integer }`.
`source` is `manual`, `bootstrap`, `multicast`, `pex` or `handshake`.

```json
{
  "peers": [{
    "id": "mapw…c4va", "linkId": "3", "direction": "out", "addr": "tcp://192.168.1.31:47470",
    "agent": "clawnet/0.1.0", "caps": { "relay": true, "mailbox": true, "transit": true },
    "listen": ["tcp://192.168.1.31:47470"], "since": 1794787205120,
    "rttMs": 1.8, "srttMs": 2.1, "cost": 3, "misses": 0, "lastRxAt": 1794787322900,
    "packetsIn": 412, "packetsOut": 398, "bytesIn": 88211, "bytesOut": 80112,
    "queuedBytes": 0, "throttled": false, "sticky": false
  }],
  "dialing": [],
  "asOf": { "boot": "9f2c1a7b", "seq": 1042 }
}
```

**`GET /peers/known`** returns `{ addresses: AddressEntry[] }`, at most 4096.
`AddressEntry`: `{ addr: Address, id: NodeId | null, sources: string[], addedAt: Ms,
lastOkAt: Ms | null, lastFailAt: Ms | null, fails: integer, lastError: string | null,
nextAttemptAt: Ms }`.

```json
{ "addresses": [{ "addr": "tcp://192.168.1.31:47470", "id": "mapw…c4va", "sources": ["bootstrap", "pex"],
  "addedAt": 1794787200050, "lastOkAt": 1794787205120, "lastFailAt": null, "fails": 0,
  "lastError": null, "nextAttemptAt": 0 }] }
```

**`POST /peers/connect`** dials an address and waits for the handshake (at most
`timers.handshakeTimeoutMs`). The address becomes sticky.

Request: `{ "address": Address }`. Response `200`: `{ "peer": PeerInfo }`.
Errors: `invalid_request`, `peer_limit`, `connect_failed` (for example
`details.reason = "noise"` for a wrong network key, `"connect-failed"`, `"not-allowed"`).

```json
{ "address": "tcp://192.168.1.31:47470" }
```
```json
{ "peer": { "id": "mapw…c4va", "linkId": "3", "direction": "out", "addr": "tcp://192.168.1.31:47470", "cost": 3, "…": "…" } }
```

**`POST /peers/{id}/disconnect`** closes the link to that node and forgets its manually
added addresses, so it is not redialed on their account. No body.
Response `200`. Errors: `invalid_request` (not a NodeId), `not_found` (no link to that id).

```json
{ "disconnected": true }
```

### 6.4 Topology

**`GET /topology`** returns what this node knows of the network: every node with a current
LSA, this node, and every linked peer; and every link that at least one LSA advertises.

| Field | Type | Meaning |
| --- | --- | --- |
| `rev` | integer | increases with every routing recomputation; also in `topology.changed` and `routes.changed` |
| `self` | NodeId | |
| `nodes` | TopologyNode[] | |
| `links` | TopologyLink[] | |
| `asOf` | `{ boot, seq }` | |

`TopologyNode`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id`, `shortId` | | |
| `self` | boolean | |
| `linked` | boolean | a direct link exists |
| `caps` | `{ relay, mailbox, transit }` \| null | from its LSA, else from the handshake |
| `seq` | integer \| null | its LSA's sequence number |
| `ts` | Ms \| null | its LSA's own timestamp |
| `receivedAgoMs` | Ms \| null | time since this node received that LSA |
| `advertised` | integer | number of links in its LSA |
| `reachable` | boolean | a route exists (always true for `self`) |
| `nextHop` | NodeId \| null | |
| `cost` | integer \| null | route cost |
| `hops` | integer \| null | 0 for `self` |
| `addrs` | Address[] | from its peer record, if known |

`TopologyLink` (undirected, `a < b` as strings):

| Field | Type | Meaning |
| --- | --- | --- |
| `a`, `b` | NodeId | |
| `costAB` | integer \| null | cost `a` advertises towards `b`; null if `a` does not advertise the link |
| `costBA` | integer \| null | |
| `state` | `"confirmed"` \| `"half"` | `confirmed` when both ends advertise it; only confirmed links carry traffic |

```json
{
  "rev": 41, "self": "fxl7…elga",
  "nodes": [
    { "id": "fxl7…elga", "shortId": "fxl7tt5o", "self": true, "linked": false,
      "caps": { "relay": true, "mailbox": false, "transit": true }, "seq": 1794787320113,
      "ts": 1794787320113, "receivedAgoMs": 3343, "advertised": 1, "reachable": true,
      "nextHop": null, "cost": 0, "hops": 0, "addrs": ["tcp://192.168.1.20:47470"] },
    { "id": "mapw…c4va", "shortId": "mapwpitk", "self": false, "linked": true,
      "caps": { "relay": true, "mailbox": true, "transit": true }, "seq": 1794787319870,
      "ts": 1794787319870, "receivedAgoMs": 3586, "advertised": 2, "reachable": true,
      "nextHop": "mapw…c4va", "cost": 3, "hops": 1, "addrs": ["tcp://192.168.1.31:47470"] },
    { "id": "v5lj…g5iq", "shortId": "v5lj76hr", "self": false, "linked": false,
      "caps": { "relay": true, "mailbox": false, "transit": true }, "seq": 1794787318002,
      "ts": 1794787318002, "receivedAgoMs": 5454, "advertised": 1, "reachable": true,
      "nextHop": "mapw…c4va", "cost": 15, "hops": 2, "addrs": [] }
  ],
  "links": [
    { "a": "fxl7…elga", "b": "mapw…c4va", "costAB": 3, "costBA": 3, "state": "confirmed" },
    { "a": "mapw…c4va", "b": "v5lj…g5iq", "costAB": 12, "costBA": 11, "state": "confirmed" }
  ],
  "asOf": { "boot": "9f2c1a7b", "seq": 1042 }
}
```

This is one node's view. It is built from signed advertisements: a node can misstate its
own links but not anyone else's, and a link is `confirmed` only when both ends state it.

**`GET /topology/routes`** returns `{ rev, routes: Route[], asOf }`, nearest first.
`Route`: `{ dst: NodeId, nextHop: NodeId, cost: integer, hops: integer, path: NodeId[] }`;
`path` starts with this node and ends with `dst`.

```json
{ "rev": 41, "routes": [
    { "dst": "mapw…c4va", "nextHop": "mapw…c4va", "cost": 3, "hops": 1, "path": ["fxl7…elga", "mapw…c4va"] },
    { "dst": "v5lj…g5iq", "nextHop": "mapw…c4va", "cost": 15, "hops": 2, "path": ["fxl7…elga", "mapw…c4va", "v5lj…g5iq"] }
  ], "asOf": { "boot": "9f2c1a7b", "seq": 1042 } }
```

**`GET /topology/nodes/{id}`** returns `{ node: TopologyNode | null, lsa: object | null,
peerRecord: object | null, route: Route | null }`; `lsa` and `peerRecord` are the signed
records as received. `node` is null for a node of which only a peer record is known (no
current LSA, not linked). Errors: `invalid_request` (not a NodeId), `not_found`.

```json
{ "node": { "id": "v5lj…g5iq", "reachable": true, "hops": 2, "…": "…" },
  "lsa": { "type": "lsa", "origin": "v5lj…g5iq", "seq": 1794787318002, "ts": 1794787318002,
           "links": [{ "peer": "mapw…c4va", "cost": 11 }],
           "caps": { "relay": true, "mailbox": false, "transit": true }, "sig": "…" },
  "peerRecord": null,
  "route": { "dst": "v5lj…g5iq", "nextHop": "mapw…c4va", "cost": 15, "hops": 2, "path": ["fxl7…elga", "mapw…c4va", "v5lj…g5iq"] } }
```

### 6.5 Messages

**`POST /messages`** sends an end-to-end encrypted, acknowledged chat message.

Request: `{ "to": NodeId, "text": string }`; `text` is 1 to 16384 bytes of UTF-8.
Response `202`: `{ "message": ChatMessage }`. The message is now in the outbox; its
progress arrives as `chat.state` events. Errors: `invalid_request`,
`unknown_destination`, `outbox_full`.

```json
{ "to": "v5lj…g5iq", "text": "status report at 0900" }
```
```json
{ "message": { "seq": 17, "id": "ae7be26cdaa742ca148068d5ac90eaca", "peer": "v5lj…g5iq",
  "direction": "out", "text": "status report at 0900", "ts": 1794787323400,
  "at": 1794787323401, "state": "sent" } }
```

**`GET /conversations`** returns `{ conversations: ConversationSummary[] }`, most recently
active first.

```json
{ "conversations": [{ "peer": "v5lj…g5iq", "count": 12, "lastAt": 1794787323401,
  "last": { "seq": 17, "id": "ae7be26c…eaca", "peer": "v5lj…g5iq", "direction": "out",
            "text": "status report at 0900", "ts": 1794787323400, "at": 1794787323401, "state": "delivered" } }] }
```

**`GET /conversations/{id}`** pages through the messages exchanged with one node.
Query: `limit`, `before` (a `seq`). Response: `{ peer, items: ChatMessage[], nextBefore }`.
An unknown node yields an empty list, not an error.

```json
{ "peer": "v5lj…g5iq", "items": [
    { "seq": 17, "id": "ae7be26c…eaca", "peer": "v5lj…g5iq", "direction": "out", "text": "status report at 0900",
      "ts": 1794787323400, "at": 1794787323401, "state": "delivered" },
    { "seq": 16, "id": "aaf2f899…d45f", "peer": "v5lj…g5iq", "direction": "in", "text": "ready",
      "ts": 1794787300100, "at": 1794787300160, "state": "received" }
  ], "nextBefore": null }
```

**`GET /outbox`** lists reliable messages of every kind that are not yet acknowledged.
Query: `limit` (default 200, maximum 1000). Response:
`{ total: integer, entries: OutboxEntry[] }`, newest first.

```json
{ "total": 1, "entries": [{ "id": "ae7be26cdaa742ca148068d5ac90eaca", "dst": "v5lj…g5iq", "kind": "msg",
  "bytes": 612, "createdAt": 1794787323401, "expiresAt": 1795392123401, "attempts": 2,
  "nextAttemptAt": 1794787329700, "state": "backoff", "custodian": null, "custodyState": null, "custody": true }] }
```

### 6.6 Channels (ClawCast)

A channel is a name (`^[a-z0-9][a-z0-9._-]{0,63}$`) and optionally a shared 32-byte key.
The pair determines the channel's wire id `chan`; the same name with and without a key,
or with different keys, are different channels.

**`GET /channels`** returns `{ channels: ChannelInfo[] }`.

```json
{ "channels": [{ "name": "ops", "chan": "26c322652770620e64ac90682eb6504c", "encrypted": true,
  "joinedAt": 1794787201000, "messages": 42, "lastMessageAt": 1794787310000 }] }
```

**`POST /channels`** joins a channel.
Request: `{ "name": string, "key"?: Base64 }`; `key` must decode to exactly 32 bytes.
Response `201`: `{ "channel": ChannelInfo }` (`200` when already joined with the same
key). Errors: `invalid_request`, `already_joined`. Messages of the channel that the node
already relays appear in the history at once. The key is stored encrypted on disk and is
never returned by the API.

```json
{ "name": "ops", "key": "Ldf5z65NbQ7BXWfaPxFStafDpoqK56hZqsNlpTIkIsw=" }
```
```json
{ "channel": { "name": "ops", "chan": "26c322652770620e64ac90682eb6504c", "encrypted": true,
  "joinedAt": 1794787201000, "messages": 0, "lastMessageAt": null } }
```

**`DELETE /channels/{name}`** leaves the channel and deletes its local history.
Response `200`: `{ "left": true }`. Errors: `not_joined`.

**`POST /channels/{name}/messages`** publishes.
Request: `{ "text": string }`, 1 to 16384 bytes of UTF-8.
Response `202`: `{ "message": CastMessage }`. Errors: `invalid_request`, `not_joined`,
`rate_limited` (more than `limits.castPerOriginPerMin` in 60 seconds; `details.retryInMs`).

```json
{ "text": "convoy leaves at dawn" }
```
```json
{ "message": { "seq": 43, "channel": "ops", "chan": "26c32265…504c", "origin": "fxl7…elga", "n": 7,
  "ts": 1794787323000, "text": "convoy leaves at dawn", "at": 1794787323002, "mine": true } }
```

**`GET /channels/{name}/messages`** pages through the history.
Query: `limit`, `before` (a `seq`). Response: `{ channel, items: CastMessage[], nextBefore }`.
Errors: `not_joined`.

```json
{ "channel": "ops", "items": [
    { "seq": 43, "channel": "ops", "chan": "26c32265…504c", "origin": "fxl7…elga", "n": 7,
      "ts": 1794787323000, "text": "convoy leaves at dawn", "at": 1794787323002, "mine": true },
    { "seq": 42, "channel": "ops", "chan": "26c32265…504c", "origin": "mapw…c4va", "n": 3,
      "ts": 1794787310000, "text": "copy", "at": 1794787310090, "mine": false }
  ], "nextBefore": 42 }
```

Items are in local arrival order. Per sender, `n` gives the publishing order; across
senders only the senders' own `ts` is available.

### 6.7 Files

**`POST /files`** offers a file to a node. The node reads the file from its own
filesystem; the path is resolved by the node process.

Request: `{ "to": NodeId, "path": string, "name"?: string }`; `name` (1 to 255 bytes)
overrides the file name shown to the receiver.
Response `202`: `{ "transfer": Transfer }` in state `preparing`. Errors:
`invalid_request`, `invalid_file`, `unknown_destination`.

```json
{ "to": "v5lj…g5iq", "path": "C:/Users/me/Documents/map.pdf" }
```
```json
{ "transfer": { "id": "83f1535f99ab0bf4e9d02dfd85d3e3f7", "direction": "send", "peer": "v5lj…g5iq",
  "name": "map.pdf", "size": 1843200, "sha256": null, "chunkSize": 32768, "chunks": 57,
  "state": "preparing", "bytesDone": 0, "chunksDone": 0, "rateBps": 0,
  "createdAt": 1794787323500, "updatedAt": 1794787323500,
  "path": "C:/Users/me/Documents/map.pdf", "error": null } }
```

**`GET /files`** returns `{ transfers: Transfer[], asOf }`: every active transfer and the
200 most recently finished, newest first.

```json
{ "transfers": [{ "id": "83f1535f99ab0bf4e9d02dfd85d3e3f7", "direction": "send", "peer": "v5lj…g5iq",
    "name": "map.pdf", "size": 1843200, "sha256": "r1af+PFt82DwaCdT7pgpWdEvc9l8jcXXEJkSj6G1N1E=",
    "chunkSize": 32768, "chunks": 57, "state": "sending", "bytesDone": 1048576, "chunksDone": 32,
    "rateBps": 412300.5, "createdAt": 1794787323500, "updatedAt": 1794787327900,
    "path": "C:/Users/me/Documents/map.pdf", "error": null }],
  "asOf": { "boot": "9f2c1a7b", "seq": 1101 } }
```

**`GET /files/{id}`** returns `{ transfer: Transfer }` for one transfer id. Errors:
`not_found`.

```json
{ "transfer": { "id": "83f1535f99ab0bf4e9d02dfd85d3e3f7", "direction": "send", "state": "completed",
  "bytesDone": 1843200, "chunksDone": 57, "error": null, "…": "…" } }
```

**`POST /files/{id}/accept`** accepts an incoming offer in state `offered`.
**`POST /files/{id}/reject`** declines it.
**`POST /files/{id}/cancel`** stops a transfer in any unfinished state, in either
direction; a partial download is deleted.
No body. Response `200`: `{ "transfer": Transfer }`. Errors: `not_found`, `invalid_state`.

```json
{ "transfer": { "id": "83f1535f99ab0bf4e9d02dfd85d3e3f7", "direction": "receive", "peer": "fxl7…elga",
  "name": "map.pdf", "size": 1843200, "sha256": "r1af+PFt82DwaCdT7pgpWdEvc9l8jcXXEJkSj6G1N1E=",
  "chunkSize": 32768, "chunks": 57, "state": "receiving", "bytesDone": 0, "chunksDone": 0,
  "rateBps": 0, "createdAt": 1794787324100, "updatedAt": 1794787330000, "path": null, "error": null } }
```

Whether an incoming offer needs `accept` depends on `config.files.accept`: `ask` (the
offer waits in state `offered`), `auto`, or `deny`. Received files are written only inside
`config.files.downloadsDir`, under a sanitized name; `path` is set when the file is
complete and verified.

### 6.8 Diagnostics

**`POST /diag/ping`** sends probes and answers when all have been answered or timed out.
While it runs, a `diag.ping` event is emitted per probe.

Request: `{ "to": NodeId, "count"?: 1..100 (default 4), "intervalMs"?: 10..60000
(default 1000), "timeoutMs"?: 100..60000 (default 5000) }`.
Response `200`: PingResult. Errors: `invalid_request`, `busy`. An unreachable or silent
destination is not an error: the result reports the loss.

```json
{ "to": "v5lj…g5iq", "count": 3 }
```
```json
{ "dst": "v5lj…g5iq", "sent": 3, "received": 3, "lossPct": 0,
  "rttMs": { "min": 14.2, "avg": 15.1, "max": 16.4 },
  "probes": [ { "seq": 1, "id": "…", "rttMs": 14.2, "hops": 2 },
              { "seq": 2, "id": "…", "rttMs": 14.7, "hops": 2 },
              { "seq": 3, "id": "…", "rttMs": 16.4, "hops": 2 } ] }
```

**`POST /diag/traceroute`** probes hop by hop; a `diag.trace_hop` event is emitted per hop.

Request: `{ "to": NodeId, "maxHops"?: 1..limits.ttl, "timeoutMs"?: 100..60000 (default 3000) }`.
Response `200`: TraceResult. Errors: `invalid_request`, `busy`.

```json
{ "dst": "v5lj…g5iq", "reached": true, "hops": [
    { "n": 1, "node": "mapw…c4va", "rttMs": 3.9 },
    { "n": 2, "node": "v5lj…g5iq", "rttMs": 15.0 } ] }
```

A hop with `node: null` did not answer within the timeout (it may not know this node's
identity card, or it rate-limited the reply). After three such hops in a row the trace
stops, so `hops` then ends with three `node: null` entries and `reached` is false: nothing
beyond a cut will answer, and waiting out every remaining hop helps nobody. Without any
route to the destination nothing is sent and the three entries come back at once. Each
`node` is authenticated: the answer is sealed by the node that reports itself.

**`GET /diag/counters`** returns a CountersSnapshot.

```json
{ "at": 1794787323456, "uptimeMs": 123456, "windowMs": 10000,
  "totals": { "peers.links": 2, "forwarder.forwarded": 318, "forwarder.dropped_ttl": 0,
              "messaging.acked": 11, "router.spfRuns": 41, "services.cast.published": 7 },
  "rates":  { "forwarder.forwarded": 2.4, "peers.bytesIn": 1830.5 } }
```

`totals` has one integer per counter, named `<module>.<counter>` (services under
`services.<name>.`); the counter names are listed per module in ARCHITECTURE.md. `rates`
has, for every counter that moved in the window, its change per second.

**`GET /diag/events`** reads the event ring buffer without opening a stream.
Query: `since` (integer `seq`; events after it, oldest first), `limit` (default 200,
maximum 1000), `types` (comma-separated, as in section 8.3). Without `since`, the newest
`limit` events. Response: `{ boot, lastSeq, oldestSeq, events: Event[] }`.

```json
{ "boot": "9f2c1a7b", "lastSeq": 1042, "oldestSeq": 1, "events": [
    { "seq": 1041, "ts": 1794787320150, "type": "lsa.originated", "data": { "seq": 1794787320113, "links": 1, "reason": "refresh" } },
    { "seq": 1042, "ts": 1794787322901, "type": "link.metric", "data": { "peer": "mapw…c4va", "rttMs": 1.8, "srttMs": 2.1, "cost": 3, "misses": 0 } } ] }
```

**`GET /diag/sync`** returns `{ datasets: [{ name: string, entries: integer }],
engine: object }`. `datasets` lists `lsa`, `peer`, `cast` and `receipt` with the number of
records held. `engine` is the object returned by `SyncEngine#stats()`: non-negative
integers. Its members are `published`, `recordsIn`, `accepted`, `ignored`, `invalid`,
`recordsOut`, `gossipIn`, `gossipOut`, `gossipDropped`, `digestsIn`, `digestsOut`,
`requestsIn`, `requestsOut`, `deltasIn`, `deltasOut`, `roundsStarted`, `roundsCompleted`,
`roundsAbandoned`, `roundsDeclined`, `roundsServed`, `roundsRefused`, `staleDigests`,
`staleReplies`, `unknownSets`, `strayPackets`, `unsendable`, `sendFailures`, `faults`,
`peers`, `pending`, `activeRounds`; `sync/antientropy.js` is the authority for their
meaning, and clients should display members they do not know generically.

```json
{ "datasets": [ { "name": "lsa", "entries": 3 }, { "name": "peer", "entries": 3 },
                { "name": "cast", "entries": 42 }, { "name": "receipt", "entries": 0 } ],
  "engine": { "published": 61, "recordsIn": 88, "accepted": 74, "ignored": 14, "invalid": 0,
              "recordsOut": 96, "roundsStarted": 18, "roundsCompleted": 18, "faults": 0,
              "peers": 2, "pending": 0, "activeRounds": 0, "…": 0 } }
```

### 6.9 `GET /mailbox` (not implemented)

The endpoint was designed to show what a node holds in custody for others (deposits,
receipts, quotas). The mailbox service that would serve it is not built, so the node
answers it like any unknown path:

```json
{ "error": { "code": "not_found", "message": "no such endpoint" } }
```

The `mailbox` section of the configuration (section 6.10) and `caps.mailbox` exist, but
nothing reads them. A client must not depend on this endpoint.

### 6.10 `GET /config`

Returns `{ dataDir: string, config: object, redacted: string[] }`. `config` is the
effective, validated configuration with the structure of `core/config.js`. Secret values
are replaced by the string `"[redacted]"` when set and left `null` when unset; `redacted`
lists their paths. In v1 the only secret is `networkKey`. The configuration cannot be
changed through the API; edit `config.json` and restart.

```json
{ "dataDir": "C:/Users/me/AppData/Roaming/clawnet",
  "config": { "networkId": "clawnet-main", "networkKey": "[redacted]",
              "listen": { "host": "0.0.0.0", "port": 47470 }, "advertise": [],
              "api": { "enabled": true, "host": "127.0.0.1", "port": 47480, "…": "…" },
              "…": "…" },
  "redacted": ["networkKey"] }
```

### 6.11 `POST /shutdown`

Stops the node cleanly. No body (or `{}`). Response `202`: `{ "stopping": true }`. The
response is sent first; then links are closed with a goodbye, stores are flushed and the
process of a `clawnet start` exits with status 0. Open event streams receive
`node.stopping` and are then closed.

## 7. Types

Types used by more than one endpoint or event.

**`ChatMessage`**

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer | local order; paging cursor |
| `id` | Id | message id |
| `peer` | NodeId | the other party |
| `direction` | `"in"` \| `"out"` | |
| `text` | string | |
| `ts` | Ms | the sender's clock when it was sent |
| `at` | Ms | this node's clock when it was recorded |
| `state` | string | outgoing: `queued`, `sent` (transmitted at least once), `custody` (a mailbox holds a copy; never occurs, as no mailbox service exists), `delivered` (acknowledged by the recipient), `expired`. Incoming: `received` |

An incoming message's `peer` is authenticated: the message was sealed with that node's key.

**`ConversationSummary`**: `{ peer: NodeId, count: integer, lastAt: Ms, last: ChatMessage }`.

**`OutboxEntry`**

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | Id | |
| `dst` | NodeId | |
| `kind` | string | `msg`, `file-offer`, `custody-deposit`, … |
| `bytes` | integer | size of the sealed packet |
| `createdAt`, `expiresAt` | Ms | |
| `attempts` | integer | transmissions so far |
| `nextAttemptAt` | Ms \| null | null while waiting for a route |
| `state` | `"waiting"` \| `"backoff"` | `waiting`: no route to `dst` |
| `custodian` | NodeId \| null | mailbox asked to hold a copy. Always null: no mailbox service exists |
| `custodyState` | `"pending"` \| `"accepted"` \| `"refused"` \| null | always null, for the same reason |
| `custody` | boolean | whether the message may be deposited (true by default, with no effect) |

**`ChannelInfo`**: `{ name: string, chan: Id, encrypted: boolean, joinedAt: Ms,
messages: integer, lastMessageAt: Ms | null }`.

**`CastMessage`**

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer | local arrival order; paging cursor |
| `channel` | string | channel name |
| `chan` | Id | channel wire id |
| `origin` | NodeId | the publisher (signature verified) |
| `n` | integer | the publisher's counter in this channel, from 1 |
| `ts` | Ms | the publisher's clock |
| `text` | string | |
| `at` | Ms | local arrival |
| `mine` | boolean | published by this node |

**`Transfer`**

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | Id | transfer id |
| `direction` | `"send"` \| `"receive"` | |
| `peer` | NodeId | |
| `name` | string | file name as offered (not sanitized; display only) |
| `size` | integer | bytes |
| `sha256` | Base64 \| null | null while `preparing` |
| `chunkSize`, `chunks` | integer | |
| `state` | string | `preparing`, `offered`, `sending`, `receiving`, `paused`, `verifying`, `completed`, `rejected`, `cancelled`, `failed` |
| `bytesDone`, `chunksDone` | integer | acknowledged (send) or stored (receive) |
| `rateBps` | number | bytes per second over the last seconds |
| `createdAt`, `updatedAt` | Ms | |
| `path` | string \| null | send: the source path. Receive: the final path once `completed`, else null |
| `error` | string \| null | reason when `failed`, `rejected` or `cancelled` |

**`PingResult`**: `{ dst: NodeId, sent: integer, received: integer, lossPct: number,
rttMs: { min: number, avg: number, max: number } | null,
probes: [{ seq: integer, id: Id, rttMs: number | null, hops: integer | null }] }`.

**`TraceResult`**: `{ dst: NodeId, reached: boolean,
hops: [{ n: integer, node: NodeId | null, rttMs: number | null }] }`.

**`CountersSnapshot`**: `{ at: Ms, uptimeMs: Ms, windowMs: Ms,
totals: { [name]: integer }, rates: { [name]: number } }`.

**`Event`**: `{ seq: integer, ts: Ms, type: string, data: object | null }`.

## 8. Event stream

`GET /api/v1/events` is a `text/event-stream` of everything the node's event bus emits.
It is read with `fetch` and a stream reader so that the token travels in the
`Authorization` header; the browser's `EventSource` cannot set headers and is not used.

```js
const res = await fetch('/api/v1/events?types=link.*,topology.changed', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Last-Event-ID': lastId ?? '' },
  signal,
});
// read res.body, split on blank lines, parse "id:", "event:", "data:" lines
```

### 8.1 Framing

Response headers: `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-store`, `X-Accel-Buffering: no`. The body follows the server-sent
events format: UTF-8 lines ending in `\n`, events separated by a blank line.

```
retry: 2000

event: stream.hello
data: {"boot":"9f2c1a7b","nodeId":"fxl7tt5ojvwq5qk5m7nd6ekswwt4hjukrlt2qwnkyns2kmreelga","lastSeq":1042,"oldestSeq":1,"resumed":false}

id: 9f2c1a7b-1043
event: link.up
data: {"seq":1043,"ts":1794787330120,"type":"link.up","data":{"peer":"v5lj76hrnxzwb4die5j65gbjlhis646zpsg4lvyqteji7invg5iq","linkId":"4","direction":"in","addr":"tcp://192.168.1.44:51522","agent":"clawnet/0.1.0","caps":{"relay":true,"mailbox":false,"transit":true},"rttMs":2.2,"cost":3}}

: ka

```

- Each bus event is one SSE event: `id` is `<boot>-<seq>`, `event` is the event type,
  `data` is the whole `Event` object as one line of JSON.
- `stream.hello` is always first. `stream.hello` and `stream.gap` are produced by the
  stream itself, carry no `id`, and are not bus events.
- Events are delivered in `seq` order without gaps, except as announced by `stream.gap`.

### 8.2 Resume

A client remembers the `id` of the last event it processed and sends it as
`Last-Event-ID` when it reconnects (the query parameter `since=<boot>-<seq>` is
equivalent; the header wins).

- The boot id matches and the ring buffer still holds `seq + 1`: the server replays
  everything after `seq`, then continues live. `stream.hello` has `resumed: true`.
- The boot id matches but older events were already dropped from the ring buffer (5000
  events): the server sends `stream.gap` with `{ "reason": "overflow", "from": <seq + 1>,
  "to": <oldestSeq - 1> }`, then everything it still has.
- The boot id differs (the node restarted): `stream.gap` with `{ "reason": "restart" }`,
  then live events from now.
- The id names a `seq` beyond the last event of this boot (it cannot have come from this
  node): treated as `restart`.
- No `Last-Event-ID` (or an empty one): live events from now.
- A malformed id (not `<8 hex>-<integer>`) is `400 invalid_request`, as is a `types`
  list with an item that is neither an event type nor a prefix ending in `.*`.

After a `stream.gap` the client's picture may be wrong: it refetches the snapshots it
shows (section 9). A server that must drop a slow client (its queue exceeds 1 MiB) closes
the connection; the client reconnects and resumes the same way.

### 8.3 Filtering

`types` is a comma-separated list; each item is an exact event type or a prefix ending in
`.*` (`packet.*`). Without it, every event is sent. Filtering does not create gaps:
`seq` values of filtered-out events are simply skipped, and the client must not treat a
jump in `seq` as loss; only `stream.gap` signals loss.

### 8.4 Keep-alive and limits

A comment line `: ka` is sent every 15 seconds so that idle streams and intermediaries do
not time out. A client that sees nothing for 45 seconds should reconnect. At most 16
streams are open at once (`503 too_many_streams`). `retry: 2000` suggests the reconnect
delay.

### 8.5 Event types

`data` of each event. NodeIds: `peer`, `origin`, `dst`, `from`, `nextHop`, `custodian`,
`depositor`. `id` is a message or packet id unless stated. `type` inside packet events is
`"data"` or `"probe"`. Lists are capped at 500 items; a cut list comes with
`truncated: true`. ARCHITECTURE.md section 9 is the normative copy of this table and
names the emitting module.

**Node**

| Event | Data |
| --- | --- |
| `node.started` | `{ nodeId, boot, agent, networkId, listen: Address \| null }` |
| `node.stopping` | `{ reason }` |
| `node.stopped` | `{}` |
| `internal.error` | `{ where, code: string \| null, message }` |
| `internal.listener_error` | diagnostic of the event bus itself |
| `store.recovered` | `{ file, movedTo }` a damaged state file was set aside |
| `sync.peer_error` | `{ peer, reason, detail }` a peer broke the sync protocol (for example relayed an invalid record) and was disconnected |
| `traffic.sample` | `{ intervalMs, links: [{ peer, packetsIn, packetsOut, bytesIn, bytesOut }], forwarder: { originated, forwarded, delivered, queued, dropped }, suppressed }` deltas since the previous sample (about every 500 ms; not sent when idle) |

**Peers and discovery**

| Event | Data |
| --- | --- |
| `peer.dialing` | `{ addr, peer: NodeId \| null, source, attempt }` |
| `peer.dial_failed` | `{ addr, peer: NodeId \| null, reason, retryInMs: integer \| null }` (`retryInMs` is null when the address will not be redialled) |
| `peer.refused` | `{ addr, peer, direction, reason }` |
| `link.up` | `{ peer, linkId, direction, addr, agent, caps, rttMs, cost }` |
| `link.down` | `{ peer, linkId, reason, remote: boolean, durationMs }`; `reason` is a BYE reason (ARCHITECTURE.md 4.1), or `auth`, `eof`, `socket`, `overflow` or `unknown` |
| `link.metric` | `{ peer, rttMs: number \| null, srttMs, cost, misses }` once per keepalive per link |
| `link.throttled` | `{ peer, by: "packets" \| "bytes" }` |
| `discovery.candidate` | `{ addr, peer: NodeId \| null, source }` |
| `discovery.error` | `{ source, message }` |
| `peer.record` | `{ peer, seq, addrs: Address[], caps }` |
| `peer.equivocation` | `{ peer, seq }` two different valid peer records of one origin with one `seq` |
| `discovery.clone_suspected` | `{ peer, seq, bumps }` another node appears to use this node's identity; `peer` is this node |

**Routing**

| Event | Data |
| --- | --- |
| `lsa.originated` | `{ seq, links: integer, reason }` |
| `lsa.accepted` | `{ origin, seq, changed: boolean, from: NodeId \| null }` |
| `lsa.expired` | `{ origin }` |
| `lsa.equivocation` | `{ origin, seq }` two different valid LSAs of one origin with one `seq` |
| `routes.changed` | `{ rev, total, reachable: NodeId[], unreachable: NodeId[], changed: integer }` |
| `topology.changed` | `{ rev, full: boolean, nodesAdded: [{ id, caps }], nodesUpdated: [{ id, caps }], nodesRemoved: NodeId[], linksAdded: TopologyLink[], linksUpdated: TopologyLink[], linksRemoved: [{ a, b }] }` |

**Packets** (this node's own activity; rate-capped at 200 events per second)

| Event | Data |
| --- | --- |
| `packet.sent` | `{ id, type, dst, nextHop, try: integer \| null, bytes, path: NodeId[] \| null }` this node originated a packet; `path` is its predicted route, this node first |
| `packet.forwarded` | `{ id, type, dst, from, nextHop, ttl, bytes }` this node passed on someone else's packet |
| `packet.delivered` | `{ id, type, from, bytes }` a packet addressed to this node arrived from neighbour `from` |
| `packet.queued` | `{ id, type, dst, from, reason, queued: integer }` held in the transit queue: `no-route`, `split-horizon`, `backpressure` |
| `packet.dropped` | `{ id, type, dst, from: NodeId \| null, reason }`: `ttl`, `duplicate`, `no-transit`, `transit-full`, `hold-expired`, `malformed`, `no-handler`, `oversize`, `auth` |

**Messages**

| Event | Data |
| --- | --- |
| `message.queued` | `{ id, dst, kind, bytes }` |
| `message.sent` | `{ id, dst, kind, attempt, nextHop }` each transmission, `attempt` from 1 |
| `message.waiting` | `{ id, dst, kind }` no route |
| `message.acked` | `{ id, dst, kind, attempts, elapsedMs }` |
| `message.expired`, `message.cancelled` | `{ id, dst, kind }` |
| `message.received` | `{ id, from, kind, bytes, prevHop, viaCustody: NodeId \| null }` |
| `message.duplicate` | `{ id, prevHop, viaCustody: NodeId \| null }` |
| `message.unhandled` | `{ id, from, kind }` |
| `message.handler_error` | `{ id, from, kind, message }` |
| `chat.message` | `{ message: ChatMessage }` |
| `chat.state` | `{ id, peer, state }` |

**Channels, files, diagnostics, API**

| Event | Data |
| --- | --- |
| `cast.joined` | `{ name, chan, encrypted }` |
| `cast.left` | `{ name, chan }` |
| `cast.message` | `{ message: CastMessage }` |
| `cast.rejected` | `{ origin, chan, reason }` |
| `file.offered`, `file.incoming`, `file.accepted`, `file.rejected`, `file.completed`, `file.failed`, `file.cancelled` | `{ transfer: Transfer }` |
| `file.progress` | `{ id, direction, bytesDone, size, chunksDone, chunks, rateBps }` at most 4 per second per transfer; `id` is the transfer id |
| `file.paused` | `{ id, reason }` |
| `file.resumed` | `{ id }` |
| `diag.ping` | `{ dst, seq, id, rttMs: number \| null, hops: integer \| null }` |
| `diag.trace_hop` | `{ dst, n, node: NodeId \| null, rttMs: number \| null, reached: boolean }` |
| `api.listening` | `{ host, port }` |
| `api.denied` | `{ reason: "host" \| "origin" \| "token", remote }` (at most one per second) |

The custody events (`custody.deposited`, `custody.refused`, `custody.stored`,
`custody.forwarded`, `custody.purged`, `custody.receipt`) belong to the unbuilt mailbox
service. They are never emitted, and the console does not use them.

## 9. Building a live view without polling

The pattern for every panel is the same: open the stream, fetch a snapshot, then apply
events newer than the snapshot.

1. Open `GET /events` (with the type filter the view needs) and buffer what arrives.
2. Fetch the snapshot. Note its `asOf`.
3. Discard buffered events with `seq <= asOf.seq`, apply the rest, then apply live events.
4. On `stream.gap`, or when `stream.hello.boot` differs from the snapshot's `asOf.boot`,
   or when `topology.changed` has `full: true`: go back to step 2.

| View | Snapshot | Events to apply |
| --- | --- | --- |
| Network graph | `GET /topology` | `topology.changed` (add, update and remove nodes and links by id; keep `rev`), `link.up` / `link.down` (mark the neighbour `linked`), `link.metric` (live cost and RTT of this node's own links) |
| Route overlay | `GET /topology/routes` | `routes.changed` says which destinations appeared or vanished and how many changed; refetch the routes when `changed > 0` or either list is non-empty (the table is small) |
| Peers | `GET /peers` | `link.up`, `link.down`, `link.metric`, `link.throttled`, `peer.dialing`, `peer.dial_failed` |
| Chat | `GET /conversations`, `GET /conversations/{id}` | `chat.message`, `chat.state` |
| Outbox | `GET /outbox` | `message.queued`, `message.sent`, `message.waiting`, `message.acked`, `message.expired`, `message.cancelled` |
| Channels | `GET /channels`, history | `cast.joined`, `cast.left`, `cast.message` |
| Files | `GET /files` | `file.*` |

**Animating packet activity.** Each packet event names the two ends of the hop it
concerns, so it maps onto an edge of the graph:

| Event | Draw |
| --- | --- |
| `packet.sent` | a packet leaving this node towards `nextHop`; `path`, when present, is the route this node expects it to take and may be animated end to end as a prediction |
| `packet.forwarded` | a packet arriving from `from` and leaving towards `nextHop` |
| `packet.delivered` | a packet arriving at this node from `from` |
| `packet.queued` | a packet from `from` parked at this node |
| `packet.dropped` | a packet from `from` (or originated here when `from` is null) discarded at this node, with the reason |
| `message.sent`, `message.acked` | the start and end of one message's life: join them by `id` to show delivery time; `packet.*` events with the same `id` are its hops as seen from this node |
| `traffic.sample` | bulk flow: per-link packet and byte counts for the last interval. File chunks appear only here (and in `file.progress`), not as individual packet events. `suppressed` counts packet events that were withheld by the rate cap in that interval |

What the stream shows is what **this node** did and saw. It observes a packet at the
moment it sends, forwards, receives or drops it; it does not observe hops between other
nodes. `packet.sent.path` is a prediction from this node's routing table, not a trace;
`POST /diag/traceroute` measures the real path. A view of several nodes (for example a
devnet) is built by connecting to each node's API and merging by packet `id`.

Nothing in any event or endpoint exposes the content of messages this node merely
forwards: the node cannot read them.
