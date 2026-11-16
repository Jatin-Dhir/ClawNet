/**
 * The API client of the command line: the server-sent-events parser, request and error
 * handling against a small fake server, and finding a node through its data directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { ApiClient, SseParser } from '../../src/cli/client.js';
import { ApiError, CliError, ExitCode, NotRunningError } from '../../src/cli/errors.js';
import { tempDir } from '../helpers/tmp.js';

const TOKEN = 'ab'.repeat(32);

/** A fake API: `handler(req, res, body)` answers every request; the requests are recorded. */
async function fakeServer(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('SseParser splits events however the bytes arrive', () => {
  const stream = 'retry: 2000\n\nid: a-1\nevent: link.up\ndata: {"seq":1}\n\n: ka\n\nevent: x\ndata: one\ndata: two\n\n';
  const whole = new SseParser().feed(stream);
  assert.deepEqual(whole, [
    { id: 'a-1', type: 'link.up', data: '{"seq":1}' },
    { id: null, type: 'x', data: 'one\ntwo' },
  ]);
  // Every possible split point gives the same result.
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const parser = new SseParser();
    const events = [...parser.feed(stream.slice(0, cut)), ...parser.feed(stream.slice(cut))];
    assert.deepEqual(events, whole, `split at ${cut}`);
  }
  // Byte by byte, too.
  const slow = new SseParser();
  const bytes = [];
  for (const char of stream) bytes.push(...slow.feed(char));
  assert.deepEqual(bytes, whole);
});

test('SseParser accepts CRLF and CR line ends, ignores comments and unknown fields, and does not carry an id over', () => {
  const crlf = new SseParser().feed('id: 1\r\nevent: a\r\ndata: x\r\n\r\ndata: y\r\n\r\n');
  assert.deepEqual(crlf, [{ id: '1', type: 'a', data: 'x' }, { id: null, type: 'message', data: 'y' }]);
  const cr = new SseParser().feed('event: b\rdata: z\r\r');
  assert.deepEqual(cr, [{ id: null, type: 'b', data: 'z' }]);
  const split = new SseParser();
  assert.deepEqual([...split.feed('data: p\r'), ...split.feed('\n\r\n')], [{ id: null, type: 'message', data: 'p' }], 'a CRLF split between chunks is one line end');
  assert.deepEqual(new SseParser().feed(': only a comment\n\nretry: 5\nfoo: bar\n\n'), []);
  assert.deepEqual(new SseParser().feed('data:no space\n\ndata:  two spaces\n\n').map((e) => e.data), ['no space', ' two spaces']);
  assert.deepEqual(new SseParser().feed('event: only-a-type\n\n'), [{ id: null, type: 'only-a-type', data: '' }]);
  assert.deepEqual(new SseParser().feed('data: incomplete'), [], 'nothing until the blank line');
});

test('request sends the bearer token and JSON, and returns the parsed answer', async (t) => {
  const server = await fakeServer(t, (req, res) => json(res, 200, { ok: true }));
  const client = new ApiClient({ url: server.url, token: TOKEN });
  assert.equal(client.url, server.url);
  assert.deepEqual(await client.request('POST', '/messages?x=1', { to: 'a', text: 'é' }), { ok: true });
  assert.deepEqual(await client.request('GET', '/status'), { ok: true });
  const [post, getRequest] = server.seen;
  assert.equal(post.method, 'POST');
  assert.equal(post.url, '/api/v1/messages?x=1');
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { to: 'a', text: 'é' });
  assert.equal(Number(post.headers['content-length']), Buffer.byteLength(post.body));
  assert.equal(getRequest.headers['content-type'], undefined);
  assert.equal(getRequest.body, '');
  assert.equal(getRequest.headers.host, `127.0.0.1:${server.port}`);
  assert.equal(client.consoleUrl(), `${server.url}/#token=${TOKEN}`);
});

test('an error document becomes an ApiError carrying status, code and details', async (t) => {
  const server = await fakeServer(t, (req, res) => json(res, 404, { error: { code: 'unknown_destination', message: 'no card', details: { to: 'x' } } }));
  const client = new ApiClient({ url: server.url, token: TOKEN });
  await assert.rejects(client.request('POST', '/messages', {}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'unknown_destination');
    assert.deepEqual(error.details, { to: 'x' });
    assert.equal(error.message, 'unknown_destination: no card');
    assert.equal(error.exitCode, ExitCode.FAILURE);
    return true;
  });
});

test('answers that are not API answers are reported plainly', async (t) => {
  const server = await fakeServer(t, (req, res, body) => {
    if (req.url.endsWith('/html')) {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
    } else if (req.url.endsWith('/notjson')) {
      res.writeHead(200);
      res.end('plain');
    } else {
      res.writeHead(200);
      res.end(body);
    }
  });
  const client = new ApiClient({ url: server.url, token: TOKEN });
  await assert.rejects(client.request('GET', '/html'), (error) => error instanceof CliError && /not an API response/.test(error.message) && error.message.includes('502'));
  await assert.rejects(client.request('GET', '/notjson'), (error) => error instanceof CliError && /not JSON/.test(error.message));
});

test('a node that is not there is a NotRunningError (exit code 3), and a slow one times out', async (t) => {
  const closed = await new Promise((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const gone = new ApiClient({ url: `http://127.0.0.1:${closed}`, token: TOKEN });
  await assert.rejects(gone.request('GET', '/status'), (error) => error instanceof NotRunningError && error.exitCode === ExitCode.NOT_RUNNING && /ECONNREFUSED/.test(error.message));
  await assert.rejects((async () => { for await (const _ of gone.events()) assert.fail('no events'); })(), NotRunningError);

  const silent = await fakeServer(t, () => {});
  const slow = new ApiClient({ url: silent.url, token: TOKEN });
  await assert.rejects(slow.request('GET', '/status', undefined, { timeoutMs: 100 }), (error) => error instanceof CliError && /did not answer within 100 ms/.test(error.message));
});

test('the constructor accepts plain http URLs only', () => {
  assert.throws(() => new ApiClient({ url: 'nope', token: TOKEN }), CliError);
  assert.throws(() => new ApiClient({ url: 'https://127.0.0.1:1', token: TOKEN }), /http/);
  assert.equal(new ApiClient({ url: 'http://[::1]:47480', token: TOKEN }).url, 'http://[::1]:47480');
});

test('events() yields parsed events, passes types and Last-Event-ID, and ends when the stream ends', async (t) => {
  const server = await fakeServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: stream.hello\ndata: {"boot":"b"}\n\n');
    res.write('id: b-1\nevent: link.up\ndata: {"seq":1,"type":"link.up"}\n\n: ka\n\nevent: broken\ndata: {not json\n\n');
    res.end();
  });
  const client = new ApiClient({ url: server.url, token: TOKEN });
  const items = [];
  for await (const item of client.events({ types: ['link.*', 'topology.changed'], lastEventId: 'b-0' })) items.push(item);
  assert.deepEqual(items, [
    { id: null, type: 'stream.hello', event: { boot: 'b' } },
    { id: 'b-1', type: 'link.up', event: { seq: 1, type: 'link.up' } },
    { id: null, type: 'broken', event: null },
  ]);
  assert.equal(server.seen[0].url, '/api/v1/events?types=link.*%2Ctopology.changed');
  assert.equal(server.seen[0].headers['last-event-id'], 'b-0');
  assert.equal(server.seen[0].headers.accept, 'text/event-stream');
  assert.equal(server.seen[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('events() ends quietly when aborted and throws the node\'s error when the stream is refused', async (t) => {
  const server = await fakeServer(t, (req, res) => {
    if (req.headers['last-event-id'] === 'refuse') return json(res, 503, { error: { code: 'too_many_streams', message: 'full' } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.write('event: stream.hello\ndata: {}\n\n');
  });
  const client = new ApiClient({ url: server.url, token: TOKEN });
  const controller = new AbortController();
  const seen = [];
  for await (const item of client.events({ signal: controller.signal })) {
    seen.push(item.type);
    controller.abort();
  }
  assert.deepEqual(seen, ['stream.hello']);
  await assert.rejects((async () => { for await (const _ of client.events({ lastEventId: 'refuse' })) assert.fail('no events'); })(), (error) => error instanceof ApiError && error.code === 'too_many_streams');
  const early = new AbortController();
  early.abort();
  for await (const _ of client.events({ signal: early.signal })) assert.fail('aborted before it began');
});

test('fromDataDir finds the node through runtime.json and the token file', async (t) => {
  const dir = await tempDir(t, 'cli-client');
  await assert.rejects(ApiClient.fromDataDir(dir), (error) => error instanceof NotRunningError && error.message.includes(dir));

  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ pid: 1, api: null }));
  await assert.rejects(ApiClient.fromDataDir(dir), (error) => error instanceof CliError && !(error instanceof NotRunningError) && /without its control API/.test(error.message));

  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ pid: 1, api: 'http://127.0.0.1:9' }));
  await assert.rejects(ApiClient.fromDataDir(dir), (error) => error instanceof CliError && /API token/.test(error.message));

  await writeFile(join(dir, 'api-token'), `${TOKEN}\n`);
  const client = await ApiClient.fromDataDir(dir);
  assert.equal(client.url, 'http://127.0.0.1:9');
  assert.equal(client.consoleUrl(), `http://127.0.0.1:9/#token=${TOKEN}`);

  await writeFile(join(dir, 'runtime.json'), '{broken');
  await assert.rejects(ApiClient.fromDataDir(dir), (error) => error instanceof CliError && /cannot read/.test(error.message));
});
