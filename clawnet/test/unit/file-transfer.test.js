/**
 * File transfer between two services joined by a fake network that can drop, delay,
 * duplicate and reorder chunks and messages, over a manual clock. Everything else is real:
 * the sealing of chunks, the sealed storage, and the files, which live in a temporary
 * directory and are read and written for real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  DEFAULT_OFFER_TTL_MS,
  INITIAL_WINDOW,
  MAX_CHUNKS,
  SACK_MAX_RANGES,
  createFileTransferService,
  sanitizeFileName,
} from '../../src/vault/file-transfer.js';
import { peekChunk, sealChunk } from '../../src/core/crypto/envelope.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { ClawNetError, ConfigError, StateError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { NodeStorage } from '../../src/core/storage.js';
import { PacketType } from '../../src/core/wire/types.js';
import { tempDir } from '../helpers/tmp.js';

const STEP_MS = 5;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** A network of fake service contexts on one manual clock. */
class Net {
  now = 1_000_000;
  /** false: a blackhole. Packets are accepted by the sender's route and vanish; reliable messages wait. */
  up = true;
  /** false: the sender has no route at all, and `originate` says so. */
  routable = true;
  members = new Map();
  nodes = [];
  everys = [];
  queue = [];
  log = [];
  /** @type {null | ((info: object) => { drop?: boolean, duplicate?: boolean, delayMs?: number })} */
  chunkFilter = null;
  /** @type {null | ((info: object) => boolean)} */
  messageFilter = null;
  pendingIds = new Set();
  held = [];
  latencyMs = STEP_MS;
  chunksInFlight = 0;
  maxChunksInFlight = 0;

  step(ms = STEP_MS) {
    this.now += ms;
    for (;;) {
      const due = this.queue.filter((entry) => entry.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (due.length === 0) break;
      for (const entry of due) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        entry.run();
      }
    }
    for (const every of this.everys) {
      if (this.now >= every.next) {
        every.next = this.now + every.ms;
        every.fn();
      }
    }
  }

  later(ms, run) {
    this.queue.push({ at: this.now + ms, seq: this.queue.length, run });
  }

  /** Advance the clock until `predicate` holds, giving real I/O time to finish between steps. */
  async until(predicate, { maxSteps = 8000, patienceMs = 30000, message = 'the condition' } = {}) {
    for (let i = 0; i < maxSteps; i += 1) {
      if (await predicate()) return;
      this.step();
      await new Promise((resolve) => setImmediate(resolve));
      if (i % 8 === 7) await sleep(1);
    }
    // The clock here is virtual but hashing a file and renaming it into place are real, and
    // on a slow disk, or with antivirus holding a newly written file, they can outlast every
    // step above. Before giving up, keep going at roughly real-time pace for a while.
    const deadline = Date.now() + patienceMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      this.step();
      await sleep(STEP_MS);
    }
    const states = this.nodes.map((node) => node.api.list().map((entry) => `${entry.direction}:${entry.state}:${entry.chunksDone}/${entry.chunks}:${entry.error}`).join(','));
    const tail = this.log.slice(-6).map((entry) => `${entry.type}:${entry.kind ?? entry.index}`).join(' ');
    throw new Error(`gave up waiting for ${message} after ${maxSteps} steps; nodes: ${states.join(' | ')}; log tail: ${tail}; warnings: ${this.nodes.flatMap((node) => node.warnings).join(' / ')}`);
  }

  /** Let virtual time pass. */
  async run(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
      this.step();
      await new Promise((resolve) => setImmediate(resolve));
      if (elapsed % (STEP_MS * 8) === 0) await sleep(1);
    }
  }

  attach(id, member) {
    this.members.set(id, member);
    const waiting = this.held.filter((entry) => entry.to === id);
    this.held = this.held.filter((entry) => entry.to !== id);
    for (const entry of waiting) this.deliver(entry);
  }

  detach(id) {
    this.members.delete(id);
  }

  setRoutable(routable) {
    this.routable = routable;
    if (routable) for (const member of this.members.values()) for (const listener of member.routeListeners ?? []) listener({ reachable: [...this.members.keys()] });
  }

  setUp(up) {
    this.up = up;
    const waiting = this.held.filter((entry) => this.members.has(entry.to));
    if (up) {
      this.held = this.held.filter((entry) => !this.members.has(entry.to));
      for (const entry of waiting) this.deliver(entry);
      for (const member of this.members.values()) for (const listener of member.routeListeners ?? []) listener({ reachable: [...this.members.keys()] });
    }
  }

  sendMessage(from, to, message, reliable) {
    const entry = { from, to, message, reliable };
    this.log.push({ at: this.now, type: 'message', from, to, kind: message.kind, meta: message.meta, reliable });
    if (reliable) this.pendingIds.add(message.id);
    if (!this.up || !this.members.has(to)) {
      if (reliable) this.held.push(entry);
      return;
    }
    if (this.messageFilter?.({ from, to, kind: message.kind, meta: message.meta, reliable }) === true) {
      if (reliable) this.held.push(entry);
      return;
    }
    this.deliver(entry);
  }

  deliver(entry) {
    this.later(this.latencyMs, () => {
      const member = this.members.get(entry.to);
      if (member === undefined) {
        if (entry.reliable) this.held.push(entry);
        return;
      }
      this.pendingIds.delete(entry.message.id);
      member.receiveMessage(entry.message);
    });
  }

  sendChunk(from, to, body) {
    const { index } = peekChunk(body);
    const info = { from, to, index, bytes: body.length };
    if (!this.routable || !this.members.has(to)) return { ok: false, reason: 'no-route' };
    this.log.push({ at: this.now, type: 'chunk', ...info });
    if (!this.up) return { ok: true, nextHop: to };
    const verdict = this.chunkFilter?.(info) ?? {};
    if (verdict.drop === true) return { ok: true, nextHop: to };
    const copies = verdict.duplicate === true ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      this.chunksInFlight += 1;
      this.maxChunksInFlight = Math.max(this.maxChunksInFlight, this.chunksInFlight);
      this.later(this.latencyMs + (verdict.delayMs ?? 0) + copy, () => {
        this.chunksInFlight -= 1;
        this.members.get(to)?.receiveChunk({ type: PacketType.DATA, header: { id: hex(randomBytes(16)), dst: to, ttl: 1, try: 0 }, body }, { from });
      });
    }
    return { ok: true, nextHop: to };
  }

  /** The chunk indexes sent from `from` after `since` (a log position). */
  chunksSince(since, from) {
    return this.log.slice(since).filter((entry) => entry.type === 'chunk' && entry.from === from).map((entry) => entry.index);
  }

  messages(kind, { from, to } = {}) {
    return this.log.filter((entry) => entry.type === 'message' && entry.kind === kind && (from === undefined || entry.from === from) && (to === undefined || entry.to === to));
  }
}

/** A service endpoint with a fake context. */
async function addNode(t, net, { identity = Identity.generate(), dir, storageKey = randomBytes(32), files = {}, options = {}, limits = {}, timers = {}, holder: shared } = {}) {
  // Registered before the directory's own cleanup, so the service stops while its files still exist.
  const holder = shared ?? { node: null };
  if (shared === undefined) t.after(() => holder.node?.stop());
  const directory = dir ?? (await tempDir(t, 'files'));
  const downloads = files.downloadsDir ?? join(directory, 'downloads');
  await mkdir(join(directory, 'state'), { recursive: true });
  const nodeStorage = new NodeStorage({ dir: join(directory, 'state'), storageKey });
  const events = new EventBus({ capacity: 5000, now: () => net.now });
  const routes = new Map();
  const warnings = [];
  const handlers = new Map();
  const everyHandles = [];
  const id = identity.nodeId;
  const member = {
    routeListeners: [],
    receiveMessage: (message) => handlers.get(message.kind)?.(message),
    receiveChunk: (packet, info) => member.chunkHandler?.(packet, info),
    chunkHandler: null,
  };
  const config = {
    files: { downloadsDir: downloads, chunkSize: 1024, window: 16, accept: 'auto', maxSizeBytes: 100 * 1024 * 1024, ...files },
    timers: { retransmitMinMs: 200, retransmitMaxMs: 2000, ...timers },
    limits: { ttl: 16, messageLifetimeMs: 7 * 24 * 3_600_000, ...limits },
  };
  const service = createFileTransferService(options);
  const context = {
    service: 'files',
    nodeId: id,
    boot: 'b00700',
    config,
    events,
    log: { debug() {}, info() {}, warn: (message, fields) => warnings.push(`${message} ${JSON.stringify(fields)}`), error: (message, fields) => warnings.push(`${message} ${JSON.stringify(fields)}`) },
    now: () => net.now,
    storage: nodeStorage,
    node: { dataDir: directory },
    directory: { cardOf: (other) => (net.members.has(other) || other === id ? { id: other } : null) },
    messaging: {
      send: async (dst, { kind, meta = {}, content = Buffer.alloc(0), reliable = true }) => {
        if (!net.members.has(dst)) throw new StateError('unknown-destination: nobody there');
        const message = { id: hex(randomBytes(16)), from: id, kind, meta: { ...meta, kind }, content, ts: net.now };
        net.sendMessage(id, dst, message, reliable);
        return { id: message.id, state: 'sent' };
      },
      onKind: (kind, handler) => {
        handlers.set(kind, handler);
        return () => handlers.delete(kind);
      },
      get: (messageId) => (net.pendingIds.has(messageId) ? { id: messageId } : null),
    },
    packets: {
      originate: (packet) => net.sendChunk(id, packet.header.dst, packet.body),
      onLocal: (selector, handler) => {
        if (selector === 'data.transfer') member.chunkHandler = handler;
      },
    },
    routing: {
      onRoutesChanged: (listener) => {
        member.routeListeners.push(listener);
        return () => member.routeListeners.splice(member.routeListeners.indexOf(listener), 1);
      },
    },
    api: {
      route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      reply: (status, body) => ({ replied: true, status, body }),
      error: (status, code, message, details) => Object.assign(new ClawNetError('ERR_API', message), { status, apiCode: code, details: details ?? null }),
    },
    every: (fn, ms) => {
      const entry = { fn, ms, next: net.now + ms };
      net.everys.push(entry);
      everyHandles.push(entry);
      return () => net.everys.splice(net.everys.indexOf(entry), 1);
    },
    schedule: () => () => {},
  };
  await service.init(context);
  await service.start();
  net.attach(id, member);
  let stopped = false;
  const node = {
    id,
    identity,
    service,
    api: service.api,
    events,
    routes,
    dir: directory,
    downloads,
    storageKey,
    member,
    warnings,
    async stop() {
      if (stopped) return;
      stopped = true;
      net.detach(id);
      await service.stop();
      await nodeStorage.closeAll();
    },
    async restart(overrides = {}) {
      await node.stop();
      return addNode(t, net, { identity, dir: directory, storageKey, files, options, limits, timers, holder, ...overrides });
    },
    transfer: (tid) => service.api.get(tid),
    listDownloads: async () => (await readdir(downloads).catch(() => [])).sort(),
  };
  holder.node = node;
  net.nodes.push(node);
  return node;
}

/** A peer that is not a service: it sends and receives what the test tells it to. */
function addRaw(net, identity = Identity.generate()) {
  const id = identity.nodeId;
  const inbox = [];
  const raw = {
    id,
    inbox,
    member: {
      routeListeners: [],
      receiveMessage: (message) => inbox.push(message),
      receiveChunk: () => {},
    },
    send: (to, kind, meta, { reliable = true } = {}) => {
      const message = { id: hex(randomBytes(16)), from: id, kind, meta: { ...meta, kind }, content: Buffer.alloc(0), ts: net.now };
      net.sendMessage(id, to, message, reliable);
    },
    chunk: (to, body) => net.sendChunk(id, to, body),
    messages: (kind) => inbox.filter((message) => message.kind === kind),
  };
  net.attach(id, raw.member);
  return raw;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** An offer made by hand: `data` is what the chunks will carry. */
function offerFor(data, { name = 'file.bin', chunk = 1024, tid = hex(randomBytes(16)), key = randomBytes(32), sha, size } = {}) {
  return {
    tid,
    key,
    chunk,
    data,
    meta: { tid, name, size: size ?? data.length, sha256: b64(sha ?? sha256(data)), chunk, key: b64(key) },
  };
}

function sealAll(offer) {
  const out = [];
  for (let index = 0; index * offer.chunk < offer.data.length; index += 1) {
    out.push(sealChunk({ key: offer.key, transferId: Buffer.from(offer.tid, 'hex'), index, plaintext: offer.data.subarray(index * offer.chunk, (index + 1) * offer.chunk) }));
  }
  return out;
}

async function makeFile(dir, name, size) {
  const path = join(dir, name);
  const data = randomBytes(size);
  await writeFile(path, data);
  return { path, data };
}

async function pair(t, options = {}) {
  const net = new Net();
  const sender = await addNode(t, net, options.sender);
  const receiver = await addNode(t, net, options.receiver);
  return { net, sender, receiver };
}

async function sendAndWait(net, sender, receiver, path, options) {
  const transfer = await sender.api.send(receiver.id, path, options);
  await net.until(() => ['completed', 'failed', 'rejected', 'cancelled'].includes(sender.api.get(transfer.id).state), { message: 'the sender to finish' });
  return transfer.id;
}

// ---------------------------------------------------------------------------------------

test('sanitizeFileName: the names an attacker can offer all come out as plain names', () => {
  const cases = [
    ['plain.txt', 'plain.txt'],
    ['../../x', 'x'],
    ['..\\..\\x', 'x'],
    ['a/b/c.txt', 'c.txt'],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['/etc/passwd', 'passwd'],
    ['....', 'file'],
    ['.', 'file'],
    ['..', 'file'],
    ['   ', 'file'],
    ['', 'file'],
    ['name. . ', 'name'],
    ['.hidden', 'hidden'],
    ['CON.txt', '_CON.txt'],
    ['con', '_con'],
    ['Aux.tar.gz', '_Aux.tar.gz'],
    ['LPT9', '_LPT9'],
    ['COM1.log', '_COM1.log'],
    ['COM10.log', 'COM10.log'],
    ['console.txt', 'console.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'abcdefgh.txt'],
    ['tab\there\nnewline\u0000nul\u001f.txt', 'tabherenewlinenul.txt'],
    ['del\u007fx\u0085y.txt', 'delxy.txt'],
    ['evil\u202etxt.exe', 'eviltxt.exe'],
    ['stream.txt:hidden', 'stream.txthidden'],
    ['sp ace.txt', 'sp ace.txt'],
    ['caf\u00e9.txt', 'caf\u00e9.txt'],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeFileName(input), expected, JSON.stringify(input));
  for (const hostile of [undefined, null, 5, {}, []]) assert.equal(sanitizeFileName(hostile), 'file');
  assert.equal(sanitizeFileName('lone\ud800surrogate.txt').includes('\ud800'), false);

  const long = sanitizeFileName(`${'a'.repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith('.pdf'), 'the extension survives the cut');
  const wide = sanitizeFileName(`${'\u00e9'.repeat(150)}.txt`);
  assert.ok(Buffer.byteLength(wide) <= 200);
  assert.equal(wide.includes('\ufffd'), false, 'no character is split');
  assert.ok(wide.endsWith('.txt'));
  assert.ok(Buffer.byteLength(sanitizeFileName('x'.repeat(500))) <= 200);
  for (const out of [long, wide]) assert.equal(/[/\\]/.test(out), false);
});

test('files of every awkward size arrive byte for byte, under their final name only once verified', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const arrived = [];
  for (const size of [0, 1, 1023, 1024, 1025, 3 * 1024 + 7]) {
    const { path, data } = await makeFile(dir, `size-${size}.bin`, size);
    const tid = (await sender.api.send(receiver.id, path)).id;
    let sawPartOnly = false;
    await net.until(async () => {
      const names = await receiver.listDownloads();
      if (names.some((name) => name.endsWith('.part')) && !names.includes(`size-${size}.bin`)) sawPartOnly = true;
      return sender.api.get(tid).state === 'completed';
    }, { message: `${size} bytes` });
    await net.until(() => receiver.api.list().find((entry) => entry.id === tid)?.state === 'completed', { message: 'the receiver to finish' });
    arrived.push(`size-${size}.bin`);
    assert.deepEqual(await receiver.listDownloads(), [...arrived].sort(), `${size}: only finished files, no part file is left`);
    const received = await readFile(join(receiver.downloads, `size-${size}.bin`));
    assert.equal(hex(sha256(received)), hex(sha256(data)), `${size} bytes are identical`);
    const view = receiver.api.get(tid);
    assert.equal(view.state, 'completed');
    assert.equal(view.bytesDone, size);
    assert.equal(view.path, join(receiver.downloads, `size-${size}.bin`));
    assert.equal(view.direction, 'receive');
    assert.equal(sender.api.get(tid).bytesDone, size);
    if (size > 1024) assert.equal(sawPartOnly, true, `${size}: while it was incomplete only a .part existed`);
  }
  assert.equal(sender.service.stats().completedOut, 6);
  assert.equal(receiver.service.stats().completedIn, 6);
});

test('several megabytes of random data arrive with the same SHA-256, and the transfer reports itself honestly', async (t) => {
  const { net, sender, receiver } = await pair(t, { sender: { files: { chunkSize: 32768, window: 32 } }, receiver: { files: { chunkSize: 32768, window: 32 } } });
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'big.bin', 3 * 1024 * 1024 + 4321);
  const states = [];
  receiver.events.on('file.progress', (event) => states.push(event.data));
  const sent = await sender.api.send(receiver.id, path, { name: 'renamed.bin' });
  assert.equal(sent.state, 'preparing');
  assert.equal(sent.sha256, null);
  assert.equal(sent.chunks, Math.ceil(data.length / 32768));
  assert.equal(sent.name, 'renamed.bin');
  await net.until(() => receiver.api.list()[0]?.state === 'completed' && sender.api.get(sent.id).state === 'completed', { message: 'the transfer' });
  // The state changes before the event is emitted, so wait for the events the test reads below.
  const completed = (node) => node.events.recent({ types: ['file.completed'] }).length > 0;
  await net.until(() => completed(sender) && completed(receiver), { message: 'the completion events' });
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'renamed.bin')))), hex(sha256(data)));
  assert.equal(sender.api.get(sent.id).sha256, b64(sha256(data)));
  // The clock is virtual while the file I/O is real, so a busy machine can make a stall timer
  // fire early; a stall sends again what was in flight, which the window bounds.
  const extra = sender.service.stats().chunksSent - sent.chunks;
  assert.ok(extra >= 0 && extra <= 16, `a clean network needs next to no retransmissions (${extra})`);
  assert.equal(sender.service.stats().chunksResent, extra);
  assert.equal(receiver.service.stats().chunksReceived, sent.chunks);
  assert.equal(receiver.service.stats().bytesReceived, data.length);
  assert.ok(states.length > 0 && states.every((entry) => entry.direction === 'receive' && entry.bytesDone <= entry.size));
  const events = (node, type) => node.events.recent({ types: [type] }).map((event) => event.data);
  assert.equal(events(sender, 'file.offered').length, 1);
  assert.equal(events(sender, 'file.accepted').length, 1);
  assert.equal(events(sender, 'file.completed')[0].transfer.state, 'completed');
  assert.equal(events(receiver, 'file.incoming').length, 1);
  assert.equal(events(receiver, 'file.completed')[0].transfer.path, join(receiver.downloads, 'renamed.bin'));
});

test('flow control is receiver-driven: no more than the initial credit goes out before the first acknowledgement', async (t) => {
  const { net, sender, receiver } = await pair(t, { sender: { files: { window: 32 } }, receiver: { files: { window: 32 } } });
  const dir = await tempDir(t, 'src');
  const { path } = await makeFile(dir, 'f.bin', 200 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => sender.api.get(sent.id).state === 'completed', { message: 'completion' });
  const firstAck = net.log.findIndex((entry) => entry.type === 'message' && entry.kind === 'file-sack');
  const beforeAck = net.log.slice(0, firstAck).filter((entry) => entry.type === 'chunk').length;
  assert.ok(beforeAck >= 1 && beforeAck <= INITIAL_WINDOW, `${beforeAck} chunks before the first sack`);
  // The credit grows with acknowledgements, and a window of 32 is honoured and eventually used.
  assert.ok(net.maxChunksInFlight >= 2, `chunks were pipelined (peak ${net.maxChunksInFlight})`);
  assert.ok(net.maxChunksInFlight <= 32, `never more than files.window in the network (peak ${net.maxChunksInFlight})`);
  const wins = net.messages('file-sack').map((entry) => entry.meta.win);
  assert.ok(wins.every((win) => Number.isInteger(win) && win >= 1 && win <= 32));
  assert.ok(Math.max(...wins) > INITIAL_WINDOW);
});

test('20 percent loss of chunks, reordering, duplication and lost acknowledgements still complete, with retransmissions counted', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'lossy.bin', 120 * 1024 + 11);
  let dice = 12345;
  const roll = () => {
    dice = (dice * 1103515245 + 12345) & 0x7fffffff;
    return dice / 0x7fffffff;
  };
  net.chunkFilter = () => ({ drop: roll() < 0.2, duplicate: roll() < 0.1, delayMs: roll() < 0.2 ? Math.floor(roll() * 40) : 0 });
  net.messageFilter = ({ kind, reliable }) => !reliable && kind === 'file-sack' && roll() < 0.3;
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => sender.api.get(sent.id).state === 'completed' && receiver.api.get(sent.id)?.state === 'completed', { message: 'completion under loss', maxSteps: 60000 });
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'lossy.bin')))), hex(sha256(data)));
  assert.ok(sender.service.stats().chunksResent > 0, 'lost chunks were sent again');
  assert.ok(receiver.service.stats().chunksDuplicate > 0, 'duplicates were noticed');
  assert.ok(sender.service.stats().chunksSent < sent.chunks * 3, 'and not absurdly often');
  assert.deepEqual(await receiver.listDownloads(), ['lossy.bin']);
});

test('resume: a receiver that is stopped mid-transfer and started again on the same storage finishes without taking chunks it already holds', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'resume.bin', 400 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 120, { message: 'a good part of the file' });
  await receiver.stop();
  const mark = net.log.length;
  const again = await receiver.restart();
  await net.until(() => again.api.get(sent.id)?.state === 'completed' && sender.api.get(sent.id).state === 'completed', { message: 'completion after the restart' });
  assert.equal(hex(sha256(await readFile(join(again.downloads, 'resume.bin')))), hex(sha256(data)));
  const accept = net.log.slice(mark).find((entry) => entry.type === 'message' && entry.kind === 'file-accept');
  assert.ok(accept, 'the restarted receiver told the sender what it holds');
  assert.ok(accept.meta.base >= 100, `it kept its progress (base ${accept.meta.base})`);
  const held = new Set();
  for (let i = 0; i < accept.meta.base; i += 1) held.add(i);
  for (const [from, to] of accept.meta.ranges) for (let i = from; i <= to; i += 1) held.add(i);
  const acceptAt = net.log.indexOf(accept);
  const resent = net.chunksSince(acceptAt, sender.id).filter((index) => held.has(index));
  assert.deepEqual(resent, [], 'no chunk the receiver holds was sent again');
  assert.deepEqual(await again.listDownloads(), ['resume.bin']);
});

test('resume: a sender that is stopped and started again re-offers, learns what the receiver holds, and does not resend it', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'sender-restart.bin', 400 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 100, { message: 'part of the file' });
  await sender.stop();
  await net.run(100);
  const mark = net.log.length;
  const again = await sender.restart();
  assert.ok(['offered', 'paused', 'sending'].includes(again.api.get(sent.id).state));
  await net.until(() => again.api.get(sent.id).state === 'completed' && receiver.api.get(sent.id).state === 'completed', { message: 'completion after the sender restarted' });
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'sender-restart.bin')))), hex(sha256(data)));
  const offers = net.messages('file-offer', { from: sender.id }).filter((entry) => net.log.indexOf(entry) >= mark);
  assert.ok(offers.length >= 1, 'the offer was made again');
  assert.equal(offers[0].meta.tid, sent.id, 'under the same transfer id');
  const accept = net.log.slice(mark).find((entry) => entry.type === 'message' && entry.kind === 'file-accept');
  assert.ok(accept.meta.base >= 90, `the receiver reported its progress (base ${accept.meta.base})`);
  const resent = net.chunksSince(net.log.indexOf(accept), sender.id).filter((index) => index < accept.meta.base);
  assert.deepEqual(resent, [], 'nothing below the receiver base was sent again');
});

test('when every message is lost for a while both sides pause, and the transfer resumes and completes when the network returns', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'outage.bin', 200 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 20, { message: 'some progress' });
  net.setUp(false);
  await net.until(() => sender.api.get(sent.id).state === 'paused' && receiver.api.get(sent.id).state === 'paused', { message: 'both sides to pause', maxSteps: 4000 });
  assert.deepEqual(sender.events.recent({ types: ['file.paused'] }).map((event) => event.data), [{ id: sent.id, reason: 'stalled' }]);
  const before = receiver.api.get(sent.id).chunksDone;
  await net.run(3000);
  net.setUp(true);
  await net.until(() => sender.api.get(sent.id).state === 'completed' && receiver.api.get(sent.id).state === 'completed', { message: 'completion after the outage' });
  assert.ok(receiver.api.get(sent.id).chunksDone > before);
  assert.equal(sender.events.recent({ types: ['file.resumed'] }).length >= 1, true);
  assert.equal(receiver.events.recent({ types: ['file.resumed'] }).length >= 1, true);
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'outage.bin')))), hex(sha256(data)));
});

test('a part file that was deleted while the receiver was down is started again from zero, and the transfer still completes', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'lost-part.bin', 150 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 40, { message: 'some progress' });
  await receiver.stop();
  const names = await readdir(receiver.downloads);
  assert.equal(names.length, 1);
  await rm(join(receiver.downloads, names[0]));
  const mark = net.log.length;
  const again = await receiver.restart();
  await net.until(() => again.api.get(sent.id)?.state === 'completed' && sender.api.get(sent.id).state === 'completed', { message: 'completion from zero' });
  const accept = net.log.slice(mark).find((entry) => entry.type === 'message' && entry.kind === 'file-accept');
  assert.equal(accept.meta.base, 0, 'the receiver admitted that it holds nothing');
  assert.deepEqual(accept.meta.ranges, []);
  assert.equal(hex(sha256(await readFile(join(again.downloads, 'lost-part.bin')))), hex(sha256(data)));
});

test('a transfer that makes no progress for the message lifetime fails with expired, on both sides, and leaves nothing behind', async (t) => {
  const net = new Net();
  const sender = await addNode(t, net, { limits: { messageLifetimeMs: 5000 } });
  const receiver = await addNode(t, net, { limits: { messageLifetimeMs: 5000 } });
  const dir = await tempDir(t, 'src');
  const { path } = await makeFile(dir, 'expire.bin', 100 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 5, { message: 'a start' });
  net.setUp(false);
  await net.until(() => sender.api.get(sent.id).state === 'failed' && receiver.api.get(sent.id).state === 'failed', { message: 'both sides to expire', maxSteps: 3000 });
  assert.equal(sender.api.get(sent.id).error, 'expired');
  assert.equal(receiver.api.get(sent.id).error, 'expired');
  await net.until(async () => (await receiver.listDownloads()).length === 0, { message: 'the part file to go' });
});

test('with no route the sender waits instead of failing, and sends again when a route appears', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'noroute.bin', 120 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 10, { message: 'a start' });
  net.setRoutable(false);
  const stuck = sender.service.stats().chunksSent;
  await net.run(1500);
  assert.equal(sender.api.get(sent.id).state, 'sending', 'no route is not a failure');
  assert.ok(sender.service.stats().chunksSent <= stuck + 16, 'and nothing is sent without a route');
  net.setRoutable(true);
  await net.until(() => sender.api.get(sent.id).state === 'completed' && receiver.api.get(sent.id).state === 'completed', { message: 'completion once routed' });
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'noroute.bin')))), hex(sha256(data)));
});

test('a whole-file hash that does not match ends in failed, deletes the part file and creates no file', async (t) => {
  const net = new Net();
  const receiver = await addNode(t, net);
  const raw = addRaw(net);
  const data = randomBytes(5000);
  const offer = offerFor(data, { name: 'lie.bin', sha: sha256(Buffer.from('something else')) });
  raw.send(receiver.id, 'file-offer', offer.meta);
  await net.until(() => raw.messages('file-accept').length === 1, { message: 'the accept' });
  for (const body of sealAll(offer)) raw.chunk(receiver.id, body);
  await net.until(() => raw.messages('file-done').length === 1, { message: 'the verdict' });
  assert.deepEqual({ ok: raw.messages('file-done')[0].meta.ok, reason: raw.messages('file-done')[0].meta.reason }, { ok: false, reason: 'hash' });
  const view = receiver.api.get(offer.tid);
  assert.equal(view.state, 'failed');
  assert.equal(view.error, 'hash');
  assert.equal(view.path, null);
  assert.deepEqual(await receiver.listDownloads(), []);
  assert.equal(receiver.service.stats().failed, 1);
  assert.equal(receiver.events.recent({ types: ['file.failed'] }).length, 1);
});

test('the acceptance policy: ask waits, auto accepts, deny refuses; reject and accept by hand', async (t) => {
  const net = new Net();
  const asker = await addNode(t, net, { files: { accept: 'ask' } });
  const denier = await addNode(t, net, { files: { accept: 'deny' } });
  const raw = addRaw(net);
  const first = offerFor(randomBytes(3000), { name: 'ask.bin' });
  const second = offerFor(randomBytes(10), { name: 'ask-no.bin' });
  raw.send(asker.id, 'file-offer', first.meta);
  raw.send(asker.id, 'file-offer', second.meta);
  raw.send(denier.id, 'file-offer', offerFor(randomBytes(10)).meta);
  await net.until(() => raw.messages('file-reject').length === 1, { message: 'the denial' });
  assert.equal(raw.messages('file-reject')[0].meta.reason, 'denied');
  assert.equal(denier.api.list().length, 0, 'a denied offer leaves no transfer behind');
  assert.equal(asker.api.get(first.tid).state, 'offered');
  assert.equal(asker.events.recent({ types: ['file.incoming'] }).length, 2);
  assert.equal(raw.messages('file-accept').length, 0, 'nothing is sent until someone decides');
  assert.deepEqual(await asker.listDownloads(), []);

  await assert.rejects(() => asker.api.reject('0'.repeat(32)), /^StateError: not-found:/);
  const rejected = await asker.api.reject(second.tid);
  assert.equal(rejected.state, 'rejected');
  await net.until(() => raw.messages('file-reject').length === 2, { message: 'the rejection' });
  assert.equal(raw.messages('file-reject')[1].meta.tid, second.tid);
  await assert.rejects(() => asker.api.accept(second.tid), /^StateError: invalid-state:/);
  await assert.rejects(() => asker.api.reject(second.tid), /^StateError: invalid-state:/);

  const accepted = await asker.api.accept(first.tid);
  assert.equal(accepted.state, 'receiving');
  await net.until(() => raw.messages('file-accept').length === 1, { message: 'the accept' });
  for (const body of sealAll(first)) raw.chunk(asker.id, body);
  await net.until(() => asker.api.get(first.tid).state === 'completed', { message: 'completion' });
  assert.deepEqual(await asker.listDownloads(), ['ask.bin']);
});

test('an offer nobody answers is declined after the offer time-out, which frees its slot for the next sender', async (t) => {
  const net = new Net();
  const asker = await addNode(t, net, { files: { accept: 'ask' }, options: { maxPendingPerPeer: 1, offerTtlMs: 2000 } });
  const raw = addRaw(net);
  const stale = offerFor(randomBytes(100), { name: 'stale.bin' });
  const next = offerFor(randomBytes(100), { name: 'next.bin' });
  raw.send(asker.id, 'file-offer', stale.meta);
  await net.until(() => asker.api.get(stale.tid)?.state === 'offered', { message: 'the offer' });
  // The slot is taken: another offer from the same peer is refused as busy.
  raw.send(asker.id, 'file-offer', next.meta);
  await net.until(() => raw.messages('file-reject').length === 1, { message: 'busy' });
  assert.equal(raw.messages('file-reject')[0].meta.reason, 'busy');
  await net.run(2500);
  await net.until(() => asker.api.get(stale.tid).state === 'rejected', { message: 'the time-out' });
  await net.until(() => raw.messages('file-reject').length === 2, { message: 'the decline' });
  assert.deepEqual(raw.messages('file-reject')[1].meta, { tid: stale.tid, reason: 'denied', kind: 'file-reject' });
  raw.send(asker.id, 'file-offer', next.meta);
  await net.until(() => asker.api.get(next.tid)?.state === 'offered', { message: 'the next offer is held' });
  assert.equal(raw.messages('file-reject').length, 2);
  assert.throws(() => createFileTransferService({ offerTtlMs: 0 }), ConfigError);
});

test('cancel from either side stops the transfer and removes the part file', async (t) => {
  for (const canceller of ['sender', 'receiver']) {
    const { net, sender, receiver } = await pair(t);
    const dir = await tempDir(t, 'src');
    const { path } = await makeFile(dir, 'cancel.bin', 300 * 1024);
    const sent = await sender.api.send(receiver.id, path);
    await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 10, { message: 'some chunks' });
    assert.ok((await receiver.listDownloads()).some((name) => name.endsWith('.part')));
    const [first, second] = canceller === 'sender' ? [sender, receiver] : [receiver, sender];
    const result = await first.api.cancel(sent.id);
    assert.equal(result.state, 'cancelled');
    await net.until(() => second.api.get(sent.id).state === 'cancelled', { message: 'the other side to learn' });
    await net.until(async () => (await receiver.listDownloads()).length === 0, { message: `${canceller} cancelled: the part file to go` });
    await assert.rejects(() => first.api.cancel(sent.id), /^StateError: invalid-state:/);
    const received = net.log.length;
    await net.run(500);
    assert.deepEqual(net.chunksSince(received, sender.id), [], 'no chunk is sent after a cancel');
  }
});

test('hostile offers: too large, absurd chunk counts, bad keys and hashes, floods, and every kind of name', async (t) => {
  const net = new Net();
  const receiver = await addNode(t, net, { files: { accept: 'ask', maxSizeBytes: 10 * 1024 * 1024 }, options: { maxPendingPerPeer: 8, maxPendingOffers: 20 } });
  const raw = addRaw(net);
  const replies = () => raw.messages('file-reject').map((message) => message.meta.reason);

  raw.send(receiver.id, 'file-offer', offerFor(Buffer.alloc(0), { size: 10 * 1024 * 1024 + 1 }).meta);
  raw.send(receiver.id, 'file-offer', offerFor(Buffer.alloc(0), { size: 2 ** 40, chunk: 1 }).meta);
  raw.send(receiver.id, 'file-offer', offerFor(Buffer.alloc(0), { size: 9 * 1024 * 1024, chunk: 1 }).meta);
  raw.send(receiver.id, 'file-offer', offerFor(Buffer.alloc(0), { size: 100, chunk: 1032192 }).meta);
  raw.send(receiver.id, 'file-offer', offerFor(Buffer.alloc(0), { size: 100, chunk: 1032193 }).meta);
  await net.until(() => replies().length >= 5, { message: 'replies to hostile sizes' });
  assert.equal(replies().length, 5, 'one reply per refused offer');
  assert.equal(replies().filter((reason) => reason === 'too-large').length, 3, 'size over the limit, and two absurd chunk counts');
  assert.equal(replies().filter((reason) => reason === 'invalid').length, 2, 'a chunk size no packet can carry, and one above the protocol limit');
  assert.equal(receiver.api.list().length, 0, 'none of them became a transfer');

  // Malformed fields: invalid, or silence when not even the id is usable.
  const good = offerFor(randomBytes(10));
  const before = raw.inbox.length;
  for (const mutate of [
    (meta) => { meta.key = b64(randomBytes(31)); },
    (meta) => { meta.key = 'not base64!'; },
    (meta) => { meta.sha256 = b64(randomBytes(33)); },
    (meta) => { meta.size = -1; },
    (meta) => { meta.size = 1.5; },
    (meta) => { meta.size = '10'; },
    (meta) => { meta.chunk = 0; },
    (meta) => { meta.name = ''; },
    (meta) => { meta.name = 'x'.repeat(256); },
    (meta) => { meta.name = 'lone\ud800'; },
    (meta) => { meta.name = 7; },
    (meta) => { delete meta.key; },
    (meta) => { meta.tid = 'ABC'; },
    (meta) => { delete meta.tid; },
  ]) {
    const meta = { ...good.meta, tid: hex(randomBytes(16)) };
    mutate(meta);
    raw.send(receiver.id, 'file-offer', meta);
  }
  await net.run(200);
  assert.equal(receiver.api.list().length, 0);
  const invalidReplies = raw.inbox.slice(before).filter((message) => message.kind === 'file-reject');
  assert.ok(invalidReplies.every((message) => message.meta.reason === 'invalid'));
  assert.ok(invalidReplies.length >= 10 && invalidReplies.length <= 12, `answered the ones with a usable id (${invalidReplies.length})`);

  // A hundred offers from one peer: eight wait, the rest are refused, and only some of them answered.
  const flooder = addRaw(net);
  for (let i = 0; i < 100; i += 1) flooder.send(receiver.id, 'file-offer', offerFor(randomBytes(10)).meta);
  await net.run(400);
  assert.equal(receiver.api.list().length, 8, 'eight pending offers per peer');
  const busy = flooder.messages('file-reject').filter((message) => message.meta.reason === 'busy');
  assert.equal(busy.length, 20, 'twenty busy answers a minute, not one for each of the hundred');

  // Another peer is not affected by it, up to the overall limit of 20.
  for (const expected of [16, 20, 20]) {
    const other = addRaw(net);
    for (let i = 0; i < 8; i += 1) other.send(receiver.id, 'file-offer', offerFor(randomBytes(10)).meta);
    await net.run(300);
    assert.equal(receiver.api.list().length, expected, 'eight more from a fresh peer, until the overall limit of pending offers');
  }
});

test('hostile names never leave the downloads directory, and every file lands inside it', async (t) => {
  const net = new Net();
  const receiver = await addNode(t, net, { files: { accept: 'auto' } });
  const raw = addRaw(net);
  const names = ['../../x', '..\\..\\x', '/etc/passwd', 'C:\\Windows\\win.ini', 'CON.txt', '....', 'a'.repeat(300), 'nul\u0000byte.txt', 'tab\tname.txt', '..'];
  const outside = async () => (await readdir(receiver.dir)).filter((name) => name !== 'downloads').sort();
  const outsideBefore = await outside();
  const done = [];
  for (const name of names) {
    const data = randomBytes(2500);
    const offer = offerFor(data, { name: name.slice(0, 255) });
    raw.send(receiver.id, 'file-offer', offer.meta);
    await net.until(() => raw.messages('file-accept').some((message) => message.meta.tid === offer.tid), { message: `the accept of ${JSON.stringify(name).slice(0, 30)}` });
    for (const body of sealAll(offer)) raw.chunk(receiver.id, body);
    await net.until(() => receiver.api.get(offer.tid)?.state === 'completed', { message: 'completion' });
    done.push({ offer, data });
  }
  assert.deepEqual(await outside(), outsideBefore, 'nothing was written next to the downloads directory');
  const inside = await receiver.listDownloads();
  assert.equal(inside.length, names.length);
  for (const { offer, data } of done) {
    const view = receiver.api.get(offer.tid);
    assert.ok(!relative(receiver.downloads, view.path).startsWith('..'), `${view.path} is inside the downloads directory`);
    assert.equal(hex(sha256(await readFile(view.path))), hex(sha256(data)));
  }
  assert.ok(inside.includes('x'), '../../x became x');
  assert.ok(inside.includes('_CON.txt'));
  assert.ok(inside.every((name) => [...name].every((character) => character.codePointAt(0) > 0x1f && !'/\\:*?"<>|'.includes(character))));
  assert.ok(inside.every((name) => Buffer.byteLength(name) <= 200));
  assert.equal(inside.filter((name) => name === 'x' || /^x \(\d+\)$/.test(name)).length, 2, 'two offers named x did not overwrite each other');
});

test('two files with the same name do not overwrite each other', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const first = await makeFile(dir, 'same.txt', 5000);
  await mkdir(join(dir, 'other'));
  const second = await makeFile(join(dir, 'other'), 'same.txt', 6000);
  const third = await makeFile(join(dir, 'other'), 'same.tar.gz', 1000);
  const fourth = await makeFile(dir, 'same.tar.gz', 1100);
  const ids = [];
  for (const file of [first, second, third, fourth]) ids.push((await sender.api.send(receiver.id, file.path)).id);
  await net.until(() => ids.every((id) => receiver.api.get(id)?.state === 'completed'), { message: 'all four' });
  assert.deepEqual(await receiver.listDownloads(), ['same (1).txt', 'same.tar (1).gz', 'same.tar.gz', 'same.txt']);
  const byName = async (name) => hex(sha256(await readFile(join(receiver.downloads, name))));
  const contents = new Set([await byName('same.txt'), await byName('same (1).txt')]);
  assert.deepEqual(contents, new Set([hex(sha256(first.data)), hex(sha256(second.data))]));
  const archives = new Set([await byName('same.tar.gz'), await byName('same.tar (1).gz')]);
  assert.deepEqual(archives, new Set([hex(sha256(third.data)), hex(sha256(fourth.data))]));
});

test('hostile chunks: wrong key, altered header, out of range, wrong length, unknown transfer, or not accepted yet', async (t) => {
  const net = new Net();
  const receiver = await addNode(t, net, { files: { accept: 'ask' } });
  const raw = addRaw(net);
  const data = randomBytes(4096);
  const offer = offerFor(data, { name: 'target.bin' });
  raw.send(receiver.id, 'file-offer', offer.meta);
  await net.run(100);
  const bodies = sealAll(offer);
  raw.chunk(receiver.id, bodies[0]);
  await net.run(100);
  assert.equal(receiver.service.stats().chunksReceived, 0, 'chunks of an offer nobody accepted are dropped');
  await receiver.api.accept(offer.tid);
  await net.until(() => raw.messages('file-accept').length === 1, { message: 'accept' });

  const tid = Buffer.from(offer.tid, 'hex');
  const hostile = [];
  hostile.push(sealChunk({ key: randomBytes(32), transferId: tid, index: 1, plaintext: data.subarray(1024, 2048) })); // wrong key
  const altered = Buffer.from(bodies[1]);
  altered[17 + 3] ^= 1; // the index in the header
  hostile.push(altered);
  const otherTid = Buffer.from(bodies[1]);
  otherTid[5] ^= 1; // the transfer id
  hostile.push(otherTid);
  const tampered = Buffer.from(bodies[1]);
  tampered[tampered.length - 1] ^= 1; // the tag
  hostile.push(tampered);
  hostile.push(sealChunk({ key: offer.key, transferId: tid, index: 99, plaintext: data.subarray(0, 1024) })); // out of range
  hostile.push(sealChunk({ key: offer.key, transferId: tid, index: 1, plaintext: data.subarray(0, 100) })); // wrong length
  hostile.push(sealChunk({ key: offer.key, transferId: tid, index: 3, plaintext: data.subarray(0, 1024 + 1) })); // too long
  hostile.push(sealChunk({ key: offer.key, transferId: Buffer.from(hex(randomBytes(16)), 'hex'), index: 0, plaintext: data.subarray(0, 1024) })); // unknown transfer
  hostile.push(Buffer.from([2, 1, 2, 3])); // not even a chunk
  hostile.push(Buffer.alloc(40)); // wrong scheme
  const before = receiver.service.stats().chunksReceived;
  for (const body of hostile) {
    try {
      raw.chunk(receiver.id, body);
    } catch {
      // peekChunk in the fake network refuses garbage before it is "sent"; the service sees only what arrives.
      receiver.member.receiveChunk({ type: PacketType.DATA, header: {}, body }, { from: raw.id });
    }
  }
  await net.run(200);
  assert.equal(receiver.service.stats().chunksReceived, before, 'no hostile chunk was taken');
  assert.equal(receiver.service.stats().chunksRejected, hostile.length + 1);
  assert.equal(receiver.api.get(offer.tid).chunksDone, 0);
  // The genuine ones still work afterwards.
  for (const body of bodies) raw.chunk(receiver.id, body);
  await net.until(() => receiver.api.get(offer.tid).state === 'completed', { message: 'the genuine chunks' });
  assert.equal(hex(sha256(await readFile(join(receiver.downloads, 'target.bin')))), hex(sha256(data)));
});

test('control messages are honoured only from the transfer peer, and unknown transfers are ignored', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const stranger = addRaw(net);
  const dir = await tempDir(t, 'src');
  const { path } = await makeFile(dir, 'x.bin', 200 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 10, { message: 'progress' });
  const forged = [
    ['file-cancel', { reason: 'user' }],
    ['file-done', { ok: true }],
    ['file-reject', { reason: 'denied' }],
    ['file-accept', { base: 5, ranges: [], win: 100 }],
    ['file-sack', { base: 200, ranges: [] }],
  ];
  for (const target of [sender, receiver]) {
    for (const [kind, meta] of forged) stranger.send(target.id, kind, { tid: sent.id, ...meta });
  }
  for (const [kind, meta] of forged) stranger.send(sender.id, kind, { tid: hex(randomBytes(16)), ...meta });
  await net.run(100);
  assert.equal(sender.api.get(sent.id).state === 'sending' || sender.api.get(sent.id).state === 'completed', true);
  assert.notEqual(receiver.api.get(sent.id).state, 'cancelled');
  await net.until(() => sender.api.get(sent.id).state === 'completed', { message: 'completion despite the noise' });
  assert.equal(receiver.api.get(sent.id).state, 'completed');
  // The right peer's malformed progress is ignored too.
  const second = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(second.id)?.chunksDone ?? 0) >= 1, { message: 'a start' });
  for (const meta of [
    { base: -1, ranges: [] },
    { base: 99999, ranges: [] },
    { base: 0, ranges: [[5, 3]] },
    { base: 0, ranges: [[0, 3]] },
    { base: 0, ranges: [[1, 3], [2, 5]] },
    { base: 0, ranges: [[1, 99999]] },
    { base: 0, ranges: new Array(SACK_MAX_RANGES + 1).fill([1, 1]) },
    { base: 0, ranges: [], win: 0 },
    { base: 0, ranges: [], win: 5000 },
    { base: 0, ranges: 'x' },
  ]) {
    sender.member.receiveMessage({ id: hex(randomBytes(16)), from: receiver.id, kind: 'file-sack', meta: { tid: second.id, ...meta, kind: 'file-sack' }, content: Buffer.alloc(0) });
  }
  await net.until(() => sender.api.get(second.id).state === 'completed', { message: 'completion after malformed sacks' });
});

test('a source file that changes during the transfer fails it with source-changed, and the receiver keeps nothing', async (t) => {
  const { net, sender, receiver } = await pair(t, { sender: { files: { window: 4 } }, receiver: { files: { window: 4 } } });
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 'changing.bin', 200 * 1024);
  const sent = await sender.api.send(receiver.id, path);
  await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 8, { message: 'a few chunks' });
  const changed = Buffer.from(data);
  changed[150 * 1024] ^= 0xff; // a byte of a chunk that has not been sent yet
  await writeFile(path, changed);
  await net.until(() => sender.api.get(sent.id).state === 'failed', { message: 'the sender to notice' });
  assert.equal(sender.api.get(sent.id).error, 'source-changed');
  await net.until(() => receiver.api.get(sent.id).state === 'failed', { message: 'the receiver to be told' });
  assert.equal(receiver.api.get(sent.id).error, 'source-changed');
  await net.until(async () => (await receiver.listDownloads()).length === 0, { message: 'the part file to go' });
  const after = net.log.length;
  await net.run(500);
  assert.deepEqual(net.chunksSince(after, sender.id), [], 'sending stopped');
  assert.equal(sender.events.recent({ types: ['file.failed'] }).length, 1);
});

test('a source that grows or shrinks is also a changed source', async (t) => {
  for (const change of ['grow', 'shrink']) {
    const { net, sender, receiver } = await pair(t, { sender: { files: { window: 2 } }, receiver: { files: { window: 2 } } });
    const dir = await tempDir(t, 'src');
    const { path, data } = await makeFile(dir, 'c.bin', 100 * 1024);
    const sent = await sender.api.send(receiver.id, path);
    await net.until(() => (receiver.api.get(sent.id)?.chunksDone ?? 0) >= 3, { message: 'a start' });
    if (change === 'grow') await writeFile(path, Buffer.concat([data, Buffer.from('more')]));
    else await writeFile(path, data.subarray(0, 90 * 1024));
    await net.until(() => sender.api.get(sent.id).state === 'failed', { message: `the sender to notice (${change})` });
    assert.equal(sender.api.get(sent.id).error, 'source-changed', change);
    await net.until(async () => (await receiver.listDownloads()).length === 0, { message: `the part file to go (${change})` });
  }
});

test('send() validates its input and offers nothing for an unusable file', async (t) => {
  const { net, sender, receiver } = await pair(t, { sender: { files: { maxSizeBytes: 5000 } } });
  const dir = await tempDir(t, 'src');
  const ok = await makeFile(dir, 'ok.bin', 100);
  const big = await makeFile(dir, 'big.bin', 6000);
  const reason = async (work) => work().then(() => null, (error) => ({ name: error.constructor.name, message: error.message.split(':')[0], reason: error.reason }));
  assert.deepEqual(await reason(() => sender.api.send(receiver.id, join(dir, 'missing'))), { name: 'StateError', message: 'invalid-file', reason: 'not-found' });
  assert.deepEqual(await reason(() => sender.api.send(receiver.id, dir)), { name: 'StateError', message: 'invalid-file', reason: 'not-a-file' });
  assert.deepEqual(await reason(() => sender.api.send(receiver.id, big.path)), { name: 'StateError', message: 'invalid-file', reason: 'too-large' });
  assert.equal((await reason(() => sender.api.send(Identity.generate().nodeId, ok.path)))?.message, 'unknown-destination');
  for (const [to, path, options] of [
    ['short', ok.path, {}],
    [sender.id, ok.path, {}],
    [receiver.id, '', {}],
    [receiver.id, 5, {}],
    [receiver.id, `${ok.path}\0x`, {}],
    [receiver.id, ok.path, { name: '' }],
    [receiver.id, ok.path, { name: 'x'.repeat(256) }],
  ]) {
    assert.equal((await reason(() => sender.api.send(to, path, options))).name, 'ConfigError', JSON.stringify([to, path, options]).slice(0, 60));
  }
  assert.equal(sender.api.list().length, 0, 'nothing was created');
  await net.run(100);
  assert.equal(net.messages('file-offer').length, 0);
  for (const options of [{ maxActive: 0 }, { maxPendingOffers: -1 }, { maxPendingPerPeer: 1.5 }, { keep: 0 }]) {
    assert.throws(() => createFileTransferService(options), ConfigError);
  }
});

test('maxActive: accepted transfers beyond it wait in paused and start when a slot frees; finished transfers are bounded by keep', async (t) => {
  const net = new Net();
  const sender = await addNode(t, net);
  // Offers wait for a decision, so that all four exist before any of them is accepted.
  const receiver = await addNode(t, net, { files: { accept: 'ask' }, options: { maxActive: 1, keep: 2 } });
  const dir = await tempDir(t, 'src');
  const files = [];
  for (let i = 0; i < 4; i += 1) files.push(await makeFile(dir, `queue-${i}.bin`, 100 * 1024));
  const ids = [];
  for (const file of files) ids.push((await sender.api.send(receiver.id, file.path)).id);
  await net.until(() => receiver.api.list().length === 4, { message: 'all offers' });
  for (const id of ids) await receiver.api.accept(id);
  const running = () => receiver.api.list().filter((entry) => entry.state === 'receiving').length;
  const waiting = () => receiver.api.list().filter((entry) => entry.state === 'paused').length;
  await net.until(() => running() === 1 && waiting() === 3, { message: 'one transfer running and three waiting' });
  assert.ok(receiver.events.recent({ types: ['file.paused'] }).every((event) => event.data.reason === 'waiting-for-slot'));
  await net.until(() => receiver.api.list().filter((entry) => entry.state === 'completed').length >= 2, { message: 'the queue to move' });
  await net.until(() => ids.every((id) => sender.api.get(id)?.state === 'completed' || sender.api.get(id) === null), { message: 'all to finish', maxSteps: 40000 });
  await net.until(() => receiver.api.list().filter((entry) => entry.state === 'completed').length === 2, { message: 'retention' });
  assert.equal(receiver.api.list().length, 2, 'only the newest `keep` finished transfers stay listed');
  assert.equal((await receiver.listDownloads()).length, 4, 'but every file arrived');
});

test('the API routes validate input and map errors as API.md asks', async (t) => {
  const { net, sender, receiver } = await pair(t, { receiver: { files: { accept: 'ask' } } });
  const dir = await tempDir(t, 'src');
  const { path } = await makeFile(dir, 'api.bin', 3000);
  const call = (node, method, route, { params = {}, body = null } = {}) => node.routes.get(`${method} ${route}`)({ params, query: {}, body, signal: null });
  const fails = (work) => work().then(() => assert.fail('expected an error'), (error) => error);
  assert.deepEqual([...sender.routes.keys()].sort(), [
    'GET /files',
    'GET /files/:id',
    'POST /files',
    'POST /files/:id/accept',
    'POST /files/:id/cancel',
    'POST /files/:id/reject',
  ]);
  for (const body of [null, [], {}, { to: 'x', path }, { to: receiver.id }, { to: receiver.id, path: '' }, { to: receiver.id, path, extra: 1 }, { to: receiver.id, path, name: '' }]) {
    const error = await fails(() => call(sender, 'POST', '/files', { body }));
    assert.equal(error.status, 400, JSON.stringify(body));
    assert.equal(error.apiCode, 'invalid_request');
  }
  for (const [file, expected] of [[join(dir, 'nope'), 'not-found'], [dir, 'not-a-file']]) {
    const error = await fails(() => call(sender, 'POST', '/files', { body: { to: receiver.id, path: file } }));
    assert.equal(error.status, 400);
    assert.equal(error.apiCode, 'invalid_file');
    assert.deepEqual(error.details, { reason: expected });
  }
  const reply = await call(sender, 'POST', '/files', { body: { to: receiver.id, path, name: 'shown.bin' } });
  assert.equal(reply.status, 202);
  assert.equal(reply.body.transfer.state, 'preparing');
  assert.equal(reply.body.transfer.name, 'shown.bin');
  const tid = reply.body.transfer.id;
  const listed = await call(sender, 'GET', '/files');
  assert.deepEqual(listed.transfers.map((entry) => entry.id), [tid]);
  assert.equal(listed.asOf.boot, 'b00700');
  assert.ok(Number.isInteger(listed.asOf.seq));
  await net.until(() => receiver.api.get(tid)?.state === 'offered', { message: 'the offer to arrive' });
  assert.equal((await call(receiver, 'GET', '/files/:id', { params: { id: tid } })).transfer.direction, 'receive');
  const missing = await fails(() => call(receiver, 'GET', '/files/:id', { params: { id: 'f'.repeat(32) } }));
  assert.match(missing.message, /^not-found:/);
  const stateError = await fails(() => call(sender, 'POST', '/files/:id/accept', { params: { id: tid } }));
  assert.match(stateError.message, /^invalid-state:/);
  const accepted = await call(receiver, 'POST', '/files/:id/accept', { params: { id: tid } });
  assert.equal(accepted.transfer.state, 'receiving');
  await net.until(() => sender.api.get(tid).state === 'completed', { message: 'completion' });
  const cancelled = await fails(() => call(receiver, 'POST', '/files/:id/cancel', { params: { id: tid } }));
  assert.match(cancelled.message, /^invalid-state:/);
});

test('stats count what happened', async (t) => {
  const { net, sender, receiver } = await pair(t);
  const dir = await tempDir(t, 'src');
  const { path, data } = await makeFile(dir, 's.bin', 10 * 1024);
  await sendAndWait(net, sender, receiver, path);
  await net.until(() => receiver.service.stats().completedIn === 1, { message: 'the receiver' });
  // A busy machine can fire a stall timer early (virtual clock, real I/O): count what was resent.
  const resent = sender.service.stats().chunksSent - 10;
  assert.ok(resent >= 0 && resent <= 10, `retransmissions: ${resent}`);
  assert.deepEqual(sender.service.stats(), {
    active: 0, offersIn: 0, offersOut: 1, completedIn: 0, completedOut: 1, failed: 0,
    chunksSent: 10 + resent, chunksResent: resent, chunksReceived: 0, chunksDuplicate: 0, chunksRejected: 0,
    bytesSent: data.length + resent * 1024, bytesReceived: 0,
  });
  const { chunksDuplicate, chunksRejected, ...received } = receiver.service.stats();
  assert.deepEqual(received, {
    active: 0, offersIn: 1, offersOut: 0, completedIn: 1, completedOut: 0, failed: 0,
    chunksSent: 0, chunksResent: 0, chunksReceived: 10,
    bytesSent: 0, bytesReceived: data.length,
  });
  // Every extra copy was either noticed as a duplicate or arrived after the file was complete.
  await net.run(100);
  const late = receiver.service.stats();
  assert.equal(late.chunksDuplicate + late.chunksRejected, resent);
  assert.ok(chunksDuplicate + chunksRejected <= resent);
});

test('a receiver stopped while it verifies a finished file resumes after the restart and completes', async (t) => {
  const CHUNK = 32 * 1024;
  const net = new Net();
  const receiver = await addNode(t, net, { files: { chunkSize: CHUNK } });
  const raw = addRaw(net);
  // Fewer chunks than the persist threshold, on a clock that does not move, so that no
  // progress is saved before the stop: the state a crash leaves, however it is reached.
  const data = randomBytes(48 * CHUNK - 5);
  const offer = offerFor(data, { chunk: CHUNK });
  const sealed = sealAll(offer);
  raw.send(receiver.id, 'file-offer', offer.meta);
  await net.until(() => receiver.api.get(offer.tid)?.state === 'receiving', { message: 'the offer to be accepted' });
  for (const body of sealed) raw.chunk(receiver.id, body);
  net.step();
  // The stop has to land while the whole-file hash is being computed: poll between the
  // file operations of the verification and stop at the first sight of the state.
  let caught = false;
  for (let i = 0; i < 400_000 && !caught; i += 1) {
    const { state } = receiver.api.get(offer.tid);
    if (state === 'verifying') caught = true;
    else if (state === 'completed') break;
    else await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(caught, true, 'the transfer was seen verifying');
  const acceptsBefore = raw.messages('file-accept').length;
  const restarted = await receiver.restart();
  await net.until(() => raw.messages('file-accept').length > acceptsBefore, { message: 'the restarted receiver to tell the sender what it holds' });
  const accepted = restarted.api.get(offer.tid);
  assert.equal(accepted.state, 'receiving', 'it asks for what it lacks instead of sitting in verifying');
  assert.ok(accepted.chunksDone < accepted.chunks, 'the saved progress was older than the last chunk');
  // The sender answers as it would on its own stall: the offer again, then the chunks.
  raw.send(restarted.id, 'file-offer', offer.meta);
  for (const body of sealed) raw.chunk(restarted.id, body);
  await net.until(() => restarted.api.get(offer.tid).state === 'completed', { message: 'the transfer to complete after the restart' });
  assert.equal(hex(sha256(await readFile(join(restarted.downloads, 'file.bin')))), hex(sha256(data)));
  assert.deepEqual(await restarted.listDownloads(), ['file.bin'], 'no part file is left');
  await net.until(() => raw.messages('file-done').length > 0, { message: 'file-done' });
  assert.equal(raw.messages('file-done').at(-1).meta.ok, true);
});

test('limits are honest constants', () => {
  assert.equal(MAX_CHUNKS, 1048576);
  assert.equal(SACK_MAX_RANGES, 64);
  assert.equal(INITIAL_WINDOW, 4);
  assert.equal(DEFAULT_OFFER_TTL_MS, 24 * 3_600_000);
});
