/**
 * Diagnostics service (ARCHITECTURE.md 8.4): end-to-end ping and traceroute over `PROBE`
 * packets, the counter view, and the answers this node gives to other nodes' probes.
 *
 * A probe is an unauthenticated routed packet. The answer is a sealed `probe-reply`
 * message, so its sender is authenticated: that is what makes a hop in a traceroute
 * trustworthy (a node can only report itself). Because anyone can forge the `rsvp` field,
 * answers are rate limited in total and per `rsvp`, and a probe that exceeds either is
 * dropped without a word.
 */

import { performance } from 'node:perf_hooks';

import { randomBytes } from '../crypto/primitives.js';
import { ConfigError, StateError } from '../errors.js';
import { isNodeId } from '../wire/schema.js';
import { MESSAGE_ID_PATTERN, PacketType } from '../wire/types.js';
import { Counters } from './counters.js';

/** Most probes in flight (sent and not yet answered or timed out) at once. */
export const DEFAULT_MAX_PENDING = 256;

/** Probe answers per second, in total and per `rsvp` (burst equal to the rate). */
export const DEFAULT_REPLIES_PER_SEC = 20;
export const DEFAULT_REPLIES_PER_RSVP_PER_SEC = 5;

/** Distinct `rsvp` ids whose bucket is tracked; the oldest is forgotten first. */
export const MAX_TRACKED_RSVP = 1024;

/** A traceroute gives up after this many hops in a row that did not answer. */
export const MAX_SILENT_HOPS = 3;

/** Interval of the counter sample. */
export const COUNTER_SAMPLE_MS = 1000;

const EMPTY = Buffer.alloc(0);

const PING_LIMITS = Object.freeze({ count: [1, 100], intervalMs: [10, 60000], timeoutMs: [100, 60000] });
const TRACE_TIMEOUT_LIMITS = Object.freeze([100, 60000]);

const REPLY_AT = Object.freeze(['dst', 'expired']);

const round2 = (value) => Math.round(value * 100) / 100;

/** A token bucket on a monotonic clock, burst equal to its rate. */
class TokenBucket {
  #rate;
  #tokens;
  #at;

  constructor(perSecond, at) {
    this.#rate = perSecond;
    this.#tokens = perSecond;
    this.#at = at;
  }

  take(at) {
    this.#tokens = Math.min(this.#rate, this.#tokens + ((at - this.#at) / 1000) * this.#rate);
    this.#at = at;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

function checkInteger(value, name, [min, max]) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Build the diagnostics service.
 *
 * Its `api` is `{ ping(dst, options), traceroute(dst, options), counters() }`:
 *
 * - `ping(dst, { count = 4, intervalMs = 1000, timeoutMs = 5000, signal })` resolves to a
 *   PingResult (API.md section 7). An unreachable or silent destination is not an error:
 *   the result reports the loss.
 * - `traceroute(dst, { maxHops, timeoutMs = 3000, signal })` resolves to a TraceResult.
 *   After `MAX_SILENT_HOPS` hops in a row without an answer it stops: nothing beyond a
 *   cut will ever answer, and waiting out every remaining hop helps nobody.
 * - `counters()` returns a CountersSnapshot.
 *
 * @param {object} [options]
 * @param {number} [options.maxPending] probes in flight at once
 * @param {number} [options.repliesPerSec] probe answers per second in total
 * @param {number} [options.repliesPerRsvpPerSec] probe answers per second per `rsvp`
 * @param {() => number} [options.monoNow] monotonic clock in milliseconds, for round-trip
 *   times and the answer buckets; tests inject one
 * @returns {object} a Service (ARCHITECTURE.md section 6) named `diag`
 * @throws {ConfigError} for an invalid option
 */
export function createDiagService({
  maxPending = DEFAULT_MAX_PENDING,
  repliesPerSec = DEFAULT_REPLIES_PER_SEC,
  repliesPerRsvpPerSec = DEFAULT_REPLIES_PER_RSVP_PER_SEC,
  monoNow = () => performance.now(),
} = {}) {
  if (typeof monoNow !== 'function') throw new ConfigError('monoNow must be a function');
  checkInteger(maxPending, 'maxPending', [1, 1_000_000]);
  checkInteger(repliesPerSec, 'repliesPerSec', [1, 1_000_000]);
  checkInteger(repliesPerRsvpPerSec, 'repliesPerRsvpPerSec', [1, 1_000_000]);

  let ctx = null;
  let counters = null;
  let stopCounters = null;
  let stopped = false;
  /** Probe id -> the probe waiting for its answer. */
  const pending = new Map();
  /** Probes and sleeps that callers started and that stop() must release. */
  const sleepers = new Set();
  let reserved = 0;
  let total = null;
  const perRsvp = new Map();
  const stats = {
    probesSent: 0,
    repliesReceived: 0,
    repliesIgnored: 0,
    probesAnswered: 0,
    probesRateLimited: 0,
    probesUnanswerable: 0,
    probesUnsendable: 0,
    pings: 0,
    traces: 0,
  };

  const live = () => {
    if (ctx === null || stopped) throw new StateError('not-running: the diagnostics service is not running');
    return ctx;
  };

  const sleep = (ms) => new Promise((resolve) => {
    const cancel = live().schedule(() => {
      sleepers.delete(release);
      resolve();
    }, ms);
    const release = () => {
      cancel();
      resolve();
    };
    sleepers.add(release);
  });

  const reserve = (slots) => {
    if (reserved + slots > maxPending) {
      throw new StateError(`busy: ${reserved} probes are in flight, at most ${maxPending} are allowed`);
    }
    reserved += slots;
  };

  /**
   * Send one probe and wait for its answer or the timeout.
   *
   * @returns {Promise<{ id: string, from: string | null, at: string | null, hop: number | null, rttMs: number | null }>}
   */
  const launch = (dst, n, timeoutMs) => new Promise((resolve) => {
    const { schedule, nodeId } = live();
    const id = randomBytes(16).toString('hex');
    const startedAt = monoNow();
    let cancel = () => {};
    const entry = {
      dst,
      n,
      settle(answer) {
        if (!pending.delete(id)) return;
        cancel();
        resolve({
          id,
          from: answer?.from ?? null,
          at: answer?.at ?? null,
          hop: answer?.hop ?? null,
          rttMs: answer === null ? null : round2(monoNow() - startedAt),
        });
      },
    };
    pending.set(id, entry);
    cancel = schedule(() => entry.settle(null), timeoutMs);
    let result;
    try {
      stats.probesSent += 1;
      result = ctx.packets.originate({
        type: PacketType.PROBE,
        header: { id, dst, ttl: n, rsvp: nodeId, n },
        body: EMPTY,
      });
    } catch {
      result = { ok: false };
    }
    // No route (or a full link): the probe is lost now, there is nothing to wait for.
    if (result.ok !== true) {
      stats.probesUnsendable += 1;
      entry.settle(null);
    }
  });

  /** The `probe-reply` handler: authenticated by the seal, matched by probe id. */
  const onReply = (message) => {
    const meta = message.meta ?? {};
    const entry = typeof meta.re === 'string' && MESSAGE_ID_PATTERN.test(meta.re) ? pending.get(meta.re) : undefined;
    const { n, hop, at } = meta;
    const wellFormed = entry !== undefined && Number.isSafeInteger(n) && Number.isSafeInteger(hop) &&
      REPLY_AT.includes(at) && n === entry.n && hop >= 1 && hop <= n;
    if (!wellFormed) {
      stats.repliesIgnored += 1;
      return;
    }
    // Only the destination answers "dst", and the destination never reports an expiry; an
    // expiry reports the hop it happened at, which is the probe's own `n`.
    const fromDst = message.from === entry.dst;
    const valid = at === 'dst' ? fromDst : !fromDst && hop === n;
    if (!valid) {
      stats.repliesIgnored += 1;
      return;
    }
    stats.repliesReceived += 1;
    entry.settle({ from: message.from, at, hop });
  };

  /** What this node does with a probe that arrived for it (`at: "dst"`) or ran out here. */
  const answer = (at) => (packet) => {
    const { id, rsvp, n, ttl } = packet.header;
    const context = ctx;
    if (context === null || stopped) return;
    // Without the card nothing can be sealed to `rsvp`; stay silent, and spend no budget.
    if (context.directory.cardOf(rsvp) === null) {
      stats.probesUnanswerable += 1;
      return;
    }
    const now = monoNow();
    total ??= new TokenBucket(repliesPerSec, now);
    let bucket = perRsvp.get(rsvp);
    if (bucket === undefined) {
      if (perRsvp.size >= MAX_TRACKED_RSVP) perRsvp.delete(perRsvp.keys().next().value);
      bucket = new TokenBucket(repliesPerRsvpPerSec, now);
      perRsvp.set(rsvp, bucket);
    }
    // Both buckets are always charged (no short-circuit), so each counts every probe it
    // was offered, not only the ones the other one let through.
    const allowedTotal = total.take(now);
    const allowedRsvp = bucket.take(now);
    if (!allowedTotal || !allowedRsvp) {
      stats.probesRateLimited += 1;
      return;
    }
    stats.probesAnswered += 1;
    context.messaging.send(rsvp, {
      kind: 'probe-reply',
      meta: { re: id, n, hop: n - ttl + 1, at },
      reliable: false,
    }).catch(() => {
      stats.probesUnanswerable += 1;
    });
  };

  const emit = (type, data) => {
    try {
      ctx?.events.emit(type, data);
    } catch {
      // The result is returned to the caller whatever the bus says.
    }
  };

  const service = {
    name: 'diag',

    init(context) {
      ctx = context;
      stopped = false;
      context.messaging.onKind('probe-reply', onReply);
      context.packets.onLocal('probe', answer('dst'));
      context.packets.onLocal('probe.expired', answer('expired'));
      registerRoutes(context, service.api);
    },

    start() {
      counters = new Counters({ source: () => ctx.node.stats(), now: ctx.now });
      counters.sample();
      stopCounters = ctx.every(() => counters.sample(), COUNTER_SAMPLE_MS);
    },

    stop() {
      stopped = true;
      stopCounters?.();
      stopCounters = null;
      for (const entry of [...pending.values()]) entry.settle(null);
      for (const release of [...sleepers]) release();
      sleepers.clear();
      // Nothing from the context is kept after stop (ARCHITECTURE.md section 6).
      counters = null;
      ctx = null;
    },

    stats() {
      return { ...stats, pending: pending.size };
    },

    api: {
      async ping(dst, { count = 4, intervalMs = 1000, timeoutMs = 5000, signal } = {}) {
        const context = live();
        if (!isNodeId(dst)) throw new ConfigError('dst must be a NodeId');
        if (dst === context.nodeId) throw new ConfigError('dst must not be this node');
        checkInteger(count, 'count', PING_LIMITS.count);
        checkInteger(intervalMs, 'intervalMs', PING_LIMITS.intervalMs);
        checkInteger(timeoutMs, 'timeoutMs', PING_LIMITS.timeoutMs);
        reserve(count);
        stats.pings += 1;
        const ttl = context.config.limits.ttl;
        const probes = [];
        try {
          const running = [];
          for (let seq = 1; seq <= count; seq += 1) {
            if (seq > 1) await sleep(intervalMs);
            if (stopped || signal?.aborted === true) break;
            running.push(launch(dst, ttl, timeoutMs).then((result) => {
              const rttMs = result.at === 'dst' ? result.rttMs : null;
              const probe = { seq, id: result.id, rttMs, hops: rttMs === null ? null : result.hop };
              emit('diag.ping', { dst, seq, id: probe.id, rttMs: probe.rttMs, hops: probe.hops });
              return probe;
            }));
          }
          probes.push(...(await Promise.all(running)));
        } finally {
          reserved -= count;
        }
        const rtts = probes.filter((probe) => probe.rttMs !== null).map((probe) => probe.rttMs);
        const sent = probes.length;
        return {
          dst,
          sent,
          received: rtts.length,
          lossPct: sent === 0 ? 0 : Math.round(((sent - rtts.length) / sent) * 1000) / 10,
          rttMs: rtts.length === 0 ? null : {
            min: Math.min(...rtts),
            avg: round2(rtts.reduce((sum, rtt) => sum + rtt, 0) / rtts.length),
            max: Math.max(...rtts),
          },
          probes,
        };
      },

      async traceroute(dst, { maxHops, timeoutMs = 3000, signal } = {}) {
        const context = live();
        if (!isNodeId(dst)) throw new ConfigError('dst must be a NodeId');
        if (dst === context.nodeId) throw new ConfigError('dst must not be this node');
        const ceiling = context.config.limits.ttl;
        const limit = maxHops === undefined ? ceiling : checkInteger(maxHops, 'maxHops', [1, ceiling]);
        checkInteger(timeoutMs, 'timeoutMs', TRACE_TIMEOUT_LIMITS);
        reserve(1);
        stats.traces += 1;
        const hops = [];
        let reached = false;
        let silent = 0;
        try {
          for (let n = 1; n <= limit && !reached && !stopped && signal?.aborted !== true; n += 1) {
            const result = await launch(dst, n, timeoutMs);
            reached = result.at === 'dst';
            const hop = { n, node: result.from, rttMs: result.rttMs };
            hops.push(hop);
            emit('diag.trace_hop', { dst, n, node: hop.node, rttMs: hop.rttMs, reached });
            silent = hop.node === null ? silent + 1 : 0;
            if (silent >= MAX_SILENT_HOPS) break;
          }
        } finally {
          reserved -= 1;
        }
        return { dst, reached, hops };
      },

      counters() {
        live();
        if (counters === null) throw new StateError('not-running: the diagnostics service has not started');
        return counters.snapshot();
      },
    },
  };
  return service;
}

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

function invalid(ctx, field, problem) {
  return ctx.api.error(400, 'invalid_request', `${field}: ${problem}`, { field, problem });
}

function objectBody(ctx, body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid(ctx, 'body', 'a JSON object is required');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(ctx, key, 'unknown field');
  }
  return body;
}

function optionalInteger(ctx, body, name, [min, max]) {
  if (body[name] === undefined) return undefined;
  if (!Number.isSafeInteger(body[name]) || body[name] < min || body[name] > max) {
    throw invalid(ctx, name, `must be an integer from ${min} to ${max}`);
  }
  return body[name];
}

function registerRoutes(ctx, api) {
  ctx.api.route('POST', '/diag/ping', async (req) => {
    const body = objectBody(ctx, req.body, ['to', 'count', 'intervalMs', 'timeoutMs']);
    if (!isNodeId(body.to)) throw invalid(ctx, 'to', 'must be a NodeId');
    if (body.to === ctx.nodeId) throw invalid(ctx, 'to', 'must not be this node');
    return api.ping(body.to, {
      count: optionalInteger(ctx, body, 'count', PING_LIMITS.count),
      intervalMs: optionalInteger(ctx, body, 'intervalMs', PING_LIMITS.intervalMs),
      timeoutMs: optionalInteger(ctx, body, 'timeoutMs', PING_LIMITS.timeoutMs),
      signal: req.signal,
    });
  }, { summary: 'ping a node' });

  ctx.api.route('POST', '/diag/traceroute', async (req) => {
    const body = objectBody(ctx, req.body, ['to', 'maxHops', 'timeoutMs']);
    if (!isNodeId(body.to)) throw invalid(ctx, 'to', 'must be a NodeId');
    if (body.to === ctx.nodeId) throw invalid(ctx, 'to', 'must not be this node');
    return api.traceroute(body.to, {
      maxHops: optionalInteger(ctx, body, 'maxHops', [1, ctx.config.limits.ttl]),
      timeoutMs: optionalInteger(ctx, body, 'timeoutMs', TRACE_TIMEOUT_LIMITS),
      signal: req.signal,
    });
  }, { summary: 'trace the path to a node' });

  ctx.api.route('GET', '/diag/counters', (req) => {
    for (const key of Object.keys(req.query)) throw invalid(ctx, key, 'unknown query parameter');
    return api.counters();
  }, { summary: 'counters and rates' });
}
