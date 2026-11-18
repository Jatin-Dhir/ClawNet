/**
 * The phone web app server (src/gate/webapp-server.js): which files it serves, the Host
 * rule, its headers, /config.json, caching and its bounds on idle connections.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';

import { ConfigError } from '../../src/core/errors.js';
import { appUrls, contentSecurityPolicy, createWebServer, INDEX_PATH, loadWebFiles } from '../../src/gate/webapp-server.js';
import { tempDir } from '../helpers/tmp.js';

const HOST = '127.0.0.1';
const WS_PORT = 47471;
const KEY = 'c2VjcmV0LW5ldHdvcmsta2V5LW9mLTMyLWJ5dGVzISE=';

async function withServer(options, run) {
  const files = options.files ?? loadWebFiles();
  const config = { networkId: 'clawnet-test', networkKey: null, webapp: { allowedHosts: [] }, ...options.config };
  const stats = {};
  const server = createWebServer({ files, config, wsPort: () => WS_PORT, stats, idleTimeoutMs: options.idleTimeoutMs });
  server.listen(0, HOST);
  await once(server, 'listening');
  try {
    await run({ port: server.address().port, stats, files });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function request(port, { path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, path, method, agent: false, headers: { Host: `${HOST}:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the served files are the app, the browser core, the vendored libraries and three shared modules', () => {
  const files = loadWebFiles();
  assert.ok(files.has(`/${INDEX_PATH}`));
  for (const path of ['/web/app/main.js', '/web/app/app.css', '/web/core/node.js', '/web/vendor/manifest.json', '/src/core/errors.js', '/src/core/wire/types.js', '/src/core/wire/canonical.js']) {
    assert.ok(files.has(path), path);
  }
  for (const path of files.keys()) {
    assert.match(path, /^\/(web\/(app|core|vendor)\/[A-Za-z0-9._/-]+|src\/core\/(errors|wire\/types|wire\/canonical)\.js)$/, path);
    assert.ok(!path.split('/').some((part) => part.startsWith('.')), path);
  }
  assert.equal([...files.keys()].some((path) => path.startsWith('/src/') && !path.startsWith('/src/core/')), false);
});

test('hidden files, odd names and unknown types are left out; a missing index page is an error', async (t) => {
  const root = await tempDir(t, 'webapp-files');
  for (const dir of ['web/app', 'web/core', 'web/vendor', 'src/core/wire']) await mkdir(join(root, ...dir.split('/')), { recursive: true });
  for (const name of ['src/core/errors.js', 'src/core/wire/types.js', 'src/core/wire/canonical.js', 'web/core/x.js']) await writeFile(join(root, ...name.split('/')), 'export {};\n');
  await writeFile(join(root, 'web', 'app', '.secret.js'), 'no');
  await writeFile(join(root, 'web', 'app', 'with space.js'), 'no');
  await writeFile(join(root, 'web', 'app', 'notes.md'), 'no');
  assert.throws(() => loadWebFiles(root), ConfigError);
  await writeFile(join(root, 'web', 'app', 'index.html'), '<!doctype html>');
  const files = loadWebFiles(root);
  assert.deepEqual([...files.keys()].sort(), ['/src/core/errors.js', '/src/core/wire/canonical.js', '/src/core/wire/types.js', '/web/app/index.html', '/web/core/x.js']);
});

test('the app is served with a strict policy that allows this node\'s WebSocket port only', async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, new RegExp(`connect-src 'self' ws://${HOST.replaceAll('.', '\\.')}:${WS_PORT}(;|$)`));
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  });
});

test('the Host header must name this machine in a way nobody outside can redirect', async () => {
  await withServer({ config: { webapp: { allowedHosts: ['mypc'] } } }, async ({ port, stats }) => {
    for (const host of ['192.168.1.20:47490', 'localhost', '[::1]:47490', 'mypc.local', 'mypc.home.arpa', 'mypc']) {
      assert.equal((await request(port, { headers: { Host: host } })).status, 200, host);
    }
    for (const host of ['evil.example', 'mypc.example.com', 'localhost.evil.example', 'a b']) {
      const res = await request(port, { headers: { Host: host } });
      assert.equal(res.status, 421, host);
      assert.match(res.body.toString(), /IP address/);
    }
    assert.ok(stats.refusedHost >= 4);
    // Node's client fills in an empty Host header, so these two go over a raw socket.
    for (const head of [`GET / HTTP/1.1\r\nHost:\r\n\r\n`, 'GET / HTTP/1.1\r\n\r\n']) {
      const socket = net.connect(port, HOST);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.end(head);
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'close');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(chunks).toString('latin1'))?.[1]);
      assert.ok(status === 400 || status === 421, `${JSON.stringify(head)} got ${status}`);
    }
  });
});

test('only GET and HEAD are answered; HEAD sends no body', async () => {
  await withServer({}, async ({ port }) => {
    const post = await request(port, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    const head = await request(port, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers['content-length']) > 0);
    assert.equal(head.body.length, 0);
  });
});

test('/config.json says whether a key is needed, and never contains it', async () => {
  await withServer({ config: { networkKey: KEY } }, async ({ port }) => {
    const res = await request(port, { path: '/config.json' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body.toString());
    assert.deepEqual(Object.keys(body).sort(), ['agent', 'keyRequired', 'networkId', 'v', 'websocket']);
    assert.equal(body.keyRequired, true);
    assert.equal(body.networkId, 'clawnet-test');
    assert.deepEqual(body.websocket, { port: WS_PORT, path: '/' });
    assert.equal(res.body.toString().includes(KEY), false);
  });
  await withServer({}, async ({ port }) => {
    assert.equal(JSON.parse((await request(port, { path: '/config.json' })).body.toString()).keyRequired, false);
  });
});

test('a matching ETag gets 304 without a body', async () => {
  await withServer({}, async ({ port, stats }) => {
    const first = await request(port, { path: '/web/app/main.js' });
    assert.equal(first.status, 200);
    const again = await request(port, { path: '/web/app/main.js', headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(stats.notModified, 1);
  });
});

test('anything outside the table is 404, however the path is written', async () => {
  await withServer({}, async ({ port }) => {
    for (const path of ['/package.json', '/web/app/../../package.json', '/web/app/%2e%2e/%2e%2e/package.json', '/src/core/node.js', '/web/app', '/.git/config', '/web/app/main.js/']) {
      assert.equal((await request(port, { path })).status, 404, path);
    }
    // A query string does not change which file is served.
    assert.equal((await request(port, { path: '/web/app/main.js?v=2' })).status, 200);
  });
});

test('an upgrade request is dropped: this server never speaks WebSocket', async () => {
  await withServer({}, async ({ port }) => {
    const socket = net.connect(port, HOST);
    socket.on('error', () => {});
    socket.resume();
    await once(socket, 'connect');
    socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    await once(socket, 'close');
  });
});

test('a connection that sends nothing is closed after the idle timeout', async () => {
  await withServer({ idleTimeoutMs: 300 }, async ({ port }) => {
    const socket = net.connect(port, HOST);
    socket.on('error', () => {});
    socket.resume();
    await once(socket, 'connect');
    const started = Date.now();
    await once(socket, 'close');
    assert.ok(Date.now() - started < 3000, `closed after ${Date.now() - started} ms`);
  });
});

test('the policy names the WebSocket port under the host the browser used, or none', () => {
  assert.match(contentSecurityPolicy('[fe80::1]', 47471), /connect-src 'self' ws:\/\/\[fe80::1\]:47471(;|$)/);
  assert.match(contentSecurityPolicy('192.168.1.20', null), /connect-src 'self'(;|$)/);
});

test('the app URLs are the local IPv4 addresses, or the one address the server is bound to', () => {
  const interfaces = () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wifi: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    eth: [{ family: 4, address: '10.0.0.5', internal: false }, { family: 'IPv4', address: '169.254.3.4', internal: false }],
    dup: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
  });
  assert.deepEqual(appUrls({ host: '0.0.0.0', port: 47490 }, interfaces), ['http://10.0.0.5:47490/', 'http://192.168.1.20:47490/']);
  assert.deepEqual(appUrls({ host: '127.0.0.1', port: 1 }, interfaces), ['http://127.0.0.1:1/']);
  assert.deepEqual(appUrls({ host: 'fe80::1', port: 2 }, interfaces), ['http://[fe80::1]:2/']);
  assert.deepEqual(appUrls({ host: '0.0.0.0', port: 3 }, () => ({})), []);
});
