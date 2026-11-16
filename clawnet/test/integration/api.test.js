/**
 * The control API of several real ClawNodes talking to each other over loopback TCP: what
 * its documents say about a network that exists, a message that crosses it end to end, one
 * that waits across a partition, diagnostics, and the live event stream. Everything runs on
 * one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ApiClient } from '../../src/cli/client.js';
import { createDiagService } from '../../src/core/diag/diag.js';
import { createMessagesService } from '../../src/core/messaging/conversations.js';
import { createApiService } from '../../src/gate/api-server.js';
import { call, openStream } from '../helpers/api.js';
import { startCluster } from '../helpers/cluster.js';

const services = () => [createMessagesService(), createDiagService(), createApiService({ requestsPerSec: 1_000_000, authFailuresPerSec: 1_000_000 })];
const apiConfig = () => ({ api: { enabled: true, port: 0 } });

/** A line of nodes, each with its API; `clients[i]` talks to node i. */
async function network(t, { size = 3, netem = false } = {}) {
  const cluster = await startCluster(t, { size, topology: 'line', netem, services, config: apiConfig });
  await cluster.converged();
  const clients = await Promise.all(cluster.dirs.map((dir) => ApiClient.fromDataDir(dir)));
  const tokens = await Promise.all(cluster.dirs.map(async (dir) => (await readFile(join(dir, 'api-token'), 'utf8')).trim()));
  const port = (i) => cluster.nodes[i].service('api').address.port;
  const waitApi = (predicate, message) => cluster.waitFor(async () => predicate(), { message, timeoutMs: 8000 });
  return { cluster, clients, tokens, port, waitApi };
}

test('the documents describe the network that exists: peers, topology, routes and one node in detail', async (t) => {
  const { cluster, clients } = await network(t);
  const [a, b, c] = cluster.ids;

  const status = await clients[0].request('GET', '/status');
  assert.deepEqual([status.nodeId, status.peers.linked, status.routing.nodes, status.routing.reachable], [a, 1, 3, 2]);
  assert.equal(status.asOf.boot, status.boot);

  const peers = await clients[1].request('GET', '/peers');
  assert.deepEqual(peers.peers.map((peer) => peer.id).sort(), [a, c].sort());
  for (const peer of peers.peers) {
    assert.match(peer.addr, /^tcp:\/\/127\.0\.0\.1:[0-9]+$/);
    assert.deepEqual(Object.keys(peer.caps).sort(), ['mailbox', 'relay', 'transit']);
    assert.ok(peer.cost >= 1 && peer.cost <= 65535);
    assert.ok(['in', 'out'].includes(peer.direction));
    assert.ok(peer.packetsIn > 0 && peer.bytesOut > 0);
  }
  // In the line node 0 dials node 1 and node 1 dials node 2.
  assert.deepEqual(peers.peers.map((peer) => [peer.id, peer.direction]).sort(), [[a, 'in'], [c, 'out']].sort());

  const topology = await clients[0].request('GET', '/topology');
  assert.equal(topology.self, a);
  assert.deepEqual(topology.nodes.map((node) => node.id).sort(), [a, b, c].sort());
  const byId = new Map(topology.nodes.map((node) => [node.id, node]));
  assert.deepEqual([byId.get(a).hops, byId.get(b).hops, byId.get(c).hops], [0, 1, 2]);
  assert.deepEqual([byId.get(b).linked, byId.get(c).linked, byId.get(c).nextHop], [true, false, b]);
  assert.ok(topology.nodes.every((node) => node.reachable));
  const links = topology.links.map((link) => [link.a < link.b ? link.a : link.b, link.a < link.b ? link.b : link.a, link.state]);
  assert.deepEqual(links.sort(), [[a, b, 'confirmed'], [b, c, 'confirmed']].map(([x, y, s]) => [x < y ? x : y, x < y ? y : x, s]).sort());
  assert.ok(topology.links.every((link) => link.a < link.b && link.costAB >= 1 && link.costBA >= 1));

  const routes = await clients[0].request('GET', '/topology/routes');
  assert.deepEqual(routes.routes.map((route) => [route.dst, route.hops]), [[b, 1], [c, 2]]);
  assert.deepEqual(routes.routes[1].path, [a, b, c]);
  assert.ok(routes.rev >= topology.rev, 'the routing revision only grows');

  const detail = await clients[0].request('GET', `/topology/nodes/${c}`);
  assert.equal(detail.node.id, c);
  assert.deepEqual(detail.route.path, [a, b, c]);
  assert.equal(detail.lsa.origin, c);
  assert.equal(detail.lsa.links.length, 1);
  assert.equal(detail.lsa.links[0].peer, b);
  assert.equal(detail.peerRecord.origin, c);
  assert.deepEqual(detail.peerRecord.card.id, c);

  const sync = await clients[0].request('GET', '/diag/sync');
  assert.equal(sync.datasets.find((dataset) => dataset.name === 'lsa').entries, 3);
  assert.equal(sync.datasets.find((dataset) => dataset.name === 'peer').entries, 3);
  assert.ok(sync.engine.recordsIn > 0 && sync.engine.roundsCompleted >= 0);

  // Each node has its own token.
  const crossed = await call(cluster.nodes[1].service('api').address.port, { path: '/api/v1/status', token: (await readFile(join(cluster.dirs[0], 'api-token'), 'utf8')).trim() });
  assert.equal(crossed.status, 401);
});

test('a message sent through the first node\'s API is delivered to the third through the second, and both ends show it', async (t) => {
  const { cluster, clients, tokens, port, waitApi } = await network(t);
  const [a, , c] = cluster.ids;
  const sender = await openStream(port(0), { token: tokens[0], query: '?types=chat.*,message.*' });
  const receiver = await openStream(port(2), { token: tokens[2], query: '?types=chat.*' });
  const relay = await openStream(port(1), { token: tokens[1], query: '?types=packet.*' });
  t.after(() => {
    sender.close();
    receiver.close();
    relay.close();
  });
  await Promise.all([sender.take(1), receiver.take(1), relay.take(1)]);

  const secret = 'status report at 0900 — café';
  const sent = await call(port(0), { method: 'POST', path: '/api/v1/messages', token: tokens[0], body: { to: c, text: secret } });
  assert.equal(sent.status, 202);
  const { message } = sent.json;
  assert.deepEqual(Object.keys(message).sort(), ['at', 'direction', 'id', 'peer', 'seq', 'state', 'text', 'ts']);
  assert.deepEqual([message.peer, message.direction, message.text, message.seq], [c, 'out', secret, 1]);
  assert.match(message.id, /^[0-9a-f]{32}$/);
  assert.ok(['queued', 'sent', 'delivered'].includes(message.state));

  // The sender sees the message, then its delivery.
  await waitApi(() => sender.events.some((event) => event.type === 'chat.state' && event.data.data.state === 'delivered'), 'the delivered state');
  const chat = sender.events.filter((event) => event.type === 'chat.message');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].data.data.message.text, secret);
  const states = sender.events.filter((event) => event.type === 'chat.state').map((event) => event.data.data);
  assert.ok(states.every((entry) => entry.id === message.id && entry.peer === c));
  assert.equal(states.at(-1).state, 'delivered');
  const acked = sender.events.find((event) => event.type === 'message.acked');
  assert.equal(acked.data.data.id, message.id);

  // The receiver got it, authenticated as coming from the first node.
  const [incoming] = await receiver.take(1);
  assert.equal(incoming.type, 'chat.message');
  assert.deepEqual([incoming.data.data.message.peer, incoming.data.data.message.direction, incoming.data.data.message.state, incoming.data.data.message.text], [a, 'in', 'received', secret]);
  const inbox = await clients[2].request('GET', '/conversations');
  assert.deepEqual(inbox.conversations.map((entry) => [entry.peer, entry.count, entry.last.text]), [[a, 1, secret]]);
  const thread = await clients[2].request('GET', `/conversations/${a}`);
  assert.deepEqual(thread.items.map((item) => [item.id, item.direction, item.text]), [[message.id, 'in', secret]]);
  const own = await clients[0].request('GET', `/conversations/${c}`);
  assert.equal(own.items[0].state, 'delivered');
  assert.equal((await clients[0].request('GET', '/outbox')).total, 0);

  // The middle node saw packets go by and nothing of the text.
  await waitApi(() => relay.events.some((event) => event.type === 'packet.forwarded'), 'the relay to report forwarding');
  const forwarded = relay.events.filter((event) => event.type === 'packet.forwarded').map((event) => event.data.data);
  assert.ok(forwarded.some((entry) => entry.id === message.id && entry.dst === c && entry.from === a && entry.nextHop === c && entry.type === 'data'));
  assert.ok(forwarded.some((entry) => entry.dst === a && entry.from === c), 'and the acknowledgement coming back');
  assert.ok(!JSON.stringify(relay.events).includes('status report'), 'the relay\'s event stream never carries the plaintext');
  assert.deepEqual((await clients[1].request('GET', '/conversations')).conversations, []);
});

test('a message to a node behind a partition waits in the outbox and is delivered when the partition heals', async (t) => {
  const { cluster, clients, waitApi } = await network(t, { netem: true });
  const [, , c] = cluster.ids;
  cluster.partition([0, 1], [2]);
  await cluster.waitFor(() => !cluster.nodes[0].routes().some((route) => route.dst === c), { message: 'the route to node 2 to disappear' });

  const sent = await clients[0].request('POST', '/messages', { to: c, text: 'wait for me' });
  assert.ok(['queued', 'sent'].includes(sent.message.state));
  const outbox = await clients[0].request('GET', '/outbox');
  assert.equal(outbox.total, 1);
  const [entry] = outbox.entries;
  assert.deepEqual([entry.id, entry.dst, entry.kind, entry.state], [sent.message.id, c, 'msg', 'waiting']);
  assert.equal(entry.nextAttemptAt, null);
  assert.equal(entry.attempts, 0);
  assert.equal((await clients[0].request('GET', '/status')).messaging.waiting, 1);
  assert.equal((await clients[0].request('GET', '/outbox?limit=1')).entries.length, 1);
  assert.equal((await clients[0].request('GET', `/conversations/${c}`)).items[0].state, 'queued');

  cluster.heal();
  await waitApi(() => cluster.nodes[0].outbox().length === 0, 'the outbox to drain');
  const thread = await clients[0].request('GET', `/conversations/${c}`);
  assert.equal(thread.items[0].state, 'delivered');
  const received = await clients[2].request('GET', `/conversations/${cluster.ids[0]}`);
  assert.deepEqual(received.items.map((item) => item.text), ['wait for me']);
  assert.equal(received.items.length, 1, 'delivered once, however many times it was sent');
});

test('ping, traceroute and counters through the API', async (t) => {
  const { cluster, clients, tokens, port } = await network(t);
  const [, b, c] = cluster.ids;
  const stream = await openStream(port(0), { token: tokens[0], query: '?types=diag.*' });
  t.after(() => stream.close());
  await stream.take(1);

  const ping = await clients[0].request('POST', '/diag/ping', { to: c, count: 3, intervalMs: 20 });
  assert.deepEqual([ping.dst, ping.sent, ping.received, ping.lossPct], [c, 3, 3, 0]);
  assert.deepEqual(ping.probes.map((probe) => probe.hops), [2, 2, 2]);
  assert.ok(ping.rttMs.min > 0 && ping.rttMs.min <= ping.rttMs.avg && ping.rttMs.avg <= ping.rttMs.max);
  const trace = await clients[0].request('POST', '/diag/traceroute', { to: c, maxHops: 5, timeoutMs: 2000 });
  assert.deepEqual(trace.hops.map((hop) => [hop.n, hop.node]), [[1, b], [2, c]]);
  assert.equal(trace.reached, true);

  const events = await stream.take(5);
  assert.deepEqual(events.map((event) => event.type), ['diag.ping', 'diag.ping', 'diag.ping', 'diag.trace_hop', 'diag.trace_hop']);
  assert.deepEqual(events.slice(0, 3).map((event) => event.data.data.hops), [2, 2, 2]);

  // Counters of the node in the middle show that it forwarded the probes and their answers.
  await cluster.waitFor(async () => (await clients[1].request('GET', '/diag/counters')).totals['forwarder.forwarded'] >= 6, { message: 'the relay\'s counters' });
  const counters = await clients[1].request('GET', '/diag/counters');
  assert.ok(counters.totals['services.diag.probesSent'] === 0);
  assert.ok(counters.totals['forwarder.forwarded'] >= 6);
  assert.ok(Object.values(counters.totals).every((total) => Number.isSafeInteger(total) && total >= 0));
  assert.equal(counters.windowMs, 10000);

  // Pinging a node that does not exist is a result, not an error.
  const lonely = await clients[0].request('POST', '/diag/ping', { to: 'a'.repeat(51) + 'a', count: 1, timeoutMs: 100 });
  assert.deepEqual([lonely.sent, lonely.received, lonely.lossPct], [1, 0, 100]);
  await assert.rejects(clients[0].request('POST', '/diag/ping', { to: cluster.ids[0] }), (error) => error.code === 'invalid_request');
});

test('a view built the documented way: open the stream, take a snapshot, apply the events newer than it', async (t) => {
  const { cluster, clients, tokens, port, waitApi } = await network(t);
  const c = cluster.ids[2];
  const stream = await openStream(port(1), { token: tokens[1], query: '?types=link.*,routes.changed,topology.changed' });
  t.after(() => stream.close());
  const [hello] = await stream.take(1);
  const snapshot = await clients[1].request('GET', '/peers');
  assert.equal(snapshot.asOf.boot, hello.data.boot);
  assert.ok(snapshot.asOf.seq >= hello.data.lastSeq, 'the snapshot is not older than the hello');
  const linked = new Set(snapshot.peers.map((peer) => peer.id));
  assert.equal(linked.size, 2);

  await cluster.stopNode(2);
  await waitApi(() => stream.events.some((event) => event.type === 'link.down'), 'link.down');
  const applied = stream.events.filter((event) => event.data.seq > snapshot.asOf.seq);
  for (const event of applied) {
    if (event.type === 'link.up') linked.add(event.data.data.peer);
    if (event.type === 'link.down') linked.delete(event.data.data.peer);
  }
  const live = await clients[1].request('GET', '/peers');
  assert.deepEqual([...linked].sort(), live.peers.map((peer) => peer.id).sort(), 'the snapshot plus the events equals a fresh snapshot');
  const down = applied.find((event) => event.type === 'link.down').data.data;
  assert.equal(down.peer, c);
  assert.equal(typeof down.reason, 'string');
  assert.equal(typeof down.durationMs, 'number');
  await waitApi(() => stream.events.some((event) => event.type === 'routes.changed' && event.data.data.unreachable.includes(c)), 'the route to the stopped node to go');
});

test('services that are not installed have no routes; the ones that are show up in the status', async (t) => {
  const { cluster, clients, tokens, port } = await network(t, { size: 2 });
  const status = await clients[0].request('GET', '/status');
  assert.deepEqual(status.services, ['messages', 'diag', 'api']);
  for (const path of ['/channels', '/files', '/mailbox']) {
    const answer = await call(port(0), { path: `/api/v1${path}`, token: tokens[0] });
    assert.equal(answer.status, 404, path);
    assert.equal(answer.json.error.code, 'not_found');
  }
  assert.ok(cluster.nodes[0].apiRoutes().every((route) => ['api', 'messages', 'diag'].includes(route.service)));
});
