/**
 * Peer discovery: how a node finds addresses to dial (DESIGN.md section 8, with the
 * changes of section 15, items 22 and 23).
 *
 * Three independent means feed one shared dial budget:
 *
 *   - `BootstrapDiscovery`  addresses the operator configured;
 *   - `PeerExchange`        signed peer records spread by ClawSync, which also serve as
 *                           the card directory;
 *   - `MulticastDiscovery`  signed beacons on the LAN (wire format in `beacon.js`).
 *
 * **The seam.** None of these modules opens a TCP connection. What they need from the
 * node is four plain functions, all provided by the peer manager:
 *
 * ```
 * dial(address, { id, source }) => Promise<{ id? } | void>
 *     start a link to `address` (`tcp://host:port`). Resolves when the node is linked
 *     to whoever lives there (also if it already was), rejects when it is not (a
 *     HandshakeError carries a `reason`). `id` is the NodeId the discoverer expects, or
 *     null; it is advice, since every dial ends in the authenticated handshake.
 *     `source` is "bootstrap", "pex" or "multicast".
 * isKnown(nodeId) => boolean
 *     the node is linked, being dialed, or in dial backoff. Such nodes are not dialed
 *     again and their beacons are ignored. An exception is read as true.
 * peerCount() => number
 *     links plus dials in flight (bootstrap only; compared with `peers.target`).
 * ownAddresses() => Address[]
 *     the addresses to announce in our peer record (pex only; ARCHITECTURE.md 4.6).
 * ```
 *
 * and, for the modules to talk back, `onCandidate(candidate)` (multicast: the node calls
 * `pex.noteCard(candidate.card)` there), `pex.attach(record => sync.publish("peer", record))`,
 * and an `EventBus` for `discovery.candidate`, `discovery.error`, `peer.record`,
 * `peer.equivocation` and `discovery.clone_suspected`.
 *
 * **Wiring** (the node owns every timer; the modules own none except the beacon timer
 * of `MulticastDiscovery`):
 *
 * ```
 * const governor = new DialGovernor({ dialsPerSecond: limits.dialsPerSecond,
 *   backoffMinMs: timers.redialMinMs, backoffMaxMs: timers.redialMaxMs, jitter: timers.redialJitter });
 * const dial = (address, hint) => peers.connect(address, { sticky: false });
 * const bootstrap = new BootstrapDiscovery({ addresses: discovery.bootstrap, dial, governor, isKnown, peerCount, targetPeers: peers.target, events });
 * const pex = new PeerExchange({ identity, caps, ownAddresses, isKnown, dial, governor, pex: discovery.pex,
 *   allowLoopback: discovery.allowLoopback, allowOrigin, maxOrigins, maxClockSkewMs, doc, state, events });
 * const multicast = new MulticastDiscovery({ identity, networkId, networkKey, group, port, iface, listenPort,
 *   intervalMs: timers.beaconIntervalMs, maxClockSkewMs, beaconsPerSourcePerMin, beaconsPerMin,
 *   allowLoopback: discovery.allowLoopback, isKnown, dial, governor, onCandidate: c => pex.noteCard(c.card), events });
 *
 * start:        await pex.load();  pex.attach(r => sync.publish('peer', r));  pex.refresh();
 *               bootstrap.start();  if (discovery.multicast.enabled) await multicast.start();
 * maintenance:  every redialMinMs and after each link-down, while below target:
 *                 bootstrap.maintain();  pex.maintain(peers.target - peerCount());
 * last link down: bootstrap.kick()
 * onObserved:   pex.refresh()
 * link up:      pex.noteCard(card)
 * stop:         await multicast.stop();  await pex.flush()
 * ```
 */

export { HostClass, budgetKey, checkLearnedAddress, classifyHost, classifyIp, isDialableIp } from './address-policy.js';
export { BEACON_MAX_BYTES, authenticateBeacon, encodeBeacon, parseBeacon } from './beacon.js';
export { BootstrapDiscovery, MAX_BOOTSTRAP_ADDRESSES } from './bootstrap.js';
export { DialGovernor } from './dial-governor.js';
export { MulticastDiscovery } from './multicast.js';
export { PEER_DATASET, PeerExchange } from './pex.js';
