/**
 * The phone web app server (DESIGN.md section 16): hands the browser node in `web/` to
 * phones on the local network.
 *
 * It is a separate, opt-in HTTP server on a port of its own (`webapp.port`). It serves
 * static files and one small JSON document and nothing else: no API, no token, no state.
 * The control API keeps its own server on 127.0.0.1; nothing here can reach it. The phone
 * that loads the app becomes a node of its own and links to this node over the WebSocket
 * port, like any other peer.
 *
 * Serving rules:
 *
 *   - The files are read once, at start, from a fixed list: everything in `web/app`,
 *     `web/core` and `web/vendor` with a known extension, plus the three engine modules the
 *     browser code shares (`src/core/errors.js`, `src/core/wire/types.js`,
 *     `src/core/wire/canonical.js`). URL paths are the files' paths inside `clawnet/`, and
 *     `/` is the app. A request matches an entry of that table or gets 404, so no request
 *     ever touches the file system.
 *   - GET and HEAD only. Responses carry an ETag and `Cache-Control: no-cache`, so a phone
 *     always revalidates and picks up a new version of the app as soon as the computer has
 *     one.
 *   - The `Host` header must name this machine in a way an outsider cannot redirect: an IP
 *     address, `localhost`, a `.local` or `.home.arpa` name, or one of
 *     `webapp.allowedHosts`. That defeats DNS rebinding, and the same rule decides which
 *     origins the WebSocket port admits.
 *   - Every response has a strict Content-Security-Policy: scripts, styles and images from
 *     this origin only, and connections to this origin and to this node's WebSocket port
 *     under the same host name.
 *   - `/config.json` tells the app the network id, whether a network key is needed (never
 *     the key itself, which the user types on the phone) and the WebSocket port. It does
 *     not reveal this node's identity, which a private network's handshake keeps from
 *     non-members.
 *
 * Plain HTTP on a home network has a limit that no header removes: anyone who can tamper
 * with traffic on that network can change the app before it reaches the phone.
 * THREAT_MODEL.md says so; the owner should use it on a network they trust.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, StateError } from '../core/errors.js';
import { DEFAULT_AGENT } from '../core/peer/peer-manager.js';
import { isLocalHostName, parseHostHeader } from '../core/transport/websocket.js';
import { normalizeIp } from '../core/transport/tcp.js';

/** The engine directory (`clawnet/`), the root URL paths are relative to. */
export const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories served whole, relative to ENGINE_ROOT. */
export const SERVED_DIRS = Object.freeze(['web/app', 'web/core', 'web/vendor']);

/** Engine modules the browser code imports, relative to ENGINE_ROOT. */
export const SHARED_MODULES = Object.freeze(['src/core/errors.js', 'src/core/wire/types.js', 'src/core/wire/canonical.js']);

/** The page served at `/`. */
export const INDEX_PATH = 'web/app/index.html';

/** Most connections at once, and from one address. */
export const MAX_CONNECTIONS = 64;
export const MAX_CONNECTIONS_PER_IP = 16;

/** A connection with no traffic either way for this long is closed. */
export const IDLE_TIMEOUT_MS = 10_000;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
});
/** Files without an extension that are served as text: the vendored licences. */
const TEXT_NAMES = new Set(['LICENSE']);
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const COMMON_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
});

/**
 * Build the table of served files.
 *
 * @param {string} [root] engine directory; default ENGINE_ROOT
 * @returns {Map<string, { body: Buffer, type: string, etag: string }>} by URL path
 * @throws {ConfigError} if the index page is missing or the files are too large
 */
export function loadWebFiles(root = ENGINE_ROOT) {
  const files = new Map();
  let total = 0;
  const add = (relPath) => {
    const name = relPath.split('/').pop();
    const dot = name.lastIndexOf('.');
    const type = dot > 0 ? MIME[name.slice(dot)] : TEXT_NAMES.has(name) ? MIME['.txt'] : undefined;
    if (type === undefined) return;
    const body = readFileSync(join(root, ...relPath.split('/')));
    total += body.length;
    if (total > MAX_TOTAL_BYTES) throw new ConfigError('the web app is larger than the server will hold');
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    files.set(`/${relPath}`, { body, type, etag });
  };
  for (const dir of SERVED_DIRS) {
    const base = join(root, ...dir.split('/'));
    let entries;
    try {
      entries = readdirSync(base, { recursive: true, withFileTypes: true });
    } catch (cause) {
      throw new ConfigError(`the web app directory ${dir} cannot be read`, { cause });
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      // Hidden files and anything that is not plainly named are never served.
      if (rel.split('/').some((part) => part.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(part))) continue;
      if (statSync(full).isFile()) add(rel);
    }
  }
  for (const module of SHARED_MODULES) add(module);
  if (!files.has(`/${INDEX_PATH}`)) throw new ConfigError(`the web app has no ${INDEX_PATH}`);
  return files;
}

/**
 * The Content-Security-Policy of a response, for the host name the browser used.
 *
 * @param {string} hostname validated, IPv6 in brackets
 * @param {number | null} wsPort the node's WebSocket port
 * @returns {string}
 */
export function contentSecurityPolicy(hostname, wsPort) {
  const ws = wsPort === null ? '' : ` ws://${hostname}:${wsPort}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${ws}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The addresses a phone on the local network can open the app at: one per local IPv4
 * address when the server listens on all of them, else the address it listens on.
 *
 * @param {{ host: string, port: number }} address the bound address
 * @param {() => object} [interfaces] os.networkInterfaces, injectable for tests
 * @returns {string[]}
 */
export function appUrls(address, interfaces = networkInterfaces) {
  const { host, port } = address;
  if (host !== '0.0.0.0' && host !== '::') {
    return [`http://${host.includes(':') ? `[${host}]` : host}:${port}/`];
  }
  const out = [];
  for (const list of Object.values(interfaces() ?? {})) {
    for (const entry of list ?? []) {
      const v4 = entry.family === 'IPv4' || entry.family === 4;
      if (v4 && !entry.internal && !entry.address.startsWith('169.254.')) out.push(`http://${entry.address}:${port}/`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * The `webapp` service. It does nothing unless `webapp.enabled`.
 *
 * @param {{ root?: string, interfaces?: () => object }} [options] `root`: where `web/` is
 *   found (tests); `interfaces`: os.networkInterfaces
 * @returns {object} a service (ARCHITECTURE.md section 6)
 */
export function createWebAppService({ root = ENGINE_ROOT, interfaces = networkInterfaces } = {}) {
  let ctx = null;
  let enabled = false;
  let server = null;
  let address = null;
  let files = null;
  const stats = { requests: 0, served: 0, notModified: 0, notFound: 0, refusedHost: 0, refusedMethod: 0, refusedConnections: 0 };

  const service = {
    name: 'webapp',

    init(context) {
      ctx = context;
      enabled = context.config.webapp.enabled;
    },

    async start() {
      if (!enabled) return;
      files = loadWebFiles(root);
      const { host, port } = ctx.config.webapp;
      server = createWebServer({
        files,
        config: ctx.config,
        wsPort: () => ctx.node.websocketAddress?.port ?? null,
        stats,
      });
      await new Promise((resolve, reject) => {
        const fail = (cause) => {
          server.removeListener('listening', ok);
          reject(new StateError(`webapp-listen-failed: cannot listen on ${host}:${port}`, { cause }));
        };
        const ok = () => {
          server.removeListener('error', fail);
          resolve();
        };
        server.once('error', fail);
        server.once('listening', ok);
        server.listen({ host, port, exclusive: true });
      });
      server.on('error', (error) => ctx.log.warn('webapp server error', { message: String(error?.message).slice(0, 200) }));
      const bound = server.address();
      address = { host: normalizeIp(bound.address), port: bound.port };
      ctx.log.info('phone web app served', { port: address.port });
    },

    async stop() {
      const closing = server;
      server = null;
      address = null;
      if (closing === null) return;
      await new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    },

    stats() {
      return { ...stats, files: files?.size ?? 0 };
    },

    api: {
      /** @returns {number | null} the bound port */
      get port() {
        return address?.port ?? null;
      },
      /** @returns {{ host: string, port: number } | null} */
      get address() {
        return address === null ? null : { ...address };
      },
      /** @returns {string[]} where phones on the network can open the app */
      urls() {
        return address === null ? [] : appUrls(address, interfaces);
      },
    },
  };
  return service;
}

/**
 * The HTTP server itself, separate from the service so tests can run it alone.
 *
 * @param {object} options
 * @param {Map<string, { body: Buffer, type: string, etag: string }>} options.files
 * @param {object} options.config the node configuration
 * @param {() => number | null} options.wsPort
 * @param {object} [options.stats] counters to increment
 * @param {number} [options.idleTimeoutMs] see IDLE_TIMEOUT_MS
 * @returns {import('node:http').Server}
 */
export function createWebServer({ files, config, wsPort, stats = {}, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  const allowedHosts = config.webapp.allowedHosts;
  const perIp = new Map();
  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1000,
  });
  server.maxConnections = MAX_CONNECTIONS;
  const count = (name) => {
    stats[name] = (stats[name] ?? 0) + 1;
  };

  server.on('connection', (socket) => {
    socket.on('error', () => socket.destroy());
    // Node's header deadline starts with the first byte received; this also closes a
    // socket that sends nothing, or stops reading, for ten seconds.
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    const ip = normalizeIp(socket.remoteAddress);
    const n = perIp.get(ip) ?? 0;
    if (n >= MAX_CONNECTIONS_PER_IP) {
      count('refusedConnections');
      socket.destroy();
      return;
    }
    perIp.set(ip, n + 1);
    socket.once('close', () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  });

  // This server never upgrades: the app links through the WebSocket port.
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', 'latin1');
    socket.destroy();
  });

  server.on('request', (req, res) => {
    count('requests');
    const send = (status, headers, body) => {
      const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body ?? Buffer.alloc(0);
      res.writeHead(status, { ...COMMON_HEADERS, ...headers, 'Content-Length': payload.length });
      res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const host = parseHostHeader(req.headers.host ?? '');
    if (host === null || !isLocalHostName(host.hostname, allowedHosts)) {
      count('refusedHost');
      send(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        'Open the ClawNet app with this computer\'s IP address, for example http://192.168.1.20:47490/\n');
      return;
    }
    const csp = contentSecurityPolicy(host.hostname, wsPort());
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      count('refusedMethod');
      send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': csp }, 'Method not allowed\n');
      return;
    }
    const url = typeof req.url === 'string' && req.url.startsWith('/') && req.url.length <= 2048 ? req.url : '/';
    const path = url.split('?')[0];

    if (path === '/config.json') {
      const body = JSON.stringify({
        v: 1,
        networkId: config.networkId,
        keyRequired: config.networkKey !== null,
        websocket: { port: wsPort(), path: '/' },
        agent: DEFAULT_AGENT,
      });
      send(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp }, body);
      count('served');
      return;
    }

    const file = files.get(path === '/' ? `/${INDEX_PATH}` : path);
    if (file === undefined) {
      count('notFound');
      send(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp }, 'Not found\n');
      return;
    }
    const headers = {
      'Content-Type': file.type,
      ETag: file.etag,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': csp,
    };
    if (req.headers['if-none-match'] === file.etag) {
      count('notModified');
      res.writeHead(304, { ...COMMON_HEADERS, ...headers });
      res.end();
      return;
    }
    count('served');
    send(200, headers, file.body);
  });
  return server;
}
