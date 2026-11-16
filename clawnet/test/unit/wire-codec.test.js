import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodePacket,
  decodePacket,
  encodeFrame,
  FrameDecoder,
  PACKET_PREFIX_BYTES,
  FRAME_PREFIX_BYTES,
  PacketKind,
  packetKind,
  sendLimit,
  assertSendable,
} from '../../src/core/wire/codec.js';
import { WireError } from '../../src/core/errors.js';
import { Limits, PacketType } from '../../src/core/wire/types.js';

const DST = 'a'.repeat(52);
const ID = '0123456789abcdef0123456789abcdef';

/** Build raw packet bytes by hand so that decoder tests do not depend on the encoder. */
function rawPacket(type, flags, headerText, body = Buffer.alloc(0), declaredHeaderLength) {
  const header = Buffer.from(headerText, 'utf8');
  const prefix = Buffer.alloc(PACKET_PREFIX_BYTES);
  prefix[0] = type;
  prefix[1] = flags;
  prefix.writeUInt16BE(declaredHeaderLength ?? header.length, 2);
  return Buffer.concat([prefix, header, body]);
}

function isWireError(pattern) {
  return (err) => {
    assert.ok(err instanceof WireError, `expected WireError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'ERR_WIRE');
    assert.match(err.message, pattern);
    return true;
  };
}

test('encodePacket writes type, zero flags, header length, canonical header and body', () => {
  const body = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const packet = encodePacket({
    type: PacketType.DATA,
    header: { ttl: 16, id: ID, try: 0, dst: DST },
    body,
  });
  // Keys in byte order: "try" sorts before "ttl".
  const headerText = `{"dst":"${DST}","id":"${ID}","try":0,"ttl":16}`;
  const expected = Buffer.concat([
    Buffer.from([32, 0, 0, headerText.length]),
    Buffer.from(headerText, 'utf8'),
    body,
  ]);
  assert.deepEqual(packet, expected);
});

test('encodePacket without a body produces an empty body', () => {
  const packet = encodePacket({ type: PacketType.PING, header: { n: 7 } });
  assert.deepEqual(packet, Buffer.from([1, 0, 0, 7, ...Buffer.from('{"n":7}')]));
  const decoded = decodePacket(packet);
  assert.equal(decoded.body.length, 0);
  assert.ok(Buffer.isBuffer(decoded.body));
});

test('decodePacket round-trips every packet type', () => {
  for (const [name, type] of Object.entries(PacketType)) {
    const body = Buffer.from(`body of ${name}`);
    const decoded = decodePacket(encodePacket({ type, header: { k: name, n: type }, body }));
    assert.equal(decoded.type, type, name);
    assert.equal(decoded.flags, 0, name);
    assert.deepEqual(decoded.header, { k: name, n: type }, name);
    assert.deepEqual(decoded.body, body, name);
  }
});

test('decodePacket returns the body as a view into the input, not a copy', () => {
  const packet = encodePacket({ type: PacketType.DATA, header: {}, body: Buffer.from('hello') });
  const { body } = decodePacket(packet);
  assert.equal(body.buffer, packet.buffer);
  assert.equal(body.byteOffset, packet.byteOffset + PACKET_PREFIX_BYTES + 2);
  packet[packet.length - 1] = 0x21;
  assert.equal(body.toString('latin1'), 'hell!');
});

test('decodePacket accepts a plain Uint8Array at a non-zero offset without copying', () => {
  const packet = encodePacket({ type: PacketType.PONG, header: { n: 1 }, body: Buffer.from([9, 8, 7]) });
  const backing = new Uint8Array(packet.length + 10);
  backing.set(packet, 5);
  const view = backing.subarray(5, 5 + packet.length);
  const decoded = decodePacket(view);
  assert.deepEqual(decoded.header, { n: 1 });
  assert.ok(Buffer.isBuffer(decoded.body));
  assert.deepEqual([...decoded.body], [9, 8, 7]);
  assert.equal(decoded.body.buffer, backing.buffer);
});

test('decodePacket rejects truncated input', () => {
  for (const length of [0, 1, 2, 3]) {
    assert.throws(() => decodePacket(Buffer.alloc(length, 1)), isWireError(/truncated/), `length ${length}`);
  }
  const full = rawPacket(PacketType.PING, 0, '{"n":1}');
  for (let length = PACKET_PREFIX_BYTES; length < full.length; length += 1) {
    assert.throws(() => decodePacket(full.subarray(0, length)), isWireError(/truncated/), `length ${length}`);
  }
  assert.throws(
    () => decodePacket(rawPacket(PacketType.PING, 0, '{}', Buffer.alloc(0), 3)),
    isWireError(/truncated/),
  );
});

test('decodePacket rejects unknown packet types', () => {
  const known = new Set(Object.values(PacketType));
  for (let type = 0; type < 256; type += 1) {
    const packet = rawPacket(type, 0, '{}');
    if (known.has(type)) {
      assert.equal(decodePacket(packet).type, type);
    } else {
      assert.throws(() => decodePacket(packet), isWireError(/unknown packet type/), `type ${type}`);
    }
  }
});

test('decodePacket rejects every non-zero flags value', () => {
  for (let flags = 1; flags < 256; flags += 1) {
    assert.throws(
      () => decodePacket(rawPacket(PacketType.PING, flags, '{}')),
      isWireError(/flags/),
      `flags ${flags}`,
    );
  }
});

test('decodePacket rejects headers that are not strictly canonical', () => {
  const bad = {
    'empty header': '',
    'whitespace': '{ "a":1}',
    'trailing newline': '{"a":1}\n',
    'unsorted keys': '{"b":1,"a":2}',
    'duplicate keys': '{"a":1,"a":1}',
    'float': '{"a":1.5}',
    'exponent': '{"a":1e3}',
    'negative zero': '{"a":-0}',
    // A JSON unicode escape for the letter A, built without writing the escape here.
    'non-minimal escape': `{"a":"${String.fromCodePoint(0x5c)}u0041"}`,
    'not json': '{"a":',
    'trailing garbage': '{"a":1}x',
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(
      () => decodePacket(rawPacket(PacketType.PING, 0, text)),
      isWireError(/not canonical JSON/),
      name,
    );
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from([PacketType.PING, 0, 0, 7]),
    Buffer.from('{"a":"', 'latin1'),
    Buffer.from([0xff]),
  ]);
  assert.throws(() => decodePacket(invalidUtf8), isWireError(/not canonical JSON/));
});

test('decodePacket keeps the canonical parser error as the cause', () => {
  assert.throws(
    () => decodePacket(rawPacket(PacketType.PING, 0, '{"b":1,"a":2}')),
    (err) => err instanceof WireError && err.cause?.code === 'ERR_CANONICAL',
  );
});

test('decodePacket rejects canonical headers that are not objects', () => {
  for (const text of ['[]', '[1,2]', 'null', 'true', '1', '"x"']) {
    assert.throws(
      () => decodePacket(rawPacket(PacketType.PING, 0, text)),
      isWireError(/must be a JSON object/),
      text,
    );
  }
});

test('header size limit is enforced exactly on both sides', () => {
  // {"p":"<padding>"} is 8 bytes of syntax around the padding.
  const fits = { p: 'x'.repeat(Limits.MAX_HEADER - 8) };
  const tooBig = { p: 'x'.repeat(Limits.MAX_HEADER - 7) };

  const packet = encodePacket({ type: PacketType.GOSSIP, header: fits });
  assert.equal(packet.readUInt16BE(2), Limits.MAX_HEADER);
  assert.deepEqual(decodePacket(packet).header, fits);

  assert.throws(() => encodePacket({ type: PacketType.GOSSIP, header: tooBig }), isWireError(/header is 8193 bytes/));

  const oversized = rawPacket(PacketType.GOSSIP, 0, JSON.stringify(tooBig));
  assert.equal(oversized.readUInt16BE(2), Limits.MAX_HEADER + 1);
  assert.throws(() => decodePacket(oversized), isWireError(/header is 8193 bytes/));
});

test('a declared header length over the limit is rejected before the header is parsed', () => {
  // The header bytes are not JSON at all; the size check must fire first.
  const packet = Buffer.alloc(PACKET_PREFIX_BYTES + 0xffff, 0x00);
  packet[0] = PacketType.PING;
  packet.writeUInt16BE(0xffff, 2);
  assert.throws(() => decodePacket(packet), isWireError(/header is 65535 bytes/));
});

test('packet size limit is enforced exactly on both sides', () => {
  const header = {};
  const maxBody = Limits.MAX_PACKET - PACKET_PREFIX_BYTES - 2;

  const packet = encodePacket({ type: PacketType.DATA, header, body: Buffer.alloc(maxBody, 0xab) });
  assert.equal(packet.length, Limits.MAX_PACKET);
  const decoded = decodePacket(packet);
  assert.equal(decoded.body.length, maxBody);
  assert.equal(decoded.body[maxBody - 1], 0xab);

  assert.throws(
    () => encodePacket({ type: PacketType.DATA, header, body: Buffer.alloc(maxBody + 1) }),
    isWireError(/packet is 1048577 bytes/),
  );
  const oversized = Buffer.concat([packet, Buffer.from([0])]);
  assert.throws(() => decodePacket(oversized), isWireError(/packet is 1048577 bytes/));
});

test('encodePacket rejects invalid arguments', () => {
  const cases = [
    [undefined, /must be an object/],
    [null, /must be an object/],
    [[], /must be an object/],
    [{ type: 0, header: {} }, /unknown packet type 0/],
    [{ type: 4, header: {} }, /unknown packet type 4/],
    [{ type: 256, header: {} }, /unknown packet type 256/],
    [{ type: '1', header: {} }, /unknown packet type of type string/],
    [{ type: 1.5, header: {} }, /unknown packet type/],
    [{ header: {} }, /unknown packet type/],
    [{ type: PacketType.PING }, /plain object/],
    [{ type: PacketType.PING, header: null }, /plain object/],
    [{ type: PacketType.PING, header: [] }, /plain object/],
    [{ type: PacketType.PING, header: 'x' }, /plain object/],
    [{ type: PacketType.PING, header: new Map() }, /plain object/],
    [{ type: PacketType.PING, header: {}, body: 'text' }, /body must be/],
    [{ type: PacketType.PING, header: {}, body: [1, 2] }, /body must be/],
    [{ type: PacketType.PING, header: {}, body: null }, /body must be/],
    [{ type: PacketType.PING, header: { n: 1.5 } }, /canonical JSON/],
    [{ type: PacketType.PING, header: { n: undefined } }, /canonical JSON/],
    [{ type: PacketType.PING, header: { ['k' + String.fromCodePoint(0xe9)]: 1 } }, /canonical JSON/],
  ];
  for (const [packet, pattern] of cases) {
    assert.throws(() => encodePacket(packet), isWireError(pattern), JSON.stringify(packet) ?? String(packet));
  }
});

test('decodePacket rejects input that is not bytes', () => {
  for (const input of [undefined, null, 'abc', 123, [1, 0, 0, 2], {}, new ArrayBuffer(8)]) {
    assert.throws(() => decodePacket(input), isWireError(/must be a Buffer or Uint8Array/));
  }
});

test('a header key named __proto__ is refused on both sides', () => {
  // DESIGN.md section 15 item 2: canonical JSON has no "__proto__" key, at any depth.
  for (const text of ['{"__proto__":{"x":1}}', '{"a":{"__proto__":1}}', '{"a":[{"__proto__":null}]}']) {
    assert.throws(
      () => decodePacket(rawPacket(PacketType.PING, 0, text)),
      (err) => isWireError(/not canonical JSON/)(err) && err.cause?.code === 'ERR_CANONICAL',
      text,
    );
  }
  const header = JSON.parse('{"__proto__":{"x":1}}');
  assert.throws(() => encodePacket({ type: PacketType.PING, header }), isWireError(/canonical JSON/));
});

test('packetKind and sendLimit classify every packet type', () => {
  for (const [name, type] of Object.entries(PacketType)) {
    const routed = name === 'DATA' || name === 'PROBE';
    assert.equal(packetKind(type), routed ? PacketKind.ROUTED : PacketKind.LINK, name);
    assert.equal(sendLimit(type), routed ? Limits.MAX_ROUTED_PACKET : Limits.MAX_SYNC_PACKET, name);
  }
  assert.equal(Limits.MAX_SYNC_PACKET, 65536);
  assert.equal(Limits.MAX_ROUTED_PACKET, 131072);
  for (const type of [0, 4, 31, 34, 255, 256, -1, 1.5, '1', null, undefined]) {
    assert.throws(() => packetKind(type), isWireError(/unknown packet type/), String(type));
    assert.throws(() => sendLimit(type), isWireError(/unknown packet type/), String(type));
  }
});

/** An encoded packet of exactly `total` bytes with the given type. */
function packetOfSize(type, total) {
  const header = { n: 1 };
  const overhead = encodePacket({ type, header }).length;
  return encodePacket({ type, header, body: Buffer.alloc(total - overhead) });
}

test('assertSendable enforces the link-local send limit exactly', () => {
  for (const type of [PacketType.PING, PacketType.GOSSIP, PacketType.SYNC_DELTA]) {
    const atLimit = packetOfSize(type, Limits.MAX_SYNC_PACKET);
    assert.equal(assertSendable(atLimit), Limits.MAX_SYNC_PACKET);
    assert.equal(assertSendable(atLimit, PacketKind.LINK), Limits.MAX_SYNC_PACKET);
    const over = packetOfSize(type, Limits.MAX_SYNC_PACKET + 1);
    assert.throws(() => assertSendable(over), isWireError(/link packet is 65537 bytes, send limit is 65536/));
    // The receiving side still accepts it: the parser's bound is MAX_PACKET.
    assert.equal(decodePacket(over).type, type);
    assert.equal(over.length, Limits.MAX_SYNC_PACKET + 1);
  }
});

test('assertSendable enforces the routed send limit exactly while decodePacket keeps MAX_PACKET', () => {
  for (const type of [PacketType.DATA, PacketType.PROBE]) {
    const atLimit = packetOfSize(type, Limits.MAX_ROUTED_PACKET);
    assert.equal(assertSendable(atLimit, PacketKind.ROUTED), Limits.MAX_ROUTED_PACKET);
    const over = packetOfSize(type, Limits.MAX_ROUTED_PACKET + 1);
    assert.throws(() => assertSendable(over), isWireError(/routed packet is 131073 bytes, send limit is 131072/));
    // A forwarder may receive such a packet from a peer, but must not relay it.
    const huge = packetOfSize(type, Limits.MAX_PACKET);
    assert.equal(decodePacket(huge).type, type);
    assert.throws(() => assertSendable(huge), isWireError(/send limit is 131072/));
  }
});

test('assertSendable refuses a packet of the other kind and malformed input', () => {
  const ping = encodePacket({ type: PacketType.PING, header: { n: 1 } });
  const data = encodePacket({ type: PacketType.DATA, header: { id: ID, dst: DST, ttl: 1, try: 0 } });
  assert.throws(() => assertSendable(ping, PacketKind.ROUTED), isWireError(/is link, not routed/));
  assert.throws(() => assertSendable(data, PacketKind.LINK), isWireError(/is routed, not link/));
  assert.throws(() => assertSendable(ping, 'data'), isWireError(/kind must be/));

  const cases = [
    [undefined, /must be a Buffer or Uint8Array/],
    ['abc', /must be a Buffer or Uint8Array/],
    [[1, 0, 0, 0], /must be a Buffer or Uint8Array/],
    [Buffer.alloc(0), /truncated/],
    [Buffer.from([1, 0, 0]), /truncated/],
    [rawPacket(99, 0, '{}'), /unknown packet type 99/],
    [rawPacket(PacketType.PING, 1, '{}'), /unsupported packet flags/],
    [rawPacket(PacketType.PING, 0, '{}', Buffer.alloc(0), 3), /header runs past the end/],
    [rawPacket(PacketType.PING, 0, '{}', Buffer.alloc(0), Limits.MAX_HEADER + 1), /limit is 8192/],
  ];
  for (const [input, pattern] of cases) assert.throws(() => assertSendable(input), isWireError(pattern), String(pattern));
  // A plain Uint8Array view at an offset is read correctly.
  const backing = new Uint8Array(ping.length + 3);
  backing.set(ping, 3);
  assert.equal(assertSendable(backing.subarray(3), PacketKind.LINK), ping.length);
});

test('encodeFrame prefixes the payload with its big-endian length', () => {
  assert.deepEqual(encodeFrame(Buffer.from([1, 2, 3])), Buffer.from([0, 0, 0, 3, 1, 2, 3]));
  assert.deepEqual(encodeFrame(new Uint8Array([0xff])), Buffer.from([0, 0, 0, 1, 0xff]));
  const big = encodeFrame(Buffer.alloc(0x012345, 7));
  assert.deepEqual(big.subarray(0, FRAME_PREFIX_BYTES), Buffer.from([0, 0x01, 0x23, 0x45]));
  assert.equal(big.length, FRAME_PREFIX_BYTES + 0x012345);
});

test('encodeFrame rejects empty, oversized and non-byte payloads', () => {
  assert.throws(() => encodeFrame(Buffer.alloc(0)), isWireError(/must not be empty/));
  assert.throws(() => encodeFrame(Buffer.alloc(Limits.MAX_PACKET + 1)), isWireError(/limit is 1048576/));
  assert.equal(encodeFrame(Buffer.alloc(Limits.MAX_PACKET)).length, Limits.MAX_PACKET + 4);
  assert.throws(() => encodeFrame(Buffer.alloc(9), { maxFrame: 8 }), isWireError(/limit is 8/));
  assert.equal(encodeFrame(Buffer.alloc(8), { maxFrame: 8 }).length, 12);
  for (const payload of [undefined, null, 'abc', [1, 2], 5]) {
    assert.throws(() => encodeFrame(payload), isWireError(/must be a Buffer or Uint8Array/));
  }
  assert.throws(() => encodeFrame(Buffer.alloc(1), { maxFrame: 0 }), isWireError(/maxFrame/));
});

test('FrameDecoder returns a frame delivered in one chunk', () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeFrame(Buffer.from('abc')));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], Buffer.from('abc'));
  assert.equal(decoder.buffered, 0);
});

test('FrameDecoder reassembles frames delivered one byte at a time', () => {
  const payloads = [Buffer.from('a'), Buffer.from('hello world'), Buffer.alloc(300, 0x5a), Buffer.from([0])];
  const stream = Buffer.concat(payloads.map((p) => encodeFrame(p)));
  const decoder = new FrameDecoder();
  const out = [];
  for (let i = 0; i < stream.length; i += 1) {
    const frames = decoder.push(stream.subarray(i, i + 1));
    assert.ok(frames.length <= 1);
    out.push(...frames);
  }
  assert.equal(out.length, payloads.length);
  for (let i = 0; i < payloads.length; i += 1) assert.deepEqual(out[i], payloads[i], `frame ${i}`);
  assert.equal(decoder.buffered, 0);
});

test('FrameDecoder returns many frames from one chunk in order', () => {
  const payloads = Array.from({ length: 500 }, (_, i) => Buffer.from(`frame-${i}`));
  const decoder = new FrameDecoder();
  const frames = decoder.push(Buffer.concat(payloads.map((p) => encodeFrame(p))));
  assert.equal(frames.length, 500);
  for (let i = 0; i < 500; i += 1) assert.equal(frames[i].toString(), `frame-${i}`);
});

test('FrameDecoder gives the same frames for every possible split of a stream', () => {
  const payloads = [Buffer.from('one'), Buffer.from('2'), Buffer.from('three!')];
  const stream = Buffer.concat(payloads.map((p) => encodeFrame(p)));
  for (let a = 0; a <= stream.length; a += 1) {
    for (let b = a; b <= stream.length; b += 1) {
      const decoder = new FrameDecoder();
      const out = [
        ...decoder.push(stream.subarray(0, a)),
        ...decoder.push(stream.subarray(a, b)),
        ...decoder.push(stream.subarray(b)),
      ];
      assert.deepEqual(out, payloads, `split at ${a},${b}`);
      assert.equal(decoder.buffered, 0);
    }
  }
});

test('FrameDecoder tracks buffered bytes across a partial prefix and a partial payload', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame(Buffer.from('abcdefgh'));
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
  assert.equal(decoder.buffered, 0);
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.equal(decoder.buffered, 2);
  assert.deepEqual(decoder.push(frame.subarray(2, 4)), []);
  assert.equal(decoder.buffered, 4);
  assert.deepEqual(decoder.push(frame.subarray(4, 9)), []);
  assert.equal(decoder.buffered, 9);
  // The rest of this frame plus the first three bytes of the next one.
  const next = encodeFrame(Buffer.from('z'));
  const frames = decoder.push(Buffer.concat([frame.subarray(9), next.subarray(0, 3)]));
  assert.deepEqual(frames, [Buffer.from('abcdefgh')]);
  assert.equal(decoder.buffered, 3);
  assert.deepEqual(decoder.push(next.subarray(3)), [Buffer.from('z')]);
  assert.equal(decoder.buffered, 0);
});

test('FrameDecoder frames do not alias the chunk they arrived in', () => {
  const decoder = new FrameDecoder();
  const chunk = encodeFrame(Buffer.from('stable'));
  const [frame] = decoder.push(chunk);
  chunk.fill(0);
  assert.equal(frame.toString(), 'stable');
});

test('FrameDecoder rejects a zero length as soon as the prefix is complete', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0, 0, 0])), []);
  assert.throws(() => decoder.push(Buffer.from([0])), isWireError(/length of zero/));
});

test('FrameDecoder rejects an oversized length before any body byte arrives', () => {
  const decoder = new FrameDecoder();
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(Limits.MAX_PACKET + 1, 0);
  assert.throws(() => decoder.push(prefix), isWireError(/declares 1048577 bytes, limit is 1048576/));
  assert.equal(decoder.buffered, 0);

  const huge = new FrameDecoder();
  assert.throws(() => huge.push(Buffer.from([0xff, 0xff, 0xff, 0xff])), isWireError(/declares 4294967295 bytes/));
});

test('FrameDecoder accepts a frame of exactly maxFrame bytes', () => {
  const decoder = new FrameDecoder({ maxFrame: 5 });
  assert.deepEqual(decoder.push(Buffer.from([0, 0, 0, 5, 1, 2, 3, 4, 5])), [Buffer.from([1, 2, 3, 4, 5])]);
  const strict = new FrameDecoder({ maxFrame: 5 });
  assert.throws(() => strict.push(Buffer.from([0, 0, 0, 6])), isWireError(/declares 6 bytes, limit is 5/));

  const full = new FrameDecoder();
  const [frame] = full.push(encodeFrame(Buffer.alloc(Limits.MAX_PACKET, 0x11)));
  assert.equal(frame.length, Limits.MAX_PACKET);
  assert.equal(frame[Limits.MAX_PACKET - 1], 0x11);
});

test('FrameDecoder stays failed after an error and discards its partial state', () => {
  const decoder = new FrameDecoder({ maxFrame: 16 });
  const good = encodeFrame(Buffer.from('ok'));
  // A valid frame followed by a bad prefix in the same chunk: the whole push fails.
  let first;
  assert.throws(
    () => decoder.push(Buffer.concat([good, Buffer.from([0, 0, 0, 17])])),
    (err) => {
      first = err;
      return err instanceof WireError;
    },
  );
  assert.equal(decoder.buffered, 0);
  assert.throws(() => decoder.push(good), (err) => err === first);
  assert.throws(() => decoder.push(Buffer.alloc(0)), (err) => err === first);
});

test('FrameDecoder rejects input that is not bytes', () => {
  for (const input of ['abcd', [0, 0, 0, 1, 1], null, undefined, 4]) {
    assert.throws(() => new FrameDecoder().push(input), isWireError(/must be a Buffer or Uint8Array/));
  }
});

test('FrameDecoder rejects an invalid maxFrame', () => {
  for (const maxFrame of [0, -1, 1.5, NaN, Infinity, 2 ** 32, '16', null]) {
    assert.throws(() => new FrameDecoder({ maxFrame }), isWireError(/maxFrame/), String(maxFrame));
  }
  assert.doesNotThrow(() => new FrameDecoder({ maxFrame: 0xffffffff }));
});

test('FrameDecoder never buffers more than one frame, however the stream is sliced', () => {
  const maxFrame = 4096;
  const decoder = new FrameDecoder({ maxFrame });
  const payloads = Array.from({ length: 40 }, (_, i) => Buffer.alloc(1 + ((i * 997) % maxFrame), i));
  const stream = Buffer.concat(payloads.map((p) => encodeFrame(p, { maxFrame })));
  const out = [];
  // Chunk sizes cycle through primes so that boundaries land everywhere.
  const sizes = [1, 2, 3, 5, 7, 11, 13, 4099, 17, 8191];
  let offset = 0;
  for (let i = 0; offset < stream.length; i += 1) {
    const size = sizes[i % sizes.length];
    out.push(...decoder.push(stream.subarray(offset, offset + size)));
    offset += size;
    assert.ok(decoder.buffered < FRAME_PREFIX_BYTES + maxFrame, `buffered ${decoder.buffered}`);
  }
  assert.deepEqual(out, payloads);
});

test('FrameDecoder handles a megabyte frame fed one byte at a time in linear time', () => {
  // With a quadratic reassembly (Buffer.concat per byte) this would copy about 2^39 bytes
  // and take minutes; the linear decoder does it in well under a second. The bound is
  // loose on purpose so that a slow machine cannot make the test flaky.
  const payload = Buffer.alloc(Limits.MAX_PACKET);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) & 0xff;
  const stream = encodeFrame(payload);
  const decoder = new FrameDecoder();
  const started = process.hrtime.bigint();
  let frames = [];
  for (let i = 0; i < stream.length; i += 1) {
    const got = decoder.push(stream.subarray(i, i + 1));
    if (got.length > 0) frames = got;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(payload));
  assert.ok(elapsedMs < 20000, `byte-at-a-time decode took ${elapsedMs.toFixed(0)} ms`);
});

test('framed packets survive a full encode, stream and decode cycle', () => {
  const packets = [
    { type: PacketType.PING, header: { n: 1 }, body: Buffer.alloc(0) },
    { type: PacketType.DATA, header: { dst: DST, id: ID, ttl: 3, try: 1 }, body: Buffer.alloc(70000, 0xc3) },
    { type: PacketType.BYE, header: { reason: 'duplicate' }, body: Buffer.alloc(0) },
  ];
  const stream = Buffer.concat(packets.map((p) => encodeFrame(encodePacket(p))));
  const decoder = new FrameDecoder();
  const decoded = [];
  // 65535 is the Noise record size, the chunking a real link produces.
  for (let offset = 0; offset < stream.length; offset += 65535) {
    for (const frame of decoder.push(stream.subarray(offset, offset + 65535))) {
      decoded.push(decodePacket(frame));
    }
  }
  assert.equal(decoded.length, packets.length);
  for (let i = 0; i < packets.length; i += 1) {
    assert.equal(decoded[i].type, packets[i].type);
    assert.deepEqual(decoded[i].header, packets[i].header);
    assert.ok(decoded[i].body.equals(packets[i].body));
  }
});
