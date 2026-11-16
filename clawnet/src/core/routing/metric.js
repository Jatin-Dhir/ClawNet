/**
 * Link cost from keepalive round-trip times (DESIGN.md section 7).
 *
 * A link's cost is what the node advertises for it in its LSA and what Dijkstra sums.
 * It follows measured quality: an exponentially weighted moving average of the keepalive
 * RTT, the same smoothing TCP uses for its retransmission timer (RFC 6298), so one slow
 * keepalive nudges the cost instead of rerouting the network. A missed keepalive carries
 * no RTT at all, so it is charged as a multiplier that the next successful sample clears.
 *
 * This class holds no timers and reads no clock: the peer layer measures the RTT and
 * calls sample() or miss().
 */

import { ConfigError } from '../errors.js';

/** Largest cost a link may be advertised with. Costs are integers in 1..MAX_LINK_COST. */
export const MAX_LINK_COST = 65535;

/**
 * Re-advertising needs a move of more than this fraction of the advertised cost, and
 * also more than ADVERTISE_DELTA_MS (DESIGN.md section 15, item 17).
 */
export const ADVERTISE_RATIO = 0.25;

/**
 * Re-advertising needs a move of more than this many milliseconds, and also more than
 * ADVERTISE_RATIO of the advertised cost.
 */
export const ADVERTISE_DELTA_MS = 10;

export class LinkMetric {
  #alpha;
  #missPenalty;
  #maxCost;
  /** Smoothed RTT in milliseconds; null until the first sample. */
  #srtt = null;
  /** Keepalives missed in a row since the last sample. */
  #misses = 0;

  /**
   * @param {object} [options]
   * @param {number} [options.alpha=0.125]   weight of a new sample, in (0, 1]
   * @param {number} [options.missPenalty=2] cost multiplier per consecutive missed
   *   keepalive, finite and >= 1
   * @param {number} [options.maxCost=65535] upper bound of the cost, an integer in
   *   1..65535
   * @throws {ConfigError} if an option is out of range
   */
  constructor({ alpha = 0.125, missPenalty = 2, maxCost = MAX_LINK_COST } = {}) {
    if (typeof alpha !== 'number' || !(alpha > 0 && alpha <= 1)) {
      throw new ConfigError('alpha must be a number in (0, 1]');
    }
    if (typeof missPenalty !== 'number' || !Number.isFinite(missPenalty) || missPenalty < 1) {
      throw new ConfigError('missPenalty must be a finite number >= 1');
    }
    if (!Number.isSafeInteger(maxCost) || maxCost < 1 || maxCost > MAX_LINK_COST) {
      throw new ConfigError(`maxCost must be an integer in 1..${MAX_LINK_COST}`);
    }
    this.#alpha = alpha;
    this.#missPenalty = missPenalty;
    this.#maxCost = maxCost;
  }

  /**
   * Record the round-trip time of an answered keepalive. Clears the miss penalty.
   *
   * @param {number} rttMs round-trip time in milliseconds, finite and >= 0. Measure it
   *   with a monotonic clock: a wall-clock step can produce a negative value, which is
   *   rejected rather than folded into the average.
   * @throws {ConfigError} if rttMs is not a finite, non-negative number
   */
  sample(rttMs) {
    if (typeof rttMs !== 'number' || !Number.isFinite(rttMs) || rttMs < 0) {
      throw new ConfigError('rttMs must be a finite number >= 0');
    }
    // The cost saturates at maxCost, so a larger sample carries no extra information; it
    // would only make the average take longer to come back down afterwards.
    const rtt = Math.min(rttMs, this.#maxCost);
    this.#srtt = this.#srtt === null ? rtt : this.#srtt + this.#alpha * (rtt - this.#srtt);
    this.#misses = 0;
  }

  /** Record a keepalive that was not answered in time. */
  miss() {
    this.#misses += 1;
  }

  /**
   * Smoothed round-trip time in milliseconds, or null before the first sample.
   *
   * @returns {number | null}
   */
  get srtt() {
    return this.#srtt;
  }

  /**
   * Keepalives missed in a row since the last sample.
   *
   * @returns {number}
   */
  get misses() {
    return this.#misses;
  }

  /**
   * Current link cost: the smoothed RTT in milliseconds rounded up (at least 1),
   * multiplied by missPenalty once per consecutive missed keepalive, capped at maxCost.
   *
   * A link that has never been measured costs maxCost: nothing is known about it, so it
   * is used only when there is no measured alternative. Callers that want a new link to
   * be attractive at once feed the handshake round trip in as the first sample.
   *
   * @returns {number} an integer in 1..maxCost
   */
  get cost() {
    if (this.#srtt === null) return this.#maxCost;
    const base = Math.max(1, Math.ceil(this.#srtt));
    const cost = Math.ceil(base * this.#missPenalty ** this.#misses);
    // Written as "cost < max" so that an overflow to Infinity also lands on maxCost.
    return cost < this.#maxCost ? cost : this.#maxCost;
  }

  /**
   * Whether the cost has moved far enough from the advertised value to be worth a new
   * LSA: by more than 25 % of the advertised cost AND by more than 10 ms (DESIGN.md
   * section 15, item 17). Smaller changes are not flooded, which is what keeps RTT jitter
   * from churning every node's routes.
   *
   * Both conditions are needed. The relative one alone would fire on a single unit for
   * advertised costs 1 to 3 (a LAN link whose RTT sits near a whole millisecond would
   * flood a changed LSA, and make every node recompute its routes, each time jitter
   * carried it across); the absolute one alone would fire on ordinary jitter of a slow,
   * long-distance link. An advertised cost is therefore off by at most 10 ms or 25 %,
   * whichever is larger.
   *
   * @param {number | null | undefined} lastAdvertisedCost the cost in the last LSA sent
   *   for this link, or null/undefined if the link has not been advertised yet
   * @returns {boolean}
   * @throws {ConfigError} if lastAdvertisedCost is given and is not a finite number > 0
   */
  shouldAdvertise(lastAdvertisedCost) {
    if (lastAdvertisedCost == null) return true;
    if (
      typeof lastAdvertisedCost !== 'number' ||
      !Number.isFinite(lastAdvertisedCost) ||
      lastAdvertisedCost <= 0
    ) {
      throw new ConfigError('lastAdvertisedCost must be a finite number > 0');
    }
    const delta = Math.abs(this.cost - lastAdvertisedCost);
    return delta > ADVERTISE_DELTA_MS && delta > lastAdvertisedCost * ADVERTISE_RATIO;
  }
}
