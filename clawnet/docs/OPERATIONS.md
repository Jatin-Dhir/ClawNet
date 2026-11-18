# Operating a ClawNet node

How to run, configure, back up, upgrade and diagnose a node. Every command shown here that
begins with `node bin/clawnet.js` was run while writing this document, on one Windows 11
machine with Node 26.12, in a throwaway data directory. Where something was not run, the
text says so. Commands are written for a shell in the `clawnet/` directory; `clawnet` in the
prose means `node bin/clawnet.js`.

Contents: 1 requirements · 2 the data directory · 3 configuration · 4 running a node ·
5 running as a service · 6 network ports and the firewall · 7 a private network ·
8 backup and identity · 9 upgrading · 10 troubleshooting · 11 what is not covered.

## 1. Requirements

- Node.js 22.12 or later. The engine has no dependencies and nothing to install; it is
  started with `node bin/clawnet.js`. (The CI workflow tests Node 22 and 24.)
- A user account that can create a directory and listen on a TCP port.
- Optional: building the console (`console/`) needs `npm install` there; the node serves the
  built files from `ui/`. A checkout without `ui/` still works; the API answers a plain-text
  page where the console would be.

## 2. The data directory

One process owns a data directory. It holds the node's identity and everything the node
remembers.

**Where it is.** The first of these that applies:

1. `--data-dir <dir>` (`-d`) on the command line;
2. the environment variable `CLAWNET_HOME`;
3. Windows: `%APPDATA%\clawnet`, or `~\AppData\Roaming\clawnet` if `APPDATA` is unset;
4. otherwise `~/.clawnet`.

Creating it uses mode `0700` on POSIX systems, and tightens a looser mode on an existing
directory. On Windows there are no POSIX modes: the directory inherits the access rules of its
parent, so keep it under your own profile. That has not been checked with `icacls`.

**Layout.** This is what a node that has run, joined a network, received a message and a
file, and joined a channel looks like. "sealed" files are encrypted with the keystore's
storage key; the others are readable by anyone who can read the directory.

```
<dataDir>/
  keystore.json          identity keys and storage key; encrypted only if a passphrase was set
  network-id             the network this identity was created for; the node refuses another
  config.json            optional settings; `init` writes {"networkId": ...}
  api-token              64 hex characters; the control API's bearer token
  lock                   pid of the owning process; removed on clean stop
  runtime.json           { pid, boot, nodeId, listen, api, startedAt }; removed on clean stop
  state.json             own LSA sequence and peer-record sequence
  lsdb-seqs.json         highest LSA sequence seen per origin (replay protection)
  peers.json             the address book
  peer-records.json      signed peer records: the card directory
  seen.log               sealed: ids of delivered messages (replay cache)
  outbox.log, outbox/    sealed: messages waiting for acknowledgement
  conversations.log      sealed: chat history
  services/cast/         sealed: channels (with their keys) and history
  services/files/        sealed: transfer state, per-chunk hashes, receive bitmaps
  downloads/             received files, plain, in `files.downloadsDir`
```

Directories under `services/` also exist for `api`, `diag` and `messages`; they stay empty.
`devnet` nodes also write `node.log`. A state file that cannot be parsed is moved aside as
`<name>.corrupt-<timestamp>` and the node starts from defaults, with a `store.recovered`
event; nothing is deleted.

**Network binding.** `init` records the network id in `network-id`, and a node refuses to
start with a different one, because signed records and identity cards do not name their
network:

```
$ node bin/clawnet.js -d DIR start --network other
clawnet: networkId: the data directory belongs to network "clawnet-main", not "other"; use another data directory or the original network id
```

## 3. Configuration

Four layers, later ones winning: built-in defaults, then the config file, then `CLAWNET_*`
environment variables, then command-line flags. The config file is `<dataDir>/config.json`,
or the file named by `CLAWNET_CONFIG`. It is JSON, shaped as below.

Validation is strict. An unknown key is an error, every number has a range, and settings that
only make sense together are checked together. The error names the setting and never repeats
its value, because one setting is a secret:

```
$ node bin/clawnet.js -d DIR start      (config.json contains {"bogus": 1})
clawnet: bogus: unknown setting
$ node bin/clawnet.js -d DIR start      (config.json contains {"timers": {"keepaliveMs": 40000}})
clawnet: timers.peerTimeoutMs: must be greater than timers.keepaliveMs
```

`clawnet config` prints the effective configuration of a running node with `networkKey`
replaced by `"[redacted]"`. The configuration cannot be changed through the API; edit
`config.json` and restart.

### 3.1 Settings

Durations are milliseconds. All timers are settings, which is how the tests run the real code
with short intervals; the defaults suit a real network.

| Setting | Default | Meaning |
| --- | --- | --- |
| `networkId` | `"clawnet-main"` | Network name, 1 to 64 of `[A-Za-z0-9._-]`. Nodes with different names cannot link. |
| `networkKey` | `null` | Base64 of exactly 32 bytes. When set, links use Noise `XXpsk0` and nodes without it cannot join (section 7). |
| `listen.host` | `"0.0.0.0"` | Address the peer listener binds. |
| `listen.port` | `47470` | Peer TCP port; 0 lets the OS choose. |
| `advertise` | `[]` | Addresses (`tcp://host:port`, at most 16) announced to other nodes in addition to the ones peers report seeing. |
| `api.enabled` | `true` | Serve the control API. |
| `api.host` | `"127.0.0.1"` | API bind address; must be loopback unless `api.allowRemote`. |
| `api.port` | `47480` | API port; 0 lets the OS choose. |
| `api.allowedHosts` | `["127.0.0.1","localhost","[::1]"]` | `Host` values the API accepts (defeats DNS rebinding). |
| `api.corsOrigins` | `[]` | Origins allowed to call the API from a browser; empty means no CORS headers. |
| `api.serveUi` | `true` | Serve the built console from `ui/`. |
| `api.allowRemote` | `false` | Permit a non-loopback `api.host`. The token then travels in clear text over HTTP. |
| `discovery.multicast.enabled` | `true` | Send and receive LAN beacons. |
| `discovery.multicast.group` | `"239.255.67.78"` | IPv4 multicast group. |
| `discovery.multicast.port` | `47470` | UDP port. |
| `discovery.multicast.interface` | `null` | IPv4 address of the local interface to use; null lets the OS choose. |
| `discovery.bootstrap` | `[]` | Addresses dialled at start and whenever the node has too few peers (at most 256). |
| `discovery.pex` | `true` | Learn and dial addresses from signed peer records. |
| `discovery.allowLoopback` | `false` | Dial loopback, unspecified, multicast and link-local addresses learned from the network. For single-machine networks only. |
| `peers.target` | `8` | Peer count the node tries to keep. |
| `peers.max` | `64` | Most simultaneous links (1 to 4096). |
| `peers.allow` | `[]` | NodeIds allowed to connect and whose records are accepted; empty means anyone. |
| `peers.block` | `[]` | NodeIds always refused, links and records. |
| `caps.relay` | `true` | Advertise willingness to relay (a dial preference only). |
| `caps.mailbox` | `false` | **Leave false.** The mailbox service is not built; true advertises something the node does not do. |
| `caps.transit` | `true` | Allow routes through this node. |
| `timers.keepaliveMs` | `10000` | Ping interval on an idle link. |
| `timers.peerTimeoutMs` | `30000` | Silence after which a link is closed; must exceed `keepaliveMs`. |
| `timers.handshakeTimeoutMs` | `10000` | Time allowed for a link handshake. |
| `timers.redialMinMs`, `redialMaxMs`, `redialJitter` | `1000`, `60000`, `0.2` | Redial backoff and its random spread (a fraction). `redialMaxMs` is also how long a misbehaving peer is refused. |
| `timers.lsaRefreshMs` | `60000` | Re-advertisement of the node's own link-state record. |
| `timers.lsaMaxAgeMs` | `210000` | Age since receipt at which a record expires. |
| `timers.lsaTombstoneMs` | `86400000` | How long the highest sequence of an expired record is remembered. |
| `timers.lsaMinIntervalMs` | `5000` | Least time between two records from one origin; must be below `lsaMaxAgeMs`. |
| `timers.spfDebounceMs` | `50` | Delay before routes are recomputed after a change. |
| `timers.syncIntervalMs` | `20000` | Interval between anti-entropy rounds. |
| `timers.gossipBatchMs` | `25` | How long new records are batched before being pushed. |
| `timers.retransmitMinMs`, `retransmitMaxMs`, `retransmitJitter` | `2000`, `900000`, `0.2` | Retransmission backoff of reliable messages. |
| `timers.transitHoldMs` | `30000` | How long a forwarder holds a packet with no route. |
| `timers.forwardDedupeTtlMs` | `60000` | How long a forwarder remembers a packet it forwarded. |
| `timers.beaconIntervalMs` | `5000` | Interval between LAN beacons. |
| `limits.ttl` | `16` | Hop limit of new packets, 1 to 32. |
| `limits.messageLifetimeMs` | `604800000` | How long a message is retried and its id remembered (7 days). |
| `limits.seenCacheEntries` | `100000` | Message ids remembered for duplicate and replay suppression. |
| `limits.outboxMaxEntries`, `outboxMaxBytes` | `10000`, `268435456` | Messages waiting for acknowledgement. |
| `limits.transitQueueMax` | `1000` | Packets held for destinations without a route; 0 disables holding. |
| `limits.peerPacketsPerSec`, `peerBytesPerSec` | `2000`, `16777216` | Per-peer receive budget for control packets. Over budget, reading from that link pauses. |
| `limits.dataPacketsPerSec`, `dataBytesPerSec` | `1000`, `8388608` | Per-peer budget for routed packets. Over budget, packets are dropped and counted. |
| `limits.castPerOriginPerMin` | `60` | Casts accepted per origin per minute; 0 refuses all. Enforced as at most 63. |
| `limits.maxClockSkewMs` | `300000` | Clock difference tolerated between nodes (section 10). |
| `limits.maxInFlightPerDestination` | `4` | Unacknowledged messages in flight to one destination. |
| `limits.maxOrigins` | `10000` | Most origins any per-origin table holds. |
| `limits.newOriginsPerPeerPerMin` | `120` | Unknown origins one neighbour may introduce per minute. |
| `limits.dialsPerSecond` | `5` | Global cap on outgoing connection attempts. |
| `limits.beaconsPerSourcePerMin`, `beaconsPerMin` | `30`, `600` | LAN beacons accepted per source and in total, before any signature check. |
| `limits.maxMessageBytes` | `98304` | Largest sealed message (meta and content). |
| `files.downloadsDir` | `<dataDir>/downloads` | Where received files are written. |
| `files.chunkSize` | `32768` | Plaintext bytes per file chunk, 64 to 114688. |
| `files.window` | `32` | Most chunks in flight per transfer. |
| `files.accept` | `"ask"` | What to do with an incoming offer: `ask` (wait for `accept`), `auto`, `deny`. |
| `files.maxSizeBytes` | `4294967296` | Largest file accepted. Free disk space is not checked. |
| `mailbox.*` | | Quotas for the unbuilt mailbox service. No effect. |
| `log.level` | `"info"` | `debug`, `info`, `warn`, `error`. |

### 3.2 Environment variables and flags

| Variable | Setting |
| --- | --- |
| `CLAWNET_HOME` | the data directory |
| `CLAWNET_CONFIG` | path of the config file |
| `CLAWNET_NETWORK` | `networkId` |
| `CLAWNET_NETWORK_KEY` | `networkKey` |
| `CLAWNET_LISTEN_HOST`, `CLAWNET_LISTEN_PORT` | `listen.host`, `listen.port` |
| `CLAWNET_ADVERTISE` | `advertise` |
| `CLAWNET_API_ENABLED`, `CLAWNET_API_HOST`, `CLAWNET_API_PORT`, `CLAWNET_API_ALLOW_REMOTE` | `api.*` |
| `CLAWNET_WEBSOCKET`, `CLAWNET_WEBSOCKET_PORT` | `websocket.enabled`, `websocket.port` |
| `CLAWNET_WEBAPP`, `CLAWNET_WEBAPP_PORT` | `webapp.enabled`, `webapp.port` |
| `CLAWNET_BOOTSTRAP` | `discovery.bootstrap` |
| `CLAWNET_MULTICAST`, `CLAWNET_PEX`, `CLAWNET_ALLOW_LOOPBACK` | `discovery.multicast.enabled`, `discovery.pex`, `discovery.allowLoopback` |
| `CLAWNET_PEERS_TARGET`, `CLAWNET_PEERS_MAX` | `peers.target`, `peers.max` |
| `CLAWNET_RELAY`, `CLAWNET_MAILBOX`, `CLAWNET_TRANSIT` | `caps.*` |
| `CLAWNET_DOWNLOADS_DIR`, `CLAWNET_FILES_ACCEPT` | `files.downloadsDir`, `files.accept` |
| `CLAWNET_LOG_LEVEL` | `log.level` |
| `CLAWNET_PASSPHRASE` | the keystore passphrase (not a setting; read by `start`) |
| `CLAWNET_DEBUG=1` | print stack traces from the CLI |

`clawnet start` flags: `--listen host:port`, `--api-port n`, `--bootstrap addr` (repeatable),
`--network id`, `--network-key-file file`, `--multicast` or `--no-multicast`,
`--passphrase-file file`, `--phone` (section 6a), `--websocket-port n`, `--webapp-port n`. Run with `CLAWNET_LOG_LEVEL=warn` it logs less: checked, the effective
configuration showed `"level": "warn"`.

## 4. Running a node

### 4.1 Create an identity

```
$ node bin/clawnet.js -d DIR init --passphrase-file pass.txt
initialised DIR
node id uuhltsb7pd4w6npq23t4fzcvttfdwx3aditoommsjhhitb5d6h2a
```

`--no-passphrase` stores the keys unencrypted, protected only by file permissions, and prints
a warning:

```
$ node bin/clawnet.js -d DIR init --no-passphrase
warning: the keystore is not encrypted; only file permissions protect the identity
```

Without either flag, `init` asks on a terminal. `init` refuses to overwrite an existing
identity. There is no command to change a passphrase or to create a second identity in the same
directory.

### 4.2 Start it

```
$ node bin/clawnet.js -d DIR start --passphrase-file pass.txt
{"ts":...,"level":"info","msg":"node started","mod":"node","listen":"tcp://0.0.0.0:47470"}
{"event":"ready","nodeId":"...","listen":"tcp://0.0.0.0:47470","api":"http://127.0.0.1:47480","dataDir":"DIR"}
```

`start` runs in the foreground. Standard output carries exactly one line, the JSON `ready`
event, so a supervisor can wait for it. Logs are JSON lines on standard error, one object per
line (`ts`, `level`, `mod`, `msg`, plus fields). A passphrase is read from `--passphrase-file`,
else `CLAWNET_PASSPHRASE`, else a hidden prompt on a terminal; with none of them and no
terminal, `start` fails with a usage error (exit 2). A wrong passphrase:

```
clawnet: cannot unlock the keystore in DIR: wrong passphrase, or the file was changed      (exit 1)
```

`start` refuses to run without an identity (`init` first) and refuses a data directory that
another live process owns:

```
clawnet: the data directory DIR is already in use (the data directory is in use by process 51428)      (exit 1)
```

### 4.3 Stopping

`clawnet stop` asks the node to shut down through the API and waits until it has exited,
printing `stopped`. `SIGINT` and `SIGTERM` (and `SIGBREAK` on Windows) also stop it cleanly:
links get a goodbye, stores are flushed, `runtime.json` and `lock` are removed. A second signal
exits at once with status 1. The whole shutdown is limited to 5 seconds; after that sockets and
timers are destroyed and stores are still flushed.

If a node is killed, nothing needs cleaning up: the next `start` finds `lock` naming a dead
process, replaces it and starts. This was tried by killing a node's process and starting it
again on the same directory.

**Windows.** Killing a process with `taskkill /F` or from the Task Manager is a hard
terminate: no signal handler runs. Use `clawnet stop` for a clean stop. Real Ctrl+C in a console
was not tried; the signal path is tested with injected signals.

### 4.4 Using a running node

Client commands talk to the node that owns the same `--data-dir`, through the control API.
They print text, or one JSON document with `--json`. Exit codes: 0 success, 1 failure, 2 usage
error, 3 no node is running (`clawnet: no node is running with the data directory ...`).

| Command | Shows or does |
| --- | --- |
| `id`, `status` | the node id; a summary of the node |
| `peers`, `routes`, `topology` | links and dials; the routing table; the nodes and links known |
| `outbox` | messages not yet acknowledged |
| `counters` | counters and rates by module |
| `config` | the effective configuration |
| `connect <tcp://host:port>`, `disconnect <id>` | dial a peer; close a link |
| `send <id> <text...>`, `inbox [<id>]` | send an end-to-end message; list conversations or one conversation |
| `ping <id> [-c n]`, `trace <id>` | round-trip time; the path hop by hop |
| `events [--types a,b.*] [--count n] [--replay]` | the live event stream, one JSON event per line |
| `ui [--open]` | the console address, with the token after `#` (`--open`, which launches a browser, was not run) |
| `devnet --nodes n [--topology line\|ring\|star\|mesh] [--base-dir d]` | several nodes on this machine |

An id may be shortened to any unique prefix of at least 8 characters. There are no CLI
commands yet for channels or file transfer; use the HTTP API (`API.md`) or the console.

## 5. Running as a service

The contract a supervisor can rely on:

- `clawnet start` runs in the foreground and does not detach. It exits 0 after a clean stop,
  1 on a failure to start or stop.
- Standard output carries one `ready` line when the node is ready; logs go to standard error.
- `SIGTERM` stops it cleanly (POSIX). Allow it 5 seconds.
- The data directory must be writable by the service account and not shared with another node.
- An encrypted keystore needs the passphrase at every start, from a file or an environment
  variable. For an unattended node that stores the passphrase next to the keystore it protects,
  which is little better than no passphrase; the file's permissions are then the protection.

A `systemd` unit written from that contract. **It was not run**: this document was written on
Windows, and no service manager was available to test any unit or task definition.

```ini
[Unit]
Description=ClawNet node
After=network-online.target
Wants=network-online.target

[Service]
User=clawnet
WorkingDirectory=/opt/clawnet/clawnet
Environment=CLAWNET_HOME=/var/lib/clawnet
ExecStart=/usr/bin/node bin/clawnet.js start --passphrase-file /etc/clawnet/passphrase
Restart=on-failure
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

Nothing has been written or tested for Windows services, `launchd` or containers. On Windows
the equivalent is any tool that runs a console program at start-up, restarts it on failure, and
stops it by running `clawnet stop` (not by killing the process).

## 6. Network ports and the firewall

| Port | Protocol | Default | Used for | Exposure |
| --- | --- | --- | --- | --- |
| `listen.port` | TCP | 47470 on `0.0.0.0` | links from other nodes | reachable from other machines |
| `discovery.multicast.port` | UDP | 47470, group `239.255.67.78` | LAN beacons; multicast TTL 1 | local network only |
| `api.port` | TCP | 47480 on `127.0.0.1` | control API and console | this machine only |
| `websocket.port` | TCP (WebSocket) | 47471 on `0.0.0.0`, **off** | links from phones (browsers) | other machines, when switched on |
| `webapp.port` | TCP (HTTP) | 47490 on `0.0.0.0`, **off** | the phone web app's files | other machines, when switched on |

For other machines to link to a node, its `listen.port` must be reachable: allow inbound TCP on
it in the host firewall and, behind a router, forward it. Nodes behind NAT can still dial out to
nodes that are reachable; there is no hole punching. For LAN discovery allow inbound UDP on the
multicast port. Do not open the API port; if you must reach it from another machine, use an SSH
tunnel rather than `api.allowRemote`, which sends the token unencrypted.

**The firewall prompt.** With the default `listen.host` of `0.0.0.0` a node accepts connections
from other machines, and an operating system with a host firewall commonly asks the user the
first time a program does that. Windows Defender Firewall shows a dialog for a program that
listens on a non-loopback address; macOS asks whether to allow incoming network connections;
a typical Linux firewall does not prompt and simply blocks until a rule is added. **This was
not observed**: every command in this document binds `127.0.0.1` (`--listen 127.0.0.1:0`, or
`devnet`, which says so), so no prompt appeared. To run a node that never triggers it, bind
loopback: `--listen 127.0.0.1:47470 --no-multicast`.

On a machine with several network interfaces, multicast may leave by the wrong one; set
`discovery.multicast.interface` to the IPv4 address of the interface to use. Real LAN multicast
has not been tested between machines.

## 6a. Phones

A phone becomes a node by opening a web page that a computer node serves (DESIGN.md
section 16). Both halves are off by default; switch them on together:

```bash
node bin/clawnet.js start --phone
```

or in `config.json`: `"websocket": { "enabled": true }, "webapp": { "enabled": true }`, or
with `CLAWNET_WEBSOCKET=1 CLAWNET_WEBAPP=1`. `--websocket-port` and `--webapp-port` choose
other ports. On start the node prints, on standard error, the addresses phones can open, one
per network address of the computer (for example `http://192.168.1.20:47490/`); the JSON
ready line carries them as `phone.webapp`, and `clawnet status` (API `/status`) as
`phone`.

On the phone, connected to the same Wi-Fi: open that address in Safari or Chrome. On an
iPhone, add it to the home screen first (Share, Add to Home Screen) and set it up from
there: the home-screen app keeps its own storage, separate from Safari's. Create the
phone's identity; on a private network type the network key (the base64 text of
`networkKey`). The phone links to the computer and lists the nodes it can reach.

Rules and limits, in plain terms:

- The phone works only while the app is open and on screen. Closed or in the background,
  it neither sends nor receives; messages to it wait (and are retried) on their senders.
- It needs a computer node on the same network to link through. Two phones never link to
  each other directly; each links to a computer.
- Its keys and messages live in the browser's storage on that phone. Clearing the
  website's data, or deleting the home-screen app, deletes them.
- The page arrives over plain http. Anyone who can tamper with traffic on the Wi-Fi can
  change the app before it runs (THREAT_MODEL.md section 3.7). Use it on a network you
  trust.
- The phone's clock and the computer's must agree within five minutes.
- Browsers are admitted only from this node's own web app, reached by IP address,
  `localhost` or a `.local` name. To open the app by another name, add it to
  `webapp.allowedHosts`; to let a page served elsewhere link, list its origin in
  `websocket.allowedOrigins`.
- The firewall: the first time the node listens on these ports, Windows may ask whether
  Node.js may use the network. Allow it on private networks. On the one PC where a real
  phone was tried, Node.js already had a rule that allowed it, so the prompt itself has
  not been observed.
- The start-up hint names the adapter of each address. Use the Wi-Fi or Ethernet one; the
  addresses of virtual adapters (WSL, Hyper-V, VMware, VirtualBox, Docker) are listed
  apart, because a phone cannot reach them.
- The phone's identity belongs to the exact address it opened, such as
  `http://192.168.1.20:47490`. If the computer gets another address from the router, the
  app at the new address starts over as a new node. Give the computer a fixed address (a
  reservation in the router's DHCP settings) before you rely on a phone.
- If the hint printed at start says only this computer can open the app, `webapp.host` or
  `websocket.host` is a loopback address; set both to `0.0.0.0`, the default.
- If the phone cannot open the page, or shows "Can't reach the computer", check in this
  order:
  1. The node is running and was started with `--phone`.
  2. The phone is on the same Wi-Fi as the computer: not on mobile data, and not on a guest
     network, which usually keeps devices from reaching each other. Some routers do the
     same on the main network under a name such as "AP isolation" or "client isolation".
  3. Windows treats the Wi-Fi as a private network. An "allow on private networks" rule
     does nothing while the network's profile is Public: Settings, Network & internet,
     Wi-Fi, the network's properties, Network profile type, Private.
  4. The firewall rule for Node.js was not refused earlier. Windows Security, Firewall &
     network protection, Allow an app through firewall: Node.js needs a tick under
     Private.
  5. The computer's address has not changed since the phone opened the app.
- While the computer's node is not running, the home-screen app has nothing to load and
  shows Safari's own error page. Start the node and open the app again.
- It has been tried on one real phone, once: the owner's iPhone, on their home Wi-Fi,
  against a node on their PC, on 18 November 2026. It linked, and a message went each way
  (THREAT_MODEL.md section 3.7).

## 7. A private network

Give every node of the network the same 32-byte key. Generate one:

```
$ node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > netkey.txt
```

Start each node with `--network-key-file netkey.txt` (or `CLAWNET_NETWORK_KEY`, or `networkKey`
in `config.json`). Use a distinct `--network` name at `init` so that identities of the private
network cannot be started on the public one. Checked: a node started this way reports
`"networkKey": "[redacted]"` in `clawnet config`.

A node with the wrong key, or none, fails on the first handshake message, learns nothing about
the node it dialled, and the failure looks the same as a wrong network name. Be aware that the
key is a single shared secret with no revocation: anyone who holds it can join, and if it leaks
every node must change it. Keep it out of `config.json` on machines where the data directory
might be copied (the file is not encrypted). Beacons on the LAN stay readable by anyone on it.
That the handshake with a key rejects non-members is tested over loopback; the `XXpsk0` pattern
itself has no published vector (`PROTOCOL.md` section 3.5).

## 8. Backup, identity and moving a node

**What an identity is.** The NodeId is derived from the public key in `keystore.json`. The same
file holds the storage key that decrypts the node's sealed files, so a backup of the sealed
files without the keystore is useless.

**Back up** with the node stopped: copy the whole data directory. The minimum that preserves
the identity and the ability to read history is `keystore.json`, `network-id` and `config.json`;
everything else (`peers.json`, `peer-records.json`, `state.json`, `lsdb-seqs.json`) is
rediscovered, and the sealed files and `downloads/` are history. A backup of an unencrypted
keystore is a copy of the identity: protect it as you would the node. A passphrase protects the
backup too.

**Restore** by copying the directory back and starting a node on it. Checked: a copy of a
stopped (and a killed) node's directory, with the lock and runtime files removed, started with
the same passphrase and came up with the same NodeId.

**Moving to another machine** is a restore. Make sure the old copy never runs again. Two nodes
with one identity fight: each sees the other's link-state records at or above its own
sequence number and jumps past them, and nodes report `discovery.clone_suspected`. Which of them a
message reaches is not defined.

**Rotating an identity** is not possible. A new identity is a new NodeId: run `init` in a new
data directory. There is no revocation of a stolen key (`THREAT_MODEL.md` section 5). There is
no command to change the passphrase of an existing keystore.

## 9. Upgrading

There is one released version, `clawnet/0.1.0`, so no upgrade has ever been performed and no
migration tool exists. What the code does provide:

- Stop the node (`clawnet stop`), back up the data directory, replace the code, start.
- Persistent files carry a format version (`"v": 1`). A state file whose content fails the
  node's checks (including one written by another version) is moved aside as `.corrupt-<timestamp>` and the node starts from defaults;
  `keystore.json` is never recreated automatically. A keystore that fails to open stops the
  start.
- The wire protocol has a single version (`clawnet/1`) and no negotiation: nodes of a
  different protocol version fail the handshake and do not link. A change to the wire protocol
  therefore means upgrading every node of a network together.
- The `agent` string (`clawnet/0.1.0`) is announced in handshakes and shown in `peers`, which
  tells you what the nodes around you run.

## 10. Troubleshooting

Start with `clawnet status`, then `clawnet peers`:

```
$ node bin/clawnet.js -d DIR status
node      a7xamcag... (running)
network   clawnet-devnet   agent clawnet/0.1.0   boot 7f6a1262
uptime    21s
listen    tcp://127.0.0.1:50482
peers     2 linked, 0 dialing, 0 known (target 2, max 64)
routing   3 nodes, 2 reachable, rev 11
messages  0 in the outbox (0 waiting for a route)
events    1..86
services  messages, diag, cast, files, api
```

| Symptom | Check | Likely cause |
| --- | --- | --- |
| `clawnet: no node is running ...` (exit 3) | `lock`, `runtime.json` | the node is not running; or you used another `--data-dir` |
| `... is already in use (...process N)` | the process id | another node owns the directory; a dead pid is replaced automatically |
| `networkId: the data directory belongs to network ...` | `network-id` | started with another `--network`; the identity belongs to one network |
| `peers`: `no links` | `peers`, `events --types peer.*` | nothing to dial; see below |
| a message stays `waiting` in `outbox` | `routes`, `topology` | no route to the destination; it is delivered when one appears |
| a message stays `backoff` | `ping`, `trace` | the route exists but the destination is not acknowledging |
| `ping` loses all probes | `trace <id>` | the path is cut beyond the last answering hop |
| routes missing though links are up | `status` clocks | clock skew (below) |
| links flap | `events --types link.*` | the `reason` of each `link.down` |

**No links.** Check `peers.target`, `discovery.bootstrap` and `discovery.multicast.enabled`. A
node with no bootstrap address and multicast off links to nobody until someone dials it, or
until you run `clawnet connect tcp://host:port`. Multicast reaches only the local network.
`peer.dial_failed` events carry a `reason` and `retryInMs`; `peer.refused` events carry why a
link was turned away.

**Link reasons.** The `reason` in `peer.dial_failed`, `peer.refused` and `link.down`:

| Reason | Meaning |
| --- | --- |
| `connect-failed`, `connect-timeout` | TCP did not connect: wrong address, firewall, node not running |
| `handshake-timeout`, `closed` | connected but the handshake did not finish |
| `noise` | a handshake message failed to decrypt: wrong network key, wrong network name, other protocol version, or tampering. These cannot be told apart. |
| `network-mismatch` | the peer is on another network name |
| `clock-skew` | the clocks differ by more than `limits.maxClockSkewMs` |
| `bad-payload`, `bad-card`, `key-mismatch`, `version` | the peer sent something malformed or forged |
| `self`, `blocked`, `not-allowed`, `full` | admission policy: own address, block list, allow list, `peers.max` |
| `duplicate`, `replaced` | another link to the same node was kept |
| `timeout` | missed keepalives for `timers.peerTimeoutMs` |
| `protocol` | the peer broke the protocol and is refused for `timers.redialMaxMs` |
| `shutdown` | the peer stopped cleanly |
| `overflow` | the peer stopped reading and its control queue filled |

**Clock skew.** Link-state records carry wall-clock sequence numbers and are checked against
the local clock. If two nodes' clocks differ by more than 5 minutes they refuse each other's
handshakes (`clock-skew`) or each other's routing records. Fix the clock; raising
`limits.maxClockSkewMs` loosens a security check (`THREAT_MODEL.md`).

**Messages in the outbox.** With the destination's node stopped, a message is queued and waits:

```
$ node bin/clawnet.js -d DIR send xu3n4td3 "are you there"
message 2267ef63774197a3f56b12fc16dca813 to xu3n4td3: queued
$ node bin/clawnet.js -d DIR outbox
ID        TO        KIND  STATE    TRIES  BYTES  EXPIRES
2267ef63  xu3n4td3  msg   waiting  0      672    2026-11-23 13:59:47
$ node bin/clawnet.js -d DIR peers
no links
$ node bin/clawnet.js -d DIR ping xu3n4td3 -c 1 --timeout 1500
probe 1: no answer
1 sent, 0 received, 100% loss          (exit 1)
```

The message survives a restart of the sender and is retried for up to 7 days
(`limits.messageLifetimeMs`). There is no mailbox: while the destination is offline the
message stays in the sender's outbox, so the sender's node must be running when the
destination comes back.

**Counters and sync.** `clawnet counters` lists counters by module (`forwarder.dropped_*` show
why packets were dropped; `messaging.*` show retries); `GET /api/v1/diag/sync` shows the
datasets and the anti-entropy engine's counters. `clawnet events --replay --count N` reads the
last events from the node's ring buffer (5000 events) and follows new ones; `--types` filters
(`link.*,peer.*`). `--count` waits until that many events have arrived, so ask for no more than
there are.

**Logs.** Standard error, one JSON object per line. `CLAWNET_LOG_LEVEL=debug` shows more. A
`devnet` writes each node's log to `node.log` in its directory.

**Windows file errors.** Replacing a state file can fail with `EPERM` for a moment when a
virus scanner or indexer holds the new file. The engine retries for up to about 3.6 seconds
before reporting a `StoreError`; a persistent error means a real permission problem on the data
directory.

## 11. What is not covered

- Running on two machines, through a NAT, or on a LAN with real multicast: not tested.
- Running as a Windows service, under `launchd`, or in a container: nothing written or tested.
- Upgrades between versions: none exist yet.
- Changing a passphrase, rotating an identity, or revoking a key: no commands; see section 8.
- File transfer and channels from the command line: use the API or the console.
- Mailbox custody (`caps.mailbox`, the `mailbox` settings): designed, not built.
