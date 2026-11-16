/**
 * Plain-text rendering of API documents for people. `--json` bypasses all of this and
 * prints the document the node returned.
 */

const SHORT = 8;

/** @param {string | null | undefined} id @returns {string} the first 8 characters, or "-" */
export function short(id) {
  return typeof id === 'string' ? id.slice(0, SHORT) : '-';
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  return String(value);
}

/**
 * Lay out rows in left-aligned columns.
 *
 * @param {string[]} header
 * @param {Array<Array<unknown>>} rows
 * @returns {string} lines ending in a newline; the header line only when there are rows
 */
export function table(header, rows) {
  if (rows.length === 0) return '';
  const all = [header, ...rows.map((row) => row.map(cell))];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return `${all.map((row) => row.map((text, i) => (i === row.length - 1 ? text : text.padEnd(widths[i]))).join('  ').trimEnd()).join('\n')}\n`;
}

/** @param {number | null | undefined} ms @returns {string} for example `2m 05s` */
export function duration(ms) {
  if (!Number.isFinite(ms)) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function time(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-';
}

/** @param {object} status GET /status @returns {string} */
export function statusText(status) {
  const lines = [
    `node      ${status.nodeId} (${status.state})`,
    `network   ${status.networkId}   agent ${status.agent}   boot ${status.boot}`,
    `uptime    ${duration(status.uptimeMs)}`,
    `listen    ${cell(status.listen)}`,
    `announces ${status.addresses.length === 0 ? '-' : status.addresses.join(', ')}`,
    `peers     ${status.peers.linked} linked, ${status.peers.dialing} dialing, ${status.peers.known} known (target ${status.peers.target}, max ${status.peers.max})`,
    `routing   ${status.routing.nodes} nodes, ${status.routing.reachable} reachable, rev ${status.routing.rev}`,
    `messages  ${status.messaging.outbox} in the outbox (${status.messaging.waiting} waiting for a route)`,
    `events    ${status.events.oldestSeq}..${status.events.lastSeq}`,
    `services  ${status.services.join(', ')}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** @param {object} identity GET /identity @returns {string} */
export function identityText(identity) {
  return `${identity.nodeId}\n`;
}

/** @param {object} result GET /peers @returns {string} */
export function peersText(result) {
  const rows = result.peers.map((peer) => [
    short(peer.id), peer.direction, peer.addr, peer.rttMs === null ? '-' : `${(peer.srttMs ?? peer.rttMs).toFixed(1)} ms`, peer.cost,
    peer.sticky ? 'sticky' : '', duration(Date.now() - peer.since),
  ]);
  let text = table(['PEER', 'DIR', 'ADDRESS', 'RTT', 'COST', '', 'UP'], rows);
  if (text === '') text = 'no links\n';
  for (const dial of result.dialing) text += `dialing ${dial.addr} (${dial.source}, attempt ${dial.attempt})\n`;
  return text;
}

/** @param {object} result GET /topology/routes @returns {string} */
export function routesText(result) {
  const rows = result.routes.map((route) => [
    short(route.dst), short(route.nextHop), route.hops, route.cost, route.path.map(short).join(' > '),
  ]);
  const text = table(['DESTINATION', 'NEXT HOP', 'HOPS', 'COST', 'PATH'], rows);
  return text === '' ? 'no routes\n' : text;
}

/** @param {object} topology GET /topology @returns {string} */
export function topologyText(topology) {
  const nodes = topology.nodes.map((node) => [
    short(node.id) + (node.self ? ' (this node)' : ''),
    node.linked ? 'linked' : node.reachable ? 'routed' : 'unreachable',
    node.hops, node.cost, node.advertised, node.caps === null ? '-' : Object.entries(node.caps).filter(([, on]) => on).map(([name]) => name).join(','),
  ]);
  const links = topology.links.map((link) => [short(link.a), short(link.b), cell(link.costAB), cell(link.costBA), link.state]);
  return `${table(['NODE', 'STATE', 'HOPS', 'COST', 'LINKS', 'CAPS'], nodes)}\n${table(['A', 'B', 'A>B', 'B>A', 'STATE'], links) || 'no links\n'}`;
}

/** @param {object} message ChatMessage @returns {string} one line */
export function messageLine(message) {
  const arrow = message.direction === 'in' ? '<' : '>';
  return `${time(message.at)} ${arrow} ${short(message.peer)} [${message.state}] ${message.text}`;
}

/** @param {object} result GET /conversations @returns {string} */
export function conversationsText(result) {
  const rows = result.conversations.map((entry) => [short(entry.peer), entry.count, time(entry.lastAt), entry.last.text.replace(/\s+/g, ' ').slice(0, 60)]);
  const text = table(['PEER', 'MESSAGES', 'LAST', 'TEXT'], rows);
  return text === '' ? 'no conversations\n' : text;
}

/** @param {object} page GET /conversations/{id} @returns {string} oldest first */
export function messagesText(page) {
  if (page.items.length === 0) return 'no messages\n';
  return `${[...page.items].reverse().map(messageLine).join('\n')}\n${page.nextBefore === null ? '' : `(older messages exist: --before ${page.nextBefore})\n`}`;
}

/** @param {object} result GET /outbox @returns {string} */
export function outboxText(result) {
  const rows = result.entries.map((entry) => [
    entry.id.slice(0, SHORT), short(entry.dst), entry.kind, entry.state, entry.attempts, entry.bytes, time(entry.expiresAt),
  ]);
  const text = table(['ID', 'TO', 'KIND', 'STATE', 'TRIES', 'BYTES', 'EXPIRES'], rows);
  return text === '' ? 'the outbox is empty\n' : text;
}

/** @param {object} result POST /diag/ping @returns {string} */
export function pingText(result) {
  const lines = result.probes.map((probe) => (probe.rttMs === null
    ? `probe ${probe.seq}: no answer`
    : `probe ${probe.seq}: ${probe.rttMs} ms over ${probe.hops} hop${probe.hops === 1 ? '' : 's'}`));
  lines.push(`${result.sent} sent, ${result.received} received, ${result.lossPct}% loss`);
  if (result.rttMs !== null) lines.push(`rtt min/avg/max = ${result.rttMs.min}/${result.rttMs.avg}/${result.rttMs.max} ms`);
  return `${lines.join('\n')}\n`;
}

/** @param {object} result POST /diag/traceroute @returns {string} */
export function traceText(result) {
  const lines = result.hops.map((hop) => (hop.node === null
    ? `${String(hop.n).padStart(2)}  *`
    : `${String(hop.n).padStart(2)}  ${hop.node} ${hop.rttMs} ms`));
  lines.push(result.reached ? `reached ${short(result.dst)}` : `${short(result.dst)} was not reached`);
  return `${lines.join('\n')}\n`;
}

/** @param {object} snapshot GET /diag/counters @returns {string} counters that are not zero */
export function countersText(snapshot) {
  const rows = Object.entries(snapshot.totals)
    .filter(([, total]) => total > 0)
    .map(([name, total]) => [name, total, snapshot.rates[name] === undefined ? '' : `${snapshot.rates[name]}/s`]);
  const text = table(['COUNTER', 'TOTAL', 'RATE'], rows);
  return text === '' ? 'no counter has moved\n' : text;
}
