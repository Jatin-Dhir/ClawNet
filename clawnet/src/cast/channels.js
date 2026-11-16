/**
 * ClawCast: broadcast channels (ARCHITECTURE.md 8.1, DESIGN.md sections 11 and 15.24 to
 * 15.25).
 *
 * A cast is a signed record in the `cast` log dataset that every node floods and
 * synchronizes through ClawSync, whether or not it joined the channel. A node that joined
 * a channel additionally surfaces the casts of that channel (decrypting them when the
 * channel has a key), keeps a bounded history and reports them as `cast.message` events.
 *
 * Two decisions of DESIGN.md section 15 shape the dataset's check function:
 *
 *   - Item 25, the rate limit is a function of signed content. With K =
 *     `limits.castPerOriginPerMin` (kept below the retention window, see `effectiveRate`),
 *     an honest origin's records `n` and `n - jK` are at least j minutes apart, for every
 *     j. A record is admitted only if that holds against every held record `n - jK` and
 *     `n + jK` of its stream, and it does not jump more than K past the newest index.
 *     Every node holding the same records reaches the same verdict, and a backlog that
 *     arrives in one go after a partition is not mistaken for a flood, which a token
 *     bucket filled at arrival time would do. A record none of whose neighbours is held
 *     cannot be judged and is admitted, so an honest record is never refused whatever the
 *     order of arrival (a record that jumps past the newest index waits for the ones before
 *     it, and anti-entropy offers it again). For a hostile origin the same rule bounds what
 *     any set of held records can contain: per residue of the counter modulo K, members
 *     that are j steps apart need j minutes between them, so a span of D minutes holds at
 *     most K * (D + 1) of them, however they arrive. Two nodes can disagree about a
 *     hostile origin's records, depending on arrival order, but never about an honest one's.
 *   - Item 24, encryption is bound to its record. `castEncrypt` puts origin, channel,
 *     counter and time into the key derivation and the associated data, so a non-member
 *     that re-signs a member's ciphertext as its own produces a record no member can open.
 *
 * Check functions follow ARCHITECTURE.md 4.5: schema and signature failures are hard
 * (the relaying peer is blamed), everything that depends on this node's clock, records or
 * quotas is soft.
 */

import { ConfigError, StateError } from '../core/errors.js';
import { castDecrypt, castEncrypt, channelWireId } from '../core/crypto/envelope.js';
import { verifyRecord } from '../core/crypto/identity.js';
import { base64Decode, base64Encode } from '../core/crypto/primitives.js';
import { validateCast } from '../core/wire/schema.js';
import { CHANNEL_ID_PATTERN, Limits, RecordType } from '../core/wire/types.js';
import { LogDataset } from '../sync/datasets.js';

/** A channel name: what people type; forwarders only ever see its wire id. */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Most streams (channels) one origin may have open in the dataset at once. */
export const MAX_STREAMS_PER_ORIGIN = 16;

/** The window of the rate limit: at most K casts per stream in any span of this length. */
export const RATE_WINDOW_MS = 60_000;

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const MAX_HISTORY_PAGE = 500;
const DEFAULT_HISTORY_PAGE = 50;
// Rejections are reported at most this often, so a flood cannot fill the event buffer.
const REJECT_EVENT_INTERVAL_MS = 1000;
const MAX_ORIGINS_REMEMBERED = 4096;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
  return value;
}

/** The structure of the `channels` document; a document that fails this is set aside. */
function validChannelsDoc(value) {
  if (value === null || typeof value !== 'object' || value.v !== 1 || !Array.isArray(value.channels)) return false;
  return value.channels.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.name === 'string' &&
      CHANNEL_NAME_PATTERN.test(entry.name) &&
      (entry.key === null || typeof entry.key === 'string') &&
      typeof entry.chan === 'string' &&
      CHANNEL_ID_PATTERN.test(entry.chan) &&
      Number.isSafeInteger(entry.nextN) &&
      entry.nextN >= 1 &&
      Number.isSafeInteger(entry.joinedAt) &&
      entry.joinedAt >= 0,
  );
}

/**
 * Create the ClawCast service (service name `cast`).
 *
 * @param {object} [options]
 * @param {number} [options.maxPerStream=64] retention window of the dataset per stream
 * @param {number} [options.maxStreams=1024] streams the dataset tracks
 * @param {number} [options.historyPerChannel=1000] newest messages kept per joined channel
 * @returns {object} a Service (ARCHITECTURE.md section 6); `api` offers `list`, `join`,
 *   `leave`, `publish` and `history`
 * @throws {ConfigError} if an option is not a positive integer
 */
export function createCastService({ maxPerStream = 64, maxStreams = 1024, historyPerChannel = 1000 } = {}) {
  requirePositiveInteger(maxPerStream, 'maxPerStream');
  requirePositiveInteger(maxStreams, 'maxStreams');
  requirePositiveInteger(historyPerChannel, 'historyPerChannel');

  /** @type {object | null} */
  let ctx = null;
  /** @type {LogDataset | null} */
  let dataset = null;
  let doc = null;
  let historyLog = null;
  let selfId = '';
  let limits = null;
  let tail = Promise.resolve();
  let seq = 0;
  let lastRejectEventAt = -Infinity;

  /** name -> { name, key: Buffer | null, chan, nextN, joinedAt } */
  const channels = new Map();
  /** chan -> channel */
  const byChan = new Map();
  /** chan -> messages, oldest first */
  const messages = new Map();
  /** `chan:origin:n` of every message in `messages` */
  const surfaced = new Set();
  /** origin -> streams that origin has open in the dataset */
  const originStreams = new Map();
  /** Our own publish times, newest last: the local, cross-channel half of the rate limit. */
  const recentPublishes = [];
  const counters = {
    joined: 0,
    published: 0,
    received: 0,
    surfaced: 0,
    undecryptable: 0,
    rateRejected: 0,
    streamRejected: 0,
  };

  const streamOf = (record) => `${record.chan}:${record.origin}`;

  /** K of the rate limit: the configured rate, kept inside what a stream retains. */
  const effectiveRate = () => Math.min(limits.castPerOriginPerMin, maxPerStream - 1);

  function serialized(work) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }

  function reportRejected(record, reason) {
    const at = ctx.now();
    if (at - lastRejectEventAt < REJECT_EVENT_INTERVAL_MS) return;
    lastRejectEventAt = at;
    ctx.events.emit('cast.rejected', { origin: record.origin, chan: record.chan, reason });
  }

  // ------------------------------------------------------------------ dataset check

  /**
   * The content-based rate rule (DESIGN.md 15.25), for a record of `stream` with counter
   * `n` and time `ts`. Reads the dataset, changes nothing.
   *
   * @returns {{ reason: 'rate' | 'gap', retryInMs: number } | null} why the record is
   *   refused, and how long waiting would help (Infinity if it would not), or null
   */
  function spacingProblem(stream, n, ts) {
    const rate = effectiveRate();
    if (rate < 1) return { reason: 'rate', retryInMs: RATE_WINDOW_MS };
    const top = dataset.topOf(stream);
    // Nothing held, so nothing to compare against: the record cannot be judged and is admitted.
    if (top === undefined) return null;
    if (n > top + rate) return { reason: 'gap', retryInMs: Infinity };
    let retryInMs = 0;
    // Walk the records held, at most one retention window of them, and not the counters
    // between them and `n`: `n` is unverified input, and stepping from it would let one
    // forged record with a huge counter keep this thread busy before its signature is read.
    for (const held of dataset.range(stream, 1, Number.MAX_SAFE_INTEGER)) {
      const distance = n - held.n;
      if (distance === 0 || distance % rate !== 0) continue;
      const steps = Math.abs(distance) / rate;
      if (distance > 0) {
        retryInMs = Math.max(retryInMs, held.ts + steps * RATE_WINDOW_MS - ts);
      } else if (held.ts - ts < steps * RATE_WINDOW_MS) {
        retryInMs = Infinity;
      }
    }
    return retryInMs > 0 ? { reason: 'rate', retryInMs } : null;
  }

  function check(record) {
    if (!validateCast(record).ok) return { ok: false, reason: 'invalid-cast' };
    // Before the signature, so that a flood costs no signature work.
    const problem = spacingProblem(streamOf(record), record.n, record.ts);
    if (problem !== null) {
      counters.rateRejected += 1;
      reportRejected(record, problem.reason);
      return { ok: false, reason: problem.reason, soft: true };
    }
    if (!verifyRecord(record, RecordType.CAST).ok) return { ok: false, reason: 'bad-signature' };
    const at = ctx.now();
    if (record.ts > at + limits.maxClockSkewMs) return { ok: false, reason: 'future', soft: true };
    if (record.ts < at - limits.messageLifetimeMs) return { ok: false, reason: 'expired', soft: true };
    const stream = streamOf(record);
    if (dataset.topOf(stream) === undefined && openStreamsOf(record.origin) >= MAX_STREAMS_PER_ORIGIN) {
      counters.streamRejected += 1;
      reportRejected(record, 'streams');
      return { ok: false, reason: 'streams', soft: true };
    }
    return { ok: true };
  }

  /**
   * How many streams `origin` has open in the dataset. The side table can hold streams the
   * dataset has since dropped (it evicts when full, and the sweep drops quiet ones), so
   * the entry is trimmed against the dataset before it is counted.
   */
  function openStreamsOf(origin) {
    const streams = originStreams.get(origin);
    if (streams === undefined) return 0;
    for (const stream of streams) if (dataset.topOf(stream) === undefined) streams.delete(stream);
    if (streams.size === 0) originStreams.delete(origin);
    return streams.size;
  }

  function onAccept(record) {
    const stream = streamOf(record);
    let streams = originStreams.get(record.origin);
    if (streams === undefined) {
      // Entries only outlive their streams until trimmed, so after a trim the table holds
      // at most one origin per stream the dataset tracks and there is always room. The cap
      // must never switch the per-origin limit off for an origin it stops tracking.
      if (originStreams.size >= Math.max(MAX_ORIGINS_REMEMBERED, maxStreams)) {
        for (const origin of [...originStreams.keys()]) openStreamsOf(origin);
      }
      streams = new Set();
      originStreams.set(record.origin, streams);
    }
    streams.add(stream);
    counters.received += 1;
    const channel = byChan.get(record.chan);
    if (channel !== undefined) surface(channel, record);
  }

  function onSelfNewer({ stream, index }) {
    const channel = byChan.get(stream.slice(0, stream.indexOf(':')));
    if (channel === undefined || index < channel.nextN) return;
    channel.nextN = index + 1;
    persistChannel(channel);
  }

  // ------------------------------------------------------------------ surfacing

  /** Turn a record of a joined channel into text, or null when it is not for this channel. */
  function open(channel, record) {
    try {
      let plaintext;
      if (channel.key !== null) {
        if (!record.enc) return null;
        plaintext = castDecrypt({
          channelKey: channel.key,
          fields: { type: record.type, origin: record.origin, chan: record.chan, n: record.n, ts: record.ts, enc: true },
          salt: base64Decode(record.salt, SALT_BYTES),
          ciphertext: base64Decode(record.body),
        });
      } else {
        if (record.enc) return null;
        plaintext = base64Decode(record.body);
      }
      return UTF8.decode(plaintext);
    } catch {
      return null;
    }
  }

  function surface(channel, record) {
    const key = `${record.chan}:${record.origin}:${record.n}`;
    if (surfaced.has(key)) return;
    const text = open(channel, record);
    if (text === null) {
      counters.undecryptable += 1;
      reportRejected(record, 'undecryptable');
      return;
    }
    seq += 1;
    const message = { seq, chan: record.chan, origin: record.origin, n: record.n, ts: record.ts, text, at: ctx.now() };
    let list = messages.get(record.chan);
    if (list === undefined) {
      list = [];
      messages.set(record.chan, list);
    }
    list.push(message);
    surfaced.add(key);
    while (list.length > historyPerChannel) {
      const dropped = list.shift();
      surfaced.delete(`${dropped.chan}:${dropped.origin}:${dropped.n}`);
    }
    counters.surfaced += 1;
    historyLog.append({ op: 'add', ...message }).catch((error) => ctx.log.warn('cast history append failed', { error: String(error?.message ?? error) }));
    ctx.events.emit('cast.message', { message: view(channel, message) });
  }

  function view(channel, message) {
    return {
      seq: message.seq,
      channel: channel.name,
      chan: message.chan,
      origin: message.origin,
      n: message.n,
      ts: message.ts,
      text: message.text,
      at: message.at,
      mine: message.origin === selfId,
    };
  }

  /** Surface what the dataset already holds for a channel that has just been joined. */
  function backfill(channel) {
    const prefix = `${channel.chan}:`;
    for (const stream of dataset.streams()) {
      if (!stream.startsWith(prefix)) continue;
      for (const record of dataset.range(stream, 1, Number.MAX_SAFE_INTEGER)) surface(channel, record);
    }
  }

  function info(channel) {
    const list = messages.get(channel.chan) ?? [];
    let lastMessageAt = null;
    for (const message of list) if (lastMessageAt === null || message.ts > lastMessageAt) lastMessageAt = message.ts;
    return {
      name: channel.name,
      chan: channel.chan,
      encrypted: channel.key !== null,
      joinedAt: channel.joinedAt,
      messages: list.length,
      lastMessageAt,
    };
  }

  // ------------------------------------------------------------------ persistence

  function persistChannel(channel) {
    doc.update((data) => {
      const entry = data.channels.find((candidate) => candidate.chan === channel.chan);
      if (entry !== undefined) entry.nextN = channel.nextN;
    });
  }

  async function loadChannels() {
    await doc.load();
    for (const entry of doc.data.channels) {
      let key = null;
      try {
        key = entry.key === null ? null : base64Decode(entry.key, KEY_BYTES);
      } catch {
        ctx.log.warn('cast: ignoring a stored channel with an unreadable key', { chan: entry.chan });
        continue;
      }
      const channel = { name: entry.name, key, chan: entry.chan, nextN: entry.nextN, joinedAt: entry.joinedAt };
      channels.set(channel.name, channel);
      byChan.set(channel.chan, channel);
    }
  }

  async function loadHistory() {
    await historyLog.open();
    let lines = 0;
    for await (const record of historyLog.read()) {
      lines += 1;
      if (record.op === 'del' && typeof record.chan === 'string') {
        messages.delete(record.chan);
      } else if (record.op === 'add' && byChan.has(record.chan)) {
        let list = messages.get(record.chan);
        if (list === undefined) {
          list = [];
          messages.set(record.chan, list);
        }
        const { op: _op, ...message } = record;
        list.push(message);
      }
    }
    let live = 0;
    for (const [chan, list] of messages) {
      if (list.length > historyPerChannel) list.splice(0, list.length - historyPerChannel);
      for (const message of list) {
        surfaced.add(`${chan}:${message.origin}:${message.n}`);
        seq = Math.max(seq, message.seq);
        live += 1;
      }
    }
    // Leave drops history and retention trims it: compact once the file is mostly dead.
    if (lines > 2 * live + 64) {
      await historyLog.rewrite([...messages.values()].flat().sort((a, b) => a.seq - b.seq).map((message) => ({ op: 'add', ...message })));
    }
  }

  // ------------------------------------------------------------------ operations

  function requireJoined(name) {
    const channel = channels.get(name);
    if (channel === undefined) throw new StateError(`not-joined: channel "${String(name).slice(0, 64)}" is not joined`);
    return channel;
  }

  function join(name, { key } = {}) {
    if (typeof name !== 'string' || !CHANNEL_NAME_PATTERN.test(name)) {
      throw new ConfigError('channel name must match /^[a-z0-9][a-z0-9._-]{0,63}$/');
    }
    if (key !== undefined && (!(key instanceof Uint8Array) || key.length !== KEY_BYTES)) {
      throw new ConfigError('channel key must be 32 bytes');
    }
    return serialized(async () => {
      const keyBytes = key === undefined ? null : Buffer.from(key);
      const chan = channelWireId(name, keyBytes ?? undefined);
      const existing = channels.get(name);
      if (existing !== undefined) {
        if (existing.chan !== chan) throw new StateError(`already-joined: channel "${name}" is joined with another key`);
        return info(existing);
      }
      const channel = { name, key: keyBytes, chan, nextN: 1, joinedAt: ctx.now() };
      doc.update((data) => {
        data.channels.push({
          name,
          key: keyBytes === null ? null : base64Encode(keyBytes),
          chan,
          nextN: channel.nextN,
          joinedAt: channel.joinedAt,
        });
      });
      await doc.flush();
      channels.set(name, channel);
      byChan.set(chan, channel);
      dataset.priorityChanged();
      counters.joined += 1;
      ctx.events.emit('cast.joined', { name, chan, encrypted: keyBytes !== null });
      backfill(channel);
      return info(channel);
    });
  }

  function leave(name) {
    return serialized(async () => {
      const channel = requireJoined(name);
      doc.update((data) => {
        data.channels = data.channels.filter((entry) => entry.chan !== channel.chan);
      });
      await doc.flush();
      channels.delete(name);
      byChan.delete(channel.chan);
      dataset.priorityChanged();
      for (const message of messages.get(channel.chan) ?? []) surfaced.delete(`${message.chan}:${message.origin}:${message.n}`);
      messages.delete(channel.chan);
      await historyLog.append({ op: 'del', chan: channel.chan });
      ctx.events.emit('cast.left', { name, chan: channel.chan });
      return true;
    });
  }

  /** Milliseconds until a publish at `at` would respect the local rate, 0 if it does now. */
  function localRetryIn(at) {
    const rate = effectiveRate();
    if (rate < 1) return RATE_WINDOW_MS;
    while (recentPublishes.length > 0 && recentPublishes[0] <= at - RATE_WINDOW_MS) recentPublishes.shift();
    if (recentPublishes.length < rate) return 0;
    return recentPublishes[recentPublishes.length - rate] + RATE_WINDOW_MS - at;
  }

  function rateLimited(retryInMs) {
    const error = new StateError(`rate-limited: at most ${effectiveRate()} casts per minute; retry in ${retryInMs} ms`);
    error.retryInMs = retryInMs;
    return error;
  }

  function publish(name, text) {
    if (typeof text !== 'string' || !text.isWellFormed()) throw new ConfigError('text must be a well-formed string');
    const plaintext = Buffer.from(text, 'utf8');
    if (plaintext.length < 1 || plaintext.length > Limits.MAX_CAST_BODY) {
      throw new ConfigError(`text must be 1 to ${Limits.MAX_CAST_BODY} bytes of UTF-8`);
    }
    return serialized(async () => {
      const channel = requireJoined(name);
      const at = ctx.now();
      const retryIn = localRetryIn(at);
      if (retryIn > 0) throw rateLimited(retryIn);
      const stream = `${channel.chan}:${selfId}`;
      // The counter never repeats: past what we stored, and past anything the network
      // still holds of ours (DESIGN.md 15.16, after a restart that lost the document).
      const n = Math.max(channel.nextN, (dataset.topOf(stream) ?? 0) + 1);
      // The same spacing rule every node applies, against records of ours that outlived a restart.
      const problem = spacingProblem(stream, n, at);
      if (problem !== null) throw rateLimited(Number.isFinite(problem.retryInMs) ? problem.retryInMs : RATE_WINDOW_MS);
      channel.nextN = n + 1;
      persistChannel(channel);
      await doc.flush();
      const fields = { chan: channel.chan, n, ts: at };
      if (channel.key === null) {
        Object.assign(fields, { enc: false, body: base64Encode(plaintext) });
      } else {
        const { salt, ciphertext } = castEncrypt({
          channelKey: channel.key,
          fields: { type: RecordType.CAST, origin: selfId, chan: channel.chan, n, ts: at, enc: true },
          plaintext,
        });
        Object.assign(fields, { enc: true, salt: base64Encode(salt), body: base64Encode(ciphertext) });
      }
      const result = ctx.sync.publish('cast', ctx.identity.signRecord(RecordType.CAST, fields));
      if (!result.accepted) throw new StateError(`publish-refused: the cast dataset refused our own record (${result.reason ?? 'unknown'})`);
      recentPublishes.push(at);
      counters.published += 1;
      const stored = messages.get(channel.chan)?.findLast((message) => message.origin === selfId && message.n === n);
      return view(channel, stored ?? { seq: 0, chan: channel.chan, origin: selfId, n, ts: at, text, at });
    });
  }

  function history(name, { before, limit = DEFAULT_HISTORY_PAGE } = {}) {
    const channel = requireJoined(name);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) {
      throw new ConfigError(`limit must be an integer from 1 to ${MAX_HISTORY_PAGE}`);
    }
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw new ConfigError('before must be a positive integer');
    }
    const list = messages.get(channel.chan) ?? [];
    const older = before === undefined ? list : list.filter((message) => message.seq < before);
    const items = older.slice(-limit).reverse();
    const nextBefore = older.length > items.length ? items[items.length - 1].seq : null;
    return { items: items.map((message) => view(channel, message)), nextBefore };
  }

  /** Free the stream slots of channels and publishers that have gone quiet. */
  function sweep() {
    const horizon = ctx.now() - limits.messageLifetimeMs;
    for (const stream of dataset.streams()) {
      const top = dataset.topOf(stream);
      const newest = top === undefined ? undefined : dataset.get(stream, top);
      if (newest !== undefined && newest.ts >= horizon) continue;
      dataset.dropStream(stream);
      const origin = stream.slice(stream.indexOf(':') + 1);
      const streams = originStreams.get(origin);
      streams?.delete(stream);
      if (streams?.size === 0) originStreams.delete(origin);
    }
  }

  // ------------------------------------------------------------------ API routes

  function invalid(field, problem) {
    return ctx.api.error(400, 'invalid_request', `${field}: ${problem}`, { field, problem });
  }

  /** Give a rate-limit error the status and details API.md section 4 asks for. */
  async function mapped(work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StateError && error.retryInMs !== undefined) {
        throw ctx.api.error(429, 'rate_limited', error.message, { retryInMs: error.retryInMs });
      }
      throw error;
    }
  }

  function integerQuery(query, field) {
    const raw = query?.[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^[0-9]{1,15}$/.test(raw)) throw invalid(field, 'must be a non-negative integer');
    return Number(raw);
  }

  function registerRoutes() {
    ctx.api.route('GET', '/channels', async () => ({ channels: api.list() }), { summary: 'joined channels' });
    ctx.api.route(
      'POST',
      '/channels',
      async ({ body }) => {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'must be an object');
        for (const field of Object.keys(body)) if (field !== 'name' && field !== 'key') throw invalid(field, 'unknown field');
        if (typeof body.name !== 'string' || !CHANNEL_NAME_PATTERN.test(body.name)) {
          throw invalid('name', 'must match /^[a-z0-9][a-z0-9._-]{0,63}$/');
        }
        let key;
        if (body.key !== undefined) {
          try {
            key = base64Decode(body.key, KEY_BYTES);
          } catch {
            throw invalid('key', 'must be base64 of exactly 32 bytes');
          }
        }
        const existed = channels.has(body.name);
        const channel = await join(body.name, { key });
        return existed ? { channel } : ctx.api.reply(201, { channel });
      },
      { summary: 'join a channel' },
    );
    ctx.api.route(
      'DELETE',
      '/channels/:name',
      async ({ params }) => {
        await leave(params.name);
        return { left: true };
      },
      { summary: 'leave a channel and delete its history' },
    );
    ctx.api.route(
      'POST',
      '/channels/:name/messages',
      async ({ params, body }) => {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'must be an object');
        for (const field of Object.keys(body)) if (field !== 'text') throw invalid(field, 'unknown field');
        if (typeof body.text !== 'string') throw invalid('text', 'must be a string');
        requireJoined(params.name);
        const message = await mapped(() => publish(params.name, body.text));
        return ctx.api.reply(202, { message });
      },
      { summary: 'publish to a channel' },
    );
    ctx.api.route(
      'GET',
      '/channels/:name/messages',
      async ({ params, query }) => {
        const limit = integerQuery(query, 'limit');
        const before = integerQuery(query, 'before');
        const page = history(params.name, { before, limit });
        return { channel: params.name, items: page.items, nextBefore: page.nextBefore };
      },
      { summary: 'channel history, newest first' },
    );
  }

  const api = {
    /**
     * @returns {object[]} ChannelInfo of every joined channel, by name
     */
    list: () => [...channels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(info),
    /**
     * Join a channel; joining again with the same key changes nothing.
     *
     * @param {string} name CHANNEL_NAME_PATTERN
     * @param {{ key?: Uint8Array }} [options] 32-byte channel key; omit for a public channel
     * @returns {Promise<object>} ChannelInfo
     * @throws {ConfigError} for a bad name or key
     * @throws {StateError} `already-joined` when the name is joined with another key
     */
    join,
    /**
     * Leave a channel and delete its local history; the node keeps relaying its casts.
     *
     * @param {string} name
     * @returns {Promise<true>}
     * @throws {StateError} `not-joined`
     */
    leave,
    /**
     * Publish a cast.
     *
     * @param {string} name a joined channel
     * @param {string} text 1 to 16384 bytes of UTF-8
     * @returns {Promise<object>} the CastMessage as this node now holds it
     * @throws {ConfigError} for bad text
     * @throws {StateError} `not-joined`, or `rate-limited` (the error has `retryInMs`)
     */
    publish,
    /**
     * A page of a channel's history, newest first.
     *
     * @param {string} name a joined channel
     * @param {{ before?: number, limit?: number }} [options] `before`: a `seq` cursor
     * @returns {{ items: object[], nextBefore: number | null }}
     * @throws {StateError} `not-joined`
     * @throws {ConfigError} for a bad cursor or limit
     */
    history,
  };

  return {
    name: 'cast',
    api,

    async init(serviceContext) {
      ctx = serviceContext;
      selfId = ctx.nodeId;
      limits = ctx.config.limits;
      dataset = new LogDataset({
        name: 'cast',
        stream: streamOf,
        index: (record) => record.n,
        check,
        onAccept,
        ownStream: (stream) => stream.endsWith(`:${selfId}`),
        onSelfNewer,
        // A full table gives its slot to a stream of a channel this node joined over one of
        // a channel it only relays, so junk streams cannot crowd out the ones in use.
        priority: (stream) => (byChan.has(stream.slice(0, stream.indexOf(':'))) ? 2 : 1),
        maxPerStream,
        maxStreams,
      });
      ctx.sync.addDataset(dataset);
      doc = ctx.storage.doc('channels', { defaults: { v: 1, channels: [] }, validate: validChannelsDoc });
      historyLog = ctx.storage.log('history');
      await loadChannels();
      await loadHistory();
      registerRoutes();
    },

    start() {
      ctx.every(sweep, ctx.config.timers.retransmitMaxMs);
    },

    async stop() {
      await tail.catch(() => {});
      await doc.flush();
      await historyLog.flush();
    },

    stats() {
      let entries = 0;
      for (const list of messages.values()) entries += list.length;
      return { ...counters, historyEntries: entries };
    },
  };
}
