/**
 * PhoneNode: a ClawNet node that runs in a web page.
 *
 * It is a node of its own, not a remote control: it has its own identity (kept in the
 * browser's storage), links to one computer node over that node's WebSocket port, takes
 * part in ClawSync for the `lsa` and `peer` datasets, publishes its own signed LSA and peer
 * record, and sends and receives end-to-end encrypted messages that the computer forwards
 * without being able to read them.
 *
 * What it does not do, by design (web/README.md): accept links (a browser cannot listen),
 * forward anyone else's packets (it advertises `transit: false`, so no route passes through
 * it), run casts or file transfer, or keep working in the background. It only works while
 * the page is open, and it needs a computer node on the same network to link through.
 *
 * Its records, as the engine expects them:
 *   LSA   { type: "lsa", origin, seq, ts, links: [{ peer: <computer>, cost }], caps, sig }
 *         seq = max(previous + 1, now), kept in storage; refreshed every 60 s while linked,
 *         at most one per 5 s, again when the cost moves by more than 25 % and 10 ms.
 *   peer  { type: "peer", origin, seq, ts, addrs: [], caps, card, sig }
 *   caps  { relay: false, mailbox: false, transit: false }
 */

import { HandshakeError } from '../../src/core/errors.js';
import { PacketType, RecordType } from '../../src/core/wire/types.js';
import { base64Decode, base64Encode } from './bytes.js';
import { openLink } from './channel.js';
import { Identity, isValidNodeId, shortId, verifyCard, verifyRecord } from './identity.js';
import { LwwDataset } from './lww.js';
import { Messenger } from './messenger.js';
import { isNetworkId, validateLsa, validatePeerRecord, validateProbeHeader } from './schema.js';
import { SyncEngine } from './sync.js';

export const AGENT = 'clawnet-web/0.1.0';
export const CAPS = Object.freeze({ relay: false, mailbox: false, transit: false });

export const TIMERS = Object.freeze({
  keepaliveMs: 10_000,
  peerTimeoutMs: 30_000,
  handshakeTimeoutMs: 10_000,
  lsaRefreshMs: 60_000,
  lsaMinIntervalMs: 5_000,
  lsaMaxAgeMs: 210_000,
  syncIntervalMs: 20_000,
  redialMinMs: 1_000,
  redialMaxMs: 30_000,
  maxClockSkewMs: 300_000,
});

const MAX_ORIGINS = 4096;
/**
 * Peer records kept in storage across reloads (those of remembered nodes first, then the
 * newest), and remembered cards: of the computers this phone linked to and of the nodes it
 * exchanged messages with.
 */
const SAVED_PEER_RECORDS = 256;
const SAVED_CARDS = 64;
/**
 * Records new to this phone that it accepts from the computer per minute, with a full
 * allowance at link-up. Checking one costs one or two signature verifications on the
 * page's only thread, so a hostile computer must not be able to queue thousands; a phone
 * on a large network learns it over a few minutes instead.
 */
const NEW_KEYS_PER_MINUTE = 300;
const PROBE_REPLIES_PER_SEC = 20;
const PROBE_REPLIES_PER_RSVP_PER_SEC = 5;

/**
 * @typedef {object} NodeView one node as the app shows it
 * @property {string} id
 * @property {string} short
 * @property {string | null} name a nickname given on this phone
 * @property {boolean} linked  the computer this phone links through
 * @property {boolean} reachable a route exists from this phone
 * @property {boolean} canMessage this phone holds its identity card
 * @property {{ relay: boolean, mailbox: boolean, transit: boolean } | null} caps
 * @property {boolean} phone it advertises itself as a phone-like leaf (no transit)
 */

export class PhoneNode {
  #storage;
  #WebSocket;
  #now;
  #monoNow;
  #rng;
  #t;
  #listeners = new Set();
  #identity = null;
  #network = null;
  #url = null;
  #link = null;
  #connecting = false;
  #running = false;
  #attempt = 0;
  #redialTimer = null;
  #status = { state: 'idle', reason: null, since: 0 };
  #lsa;
  #peers;
  #received = new Map();
  #sync = null;
  #messenger = null;
  #seq = { lsa: 0, peer: 0 };
  #lastLsaAt = -Infinity;
  #advertisedCost = null;
  #lsaTimer = null;
  #syncTimer = null;
  #sweepTimer = null;
  #peerPublished = false;
  #names;
  /** Cards of the nodes this phone has linked to, verified in the handshake. */
  #cards = new Map();
  #saveQueued = false;
  #changeQueued = false;
  #probeTokens = { total: PROBE_REPLIES_PER_SEC, at: 0, perRsvp: new Map() };

  /**
   * @param {object} options
   * @param {ReturnType<import('./storage.js').createStorage>} options.storage
   * @param {typeof WebSocket} [options.WebSocket]
   * @param {() => number} [options.now]
   * @param {() => number} [options.monoNow]
   * @param {() => number} [options.rng]
   * @param {object} [options.timers] overrides of TIMERS (tests)
   */
  constructor({ storage, WebSocket: WebSocketClass = globalThis.WebSocket, now = Date.now, monoNow = () => performance.now(), rng = Math.random, timers = {} }) {
    this.#storage = storage;
    this.#WebSocket = WebSocketClass;
    this.#now = now;
    this.#monoNow = monoNow;
    this.#rng = rng;
    this.#t = { ...TIMERS, ...timers };
    this.#names = storage.get('names') ?? {};
    const cards = storage.get('cards');
    if (Array.isArray(cards)) {
      for (const card of cards.slice(-SAVED_CARDS)) if (verifyCard(card).ok) this.#cards.set(card.id, card);
    }
    const saved = storage.get('seq');
    if (saved !== null && Number.isSafeInteger(saved.lsa) && Number.isSafeInteger(saved.peer)) this.#seq = { lsa: saved.lsa, peer: saved.peer };
    this.#loadIdentity();
  }

  // ------------------------------------------------------------------ identity and network

  /** @returns {{ nodeId: string, short: string, networkId: string, card: object } | null} */
  get identity() {
    if (this.#identity === null) return null;
    return { nodeId: this.#identity.nodeId, short: shortId(this.#identity.nodeId), networkId: this.#network.networkId, card: this.#identity.card };
  }

  /** @returns {{ networkId: string, hasKey: boolean } | null} */
  get network() {
    return this.#network === null ? null : { networkId: this.#network.networkId, hasKey: this.#network.key !== null };
  }

  /**
   * Create this phone's identity for one network (an identity belongs to one network,
   * DESIGN.md section 15 item 3), and remember the network key if it has one.
   *
   * @param {{ networkId: string, networkKey?: string | null }} options key as base64 of 32 bytes
   * @throws {Error} code "bad-network" or "bad-key"
   */
  createIdentity({ networkId, networkKey = null }) {
    if (!isNetworkId(networkId)) throw coded('bad-network', 'the network name is not valid');
    const key = parseKey(networkKey);
    const identity = Identity.generate();
    const secret = identity.toSecret();
    this.#storage.set('identity', {
      v: 1,
      networkId,
      signSeed: base64Encode(secret.signSeed),
      linkPrivate: base64Encode(secret.linkPrivate),
      e2ePrivate: base64Encode(secret.e2ePrivate),
    });
    for (const value of Object.values(secret)) value.fill(0);
    this.#storage.set('network', { networkId, key: key === null ? null : base64Encode(key) });
    this.#storage.set('seq', { lsa: 0, peer: 0 });
    this.#seq = { lsa: 0, peer: 0 };
    this.#loadIdentity();
    this.#changed();
  }

  /**
   * Change the network key (for example after typing it wrong).
   *
   * @param {string | null} networkKey base64 of 32 bytes, or null
   */
  setNetworkKey(networkKey) {
    if (this.#network === null) throw coded('no-identity', 'create an identity first');
    const key = parseKey(networkKey);
    this.#network = { ...this.#network, key };
    this.#storage.set('network', { networkId: this.#network.networkId, key: key === null ? null : base64Encode(key) });
    this.#changed();
  }

  /** Forget the identity, the key and every message. Cannot be undone. */
  reset() {
    this.stop();
    this.#messenger?.close();
    this.#messenger = null;
    this.#storage.clear();
    this.#identity = null;
    this.#network = null;
    this.#names = {};
    this.#seq = { lsa: 0, peer: 0 };
    this.#setStatus('idle', null);
  }

  /**
   * @param {string} id
   * @param {string} name a nickname shown on this phone only; empty removes it
   */
  setName(id, name) {
    if (!isValidNodeId(id)) return;
    // Control characters are dropped; the name is shown with textContent only.
    const clean = [...String(name ?? '')].filter((ch) => ch >= ' ' && ch !== '\u007f').join('').trim().slice(0, 40);
    if (clean === '') delete this.#names[id];
    else this.#names[id] = clean;
    this.#storage.set('names', this.#names);
    this.#changed();
  }

  // ------------------------------------------------------------------ running

  /**
   * Link to the computer at `url` and keep the link up while the page is open.
   *
   * @param {string} url ws://host:port/
   */
  start(url) {
    if (this.#identity === null) throw coded('no-identity', 'create an identity first');
    this.#url = url;
    this.#running = true;
    this.#attempt = 0;
    this.#ensureModules();
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = setInterval(() => this.#sweep(), Math.max(1000, Math.floor(this.#t.lsaMaxAgeMs / 10)));
    this.#dial();
  }

  /** Close the link and stop redialing. */
  stop() {
    this.#running = false;
    clearTimeout(this.#redialTimer);
    clearInterval(this.#sweepTimer);
    this.#link?.close('shutdown');
    this.#link = null;
    this.#setStatus('idle', null);
  }

  /** Dial now if not linked (the page became visible again, the network came back). */
  reconnectNow() {
    if (!this.#running || this.#link !== null || this.#connecting) return;
    clearTimeout(this.#redialTimer);
    this.#dial();
  }

  /** @returns {{ state: string, reason: string | null, since: number, peer: object | null, pending: number }} */
  status() {
    const link = this.#link;
    return {
      ...this.#status,
      peer: link === null ? null : { id: link.remoteId, short: shortId(link.remoteId), rttMs: link.rttMs, agent: link.remotePayload.agent },
      pending: this.#messenger?.pending ?? 0,
    };
  }

  /** @returns {NodeView[]} every node this phone knows of, reachable ones first */
  nodes() {
    if (this.#sync === null || this.#identity === null) return [];
    const self = this.#identity.nodeId;
    const ids = new Set();
    for (const record of this.#peers.values()) ids.add(record.origin);
    for (const record of this.#lsa.values()) ids.add(record.origin);
    if (this.#link !== null) ids.add(this.#link.remoteId);
    ids.delete(self);
    const reachable = this.#reachable();
    const out = [];
    for (const id of ids) {
      const caps = this.#lsa.get(id)?.caps ?? this.#peers.get(id)?.caps ?? (this.#link?.remoteId === id ? this.#link.remotePayload.caps : null);
      out.push({
        id,
        short: shortId(id),
        name: this.#names[id] ?? null,
        linked: this.#link?.remoteId === id,
        reachable: reachable.has(id),
        canMessage: this.#cardOf(id) !== null,
        caps,
        phone: caps !== null && caps.transit === false,
      });
    }
    return out.sort((a, b) => Number(b.linked) - Number(a.linked) || Number(b.reachable) - Number(a.reachable) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  /** @returns {ReturnType<Messenger['conversations']>} */
  conversations() {
    return this.#messenger?.conversations() ?? [];
  }

  /** @param {string} peer */
  messages(peer) {
    return this.#messenger?.messages(peer) ?? [];
  }

  /**
   * @param {string} peer
   * @param {string} text
   */
  sendText(peer, text) {
    this.#ensureModules();
    const message = this.#messenger.sendText(peer, text);
    this.#changed();
    return message;
  }

  /**
   * Listen to changes; the listener gets `{ type, ... }` for "change", "message" and
   * "delivered".
   *
   * @param {(event: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ------------------------------------------------------------------ the link

  #dial() {
    if (!this.#running || this.#connecting || this.#link !== null) return;
    this.#connecting = true;
    this.#setStatus('connecting', null);
    const network = this.#network;
    openLink({
      url: this.#url,
      identity: this.#identity,
      networkId: network.networkId,
      networkKey: network.key,
      agent: AGENT,
      caps: CAPS,
      WebSocket: this.#WebSocket,
      now: this.#now,
      monoNow: this.#monoNow,
      handshakeTimeoutMs: this.#t.handshakeTimeoutMs,
      maxClockSkewMs: this.#t.maxClockSkewMs,
      keepaliveMs: this.#t.keepaliveMs,
      peerTimeoutMs: this.#t.peerTimeoutMs,
    }).then(
      (link) => {
        this.#connecting = false;
        if (!this.#running) {
          link.close('shutdown');
          return;
        }
        this.#adopt(link);
      },
      (error) => {
        this.#connecting = false;
        const reason = error instanceof HandshakeError ? error.reason : 'connect-failed';
        this.#setStatus('offline', reason);
        this.#scheduleRedial(reason);
      },
    );
  }

  #scheduleRedial(reason) {
    if (!this.#running) return;
    this.#attempt += 1;
    const { redialMinMs, redialMaxMs } = this.#t;
    // Refusals that will not change by themselves are retried slowly.
    const slow = ['blocked', 'not-allowed', 'network-mismatch', 'clock-skew', 'self'].includes(reason);
    const base = slow ? redialMaxMs : Math.min(redialMaxMs, redialMinMs * 2 ** Math.min(this.#attempt - 1, 10));
    const delay = Math.round(base * (1 + 0.2 * (2 * this.#rng() - 1)));
    clearTimeout(this.#redialTimer);
    this.#redialTimer = setTimeout(() => this.#dial(), delay);
  }

  #adopt(link) {
    this.#link = link;
    this.#attempt = 0;
    const pc = link.remoteId;
    link.onPacket = (packet) => this.#onPacket(pc, packet);
    link.onClose = (info) => this.#onLinkDown(link, info);
    link.onMetric = () => this.#onMetric();
    link.start();
    this.#setStatus('linked', null);
    this.#rememberCard(link.remoteCard);
    this.#sync.addPeer(pc);
    // The computer's card arrived in the handshake: messages to it can be sealed now.
    this.#originateLsa('link-up');
    this.#publishPeerRecord();
    clearInterval(this.#lsaTimer);
    this.#lsaTimer = setInterval(() => this.#originateLsa('refresh'), this.#t.lsaRefreshMs);
    clearInterval(this.#syncTimer);
    this.#syncTimer = setInterval(() => this.#sync.tick(), this.#t.syncIntervalMs);
    this.#messenger.linkUp();
    this.#changed();
  }

  #onLinkDown(link, { reason }) {
    if (this.#link !== link) return;
    this.#link = null;
    this.#sync.removePeer(link.remoteId);
    clearInterval(this.#lsaTimer);
    clearInterval(this.#syncTimer);
    this.#advertisedCost = null;
    if (!this.#running) return;
    this.#setStatus('offline', reason);
    this.#scheduleRedial(reason);
  }

  #onMetric() {
    const link = this.#link;
    if (link === null) return;
    const cost = link.cost;
    const old = this.#advertisedCost;
    // DESIGN.md 15.17: re-advertise when the cost moved by more than 25 % and 10 ms.
    if (old !== null && Math.abs(cost - old) > 0.25 * old && Math.abs(cost - old) > 10) this.#originateLsa('cost');
    this.#changed();
  }

  #onPacket(from, packet) {
    switch (packet.type) {
      case PacketType.GOSSIP:
      case PacketType.SYNC_DIGEST:
      case PacketType.SYNC_REQUEST:
      case PacketType.SYNC_DELTA:
        this.#sync.handlePacket(from, packet);
        this.#changed();
        return;
      case PacketType.DATA:
        if (packet.header?.dst === this.#identity.nodeId) this.#messenger.handleData(packet);
        // Anything else: this phone forwards nothing (caps.transit = false).
        return;
      case PacketType.PROBE:
        this.#onProbe(packet);
        return;
      default:
    }
  }

  /** Answer a probe addressed to this phone with a sealed probe-reply (engine's diag rules). */
  #onProbe(packet) {
    if (!validateProbeHeader(packet.header).ok || packet.header.dst !== this.#identity.nodeId) return;
    const { id, rsvp, n, ttl } = packet.header;
    if (this.#cardOf(rsvp) === null) return;
    const now = this.#monoNow();
    const refill = (bucket, rate) => {
      bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) * rate) / 1000);
      bucket.at = now;
    };
    const total = this.#probeTokens;
    let mine = total.perRsvp.get(rsvp);
    if (mine === undefined) {
      if (total.perRsvp.size >= 256) total.perRsvp.delete(total.perRsvp.keys().next().value);
      mine = { tokens: PROBE_REPLIES_PER_RSVP_PER_SEC, at: now };
      total.perRsvp.set(rsvp, mine);
    }
    refill(total, PROBE_REPLIES_PER_SEC);
    refill(mine, PROBE_REPLIES_PER_RSVP_PER_SEC);
    if (total.tokens < 1 || mine.tokens < 1) return;
    total.tokens -= 1;
    mine.tokens -= 1;
    this.#messenger.sendOnce(rsvp, { kind: 'probe-reply', re: id, n, hop: n - ttl + 1, at: 'dst' });
  }

  // ------------------------------------------------------------------ records

  #originateLsa(reason) {
    const link = this.#link;
    if (link === null || this.#sync === null) return;
    const mono = this.#monoNow();
    if (reason !== 'link-up' && mono - this.#lastLsaAt < this.#t.lsaMinIntervalMs) return;
    const now = this.#now();
    const seq = Math.max(this.#seq.lsa + 1, now);
    const cost = Math.max(1, Math.min(65535, link.cost));
    const record = this.#identity.signRecord(RecordType.LSA, { seq, ts: now, links: [{ peer: link.remoteId, cost }], caps: CAPS });
    this.#seq.lsa = seq;
    this.#saveSeq();
    this.#lastLsaAt = mono;
    this.#advertisedCost = cost;
    this.#sync.publish('lsa', record);
  }

  #publishPeerRecord() {
    if (this.#sync === null) return;
    const own = this.#peers.get(this.#identity.nodeId);
    if (this.#peerPublished && own !== undefined) {
      // Already published in this session: make sure the computer has it.
      this.#sync.push('peer', own);
      return;
    }
    const now = this.#now();
    const seq = Math.max(this.#seq.peer + 1, now);
    const record = this.#identity.signRecord(RecordType.PEER, { seq, ts: now, addrs: [], caps: CAPS, card: this.#identity.card });
    this.#seq.peer = seq;
    this.#saveSeq();
    if (this.#sync.publish('peer', record).accepted) this.#peerPublished = true;
  }

  /** A record of our own origin arrived from the network with a seq at or above ours. */
  #ownRecordSeen(kind, seq) {
    if (seq <= this.#seq[kind]) return;
    this.#seq[kind] = seq;
    this.#saveSeq();
    // Not inside the dataset's own call.
    queueMicrotask(() => {
      if (kind === 'lsa') this.#originateLsa('superseded');
      else {
        this.#peerPublished = false;
        this.#publishPeerRecord();
      }
    });
  }

  #saveSeq() {
    this.#storage.set('seq', this.#seq);
  }

  #ensureModules() {
    if (this.#sync !== null) return;
    const self = this.#identity.nodeId;
    this.#lsa = new LwwDataset({
      name: 'lsa',
      key: (r) => r.origin,
      version: (r) => r.seq,
      check: (r) => this.#checkLsa(r),
      maxEntries: MAX_ORIGINS,
      priority: (origin) => this.#importance(origin),
      onAccept: (r, { from }) => {
        if (r.origin === self) {
          if (from !== undefined) this.#ownRecordSeen('lsa', r.seq);
          return;
        }
        this.#received.set(r.origin, this.#monoNow());
      },
    });
    this.#lsa.pin(self);
    this.#peers = new LwwDataset({
      name: 'peer',
      key: (r) => r.origin,
      version: (r) => r.seq,
      check: (r) => this.#checkPeer(r),
      maxEntries: MAX_ORIGINS,
      // When full, a flood of new origins cannot push out the computer or known contacts.
      priority: (origin) => this.#importance(origin),
      onAccept: (r, { from }) => {
        if (r.origin === self) {
          if (from !== undefined) this.#ownRecordSeen('peer', r.seq);
          return;
        }
        if (from !== undefined) this.#queueSavePeers();
      },
    });
    this.#peers.pin(self);
    const saved = this.#storage.get('peerRecords');
    if (Array.isArray(saved)) {
      // Not trusted: every record goes through the dataset's check, signature included.
      for (const record of saved.slice(0, SAVED_PEER_RECORDS)) {
        if (record?.origin !== self) this.#peers.offer(record);
      }
    }
    this.#sync = new SyncEngine({
      datasets: [this.#lsa, this.#peers],
      send: (peer, packet) => this.#link !== null && this.#link.remoteId === peer && this.#link.send(packet),
      monoNow: this.#monoNow,
      rng: this.#rng,
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      // A sync violation from the computer ends the link, as the engine does with a peer.
      onError: () => this.#link?.close('protocol'),
      self,
      roundTimeoutMs: Math.min(10_000, Math.max(1000, 4 * this.#t.syncIntervalMs)),
      minRoundIntervalMs: Math.min(1000, Math.floor(this.#t.syncIntervalMs / 2)),
      newKeysPerMinute: NEW_KEYS_PER_MINUTE,
    });
    this.#messenger = new Messenger({
      identity: this.#identity,
      storage: this.#storage,
      cardOf: (id) => this.#cardOf(id),
      remember: (card) => this.#rememberCard(card),
      transmit: (packet) => this.#link !== null && this.#link.send(packet),
      emit: (type, data) => this.#notify({ type, ...data }),
      now: this.#now,
      rng: this.#rng,
    });
  }

  #checkLsa(record) {
    if (!validateLsa(record).ok) return { ok: false, reason: 'invalid-lsa' };
    const wall = this.#now();
    if (record.seq < wall - (this.#t.lsaMaxAgeMs + this.#t.maxClockSkewMs)) return { ok: false, reason: 'too-old', soft: true };
    if (record.seq > wall + this.#t.maxClockSkewMs) return { ok: false, reason: 'too-new', soft: true };
    if (!verifyRecord(record, RecordType.LSA).ok) return { ok: false, reason: 'bad-signature' };
    return { ok: true };
  }

  #checkPeer(record) {
    if (!validatePeerRecord(record).ok) return { ok: false, reason: 'bad-shape' };
    if (record.ts > this.#now() + this.#t.maxClockSkewMs) return { ok: false, reason: 'future', soft: true };
    // Nodes number their peer records with the clock, as they do LSAs. A seq far ahead of
    // it would let one origin outrank every other when the dataset is full.
    if (record.seq > this.#now() + this.#t.maxClockSkewMs) return { ok: false, reason: 'too-new', soft: true };
    if (!verifyRecord(record, RecordType.PEER).ok) return { ok: false, reason: 'bad-signature' };
    if (!verifyCard(record.card).ok) return { ok: false, reason: 'bad-card' };
    return { ok: true };
  }

  /** LSAs expire 210 s after they arrived here, as in the engine. */
  #sweep() {
    if (this.#lsa === undefined) return;
    const now = this.#monoNow();
    let removed = false;
    for (const [origin, at] of this.#received) {
      if (now - at >= this.#t.lsaMaxAgeMs) {
        this.#received.delete(origin);
        this.#lsa.remove(origin);
        removed = true;
      }
    }
    if (removed) this.#changed();
  }

  #cardOf(id) {
    if (this.#link !== null && this.#link.remoteId === id) return this.#link.remoteCard;
    return this.#peers?.get(id)?.card ?? this.#cards.get(id) ?? null;
  }

  #rememberCard(card) {
    // Already the most recent: nothing to write.
    if ([...this.#cards.keys()].at(-1) === card.id) return;
    this.#cards.delete(card.id);
    this.#cards.set(card.id, card);
    while (this.#cards.size > SAVED_CARDS) this.#cards.delete(this.#cards.keys().next().value);
    this.#storage.set('cards', [...this.#cards.values()]);
  }

  /** 2 for the computer linked now, 1 for remembered nodes, 0 for the rest. */
  #importance(id) {
    if (this.#link !== null && this.#link.remoteId === id) return 2;
    return this.#cards.has(id) ? 1 : 0;
  }

  /** Keep the newest peer records, so cards survive a reload; they are verified again on load. */
  #queueSavePeers() {
    if (this.#saveQueued) return;
    this.#saveQueued = true;
    setTimeout(() => {
      this.#saveQueued = false;
      if (this.#peers === undefined || this.#identity === null) return;
      const self = this.#identity.nodeId;
      const records = this.#peers.values()
        .filter((r) => r.origin !== self)
        .sort((a, b) => this.#importance(b.origin) - this.#importance(a.origin) || b.seq - a.seq)
        .slice(0, SAVED_PEER_RECORDS);
      this.#storage.set('peerRecords', records);
    }, 1000);
  }

  /**
   * Nodes a packet from this phone can reach: the computer it links to, then everything
   * reachable from it over links both ends advertise, passing only through nodes that
   * allow transit. The map gives each node the neighbour it was reached from.
   *
   * @returns {Map<string, string>} node -> previous node on the way from this phone
   */
  #paths() {
    const parents = new Map();
    const link = this.#link;
    if (link === null || this.#lsa === undefined) return parents;
    const advertised = new Map();
    for (const record of this.#lsa.values()) advertised.set(record.origin, new Set(record.links.map((l) => l.peer)));
    const confirmed = (a, b) => advertised.get(a)?.has(b) === true && advertised.get(b)?.has(a) === true;
    const self = this.#identity.nodeId;
    const queue = [link.remoteId];
    parents.set(link.remoteId, self);
    while (queue.length > 0) {
      const at = queue.shift();
      if (this.#lsa.get(at)?.caps.transit !== true) continue;
      for (const next of advertised.get(at) ?? []) {
        if (next === self || parents.has(next) || !confirmed(at, next)) continue;
        parents.set(next, at);
        queue.push(next);
      }
    }
    return parents;
  }

  #reachable() {
    return new Set(this.#paths().keys());
  }

  /**
   * The way a message from this phone travels to `id`, as far as this phone can tell from
   * the LSAs it holds (the nodes in between choose the actual next hops).
   *
   * @param {string} id
   * @returns {string[] | null} [this phone, the computer, ..., id], or null if unreachable
   */
  route(id) {
    if (this.#identity === null) return null;
    const parents = this.#paths();
    if (!parents.has(id)) return null;
    const path = [id];
    let at = id;
    while (parents.has(at) && path.length <= 32) {
      at = parents.get(at);
      path.unshift(at);
      if (at === this.#identity.nodeId) return path;
    }
    return null;
  }

  #loadIdentity() {
    const saved = this.#storage.get('identity');
    const network = this.#storage.get('network');
    if (saved === null || saved.v !== 1 || !isNetworkId(saved.networkId)) return;
    try {
      this.#identity = Identity.fromSecret({
        signSeed: base64Decode(saved.signSeed, 32),
        linkPrivate: base64Decode(saved.linkPrivate, 32),
        e2ePrivate: base64Decode(saved.e2ePrivate, 32),
      });
    } catch {
      this.#identity = null;
      return;
    }
    let key = null;
    try {
      key = network?.networkId === saved.networkId && typeof network.key === 'string' ? base64Decode(network.key, 32) : null;
    } catch {
      key = null;
    }
    this.#network = { networkId: saved.networkId, key };
    this.#sync = null;
    this.#lsa = undefined;
    this.#peers = undefined;
    this.#peerPublished = false;
  }

  // ------------------------------------------------------------------ events

  #setStatus(state, reason) {
    if (this.#status.state === state && this.#status.reason === reason) return;
    this.#status = { state, reason, since: this.#now() };
    this.#changed();
  }

  #changed() {
    if (this.#changeQueued) return;
    this.#changeQueued = true;
    queueMicrotask(() => {
      this.#changeQueued = false;
      this.#notify({ type: 'change' });
    });
  }

  #notify(event) {
    if (event.type !== 'change') this.#changed();
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A failing view must not stop the node.
      }
    }
  }
}

/** @returns {Uint8Array | null} the network key from base64 (spaces and line breaks ignored) */
export function parseKey(text) {
  if (text === null || text === undefined) return null;
  const clean = String(text).replace(/\s+/g, '');
  if (clean === '') return null;
  try {
    return base64Decode(clean, 32);
  } catch {
    throw coded('bad-key', 'the network key must be the 44-character base64 text of 32 bytes');
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
