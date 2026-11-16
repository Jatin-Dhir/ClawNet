/**
 * A loopback TCP proxy that stands in front of one node's listener (ARCHITECTURE.md 10.1).
 *
 * A link "through netem" is made by dialing the proxy instead of the node. The proxy can
 * delay bytes, blackhole them (read and discard, connections stay open), cut every
 * connection at once, and records the bytes it carries so tests can assert that
 * plaintext, NodeIds and keys never appear on the wire.
 *
 * Directions: "up" is dialer to target, "down" is target to dialer.
 */

import net from 'node:net';

import { parseAddress } from '../../src/core/wire/schema.js';

/** Queued but undelivered bytes per direction above which the source socket is paused. */
const MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;

/**
 * Start a proxy on 127.0.0.1, port 0.
 *
 * @param {object} options
 * @param {{ host: string, port: number } | string} options.target the node's listener, as
 *   an object or an Address ("tcp://127.0.0.1:1234")
 * @param {number} [options.latencyMs=0] delay added to every chunk, each direction
 * @param {number} [options.jitterMs=0]  extra uniform delay in [0, jitterMs]
 * @param {boolean} [options.record=true] keep the bytes for recorded()/contains()
 * @param {number} [options.maxRecordBytes] recording stops silently at this many bytes
 *   per direction; default 16 MiB
 * @returns {Promise<Netem>}
 */
export async function createNetem({
  target,
  latencyMs = 0,
  jitterMs = 0,
  record = true,
  maxRecordBytes = 16 * 1024 * 1024,
} = {}) {
  const resolved = typeof target === 'string' ? parseAddress(target) : target;
  if (resolved === null || typeof resolved?.host !== 'string' || !Number.isInteger(resolved?.port)) {
    throw new TypeError('target must be { host, port } or a valid address');
  }
  const netem = new Netem({ target: resolved, latencyMs, jitterMs, record, maxRecordBytes });
  await netem.listen();
  return netem;
}

/** One direction of one proxied connection: delays chunks, preserving their order. */
class Pipe {
  #netem;
  #direction;
  #from;
  #to;
  #queue = [];
  #queuedBytes = 0;
  #timer = null;
  #lastDeliverAt = 0;

  constructor(netem, direction, from, to) {
    this.#netem = netem;
    this.#direction = direction;
    this.#from = from;
    this.#to = to;
    from.on('data', chunk => this.#onChunk(chunk));
    to.on('drain', () => this.#pump());
  }

  #onChunk(chunk) {
    this.#netem.observe(this.#direction, chunk);
    if (this.#netem.isBlackholed(this.#direction)) {
      this.#netem.countDropped(this.#direction, chunk.length);
      return;
    }
    const { latencyMs, jitterMs } = this.#netem.delay();
    // Never before an earlier chunk of the same direction: TCP order is preserved.
    const due = Math.max(performance.now() + latencyMs + Math.random() * jitterMs, this.#lastDeliverAt);
    this.#lastDeliverAt = due;
    this.#queue.push({ chunk, due });
    this.#queuedBytes += chunk.length;
    if (this.#queuedBytes > MAX_IN_FLIGHT_BYTES) this.#from.pause();
    this.#pump();
  }

  #pump() {
    if (this.#timer !== null) return;
    while (this.#queue.length > 0) {
      if (this.#to.destroyed) {
        this.#queue = [];
        this.#queuedBytes = 0;
        return;
      }
      const head = this.#queue[0];
      const wait = head.due - performance.now();
      if (wait > 0) {
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#pump();
        }, Math.ceil(wait));
        return;
      }
      if (this.#to.writableNeedDrain) return;
      this.#queue.shift();
      this.#queuedBytes -= head.chunk.length;
      this.#to.write(head.chunk);
    }
    if (this.#queuedBytes <= MAX_IN_FLIGHT_BYTES && this.#from.isPaused()) this.#from.resume();
  }

  stop() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.#queuedBytes = 0;
  }
}

export class Netem {
  #target;
  #latencyMs;
  #jitterMs;
  #record;
  #maxRecordBytes;
  #server = null;
  #cut = false;
  #blackhole = { up: false, down: false };
  /** @type {Set<{ client: net.Socket, upstream: net.Socket, pipes: Pipe[] }>} */
  #connections = new Set();
  #recorded = { up: [], down: [] };
  #recordedBytes = { up: 0, down: 0 };
  #stats = { accepted: 0, refused: 0, bytesUp: 0, bytesDown: 0, droppedUp: 0, droppedDown: 0 };

  /** @type {string} what the dialing node connects to */
  address = '';
  /** @type {number} */
  port = 0;

  constructor({ target, latencyMs, jitterMs, record, maxRecordBytes }) {
    this.#target = { host: target.host, port: target.port };
    this.#latencyMs = latencyMs;
    this.#jitterMs = jitterMs;
    this.#record = record;
    this.#maxRecordBytes = maxRecordBytes;
  }

  /** @returns {Promise<void>} */
  listen() {
    this.#server = net.createServer({ allowHalfOpen: false }, client => this.#accept(client));
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: '127.0.0.1', port: 0 }, () => {
        this.port = this.#server.address().port;
        this.address = `tcp://127.0.0.1:${this.port}`;
        resolve();
      });
    });
  }

  #accept(client) {
    client.on('error', () => {});
    if (this.#cut) {
      this.#stats.refused += 1;
      client.resetAndDestroy();
      return;
    }
    this.#stats.accepted += 1;
    client.setNoDelay(true);
    const upstream = net.connect({ host: this.#target.host, port: this.#target.port, allowHalfOpen: false });
    upstream.setNoDelay(true);
    upstream.on('error', () => {});
    const connection = { client, upstream, pipes: [] };
    connection.pipes.push(new Pipe(this, 'up', client, upstream), new Pipe(this, 'down', upstream, client));
    this.#connections.add(connection);
    const teardown = () => {
      if (!this.#connections.delete(connection)) return;
      for (const pipe of connection.pipes) pipe.stop();
      client.destroy();
      upstream.destroy();
    };
    client.on('close', teardown);
    upstream.on('close', teardown);
  }

  /** @internal */
  observe(direction, chunk) {
    if (direction === 'up') this.#stats.bytesUp += chunk.length;
    else this.#stats.bytesDown += chunk.length;
    if (!this.#record) return;
    const room = this.#maxRecordBytes - this.#recordedBytes[direction];
    if (room <= 0) return;
    const kept = chunk.length <= room ? Buffer.from(chunk) : Buffer.from(chunk.subarray(0, room));
    this.#recorded[direction].push(kept);
    this.#recordedBytes[direction] += kept.length;
  }

  /** @internal */
  isBlackholed(direction) {
    return this.#blackhole[direction];
  }

  /** @internal */
  countDropped(direction, bytes) {
    if (direction === 'up') this.#stats.droppedUp += bytes;
    else this.#stats.droppedDown += bytes;
  }

  /** @internal */
  delay() {
    return { latencyMs: this.#latencyMs, jitterMs: this.#jitterMs };
  }

  /**
   * Set the delay for both directions; byte order is always preserved.
   *
   * @param {number} ms
   * @param {number} [jitterMs=0]
   */
  setLatency(ms, jitterMs = 0) {
    this.#latencyMs = ms;
    this.#jitterMs = jitterMs;
  }

  /**
   * Discard bytes instead of forwarding them. Connections stay open, so the nodes notice
   * only through their keepalive. Discarded bytes are still recorded.
   *
   * @param {boolean} [on=true]
   * @param {{ direction?: "up" | "down" | "both" }} [options]
   */
  blackhole(on = true, { direction = 'both' } = {}) {
    if (direction === 'up' || direction === 'both') this.#blackhole.up = on;
    if (direction === 'down' || direction === 'both') this.#blackhole.down = on;
  }

  /** Reset every connection now (both nodes see a socket error) and refuse new ones. */
  cut() {
    this.#cut = true;
    for (const { client, upstream, pipes } of [...this.#connections]) {
      for (const pipe of pipes) pipe.stop();
      client.resetAndDestroy();
      upstream.resetAndDestroy();
    }
  }

  /** Accept connections again and stop blackholing. */
  heal() {
    this.#cut = false;
    this.#blackhole.up = false;
    this.#blackhole.down = false;
  }

  /** @returns {number} open proxied connections */
  get connections() {
    return this.#connections.size;
  }

  /**
   * @param {"up" | "down" | "both"} [direction="both"]
   * @returns {Buffer} the bytes seen, in arrival order per direction ("both": up then down)
   */
  recorded(direction = 'both') {
    if (direction === 'both') return Buffer.concat([...this.#recorded.up, ...this.#recorded.down]);
    return Buffer.concat(this.#recorded[direction]);
  }

  /**
   * Whether `needle` occurs in either direction's whole recorded byte stream. Only
   * meaningful for needles long enough not to occur by chance (16 bytes or more).
   *
   * @param {Buffer | string} needle
   * @returns {boolean}
   */
  contains(needle) {
    const bytes = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : needle;
    return this.recorded('up').includes(bytes) || this.recorded('down').includes(bytes);
  }

  /** Forget everything recorded so far. */
  clearRecording() {
    this.#recorded = { up: [], down: [] };
    this.#recordedBytes = { up: 0, down: 0 };
  }

  /** @returns {{ accepted: number, refused: number, bytesUp: number, bytesDown: number, droppedUp: number, droppedDown: number }} */
  stats() {
    return { ...this.#stats };
  }

  /** Close the proxy and every connection through it. @returns {Promise<void>} */
  close() {
    for (const { client, upstream, pipes } of [...this.#connections]) {
      for (const pipe of pipes) pipe.stop();
      client.destroy();
      upstream.destroy();
    }
    this.#connections.clear();
    return new Promise(resolve => {
      if (this.#server === null || !this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
  }
}
