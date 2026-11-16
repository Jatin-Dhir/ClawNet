/**
 * The control API of a real node process: authentication, the Host rule, input
 * validation and resuming the event stream, over real HTTP to a process that was started
 * by the command line. Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import { call, openStream, rawSocket, statusOf } from '../helpers/api.js';
import { initNode, runCli, startNode } from '../helpers/cli.js';
import { tempDir } from '../helpers/tmp.js';

async function startApiProcess(t) {
  const dir = await tempDir(t, 'e2e-api');
  const home = join(dir, 'node');
  await initNode(home);
  const node = await startNode(t, home);
  const port = Number(new URL(node.ready.api).port);
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  t.after(async () => {
    await runCli(['--data-dir', home, 'stop']);
  });
  return { home, node, port, token };
}

const closedPort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

test('authentication: no token, a wrong token and a token in the URL are refused; the right one is not', async (t) => {
  const { port, token } = await startApiProcess(t);
  const none = await call(port, { path: '/api/v1/status' });
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], 'Bearer realm="clawnet"');
  assert.deepEqual(Object.keys(none.json.error).sort(), ['code', 'message']);
  assert.equal(none.json.error.code, 'unauthorized');

  const wrong = await call(port, { path: '/api/v1/status', token: '0'.repeat(64) });
  assert.equal(wrong.status, 401);
  const off = await call(port, { path: '/api/v1/status', token: token.slice(0, 63) });
  assert.equal(off.status, 401);
  const query = await call(port, { path: `/api/v1/status?token=${token}` });
  assert.equal(query.status, 401, 'a token in the URL is not accepted');
  const cookie = await call(port, { path: '/api/v1/status', headers: { cookie: `token=${token}` } });
  assert.equal(cookie.status, 401);

  const good = await call(port, { path: '/api/v1/status', token });
  assert.equal(good.status, 200);
  assert.equal(good.json.state, 'running');
  assert.ok(!JSON.stringify(none.json).includes(token) && !JSON.stringify(wrong.json).includes(token));
  // A refused request does not harm the node or later requests.
  assert.equal((await call(port, { path: '/api/v1/identity', token })).status, 200);
});

test('the Host rule: a request that names another host is refused, with the right token or without', async (t) => {
  const { port, token } = await startApiProcess(t);
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `rebind.test:${port}`]) {
    for (const bearer of [token, undefined]) {
      const answer = await call(port, { path: '/api/v1/status', token: bearer, headers: { host } });
      assert.equal(answer.status, 403, host);
      assert.equal(answer.json.error.code, 'forbidden_host');
    }
    assert.equal((await call(port, { path: '/', headers: { host } })).status, 403, `static ${host}`);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal((await call(port, { path: '/api/v1/status', token, headers: { host } })).status, 200, host);
  }
  const absolute = await rawSocket(port, `GET http://evil.example/api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
  assert.equal(statusOf(absolute), 403);
  // A page on another origin cannot even probe.
  const cross = await call(port, { path: '/api/v1/status', token, headers: { origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'forbidden_origin');
  assert.ok(!('access-control-allow-origin' in cross.headers));
});

test('input validation over HTTP: bad JSON, wrong type, unknown field, bad ids, big bodies', async (t) => {
  const { port, token } = await startApiProcess(t);
  const post = (path, options) => call(port, { method: 'POST', path: `/api/v1${path}`, token, ...options });
  const stranger = 'a'.repeat(51) + 'a';

  assert.equal((await post('/messages', { raw: '{' })).json.error.code, 'invalid_json');
  assert.equal((await post('/messages', { raw: '[1]' })).json.error.code, 'invalid_json');
  assert.equal((await post('/messages', { raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  const unknown = await post('/messages', { body: { to: stranger, text: 'x', cc: 1 } });
  assert.deepEqual([unknown.status, unknown.json.error.code, unknown.json.error.details.field], [400, 'invalid_request', 'cc']);
  const badId = await post('/messages', { body: { to: 'nope', text: 'x' } });
  assert.deepEqual([badId.status, badId.json.error.details.field], [400, 'to']);
  const wrongType = await post('/messages', { body: { to: stranger, text: ['x'] } });
  assert.deepEqual([wrongType.status, wrongType.json.error.details.field], [400, 'text']);
  const empty = await post('/messages', { body: { to: stranger, text: '' } });
  assert.equal(empty.status, 400);
  const big = await post('/messages', { raw: JSON.stringify({ to: stranger, text: 'a'.repeat(70_000) }) });
  assert.deepEqual([big.status, big.json.error.code], [413, 'body_too_large']);
  const unknownDestination = await post('/messages', { body: { to: stranger, text: 'hello' } });
  assert.deepEqual([unknownDestination.status, unknownDestination.json.error.code], [404, 'unknown_destination']);
  const refused = await post('/peers/connect', { body: { address: `tcp://127.0.0.1:${await closedPort()}` } });
  assert.deepEqual([refused.status, refused.json.error.code], [502, 'connect_failed']);
  assert.equal((await post('/peers/connect', { body: { address: 'localhost' } })).status, 400);

  for (const [path, field] of [['/outbox?limit=0', 'limit'], ['/conversations/nope', 'id'], ['/diag/events?types=NOPE', 'types']]) {
    const answer = await call(port, { path: `/api/v1${path}`, token });
    assert.deepEqual([answer.status, answer.json.error.details.field], [400, field], path);
  }
  assert.equal((await call(port, { path: '/api/v1/unknown', token })).status, 404);
  assert.equal((await call(port, { method: 'DELETE', path: '/api/v1/status', token })).status, 405);
  // After all of that the node still answers.
  assert.equal((await call(port, { path: '/api/v1/status', token })).status, 200);
});

test('the event stream resumes after a disconnect without loss or duplication, and says so when it cannot', async (t) => {
  const { port, token } = await startApiProcess(t);
  const dial = async () => {
    await call(port, { method: 'POST', path: '/api/v1/peers/connect', token, body: { address: `tcp://127.0.0.1:${await closedPort()}` } });
  };

  const first = await openStream(port, { token, query: '?types=peer.*' });
  const [hello] = await first.take(1);
  assert.equal(hello.type, 'stream.hello');
  assert.equal(hello.data.resumed, false);
  await dial();
  const seen = await first.take(2);
  assert.deepEqual(seen.map((event) => event.type), ['peer.dialing', 'peer.dial_failed']);
  assert.ok(seen.every((event) => event.id === `${hello.data.boot}-${event.data.seq}`));
  first.close();

  // Two more dials while no stream is open.
  await dial();
  await dial();
  const resumed = await openStream(port, { token, headers: { 'last-event-id': seen.at(-1).id }, query: '?types=peer.*' });
  t.after(() => resumed.close());
  const [again] = await resumed.take(1);
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.boot, hello.data.boot);
  const replay = await resumed.take(4);
  assert.deepEqual(replay.map((event) => event.type), ['peer.dialing', 'peer.dial_failed', 'peer.dialing', 'peer.dial_failed']);
  const all = [...seen, ...replay].map((event) => event.data.seq);
  assert.deepEqual(all, [...all].sort((x, y) => x - y), 'in order');
  assert.equal(new Set(all).size, 6, 'six distinct events: none lost, none twice');
  await dial();
  const live = await resumed.take(2);
  assert.deepEqual(live.map((event) => event.type), ['peer.dialing', 'peer.dial_failed']);
  assert.ok(live[0].data.seq > replay.at(-1).data.seq);

  // An id from another process life is a gap, not a silent skip.
  const restarted = await openStream(port, { token, headers: { 'last-event-id': 'deadbeef-3' }, query: '?types=peer.*' });
  t.after(() => restarted.close());
  const [, gap] = await restarted.take(2);
  assert.deepEqual([gap.type, gap.data], ['stream.gap', { reason: 'restart' }]);
});

test('POST /shutdown stops the process: the stream sees node.stopping, then ends, and the process exits with 0', async (t) => {
  const dir = await tempDir(t, 'e2e-shutdown');
  const home = join(dir, 'node');
  await initNode(home);
  const node = await startNode(t, home);
  const port = Number(new URL(node.ready.api).port);
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  const stream = await openStream(port, { token });
  await stream.take(1);
  const answer = await call(port, { method: 'POST', path: '/api/v1/shutdown', token, body: {} });
  assert.deepEqual([answer.status, answer.json], [202, { stopping: true }]);
  const [stopping] = await stream.take(1);
  assert.equal(stopping.type, 'node.stopping');
  await stream.waitClosed();
  assert.equal(await node.exited, 0);
});
