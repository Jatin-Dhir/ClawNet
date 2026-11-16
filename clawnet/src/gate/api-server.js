/**
 * The local control API and the served console (API.md; ARCHITECTURE.md 8.5).
 *
 * One HTTP server on loopback does three things and nothing else:
 *
 *   - It authenticates and routes `/api/v1/...` requests. The routes come from the
 *     services through `ctx.api.route` (this service registers the ones that need only
 *     the node), so every service that is installed shows up without this file knowing it.
 *   - It streams the node's event bus as server-sent events, with resume.
 *   - It serves the built ClawView console from `uiDir`.
 *
 * Every request passes the same gates in the same order: the `Host` rule (DNS rebinding),
 * for API paths the Origin rule (cross-site pages), then the bearer token, then the rate
 * limits. The token, not the Origin rule, is the access control.
 */

import { createReadStream } from 'node:fs';
import { chmod, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { randomBytes, sha256, timingSafeEqual } from '../core/crypto/primitives.js';
import {
  CanonicalError,
  ClawNetError,
  ConfigError,
  CryptoError,
  HandshakeError,
  StateError,
  StoreError,
  WireError,
} from '../core/errors.js';
import { isNodeId, validateAddress } from '../core/wire/schema.js';
import { atomicCreateFile } from '../vault/store.js';

/** Largest request body in bytes (API.md section 1). */
export const MAX_BODY_BYTES = 65536;

/** Interval of the keep-alive comment on event streams. */
export const SSE_KEEPALIVE_MS = 15000;

/** Most event streams open at once. */
export const MAX_EVENT_STREAMS = 16;

/** Most bytes queued for one event stream before it is cut (the client resumes). */
export const MAX_STREAM_QUEUE_BYTES = 1024 * 1024;

/** Most concurrent connections. */
export const MAX_CONNECTIONS = 64;

/** Name of the token file in the data directory. */
export const TOKEN_FILE = 'api-token';

/** Requests per second an authenticated client may make, and failed authentications per second. */
export const DEFAULT_REQUESTS_PER_SEC = 200;
export const DEFAULT_AUTH_FAILURES_PER_SEC = 10;

/** The Content-Security-Policy of every static response (API.md section 2.3). */
export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TYPES_ITEM = /^[a-z][a-z0-9_-]{0,63}(?:\.[a-z0-9_-]{1,63}){0,7}(?:\.\*)?$/;
const MAX_URL_LENGTH = 4096;
const MAX_QUERY_PARAMS = 32;
const MAX_QUERY_VALUE = 1024;
const MAX_TYPES = 64;
/** A client that sends more than this after being refused is not worth reading from. */
const DRAIN_BYTES = 1024 * 1024;
const MAX_STATIC_BYTES = 64 * 1024 * 1024;
const RESUME_PATTERN = /^([0-9a-f]{8})-(0|[1-9][0-9]{0,15})$/;
const SERVER_CLOSE_GRACE_MS = 1000;
const DENIED_EVENT_INTERVAL_MS = 1000;
const DIAG_EVENTS_DEFAULT = 200;
const DIAG_EVENTS_MAX = 1000;
const OUTBOX_DEFAULT = 200;
const OUTBOX_MAX = 1000;
const KNOWN_ADDRESSES_MAX = 4096;

/** Status of each error code (API.md section 4). */
const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  invalid_json: 400,
  invalid_file: 400,
  unauthorized: 401,
  forbidden_host: 403,
  forbidden_origin: 403,
  not_found: 404,
  unknown_destination: 404,
  not_joined: 404,
  method_not_allowed: 405,
  already_joined: 409,
  invalid_state: 409,
  peer_limit: 409,
  conflict: 409,
  body_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  storage: 500,
  connect_failed: 502,
  outbox_full: 503,
  busy: 503,
  too_many_streams: 503,
  not_running: 503,
});

/** The fixed extension-to-type table of the console. Anything else is not served. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
});

const NOT_BUILT_TEXT = [
  'The ClawNet console has not been built.',
  '',
  'This node is running. Its control API is at /api/v1 and needs a bearer token;',
  'the clawnet command line uses it for you.',
  'Build the console into the "ui" directory of the clawnet package',
  '(run the build in the "console" directory) and reload this page.',
  '',
].join('\n');

const DEFAULT_UI_DIR = fileURLToPath(new URL('../../ui', import.meta.url));

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

/** A token bucket on the monotonic clock. */
class RateLimit {
  #rate;
  #burst;
  #tokens;
  #at;

  constructor(perSecond) {
    this.#rate = perSecond;
    this.#burst = Math.max(1, perSecond * 2);
    this.#tokens = this.#burst;
    this.#at = performance.now();
  }

  /** @returns {number} 0 when a token was taken, else the milliseconds until one is available */
  take() {
    const at = performance.now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((at - this.#at) / 1000) * this.#rate);
    this.#at = at;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.#tokens) / this.#rate) * 1000);
  }
}

function describeHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** The `h:port` strings a request's Host header may equal (API.md section 2.1). */
function allowedHostValues(allowedHosts, port) {
  const values = new Set(allowedHosts.map((host) => `${host.toLowerCase()}:${port}`));
  if (port === 80) for (const host of allowedHosts) values.add(host.toLowerCase());
  return values;
}

/**
 * The error body and status for anything a handler can throw (API.md section 4).
 *
 * @param {unknown} error
 * @returns {{ status: number, code: string, message: string, details?: object, internal: boolean }}
 */
export function describeError(error) {
  if (error instanceof ClawNetError && Number.isInteger(error.status) && typeof error.apiCode === 'string') {
    const out = { status: error.status, code: error.apiCode, message: error.message, internal: false };
    if (error.details !== null && error.details !== undefined) out.details = error.details;
    return out;
  }
  if (error instanceof StateError) {
    const match = /^([a-z][a-z0-9-]{0,63}): ([^]*)$/.exec(error.message);
    if (match !== null) {
      const code = match[1].replaceAll('-', '_');
      return { status: STATUS_BY_CODE[code] ?? 409, code, message: match[2], internal: false };
    }
    return { status: 409, code: 'conflict', message: error.message, internal: false };
  }
  if (error instanceof HandshakeError) {
    return { status: 502, code: 'connect_failed', message: error.message, details: { reason: error.reason }, internal: false };
  }
  if (error instanceof ConfigError || error instanceof CryptoError || error instanceof CanonicalError || error instanceof WireError) {
    const details = typeof error.path === 'string' ? { field: error.path, problem: error.message } : undefined;
    return { status: 400, code: 'invalid_request', message: error.message, ...(details === undefined ? {} : { details }), internal: false };
  }
  if (error instanceof StoreError) {
    return { status: 500, code: 'storage', message: 'a disk operation failed', internal: true };
  }
  return { status: 500, code: 'internal', message: 'internal error', internal: true };
}

function headerCount(rawHeaders, name) {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) count += 1;
  return count;
}

function queryOf(search) {
  const query = Object.create(null);
  if (search === '') return query;
  const params = new URLSearchParams(search);
  let count = 0;
  for (const [key, value] of params) {
    count += 1;
    if (count > MAX_QUERY_PARAMS || key.length > 64 || value.length > MAX_QUERY_VALUE || key in query) return null;
    query[key] = value;
  }
  return query;
}

function hasBody(req) {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

/** Read or create the token file; owner-only on platforms that have modes. */
async function loadToken(path) {
  let text = null;
  try {
    text = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new StoreError(`cannot read ${path}`, { cause: error });
  }
  if (text === null) {
    const token = randomBytes(32).toString('hex');
    try {
      await atomicCreateFile(path, `${token}\n`, { mode: 0o600 });
      return token;
    } catch (error) {
      // Another start created it first: use theirs.
      if (!(error instanceof StateError)) throw error;
      text = (await readFile(path, 'utf8')).trim();
    }
  }
  if (!TOKEN_PATTERN.test(text)) {
    throw new StoreError(`${path} does not hold a token (64 hexadecimal characters); delete it to create a new one`);
  }
  if (process.platform !== 'win32') {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
  }
  return text;
}

// ---------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------

/**
 * Build the control API service. Its `api` is `{ address, url, tokenPath }`: the bound
 * address after start (`null` before, and when the API is disabled), the base URL, and the
 * token file.
 *
 * @param {object} [options]
 * @param {string} [options.uiDir] directory of the built console (default `<package>/ui`)
 * @param {number} [options.sseKeepAliveMs] interval of the stream keep-alive comment
 * @param {number} [options.requestsPerSec] sustained rate allowed per authenticated client
 * @param {number} [options.authFailuresPerSec] sustained rate of failed authentications
 *   after which further attempts are answered 429 without being compared
 * @returns {object} a Service (ARCHITECTURE.md section 6) named `api`
 * @throws {ConfigError} for an invalid option
 */
export function createApiService({
  uiDir = DEFAULT_UI_DIR,
  sseKeepAliveMs = SSE_KEEPALIVE_MS,
  requestsPerSec = DEFAULT_REQUESTS_PER_SEC,
  authFailuresPerSec = DEFAULT_AUTH_FAILURES_PER_SEC,
} = {}) {
  if (typeof uiDir !== 'string' || uiDir === '' || uiDir.includes('\0')) throw new ConfigError('uiDir must be a path');
  for (const [value, name] of [[sseKeepAliveMs, 'sseKeepAliveMs'], [requestsPerSec, 'requestsPerSec'], [authFailuresPerSec, 'authFailuresPerSec']]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
  }

  let server = null;
  let ctx = null;
  let enabled = false;
  let address = null;
  let url = null;
  let tokenPath = null;

  const service = {
    name: 'api',

    init(context) {
      ctx = context;
      enabled = context.config.api.enabled;
      if (!enabled) return;
      tokenPath = join(context.node.dataDir, TOKEN_FILE);
      registerCoreRoutes(context);
    },

    async start() {
      if (!enabled) return;
      server = new ApiHttpServer({ ctx, uiDir, sseKeepAliveMs, requestsPerSec, authFailuresPerSec, tokenPath });
      address = await server.listen();
      url = server.url;
    },

    async stop() {
      const closing = server;
      server = null;
      address = null;
      url = null;
      if (closing !== null) await closing.close();
    },

    stats() {
      return server === null ? {} : server.stats();
    },

    api: {
      get address() {
        return address === null ? null : { ...address };
      },
      get url() {
        return url;
      },
      get tokenPath() {
        return tokenPath;
      },
    },
  };
  return service;
}

// ---------------------------------------------------------------------------------------
// Core routes: everything that needs only the node
// ---------------------------------------------------------------------------------------

function invalid(ctx, field, problem) {
  return ctx.api.error(400, 'invalid_request', `${field}: ${problem}`, { field, problem });
}

function objectBody(ctx, body, allowed) {
  if (body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid(ctx, 'body', 'a JSON object is required');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(ctx, key, 'unknown field');
  }
  return body;
}

function allowQuery(ctx, query, allowed) {
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw invalid(ctx, key, 'unknown query parameter');
  }
}

function queryInteger(ctx, query, name, { min, max, fallback }) {
  const raw = query[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,15}$/.test(raw)) throw invalid(ctx, name, 'must be an integer');
  const value = Number(raw);
  if (value < min || value > max) throw invalid(ctx, name, `must be from ${min} to ${max}`);
  return value;
}

/** `types` of the event stream and of `/diag/events`: exact types or `prefix.*`. */
function parseTypes(ctx, raw) {
  if (raw === undefined) return null;
  const items = raw.split(',');
  if (items.length > MAX_TYPES || items.some((item) => !TYPES_ITEM.test(item))) {
    throw invalid(ctx, 'types', 'must be a comma-separated list of event types or prefixes ending in ".*"');
  }
  const exact = new Set();
  const prefixes = [];
  for (const item of items) {
    if (item.endsWith('.*')) prefixes.push(item.slice(0, -1));
    else exact.add(item);
  }
  return (type) => exact.has(type) || prefixes.some((prefix) => type.startsWith(prefix));
}

function asOf(node) {
  return { boot: node.boot, seq: node.events.lastSeq };
}

function registerCoreRoutes(ctx) {
  const { node } = ctx;
  const route = (method, path, summary, handler) => ctx.api.route(method, path, handler, { summary });
  const none = (req) => {
    allowQuery(ctx, req.query, []);
    return null;
  };

  route('GET', '/status', 'node summary', (req) => {
    none(req);
    return node.status();
  });

  route('GET', '/identity', 'this node\'s identity', (req) => {
    none(req);
    return node.identityInfo();
  });

  route('GET', '/peers', 'links and dials in progress', (req) => {
    none(req);
    const snapshot = asOf(node);
    return { peers: node.listPeers(), dialing: node.listDialing(), asOf: snapshot };
  });

  route('GET', '/peers/known', 'the address book', (req) => {
    none(req);
    return { addresses: node.listKnownAddresses().slice(0, KNOWN_ADDRESSES_MAX) };
  });

  route('POST', '/peers/connect', 'dial an address', async (req) => {
    const body = objectBody(ctx, req.body, ['address']);
    if (typeof body.address !== 'string' || !validateAddress(body.address).ok) {
      throw invalid(ctx, 'address', 'must be an address of the form tcp://host:port');
    }
    return { peer: await node.connect(body.address) };
  });

  route('POST', '/peers/:id/disconnect', 'close a link', async (req) => {
    objectBody(ctx, req.body, []);
    if (!isNodeId(req.params.id)) throw invalid(ctx, 'id', 'must be a NodeId');
    if (!(await node.disconnect(req.params.id))) {
      throw ctx.api.error(404, 'not_found', 'no link to that node', { id: req.params.id });
    }
    return { disconnected: true };
  });

  route('GET', '/topology', 'nodes and links', (req) => {
    none(req);
    const snapshot = asOf(node);
    return { ...node.topology(), asOf: snapshot };
  });

  route('GET', '/topology/routes', 'this node\'s routing table', (req) => {
    none(req);
    const snapshot = asOf(node);
    return { rev: node.status().routing.rev, routes: node.routes(), asOf: snapshot };
  });

  route('GET', '/topology/nodes/:id', 'one node in detail', (req) => {
    none(req);
    if (!isNodeId(req.params.id)) throw invalid(ctx, 'id', 'must be a NodeId');
    const detail = node.nodeDetail(req.params.id);
    if (detail === null) throw ctx.api.error(404, 'not_found', 'no such node', { id: req.params.id });
    return detail;
  });

  route('GET', '/outbox', 'undelivered reliable messages', (req) => {
    allowQuery(ctx, req.query, ['limit']);
    const limit = queryInteger(ctx, req.query, 'limit', { min: 1, max: OUTBOX_MAX, fallback: OUTBOX_DEFAULT });
    const all = node.outbox();
    return { total: all.length, entries: all.reverse().slice(0, limit) };
  });

  route('GET', '/config', 'effective configuration, secrets redacted', (req) => {
    none(req);
    return { dataDir: node.dataDir, config: node.configView(), redacted: ['networkKey'] };
  });

  route('GET', '/diag/events', 'recent events from the ring buffer', (req) => {
    allowQuery(ctx, req.query, ['since', 'limit', 'types']);
    const since = queryInteger(ctx, req.query, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: undefined });
    const limit = queryInteger(ctx, req.query, 'limit', { min: 1, max: DIAG_EVENTS_MAX, fallback: DIAG_EVENTS_DEFAULT });
    const wanted = parseTypes(ctx, req.query.types);
    const status = node.status().events;
    let events = node.events.recent(since === undefined ? {} : { sinceSeq: since });
    if (wanted !== null) events = events.filter((event) => wanted(event.type));
    // Without `since`: the newest `limit`; with it: the oldest `limit` after it.
    events = since === undefined ? events.slice(-limit) : events.slice(0, limit);
    return {
      boot: node.boot,
      lastSeq: status.lastSeq,
      oldestSeq: status.oldestSeq,
      events: events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, data: event.data })),
    };
  });

  route('GET', '/diag/sync', 'ClawSync statistics', (req) => {
    none(req);
    return { datasets: node.syncDatasets(), engine: node.syncStats() };
  });

  route('POST', '/shutdown', 'stop the node', (req) => {
    objectBody(ctx, req.body, []);
    // The response is written first; the stop then closes this server gracefully, which
    // lets the response finish. A node that is already stopping has nothing more to do.
    ctx.schedule(() => {
      node.stop({ reason: 'api' }).catch(() => {});
    }, 0);
    return ctx.api.reply(202, { stopping: true });
  });
}

// ---------------------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------------------

class ApiHttpServer {
  #ctx;
  #uiDir;
  #keepAliveMs;
  #tokenPath;
  #tokenDigest = null;
  #config;
  #http = null;
  #table = [];
  #streams = new Set();
  #cancelKeepAlive = null;
  #lastDeniedAt = -Infinity;
  #requestLimit;
  #failureLimit;
  #hosts = new Set();
  #port = 0;
  #listenHost = '';
  #stats = {
    requests: 0,
    denied_host: 0,
    denied_origin: 0,
    denied_token: 0,
    rate_limited: 0,
    errors: 0,
    streamsOpened: 0,
    streamsOverflowed: 0,
    eventsSent: 0,
  };

  constructor({ ctx, uiDir, sseKeepAliveMs, requestsPerSec, authFailuresPerSec, tokenPath }) {
    this.#ctx = ctx;
    this.#uiDir = uiDir;
    this.#keepAliveMs = sseKeepAliveMs;
    this.#tokenPath = tokenPath;
    this.#config = ctx.config.api;
    this.#requestLimit = new RateLimit(requestsPerSec);
    this.#failureLimit = new RateLimit(authFailuresPerSec);
  }

  get url() {
    const { allowedHosts, host } = this.#config;
    const wanted = describeHost(host).toLowerCase();
    const shown = allowedHosts.includes(wanted) ? describeHost(host) : (allowedHosts[0] ?? describeHost(host));
    return `http://${shown}:${this.#port}`;
  }

  stats() {
    return { ...this.#stats, streamsOpen: this.#streams.size };
  }

  async listen() {
    const token = await loadToken(this.#tokenPath);
    // Only a digest is kept for comparing: a request's token is hashed too, so the compare
    // takes the same time whatever its length.
    this.#tokenDigest = sha256(Buffer.from(token, 'utf8'));
    this.#buildTable();
    const http = createServer({
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 2000,
    }, (req, res) => this.#onRequest(req, res));
    http.maxConnections = MAX_CONNECTIONS;
    http.on('clientError', (_error, socket) => {
      // A malformed request: say so once and drop the connection.
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
    this.#http = http;
    const { host, port } = this.#config;
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(new StateError(`api-listen-failed: cannot listen on ${describeHost(host)}:${port} (${error?.code ?? 'error'})`, { cause: error }));
      http.once('error', failed);
      http.listen({ host, port }, () => {
        http.off('error', failed);
        resolve();
      });
    });
    http.on('error', (error) => this.#ctx.log.error('api server error', { code: error?.code ?? null }));
    const bound = http.address();
    this.#port = bound.port;
    this.#listenHost = bound.address;
    this.#hosts = allowedHostValues(this.#config.allowedHosts, this.#port);
    this.#cancelKeepAlive = this.#ctx.every(() => this.#keepAlive(), this.#keepAliveMs);
    this.#ctx.events.emit('api.listening', { host: this.#listenHost, port: this.#port });
    return { host: this.#listenHost, port: this.#port };
  }

  async close() {
    this.#cancelKeepAlive?.();
    this.#cancelKeepAlive = null;
    const http = this.#http;
    if (http === null) return;
    this.#http = null;
    for (const stream of [...this.#streams]) stream.end();
    const closed = new Promise((resolve) => http.close(() => resolve()));
    http.closeIdleConnections();
    const cancel = this.#ctx.schedule(() => http.closeAllConnections(), SERVER_CLOSE_GRACE_MS);
    await closed;
    cancel();
  }

  // ------------------------------------------------------------------ routing table

  #buildTable() {
    this.#table = this.#ctx.node.apiRoutes().map((route) => ({
      method: route.method,
      segments: route.path.split('/').slice(1).map((segment) => (segment.startsWith(':') ? { param: segment.slice(1) } : { literal: segment })),
      handler: route.handler,
    }));
  }

  /** @returns {{ route: object, params: object } | { allow: string[] } | null} */
  #match(method, segments) {
    const allow = new Set();
    let best = null;
    for (const route of this.#table) {
      if (route.segments.length !== segments.length) continue;
      const params = Object.create(null);
      let literals = 0;
      let ok = true;
      for (let i = 0; i < segments.length && ok; i += 1) {
        const part = route.segments[i];
        if ('literal' in part) {
          ok = part.literal === segments[i];
          if (ok) literals += 1;
        } else {
          params[part.param] = segments[i];
        }
      }
      if (!ok) continue;
      allow.add(route.method);
      if (route.method === method && (best === null || literals > best.literals)) best = { route, params, literals };
    }
    if (best !== null) return { route: best.route, params: best.params };
    return allow.size > 0 ? { allow: [...allow].sort() } : null;
  }

  // ------------------------------------------------------------------ request handling

  #onRequest(req, res) {
    this.#stats.requests += 1;
    this.#dispatch(req, res).catch((error) => {
      this.#stats.errors += 1;
      this.#ctx.log.error('request failed', { code: error?.code ?? null, message: String(error?.message).slice(0, 200) });
      if (!res.headersSent && !res.destroyed) this.#sendError(res, { status: 500, code: 'internal', message: 'internal error' });
      else res.destroy();
    });
  }

  async #dispatch(req, res) {
    const host = this.#hostOf(req);
    if (host === null) return this.#deny(req, res, 'host', 403, 'forbidden_host', 'the Host header is not allowed');

    const url = req.url ?? '';
    if (url.length > MAX_URL_LENGTH) return this.#sendError(res, { status: 400, code: 'invalid_request', message: 'the request target is too long' });
    const cut = url.indexOf('?');
    const path = cut < 0 ? url : url.slice(0, cut);
    const search = cut < 0 ? '' : url.slice(cut + 1);

    if (path !== '/api' && !path.startsWith('/api/')) return this.#serveStatic(req, res, path);

    // From here on everything is the API.
    if (req.method === 'OPTIONS') return this.#preflight(req, res);
    const cors = this.#checkOrigin(req, host);
    if (cors === false) return this.#deny(req, res, 'origin', 403, 'forbidden_origin', 'the Origin is not allowed');
    const extra = cors === null ? {} : { 'access-control-allow-origin': cors, vary: 'Origin' };

    if (!this.#tokenOk(req)) {
      const wait = this.#failureLimit.take();
      if (wait > 0) return this.#limited(req, res, extra, wait);
      return this.#deny(req, res, 'token', 401, 'unauthorized', 'a valid bearer token is required', extra,
        { 'www-authenticate': 'Bearer realm="clawnet"' });
    }
    const wait = this.#requestLimit.take();
    if (wait > 0) return this.#limited(req, res, extra, wait);

    const query = queryOf(search);
    if (query === null) return this.#sendError(res, { status: 400, code: 'invalid_request', message: 'too many, repeated or oversized query parameters' }, extra);
    let segments;
    try {
      segments = path.split('/').slice(1).map((segment) => decodeURIComponent(segment));
    } catch {
      return this.#sendError(res, { status: 400, code: 'invalid_request', message: 'the path is not valid percent-encoding' }, extra);
    }
    // segments[0] is "api"; the version follows.
    if (segments[1] !== 'v1') return this.#sendError(res, { status: 404, code: 'not_found', message: 'no such endpoint' }, extra);
    const rest = segments.slice(2);

    if (rest.length === 1 && rest[0] === 'events') {
      if (req.method !== 'GET') return this.#methodNotAllowed(res, ['GET'], extra);
      try {
        return this.#openStream(req, res, query, extra);
      } catch (error) {
        return this.#sendError(res, describeError(error), extra);
      }
    }
    const match = this.#match(req.method ?? '', rest);
    if (match === null) return this.#sendError(res, { status: 404, code: 'not_found', message: 'no such endpoint' }, extra);
    if ('allow' in match) return this.#methodNotAllowed(res, match.allow, extra);

    const body = await this.#readJson(req, res, extra);
    if (body === undefined) return undefined;
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let result;
    try {
      result = await match.route.handler({ params: match.params, query, body, signal: controller.signal });
    } catch (error) {
      const described = describeError(error);
      if (described.internal) {
        this.#stats.errors += 1;
        this.#ctx.log.error('handler failed', { path, code: error?.code ?? null, message: String(error?.message).slice(0, 200) });
      }
      return this.#sendError(res, described, extra);
    }
    if (res.destroyed) return undefined;
    if (this.#ctx.api.isReply(result)) return this.#sendJson(res, result.status, result.body, extra);
    return this.#sendJson(res, 200, result ?? {}, extra);
  }

  // ------------------------------------------------------------------ the gates

  /** @returns {string | null} the validated Host value, or null when the request is refused */
  #hostOf(req) {
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return null;
    if (headerCount(req.rawHeaders, 'host') !== 1) return null;
    const host = String(req.headers.host).toLowerCase();
    return this.#hosts.has(host) ? host : null;
  }

  /**
   * @returns {string | null | false} the origin to allow with CORS headers, null for an
   *   allowed request that needs none, false when the request is refused
   */
  #checkOrigin(req, host) {
    const { origin } = req.headers;
    let cors = null;
    if (origin !== undefined) {
      if (origin === `http://${host}`) cors = null;
      else if (this.#config.corsOrigins.includes(origin)) cors = origin;
      else return false;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && cors === null) return false;
    return cors;
  }

  #preflight(req, res) {
    const { origin } = req.headers;
    const method = req.headers['access-control-request-method'];
    if (typeof origin !== 'string' || typeof method !== 'string' || !this.#config.corsOrigins.includes(origin)) {
      return this.#deny(req, res, 'origin', 403, 'forbidden_origin', 'the Origin is not allowed');
    }
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type, Last-Event-ID',
      'access-control-max-age': '600',
      vary: 'Origin',
      'cache-control': 'no-store',
    });
    res.end();
    return undefined;
  }

  #tokenOk(req) {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([0-9a-f]{64})$/.exec(header) : null;
    // Hash whatever was sent so that the compare below always sees 32 bytes, and run it
    // even for a malformed header so that every failure takes the same time.
    const offered = sha256(Buffer.from(match === null ? '' : match[1], 'utf8'));
    return timingSafeEqual(offered, this.#tokenDigest) && match !== null;
  }

  #deny(req, res, reason, status, code, message, extra = {}, headers = {}) {
    this.#stats[`denied_${reason}`] += 1;
    this.#noteDenied(reason, req);
    return this.#sendError(res, { status, code, message }, extra, { ...headers, ...(hasBody(req) ? { connection: 'close' } : {}) });
  }

  #limited(req, res, extra, waitMs) {
    this.#stats.rate_limited += 1;
    this.#noteDenied('rate', req);
    const retryInMs = Math.max(1, waitMs);
    return this.#sendError(
      res,
      { status: 429, code: 'rate_limited', message: 'too many requests', details: { retryInMs } },
      extra,
      { 'retry-after': String(Math.ceil(retryInMs / 1000)), ...(hasBody(req) ? { connection: 'close' } : {}) },
    );
  }

  /** `api.denied`, at most once a second so that a flood cannot flood the event bus. */
  #noteDenied(reason, req) {
    const now = this.#ctx.now();
    if (now - this.#lastDeniedAt < DENIED_EVENT_INTERVAL_MS) return;
    this.#lastDeniedAt = now;
    try {
      this.#ctx.events.emit('api.denied', { reason, remote: String(req.socket.remoteAddress ?? 'unknown') });
    } catch {
      // The event is a courtesy; the refusal stands.
    }
  }

  // ------------------------------------------------------------------ bodies

  /**
   * Read the request body as a JSON object.
   *
   * @returns {Promise<object | null | undefined>} null when there is no body; undefined
   *   when an error response has already been sent
   */
  async #readJson(req, res, extra) {
    if (!hasBody(req)) return null;
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(type)) {
      this.#sendError(res, { status: 415, code: 'unsupported_media_type', message: 'send Content-Type: application/json' }, extra,
        hasBody(req) ? { connection: 'close' } : {});
      return undefined;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DRAIN_BYTES) {
      this.#sendError(res, { status: 413, code: 'body_too_large', message: `the body is larger than ${MAX_BODY_BYTES} bytes` }, extra, { connection: 'close' });
      return undefined;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        // Read (and discard) the rest of a modestly oversized body so the client sees the
        // answer rather than a reset; a body this far over the limit is not worth reading.
        else if (size > DRAIN_BYTES) break;
      }
    } catch {
      return undefined;
    }
    if (size > MAX_BODY_BYTES) {
      this.#sendError(res, { status: 413, code: 'body_too_large', message: `the body is larger than ${MAX_BODY_BYTES} bytes` }, extra,
        size > DRAIN_BYTES ? { connection: 'close' } : {});
      return undefined;
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      this.#sendError(res, { status: 400, code: 'invalid_json', message: 'the body is not valid JSON' }, extra);
      return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#sendError(res, { status: 400, code: 'invalid_json', message: 'the body must be a JSON object' }, extra);
      return undefined;
    }
    return parsed;
  }

  // ------------------------------------------------------------------ responses

  #sendJson(res, status, body, extra = {}, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': bytes.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
      ...headers,
    });
    res.end(bytes);
  }

  #sendError(res, { status, code, message, details }, extra = {}, headers = {}) {
    const error = { code, message };
    if (details !== undefined) error.details = details;
    this.#sendJson(res, status, { error }, extra, headers);
  }

  #methodNotAllowed(res, allow, extra) {
    this.#sendError(res, { status: 405, code: 'method_not_allowed', message: `use ${allow.join(', ')}` }, extra, { allow: allow.join(', ') });
  }

  // ------------------------------------------------------------------ event stream

  #openStream(req, res, query, extra) {
    allowQuery(this.#ctx, query, ['types', 'since']);
    const wanted = parseTypes(this.#ctx, query.types);
    const header = req.headers['last-event-id'];
    const rawSince = typeof header === 'string' && header !== '' ? header : query.since;
    let since = null;
    if (rawSince !== undefined && rawSince !== '') {
      const match = RESUME_PATTERN.exec(rawSince);
      if (match === null) throw invalid(this.#ctx, header ? 'Last-Event-ID' : 'since', 'must look like <boot>-<seq>');
      since = { boot: match[1], seq: Number(match[2]) };
    }
    if (this.#streams.size >= MAX_EVENT_STREAMS) {
      return this.#sendError(res, { status: 503, code: 'too_many_streams', message: `${MAX_EVENT_STREAMS} event streams are already open` }, extra);
    }

    const { node } = this.#ctx;
    const { lastSeq, oldestSeq } = node.status().events;
    let resumed = false;
    let after = lastSeq;
    let gap = null;
    if (since !== null) {
      if (since.boot !== node.boot || since.seq > lastSeq) {
        gap = { reason: 'restart' };
      } else {
        resumed = true;
        after = since.seq;
        if (oldestSeq > since.seq + 1 && lastSeq > since.seq) gap = { reason: 'overflow', from: since.seq + 1, to: oldestSeq - 1 };
      }
    }

    const stream = new EventStream({
      res,
      boot: node.boot,
      wanted,
      onOverflow: () => {
        this.#stats.streamsOverflowed += 1;
      },
      onSent: () => {
        this.#stats.eventsSent += 1;
      },
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    stream.prelude(`retry: 2000\n\n`);
    stream.prelude(`event: stream.hello\ndata: ${JSON.stringify({ boot: node.boot, nodeId: node.id, lastSeq, oldestSeq, resumed })}\n\n`);
    if (gap !== null) stream.prelude(`event: stream.gap\ndata: ${JSON.stringify(gap)}\n\n`);
    // Replay and subscription happen in one tick, so no event falls between them.
    if (resumed) stream.replay(node.events.recent({ sinceSeq: after }));
    const off = node.events.on('*', (event) => stream.live(event));
    this.#streams.add(stream);
    this.#stats.streamsOpened += 1;
    const finish = () => {
      off();
      this.#streams.delete(stream);
      stream.closed = true;
    };
    res.on('close', finish);
    stream.onEnd = finish;
    stream.pump();
    return undefined;
  }

  #keepAlive() {
    for (const stream of this.#streams) stream.keepAlive();
  }

  // ------------------------------------------------------------------ static files

  async #serveStatic(req, res, path) {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') {
      return this.#sendError(res, { status: 405, code: 'method_not_allowed', message: 'use GET or HEAD' }, {}, { allow: 'GET, HEAD' });
    }
    if (!this.#config.serveUi) return this.#staticText(res, method, 404, 'Not found\n');
    let segments;
    try {
      segments = path.split('/').slice(1).map((segment) => decodeURIComponent(segment));
    } catch {
      return this.#staticText(res, method, 404, 'Not found\n');
    }
    const name = segments.at(-1) ?? '';
    const extension = extname(name).toLowerCase();
    const unsafe = segments.some((segment) => segment === '.' || segment === '..' || /[\0\\:/]/.test(segment) || (segment.startsWith('.') && segment !== ''));
    if (unsafe || (extension !== '' && !Object.hasOwn(MIME, extension))) return this.#staticText(res, method, 404, 'Not found\n');

    let root;
    try {
      root = await realpath(this.#uiDir);
    } catch {
      return this.#staticText(res, method, 404, NOT_BUILT_TEXT);
    }
    const wanted = extension === '' ? join(root, 'index.html') : join(root, ...segments);
    let file;
    let info;
    try {
      file = await realpath(wanted);
      info = await stat(file);
    } catch {
      return this.#staticText(res, method, 404, extension === '' ? NOT_BUILT_TEXT : 'Not found\n');
    }
    // A link inside the console directory must not lead out of it.
    if ((file !== root && !file.startsWith(root + sep)) || !info.isFile() || info.size > MAX_STATIC_BYTES) {
      return this.#staticText(res, method, 404, 'Not found\n');
    }
    const type = MIME[extname(file).toLowerCase()];
    res.writeHead(200, { ...staticHeaders(), 'content-type': type, 'content-length': info.size });
    if (method === 'HEAD') {
      res.end();
      return undefined;
    }
    const input = createReadStream(file);
    input.on('error', () => res.destroy());
    res.on('close', () => input.destroy());
    input.pipe(res);
    return undefined;
  }

  #staticText(res, method, status, text) {
    const bytes = Buffer.from(text, 'utf8');
    res.writeHead(status, { ...staticHeaders(), 'content-type': 'text/plain; charset=utf-8', 'content-length': bytes.length });
    res.end(method === 'HEAD' ? undefined : bytes);
    return undefined;
  }
}

function staticHeaders() {
  return {
    'content-security-policy': CONSOLE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-cache',
  };
}

/**
 * One open event stream: the frames still to send, a bound on what may queue for a slow
 * reader, and the keep-alive. Replayed events are framed only when they are written (a
 * resume can cover thousands, and framing them all at once would count against the bound
 * of a healthy client); live events are framed on arrival and counted.
 */
class EventStream {
  #res;
  #boot;
  #wanted;
  #onOverflow;
  #onSent;
  #items = [];
  #head = 0;
  #queued = 0;
  #waiting = false;
  closed = false;
  onEnd = () => {};

  constructor({ res, boot, wanted, onOverflow, onSent }) {
    this.#res = res;
    this.#boot = boot;
    this.#wanted = wanted;
    this.#onOverflow = onOverflow;
    this.#onSent = onSent;
  }

  /** A frame that is always sent first (hello, gap). */
  prelude(text) {
    this.#items.push({ text, bytes: 0 });
  }

  /** Events to send, oldest first, before any live one. */
  replay(events) {
    for (const event of events) this.#items.push(event);
  }

  /** A live event; the stream is cut when its reader falls more than the bound behind. */
  live(event) {
    if (this.closed || (this.#wanted !== null && !this.#wanted(event.type))) return;
    const text = this.#frame(event);
    const bytes = Buffer.byteLength(text);
    this.#queued += bytes;
    this.#items.push({ text, bytes });
    if (this.#queued > MAX_STREAM_QUEUE_BYTES) {
      this.#onOverflow();
      this.closed = true;
      this.#res.destroy();
      return;
    }
    this.pump();
  }

  /** Write queued frames until the socket pushes back. */
  pump() {
    while (!this.closed && !this.#waiting && this.#head < this.#items.length) {
      const item = this.#items[this.#head];
      this.#head += 1;
      let frame;
      if (Object.hasOwn(item, 'text')) {
        frame = item.text;
        this.#queued -= item.bytes;
      } else {
        if (this.#wanted !== null && !this.#wanted(item.type)) continue;
        frame = this.#frame(item);
      }
      if (frame.startsWith('id: ')) this.#onSent();
      if (!this.#res.write(frame)) {
        this.#waiting = true;
        this.#res.once('drain', () => {
          this.#waiting = false;
          this.pump();
        });
      }
    }
    if (this.#head > 1024 && this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    }
  }

  keepAlive() {
    if (!this.closed && !this.#waiting && this.#head >= this.#items.length) this.#res.write(': ka\n\n');
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    this.#res.end();
    this.onEnd();
  }

  #frame(event) {
    const data = JSON.stringify({ seq: event.seq, ts: event.ts, type: event.type, data: event.data });
    return `id: ${this.#boot}-${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
  }
}
