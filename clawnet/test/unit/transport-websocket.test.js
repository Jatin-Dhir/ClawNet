/**
 * The WebSocket server (src/core/transport/websocket.js) against two kinds of client:
 *
 *   - Node's built-in WebSocket (undici), an independent RFC 6455 implementation, for
 *     everything a well-behaved browser does;
 *   - a raw TCP client that writes the upgrade request and the frames byte by byte, for
 *     everything a broken or hostile client could do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';

import {
  CLOSE_GRACE_MS,
  MAX_FRAGMENTS,
  WEBSOCKET_SUBPROTOCOL,
  acceptKey,
  isLocalHostName,
  listenWebSocket,
  originPolicy,
  parseHostHeader,
} from '../../src/core/transport/websocket.js';

const HOST = '127.0.0.1';

async function withServer(options, run) {
  const streams = [];
  const unclaimed = [];
  const waiters = [];
  const refused = [];
  const listener = await listenWebSocket({
    host: HOST,
    port: 0,
    onStream: (stream) => {
      streams.push(stream);
      const waiter = waiters.shift();
      if (waiter === undefined) unclaimed.push(stream);
      else waiter(stream);
    },
    onRefused: (info) => refused.push(info),
    ...options,
  });
  const nextStream = () =>
    new Promise((resolve) => {
      if (unclaimed.length > 0) resolve(unclaimed.shift());
      else waiters.push(resolve);
    });
  try {
    await run({ port: listener.address.port, nextStream, streams, refused, listener });
  } finally {
    for (const stream of streams) stream.destroy();
    await listener.close();
  }
}

/** Collect a readable stream's bytes until `n` have arrived. */
function readBytes(stream, n, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let have = 0;
    const timer = setTimeout(() => reject(new Error(`timed out with ${have} of ${n} bytes`)), timeoutMs);
    const onData = (chunk) => {
      parts.push(chunk);
      have += chunk.length;
      if (have >= n) {
        clearTimeout(timer);
        stream.removeListener('data', onData);
        resolve(Buffer.concat(parts));
      }
    };
    stream.on('data', onData);
  });
}

// ------------------------------------------------------------------- raw client helpers

function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, rsv = 0, forceLength } = {}) {
  const length = payload.length;
  const lengthMode = forceLength ?? (length < 126 ? 'short' : length < 65536 ? 'u16' : 'u64');
  const parts = [Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | opcode])];
  const maskBit = mask ? 0x80 : 0;
  if (lengthMode === 'short') parts.push(Buffer.from([maskBit | length]));
  else if (lengthMode === 'u16') {
    const b = Buffer.alloc(3);
    b[0] = maskBit | 126;
    b.writeUInt16BE(length, 1);
    parts.push(b);
  } else {
    const b = Buffer.alloc(9);
    b[0] = maskBit | 127;
    b.writeBigUInt64BE(BigInt(length), 1);
    parts.push(b);
  }
  if (mask) {
    const key = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i & 3];
    parts.push(key, masked);
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

function closePayload(code, reason = '') {
  const text = Buffer.isBuffer(reason) ? reason : Buffer.from(reason, 'utf8');
  const b = Buffer.alloc(2 + text.length);
  b.writeUInt16BE(code, 0);
  text.copy(b, 2);
  return b;
}

/** Reads the HTTP response head, then server frames, from a raw socket. */
class RawClient {
  socket;
  #buffer = Buffer.alloc(0);
  #waiters = [];
  ended = false;

  constructor(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake();
    });
    socket.on('close', () => {
      this.ended = true;
      this.#wake();
    });
    socket.on('error', () => {});
  }

  #wake() {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async #until(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value !== undefined) return value;
      if (this.ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for the server');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async head() {
    return this.#until(() => {
      const end = this.#buffer.indexOf('\r\n\r\n');
      if (end === -1) return undefined;
      const text = this.#buffer.subarray(0, end).toString('latin1');
      this.#buffer = this.#buffer.subarray(end + 4);
      const [statusLine, ...lines] = text.split('\r\n');
      const headers = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      return { status: Number(statusLine.split(' ')[1]), headers };
    });
  }

  async frame(timeoutMs) {
    return this.#until(() => {
      const b = this.#buffer;
      if (b.length < 2) return undefined;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      if (b[1] & 0x80) throw new Error('server frames must not be masked');
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return undefined;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return undefined;
        length = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      if (b.length < offset + length) return undefined;
      const payload = b.subarray(offset, offset + length);
      this.#buffer = b.subarray(offset + length);
      return { fin, opcode, payload };
    }, timeoutMs);
  }

  async closed(timeoutMs = 5000) {
    await this.#until(() => (this.ended ? true : undefined), timeoutMs);
    return this.ended;
  }
}

async function rawConnect(port, { path = '/', headers = {}, omit = [], extra = Buffer.alloc(0), method = 'GET' } = {}) {
  const socket = net.connect(port, HOST);
  await once(socket, 'connect');
  const client = new RawClient(socket);
  const key = randomBytes(16).toString('base64');
  const base = {
    Host: `${HOST}:${port}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL,
    ...headers,
  };
  for (const name of omit) delete base[name];
  const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(base).map(([name, value]) => `${name}: ${value}`), '', ''];
  socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), extra]));
  const head = await client.head();
  return { client, head, key };
}

async function expectClose(client, code) {
  const frame = await client.frame();
  assert.ok(frame !== null, 'expected a close frame before the connection ended');
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), code);
  assert.ok(await client.closed(CLOSE_GRACE_MS + 2000), 'the server ends the connection');
}

// ------------------------------------------------------------------------------ tests

test('acceptKey matches the worked example of RFC 6455 section 1.3', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a standard WebSocket client links up and the bytes flow both ways, in order', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/`, [WEBSOCKET_SUBPROTOCOL]);
    ws.binaryType = 'arraybuffer';
    const accepted = nextStream();
    await once(ws, 'open');
    assert.equal(ws.protocol, WEBSOCKET_SUBPROTOCOL);
    const stream = await accepted;
    assert.equal(stream.remoteAddress.replace(/^::ffff:/, ''), HOST);
    assert.ok(Number.isInteger(stream.remotePort));

    // Client to server: message boundaries do not matter, the byte order does.
    const sent = [];
    for (let i = 0; i < 50; i += 1) {
      const part = randomBytes(1 + (i * 37) % 300);
      sent.push(part);
      ws.send(part);
    }
    const expected = Buffer.concat(sent);
    assert.deepEqual(await readBytes(stream, expected.length), expected);

    // Server to client, including a message that needs the 64-bit length.
    const big = randomBytes(70_000);
    const received = [];
    const done = new Promise((resolve) => {
      ws.addEventListener('message', (event) => {
        received.push(Buffer.from(event.data));
        if (Buffer.concat(received).length >= big.length + 3) resolve();
      });
    });
    stream.write(Buffer.from([1, 2, 3]));
    stream.write(big);
    await done;
    assert.deepEqual(Buffer.concat(received), Buffer.concat([Buffer.from([1, 2, 3]), big]));
    ws.close();
  });
});

test('a large client message (200 KiB) arrives whole', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/`, [WEBSOCKET_SUBPROTOCOL]);
    const accepted = nextStream();
    await once(ws, 'open');
    const stream = await accepted;
    const data = randomBytes(200 * 1024);
    ws.send(data);
    assert.deepEqual(await readBytes(stream, data.length), data);
    ws.close();
  });
});

test('closing from the client ends the stream; closing from the server reaches the client', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/`, [WEBSOCKET_SUBPROTOCOL]);
    const accepted = nextStream();
    await once(ws, 'open');
    const stream = await accepted;
    stream.resume();
    const ended = once(stream, 'end');
    ws.close(1000, 'bye');
    await ended;
    const event = await once(ws, 'close');
    assert.equal(event[0].code, 1000);

    const ws2 = new WebSocket(`ws://${HOST}:${port}/`, [WEBSOCKET_SUBPROTOCOL]);
    const accepted2 = nextStream();
    await once(ws2, 'open');
    const stream2 = await accepted2;
    stream2.resume();
    const closed = once(ws2, 'close');
    stream2.end();
    const [closeEvent] = await closed;
    assert.equal(closeEvent.code, 1000);
    assert.equal(closeEvent.wasClean, true);
  });
});

test('destroying the stream sends a close frame and closes the connection', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const { client, head } = await rawConnect(port);
    assert.equal(head.status, 101);
    const stream = await nextStream();
    stream.destroy();
    await expectClose(client, 1000);
  });
});

test('the 101 response carries the accept key and the subprotocol, and nothing else is negotiated', async () => {
  await withServer({}, async ({ port }) => {
    const { client, head, key } = await rawConnect(port, {
      headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate', 'Sec-WebSocket-Protocol': 'other, clawnet.1' },
    });
    assert.equal(head.status, 101);
    assert.equal(head.headers['sec-websocket-accept'], acceptKey(key));
    assert.equal(head.headers['sec-websocket-protocol'], WEBSOCKET_SUBPROTOCOL);
    assert.equal(head.headers['sec-websocket-extensions'], undefined);
    assert.equal(head.headers.upgrade.toLowerCase(), 'websocket');
    client.socket.destroy();
  });
});

for (const [name, options, status] of [
  ['a wrong path', { path: '/other' }, 404],
  ['a query string', { path: '/?x=1' }, 404],
  ['no subprotocol', { omit: ['Sec-WebSocket-Protocol'] }, 400],
  ['a different subprotocol', { headers: { 'Sec-WebSocket-Protocol': 'chat' } }, 400],
  ['version 8', { headers: { 'Sec-WebSocket-Version': '8' } }, 426],
  ['no key', { omit: ['Sec-WebSocket-Key'] }, 400],
  ['a key that is not 16 bytes', { headers: { 'Sec-WebSocket-Key': Buffer.alloc(15).toString('base64') } }, 400],
  ['no Upgrade token', { headers: { Upgrade: 'h2c' } }, 400],
  ['the POST method', { method: 'POST' }, 405],
]) {
  test(`an upgrade request with ${name} is refused with ${status}`, async () => {
    await withServer({}, async ({ port, streams, refused }) => {
      const { client, head } = await rawConnect(port, options);
      assert.equal(head.status, status);
      if (status === 426) assert.equal(head.headers['sec-websocket-version'], '13');
      assert.ok(await client.closed());
      assert.equal(streams.length, 0);
      assert.equal(refused.length, 1);
    });
  });
}

test('a request without Connection: Upgrade is an ordinary request and gets 426', async () => {
  await withServer({}, async ({ port, streams }) => {
    const { client, head } = await rawConnect(port, { headers: { Connection: 'keep-alive, foo' } });
    assert.equal(head.status, 426);
    assert.equal(head.headers.upgrade, 'websocket');
    client.socket.destroy();
    assert.equal(streams.length, 0);
  });
});

test('the Origin check decides, and a refused origin gets 403', async () => {
  const seen = [];
  const checkOrigin = (request) => {
    seen.push(request);
    return request.origin === undefined || request.origin === 'http://good.local:47490';
  };
  await withServer({ checkOrigin }, async ({ port, streams }) => {
    const bad = await rawConnect(port, { headers: { Origin: 'http://evil.example:47490' } });
    assert.equal(bad.head.status, 403);
    const good = await rawConnect(port, { headers: { Origin: 'http://good.local:47490' } });
    assert.equal(good.head.status, 101);
    const none = await rawConnect(port);
    assert.equal(none.head.status, 101);
    assert.equal(streams.length, 2);
    assert.deepEqual(seen.map((r) => r.origin), ['http://evil.example:47490', 'http://good.local:47490', undefined]);
    assert.equal(seen[0].host, `${HOST}:${port}`);
    good.client.socket.destroy();
    none.client.socket.destroy();
  });
});

test('a plain HTTP request is answered with 426 and closed', async () => {
  await withServer({}, async ({ port }) => {
    const response = await fetch(`http://${HOST}:${port}/`);
    assert.equal(response.status, 426);
    assert.match(await response.text(), /WebSocket only/);
  });
});

test('bytes sent right behind the upgrade request are not lost', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const payload = randomBytes(300);
    const accepted = nextStream();
    const { head } = await rawConnect(port, { extra: clientFrame(0x2, payload) });
    assert.equal(head.status, 101);
    const stream = await accepted;
    assert.deepEqual(await readBytes(stream, payload.length), payload);
  });
});

test('a fragmented message with a ping in the middle is reassembled, and the ping answered', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    const a = randomBytes(10);
    const b = randomBytes(20);
    const c = randomBytes(30);
    client.socket.write(clientFrame(0x2, a, { fin: false }));
    client.socket.write(clientFrame(0x9, Buffer.from('are you there')));
    client.socket.write(clientFrame(0x0, b, { fin: false }));
    client.socket.write(clientFrame(0x0, c, { fin: true }));
    const pong = await client.frame();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString(), 'are you there');
    assert.deepEqual(await readBytes(stream, 60), Buffer.concat([a, b, c]));
    // A one-byte write split into the smallest pieces still parses.
    const tiny = clientFrame(0x2, Buffer.from('xyz'));
    for (const byte of tiny) client.socket.write(Buffer.from([byte]));
    assert.equal((await readBytes(stream, 3)).toString(), 'xyz');
  });
});

for (const [name, frames, code] of [
  ['an unmasked frame', () => [clientFrame(0x2, Buffer.from('x'), { mask: false })], 1002],
  ['a reserved bit', () => [clientFrame(0x2, Buffer.from('x'), { rsv: 4 })], 1002],
  ['a text message', () => [clientFrame(0x1, Buffer.from('hello'))], 1003],
  ['a reserved opcode', () => [clientFrame(0x3, Buffer.from('x'))], 1002],
  ['a non-minimal 16-bit length', () => [clientFrame(0x2, Buffer.alloc(10), { forceLength: 'u16' })], 1002],
  ['a non-minimal 64-bit length', () => [clientFrame(0x2, Buffer.alloc(300), { forceLength: 'u64' })], 1002],
  ['a control frame over 125 bytes', () => [clientFrame(0x9, Buffer.alloc(126))], 1002],
  ['a fragmented control frame', () => [clientFrame(0x9, Buffer.alloc(3), { fin: false })], 1002],
  ['a continuation with no message', () => [clientFrame(0x0, Buffer.from('x'))], 1002],
  ['a new message inside a fragmented one', () => [clientFrame(0x2, Buffer.from('a'), { fin: false }), clientFrame(0x2, Buffer.from('b'))], 1002],
  ['a declared length over the limit', () => [clientFrame(0x2, Buffer.alloc(2000))], 1009],
  ['fragments adding up to over the limit', () => [clientFrame(0x2, Buffer.alloc(600), { fin: false }), clientFrame(0x0, Buffer.alloc(600))], 1009],
  [
    'more fragments than allowed, all of them empty',
    () => [clientFrame(0x2, Buffer.alloc(0), { fin: false }), ...Array.from({ length: MAX_FRAGMENTS }, () => clientFrame(0x0, Buffer.alloc(0), { fin: false }))],
    1009,
  ],
  ['a close frame with a one-byte payload', () => [clientFrame(0x8, Buffer.from([3]))], 1002],
  ['a close frame with a reserved code', () => [clientFrame(0x8, closePayload(1005))], 1002],
  ['a close frame with code 999', () => [clientFrame(0x8, closePayload(999))], 1002],
  ['a close reason that is not UTF-8', () => [clientFrame(0x8, closePayload(1000, Buffer.from([0xff, 0xfe])))], 1007],
]) {
  test(`${name} closes the connection with ${code}`, async () => {
    await withServer({ maxMessageBytes: 1024 }, async ({ port, nextStream }) => {
      const accepted = nextStream();
      const { client } = await rawConnect(port);
      const stream = await accepted;
      const errored = new Promise((resolve) => {
        stream.on('error', resolve);
        stream.on('close', () => resolve(null));
      });
      for (const frame of frames()) client.socket.write(frame);
      await expectClose(client, code);
      await errored;
      assert.equal(stream.destroyed, true);
    });
  });
}

test('a message in as many fragments as allowed arrives whole', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    const frames = [clientFrame(0x2, Buffer.from([0]), { fin: false })];
    for (let i = 1; i < MAX_FRAGMENTS - 1; i += 1) frames.push(clientFrame(0x0, Buffer.from([i]), { fin: false }));
    frames.push(clientFrame(0x0, Buffer.from([MAX_FRAGMENTS - 1])));
    const data = readBytes(stream, MAX_FRAGMENTS);
    client.socket.write(Buffer.concat(frames));
    assert.deepEqual([...(await data)], Array.from({ length: MAX_FRAGMENTS }, (_, i) => i));
  });
});

test('a client that resets the connection after a refused upgrade does not stop the node', async () => {
  await withServer({ checkOrigin: ({ origin }) => origin === undefined }, async ({ port }) => {
    for (const options of [{ headers: { Origin: 'http://elsewhere.example' } }, { path: '/elsewhere' }, { omit: ['Sec-WebSocket-Protocol'] }]) {
      const { client, head } = await rawConnect(port, options);
      assert.notEqual(head.status, 101);
      client.socket.resetAndDestroy();
      await client.closed();
    }
    // An uncaught error would have ended this process; the port still answers.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { head } = await rawConnect(port);
    assert.equal(head.status, 101);
  });
});

test('a socket that never sends a byte is closed after the handshake deadline', async () => {
  await withServer({ handshakeTimeoutMs: 300 }, async ({ port }) => {
    const socket = net.connect(port, HOST);
    socket.on('error', () => {});
    socket.resume();
    await once(socket, 'connect');
    const started = Date.now();
    await once(socket, 'close');
    assert.ok(Date.now() - started < 3000, `closed after ${Date.now() - started} ms`);
  });
});

test('an upgraded connection may stay quiet for longer than the handshake deadline', async () => {
  await withServer({ handshakeTimeoutMs: 200 }, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(client.ended, false);
    const data = readBytes(stream, 3);
    client.socket.write(clientFrame(0x2, Buffer.from('abc')));
    assert.equal((await data).toString(), 'abc');
  });
});

test('a valid close frame is echoed with its code and ends the stream', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    stream.resume();
    const ended = once(stream, 'end');
    client.socket.write(clientFrame(0x8, closePayload(4000, 'done')));
    await expectClose(client, 4000);
    await ended;
  });
});

test('a client that disappears without a close frame ends the stream', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    stream.resume();
    const closed = once(stream, 'close');
    client.socket.destroy();
    await closed;
  });
});

test('reading is paused at the socket while the reader is not keeping up', async () => {
  await withServer({}, async ({ port, nextStream }) => {
    const accepted = nextStream();
    const { client } = await rawConnect(port);
    const stream = await accepted;
    stream.pause();
    // Far more than the stream's buffer: the server must stop taking it off the socket.
    for (let i = 0; i < 64; i += 1) client.socket.write(clientFrame(0x2, randomBytes(64 * 1024 - 100)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(stream.readableLength < 1024 * 1024, `buffered ${stream.readableLength} bytes`);
    const total = 64 * (64 * 1024 - 100);
    const all = readBytes(stream, total, 15000);
    stream.resume();
    assert.equal((await all).length, total);
  });
});

test('at most maxPerIp sockets from one address are accepted', async () => {
  await withServer({ maxPerIp: 2 }, async ({ port }) => {
    const first = await rawConnect(port);
    const second = await rawConnect(port);
    assert.equal(first.head.status, 101);
    assert.equal(second.head.status, 101);
    const third = net.connect(port, HOST);
    third.on('error', () => {});
    await once(third, 'close');
    first.client.socket.destroy();
    await first.client.closed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fourth = await rawConnect(port);
    assert.equal(fourth.head.status, 101);
    second.client.socket.destroy();
    fourth.client.socket.destroy();
  });
});

test('a client that never finishes its request headers is cut off after the deadline', async () => {
  await withServer({ handshakeTimeoutMs: 300 }, async ({ port }) => {
    const socket = net.connect(port, HOST);
    socket.on('error', () => {});
    // Read, so that the server's answer and its end of the connection are seen.
    socket.resume();
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    const started = Date.now();
    await once(socket, 'close');
    assert.ok(Date.now() - started < 5000);
  });
});

test('close() stops listening and drops sockets that were never upgraded', async () => {
  const listener = await listenWebSocket({ host: HOST, port: 0, onStream: (stream) => stream.destroy() });
  const socket = net.connect(listener.address.port, HOST);
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closed = once(socket, 'close');
  await listener.close();
  await closed;
  await assert.rejects(() => fetch(`http://${HOST}:${listener.address.port}/`));
});

test('the listener refuses bad options and an address in use', async () => {
  await assert.rejects(() => listenWebSocket({ host: HOST, port: 0 }), /onStream/);
  await assert.rejects(() => listenWebSocket({ host: HOST, port: 0, onStream() {}, path: 'no-slash' }), /path/);
  const first = await listenWebSocket({ host: HOST, port: 0, onStream() {} });
  await assert.rejects(() => listenWebSocket({ host: HOST, port: first.address.port, onStream() {} }), /listen-failed/);
  await first.close();
});

test('isLocalHostName accepts only names an outsider cannot point at this machine', () => {
  for (const name of ['192.168.1.20', '127.0.0.1', '[::1]', '[fe80::1]', 'localhost', 'my-pc.local', 'pc.home.arpa', 'PC.LOCAL']) {
    assert.equal(isLocalHostName(name), true, name);
  }
  for (const name of ['evil.example', 'local', 'x.localhost.com', 'example.com.local.evil.com', '', '::1', '[1.2.3.4]', 'a_b.local', '1.2.3']) {
    assert.equal(isLocalHostName(name), false, name);
  }
  assert.equal(isLocalHostName('my-pc', ['my-pc']), true);
});

test('parseHostHeader splits names, IPv6 literals and ports, and refuses junk', () => {
  assert.deepEqual(parseHostHeader('192.168.1.20:47471'), { hostname: '192.168.1.20', port: 47471 });
  assert.deepEqual(parseHostHeader('[::1]:80'), { hostname: '[::1]', port: 80 });
  assert.deepEqual(parseHostHeader('PC.local'), { hostname: 'pc.local', port: null });
  for (const bad of ['', 'a b', 'x:0', 'x:99999', 'x:1:2', '[::1', 'user@host']) assert.equal(parseHostHeader(bad), null, bad);
});

test('originPolicy admits non-browsers, listed origins and the node\'s own web app only', () => {
  const policy = originPolicy({ allowedOrigins: ['https://app.example'], webappPort: () => 47490 });
  const host = '192.168.1.20:47471';
  assert.equal(policy({ origin: undefined, host }), true);
  assert.equal(policy({ origin: 'https://app.example', host }), true);
  assert.equal(policy({ origin: 'http://192.168.1.20:47490', host }), true);
  assert.equal(policy({ origin: 'http://192.168.1.21:47490', host }), false, 'another host');
  assert.equal(policy({ origin: 'http://192.168.1.20:8080', host }), false, 'another port');
  assert.equal(policy({ origin: 'http://evil.example:47490', host: 'evil.example:47471' }), false, 'a public name');
  assert.equal(policy({ origin: 'http://my-pc.local:47490', host: 'my-pc.local:47471' }), true);
  assert.equal(policy({ origin: 'null', host }), false);
  assert.equal(policy({ origin: 'file:///x', host }), false);
  assert.equal(policy({ origin: 'http://192.168.1.20:47490', host: undefined }), false);
  const withoutApp = originPolicy({ webappPort: () => null });
  assert.equal(withoutApp({ origin: 'http://192.168.1.20:47490', host }), false);
  assert.equal(withoutApp({ origin: undefined, host }), true);
});
