/**
 * Discovery by configured bootstrap addresses (DESIGN.md section 8, item 2).
 *
 * The operator lists addresses (`discovery.bootstrap`). The node dials them when it
 * starts and again whenever it is below its target peer count, so a node that has lost
 * its peers finds the network again as long as one bootstrap node is up.
 *
 * Bootstrap addresses are the operator's own: they are *not* subject to the address
 * policy of `address-policy.js` (a bootstrap node on 127.0.0.1 is how a single-machine
 * network is made), but they do pass through the shared `DialGovernor`, so a dead
 * bootstrap address is retried with backoff and not in a loop.
 *
 * No timers and no sockets: the owner calls `start()` once, `maintain()` from the peer
 * manager's maintenance pass and `kick()` when the last link is lost. The module only
 * calls the injected `dial` (through the governor) and `isKnown`.
 */

import { ConfigError } from '../errors.js';
import { validateAddress } from '../wire/schema.js';

/** Most bootstrap addresses (`config.discovery.bootstrap`). */
export const MAX_BOOTSTRAP_ADDRESSES = 256;

export class BootstrapDiscovery {
  #addresses;
  #dial;
  #governor;
  #isKnown;
  #peerCount;
  #targetPeers;
  #events;
  #log;
  /** address -> NodeId that answered there last; read to skip addresses already linked */
  #reached = new Map();
  /** Where the next maintain() pass starts, so that every address gets its turn. */
  #cursor = 0;
  #announced = false;
  #stats = { starts: 0, maintains: 0, kicks: 0, dialsStarted: 0, dialsDenied: 0, dialsOk: 0, dialsFailed: 0 };

  /**
   * @param {object} options
   * @param {string[]} options.addresses  `discovery.bootstrap`; at most 256, each valid
   * @param {(address: string, hint: object) => unknown} options.dial the peer manager's
   *   dial function (see `dial-governor.js`); when it resolves with an object holding
   *   `id`, the address is remembered as that node's
   * @param {import('./dial-governor.js').DialGovernor} options.governor shared dial budget
   * @param {(id: string) => boolean} options.isKnown whether the peer manager is linked
   *   to, dialing or backing off from that node; an exception counts as true
   * @param {() => number} options.peerCount links plus dials in flight, the figure the
   *   peer manager compares with its target
   * @param {number} options.targetPeers  `peers.target`
   * @param {{ emit: (type: string, data?: unknown) => unknown }} [options.events]
   * @param {object} [options.log]
   * @throws {ConfigError} if an address is invalid or an option is missing
   */
  constructor({ addresses, dial, governor, isKnown, peerCount, targetPeers, events, log } = {}) {
    if (!Array.isArray(addresses) || addresses.length > MAX_BOOTSTRAP_ADDRESSES) {
      throw new ConfigError(`bootstrap: addresses must be a list of at most ${MAX_BOOTSTRAP_ADDRESSES}`);
    }
    for (const address of addresses) {
      const verdict = validateAddress(address);
      if (!verdict.ok) throw new ConfigError(`bootstrap: bad address: ${verdict.reason}`);
    }
    for (const [label, fn] of [['dial', dial], ['isKnown', isKnown], ['peerCount', peerCount]]) {
      if (typeof fn !== 'function') throw new ConfigError(`bootstrap: ${label} must be a function`);
    }
    if (governor === null || typeof governor !== 'object' || typeof governor.attempt !== 'function') {
      throw new ConfigError('bootstrap: governor is required');
    }
    if (!Number.isInteger(targetPeers) || targetPeers < 0) {
      throw new ConfigError('bootstrap: targetPeers must be a non-negative integer');
    }
    this.#addresses = [...new Set(addresses)];
    this.#dial = dial;
    this.#governor = governor;
    this.#isKnown = isKnown;
    this.#peerCount = peerCount;
    this.#targetPeers = targetPeers;
    this.#events = events;
    this.#log = log;
  }

  /** @returns {string[]} the configured addresses, without duplicates */
  get addresses() {
    return [...this.#addresses];
  }

  /**
   * Dial every bootstrap address, at the start of the node and whatever the peer count:
   * the operator named them. The governor's global rate cap still applies; addresses it
   * holds back are tried by later `maintain()` passes.
   *
   * @returns {number} dials started
   */
  start() {
    this.#stats.starts += 1;
    if (!this.#announced) {
      this.#announced = true;
      for (const addr of this.#addresses) {
        this.#events?.emit('discovery.candidate', { addr, peer: null, source: 'bootstrap' });
      }
    }
    return this.#dialAddresses(this.#addresses.length);
  }

  /**
   * One maintenance pass: if the node has fewer peers (links plus dials in flight) than
   * its target, dial as many bootstrap addresses as are missing, skipping those whose
   * node is already linked or being dialed. Addresses are taken in turn, so a dead one
   * at the head of the list does not starve the rest.
   *
   * @returns {number} dials started
   */
  maintain() {
    this.#stats.maintains += 1;
    const missing = this.#targetPeers - this.#peerCount();
    if (!(missing > 0)) return 0;
    return this.#dialAddresses(missing);
  }

  /**
   * The node has no link left: forget every backoff on the bootstrap addresses and dial
   * at once.
   *
   * @returns {number} dials started
   */
  kick() {
    this.#stats.kicks += 1;
    for (const address of this.#addresses) this.#governor.forgive(address);
    return this.#dialAddresses(Math.max(1, this.#targetPeers));
  }

  /** @returns {object} counters, all non-negative integers */
  stats() {
    return { ...this.#stats, addresses: this.#addresses.length };
  }

  #dialAddresses(limit) {
    const count = this.#addresses.length;
    let started = 0;
    let visited = 0;
    while (visited < count && started < limit) {
      const index = (this.#cursor + visited) % count;
      const address = this.#addresses[index];
      visited += 1;
      if (this.#linked(address)) continue;
      const result = this.#governor.attempt(address, { id: this.#reached.get(address) ?? null, source: 'bootstrap' }, this.#dial);
      if (!result.started) {
        this.#stats.dialsDenied += 1;
        if (result.reason === 'rate') {
          // The global rate is spent, so nothing else starts in this pass. The next pass
          // begins with the address that had to wait.
          this.#cursor = index;
          return started;
        }
        continue;
      }
      started += 1;
      this.#stats.dialsStarted += 1;
      result.done.then(outcome => this.#settled(address, outcome));
    }
    this.#cursor = count === 0 ? 0 : (this.#cursor + visited) % count;
    return started;
  }

  #settled(address, outcome) {
    if (!outcome.ok) {
      this.#stats.dialsFailed += 1;
      this.#log?.debug?.('bootstrap dial failed', { addr: address, reason: outcome.error?.reason });
      return;
    }
    this.#stats.dialsOk += 1;
    const id = outcome.value?.id;
    if (typeof id === 'string') this.#reached.set(address, id);
  }

  #linked(address) {
    const id = this.#reached.get(address);
    if (id === undefined) return false;
    try {
      return this.#isKnown(id) === true;
    } catch {
      return true;
    }
  }
}
