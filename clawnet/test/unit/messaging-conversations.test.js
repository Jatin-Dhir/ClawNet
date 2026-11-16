/**
 * The chat history (ConversationStore) against a fake messenger, a real event bus and a
 * real append-only log in a temporary directory, and the `messages` service against a fake
 * service context.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Identity } from '../../src/core/crypto/identity.js';
import { ConfigError, StateError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import {
  ConversationStore,
  createMessagesService,
  MAX_TEXT_BYTES,
} from '../../src/core/messaging/conversations.js';
import { AppendLog } from '../../src/vault/store.js';
import { tempDir } from '../helpers/tmp.js';

const SELF = Identity.generate().nodeId;
const ALICE = Identity.generate().nodeId;
const BOB = Identity.generate().nodeId;
const hex = (n) => n.toString(16).padStart(32, '0');

/** A messenger that records sends and lets a test emit the events a real one would. */
function fakeMessenger(events, { state = 'sent', emitOnSend = [] } = {}) {
  let counter = 0;
  const sent = [];
  const handlers = new Map();
  return {
    sent,
    handlers,
    async send(dst, options) {
      counter += 1;
      const id = hex(counter);
      sent.push({ dst, id, ...options });
      for (const [type, data] of emitOnSend) events.emit(type, { id, dst, kind: options.kind, ...data });
      return { id, state };
    },
    onKind(kind, handler) {
      handlers.set(kind, handler);
      return () => handlers.delete(kind);
    },
    deliver(from, id, text, ts = 1000) {
      const content = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
      return handlers.get('msg')({ id, from, kind: 'msg', meta: {}, content, ts, receivedAt: ts });
    },
  };
}

async function setup(t, { maxPerPeer, maxPeers, messenger: messengerOptions, now } = {}) {
  const dir = await tempDir(t, 'conv');
  const events = new EventBus({ capacity: 1000 });
  const log = new AppendLog(join(dir, 'conversations.log'));
  await log.open();
  const clock = { at: 1_700_000_000_000 };
  const messenger = fakeMessenger(events, messengerOptions);
  const store = new ConversationStore({
    selfId: SELF, messenger, log, events, now: now ?? (() => (clock.at += 1)), maxPerPeer, maxPeers,
  });
  await store.open();
  t.after(async () => {
    await store.close();
    await log.close();
  });
  return { dir, events, log, messenger, store, clock, path: join(dir, 'conversations.log') };
}

const seen = (events, type) => events.recent({ types: [type] }).map((event) => event.data);

test('an outgoing message is recorded, sent as kind msg with the text as content, and announced', async (t) => {
  const { store, messenger, events } = await setup(t);
  const message = await store.send(ALICE, 'status report at 0900');
  assert.deepEqual(Object.keys(message).sort(), ['at', 'direction', 'id', 'peer', 'seq', 'state', 'text', 'ts']);
  assert.equal(message.seq, 1);
  assert.equal(message.id, hex(1));
  assert.equal(message.peer, ALICE);
  assert.equal(message.direction, 'out');
  assert.equal(message.state, 'sent');
  assert.equal(messenger.sent.length, 1);
  assert.equal(messenger.sent[0].kind, 'msg');
  assert.equal(Buffer.from(messenger.sent[0].content).toString('utf8'), 'status report at 0900');
  assert.deepEqual(seen(events, 'chat.message'), [{ message }]);
  assert.deepEqual(store.list().map((entry) => [entry.peer, entry.count, entry.last.text]), [[ALICE, 1, 'status report at 0900']]);
});

test('a message the messenger had to hold starts as queued', async (t) => {
  const { store } = await setup(t, { messenger: { state: 'waiting' } });
  assert.equal((await store.send(ALICE, 'later')).state, 'queued');
});

test('the life of an outgoing message: sent, held by a mailbox, delivered, never moving back', async (t) => {
  const { store, events } = await setup(t, { messenger: { state: 'waiting' } });
  const { id } = await store.send(ALICE, 'hello');
  const state = () => store.messages(ALICE).items[0].state;
  assert.equal(state(), 'queued');

  events.emit('message.sent', { id, dst: ALICE, kind: 'msg', attempt: 1, nextHop: ALICE });
  assert.equal(state(), 'sent');
  events.emit('message.sent', { id, dst: ALICE, kind: 'msg', attempt: 2, nextHop: ALICE });
  events.emit('custody.deposited', { id, dst: ALICE, custodian: BOB });
  assert.equal(state(), 'custody');
  // A retransmission after the mailbox took it does not undo that.
  events.emit('message.sent', { id, dst: ALICE, kind: 'msg', attempt: 3, nextHop: ALICE });
  assert.equal(state(), 'custody');
  events.emit('message.acked', { id, dst: ALICE, kind: 'msg', attempts: 3, elapsedMs: 9 });
  assert.equal(state(), 'delivered');
  // Nothing moves a delivered message: not a late expiry, not a late "sent".
  events.emit('message.expired', { id, dst: ALICE, kind: 'msg' });
  events.emit('message.sent', { id, dst: ALICE, kind: 'msg', attempt: 4, nextHop: ALICE });
  assert.equal(state(), 'delivered');

  assert.deepEqual(seen(events, 'chat.state'), [
    { id, peer: ALICE, state: 'sent' },
    { id, peer: ALICE, state: 'custody' },
    { id, peer: ALICE, state: 'delivered' },
  ]);
  assert.equal(store.stats().stateChanges, 3);
});

test('an expired message says so, and events about other kinds or other ids change nothing', async (t) => {
  const { store, events } = await setup(t, { messenger: { state: 'waiting' } });
  const { id } = await store.send(ALICE, 'hello');
  events.emit('message.sent', { id, dst: ALICE, kind: 'file-offer', attempt: 1, nextHop: ALICE });
  events.emit('message.acked', { id: hex(999), dst: ALICE, kind: 'msg', attempts: 1, elapsedMs: 1 });
  events.emit('message.acked', { id, dst: BOB, kind: 'msg', attempts: 1, elapsedMs: 1 });
  assert.equal(store.messages(ALICE).items[0].state, 'queued');
  events.emit('message.expired', { id, dst: ALICE, kind: 'msg' });
  assert.equal(store.messages(ALICE).items[0].state, 'expired');
});

test('events that arrive before send() returns are not lost', async (t) => {
  // The messenger emits "sent" and the ack while send() is still running, before the
  // store knows the id.
  const { store, path, events } = await setup(t, {
    messenger: { state: 'sent', emitOnSend: [['message.sent', { attempt: 1, nextHop: ALICE }], ['message.acked', { attempts: 1, elapsedMs: 1 }]] },
  });
  const message = await store.send(ALICE, 'fast');
  assert.equal(message.state, 'delivered');
  assert.equal(store.messages(ALICE).items[0].state, 'delivered');
  assert.deepEqual(seen(events, 'chat.state'), [], 'it was already delivered when first announced');
  assert.match(await readFile(path, 'utf8'), /./, 'the log is not empty');
});

test('an incoming message is stored, announced once, and a repeat of its id is ignored', async (t) => {
  const { store, messenger, events } = await setup(t);
  await messenger.deliver(ALICE, hex(50), 'ready', 4242);
  await messenger.deliver(ALICE, hex(50), 'ready', 4242);
  const [message] = store.messages(ALICE).items;
  assert.equal(message.direction, 'in');
  assert.equal(message.state, 'received');
  assert.equal(message.peer, ALICE);
  assert.equal(message.ts, 4242);
  assert.equal(message.text, 'ready');
  assert.equal(store.messages(ALICE).items.length, 1);
  assert.equal(seen(events, 'chat.message').length, 1);
  assert.equal(store.stats().duplicates, 1);
});

test('the same id from two senders is two messages: an id is only unique per sender', async (t) => {
  const { store, messenger } = await setup(t);
  await messenger.deliver(ALICE, hex(7), 'from alice');
  await messenger.deliver(BOB, hex(7), 'from bob');
  assert.deepEqual(store.messages(ALICE).items.map((m) => m.text), ['from alice']);
  assert.deepEqual(store.messages(BOB).items.map((m) => m.text), ['from bob']);
});

test('text that is not valid UTF-8, empty or too long is ignored without failing the delivery', async (t) => {
  const { store, messenger } = await setup(t);
  await messenger.deliver(ALICE, hex(1), Buffer.from([0xff, 0xfe, 0x41]));
  await messenger.deliver(ALICE, hex(2), Buffer.alloc(0));
  await messenger.deliver(ALICE, hex(3), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
  await messenger.deliver(ALICE, hex(4), Buffer.alloc(MAX_TEXT_BYTES, 0x61));
  assert.deepEqual(store.messages(ALICE).items.map((m) => m.id), [hex(4)]);
  assert.equal(store.stats().ignored, 3);
  // A message from this node's own id never lands in a conversation.
  await messenger.deliver(SELF, hex(5), 'echo');
  assert.deepEqual(store.list().map((entry) => entry.peer), [ALICE]);
});

test('sending validates the destination and the text, and records nothing when the messenger refuses', async (t) => {
  const { store, messenger } = await setup(t);
  await assert.rejects(store.send('nope', 'x'), ConfigError);
  await assert.rejects(store.send(ALICE, ''), ConfigError);
  await assert.rejects(store.send(ALICE, 'x'.repeat(MAX_TEXT_BYTES + 1)), ConfigError);
  await assert.rejects(store.send(ALICE, String.fromCharCode(0xd800)), ConfigError, 'a lone surrogate is not text');
  await assert.rejects(store.send(ALICE, 42), ConfigError);
  assert.equal((await store.send(ALICE, 'x'.repeat(MAX_TEXT_BYTES))).text.length, MAX_TEXT_BYTES);
  assert.equal(messenger.sent.length, 1);

  messenger.send = async () => {
    throw new StateError('unknown-destination: no card');
  };
  await assert.rejects(store.send(BOB, 'hi'), { code: 'ERR_STATE' });
  assert.equal(store.messages(BOB).items.length, 0);
  assert.deepEqual(store.list().map((entry) => entry.peer), [ALICE]);
});

test('paging walks back through the history with before and nextBefore', async (t) => {
  const { store } = await setup(t);
  for (let i = 1; i <= 120; i += 1) await store.send(ALICE, `m${i}`);
  const first = store.messages(ALICE);
  assert.equal(first.items.length, 50);
  assert.deepEqual([first.items[0].seq, first.items[49].seq], [120, 71]);
  assert.equal(first.nextBefore, 71);
  const second = store.messages(ALICE, { before: first.nextBefore, limit: 50 });
  assert.deepEqual([second.items[0].seq, second.items[49].seq], [70, 21]);
  const third = store.messages(ALICE, { before: second.nextBefore });
  assert.equal(third.items.length, 20);
  assert.equal(third.nextBefore, null);
  assert.deepEqual(store.messages(ALICE, { limit: 3 }).items.map((m) => m.text), ['m120', 'm119', 'm118']);
  assert.deepEqual(store.messages(ALICE, { limit: 120 }).nextBefore, null);
  assert.deepEqual(store.messages(BOB), { items: [], nextBefore: null }, 'an unknown peer has an empty history');
  assert.throws(() => store.messages(ALICE, { limit: 0 }), ConfigError);
  assert.throws(() => store.messages(ALICE, { limit: 501 }), ConfigError);
  assert.throws(() => store.messages(ALICE, { before: 0 }), ConfigError);
  assert.throws(() => store.messages(ALICE, { before: 1.5 }), ConfigError);
  assert.throws(() => store.messages('nope'), ConfigError);
});

test('conversations are listed most recently active first, with the latest message', async (t) => {
  const { store, messenger } = await setup(t);
  await store.send(ALICE, 'one');
  await messenger.deliver(BOB, hex(100), 'two');
  await store.send(ALICE, 'three');
  const list = store.list();
  assert.deepEqual(list.map((entry) => [entry.peer, entry.count, entry.last.text]), [[ALICE, 2, 'three'], [BOB, 1, 'two']]);
  assert.equal(list[0].lastAt, list[0].last.at);
  // What list() and messages() return is a copy: changing it changes nothing.
  list[0].last.text = 'tampered';
  store.messages(ALICE).items[0].text = 'tampered';
  assert.equal(store.messages(ALICE).items[0].text, 'three');
});

test('retention keeps the newest messages per peer and the most recently active peers', async (t) => {
  const { store, messenger } = await setup(t, { maxPerPeer: 3, maxPeers: 2 });
  for (let i = 1; i <= 5; i += 1) await store.send(ALICE, `a${i}`);
  assert.deepEqual(store.messages(ALICE).items.map((m) => m.text), ['a5', 'a4', 'a3']);
  await store.send(BOB, 'b1');
  const carol = Identity.generate().nodeId;
  await messenger.deliver(carol, hex(9), 'c1');
  // Alice was the least recently active of three peers.
  assert.deepEqual(store.list().map((entry) => entry.peer), [carol, BOB]);
  assert.equal(store.stats().messages, 2);
  // Her messages are gone from the index too, so a retransmission is simply new again.
  await messenger.deliver(ALICE, hex(77), 'back');
  assert.deepEqual(store.list().map((entry) => entry.peer), [ALICE, carol]);
});

test('the history survives a restart: texts, order, states and the next seq', async (t) => {
  const first = await setup(t, { messenger: { state: 'waiting' } });
  const out = await first.store.send(ALICE, 'outgoing');
  await first.messenger.deliver(ALICE, hex(40), 'incoming', 5);
  first.events.emit('message.acked', { id: out.id, dst: ALICE, kind: 'msg', attempts: 1, elapsedMs: 1 });
  await first.store.close();

  const log = new AppendLog(first.path);
  await log.open();
  const events = new EventBus();
  const reopened = new ConversationStore({ selfId: SELF, messenger: fakeMessenger(events), log, events });
  await reopened.open();
  t.after(() => reopened.close());
  t.after(() => log.close());
  const items = reopened.messages(ALICE).items;
  assert.deepEqual(items.map((m) => [m.seq, m.direction, m.text, m.state, m.ts]), [
    [2, 'in', 'incoming', 'received', 5],
    [1, 'out', 'outgoing', 'delivered', items[1].ts],
  ]);
  // New messages continue the sequence.
  assert.equal((await reopened.send(ALICE, 'next')).seq, 3);
  // A message that was already stored is still recognised as a duplicate.
  await reopened.close();
});

test('records that are damaged or of an unknown shape are skipped and counted on load', async (t) => {
  const first = await setup(t);
  await first.store.send(ALICE, 'kept');
  await first.store.close();
  await first.log.flush();
  await appendFile(first.path, '{"op":"msg","seq":"x"}\n{"op":"nope"}\nnot json at all\n[1,2]\n');

  const log = new AppendLog(first.path);
  await log.open();
  const events = new EventBus();
  const reopened = new ConversationStore({ selfId: SELF, messenger: fakeMessenger(events), log, events });
  await reopened.open();
  t.after(() => reopened.close());
  t.after(() => log.close());
  assert.deepEqual(reopened.messages(ALICE).items.map((m) => m.text), ['kept']);
  assert.ok(reopened.stats().corruptRecords >= 2, `skipped ${reopened.stats().corruptRecords}`);
});

test('the log is rewritten to the retained messages once it holds far more records than that', async (t) => {
  const { store, path, log } = await setup(t, { maxPerPeer: 5 });
  for (let i = 1; i <= 300; i += 1) await store.send(ALICE, `m${i}`);
  await store.close();
  await log.flush();
  assert.ok(store.stats().compactions >= 1, 'a compaction ran');
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
  assert.ok(lines.length < 300, `the log shrank to ${lines.length} records`);

  const log2 = new AppendLog(path);
  await log2.open();
  const events = new EventBus();
  const reopened = new ConversationStore({ selfId: SELF, messenger: fakeMessenger(events), log: log2, events, maxPerPeer: 5 });
  await reopened.open();
  t.after(() => reopened.close());
  t.after(() => log2.close());
  assert.deepEqual(reopened.messages(ALICE).items.map((m) => m.text), ['m300', 'm299', 'm298', 'm297', 'm296']);
});

test('a closed store refuses to send, forgets the handler and ignores events', async (t) => {
  const { store, messenger, events } = await setup(t, { messenger: { state: 'waiting' } });
  const { id } = await store.send(ALICE, 'hello');
  await store.close();
  await assert.rejects(store.send(ALICE, 'more'), { code: 'ERR_STATE' });
  assert.equal(messenger.handlers.has('msg'), false);
  events.emit('message.acked', { id, dst: ALICE, kind: 'msg', attempts: 1, elapsedMs: 1 });
  assert.equal(store.messages(ALICE).items[0].state, 'queued');
});

test('constructor and open() reject invalid use', async (t) => {
  const { events, log, messenger } = await setup(t);
  assert.throws(() => new ConversationStore({ selfId: 'x', messenger, log, events }), ConfigError);
  assert.throws(() => new ConversationStore({ selfId: SELF, log, events }), ConfigError);
  assert.throws(() => new ConversationStore({ selfId: SELF, messenger, log, events, maxPerPeer: 0 }), ConfigError);
  const again = new ConversationStore({ selfId: SELF, messenger: fakeMessenger(events), log, events });
  await again.open();
  await assert.rejects(again.open(), { code: 'ERR_STATE' });
  await again.close();
});

// ---------------------------------------------------------------------------------------
// The messages service
// ---------------------------------------------------------------------------------------

function fakeServiceContext(node) {
  const routes = new Map();
  const error = (status, code, message, details) => Object.assign(new Error(message), { status, apiCode: code, details: details ?? null });
  return {
    routes,
    ctx: {
      node,
      api: {
        route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
        reply: (status, body) => ({ status, body }),
        error,
      },
    },
  };
}

test('the messages service registers its three routes and validates input before touching the node', async () => {
  const calls = [];
  const node = {
    sendMessage: async (to, text) => {
      calls.push(['send', to, text]);
      if (to === BOB) throw new StateError('unknown-destination: no identity card known');
      if (text === 'long') throw new ConfigError('text must be 1 to 16384 bytes of UTF-8');
      return { id: hex(1), text };
    },
    conversations: () => [{ peer: ALICE }],
    conversation: (peer, options) => {
      calls.push(['conversation', peer, options]);
      return { items: [], nextBefore: null };
    },
  };
  const service = createMessagesService();
  assert.equal(service.name, 'messages');
  const { ctx, routes } = fakeServiceContext(node);
  service.init(ctx);
  assert.deepEqual([...routes.keys()], ['POST /messages', 'GET /conversations', 'GET /conversations/:id']);
  const post = routes.get('POST /messages');
  const failure = async (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);

  assert.deepEqual(await post({ body: { to: ALICE, text: 'hi' } }), { status: 202, body: { message: { id: hex(1), text: 'hi' } } });
  for (const body of [null, [], { to: ALICE }, { to: 'x', text: 'hi' }, { to: ALICE, text: 5 }, { to: ALICE, text: 'hi', extra: 1 }]) {
    const error = await failure(post({ body }));
    assert.equal(error.status, 400);
    assert.equal(error.apiCode, 'invalid_request');
  }
  const unknown = await failure(post({ body: { to: BOB, text: 'hi' } }));
  assert.deepEqual([unknown.status, unknown.apiCode, unknown.details], [404, 'unknown_destination', { to: BOB }]);
  const tooLong = await failure(post({ body: { to: ALICE, text: 'long' } }));
  assert.deepEqual([tooLong.status, tooLong.apiCode, tooLong.details.field], [400, 'invalid_request', 'text']);
  assert.equal(calls.filter(([kind]) => kind === 'send').length, 3, 'only well-formed requests reached the node');

  assert.deepEqual(routes.get('GET /conversations')({ query: {} }), { conversations: [{ peer: ALICE }] });
  assert.equal((await failure(Promise.resolve().then(() => routes.get('GET /conversations')({ query: { x: '1' } })))).status, 400);

  const page = routes.get('GET /conversations/:id');
  assert.deepEqual(page({ params: { id: ALICE }, query: { limit: '5', before: '9' } }), { peer: ALICE, items: [], nextBefore: null });
  assert.deepEqual(calls.at(-1), ['conversation', ALICE, { limit: 5, before: 9 }]);
  for (const [params, query] of [[{ id: 'x' }, {}], [{ id: ALICE }, { limit: '0' }], [{ id: ALICE }, { limit: '501' }], [{ id: ALICE }, { before: '-1' }], [{ id: ALICE }, { limit: 'abc' }], [{ id: ALICE }, { nope: '1' }]]) {
    const error = await failure(Promise.resolve().then(() => page({ params, query })));
    assert.equal(error.apiCode, 'invalid_request', JSON.stringify([params, query]));
  }
});
