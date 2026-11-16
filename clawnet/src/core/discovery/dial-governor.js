/**
 * The dial budget of discovery (DESIGN.md section 15, item 22).
 *
 * Discovery learns addresses from other nodes, and anyone may announce any address. If
 * dials were budgeted by NodeId, an attacker could mint identities until a victim's
 * address had been dialed a million times. So the budget is kept by *address*:
 *
 *   - at most one attempt in flight per IP address, whatever NodeIds claim it;
 *   - after a failed attempt the IP is left alone for an exponentially growing time
 *     (1 s doubling to 60 s by default, with jitter), shared by every NodeId and every
 *     port that claims that IP;
 *   - a global cap on dial attempts per second.
 *
 * One governor is shared by the bootstrap, peer-exchange and multicast modules, because
 * the budget is only worth anything if every road to a dial goes through it.
 *
 * The governor is where the *seam* to the peer manager is crossed. It calls the injected
 * `dial` function and learns the outcome from the promise it returns:
 *
 * ```
 * dial(address: Address, hint: DialHint) => Promise<{ id?: NodeId } | void>
 *   hint = { id: NodeId | null, source: "bootstrap" | "pex" | "multicast" }
 * ```
 *
 * `dial` resolves when the node is linked to the address's owner (also when it already
 * was) and rejects when it is not; a `HandshakeError` carries a `reason`. It must start
 * a connection and return, never block on one, and it applies the peer manager's own
 * policy (peer limit, blocklist, allowlist). `hint.id` is who the discoverer believes
 * lives there; it is advice, since every dial ends in the authenticated handshake.
 *
 * No timers and no sockets: time arrives as a monotonic reading, the rest is injected.
 */

import { performance } from 'node:perf_hooks';

import { ConfigError } from '../errors.js';
import { parseAddress } from '../wire/schema.js';
import { budgetKey } from './address-policy.js';
import { TokenBucket } from './rate-limit.js';

/** Most distinct IPs whose failure state is remembered. */
export const DEFAULT_MAX_TRACKED = 4096;

/** A dial that has neither succeeded nor failed after this long counts as failed. */
export const DEFAULT_MAX_IN_FLIGHT_MS = 60_000;

/**
 * Backoff multipliers for refusals that do not depend on the network: `full` means the
 * other node has no room, `blocked`, `not-allowed` and `self` mean this node will never
 * be admitted or never wants this link, so asking again soon is pointless.
 */
const REASON_FACTOR = Object.freeze({ full: 1, blocked: 10, 'not-allowed': 10, self: 10 });

/**
 * @typedef {object} DialHint
 * @property {string | null} id  NodeId the discoverer expects at the address, or null
 * @property {"bootstrap" | "pex" | "multicast"} source
 */

/**
 * @typedef {object} AttemptResult
 * @property {boolean} started    a dial was started
 * @property {string} [reason]    when not started: "invalid", "in-flight", "backoff" or "rate"
 * @property {Promise<{ ok: boolean, value?: unknown, error?: unknown }>} [done]  when
 *   started: settles (never rejects) with the outcome of the dial
 */

export class DialGovernor {
  #monoNow;
  #bucket;
  #backoffMinMs;
  #backoffMaxMs;
  #jitter;
  #rng;
  #maxTracked;
  #maxInFlightMs;
  /** key -> { token, since } */
  #inFlight = new Map();
  /** key -> { fails, until }; insertion order is age of the last change, oldest first. */
  #failures = new Map();
  #stats = {
    started: 0,
    succeeded: 0,
    failed: 0,
    deniedInFlight: 0,
    deniedBackoff: 0,
    deniedRate: 0,
    deniedInvalid: 0,
    staleInFlight: 0,
  };

  /**
   * @param {object} [options]
   * @param {() => number} [options.monoNow] monotonic milliseconds; default `performance.now`
   * @param {number} [options.dialsPerSecond=5] global cap, > 0 (`limits.dialsPerSecond`); the
   *   burst is the same number, at least one
   * @param {number} [options.backoffMinMs=1000] first backoff after a failure (`timers.redialMinMs`)
   * @param {number} [options.backoffMaxMs=60000] longest ordinary backoff (`timers.redialMaxMs`)
   * @param {number} [options.jitter=0.2] spread of each backoff, a fraction 0..1
   *   (`timers.redialJitter`)
   * @param {() => number} [options.rng] uniform in [0, 1); default `Math.random`
   * @param {number} [options.maxTracked] most IPs whose failures are remembered
   * @param {number} [options.maxInFlightMs] a dial that takes longer counts as failed
   * @throws {ConfigError} if an option is out of range
   */
  constructor({
    monoNow = () => performance.now(),
    dialsPerSecond = 5,
    backoffMinMs = 1000,
    backoffMaxMs = 60_000,
    jitter = 0.2,
    rng = Math.random,
    maxTracked = DEFAULT_MAX_TRACKED,
    maxInFlightMs = DEFAULT_MAX_IN_FLIGHT_MS,
  } = {}) {
    if (typeof monoNow !== 'function' || typeof rng !== 'function') {
      throw new ConfigError('dial governor: monoNow and rng must be functions');
    }
    if (!(Number.isFinite(dialsPerSecond) && dialsPerSecond > 0)) {
      throw new ConfigError('dial governor: dialsPerSecond must be a positive number');
    }
    for (const [label, value] of [['backoffMinMs', backoffMinMs], ['backoffMaxMs', backoffMaxMs], ['maxInFlightMs', maxInFlightMs]]) {
      if (!(Number.isFinite(value) && value >= 1)) {
        throw new ConfigError(`dial governor: ${label} must be at least 1`);
      }
    }
    if (backoffMaxMs < backoffMinMs) {
      throw new ConfigError('dial governor: backoffMaxMs must not be below backoffMinMs');
    }
    if (!(jitter >= 0 && jitter <= 1)) throw new ConfigError('dial governor: jitter must be in 0..1');
    if (!Number.isSafeInteger(maxTracked) || maxTracked < 1) {
      throw new ConfigError('dial governor: maxTracked must be at least 1');
    }
    this.#monoNow = monoNow;
    this.#bucket = new TokenBucket({ capacity: Math.max(1, dialsPerSecond), perSecond: dialsPerSecond });
    this.#backoffMinMs = backoffMinMs;
    this.#backoffMaxMs = backoffMaxMs;
    this.#jitter = jitter;
    this.#rng = rng;
    this.#maxTracked = maxTracked;
    this.#maxInFlightMs = maxInFlightMs;
  }

  /**
   * Whether an address could be dialed right now as far as its IP is concerned. Does not
   * look at the global rate and reserves nothing; used to choose between candidates.
   *
   * @param {string} address `tcp://host:port`
   * @returns {null | "invalid" | "in-flight" | "backoff"} null if the IP is free
   */
  check(address) {
    const parsed = parseAddress(address);
    if (parsed === null) return 'invalid';
    return this.#ipState(budgetKey(parsed.host), this.#monoNow());
  }

  /**
   * Start a dial if the budget allows it.
   *
   * @param {string} address
   * @param {DialHint} hint
   * @param {(address: string, hint: DialHint) => unknown} dial the peer manager's dial;
   *   see the module description. A synchronous throw counts as a failed dial.
   * @returns {AttemptResult}
   */
  attempt(address, hint, dial) {
    const parsed = parseAddress(address);
    if (parsed === null) {
      this.#stats.deniedInvalid += 1;
      return { started: false, reason: 'invalid' };
    }
    const key = budgetKey(parsed.host);
    const now = this.#monoNow();
    const denied = this.#ipState(key, now);
    if (denied !== null) {
      if (denied === 'in-flight') this.#stats.deniedInFlight += 1;
      else this.#stats.deniedBackoff += 1;
      return { started: false, reason: denied };
    }
    if (!this.#bucket.take(now)) {
      this.#stats.deniedRate += 1;
      return { started: false, reason: 'rate' };
    }

    const token = {};
    this.#inFlight.set(key, { token, since: now });
    this.#stats.started += 1;
    let pending;
    try {
      pending = Promise.resolve(dial(address, Object.freeze({ ...hint })));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const done = pending.then(
      value => {
        this.#settle(key, token, true, undefined);
        return { ok: true, value };
      },
      error => {
        this.#settle(key, token, false, error);
        return { ok: false, error };
      },
    );
    return { started: true, done };
  }

  /**
   * Forget the failures of an address's IP, so that it may be dialed at once. Used when
   * the node has lost its last link and must not wait out a backoff.
   *
   * @param {string} address
   */
  forgive(address) {
    const parsed = parseAddress(address);
    if (parsed !== null) this.#failures.delete(budgetKey(parsed.host));
  }

  /** @returns {object} counters and gauges, all non-negative integers */
  stats() {
    return { ...this.#stats, inFlight: this.#inFlight.size, tracked: this.#failures.size };
  }

  /** Why an IP cannot be dialed now, or null. Releases a stale in-flight attempt. */
  #ipState(key, now) {
    const flight = this.#inFlight.get(key);
    if (flight !== undefined) {
      const age = now - flight.since;
      // A reading that went backwards counts as stale too: better a second attempt than
      // an IP that stays blocked for the size of the step.
      if (age >= 0 && age < this.#maxInFlightMs) return 'in-flight';
      this.#inFlight.delete(key);
      this.#stats.staleInFlight += 1;
      this.#fail(key, now, undefined);
    }
    const failure = this.#failures.get(key);
    if (failure !== undefined && now < failure.until && failure.until - now <= this.#ceiling()) {
      return 'backoff';
    }
    return null;
  }

  /** Longest backoff that can ever be set; anything beyond it is a clock step. */
  #ceiling() {
    return this.#backoffMaxMs * 10 * (1 + this.#jitter);
  }

  #settle(key, token, ok, error) {
    const flight = this.#inFlight.get(key);
    // The attempt was already given up on as stale, and a newer one may be running.
    if (flight === undefined || flight.token !== token) return;
    this.#inFlight.delete(key);
    if (ok) {
      this.#stats.succeeded += 1;
      this.#failures.delete(key);
    } else {
      this.#fail(key, this.#monoNow(), error);
    }
  }

  #fail(key, now, error) {
    this.#stats.failed += 1;
    const previous = this.#failures.get(key);
    const fails = (previous?.fails ?? 0) + 1;
    const reason = typeof error?.reason === 'string' ? error.reason : '';
    const factor = Object.hasOwn(REASON_FACTOR, reason) ? REASON_FACTOR[reason] : 1;
    const base = Math.min(this.#backoffMaxMs, this.#backoffMinMs * 2 ** Math.min(fails - 1, 30));
    const spread = 1 + this.#jitter * (2 * this.#rng() - 1);
    const delay = Math.max(1, Math.round(base * factor * spread));
    this.#failures.delete(key);
    this.#failures.set(key, { fails, until: now + delay });
    this.#trim(now);
  }

  /** Keep the failure table within bounds: expired entries first, then the oldest. */
  #trim(now) {
    if (this.#failures.size <= this.#maxTracked) return;
    for (const [key, failure] of this.#failures) {
      if (failure.until <= now) this.#failures.delete(key);
      if (this.#failures.size <= this.#maxTracked) return;
    }
    while (this.#failures.size > this.#maxTracked) {
      this.#failures.delete(this.#failures.keys().next().value);
    }
  }
}
