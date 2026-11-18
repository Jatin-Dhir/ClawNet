/**
 * The phone's messenger on its own (web/core/messenger.js): the limits a hostile or
 * careless sender runs into. Sending and receiving through a real node are covered by
 * test/integration/phone.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PacketType } from '../../src/core/wire/types.js';
import { toHex, utf8 } from '../../web/core/bytes.js';
import { decodePacket } from '../../web/core/codec.js';
import { sealMessage } from '../../web/core/envelope.js';
import { Identity, verifyCard } from '../../web/core/identity.js';
import { Messenger } from '../../web/core/messenger.js';
import { randomBytes } from '../../web/core/primitives.js';
import { createStorage } from '../../web/core/storage.js';

function setup({ settings = {}, storage = createStorage(null) } = {}) {
  let now = 1_800_000_000_000;
  const phone = Identity.generate();
  const sent = [];
  const events = [];
  const remembered = [];
  const messenger = new Messenger({
    identity: phone,
    storage,
    cardOf: () => null,
    remember: (card) => remembered.push(card.id),
    transmit: (packet) => {
      sent.push(decodePacket(packet));
      return true;
    },
    emit: (type, data) => events.push({ type, ...data }),
    now: () => now,
    settings,
  });
  const e2e = verifyCard(phone.card).e2ePublicKey;
  /** A DATA packet with a chat message from `sender` to the phone. */
  const message = (sender, text, id = toHex(randomBytes(16))) => ({
    type: PacketType.DATA,
    header: { id, dst: phone.nodeId, ttl: 16, try: 0 },
    body: sealMessage({ sender, recipientE2eKey: e2e, dst: phone.nodeId, id, meta: { kind: 'msg', ack: true }, content: utf8(text), now }),
  });
  const tick = (ms) => {
    now += ms;
  };
  return { messenger, sent, events, remembered, message, tick };
}

test('the least recent conversation gives way when there are too many, never the one just written to', () => {
  const { messenger, message, tick } = setup({ settings: { maxChats: 2 } });
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  for (const sender of [a, b, c]) {
    messenger.handleData(message(sender, `hello from ${sender.nodeId.slice(0, 4)}`));
    tick(1000);
  }
  assert.deepEqual(messenger.conversations().map((x) => x.peer), [c.nodeId, b.nodeId]);
  messenger.handleData(message(a, 'back again'));
  assert.deepEqual(messenger.conversations().map((x) => x.peer), [a.nodeId, c.nodeId]);
});

test('stored conversations stay within their size budget; the newest message always stays', () => {
  const { messenger, message, tick } = setup({ settings: { chatBytesMax: 3000 } });
  const sender = Identity.generate();
  const other = Identity.generate();
  messenger.handleData(message(other, 'x'.repeat(500)));
  tick(1000);
  for (let i = 0; i < 20; i += 1) {
    messenger.handleData(message(sender, `${i}:${'y'.repeat(500)}`));
    tick(10);
  }
  // The other conversation went first, then this one's oldest messages.
  assert.equal(messenger.messages(other.nodeId).length, 0);
  const kept = messenger.messages(sender.nodeId);
  assert.ok(kept.length >= 1 && kept.length < 20, `kept ${kept.length}`);
  assert.ok(kept.at(-1).text.startsWith('19:'));
  const size = kept.reduce((sum, m) => sum + m.text.length + 200, 0);
  assert.ok(size <= 3000, `about ${size} characters stored`);
});

test('messages beyond the opening allowance are dropped, and accepted again once it refills', () => {
  const { messenger, message, tick } = setup({ settings: { inboundBurst: 5, inboundPerSecond: 1 } });
  const sender = Identity.generate();
  for (let i = 0; i < 8; i += 1) messenger.handleData(message(sender, `burst ${i}`));
  assert.equal(messenger.stats.received, 5);
  assert.equal(messenger.stats.rateLimited, 3);
  tick(2000);
  messenger.handleData(message(sender, 'later 1'));
  messenger.handleData(message(sender, 'later 2'));
  messenger.handleData(message(sender, 'later 3'));
  assert.equal(messenger.stats.received, 7);
  assert.equal(messenger.stats.rateLimited, 4);
});

test('a message still in its conversation is not shown twice, though the replay cache let it go', () => {
  const { messenger, message, sent, tick } = setup({ settings: { seenMaxEntries: 1 } });
  const sender = Identity.generate();
  const first = message(sender, 'only once');
  messenger.handleData(first);
  tick(1000);
  messenger.handleData(message(sender, 'second'));
  messenger.handleData(message(sender, 'third'));
  const acksBefore = sent.length;
  tick(5000);
  messenger.handleData(first);
  const copies = messenger.messages(sender.nodeId).filter((m) => m.id === first.header.id);
  assert.equal(copies.length, 1);
  assert.equal(messenger.stats.duplicates, 1);
  // The duplicate is acknowledged again, so a sender that missed the ack stops retrying.
  assert.equal(sent.length, acksBefore + 1);
});

test('the cards of nodes the phone hears from are handed over to be remembered', () => {
  const { messenger, message, remembered } = setup();
  const sender = Identity.generate();
  messenger.handleData(message(sender, 'hi'));
  assert.deepEqual(remembered, [sender.nodeId]);
});

test('a write the browser refuses is counted and reported; the message stays in memory', () => {
  const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  const { messenger, message, events } = setup({ storage: createStorage(refusing) });
  const sender = Identity.generate();
  messenger.handleData(message(sender, 'kept in memory'));
  assert.ok(messenger.stats.storageFailures >= 1);
  assert.ok(events.some((e) => e.type === 'storage-failed'));
  assert.equal(messenger.messages(sender.nodeId)[0].text, 'kept in memory');
});
