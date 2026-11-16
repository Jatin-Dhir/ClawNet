import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { HandshakeError, StateError } from '../../src/core/errors.js';
import { dialTcp, isRestrictedIp, listenTcp, normalizeIp } from '../../src/core/transport/tcp.js';

const reason = expected => err => {
  assert.ok(err instanceof HandshakeError, String(err));
  assert.equal(err.reason, expected);
  return true;
};

test('listenTcp binds 127.0.0.1:0 and dialTcp reaches it, both sockets configured', async t => {
  const accepted = [];
  const listener = await listenTcp({ host: '127.0.0.1', port: 0, onSocket: s => accepted.push(s) });
  t.after(() => listener.close());
  assert.equal(listener.address.host, '127.0.0.1');
  assert.ok(listener.address.port > 0);
  const socket = await dialTcp({ host: '127.0.0.1', port: listener.address.port, timeoutMs: 2000 });
  t.after(() => socket.destroy());
  for (let i = 0; i < 100 && accepted.length === 0; i += 1) await new Promise(r => setTimeout(r, 5));
  assert.equal(accepted.length, 1);
  assert.equal(socket.allowHalfOpen, false);
  assert.equal(accepted[0].allowHalfOpen, false);
  assert.equal(socket.timeout ?? 0, 0);
  // Bytes flow both ways.
  const echoed = new Promise(resolve => socket.once('data', resolve));
  accepted[0].once('data', chunk => accepted[0].write(chunk));
  socket.write('ping');
  assert.equal((await echoed).toString(), 'ping');
  accepted[0].destroy();
});

test('close() stops accepting but leaves accepted sockets alone; closing twice is fine', async () => {
  const accepted = [];
  const listener = await listenTcp({ host: '127.0.0.1', port: 0, onSocket: s => accepted.push(s) });
  const socket = await dialTcp({ host: '127.0.0.1', port: listener.address.port, timeoutMs: 2000 });
  for (let i = 0; i < 100 && accepted.length === 0; i += 1) await new Promise(r => setTimeout(r, 5));
  const closed = listener.close();
  assert.equal(listener.close(), closed);
  await closed;
  assert.equal(accepted[0].destroyed, false);
  await assert.rejects(dialTcp({ host: '127.0.0.1', port: listener.address.port, timeoutMs: 2000 }), reason('connect-failed'));
  socket.destroy();
  accepted[0].destroy();
});

test('binding a port in use fails with listen-failed', async t => {
  const first = await listenTcp({ host: '127.0.0.1', port: 0, onSocket: s => s.destroy() });
  t.after(() => first.close());
  await assert.rejects(
    listenTcp({ host: '127.0.0.1', port: first.address.port, onSocket: () => {} }),
    err => err instanceof StateError && err.message.startsWith('listen-failed:'),
  );
});

test('a closed port is connect-failed with the OS error attached', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(dialTcp({ host: '127.0.0.1', port, timeoutMs: 2000 }), err => {
    assert.equal(err.reason, 'connect-failed');
    assert.ok(err.cause instanceof Error);
    return true;
  });
});

test('an aborted signal is "closed", before and during the attempt', async t => {
  const listener = await listenTcp({ host: '127.0.0.1', port: 0, onSocket: s => s.destroy() });
  t.after(() => listener.close());
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    dialTcp({ host: '127.0.0.1', port: listener.address.port, timeoutMs: 2000, signal: before.signal }),
    reason('closed'),
  );
  const during = new AbortController();
  const attempt = dialTcp({ host: '127.0.0.1', port: listener.address.port, timeoutMs: 2000, signal: during.signal });
  during.abort();
  await assert.rejects(attempt, reason('closed'));
});

test('restricted addresses are refused only when asked, also behind a DNS name', async t => {
  const listener = await listenTcp({ host: '127.0.0.1', port: 0, onSocket: s => s.destroy() });
  t.after(() => listener.close());
  const { port } = listener.address;
  await assert.rejects(dialTcp({ host: '127.0.0.1', port, timeoutMs: 2000, allowRestricted: false }), reason('connect-failed'));
  // "localhost" resolves to loopback: refused after resolution, with the cause attached.
  await assert.rejects(dialTcp({ host: 'localhost', port, timeoutMs: 2000, allowRestricted: false }), err => {
    assert.equal(err.reason, 'connect-failed');
    assert.equal(err.cause?.code, 'ERESTRICTED');
    return true;
  });
  const socket = await dialTcp({ host: '127.0.0.1', port, timeoutMs: 2000, allowRestricted: true });
  socket.destroy();
});

test('isRestrictedIp covers loopback, unspecified, multicast and link-local, both families', () => {
  for (const ip of ['127.0.0.1', '127.255.0.9', '0.0.0.0', '224.0.0.1', '239.255.67.78', '169.254.10.1',
    '255.255.255.255', '::1', '::', 'ff02::1', 'fe80::1', '::ffff:127.0.0.1', 'fe80::1%eth0']) {
    assert.equal(isRestrictedIp(ip), true, ip);
  }
  for (const ip of ['10.0.0.1', '192.168.1.1', '8.8.8.8', '2001:db8::1', 'fd00::1', 'example.com', '', 'x']) {
    assert.equal(isRestrictedIp(ip), false, ip);
  }
});

test('normalizeIp unwraps IPv4-mapped addresses and strips zone ids', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(normalizeIp('::FFFF:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('FE80::ABCD'), 'fe80::abcd');
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:999.1.1.1'), '::ffff:999.1.1.1');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(normalizeIp(42), '');
});
