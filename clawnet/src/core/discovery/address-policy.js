/**
 * Which addresses discovery may dial (DESIGN.md section 15, item 22).
 *
 * A signed peer record or beacon proves who said an address, not that the address is
 * theirs. Without a policy, anyone could publish `tcp://127.0.0.1:22` or the address of
 * a victim and have every node in the network knock on it. So an address that was
 * *learned* (from a peer record or a beacon) is never dialed when its host is
 *
 *   - loopback        127.0.0.0/8, ::1
 *   - unspecified     0.0.0.0/8, ::
 *   - multicast       224.0.0.0/4, ff00::/8
 *   - link-local      169.254.0.0/16, fe80::/10
 *   - reserved        240.0.0.0/4 (which holds the limited broadcast 255.255.255.255)
 *
 * unless `discovery.allowLoopback` is set (tests and single-machine networks). IPv6
 * addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64 and 6to4) are
 * judged by the embedded address. Private ranges such as 10.0.0.0/8 are allowed: they are
 * what a LAN uses.
 *
 * DNS names cannot be judged by what they look like, because a name resolves to whatever
 * its owner wants. This module refuses the names that are loopback or link-local by
 * definition (`localhost`, `*.localhost`, `*.local`) and unqualified names (no dot),
 * which only resolve through a search list on the local network. A name that resolves to
 * a refused IP is something only the connector sees: the TCP transport must apply
 * `isDialableIp` to the address it actually connects to (see "needs" of the discovery
 * work in the integration notes).
 *
 * Configured bootstrap addresses and addresses given to `connect()` by the operator are
 * trusted and do not pass through this policy.
 *
 * Pure functions: no I/O, no clock.
 */

import { isIpLiteral, parseAddress } from '../wire/schema.js';

/** Why a host is not dialed. Stable identifiers: they appear in stats and logs. */
export const HostClass = Object.freeze({
  LOOPBACK: 'loopback',
  UNSPECIFIED: 'unspecified',
  MULTICAST: 'multicast',
  LINK_LOCAL: 'link-local',
  RESERVED: 'reserved',
  UNQUALIFIED: 'unqualified',
});

const IPV4_LENGTH = 4;
const IPV6_LENGTH = 16;
const IPV4_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Parse a dotted-quad IPv4 literal.
 *
 * @param {string} text
 * @returns {number[] | null} four octets, or null if `text` is not a plain IPv4 literal
 */
function parseIpv4(text) {
  if (!IPV4_SHAPE.test(text) || !isIpLiteral(text)) return null;
  return text.split('.').map(Number);
}

/**
 * Parse an IPv6 literal (no brackets, no zone) into 16 bytes, including the forms with
 * `::` and with an embedded IPv4 tail.
 *
 * @param {string} text
 * @returns {number[] | null}
 */
function parseIpv6(text) {
  if (!text.includes(':') || !isIpLiteral(text)) return null;
  let head = text;
  let tail = [];
  const lastColon = text.lastIndexOf(':');
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const v4 = parseIpv4(dotted);
    if (v4 === null) return null;
    head = text.slice(0, lastColon + 1) + '0:0';
    tail = v4;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groupsOf = part => (part === '' ? [] : part.split(':'));
  const left = groupsOf(halves[0]);
  const right = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length === IPV4_LENGTH) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Category of an IPv4 address given as four octets, or null if it is dialable. */
function classifyV4(o) {
  if (o[0] === 0) return HostClass.UNSPECIFIED;
  if (o[0] === 127) return HostClass.LOOPBACK;
  if (o[0] === 169 && o[1] === 254) return HostClass.LINK_LOCAL;
  if (o[0] >= 224 && o[0] <= 239) return HostClass.MULTICAST;
  if (o[0] >= 240) return HostClass.RESERVED;
  return null;
}

/** Category of an IPv6 address given as 16 bytes, or null if it is dialable. */
function classifyV6(b) {
  const zeroUpTo = n => b.slice(0, n).every(x => x === 0);
  if (zeroUpTo(15) && b[15] === 0) return HostClass.UNSPECIFIED;
  if (zeroUpTo(15) && b[15] === 1) return HostClass.LOOPBACK;
  if (b[0] === 0xff) return HostClass.MULTICAST;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return HostClass.LINK_LOCAL;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the stack may connect
  // to the embedded IPv4 address.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));
  if (zeroUpTo(12)) return classifyV4(b.slice(12));
  // NAT64 well-known prefix 64:ff9b::/96 and 6to4 2002::/16 embed an IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every(x => x === 0)) {
    return classifyV4(b.slice(12));
  }
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));
  return null;
}

/**
 * Judge an IP literal.
 *
 * @param {string} ip IPv4 or IPv6 literal, without brackets or zone
 * @returns {string | null} a HostClass value if the address must not be dialed, null if
 *   it may be; an unparsable literal is reported as `reserved` (fail closed)
 */
export function classifyIp(ip) {
  if (typeof ip !== 'string') return HostClass.RESERVED;
  const v4 = parseIpv4(ip);
  if (v4 !== null) return classifyV4(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null && v6.length === IPV6_LENGTH) return classifyV6(v6);
  return HostClass.RESERVED;
}

/**
 * True if an IP that a transport is about to connect to may be dialed under the policy.
 * The TCP transport applies this to the *resolved* address of a learned DNS name.
 *
 * @param {string} ip
 * @param {{ allowLoopback?: boolean }} [options]
 * @returns {boolean}
 */
export function isDialableIp(ip, { allowLoopback = false } = {}) {
  return allowLoopback || classifyIp(ip) === null;
}

/**
 * Judge a host as it appears in an address: an IP literal (IPv6 without brackets) or a
 * DNS name.
 *
 * @param {string} host
 * @returns {string | null} a HostClass value, or null if the host may be dialed
 */
export function classifyHost(host) {
  if (typeof host !== 'string' || host === '') return HostClass.RESERVED;
  if (isIpLiteral(host)) return classifyIp(host);
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return HostClass.LOOPBACK;
  if (name.endsWith('.local')) return HostClass.LINK_LOCAL;
  if (!name.includes('.')) return HostClass.UNQUALIFIED;
  return null;
}

/**
 * Key under which dial budgets are kept: one per IP address, so that many NodeIds
 * claiming one address share its budget. IPv4-mapped IPv6 addresses share the key of the
 * IPv4 address; other IPv6 addresses are written out in full so that every spelling of
 * one address has one key. A DNS name is its own key (its IP is not known here).
 *
 * @param {string} host as in `parseAddress(addr).host`
 * @returns {string}
 */
export function budgetKey(host) {
  const v4 = parseIpv4(host);
  if (v4 !== null) return v4.join('.');
  const v6 = parseIpv6(host);
  if (v6 === null) return `name:${String(host).toLowerCase()}`;
  const mapped = v6.slice(0, 10).every(x => x === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return v6.slice(12).join('.');
  return Buffer.from(v6).toString('hex');
}

/**
 * Check an address that was *learned* from the network.
 *
 * @param {unknown} addr `tcp://host:port`
 * @param {{ allowLoopback?: boolean }} [options]
 * @returns {{ ok: true, host: string, port: number, key: string }
 *   | { ok: false, reason: string }} `reason` is "invalid" for a malformed address or
 *   a HostClass value
 */
export function checkLearnedAddress(addr, { allowLoopback = false } = {}) {
  const parsed = parseAddress(addr);
  if (parsed === null) return { ok: false, reason: 'invalid' };
  if (!allowLoopback) {
    const refused = classifyHost(parsed.host);
    if (refused !== null) return { ok: false, reason: refused };
  }
  return { ok: true, host: parsed.host, port: parsed.port, key: budgetKey(parsed.host) };
}
