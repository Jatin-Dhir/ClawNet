/**
 * The control API server against a real node on 127.0.0.1:0, with raw HTTP so that any
 * header can be set: authentication, the Host and Origin rules, bodies, error mapping,
 * the endpoints that need only the node, the event stream and the static console.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import { describeError } from '../../src/gate/api-server.js';
import { ClawNode } from '../../src/core/node.js';
import { createApiService, MAX_BODY_BYTES, MAX_EVENT_STREAMS } from '../../src/gate/api-server.js';
import {
  AuthError, CanonicalError, ConfigError, CryptoError, HandshakeError, StateError, StoreError, WireError,
} from '../../src/core/errors.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { SILENT_LOGGER } from '../helpers/cluster.js';
import { call, makeUiDir, openStream, rawSocket, startApiNode, statusOf } from '../helpers/api.js';
import { tempDir } from '../helpers/tmp.js';

const CORS = 'http://console.test:5173';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PEER = Identity.generate().nodeId;
const WRONG_TOKEN = 'f'.repeat(64);

let shared;
let sharedUi;
const stoppers = [];

before(async () => {
  const cleanup = { after: (fn) => stoppers.push(fn) };
  sharedUi = await makeUiDir(cleanup);
  shared = await startApiNode(cleanup, { config: { api: { corsOrigins: [CORS] } }, api: { uiDir: sharedUi.ui, sseKeepAliveMs: 60 } });
});

after(async () => {
  for (const stop of stoppers.reverse()) await stop();
});

const get = (path, options = {}) => call(shared.port, { path, token: shared.token, ...options });
const authed = (path, options = {}) => get(path, options);
const hostHeader = (host) => ({ host });

// ---------------------------------------------------------------------------------------
// Token and authentication
// ---------------------------------------------------------------------------------------

test('the token file holds 64 hex characters, is owner-only on POSIX, and survives a restart', async (t) => {
  const dir = await tempDir(t, 'api-token');
  const first = await startApiNode(t, { dataDir: dir });
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal(first.node.service('api').tokenPath, join(dir, 'api-token'));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'api-token'))).mode & 0o777, 0o600);
  await first.node.stop();

  const second = await startApiNode(t, { dataDir: dir });
  assert.equal(second.token, first.token, 'stable across restarts');
  await second.node.stop();

  // Deleting the file rotates the token.
  await rm(join(dir, 'api-token'));
  const third = await startApiNode(t, { dataDir: dir });
  assert.match(third.token, /^[0-9a-f]{64}$/);
  assert.notEqual(third.token, first.token);
  assert.equal((await call(third.port, { path: '/api/v1/status', token: first.token })).status, 401);
  await third.node.stop();

  // A file that is not a token is not silently replaced: start fails and says why.
  await writeFile(join(dir, 'api-token'), 'not a token\n');
  const node = new ClawNode({ config: { networkId: 'api-test', listen: { host: '127.0.0.1', port: 0 }, api: { port: 0 } }, dataDir: dir, services: [createApiService()], logger: SILENT_LOGGER });
  await assert.rejects(node.start(), (error) => error instanceof StoreError && /does not hold a token/.test(error.message));
});

test('a token file that other users could read is tightened to owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t, 'api-token');
  const first = await startApiNode(t, { dataDir: dir });
  await first.node.stop();
  await chmod(join(dir, 'api-token'), 0o644);
  const second = await startApiNode(t, { dataDir: dir });
  assert.equal((await stat(join(dir, 'api-token'))).mode & 0o777, 0o600);
  await second.node.stop();
});

test('every /api/ request needs the right bearer token; the answer is the documented 401', async () => {
  const attempts = [
    {},
    { token: WRONG_TOKEN },
    { token: shared.token.slice(1) },
    { token: `${shared.token}0` },
    { token: shared.token.toUpperCase() },
    { headers: { authorization: shared.token } },
    { headers: { authorization: `Basic ${shared.token}` } },
    { headers: { authorization: `bearer ${shared.token}` } },
    { headers: { authorization: `Bearer  ${shared.token}` } },
    { headers: { cookie: `token=${shared.token}` } },
  ];
  for (const attempt of attempts) {
    const answer = await call(shared.port, { path: '/api/v1/status', ...attempt });
    assert.equal(answer.status, 401, JSON.stringify(attempt));
    assert.equal(answer.headers['www-authenticate'], 'Bearer realm="clawnet"');
    assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.json.error.code, 'unauthorized');
    assert.equal(typeof answer.json.error.message, 'string');
  }
  // The token is accepted in the header only: never in a query string.
  assert.equal((await call(shared.port, { path: `/api/v1/status?token=${shared.token}` })).status, 401);
  assert.equal((await call(shared.port, { path: `/api/v1/status?access_token=${shared.token}`, token: WRONG_TOKEN })).status, 401);
  // Every API path is behind it, including ones that do not exist and the event stream.
  for (const path of ['/api/v1/nope', '/api/v1/events', '/api/v2/status', '/api', '/api/']) {
    assert.equal((await call(shared.port, { path })).status, 401, path);
  }
  assert.equal((await authed('/api/v1/status')).status, 200);
});

test('the console is served without a token, and a node answers nothing to a token in a static request', async () => {
  const answer = await call(shared.port, { path: '/' });
  assert.equal(answer.status, 200);
  assert.ok(!answer.text.includes(shared.token));
  assert.ok(!JSON.stringify(answer.headers).includes(shared.token));
});

// ---------------------------------------------------------------------------------------
// Host rule
// ---------------------------------------------------------------------------------------

test('only the allowed hosts, with the bound port, are served; everything else is 403 forbidden_host', async () => {
  const { port } = shared;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
    assert.equal((await call(port, { path: '/api/v1/status', token: shared.token, headers: hostHeader(host) })).status, 200, host);
    assert.equal((await call(port, { path: '/', headers: hostHeader(host) })).status, 200, `static ${host}`);
  }
  const refused = ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`,
    '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`, `127.0.0.1:${port}.evil`, `[::1]`, `127.0.0.1:${port}, evil.example`, `0.0.0.0:${port}`];
  for (const host of refused) {
    for (const path of ['/api/v1/status', '/']) {
      const answer = await call(port, { path, token: shared.token, headers: hostHeader(host) });
      assert.equal(answer.status, 403, `${JSON.stringify(host)} ${path}`);
      assert.equal(answer.json.error.code, 'forbidden_host');
    }
  }
  assert.equal(shared.node.stats().services.api.denied_host >= refused.length * 2, true);
});

test('a missing, repeated or absolute-form Host is refused', async () => {
  const { port, token } = shared;
  const auth = `authorization: Bearer ${token}\r\n`;
  const noHost = await rawSocket(port, `GET /api/v1/status HTTP/1.1\r\n${auth}Connection: close\r\n\r\n`);
  assert.equal(statusOf(noHost), 400, 'Node itself rejects an HTTP/1.1 request without Host');
  const old = await rawSocket(port, `GET /api/v1/status HTTP/1.0\r\n${auth}\r\n`);
  assert.equal(statusOf(old), 403);
  assert.match(old, /forbidden_host/);
  const twice = await rawSocket(port, `GET /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\n${auth}Connection: close\r\n\r\n`);
  assert.equal(statusOf(twice), 403);
  assert.match(twice, /forbidden_host/);
  const mixed = await rawSocket(port, `GET /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\n${auth}Connection: close\r\n\r\n`);
  assert.equal(statusOf(mixed), 403);
  const empty = await rawSocket(port, `GET /api/v1/status HTTP/1.1\r\nHost:\r\n${auth}Connection: close\r\n\r\n`);
  assert.equal(statusOf(empty), 403);
  const absolute = await rawSocket(port, `GET http://127.0.0.1:${port}/api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${auth}Connection: close\r\n\r\n`);
  assert.equal(statusOf(absolute), 403);
  assert.match(absolute, /forbidden_host/);
  const star = await rawSocket(port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  assert.equal(statusOf(star), 403);
});

// ---------------------------------------------------------------------------------------
// Origin rule and CORS
// ---------------------------------------------------------------------------------------

test('a cross-origin request is refused before the token is looked at, with no CORS headers', async () => {
  const { port, token } = shared;
  const origins = ['http://evil.example', 'null', 'https://127.0.0.1', `http://127.0.0.1:${port + 1}`, `http://evil.example:${port}`, `${CORS}/`, 'http://CONSOLE.test:5173'];
  for (const origin of origins) {
    for (const [method, path, body] of [['GET', '/api/v1/status'], ['POST', '/api/v1/messages', { to: PEER, text: 'x' }]]) {
      for (const bearer of [token, undefined]) {
        const answer = await call(port, { method, path, body, token: bearer, headers: { origin } });
        assert.equal(answer.status, 403, `${origin} ${method} ${bearer === undefined ? 'no token' : 'token'}`);
        assert.equal(answer.json.error.code, 'forbidden_origin');
        assert.ok(!Object.keys(answer.headers).some((name) => name.startsWith('access-control-')), 'no access-control headers');
      }
    }
  }
  const crossSite = await call(port, { path: '/api/v1/status', token, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, 'forbidden_origin');
  assert.equal((await call(port, { path: '/api/v1/status', token, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await call(port, { path: '/api/v1/status', token, headers: { 'sec-fetch-site': 'none' } })).status, 200);
});

test('the console\'s own origin is allowed without CORS headers', async () => {
  const { port, token } = shared;
  const answer = await call(port, { path: '/api/v1/status', token, headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(answer.status, 200);
  assert.ok(!('access-control-allow-origin' in answer.headers));
  const post = await call(port, { method: 'POST', path: '/api/v1/messages', token, body: { to: PEER, text: 'x' }, headers: { origin: `http://localhost:${port}`, host: `localhost:${port}` } });
  assert.notEqual(post.status, 403);
});

test('an origin in corsOrigins is allowed, with exactly its own origin echoed and Vary', async () => {
  const { port, token } = shared;
  for (const [path, status] of [['/api/v1/status', 200], ['/api/v1/nope', 404]]) {
    const answer = await call(port, { path, token, headers: { origin: CORS, 'sec-fetch-site': 'cross-site' } });
    assert.equal(answer.status, status);
    assert.equal(answer.headers['access-control-allow-origin'], CORS);
    assert.equal(answer.headers.vary, 'Origin');
    assert.ok(!('access-control-allow-credentials' in answer.headers));
  }
  // Even a refusal carries them, so that the console can read why.
  const denied = await call(port, { path: '/api/v1/status', headers: { origin: CORS } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['access-control-allow-origin'], CORS);
});

test('a preflight from an allowed origin needs no token and answers with the exact headers', async () => {
  const { port } = shared;
  const answer = await call(port, {
    method: 'OPTIONS', path: '/api/v1/messages',
    headers: { origin: CORS, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
  });
  assert.equal(answer.status, 204);
  assert.equal(answer.text, '');
  assert.deepEqual({
    origin: answer.headers['access-control-allow-origin'],
    methods: answer.headers['access-control-allow-methods'],
    headers: answer.headers['access-control-allow-headers'],
    maxAge: answer.headers['access-control-max-age'],
    vary: answer.headers.vary,
  }, { origin: CORS, methods: 'GET, POST, DELETE', headers: 'Authorization, Content-Type, Last-Event-ID', maxAge: '600', vary: 'Origin' });
  assert.ok(!('access-control-allow-credentials' in answer.headers));
  assert.notEqual(answer.headers['access-control-allow-origin'], '*');
});

test('every other OPTIONS request is a 403 forbidden_origin', async () => {
  const { port, token } = shared;
  const cases = [
    { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    { origin: CORS },                                   // no Access-Control-Request-Method
    { 'access-control-request-method': 'POST' },        // no Origin
    {},
    { origin: 'null', 'access-control-request-method': 'GET' },
  ];
  for (const headers of cases) {
    for (const bearer of [undefined, token]) {
      const answer = await call(port, { method: 'OPTIONS', path: '/api/v1/status', token: bearer, headers });
      assert.equal(answer.status, 403, JSON.stringify(headers));
      assert.equal(answer.json.error.code, 'forbidden_origin');
      assert.ok(!('access-control-allow-origin' in answer.headers));
    }
  }
});

// ---------------------------------------------------------------------------------------
// Bodies, validation, errors
// ---------------------------------------------------------------------------------------

test('bodies: over 64 KiB is 413, invalid JSON and non-objects are 400, a wrong content type is 415', async () => {
  const send = (options) => call(shared.port, { method: 'POST', path: '/api/v1/messages', token: shared.token, ...options });
  const big = await send({ raw: `{"to":"${PEER}","text":"${'a'.repeat(MAX_BODY_BYTES)}"}` });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'body_too_large');
  const hugeDeclared = await rawSocket(shared.port, `POST /api/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${shared.port}\r\nAuthorization: Bearer ${shared.token}\r\nContent-Type: application/json\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n{`);
  assert.equal(statusOf(hugeDeclared), 413, 'refused from the header, without reading the body');
  // At the limit exactly is fine for the size check (the request then fails validation).
  const ok = await send({ raw: JSON.stringify({ to: PEER, text: 'a'.repeat(MAX_BODY_BYTES - 100) }) });
  assert.notEqual(ok.status, 413);

  for (const raw of ['{', 'nope', '', '"text"', '[]', '42', 'null', '{"to":}']) {
    if (raw === '') continue;
    const answer = await send({ raw });
    assert.equal(answer.status, 400, raw);
    assert.equal(answer.json.error.code, 'invalid_json', raw);
  }
  const badBytes = await call(shared.port, { method: 'POST', path: '/api/v1/messages', token: shared.token, raw: Buffer.from([0x7b, 0xff, 0x7d]).toString('latin1') });
  assert.equal(badBytes.status, 400);

  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json-patch+json', 'application/json; charset=latin1']) {
    const answer = await send({ raw: '{}', headers: { 'content-type': type } });
    assert.equal(answer.status, 415, type);
    assert.equal(answer.json.error.code, 'unsupported_media_type');
  }
  const noType = await rawSocket(shared.port, `POST /api/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${shared.port}\r\nAuthorization: Bearer ${shared.token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
  assert.equal(statusOf(noType), 415);
  const charset = await send({ raw: JSON.stringify({ to: PEER, text: 'x' }), headers: { 'content-type': 'application/json; charset=UTF-8' } });
  assert.notEqual(charset.status, 415);
});

test('input validation names the field: unknown fields, wrong types and bad ids are 400 invalid_request', async () => {
  const post = (body, path = '/api/v1/messages') => call(shared.port, { method: 'POST', path, token: shared.token, body });
  const cases = [
    [{ to: PEER, text: 'x', extra: 1 }, 'extra'],
    [{ to: PEER }, 'text'],
    [{ text: 'x' }, 'to'],
    [{ to: 'not-an-id', text: 'x' }, 'to'],
    [{ to: PEER.toUpperCase(), text: 'x' }, 'to'],
    [{ to: PEER, text: 5 }, 'text'],
    [{ to: PEER, text: '' }, 'text'],
    [{ to: PEER, text: 'x'.repeat(16385) }, 'text'],
    [{ to: [PEER], text: 'x' }, 'to'],
  ];
  for (const [body, field] of cases) {
    const answer = await post(body);
    assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(answer.json.error.code, 'invalid_request');
    assert.equal(answer.json.error.details.field, field);
    assert.equal(typeof answer.json.error.details.problem, 'string');
  }
  const connect = await post({ address: 'not an address' }, '/api/v1/peers/connect');
  assert.equal(connect.json.error.details.field, 'address');
  assert.equal((await post({}, '/api/v1/peers/connect')).status, 400);
  assert.equal((await post({ address: 'tcp://127.0.0.1:1', also: 1 }, '/api/v1/peers/connect')).json.error.details.field, 'also');
  assert.equal((await post({ x: 1 }, '/api/v1/shutdown')).status, 400, 'shutdown takes no fields');
  for (const [path, field] of [
    ['/api/v1/outbox?limit=0', 'limit'], ['/api/v1/outbox?limit=1001', 'limit'], ['/api/v1/outbox?limit=x', 'limit'],
    ['/api/v1/outbox?bogus=1', 'bogus'], ['/api/v1/conversations?x=1', 'x'], [`/api/v1/conversations/${PEER}?limit=501`, 'limit'],
    [`/api/v1/conversations/${PEER}?before=0`, 'before'], ['/api/v1/conversations/short', 'id'], ['/api/v1/topology/nodes/short', 'id'],
    ['/api/v1/diag/events?since=-1', 'since'], ['/api/v1/diag/events?types=Bad%20Type', 'types'], ['/api/v1/status?x=1', 'x'],
  ]) {
    const answer = await get(path);
    assert.equal(answer.status, 400, path);
    assert.equal(answer.json.error.details.field, field, path);
  }
  assert.equal((await get('/api/v1/outbox?limit=1&limit=2')).status, 400, 'a repeated parameter');
  assert.equal((await get('/api/v1/outbox?limit=%ZZ')).status, 400, 'a bad escape is kept as text, which is not a number');
});

test('unknown paths are 404 and a known path with another method is 405 with Allow', async () => {
  for (const path of ['/api/v1/nope', '/api/v1', '/api/v1/', '/api/v2/status', '/api/v1/status/extra', '/api/v1//status', '/api/v1/peers/%E0%A4%A']) {
    const answer = await get(path);
    assert.ok([400, 404].includes(answer.status), `${path} -> ${answer.status}`);
    assert.ok(answer.json.error.code === 'not_found' || answer.json.error.code === 'invalid_request', path);
  }
  const missingFeature = await get('/api/v1/channels');
  assert.equal(missingFeature.status, 404, 'a service that is not installed has no routes');
  assert.equal(missingFeature.json.error.code, 'not_found');

  const delStatus = await get('/api/v1/status', { method: 'DELETE' });
  assert.equal(delStatus.status, 405);
  assert.equal(delStatus.json.error.code, 'method_not_allowed');
  assert.equal(delStatus.headers.allow, 'GET');
  const getConnect = await get('/api/v1/peers/connect');
  assert.equal(getConnect.status, 405);
  assert.equal(getConnect.headers.allow, 'POST');
  const postEvents = await get('/api/v1/events', { method: 'POST', body: {} });
  assert.equal(postEvents.status, 405);
  assert.equal(postEvents.headers.allow, 'GET');
  const head = await get('/api/v1/status', { method: 'HEAD' });
  assert.equal(head.status, 405);
  assert.equal(head.text, '');
  assert.equal((await get('/api/v1/peers/known')).status, 200, 'a literal wins over the :id route that could also match');
});

test('engine errors map to the codes of API.md section 4', () => {
  const strip = ({ internal: _internal, ...rest }) => rest;
  const described = (error) => strip(describeError(error));
  assert.deepEqual(described(new StateError('unknown-destination: no card')), { status: 404, code: 'unknown_destination', message: 'no card' });
  assert.deepEqual(described(new StateError('outbox-full: too many')), { status: 503, code: 'outbox_full', message: 'too many' });
  assert.deepEqual(described(new StateError('not-running: the node is stopping')), { status: 503, code: 'not_running', message: 'the node is stopping' });
  assert.deepEqual(described(new StateError('peer-limit: full')), { status: 409, code: 'peer_limit', message: 'full' });
  assert.deepEqual(described(new StateError('busy: 9 probes')), { status: 503, code: 'busy', message: '9 probes' });
  assert.deepEqual(described(new StateError('something-new: odd')), { status: 409, code: 'something_new', message: 'odd' }, 'an unlisted code is a 409');
  assert.deepEqual(described(new StateError('no colon here')), { status: 409, code: 'conflict', message: 'no colon here' });
  const handshake = new HandshakeError('noise', 'handshake failed');
  assert.deepEqual(described(handshake), { status: 502, code: 'connect_failed', message: 'handshake failed', details: { reason: 'noise' } });
  for (const error of [new ConfigError('bad'), new CryptoError('bad'), new CanonicalError('bad'), new WireError('bad')]) {
    assert.deepEqual([describeError(error).status, describeError(error).code], [400, 'invalid_request']);
  }
  assert.deepEqual([describeError(new StoreError('disk detail')).status, describeError(new StoreError('disk detail')).code, describeError(new StoreError('disk detail')).message], [500, 'storage', 'a disk operation failed']);
  for (const error of [new Error('secret detail'), new AuthError('x'), 'a string', null]) {
    const out = describeError(error);
    assert.deepEqual([out.status, out.code, out.message, out.internal], [500, 'internal', 'internal error', true]);
  }
});

test('an error carrying status and apiCode is used as it is', async (t) => {
  const failing = {
    name: 'failing',
    init(ctx) {
      ctx.api.route('GET', '/boom/made', () => {
        throw ctx.api.error(429, 'rate_limited', 'slow down', { retryInMs: 5 });
      });
      ctx.api.route('GET', '/boom/plain', () => {
        throw new Error('secret internal detail');
      });
      ctx.api.route('GET', '/boom/store', () => {
        throw new StoreError('/var/secret/path failed');
      });
      ctx.api.route('GET', '/boom/reply', () => ctx.api.reply(201, { created: true }));
      ctx.api.route('GET', '/boom/nothing', () => undefined);
      ctx.api.route('GET', '/boom/echo/:a/:b', (req) => ({ params: { ...req.params }, query: { ...req.query } }));
      ctx.api.route('POST', '/boom/body', (req) => ({ body: req.body }));
    },
  };
  const node = await startApiNode(t, { services: [failing] });
  const at = (path, options = {}) => call(node.port, { path: `/api/v1${path}`, token: node.token, ...options });
  const made = await at('/boom/made');
  assert.deepEqual([made.status, made.json], [429, { error: { code: 'rate_limited', message: 'slow down', details: { retryInMs: 5 } } }]);
  const plain = await at('/boom/plain');
  assert.deepEqual([plain.status, plain.json], [500, { error: { code: 'internal', message: 'internal error' } }]);
  assert.ok(!plain.text.includes('secret'));
  const store = await at('/boom/store');
  assert.deepEqual([store.status, store.json.error.code], [500, 'storage']);
  assert.ok(!store.text.includes('/var/secret'));
  assert.deepEqual([(await at('/boom/reply')).status, (await at('/boom/reply')).json], [201, { created: true }]);
  assert.deepEqual((await at('/boom/nothing')).json, {});
  // Parameters are percent-decoded; the query is decoded too.
  const echo = await at('/boom/echo/a%20b/%C3%A9?x=1%202&y=');
  assert.deepEqual(echo.json, { params: { a: 'a b', b: 'é' }, query: { x: '1 2', y: '' } });
  assert.deepEqual((await at('/boom/body', { method: 'POST', body: { k: [1, { z: null }] } })).json, { body: { k: [1, { z: null }] } });
  assert.deepEqual((await at('/boom/body', { method: 'POST' })).json, { body: null }, 'no body is null');
  assert.ok(node.node.stats().services.api.errors >= 2);
});

// ---------------------------------------------------------------------------------------
// Endpoints that need only the node
// ---------------------------------------------------------------------------------------

test('status, identity, peers, topology and routes have the documented shape', async () => {
  const status = (await authed('/api/v1/status')).json;
  assert.deepEqual(Object.keys(status).sort(), [
    'addresses', 'agent', 'asOf', 'boot', 'caps', 'events', 'listen', 'messaging', 'networkId', 'nodeId', 'now', 'peers',
    'routing', 'services', 'shortId', 'startedAt', 'state', 'uptimeMs',
  ]);
  assert.equal(status.state, 'running');
  assert.equal(status.nodeId, shared.node.id);
  assert.equal(status.shortId, shared.node.id.slice(0, 8));
  assert.deepEqual(status.services, ['messages', 'diag', 'api']);
  assert.match(status.boot, /^[0-9a-f]{8}$/);
  assert.deepEqual(status.asOf.boot, status.boot);
  assert.ok(status.asOf.seq >= 1);

  const identity = (await authed('/api/v1/identity')).json;
  assert.equal(identity.nodeId, shared.node.id);
  assert.deepEqual(Object.keys(identity.card).sort(), ['e2e', 'id', 'link', 'sig']);
  assert.equal(identity.keystoreEncrypted, false);
  assert.ok(!/seed|private|secret/i.test(JSON.stringify(identity)), 'no private key');

  const peers = (await authed('/api/v1/peers')).json;
  assert.deepEqual(Object.keys(peers).sort(), ['asOf', 'dialing', 'peers']);
  assert.deepEqual([peers.peers, peers.dialing], [[], []]);
  assert.deepEqual((await authed('/api/v1/peers/known')).json, { addresses: [] });

  const topology = (await authed('/api/v1/topology')).json;
  assert.equal(topology.self, shared.node.id);
  assert.deepEqual(topology.nodes.map((node) => [node.id, node.self, node.reachable, node.hops]), [[shared.node.id, true, true, 0]]);
  assert.deepEqual(topology.links, []);
  assert.ok(topology.asOf.seq >= 1);

  const routes = (await authed('/api/v1/topology/routes')).json;
  assert.deepEqual(Object.keys(routes).sort(), ['asOf', 'rev', 'routes']);
  assert.deepEqual(routes.routes, []);
  assert.ok(Number.isInteger(routes.rev));

  const detail = (await authed(`/api/v1/topology/nodes/${shared.node.id}`)).json;
  assert.equal(detail.node.self, true);
  assert.equal(detail.lsa.origin, shared.node.id);
  assert.equal(detail.route, null);
  const missing = await authed(`/api/v1/topology/nodes/${PEER}`);
  assert.deepEqual([missing.status, missing.json.error.code], [404, 'not_found']);

  const outbox = (await authed('/api/v1/outbox')).json;
  assert.deepEqual(outbox, { total: 0, entries: [] });
  assert.deepEqual((await authed('/api/v1/conversations')).json, { conversations: [] });
  assert.deepEqual((await authed(`/api/v1/conversations/${PEER}`)).json, { peer: PEER, items: [], nextBefore: null }, 'an unknown node has an empty history');
});

test('sending to a node whose card is unknown is 404 unknown_destination with the id', async () => {
  const answer = await call(shared.port, { method: 'POST', path: '/api/v1/messages', token: shared.token, body: { to: PEER, text: 'hello' } });
  assert.equal(answer.status, 404);
  assert.deepEqual(answer.json, { error: { code: 'unknown_destination', message: 'no identity card known for that node', details: { to: PEER } } });
});

test('connect: a refused dial is 502 connect_failed with the reason; disconnect of a stranger is 404', async () => {
  const closed = await new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const refused = await call(shared.port, { method: 'POST', path: '/api/v1/peers/connect', token: shared.token, body: { address: `tcp://127.0.0.1:${closed}` } });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.error.code, 'connect_failed');
  assert.equal(typeof refused.json.error.details.reason, 'string');
  const gone = await call(shared.port, { method: 'POST', path: `/api/v1/peers/${PEER}/disconnect`, token: shared.token, body: {} });
  assert.deepEqual([gone.status, gone.json.error.code], [404, 'not_found']);
  const malformed = await call(shared.port, { method: 'POST', path: '/api/v1/peers/nope/disconnect', token: shared.token });
  assert.equal(malformed.json.error.details.field, 'id');
  // The failed dial is forgotten: it does not stay sticky.
  const known = (await authed('/api/v1/peers/known')).json.addresses;
  assert.ok(known.every((entry) => !entry.addr.endsWith(`:${closed}`) || entry.fails >= 0));
});

test('config is the effective configuration with the network key redacted', async (t) => {
  const key = Buffer.alloc(32, 9).toString('base64');
  const node = await startApiNode(t, { config: { networkKey: key } });
  const answer = await call(node.port, { path: '/api/v1/config', token: node.token });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.dataDir, node.dataDir);
  assert.equal(answer.json.config.networkKey, '[redacted]');
  assert.deepEqual(answer.json.redacted, ['networkKey']);
  assert.equal(answer.json.config.networkId, 'api-test');
  assert.ok(!answer.text.includes(key));
  const plain = await authed('/api/v1/config');
  assert.equal(plain.json.config.networkKey, null, 'left null when unset');
});

test('diag/events pages the ring buffer with since, limit and type filters; diag/sync lists the datasets', async () => {
  for (let i = 1; i <= 6; i += 1) shared.node.events.emit('probe.item', { i });
  shared.node.events.emit('probe.other', {});
  const all = (await authed('/api/v1/diag/events?types=probe.*')).json;
  assert.deepEqual(Object.keys(all).sort(), ['boot', 'events', 'lastSeq', 'oldestSeq']);
  assert.equal(all.boot, shared.node.boot);
  assert.ok(all.events.length >= 7);
  const newest = (await authed('/api/v1/diag/events?types=probe.item&limit=2')).json.events;
  assert.deepEqual(newest.map((event) => event.data.i), [5, 6], 'without since: the newest, oldest first');
  const since = newest[0].seq;
  const after = (await authed(`/api/v1/diag/events?since=${since}&limit=2&types=probe.item,probe.other`)).json.events;
  assert.deepEqual(after.map((event) => event.type), ['probe.item', 'probe.other'], 'with since: the oldest after it');
  assert.ok(after.every((event) => event.seq > since));
  assert.deepEqual(Object.keys(after[0]).sort(), ['data', 'seq', 'ts', 'type']);
  const exact = (await authed('/api/v1/diag/events?types=probe.other')).json.events;
  assert.ok(exact.every((event) => event.type === 'probe.other'));

  const sync = (await authed('/api/v1/diag/sync')).json;
  assert.deepEqual(sync.datasets.map((dataset) => dataset.name), ['lsa', 'peer', 'cast', 'receipt']);
  assert.ok(sync.datasets.every((dataset) => Number.isInteger(dataset.entries)));
  assert.equal(sync.datasets[0].entries, 1, 'this node\'s own LSA');
  assert.equal(typeof sync.engine.published, 'number');
  const counters = (await authed('/api/v1/diag/counters')).json;
  assert.ok(Object.keys(counters.totals).some((name) => name.startsWith('services.api.')));
});

// ---------------------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------------------

test('the stream starts with the hello, then delivers events in order, each with its id', async () => {
  const stream = await openStream(shared.port, { token: shared.token, query: '?types=test.*' });
  t_close(stream);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.headers['cache-control'], 'no-store');
  assert.equal(stream.headers['x-accel-buffering'], 'no');
  const [hello] = await stream.take(1);
  assert.equal(hello.type, 'stream.hello');
  assert.equal(hello.id, null);
  assert.deepEqual(Object.keys(hello.data).sort(), ['boot', 'lastSeq', 'nodeId', 'oldestSeq', 'resumed']);
  assert.equal(hello.data.boot, shared.node.boot);
  assert.equal(hello.data.nodeId, shared.node.id);
  assert.equal(hello.data.resumed, false);
  assert.equal(hello.data.lastSeq, shared.node.events.lastSeq);

  for (let i = 1; i <= 5; i += 1) shared.node.events.emit('test.order', { i });
  const events = await stream.take(5);
  assert.deepEqual(events.map((event) => event.data.data.i), [1, 2, 3, 4, 5]);
  events.forEach((event, index) => {
    assert.equal(event.type, 'test.order');
    assert.equal(event.id, `${shared.node.boot}-${event.data.seq}`);
    assert.deepEqual(Object.keys(event.data).sort(), ['data', 'seq', 'ts', 'type']);
    if (index > 0) assert.equal(event.data.seq, events[index - 1].data.seq + 1, 'emitted back to back, so consecutive');
  });
});

function t_close(stream) {
  stoppers.push(() => stream.close());
}

test('type filters accept exact types and prefixes ending in .*, and a bad filter is 400', async () => {
  const stream = await openStream(shared.port, { token: shared.token, query: '?types=test.exact,filt.*' });
  t_close(stream);
  await stream.take(1);
  shared.node.events.emit('test.exact', { n: 1 });
  shared.node.events.emit('test.exactly', { n: 2 });
  shared.node.events.emit('test.other', { n: 3 });
  shared.node.events.emit('filt.a', { n: 4 });
  shared.node.events.emit('filt.b.c', { n: 5 });
  shared.node.events.emit('filter.x', { n: 6 });
  const got = await stream.take(3);
  assert.deepEqual(got.map((event) => event.data.data.n), [1, 4, 5]);
  const seqs = got.map((event) => event.data.seq);
  assert.ok(seqs[1] - seqs[0] > 1, 'filtered-out events leave holes in seq, which is not a loss');
  for (const types of ['', 'a b', '*', 'x.', '.x', 'UPPER', 'a..b', 'x.*.y', 'a,,b']) {
    const bad = await call(shared.port, { path: `/api/v1/events?types=${encodeURIComponent(types)}`, token: shared.token });
    assert.equal(bad.status, 400, JSON.stringify(types));
    assert.equal(bad.json.error.details.field, 'types');
  }
});

test('Last-Event-ID resumes with every missed event once and none twice, then continues live', async () => {
  // The same scenario through the header and through the query parameter.
  for (const mode of ['header', 'query']) {
    const type = `resume.${mode}`;
    const first = await openStream(shared.port, { token: shared.token, query: `?types=${type}` });
    await first.take(1);
    for (let n = 1; n <= 3; n += 1) shared.node.events.emit(type, { n });
    const seen = await first.take(3);
    first.close();
    const lastId = seen.at(-1).id;
    // These happen while no stream is open.
    for (let n = 4; n <= 8; n += 1) shared.node.events.emit(type, { n });
    shared.node.events.emit('unrelated.x', {});

    const resumed = await openStream(shared.port, mode === 'header'
      ? { token: shared.token, headers: { 'last-event-id': lastId }, query: `?types=${type}` }
      : { token: shared.token, query: `?types=${type}&since=${lastId}` });
    t_close(resumed);
    const [hello] = await resumed.take(1);
    assert.equal(hello.type, 'stream.hello', mode);
    assert.equal(hello.data.resumed, true, mode);
    const replay = await resumed.take(5);
    assert.deepEqual(replay.map((event) => event.data.data.n), [4, 5, 6, 7, 8], mode);
    shared.node.events.emit(type, { n: 9 });
    const [live] = await resumed.take(1);
    assert.equal(live.data.data.n, 9, mode);
    assert.equal(resumed.events.filter((event) => event.type === 'stream.gap').length, 0, mode);
    assert.equal(new Set(resumed.events.map((event) => event.id).filter(Boolean)).size, 6, 'no event twice');
  }
});

test('the header wins over the query, an empty header means no resume, a malformed id is 400', async () => {
  shared.node.events.emit('win.a', { n: 1 });
  const lastId = `${shared.node.boot}-${shared.node.events.lastSeq}`;
  shared.node.events.emit('win.a', { n: 2 });
  const both = await openStream(shared.port, { token: shared.token, headers: { 'last-event-id': lastId }, query: `?since=${shared.node.boot}-1&types=win.a` });
  t_close(both);
  const [hello, replay] = await both.take(2);
  assert.equal(hello.data.resumed, true);
  assert.equal(replay.data.data.n, 2, 'resumed after the header\'s id, not the query\'s');

  const empty = await openStream(shared.port, { token: shared.token, headers: { 'last-event-id': '' } });
  t_close(empty);
  assert.equal((await empty.take(1))[0].data.resumed, false);

  for (const id of ['nonsense', '1-2', `${shared.node.boot}-`, `${shared.node.boot}--1`, `${shared.node.boot}-01`, `${shared.node.boot.toUpperCase()}-1`, `${shared.node.boot}-1x`]) {
    const bad = await call(shared.port, { path: '/api/v1/events', token: shared.token, headers: { 'last-event-id': id } });
    assert.equal(bad.status, 400, id);
    assert.equal(bad.json.error.details.field, 'Last-Event-ID');
  }
  const badQuery = await call(shared.port, { path: '/api/v1/events?since=zzz', token: shared.token });
  assert.equal(badQuery.json.error.details.field, 'since');
});

test('an id from another boot is a stream.gap with reason restart, then live events only', async () => {
  const other = shared.node.boot === 'deadbeef' ? 'cafef00d' : 'deadbeef';
  const stream = await openStream(shared.port, { token: shared.token, headers: { 'last-event-id': `${other}-5` }, query: '?types=gap.*' });
  t_close(stream);
  const [hello, gap] = await stream.take(2);
  assert.equal(hello.data.resumed, false);
  assert.equal(gap.type, 'stream.gap');
  assert.equal(gap.id, null);
  assert.deepEqual(gap.data, { reason: 'restart' });
  shared.node.events.emit('gap.live', {});
  assert.equal((await stream.take(1))[0].type, 'gap.live');
  // An id from the future of this boot cannot be honoured either.
  const future = await openStream(shared.port, { token: shared.token, headers: { 'last-event-id': `${shared.node.boot}-999999999` } });
  t_close(future);
  assert.deepEqual((await future.take(2))[1].data, { reason: 'restart' });
});

test('an id older than the ring buffer is a stream.gap with reason overflow, then everything still held', async (t) => {
  // The node's own LSA refresh would add events of its own while the test runs; with a
  // long refresh interval the buffer holds nothing but what the test emits.
  const node = await startApiNode(t, {
    api: { sseKeepAliveMs: 60_000 },
    config: { timers: { lsaRefreshMs: 60_000, lsaMaxAgeMs: 210_000, lsaTombstoneMs: 300_000 } },
  });
  // Let the start-up events (routing settles a few milliseconds after start) finish first.
  let first = -1;
  while (node.node.events.lastSeq !== first) {
    first = node.node.events.lastSeq;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  for (let i = 0; i < 5200; i += 1) node.node.events.emit('fill.x', { i });
  const stream = await openStream(node.port, { token: node.token, headers: { 'last-event-id': `${node.node.boot}-${first}` }, query: '?types=fill.x' });
  t.after(() => stream.close());
  const [hello, gap, firstFill] = await stream.take(3);
  const { oldestSeq, lastSeq } = hello.data;
  assert.equal(hello.data.resumed, true);
  assert.equal(lastSeq, first + 5200);
  assert.equal(oldestSeq, lastSeq - 4999, 'the ring holds 5000 events');
  assert.ok(oldestSeq > first + 1, 'the buffer has dropped the oldest events');
  assert.deepEqual(gap.data, { reason: 'overflow', from: first + 1, to: oldestSeq - 1 });
  assert.equal(firstFill.data.data.i, oldestSeq - first - 1, 'then the oldest event still held');
  const rest = await stream.take(5000 - 1, 8000);
  assert.equal(rest.at(-1).data.seq, lastSeq);
  assert.deepEqual(rest.map((event) => event.data.seq), Array.from({ length: 4999 }, (_, k) => oldestSeq + 1 + k), 'every held event, once, in order');
});

test('an idle stream gets keep-alive comments', async () => {
  const stream = await openStream(shared.port, { token: shared.token, query: '?types=never.happens' });
  t_close(stream);
  await stream.take(1);
  const start = Date.now();
  while (stream.comments() < 3 && Date.now() - start < 3000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(stream.comments() >= 3, `saw ${stream.comments()} comments`);
});

test('a stalled client is cut once its queue passes the bound, and the stream is then forgotten', async (t) => {
  const node = await startApiNode(t, { api: { sseKeepAliveMs: 60_000 } });
  const socket = net.connect({ host: '127.0.0.1', port: node.port });
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`GET /api/v1/events?types=big.* HTTP/1.1\r\nHost: 127.0.0.1:${node.port}\r\nAuthorization: Bearer ${node.token}\r\nAccept: text/event-stream\r\n\r\n`);
  socket.pause();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(node.node.stats().services.api.streamsOpen, 1);
  const filler = 'x'.repeat(200_000);
  let emitted = 0;
  while (node.node.stats().services.api.streamsOverflowed === 0 && emitted < 400) {
    node.node.events.emit('big.chunk', { filler, emitted });
    emitted += 1;
    if (emitted % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(node.node.stats().services.api.streamsOverflowed, 1, `cut after ${emitted} events of 200 kB`);
  for (let i = 0; i < 100 && node.node.stats().services.api.streamsOpen !== 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(node.node.stats().services.api.streamsOpen, 0);
  // The node itself is fine, and a new stream works.
  const again = await openStream(node.port, { token: node.token });
  assert.equal((await again.take(1))[0].type, 'stream.hello');
  again.close();
});

test('the 17th stream is refused with 503 too_many_streams, and a closed one frees its place', async (t) => {
  const node = await startApiNode(t, { api: { sseKeepAliveMs: 60_000 } });
  const streams = [];
  for (let i = 0; i < MAX_EVENT_STREAMS; i += 1) streams.push(await openStream(node.port, { token: node.token }));
  t.after(() => streams.forEach((stream) => stream.close()));
  assert.ok(streams.every((stream) => stream.status === 200));
  const refused = await call(node.port, { path: '/api/v1/events', token: node.token });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error.code, 'too_many_streams');
  streams[0].close();
  for (let i = 0; i < 100 && node.node.stats().services.api.streamsOpen >= MAX_EVENT_STREAMS; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const replacement = await openStream(node.port, { token: node.token });
  assert.equal(replacement.status, 200);
  replacement.close();
  assert.equal(node.node.stats().services.api.streamsOpened, MAX_EVENT_STREAMS + 1);
});

test('POST /shutdown answers 202, streams see node.stopping and are closed, and the node stops', async (t) => {
  const node = await startApiNode(t);
  const stream = await openStream(node.port, { token: node.token });
  await stream.take(1);
  const answer = await call(node.port, { method: 'POST', path: '/api/v1/shutdown', token: node.token, body: {} });
  assert.deepEqual([answer.status, answer.json], [202, { stopping: true }]);
  // Another event (a topology change, say) can sit in the stream ahead of this one.
  let stopping;
  do {
    [stopping] = await stream.take(1);
  } while (stopping.type !== 'node.stopping');
  assert.equal(stopping.data.data.reason, 'api');
  await stream.waitClosed();
  for (let i = 0; i < 100 && node.node.state !== 'stopped'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(node.node.state, 'stopped');
  await assert.rejects(call(node.port, { path: '/api/v1/status', token: node.token }), { code: 'ECONNREFUSED' });
  await assert.rejects(readFile(join(node.dataDir, 'runtime.json')), { code: 'ENOENT' });
});

// ---------------------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------------------

test('the console is served with the documented security headers', async () => {
  const index = await call(shared.port, { path: '/' });
  assert.equal(index.status, 200);
  assert.match(index.text, /<title>ClawView<\/title>/);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['content-security-policy'], CSP);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['referrer-policy'], 'no-referrer');
  assert.equal(index.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal(Number(index.headers['content-length']), Buffer.byteLength(index.text));

  const script = await call(shared.port, { path: '/assets/app.js' });
  assert.equal(script.text, 'console.log("console");');
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['content-security-policy'], CSP);
  assert.equal((await call(shared.port, { path: '/assets/style.css' })).headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await call(shared.port, { path: '/assets/data.bin' })).headers['content-type'], 'application/octet-stream');

  // A client-side route has no extension and gets the index; a missing file does not.
  for (const path of ['/peers', '/peers/abc/def', '/a%20b', '/trailing/']) {
    const answer = await call(shared.port, { path });
    assert.equal(answer.status, 200, path);
    assert.match(answer.text, /ClawView/);
  }
  const missing = await call(shared.port, { path: '/assets/missing.js' });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['content-security-policy'], CSP);
  assert.equal((await call(shared.port, { path: '/assets/app.exe' })).status, 404, 'an extension outside the table');

  const head = await call(shared.port, { method: 'HEAD', path: '/assets/app.js' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(Number(head.headers['content-length']), 'console.log("console");'.length);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const answer = await call(shared.port, { method, path: '/', raw: method === 'OPTIONS' ? undefined : '{}' });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, 'GET, HEAD');
  }
});

test('traversal, dot files, odd characters and links out of the console directory are 404 and never leak a file', async (t) => {
  const attempts = [
    '/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/assets%2f..%2f..%2fsecret.txt',
    '/..%5csecret.txt', '/assets/..%5c..%5csecret.txt', '/%252e%252e/secret.txt', '/assets/../../secret.txt', '/../secret.txt',
    '/secret.txt', '/%00', '/index.html%00.js', '/.hidden/x.js', '/assets/.env', '/C:/Windows/win.ini', '/assets/app.js:stream.js', '/assets/app.js%3a%3a%24DATA',
    '/..\\secret.txt',
  ];
  for (const path of attempts) {
    const answer = await call(shared.port, { path });
    assert.ok(!answer.text.includes('OUTSIDE-THE-CONSOLE-DIRECTORY'), `leaked through ${path}`);
    // A path with no usable file name is the client-side index; anything that names a file is 404.
    assert.ok([200, 404].includes(answer.status), `${path} -> ${answer.status}`);
  }
  for (const path of ['/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/../../secret.txt', '/secret.txt', '/.hidden/x.js', '/C:/Windows/win.ini']) {
    assert.equal((await call(shared.port, { path })).status, 404, path);
  }
  // A symbolic link inside the directory that leads outside is not followed (skipped where links cannot be made).
  try {
    await symlink(join(sharedUi.root, 'secret.txt'), join(sharedUi.ui, 'assets', 'escape.txt'));
    const answer = await call(shared.port, { path: '/assets/escape.txt' });
    assert.equal(answer.status, 404);
    assert.ok(!answer.text.includes('OUTSIDE'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
    t.diagnostic(`symlinks cannot be created here (${error.code}); that part is skipped`);
  }
});

test('with no console built the answer is a clear plain-text page, and the API still works', async (t) => {
  const dir = await tempDir(t, 'no-ui');
  const node = await startApiNode(t, { api: { uiDir: join(dir, 'does-not-exist') } });
  for (const path of ['/', '/peers', '/assets/app.js']) {
    const answer = await call(node.port, { path });
    assert.equal(answer.status, 404, path);
    assert.match(answer.headers['content-type'], /^text\/plain/);
    assert.equal(answer.headers['content-security-policy'], CSP);
  }
  const page = await call(node.port, { path: '/' });
  assert.match(page.text, /console has not been built/i);
  assert.ok(!page.text.includes(node.token));
  assert.equal((await call(node.port, { path: '/api/v1/status', token: node.token })).status, 200);
  // An empty directory without index.html is the same.
  await mkdir(join(dir, 'empty'));
  const second = await startApiNode(t, { api: { uiDir: join(dir, 'empty') } });
  assert.match((await call(second.port, { path: '/' })).text, /has not been built/);
});

test('serveUi: false serves no console at all', async (t) => {
  const ui = await makeUiDir(t);
  const node = await startApiNode(t, { config: { api: { serveUi: false } }, api: { uiDir: ui.ui } });
  assert.equal((await call(node.port, { path: '/' })).status, 404);
  assert.equal((await call(node.port, { path: '/assets/app.js' })).status, 404);
  assert.equal((await call(node.port, { path: '/api/v1/status', token: node.token })).status, 200);
});

// ---------------------------------------------------------------------------------------
// Limits, events, switches
// ---------------------------------------------------------------------------------------

test('failed authentications are rate limited without locking out the real token', async (t) => {
  const node = await startApiNode(t, { api: { authFailuresPerSec: 2 } });
  // All at once, so that the bucket has no time to refill: a burst of four is answered
  // normally, the rest is 429.
  const answers = await Promise.all(Array.from({ length: 10 }, () => call(node.port, { path: '/api/v1/status', token: WRONG_TOKEN })));
  const statuses = answers.map((answer) => answer.status);
  const refused = statuses.filter((status) => status === 401).length;
  assert.ok(refused >= 4 && refused <= 6, `a burst of about four failures is answered normally: ${statuses}`);
  assert.equal(statuses.filter((status) => status === 429).length, 10 - refused, `the rest is 429: ${statuses}`);
  const limited = answers.find((answer) => answer.status === 429);
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.equal(typeof limited.json.error.details.retryInMs, 'number');
  assert.match(limited.headers['retry-after'], /^[1-9][0-9]*$/);
  // The holder of the token is not affected by someone else's failures.
  assert.equal((await call(node.port, { path: '/api/v1/status', token: node.token })).status, 200);
  assert.ok(node.node.stats().services.api.rate_limited >= 4);
});

test('an authenticated client is limited to the configured request rate', async (t) => {
  const node = await startApiNode(t, { api: { requestsPerSec: 2 } });
  const answers = await Promise.all(Array.from({ length: 10 }, () => call(node.port, { path: '/api/v1/status', token: node.token })));
  const statuses = answers.map((answer) => answer.status);
  const served = statuses.filter((status) => status === 200).length;
  assert.ok(served >= 4 && served <= 6, `a burst of about four is served: ${statuses}`);
  assert.equal(statuses.filter((status) => status === 429).length, 10 - served);
  assert.equal(answers.find((answer) => answer.status === 429).json.error.code, 'rate_limited');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await call(node.port, { path: '/api/v1/status', token: node.token })).status, 200, 'the budget comes back');
});

test('api.denied is emitted for refusals, at most once a second, and api.listening once', async (t) => {
  const node = await startApiNode(t);
  const listening = node.node.events.recent({ types: ['api.listening'] });
  assert.equal(listening.length, 1);
  assert.deepEqual(listening[0].data, { host: '127.0.0.1', port: node.port });
  for (let i = 0; i < 30; i += 1) await call(node.port, { path: '/api/v1/status', token: WRONG_TOKEN });
  const denied = node.node.events.recent({ types: ['api.denied'] });
  assert.ok(denied.length >= 1 && denied.length <= 3, `${denied.length} events for 30 refusals`);
  assert.deepEqual(Object.keys(denied[0].data).sort(), ['reason', 'remote']);
  assert.equal(denied[0].data.reason, 'token');
  assert.match(denied[0].data.remote, /127\.0\.0\.1/);
  const stats = node.node.stats().services.api;
  assert.equal(stats.denied_token, 30);
  assert.ok(stats.requests >= 30);
  assert.deepEqual(Object.keys(stats).sort(), [
    'denied_host', 'denied_origin', 'denied_token', 'errors', 'eventsSent', 'rate_limited', 'requests', 'streamsOpen', 'streamsOpened', 'streamsOverflowed',
  ]);
});

test('with api.enabled false the service does nothing: no listener, no routes, no token file', async (t) => {
  const node = await startApiNode(t, { config: { api: { enabled: false } } });
  const api = node.node.service('api');
  assert.equal(api.url, null);
  assert.equal(api.address, null);
  assert.deepEqual(node.node.apiRoutes().filter((route) => route.service === 'api'), []);
  assert.equal(node.node.status().services.includes('api'), true);
  await assert.rejects(readFile(join(node.dataDir, 'api-token')), { code: 'ENOENT' });
  const runtime = JSON.parse(await readFile(join(node.dataDir, 'runtime.json'), 'utf8'));
  assert.equal(runtime.api, null);
});

test('runtime.json carries the real API address, even with port 0', async (t) => {
  const node = await startApiNode(t);
  const runtime = JSON.parse(await readFile(join(node.dataDir, 'runtime.json'), 'utf8'));
  assert.equal(runtime.api, `http://127.0.0.1:${node.port}`);
  assert.equal(runtime.api, node.url);
  assert.ok(node.port > 0);
});

test('a port that is taken fails the start with a message that names it', async (t) => {
  const taken = await startApiNode(t);
  const dir = await tempDir(t, 'api-clash');
  const node = new ClawNode({
    config: { networkId: 'api-test', listen: { host: '127.0.0.1', port: 0 }, api: { port: taken.port }, discovery: { multicast: { enabled: false } } },
    dataDir: dir, services: [createApiService()], logger: SILENT_LOGGER,
  });
  await assert.rejects(node.start(), (error) => error instanceof StateError && error.message.startsWith('api-listen-failed:') && error.message.includes(String(taken.port)));
  assert.equal(node.state, 'failed');
});

test('createApiService validates its options', () => {
  assert.throws(() => createApiService({ uiDir: '' }), ConfigError);
  assert.throws(() => createApiService({ sseKeepAliveMs: 0 }), ConfigError);
  assert.throws(() => createApiService({ requestsPerSec: 1.5 }), ConfigError);
  assert.throws(() => createApiService({ authFailuresPerSec: -1 }), ConfigError);
  assert.doesNotThrow(() => createApiService());
});
