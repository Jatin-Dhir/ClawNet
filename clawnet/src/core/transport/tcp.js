/**
 * TCP listener and outbound connections (ARCHITECTURE.md section 5.1).
 *
 * This module knows nothing about Noise, packets or peers. It opens sockets, gives every
 * socket the same options in both directions, and puts a deadline on outbound connects.
 *
 * It also classifies IP addresses for the dial policy of DESIGN.md 15.22: addresses
 * learned from the network that are loopback, unspecified, multicast or link-local are
 * not dialed unless the operator allows it. A DNS name can resolve to such an address,
 * so for those dials the check is repeated on the resolved address.
 */

import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';

import { HandshakeError, StateError } from '../errors.js';

/**
 * Address ranges a node never dials when the address was learned from the network
 * (DESIGN.md 15.22): loopback, unspecified, multicast and link-local, for IPv4 and IPv6.
 * IPv4-mapped IPv6 addresses are normalized to IPv4 before the check.
 */
const RESTRICTED = new net.BlockList();
RESTRICTED.addSubnet('127.0.0.0', 8, 'ipv4');
RESTRICTED.addSubnet('0.0.0.0', 8, 'ipv4');
RESTRICTED.addSubnet('224.0.0.0', 4, 'ipv4');
RESTRICTED.addSubnet('169.254.0.0', 16, 'ipv4');
RESTRICTED.addAddress('255.255.255.255', 'ipv4');
RESTRICTED.addAddress('::1', 'ipv6');
RESTRICTED.addAddress('::', 'ipv6');
RESTRICTED.addSubnet('ff00::', 8, 'ipv6');
RESTRICTED.addSubnet('fe80::', 10, 'ipv6');

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Rewrite an IP address as peers see it: an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 * becomes `a.b.c.d`, and an IPv6 zone id (`%eth0`) is removed.
 *
 * @param {string} address IP address as reported by a socket
 * @returns {string} the normalized address; anything that is not a string becomes ''
 */
export function normalizeIp(address) {
  if (typeof address !== 'string') return '';
  const zone = address.indexOf('%');
  const bare = zone === -1 ? address : address.slice(0, zone);
  const mapped = MAPPED_IPV4.exec(bare);
  return mapped !== null && net.isIPv4(mapped[1]) ? mapped[1] : bare.toLowerCase();
}

/**
 * Whether an IP literal is loopback, unspecified, multicast or link-local: an address a
 * node must not dial when it learned it from the network (DESIGN.md 15.22).
 *
 * @param {string} ip IPv4 or IPv6 literal, without brackets
 * @returns {boolean} true for a restricted address; false for any other IP literal and
 *   for anything that is not an IP literal
 */
export function isRestrictedIp(ip) {
  const address = normalizeIp(ip);
  if (net.isIPv4(address)) return RESTRICTED.check(address, 'ipv4');
  if (net.isIPv6(address)) return RESTRICTED.check(address, 'ipv6');
  return false;
}

/** Options every socket gets, inbound and outbound (ARCHITECTURE.md 5.1). */
function prepareSocket(socket) {
  socket.setNoDelay(true);
  // No idle timeout: the peer layer runs its own keepalive.
  socket.setTimeout(0);
}

/**
 * Open the TCP listener.
 *
 * @param {object} options
 * @param {string} options.host  address to bind (IP literal or host name)
 * @param {number} options.port  port to bind, 0..65535; 0 lets the OS choose
 * @param {(socket: net.Socket) => void} options.onSocket called for every accepted
 *   connection, after the socket options are set
 * @param {(error: Error) => void} [options.onError] called for errors of the listener
 *   after it is listening
 * @returns {Promise<{ address: { host: string, port: number }, close(): Promise<void> }>}
 *   resolves once listening; `address.port` is the bound port. `close()` stops accepting
 *   and resolves when the listener is closed; it does not touch accepted sockets
 * @throws {StateError} "listen-failed: ..." if the address cannot be bound
 */
export async function listenTcp({ host, port, onSocket, onError } = {}) {
  if (typeof onSocket !== 'function') throw new StateError('listen-failed: onSocket must be a function');
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false }, socket => {
    prepareSocket(socket);
    onSocket(socket);
  });
  await new Promise((resolve, reject) => {
    const fail = err => {
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
  server.on('error', err => onError?.(err));
  const bound = server.address();
  let closing = null;
  return {
    address: { host: normalizeIp(bound.address), port: bound.port },
    close() {
      // net.Server reports 'close' only once every accepted socket has ended, and those
      // belong to the peer layer; the listening handle itself is released at once.
      closing ??= new Promise(resolve => {
        server.close(() => {});
        setImmediate(resolve);
      });
      return closing;
    },
  };
}

/**
 * Connect to a TCP address with a deadline.
 *
 * @param {object} options
 * @param {string} options.host     IP literal (IPv6 without brackets) or DNS name
 * @param {number} options.port     1..65535
 * @param {number} options.timeoutMs deadline for the TCP connect, > 0
 * @param {AbortSignal} [options.signal] aborting it abandons the attempt
 * @param {boolean} [options.allowRestricted=true] when false, refuse to connect to a
 *   loopback, unspecified, multicast or link-local address, including one a DNS name
 *   resolves to (DESIGN.md 15.22)
 * @returns {Promise<net.Socket>} a connected socket with the standard options
 * @throws {HandshakeError} "connect-timeout" after `timeoutMs`; "connect-failed" on any
 *   socket or resolution error (the cause is attached) and for a refused restricted
 *   address; "closed" when `signal` aborts. No socket is left open on rejection.
 */
export function dialTcp({ host, port, timeoutMs, signal, allowRestricted = true } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HandshakeError('closed', 'dial aborted'));
      return;
    }
    if (!allowRestricted && net.isIP(host) !== 0 && isRestrictedIp(host)) {
      reject(new HandshakeError('connect-failed', 'address is in a range that is not dialed'));
      return;
    }
    const options = { host, port, allowHalfOpen: false, noDelay: true };
    if (!allowRestricted) options.lookup = restrictedLookup;
    const socket = net.connect(options);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        prepareSocket(socket);
        resolve(socket);
      }
    };
    const onError = (cause) => finish(new HandshakeError('connect-failed', 'TCP connect failed', { cause }));
    const onConnect = () => finish(null);
    const onAbort = () => finish(new HandshakeError('closed', 'dial aborted'));
    const timer = setTimeout(
      () => finish(new HandshakeError('connect-timeout', `TCP connect did not complete in ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.once('error', onError);
    socket.once('connect', onConnect);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** dns.lookup that refuses restricted results, for dials to addresses learned from peers. */
function restrictedLookup(hostname, options, callback) {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err);
      return;
    }
    const list = Array.isArray(address) ? address : [{ address, family }];
    const allowed = list.filter(entry => !isRestrictedIp(entry.address));
    if (allowed.length === 0) {
      const refused = new Error('name resolves only to addresses that are not dialed');
      refused.code = 'ERESTRICTED';
      callback(refused);
      return;
    }
    if (Array.isArray(address)) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}
