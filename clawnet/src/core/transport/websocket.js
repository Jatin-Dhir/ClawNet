/**
 * WebSocket transport, server side (RFC 6455): how a browser reaches a node.
 *
 * A browser cannot open a TCP socket, only a WebSocket. This module accepts WebSocket
 * connections on a port of their own and turns each into a byte stream (a Node Duplex)
 * that the peer manager treats exactly like an accepted TCP socket: the same Noise
 * handshake, identity-card checks, admission policy, packet codec and rate limits run on
 * it (PeerManager#accept). Nothing above this module knows which transport a link uses,
 * except for the `transport: "ws"` label on the link.
 *
 * The mapping is deliberately thin. Binary messages carry the bytes of the link stream,
 * in order; message boundaries mean nothing, so the same bytes may arrive in one message
 * or in many. Text messages are refused (close code 1003). Browsers only dial out, so
 * there is no client side here; the engine's nodes link to each other over TCP.
 *
 * What the server accepts, all checked before the connection is upgraded:
 *
 *   - `GET <path>` over HTTP/1.1 with `Upgrade: websocket`, `Connection: Upgrade`,
 *     `Sec-WebSocket-Version: 13` and a `Sec-WebSocket-Key` of 16 bytes in base64;
 *   - the subprotocol `clawnet.1` among those the client offers (it is echoed back), so
 *     that an unrelated WebSocket client is turned away with an HTTP error instead of
 *     failing a Noise handshake;
 *   - an `Origin`, if the client sent one, that the owner's `checkOrigin` admits. Browsers
 *     always send it and pages cannot forge it; it is what stops a web page the user
 *     happens to visit from using the browser to reach this port (THREAT_MODEL.md).
 *
 * No extension is negotiated, so the RSV bits must be zero. Frames from the client must be
 * masked (section 5.1) and use the shortest length encoding (section 5.2); control frames
 * are at most 125 bytes and never fragmented; a message is at most `maxMessageBytes` in at
 * most 64 fragments (close 1009). A ping is answered with a pong unless 64 KiB already wait
 * to be sent to that client; pongs are ignored. Any violation sends a close frame with the
 * code of section 7.4 and ends the connection.
 *
 * Resource bounds before the upgrade: at most `maxConnections` sockets on the port and
 * `maxPerIp` from one address; a socket that stays silent for `handshakeTimeoutMs` is
 * closed, and the request headers must arrive within `handshakeTimeoutMs` and 8 KiB.
 * After the upgrade the peer manager's bounds apply (handshakes in flight per address and
 * in total, the handshake deadline, the peer limit).
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Duplex } from 'node:stream';

import { StateError } from '../errors.js';
import { normalizeIp } from './tcp.js';

/** The subprotocol a client must offer, and that the server answers with. */
export const WEBSOCKET_SUBPROTOCOL = 'clawnet.1';

/** RFC 6455 section 1.3: the GUID appended to the client's key. */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Largest message accepted by default. Link records are at most 65537 bytes. */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

/** Most sockets from one IP address on the WebSocket port, upgraded or not. */
export const DEFAULT_MAX_PER_IP = 8;

/** Most sockets on the WebSocket port. */
export const DEFAULT_MAX_CONNECTIONS = 128;

/** How long a closing connection waits for the other side before its socket is destroyed. */
export const CLOSE_GRACE_MS = 1000;

/**
 * Most frames one message may be split into. The cap on bytes alone would let a client
 * send endless empty fragments, each costing memory; browsers send whole messages.
 */
export const MAX_FRAGMENTS = 64;

/** Pongs are skipped while this many bytes wait to be sent to the client. */
export const PONG_BACKLOG_BYTES = 64 * 1024;

/** Close codes of RFC 6455 section 7.4.1 that this module sends. */
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
});

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_CONTROL_PAYLOAD = 125;
const MAX_HEADER_BYTES = 8192;
const KEY_PATTERN = /^[A-Za-z0-9+/]{21}[AQgw]==$/;
const PATH_PATTERN = /^\/[A-Za-z0-9._~/-]{0,127}$/;
const TOKEN_LIST = /\s*,\s*/;

/**
 * `Sec-WebSocket-Accept` for a client key (RFC 6455 section 4.2.2).
 *
 * @param {string} key the client's Sec-WebSocket-Key
 * @returns {string}
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`, 'latin1').digest('base64');
}

/**
 * Whether a host name cannot be steered by someone on the internet: an IP literal,
 * `localhost`, or a name under `.local` (multicast DNS) or `.home.arpa` (RFC 8375). A page
 * that reaches this machine through DNS rebinding uses a public name the attacker owns,
 * which none of these is.
 *
 * @param {string} hostname without port; IPv6 in brackets
 * @param {string[]} [extra] further names the owner allows, lower case
 * @returns {boolean}
 */
export function isLocalHostName(hostname, extra = []) {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return false;
  const name = hostname.toLowerCase();
  if (name.startsWith('[') && name.endsWith(']')) return isIP(name.slice(1, -1)) === 6;
  if (isIP(name) === 4) return true;
  if (extra.includes(name)) return true;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  return name === 'localhost' || name.endsWith('.local') || name.endsWith('.home.arpa');
}

/**
 * Split a Host header (or the host part of a URL) into name and port.
 *
 * @param {string} value e.g. "192.168.1.20:47471" or "[::1]:80" or "pc.local"
 * @returns {{ hostname: string, port: number | null } | null}
 */
export function parseHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260) return null;
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (match === null) return null;
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { hostname: match[1].toLowerCase(), port };
}

/**
 * The Origin rule used by a node (DESIGN.md section 16). A connection without `Origin` is
 * not from a browser and is treated like a TCP connection. A browser's is admitted when
 * its origin is listed in `allowedOrigins`, or when it is the node's own web app: the
 * same host name the browser used for this connection, a name that passes
 * isLocalHostName, and the web app's port.
 *
 * @param {object} options
 * @param {string[]} [options.allowedOrigins] exact origins, e.g. "http://192.168.1.20:47490"
 * @param {string[]} [options.allowedHosts] extra host names isLocalHostName accepts
 * @param {() => number | null} [options.webappPort] the port the node's web app is served on
 * @returns {(request: { origin: string | undefined, host: string | undefined }) => boolean}
 */
export function originPolicy({ allowedOrigins = [], allowedHosts = [], webappPort = () => null } = {}) {
  const exact = new Set(allowedOrigins);
  return ({ origin, host }) => {
    if (origin === undefined) return true;
    if (exact.has(origin)) return true;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const port = webappPort();
    if (port === null) return false;
    const originPort = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port);
    if (originPort !== port) return false;
    const requested = parseHostHeader(host ?? '');
    if (requested === null) return false;
    const originHost = url.hostname.toLowerCase();
    return originHost === requested.hostname && isLocalHostName(originHost, allowedHosts);
  };
}

/**
 * Listen for WebSocket connections.
 *
 * @param {object} options
 * @param {string} options.host address to bind
 * @param {number} options.port 0..65535; 0 lets the OS choose
 * @param {string} [options.path="/"] the only path that is upgraded
 * @param {(stream: WebSocketStream) => void} options.onStream called for each upgraded
 *   connection; the owner runs the link handshake on it and destroys it when done
 * @param {(request: { origin: string | undefined, host: string | undefined }) => boolean}
 *   [options.checkOrigin] admission by Origin; default admits everything
 * @param {(error: Error) => void} [options.onError] errors of the listener after it listens
 * @param {(info: { ip: string, status: number, reason: string }) => void} [options.onRefused]
 *   an upgrade request was refused
 * @param {number} [options.maxMessageBytes]
 * @param {number} [options.handshakeTimeoutMs=10000] deadline for the HTTP request headers
 * @param {number} [options.maxConnections]
 * @param {number} [options.maxPerIp]
 * @returns {Promise<{ address: { host: string, port: number }, close(): Promise<void> }>}
 * @throws {StateError} "listen-failed: ..." if the address cannot be bound
 */
export async function listenWebSocket({
  host,
  port,
  path = '/',
  onStream,
  checkOrigin = () => true,
  onError,
  onRefused,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  handshakeTimeoutMs = 10_000,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  maxPerIp = DEFAULT_MAX_PER_IP,
} = {}) {
  if (typeof onStream !== 'function') throw new StateError('listen-failed: onStream must be a function');
  if (typeof path !== 'string' || !PATH_PATTERN.test(path)) throw new StateError('listen-failed: path must look like /segment');
  for (const [name, value] of Object.entries({ maxMessageBytes, handshakeTimeoutMs, maxConnections, maxPerIp })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new StateError(`listen-failed: ${name} must be a positive integer`);
  }
  const perIp = new Map();
  /** Sockets on the port that have not been upgraded; the owner holds the upgraded ones. */
  const pending = new Set();
  const server = createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    requestTimeout: handshakeTimeoutMs,
    headersTimeout: handshakeTimeoutMs,
    keepAliveTimeout: 1000,
    // How often Node checks the two deadlines above; its default is 30 seconds.
    connectionsCheckingInterval: Math.max(100, Math.min(1000, Math.floor(handshakeTimeoutMs / 4))),
  });
  server.maxConnections = maxConnections;

  server.on('connection', (socket) => {
    // Node's HTTP server removes its own error handler before it hands a socket to
    // 'upgrade'. Without this one, a client that resets after a refused upgrade would
    // raise an uncaught error and stop the node.
    socket.on('error', () => socket.destroy());
    // Node's header deadlines start with the first byte received; this closes a socket
    // that sends nothing at all. WebSocketStream clears it once the socket is upgraded.
    socket.setTimeout(handshakeTimeoutMs, () => socket.destroy());
    const ip = normalizeIp(socket.remoteAddress);
    const count = perIp.get(ip) ?? 0;
    if (count >= maxPerIp) {
      socket.destroy();
      return;
    }
    perIp.set(ip, count + 1);
    pending.add(socket);
    socket.once('close', () => {
      pending.delete(socket);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  });

  // Only upgrades are served; any other request learns where it is and is closed.
  server.on('request', (req, res) => {
    const body = 'This port carries ClawNet links over WebSocket only.\n';
    res.writeHead(426, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Upgrade: 'websocket',
      Connection: 'close',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  });

  server.on('upgrade', (req, socket, head) => {
    pending.delete(socket);
    const ip = normalizeIp(socket.remoteAddress);
    const verdict = checkUpgrade(req, path, checkOrigin);
    if (verdict.status !== 101) {
      onRefused?.({ ip, status: verdict.status, reason: verdict.reason });
      refuse(socket, verdict);
      return;
    }
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
      `Sec-WebSocket-Protocol: ${WEBSOCKET_SUBPROTOCOL}`,
      '',
      '',
    ].join('\r\n');
    socket.write(response, 'latin1');
    let stream;
    try {
      stream = new WebSocketStream(socket, { head, maxMessageBytes });
    } catch (err) {
      socket.destroy();
      onError?.(err);
      return;
    }
    try {
      onStream(stream);
    } catch (err) {
      stream.destroy();
      onError?.(err);
    }
  });

  // A malformed request or a client that resets mid-request: nothing to do but close it.
  server.on('clientError', (_err, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', 'latin1');
    }
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      server.removeListener('listening', ok);
      reject(new StateError(`listen-failed: cannot listen on ${host}:${port}`, { cause: err }));
    };
    const ok = () => {
      server.removeListener('error', fail);
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen({ host, port, exclusive: true });
  });
  server.on('error', (err) => onError?.(err));
  const bound = server.address();
  let closing = null;
  return {
    address: { host: normalizeIp(bound.address), port: bound.port },
    /**
     * Stop accepting. Sockets that were never upgraded are closed; upgraded ones belong to
     * the owner, which closes them through the streams it was given.
     */
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => {});
        for (const socket of pending) socket.destroy();
        pending.clear();
        setImmediate(resolve);
      });
      return closing;
    },
  };
}

/** The checks of the module description, in order. @returns {{ status: number, reason: string, headers?: object }} */
function checkUpgrade(req, path, checkOrigin) {
  if (req.method !== 'GET') return { status: 405, reason: 'method' };
  if (req.httpVersionMajor !== 1 || req.httpVersionMinor < 1) return { status: 400, reason: 'http-version' };
  if (req.url !== path) return { status: 404, reason: 'path' };
  const headers = req.headers;
  if (!hasToken(headers.upgrade, 'websocket')) return { status: 400, reason: 'upgrade' };
  if (!hasToken(headers.connection, 'upgrade')) return { status: 400, reason: 'connection' };
  if (headers['sec-websocket-version'] !== '13') {
    return { status: 426, reason: 'version', headers: { 'Sec-WebSocket-Version': '13' } };
  }
  const key = headers['sec-websocket-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return { status: 400, reason: 'key' };
  if (!hasToken(headers['sec-websocket-protocol'], WEBSOCKET_SUBPROTOCOL, false)) {
    return { status: 400, reason: 'subprotocol' };
  }
  let admitted;
  try {
    admitted = checkOrigin({ origin: headers.origin, host: headers.host }) === true;
  } catch {
    admitted = false;
  }
  if (!admitted) return { status: 403, reason: 'origin' };
  return { status: 101, reason: 'ok' };
}

function hasToken(value, token, caseInsensitive = true) {
  if (typeof value !== 'string') return false;
  const wanted = caseInsensitive ? token.toLowerCase() : token;
  return value.split(TOKEN_LIST).some((item) => (caseInsensitive ? item.trim().toLowerCase() : item.trim()) === wanted);
}

function refuse(socket, { status, reason, headers = {} }) {
  const text = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 426: 'Upgrade Required' }[status];
  const body = `${reason}\n`;
  const lines = [
    `HTTP/1.1 ${status} ${text}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    body,
  ];
  if (socket.writable) socket.end(lines.join('\r\n'), 'latin1');
  const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
  timer.unref?.();
  socket.once('close', () => clearTimeout(timer));
}

/**
 * Encode one unmasked server frame (RFC 6455 section 5.2).
 *
 * @param {number} opcode
 * @param {Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeServerFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * One upgraded WebSocket connection as a byte stream. Written bytes go out as binary
 * messages; the payloads of binary messages received are the readable side. Reading is
 * paused at the socket while the reader is not keeping up.
 */
export class WebSocketStream extends Duplex {
  #socket;
  #maxMessage;
  #chunks = [];
  #buffered = 0;
  /** The message being reassembled from fragments, or null. */
  #fragments = null;
  #closeSent = false;
  #closeReceived = false;
  #failed = false;
  #closeTimer = null;

  /**
   * @param {import('node:net').Socket} socket upgraded, after the 101 response was written
   * @param {{ head?: Buffer, maxMessageBytes?: number }} [options] `head`: bytes the HTTP
   *   parser read past the request
   */
  constructor(socket, { head, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super({ allowHalfOpen: false });
    // Errors go to whoever listens (the link handshake, then the secure channel). A stream
    // refused before anyone listened must not turn a client's bad frame into a crash.
    this.on('error', () => {});
    this.#socket = socket;
    this.#maxMessage = maxMessageBytes;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('end', () => this.#onSocketEnd());
    socket.on('error', (error) => this.destroy(error));
    socket.on('close', () => {
      clearTimeout(this.#closeTimer);
      if (!this.destroyed) {
        this.push(null);
        this.destroy();
      }
    });
    if (head !== undefined && head.length > 0) this.#onData(head);
  }

  /** @returns {string | undefined} the client's IP address as the socket reports it */
  get remoteAddress() {
    return this.#socket.remoteAddress;
  }

  /** @returns {number | undefined} */
  get remotePort() {
    return this.#socket.remotePort;
  }

  _read() {
    if (this.#socket.isPaused() && !this.#socket.destroyed) this.#socket.resume();
  }

  _write(chunk, _encoding, callback) {
    // Once a close frame is out nothing more may be sent (section 5.5.1); the link is
    // going away, so the bytes are dropped rather than reported as an error.
    if (this.#closeSent || this.#socket.destroyed || !this.#socket.writable) {
      callback();
      return;
    }
    this.#socket.write(encodeServerFrame(OP_BINARY, chunk), (error) => callback(error ?? undefined));
  }

  _final(callback) {
    this.#sendClose(CloseCode.NORMAL, '');
    if (this.#closeReceived) this.#endSocket();
    else this.#armCloseTimer();
    callback();
  }

  _destroy(error, callback) {
    if (!this.#socket.destroyed) {
      this.#sendClose(error ? CloseCode.INTERNAL_ERROR : CloseCode.NORMAL, '');
      this.#endSocket();
    }
    callback(error);
  }

  // ---------------------------------------------------------------- receiving

  #onData(chunk) {
    if (this.#failed || this.#closeReceived) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    for (;;) {
      const frame = this.#nextFrame();
      if (frame === null) return;
      this.#handleFrame(frame);
      if (this.#failed || this.#closeReceived) return;
    }
  }

  /** The next complete frame, unmasked, or null; fails the connection on a bad header. */
  #nextFrame() {
    if (this.#buffered < 2) return null;
    const start = this.#peek(14);
    const fin = (start[0] & 0x80) !== 0;
    const rsv = start[0] & 0x70;
    const opcode = start[0] & 0x0f;
    const masked = (start[1] & 0x80) !== 0;
    const short = start[1] & 0x7f;
    if (rsv !== 0) return this.#fail(CloseCode.PROTOCOL_ERROR, 'reserved bits are set');
    if (!masked) return this.#fail(CloseCode.PROTOCOL_ERROR, 'client frames must be masked');
    const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
    const headerLength = 2 + extended + 4;
    if (this.#buffered < headerLength) return null;
    let length = short;
    if (short === 126) {
      length = start.readUInt16BE(2);
      if (length < 126) return this.#fail(CloseCode.PROTOCOL_ERROR, 'length is not minimally encoded');
    } else if (short === 127) {
      const big = start.readBigUInt64BE(2);
      if (big >> 63n !== 0n) return this.#fail(CloseCode.PROTOCOL_ERROR, 'length has its top bit set');
      if (big < 65536n) return this.#fail(CloseCode.PROTOCOL_ERROR, 'length is not minimally encoded');
      if (big > BigInt(this.#maxMessage)) return this.#fail(CloseCode.MESSAGE_TOO_BIG, 'message is too big');
      length = Number(big);
    }
    if (opcode >= 0x8) {
      if (!fin) return this.#fail(CloseCode.PROTOCOL_ERROR, 'control frames must not be fragmented');
      if (length > MAX_CONTROL_PAYLOAD) return this.#fail(CloseCode.PROTOCOL_ERROR, 'control frame is too long');
    } else if (length > this.#maxMessage) {
      return this.#fail(CloseCode.MESSAGE_TOO_BIG, 'message is too big');
    }
    if (this.#buffered < headerLength + length) return null;
    const bytes = this.#take(headerLength + length);
    const mask = bytes.subarray(2 + extended, headerLength);
    const payload = bytes.subarray(headerLength);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_BINARY:
      case OP_TEXT:
        if (this.#fragments !== null) {
          this.#fail(CloseCode.PROTOCOL_ERROR, 'a new message began inside a fragmented one');
          return;
        }
        if (opcode === OP_TEXT) {
          this.#fail(CloseCode.UNSUPPORTED_DATA, 'only binary messages are accepted');
          return;
        }
        if (fin) this.#deliver(payload);
        else this.#fragments = { parts: [payload], size: payload.length };
        return;
      case OP_CONTINUATION: {
        const message = this.#fragments;
        if (message === null) {
          this.#fail(CloseCode.PROTOCOL_ERROR, 'continuation without a message');
          return;
        }
        if (message.parts.length >= MAX_FRAGMENTS) {
          this.#fail(CloseCode.MESSAGE_TOO_BIG, 'message has too many fragments');
          return;
        }
        message.size += payload.length;
        if (message.size > this.#maxMessage) {
          this.#fail(CloseCode.MESSAGE_TOO_BIG, 'message is too big');
          return;
        }
        message.parts.push(payload);
        if (fin) {
          this.#fragments = null;
          this.#deliver(Buffer.concat(message.parts, message.size));
        }
        return;
      }
      case OP_PING:
        // A client that pings without reading gets no more pongs: what waits to be sent to
        // it would otherwise grow with every ping.
        if (!this.#closeSent && this.#socket.writable && this.#socket.writableLength < PONG_BACKLOG_BYTES) {
          this.#socket.write(encodeServerFrame(OP_PONG, payload));
        }
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.#onClose(payload);
        return;
      default:
        this.#fail(CloseCode.PROTOCOL_ERROR, 'reserved opcode');
    }
  }

  #deliver(payload) {
    if (payload.length === 0) return;
    if (!this.push(payload)) this.#socket.pause();
  }

  /** A close frame from the client (section 5.5.1): answer it, then end the connection. */
  #onClose(payload) {
    this.#closeReceived = true;
    let code = CloseCode.NORMAL;
    if (payload.length === 1) {
      this.#closeReceived = false;
      this.#fail(CloseCode.PROTOCOL_ERROR, 'close frame with a one-byte payload');
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
      let reasonOk = true;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
      } catch {
        reasonOk = false;
      }
      if (!valid || !reasonOk) {
        this.#closeReceived = false;
        this.#fail(valid ? CloseCode.INVALID_PAYLOAD : CloseCode.PROTOCOL_ERROR, 'malformed close frame');
        return;
      }
    }
    this.#sendClose(code === 1005 ? CloseCode.NORMAL : code, '');
    this.#endSocket();
    this.push(null);
  }

  #onSocketEnd() {
    // The client went away without a close frame (or after one): the stream ends here.
    this.push(null);
    if (!this.#socket.writableEnded) this.#endSocket();
  }

  /** Fail the connection (section 7.1.7): close frame with a code, end, stop reading. */
  #fail(code, reason) {
    this.#failed = true;
    this.#chunks = [];
    this.#buffered = 0;
    this.#fragments = null;
    this.#sendClose(code, reason);
    this.#endSocket();
    const error = new Error(`websocket: ${reason}`);
    error.code = 'ERR_WEBSOCKET';
    error.closeCode = code;
    this.destroy(error);
    return null;
  }

  #sendClose(code, reason) {
    if (this.#closeSent || this.#socket.destroyed || !this.#socket.writable) return;
    this.#closeSent = true;
    const text = Buffer.from(reason.slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.#socket.write(encodeServerFrame(OP_CLOSE, payload));
  }

  #endSocket() {
    if (!this.#socket.destroyed && !this.#socket.writableEnded) this.#socket.end();
    this.#armCloseTimer();
  }

  #armCloseTimer() {
    if (this.#closeTimer !== null || this.#socket.destroyed) return;
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS);
    this.#closeTimer.unref?.();
  }

  // ---------------------------------------------------------------- buffer

  /** Up to `n` leading bytes, copied, without consuming them. */
  #peek(n) {
    const want = Math.min(n, this.#buffered);
    const out = Buffer.alloc(want);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const take = Math.min(chunk.length, want - filled);
      chunk.copy(out, filled, 0, take);
      filled += take;
      if (filled === want) break;
    }
    return out;
  }

  /** Remove and return the first `n` bytes as a new buffer. */
  #take(n) {
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0];
      const take = Math.min(chunk.length, n - filled);
      chunk.copy(out, filled, 0, take);
      filled += take;
      if (take === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    this.#buffered -= n;
    return out;
  }
}
