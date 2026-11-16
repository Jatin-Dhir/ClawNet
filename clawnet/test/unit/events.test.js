import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventBus,
  LISTENER_ERROR_EVENT,
  WILDCARD,
  MAX_EVENT_DEPTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENT_VALUES,
  MAX_EVENT_TEXT,
} from '../../src/core/events.js';
import { ClawNetError, ConfigError, StateError } from '../../src/core/errors.js';

/** A clock that advances by one millisecond per reading, starting at `start`. */
function tickingClock(start = 1000) {
  let t = start;
  return () => t++;
}

function isInvalidArgument(pattern) {
  return (err) => {
    assert.ok(err instanceof ClawNetError, `expected ClawNetError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'ERR_INVALID_ARGUMENT');
    assert.match(err.message, pattern);
    return true;
  };
}

/** Let promise reactions that are already scheduled run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('emit returns numbered, timestamped events starting at 1', () => {
  const bus = new EventBus({ now: tickingClock(5000) });
  assert.equal(bus.lastSeq, 0);
  const first = bus.emit('peer.connected', { id: 'a' });
  const second = bus.emit('peer.disconnected', { id: 'a', reason: 'timeout' });
  assert.deepEqual(first, { seq: 1, ts: 5000, type: 'peer.connected', data: { id: 'a' } });
  assert.deepEqual(second, {
    seq: 2,
    ts: 5001,
    type: 'peer.disconnected',
    data: { id: 'a', reason: 'timeout' },
  });
  assert.equal(bus.lastSeq, 2);
  for (let i = 3; i <= 500; i += 1) assert.equal(bus.emit('tick').seq, i);
  assert.equal(bus.lastSeq, 500);
});

test('the default clock is Date.now', () => {
  const bus = new EventBus();
  const before = Date.now();
  const { ts } = bus.emit('x');
  assert.ok(ts >= before && ts <= Date.now());
});

test('omitted data is stored as null', () => {
  const bus = new EventBus({ now: () => 0 });
  assert.equal(bus.emit('a').data, null);
  assert.equal(bus.emit('a', undefined).data, null);
  assert.equal(bus.emit('a', null).data, null);
  assert.equal(bus.emit('a', 0).data, 0);
  assert.equal(bus.emit('a', '').data, '');
  assert.equal(bus.emit('a', false).data, false);
});

test('events and their data are frozen copies, isolated from the emitter', () => {
  const bus = new EventBus({ now: () => 0 });
  const original = { peer: 'a', links: [{ cost: 1 }], nested: { deep: { n: 1 } } };
  const event = bus.emit('routes.changed', original);

  assert.notEqual(event.data, original);
  assert.deepEqual(event.data, original);
  original.peer = 'changed';
  original.links[0].cost = 99;
  original.links.push({ cost: 2 });
  original.nested.deep.n = 2;
  assert.deepEqual(event.data, { peer: 'a', links: [{ cost: 1 }], nested: { deep: { n: 1 } } });
  assert.deepEqual(bus.recent()[0].data, { peer: 'a', links: [{ cost: 1 }], nested: { deep: { n: 1 } } });

  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.data));
  assert.ok(Object.isFrozen(event.data.links));
  assert.ok(Object.isFrozen(event.data.links[0]));
  assert.ok(Object.isFrozen(event.data.nested.deep));
  assert.throws(() => {
    event.seq = 9;
  }, TypeError);
  assert.throws(() => {
    event.data.links.push(1);
  }, TypeError);
});

test('a listener cannot alter what later listeners or the buffer see', () => {
  const bus = new EventBus({ now: () => 0 });
  const seen = [];
  bus.on('x', (event) => {
    assert.throws(() => {
      event.data.value = 'tampered';
    }, TypeError);
  });
  bus.on('x', (event) => seen.push(event.data.value));
  bus.emit('x', { value: 'original' });
  assert.deepEqual(seen, ['original']);
  // The first listener's assert.throws passed, so no listener error was recorded.
  assert.deepEqual(bus.recent().map((e) => e.type), ['x']);
});

test('event data follows JSON rules for undefined', () => {
  const bus = new EventBus({ now: () => 0 });
  const event = bus.emit('x', { a: undefined, b: [1, undefined, 3], c: { d: undefined } });
  assert.deepEqual(event.data, { b: [1, null, 3], c: {} });
  assert.deepEqual(Object.keys(event.data), ['b', 'c']);
  assert.deepEqual(event.data, JSON.parse(JSON.stringify({ a: undefined, b: [1, undefined, 3], c: { d: undefined } })));
});

test('events survive a JSON round trip unchanged', () => {
  const bus = new EventBus({ now: () => 1763251200000 });
  const data = {
    text: 'h' + String.fromCodePoint(0xe9) + 'llo ' + String.fromCodePoint(0x1f600),
    n: -12.5,
    big: Number.MAX_SAFE_INTEGER,
    list: [true, false, null, 'x', 0, [], {}],
    empty: {},
  };
  const event = bus.emit('message.received', data);
  assert.deepEqual(JSON.parse(JSON.stringify(event)), {
    seq: 1,
    ts: 1763251200000,
    type: 'message.received',
    data,
  });
});

test('emit rejects data that is not plain JSON and names where', () => {
  const bus = new EventBus({ now: () => 0 });
  const circular = { name: 'loop' };
  circular.self = circular;
  const circularArray = [];
  circularArray.push([circularArray]);
  const cases = [
    [() => {}, /the value is a function/],
    [10n, /the value is a bigint/],
    [Symbol('s'), /the value is a symbol/],
    [NaN, /the value is a non-finite number/],
    [{ rtt: Infinity }, /\.rtt is a non-finite number/],
    [{ peer: { socket: new Map() } }, /\.peer\.socket is an instance of Map/],
    [{ at: new Date(0) }, /\.at is an instance of Date/],
    [{ key: Buffer.alloc(4) }, /\.key is an instance of Buffer/],
    [{ err: new Error('x') }, /\.err is an instance of Error/],
    [[1, [2, () => {}]], /\[1\]\[1\] is a function/],
    [{ list: [{ id: 10n }] }, /\.list\[0\]\.id is a bigint/],
    [{ toJSON: () => 'x' }, /\.toJSON is a function/],
    [circular, /\.self is a circular reference/],
    [circularArray, /\[0\]\[0\] is a circular reference/],
    [new (class Peer {})(), /the value is an instance of Peer/],
  ];
  for (const [data, pattern] of cases) {
    assert.throws(() => bus.emit('x', data), isInvalidArgument(pattern), String(pattern));
  }
  // A refused emit leaves no trace: no sequence number, nothing buffered.
  assert.equal(bus.lastSeq, 0);
  assert.deepEqual(bus.recent(), []);
});

test('a refused emit is not delivered to listeners', () => {
  const bus = new EventBus({ now: () => 0 });
  let calls = 0;
  bus.on(WILDCARD, () => {
    calls += 1;
  });
  assert.throws(() => bus.emit('x', { f: () => {} }), isInvalidArgument(/function/));
  assert.equal(calls, 0);
  assert.equal(bus.emit('x', { ok: true }).seq, 1);
  assert.equal(calls, 1);
});

test('the same object may appear twice in event data when it is not a cycle', () => {
  const bus = new EventBus({ now: () => 0 });
  const shared = { n: 1 };
  const event = bus.emit('x', { a: shared, b: shared, list: [shared, shared] });
  assert.deepEqual(event.data, { a: { n: 1 }, b: { n: 1 }, list: [{ n: 1 }, { n: 1 }] });
});

test('event data depth and size are bounded', () => {
  const bus = new EventBus({ now: () => 0 });
  const nest = (depth) => {
    let value = 1;
    for (let i = 0; i < depth; i += 1) value = { k: value };
    return value;
  };
  assert.equal(bus.emit('x', nest(MAX_EVENT_DEPTH)).seq, 1);
  assert.throws(() => bus.emit('x', nest(MAX_EVENT_DEPTH + 1)), isInvalidArgument(/nests deeper than 16 levels/));

  // The array itself is one value, so MAX - 1 items fit and MAX items do not.
  assert.equal(bus.emit('x', new Array(MAX_EVENT_VALUES - 1).fill(0)).seq, 2);
  assert.throws(
    () => bus.emit('x', new Array(MAX_EVENT_VALUES).fill(0)),
    isInvalidArgument(/more than 65536 values/),
  );

  // Shared references that would expand to 2^40 values are stopped by the same bound.
  let diamond = { leaf: true };
  for (let i = 0; i < 14; i += 1) diamond = { a: diamond, b: diamond, c: diamond, d: diamond, e: diamond, f: diamond, g: diamond };
  assert.throws(() => bus.emit('x', diamond), isInvalidArgument(/more than 65536 values/));
  assert.equal(bus.lastSeq, 2);
});

test('a "__proto__" key in event data is kept as data', () => {
  const bus = new EventBus({ now: () => 0 });
  const data = JSON.parse('{"__proto__":{"admin":true},"a":1}');
  const event = bus.emit('x', data);
  assert.deepEqual(Object.keys(event.data), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(event.data), Object.prototype);
  assert.equal(event.data.admin, undefined);
  assert.equal(JSON.stringify(event.data), '{"__proto__":{"admin":true},"a":1}');
});

test('emit rejects invalid event types', () => {
  const bus = new EventBus({ now: () => 0 });
  for (const type of [undefined, null, '', 5, ['x'], {}, 'x'.repeat(MAX_EVENT_TYPE_LENGTH + 1)]) {
    assert.throws(() => bus.emit(type, {}), isInvalidArgument(/event type must be a string of 1 to 128/));
  }
  assert.throws(() => bus.emit(WILDCARD, {}), isInvalidArgument(/must not be "\*"/));
  assert.equal(bus.emit('x'.repeat(MAX_EVENT_TYPE_LENGTH)).seq, 1);
  assert.equal(bus.lastSeq, 1);
});

test('on delivers matching events and the unsubscribe function stops delivery', () => {
  const bus = new EventBus({ now: () => 0 });
  const seen = [];
  const off = bus.on('a', (event) => seen.push(event.seq));
  assert.equal(typeof off, 'function');
  bus.emit('a');
  bus.emit('b');
  bus.emit('a');
  assert.deepEqual(seen, [1, 3]);
  assert.equal(bus.listenerCount('a'), 1);

  off();
  bus.emit('a');
  assert.deepEqual(seen, [1, 3]);
  assert.equal(bus.listenerCount('a'), 0);
  // Unsubscribing twice must not remove some other subscription or throw.
  const other = [];
  bus.on('a', (event) => other.push(event.seq));
  off();
  bus.emit('a');
  assert.deepEqual(other, [5]);
});

test('listeners receive the same frozen event object that emit returns', () => {
  const bus = new EventBus({ now: () => 0 });
  const received = [];
  bus.on('a', (event) => received.push(event));
  bus.on(WILDCARD, (event) => received.push(event));
  const event = bus.emit('a', { n: 1 });
  assert.equal(received.length, 2);
  assert.equal(received[0], event);
  assert.equal(received[1], event);
  assert.equal(bus.recent()[0], event);
});

test('wildcard listeners see every event, after the listeners for the exact type', () => {
  const bus = new EventBus({ now: () => 0 });
  const order = [];
  bus.on(WILDCARD, (event) => order.push(`*1:${event.type}`));
  bus.on('a', () => order.push('a1'));
  bus.on(WILDCARD, (event) => order.push(`*2:${event.type}`));
  bus.on('a', () => order.push('a2'));
  bus.emit('a');
  bus.emit('b');
  assert.deepEqual(order, ['a1', 'a2', '*1:a', '*2:a', '*1:b', '*2:b']);
});

test('the same function subscribed twice is called twice and unsubscribed independently', () => {
  const bus = new EventBus({ now: () => 0 });
  let calls = 0;
  const listener = () => {
    calls += 1;
  };
  const offFirst = bus.on('a', listener);
  bus.on('a', listener);
  assert.equal(bus.listenerCount('a'), 2);
  bus.emit('a');
  assert.equal(calls, 2);
  offFirst();
  bus.emit('a');
  assert.equal(calls, 3);
});

test('once delivers a single event and can be cancelled beforehand', () => {
  const bus = new EventBus({ now: () => 0 });
  const seen = [];
  bus.once('a', (event) => seen.push(event.seq));
  assert.equal(bus.listenerCount('a'), 1);
  bus.emit('b');
  bus.emit('a');
  bus.emit('a');
  assert.deepEqual(seen, [2]);
  assert.equal(bus.listenerCount('a'), 0);

  const cancelled = [];
  const off = bus.once('a', (event) => cancelled.push(event.seq));
  off();
  bus.emit('a');
  assert.deepEqual(cancelled, []);

  const any = [];
  bus.once(WILDCARD, (event) => any.push(event.type));
  bus.emit('first');
  bus.emit('second');
  assert.deepEqual(any, ['first']);
  assert.equal(bus.listenerCount(), 0);
});

test('a once listener that emits its own event type is not called again', () => {
  const bus = new EventBus({ now: () => 0 });
  let calls = 0;
  bus.once('a', () => {
    calls += 1;
    bus.emit('a');
  });
  bus.emit('a');
  assert.equal(calls, 1);
  assert.equal(bus.lastSeq, 2);
});

test('a once listener that throws is still removed and its failure is reported', () => {
  const bus = new EventBus({ now: () => 0 });
  bus.once('a', () => {
    throw new Error('first and last');
  });
  bus.emit('a');
  bus.emit('a');
  assert.equal(bus.listenerCount('a'), 0);
  assert.deepEqual(bus.recent().map((e) => e.type), ['a', LISTENER_ERROR_EVENT, 'a']);
});

test('listenerCount counts per type, for the wildcard, and in total', () => {
  const bus = new EventBus({ now: () => 0 });
  assert.equal(bus.listenerCount(), 0);
  assert.equal(bus.listenerCount('a'), 0);
  const offA = bus.on('a', () => {});
  bus.on('a', () => {});
  bus.on('b', () => {});
  const offAny = bus.on(WILDCARD, () => {});
  bus.once('c', () => {});
  assert.equal(bus.listenerCount('a'), 2);
  assert.equal(bus.listenerCount('b'), 1);
  assert.equal(bus.listenerCount('c'), 1);
  assert.equal(bus.listenerCount(WILDCARD), 1);
  assert.equal(bus.listenerCount('unknown'), 0);
  assert.equal(bus.listenerCount(), 5);
  offA();
  offAny();
  bus.emit('c');
  assert.equal(bus.listenerCount('a'), 1);
  assert.equal(bus.listenerCount(WILDCARD), 0);
  assert.equal(bus.listenerCount('c'), 0);
  assert.equal(bus.listenerCount(), 2);
});

test('on and once reject invalid types and listeners', () => {
  const bus = new EventBus({ now: () => 0 });
  for (const method of ['on', 'once']) {
    for (const type of [undefined, null, '', 7, 'x'.repeat(MAX_EVENT_TYPE_LENGTH + 1)]) {
      assert.throws(() => bus[method](type, () => {}), isInvalidArgument(/event type/), `${method} ${String(type)}`);
    }
    for (const listener of [undefined, null, 'fn', {}, 5]) {
      assert.throws(() => bus[method]('a', listener), isInvalidArgument(/listener must be a function/));
    }
  }
  assert.equal(bus.listenerCount(), 0);
});

test('a throwing listener does not stop other listeners or the emitter', () => {
  const bus = new EventBus({ now: tickingClock(100) });
  const seen = [];
  bus.on('a', () => seen.push('first'));
  bus.on('a', () => {
    throw new StateError('listener exploded');
  });
  bus.on('a', () => seen.push('third'));
  bus.on(WILDCARD, (event) => seen.push(`any:${event.type}`));

  const event = bus.emit('a', { n: 1 });
  assert.equal(event.seq, 1);
  assert.deepEqual(seen, ['first', 'third', 'any:a', `any:${LISTENER_ERROR_EVENT}`]);

  const [original, report] = bus.recent();
  assert.equal(original, event);
  assert.deepEqual(report, {
    seq: 2,
    ts: 101,
    type: LISTENER_ERROR_EVENT,
    data: {
      event: { seq: 1, type: 'a' },
      error: { name: 'StateError', code: 'ERR_STATE', message: 'listener exploded' },
    },
  });
  assert.ok(Object.isFrozen(report.data.error));

  // The bus keeps working afterwards and the broken listener is still subscribed.
  assert.equal(bus.emit('b').seq, 3);
  assert.equal(bus.emit('a').seq, 4);
  assert.equal(bus.lastSeq, 5);
  assert.equal(bus.recent().at(-1).data.event.seq, 4);
});

test('listener errors can be observed by subscribing to the error event', () => {
  const bus = new EventBus({ now: () => 0 });
  const reports = [];
  bus.on(LISTENER_ERROR_EVENT, (event) => reports.push(event.data));
  bus.on('a', () => {
    throw new TypeError('bad');
  });
  bus.emit('a');
  assert.deepEqual(reports, [
    { event: { seq: 1, type: 'a' }, error: { name: 'TypeError', code: null, message: 'bad' } },
  ]);
});

test('a listener that fails on the error event is not reported again', () => {
  const bus = new EventBus({ now: () => 0 });
  let errorListenerCalls = 0;
  bus.on(LISTENER_ERROR_EVENT, () => {
    errorListenerCalls += 1;
    throw new Error('the error handler is broken too');
  });
  bus.on('a', () => {
    throw new Error('original failure');
  });
  bus.emit('a');
  assert.equal(errorListenerCalls, 1);
  assert.deepEqual(bus.recent().map((e) => e.type), ['a', LISTENER_ERROR_EVENT]);
  assert.equal(bus.lastSeq, 2);
});

test('a wildcard listener that always throws produces one report per event, not a loop', () => {
  const bus = new EventBus({ now: () => 0 });
  let calls = 0;
  bus.on(WILDCARD, () => {
    calls += 1;
    throw new Error('always');
  });
  bus.emit('a');
  bus.emit('b');
  // Called for a, its report, b, its report. The failures on the reports are dropped.
  assert.equal(calls, 4);
  assert.deepEqual(bus.recent().map((e) => e.type), ['a', LISTENER_ERROR_EVENT, 'b', LISTENER_ERROR_EVENT]);
});

test('thrown values that are not errors are described safely', () => {
  const bus = new EventBus({ now: () => 0 });
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('no peeking');
      },
    },
  );
  const thrown = [
    'a string',
    42,
    null,
    undefined,
    { message: 7, name: 9, code: 11 },
    Object.assign(new Error('m'.repeat(5000)), { name: 'N'.repeat(5000), code: 'C'.repeat(5000) }),
    hostile,
  ];
  for (const value of thrown) {
    bus.once('a', () => {
      throw value;
    });
    bus.emit('a');
  }
  const errors = bus.recent({ types: [LISTENER_ERROR_EVENT] }).map((e) => e.data.error);
  assert.deepEqual(errors, [
    { name: 'Error', code: null, message: 'a string' },
    { name: 'Error', code: null, message: '42' },
    { name: 'Error', code: null, message: 'null' },
    { name: 'Error', code: null, message: 'undefined' },
    { name: 'Error', code: null, message: 'non-error object thrown' },
    { name: 'N'.repeat(256), code: 'C'.repeat(256), message: 'm'.repeat(256) },
    { name: 'Error', code: null, message: 'error could not be described' },
  ]);
});

test('a rejected promise from an async listener is reported, not left unhandled', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const bus = new EventBus({ now: () => 0 });
  const seen = [];
  bus.on('a', async () => {
    await null;
    throw new RangeError('async failure');
  });
  bus.on('a', async () => 'fine');
  bus.on(LISTENER_ERROR_EVENT, (event) => seen.push(event));

  bus.emit('a');
  assert.deepEqual(seen, [], 'the rejection has not happened yet');
  await settle();
  await settle();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data, {
    event: { seq: 1, type: 'a' },
    error: { name: 'RangeError', code: null, message: 'async failure' },
  });
  assert.equal(seen[0].seq, 2);
  assert.deepEqual(unhandled, []);
});

test('a thenable whose then throws is reported like any other failure', () => {
  const bus = new EventBus({ now: () => 0 });
  bus.on('a', () => ({
    then() {
      throw new Error('then is broken');
    },
  }));
  bus.emit('a');
  assert.equal(bus.recent().at(-1).data.error.message, 'then is broken');
});

test('events emitted from inside a listener are delivered in sequence order to everyone', () => {
  const bus = new EventBus({ now: () => 0 });
  const first = [];
  const second = [];
  bus.on(WILDCARD, (event) => {
    first.push(event.seq);
    if (event.type === 'outer') {
      const inner = bus.emit('inner');
      // Recorded at once, delivered after the current event.
      assert.equal(inner.seq, 2);
      assert.equal(bus.lastSeq, 2);
      assert.deepEqual(second, []);
    }
  });
  bus.on(WILDCARD, (event) => second.push(event.seq));
  bus.emit('outer');
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [1, 2]);
});

test('a long chain of emits from listeners does not grow the stack', () => {
  const bus = new EventBus({ capacity: 10, now: () => 0 });
  const total = 200000;
  let delivered = 0;
  bus.on('step', (event) => {
    delivered += 1;
    if (event.data.n < total) bus.emit('step', { n: event.data.n + 1 });
  });
  bus.emit('step', { n: 1 });
  assert.equal(delivered, total);
  assert.equal(bus.lastSeq, total);
  assert.equal(bus.recent().length, 10);
});

test('a burst of emits from one listener is delivered completely and in order', () => {
  const bus = new EventBus({ capacity: 5, now: () => 0 });
  const seen = [];
  bus.on('burst', () => {
    for (let i = 0; i < 5000; i += 1) bus.emit('item', { i });
  });
  bus.on('item', (event) => seen.push(event.data.i));
  bus.emit('burst');
  assert.equal(seen.length, 5000);
  assert.ok(seen.every((value, index) => value === index));
});

test('subscriptions changed during delivery take effect predictably', () => {
  const bus = new EventBus({ now: () => 0 });
  const calls = [];
  // The first listener must be subscribed before the one it removes exists.
  const off = {};
  bus.on('a', () => {
    calls.push('first');
    off.third();
    bus.on('a', () => calls.push('added'));
  });
  bus.on('a', () => calls.push('second'));
  off.third = bus.on('a', () => calls.push('third'));

  bus.emit('a');
  // "third" was removed before its turn; "added" joined too late for this event.
  assert.deepEqual(calls, ['first', 'second']);
  calls.length = 0;
  bus.emit('a');
  // The listener added during the first event runs now; the one "first" adds during
  // this event has to wait for the next.
  assert.deepEqual(calls, ['first', 'second', 'added']);
  assert.equal(bus.listenerCount('a'), 4);
});

test('recent returns everything in order while under capacity', () => {
  const bus = new EventBus({ capacity: 10, now: tickingClock(0) });
  assert.deepEqual(bus.recent(), []);
  assert.deepEqual(bus.recent({ sinceSeq: 0 }), []);
  for (let i = 1; i <= 4; i += 1) bus.emit('n', { i });
  assert.deepEqual(bus.recent().map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(bus.recent().map((e) => e.data.i), [1, 2, 3, 4]);
  assert.deepEqual(bus.recent({}).map((e) => e.ts), [0, 1, 2, 3]);
});

test('the ring buffer keeps only the newest capacity events', () => {
  const bus = new EventBus({ capacity: 5, now: () => 0 });
  for (let i = 1; i <= 5; i += 1) bus.emit('n', { i });
  assert.deepEqual(bus.recent().map((e) => e.seq), [1, 2, 3, 4, 5]);
  bus.emit('n', { i: 6 });
  assert.deepEqual(bus.recent().map((e) => e.seq), [2, 3, 4, 5, 6]);
  for (let i = 7; i <= 23; i += 1) bus.emit('n', { i });
  assert.deepEqual(bus.recent().map((e) => e.seq), [19, 20, 21, 22, 23]);
  assert.deepEqual(bus.recent().map((e) => e.data.i), [19, 20, 21, 22, 23]);
  assert.equal(bus.lastSeq, 23);

  const one = new EventBus({ capacity: 1, now: () => 0 });
  one.emit('a');
  one.emit('b');
  assert.deepEqual(one.recent().map((e) => e.type), ['b']);
});

test('recent with sinceSeq pages forward from the oldest matching event', () => {
  const bus = new EventBus({ capacity: 8, now: () => 0 });
  for (let i = 1; i <= 20; i += 1) bus.emit('n');
  // Buffer holds 13..20.
  assert.deepEqual(bus.recent({ sinceSeq: 17 }).map((e) => e.seq), [18, 19, 20]);
  assert.deepEqual(bus.recent({ sinceSeq: 19 }).map((e) => e.seq), [20]);
  assert.deepEqual(bus.recent({ sinceSeq: 20 }), []);
  assert.deepEqual(bus.recent({ sinceSeq: 5000 }), []);
  assert.deepEqual(bus.recent({ sinceSeq: Number.MAX_SAFE_INTEGER }), []);
  // Older than the buffer: starts at the oldest retained event, revealing the gap.
  assert.deepEqual(bus.recent({ sinceSeq: 3 }).map((e) => e.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(bus.recent({ sinceSeq: 0, limit: 3 }).map((e) => e.seq), [13, 14, 15]);
  assert.deepEqual(bus.recent({ sinceSeq: 15, limit: 2 }).map((e) => e.seq), [16, 17]);

  // Paging with the last seen seq visits every retained event exactly once.
  const paged = [];
  let cursor = 0;
  for (;;) {
    const page = bus.recent({ sinceSeq: cursor, limit: 3 });
    if (page.length === 0) break;
    paged.push(...page.map((e) => e.seq));
    cursor = page.at(-1).seq;
  }
  assert.deepEqual(paged, [13, 14, 15, 16, 17, 18, 19, 20]);
});

test('recent without sinceSeq returns the newest events, oldest first', () => {
  const bus = new EventBus({ capacity: 8, now: () => 0 });
  for (let i = 1; i <= 20; i += 1) bus.emit('n');
  assert.deepEqual(bus.recent({ limit: 3 }).map((e) => e.seq), [18, 19, 20]);
  assert.deepEqual(bus.recent({ limit: 1 }).map((e) => e.seq), [20]);
  assert.deepEqual(bus.recent({ limit: 0 }), []);
  assert.deepEqual(bus.recent({ limit: 8 }).map((e) => e.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
  // A limit above the capacity cannot return more than the buffer holds.
  assert.equal(bus.recent({ limit: 1000000 }).length, 8);
});

test('recent filters by exact type and applies the limit after filtering', () => {
  const bus = new EventBus({ capacity: 100, now: () => 0 });
  const types = ['peer.up', 'peer.down', 'route.changed', 'peer.up', 'msg.in', 'peer.up', 'route.changed'];
  for (const type of types) bus.emit(type);

  assert.deepEqual(bus.recent({ types: ['peer.up'] }).map((e) => e.seq), [1, 4, 6]);
  assert.deepEqual(bus.recent({ types: ['peer.up', 'msg.in'] }).map((e) => e.seq), [1, 4, 5, 6]);
  assert.deepEqual(bus.recent({ types: new Set(['route.changed']) }).map((e) => e.seq), [3, 7]);
  assert.deepEqual(bus.recent({ types: [] }), []);
  assert.deepEqual(bus.recent({ types: ['peer'] }), [], 'no prefix matching');
  assert.deepEqual(bus.recent({ types: ['peer.up'], limit: 2 }).map((e) => e.seq), [4, 6]);
  assert.deepEqual(bus.recent({ types: ['peer.up'], limit: 2, sinceSeq: 0 }).map((e) => e.seq), [1, 4]);
  assert.deepEqual(bus.recent({ types: ['peer.up'], sinceSeq: 4 }).map((e) => e.seq), [6]);
  assert.deepEqual(bus.recent({ types: ['toString', 'constructor'] }), []);
});

test('recent returns a fresh array each time', () => {
  const bus = new EventBus({ now: () => 0 });
  bus.emit('a');
  const first = bus.recent();
  first.length = 0;
  first.push('junk');
  assert.deepEqual(bus.recent().map((e) => e.type), ['a']);
});

test('recent rejects malformed queries', () => {
  const bus = new EventBus({ now: () => 0 });
  bus.emit('a');
  const cases = [
    [null, /options object/],
    ['a', /options object/],
    [5, /options object/],
    [{ sinceSeq: -1 }, /sinceSeq/],
    [{ sinceSeq: 1.5 }, /sinceSeq/],
    [{ sinceSeq: '1' }, /sinceSeq/],
    [{ sinceSeq: NaN }, /sinceSeq/],
    [{ sinceSeq: null }, /sinceSeq/],
    [{ limit: -1 }, /limit/],
    [{ limit: 2.5 }, /limit/],
    [{ limit: '10' }, /limit/],
    [{ limit: Infinity }, /limit/],
    [{ types: 'a' }, /types must be an array or set/],
    [{ types: null }, /types must be an array or set/],
    [{ types: 7 }, /types must be an array or set/],
    [{ types: { a: true } }, /types must be an array or set/],
    [{ types: ['a', 5] }, /only strings/],
    [{ types: Array.from({ length: 1025 }, (_, i) => `t${i}`) }, /at most 1024/],
  ];
  for (const [query, pattern] of cases) {
    assert.throws(() => bus.recent(query), isInvalidArgument(pattern), JSON.stringify(query));
  }
  assert.equal(bus.recent({ types: Array.from({ length: 1024 }, (_, i) => `t${i}`) }).length, 0);
});

test('recent stops reading an endless types iterable that repeats one name', () => {
  const bus = new EventBus({ now: () => 0 });
  bus.emit('a');
  let pulled = 0;
  const endless = {
    *[Symbol.iterator]() {
      for (;;) {
        pulled += 1;
        yield 'a';
      }
    },
  };
  assert.throws(() => bus.recent({ types: endless }), isInvalidArgument(/at most 1024/));
  assert.equal(pulled, 1025);
  // Duplicates within the limit are still fine.
  assert.equal(bus.recent({ types: new Array(1024).fill('a') }).length, 1);
  assert.throws(() => bus.recent({ types: new Array(1025).fill('a') }), isInvalidArgument(/at most 1024/));
});

test('event text is bounded, counting keys and strings together', () => {
  const bus = new EventBus({ now: () => 0 });
  assert.equal(MAX_EVENT_TEXT, 1048576);
  assert.equal(bus.emit('x', 'x'.repeat(MAX_EVENT_TEXT)).seq, 1);
  assert.throws(() => bus.emit('x', 'x'.repeat(MAX_EVENT_TEXT + 1)), isInvalidArgument(/more than 1048576 characters/));
  // A few values with long strings would otherwise pin gigabytes in the ring buffer.
  const big = 'y'.repeat(600 * 1024);
  assert.throws(() => bus.emit('x', { a: big, b: big }), isInvalidArgument(/characters of text/));
  assert.throws(() => bus.emit('x', { [big]: 1, [`${big}z`]: 2 }), isInvalidArgument(/characters of text/));
  // The same string referenced many times is charged each time, as JSON would repeat it.
  const shared = 'z'.repeat(100 * 1024);
  assert.throws(() => bus.emit('x', new Array(11).fill(shared)), isInvalidArgument(/characters of text/));
  assert.equal(bus.lastSeq, 1);
});

test('a sparse array claiming a huge length is refused before anything is allocated', () => {
  const bus = new EventBus({ now: () => 0 });
  const sparse = [];
  sparse.length = 2 ** 32 - 1;
  const started = process.hrtime.bigint();
  assert.throws(() => bus.emit('x', sparse), isInvalidArgument(/more than 65536 values/));
  assert.throws(() => bus.emit('x', { list: new Array(MAX_EVENT_VALUES) }), isInvalidArgument(/more than 65536 values/));
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000);
  assert.equal(bus.lastSeq, 0);
});

test('data whose getters or proxies throw is refused with the documented error', () => {
  const bus = new EventBus({ now: () => 0 });
  const getter = {};
  Object.defineProperty(getter, 'a', {
    enumerable: true,
    get() {
      throw new TypeError('boom');
    },
  });
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new RangeError('boom');
    },
  });
  for (const data of [getter, { nested: [getter] }, proxy]) {
    assert.throws(
      () => bus.emit('x', data),
      (err) => isInvalidArgument(/could not be read/)(err) && err.cause instanceof Error,
    );
  }
  assert.equal(bus.lastSeq, 0, 'nothing was recorded');
});

test('the constructor rejects invalid options', () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, '10', null, 1000001]) {
    assert.throws(
      () => new EventBus({ capacity }),
      (err) => err instanceof ConfigError && err.code === 'ERR_CONFIG' && /capacity/.test(err.message),
      String(capacity),
    );
  }
  for (const now of [null, 5, 'now', {}]) {
    assert.throws(() => new EventBus({ now }), (err) => err instanceof ConfigError && /clock/.test(err.message));
  }
  assert.doesNotThrow(() => new EventBus());
  assert.doesNotThrow(() => new EventBus({}));
  assert.doesNotThrow(() => new EventBus({ capacity: 1 }));
});

test('a clock that throws does not consume a sequence number', () => {
  let broken = true;
  const bus = new EventBus({
    now: () => {
      if (broken) throw new Error('clock failure');
      return 7;
    },
  });
  assert.throws(() => bus.emit('a'), /clock failure/);
  assert.equal(bus.lastSeq, 0);
  assert.deepEqual(bus.recent(), []);
  broken = false;
  assert.deepEqual(bus.emit('a'), { seq: 1, ts: 7, type: 'a', data: null });
});

test('a clock failure while reporting a listener error does not escape from emit', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  let clockBroken = false;
  const bus = new EventBus({
    now: () => {
      if (clockBroken) throw new Error('clock failure');
      return 0;
    },
  });
  bus.on('sync', () => {
    clockBroken = true;
    throw new Error('listener failure');
  });
  bus.on('async', async () => {
    clockBroken = true;
    throw new Error('async listener failure');
  });

  // The listener fails, then the report cannot be timestamped: emit still returns.
  assert.equal(bus.emit('sync').seq, 1);
  assert.equal(bus.lastSeq, 1);

  clockBroken = false;
  assert.equal(bus.emit('async').seq, 2);
  await settle();
  assert.deepEqual(unhandled, []);
  assert.equal(bus.lastSeq, 2);

  clockBroken = false;
  assert.equal(bus.emit('other').seq, 3);
});

test('the default capacity is 2000 events', () => {
  const bus = new EventBus({ now: () => 0 });
  for (let i = 0; i < 2500; i += 1) bus.emit('n');
  const events = bus.recent();
  assert.equal(events.length, 2000);
  assert.equal(events[0].seq, 501);
  assert.equal(events.at(-1).seq, 2500);
});
