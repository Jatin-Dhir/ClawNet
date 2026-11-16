/**
 * End to end through the command line: separate OS processes, each started with
 * `clawnet start`, joined over loopback with ephemeral ports, driven only by CLI commands.
 * Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliJson, eventually, initNode, isAlive, runCli, startNode } from '../helpers/cli.js';
import { tempDir } from '../helpers/tmp.js';

const exists = (path) => access(path).then(() => true, () => false);

test('init, start, status, a refused second start, stop: exit codes, files and the process itself', async (t) => {
  const dir = await tempDir(t, 'e2e-life');
  const home = join(dir, 'node');

  const init = await runCli(['--data-dir', home, 'init', '--no-passphrase']);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /^initialised .*\nnode id ([a-z2-7]{52})\n$/);
  const nodeId = /node id ([a-z2-7]{52})/.exec(init.stdout)[1];
  const again = await runCli(['--data-dir', home, 'init', '--no-passphrase']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already holds an identity/);
  assert.doesNotMatch(again.stderr, /\n\s+at /);

  const node = await startNode(t, home);
  assert.equal(node.ready.nodeId, nodeId, 'the node started is the one init created');
  assert.equal(node.stdout.length, 1, 'one line on standard output');
  assert.equal(await exists(join(home, 'runtime.json')), true);
  assert.equal(await exists(join(home, 'lock')), true);
  const runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
  assert.equal(runtime.pid, node.pid);
  assert.equal(runtime.api, node.ready.api);

  const status = await cliJson(home, ['status']);
  assert.equal(status.nodeId, nodeId);
  assert.equal(status.state, 'running');
  assert.deepEqual(status.services, ['messages', 'diag', 'cast', 'files', 'api']);

  // A second node on the same data directory fails with the lock message and no stack trace.
  const second = await runCli(['--data-dir', home, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast']);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already in use/);
  assert.doesNotMatch(second.stderr, /\n\s+at /);
  assert.equal(second.stdout, '');
  assert.equal(isAlive(node.pid), true, 'the first node is untouched');

  const stop = await runCli(['--data-dir', home, 'stop']);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(await node.exited, 0, 'the node process exits with status 0');
  assert.equal(isAlive(node.pid), false);
  assert.equal(await exists(join(home, 'runtime.json')), false);
  assert.equal(await exists(join(home, 'lock')), false);

  // With the node gone, client commands say so and exit with 3.
  for (const args of [['status'], ['peers'], ['send', 'abcdefgh', 'x'], ['stop']]) {
    const gone = await runCli(['--data-dir', home, ...args]);
    assert.equal(gone.code, 3, args.join(' '));
    assert.match(gone.stderr, /no node is running/);
  }
});

test('a wrong passphrase fails the start with exit 1, a plain message and no process left', async (t) => {
  const dir = await tempDir(t, 'e2e-pass');
  const home = join(dir, 'node');
  await writeFile(join(dir, 'right'), 'right passphrase\n');
  await writeFile(join(dir, 'wrong'), 'wrong passphrase\n');
  assert.equal((await runCli(['--data-dir', home, 'init', '--passphrase-file', join(dir, 'right')])).code, 0);

  const wrong = await runCli(['--data-dir', home, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast', '--passphrase-file', join(dir, 'wrong')]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /cannot unlock the keystore/);
  assert.doesNotMatch(wrong.stderr, /\n\s+at |passphrase passphrase/);
  assert.equal(wrong.stdout, '');
  assert.equal(await exists(join(home, 'lock')), false);

  const node = await startNode(t, home, ['--passphrase-file', join(dir, 'right')]);
  assert.match(node.ready.nodeId, /^[a-z2-7]{52}$/);
  assert.equal((await cliJson(home, ['id'])).keystoreEncrypted, true);
  assert.equal((await runCli(['--data-dir', home, 'stop'])).code, 0);
  assert.equal(await node.exited, 0);
});

test('three node processes: a message goes from the first to the third through the second, and everything stops cleanly', async (t) => {
  const dir = await tempDir(t, 'e2e-three');
  const homes = [0, 1, 2].map((i) => join(dir, `node-${i}`));
  const ids = [];
  for (const home of homes) ids.push(await initNode(home));

  // A line: the second dials the first, the third dials the second.
  const a = await startNode(t, homes[0]);
  const b = await startNode(t, homes[1], ['--bootstrap', a.ready.listen]);
  const c = await startNode(t, homes[2], ['--bootstrap', b.ready.listen]);
  const nodes = [a, b, c];
  assert.deepEqual(nodes.map((node) => node.ready.nodeId), ids);

  // Wait, through the API of the first, until it can route to the third.
  await eventually(async () => {
    const topology = await cliJson(homes[0], ['topology']);
    return topology.nodes.length === 3 && topology.nodes.every((node) => node.reachable) && topology.links.filter((link) => link.state === 'confirmed').length === 2;
  }, { message: 'the first node to see the whole line' });
  await eventually(async () => (await cliJson(homes[0], ['routes'])).routes.some((route) => route.dst === ids[2] && route.hops === 2), { message: 'a two-hop route' });

  // The first node sends; the third's id is given as a prefix, which the CLI resolves.
  // A route can be known a moment before the destination's identity card has arrived by peer
  // exchange, and a message cannot be sealed without the card. Until then the node refuses
  // with unknown_destination and queues nothing, so trying again cannot send it twice.
  const send = await eventually(
    () => cliJson(homes[0], ['send', ids[2].slice(0, 12), 'hello', 'from', 'the', 'first', 'node']),
    { message: 'the third node\'s identity card to reach the first' },
  );
  assert.equal(send.message.peer, ids[2]);
  assert.equal(send.message.text, 'hello from the first node');
  assert.equal(send.message.direction, 'out');
  assert.match(send.message.id, /^[0-9a-f]{32}$/);

  // The third reads it back from its inbox, authenticated as coming from the first.
  const inbox = await eventually(async () => {
    const page = await cliJson(homes[2], ['inbox', ids[0]]);
    return page.items.length === 1 ? page : null;
  }, { message: 'the message to arrive in the third node\'s inbox' });
  assert.deepEqual(inbox.items.map((item) => [item.id, item.peer, item.direction, item.state, item.text]), [
    [send.message.id, ids[0], 'in', 'received', 'hello from the first node'],
  ]);
  const conversations = await cliJson(homes[2], ['inbox']);
  assert.deepEqual(conversations.conversations.map((entry) => [entry.peer, entry.count]), [[ids[0], 1]]);
  assert.equal((await runCli(['--data-dir', homes[2], 'inbox', ids[0].slice(0, 8)])).stdout.includes('hello from the first node'), true, 'the human form shows it too');

  // The first sees it delivered and its outbox empty; the second held no conversation.
  await eventually(async () => (await cliJson(homes[0], ['inbox', ids[2]])).items[0].state === 'delivered', { message: 'the delivered state' });
  assert.equal((await cliJson(homes[0], ['outbox'])).total, 0);
  assert.deepEqual((await cliJson(homes[1], ['inbox'])).conversations, []);

  // Status and topology over the API agree with what was built.
  const status = await cliJson(homes[1], ['status']);
  assert.deepEqual([status.nodeId, status.peers.linked, status.routing.nodes, status.routing.reachable], [ids[1], 2, 3, 2]);
  const topology = await cliJson(homes[1], ['topology']);
  assert.equal(topology.nodes.length, 3);
  assert.deepEqual(topology.links.map((link) => link.state), ['confirmed', 'confirmed']);
  const peers = await cliJson(homes[1], ['peers']);
  assert.deepEqual(peers.peers.map((peer) => peer.id).sort(), [ids[0], ids[2]].sort());

  // Diagnostics: the trace names the middle node, then the destination; the ping crosses two hops.
  const trace = await cliJson(homes[0], ['trace', ids[2]]);
  assert.deepEqual(trace.hops.map((hop) => hop.node), [ids[1], ids[2]]);
  assert.equal(trace.reached, true);
  const ping = await cliJson(homes[0], ['ping', ids[2], '-c', '2', '--interval', '50']);
  assert.deepEqual([ping.received, ping.probes.map((probe) => probe.hops)], [2, [2, 2]]);
  const human = await runCli(['--data-dir', homes[0], 'trace', ids[2].slice(0, 8)]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, new RegExp(`^ 1  ${ids[1]} [0-9.]+ ms\\n 2  ${ids[2]} [0-9.]+ ms\\nreached ${ids[2].slice(0, 8)}\\n$`));

  // The event stream shows the links that came up, replayed from the beginning.
  const events = await runCli(['--data-dir', homes[1], 'events', '--replay', '--types', 'link.up', '--count', '2']);
  assert.equal(events.code, 0, events.stderr);
  const lines = events.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.type), ['link.up', 'link.up']);
  assert.deepEqual(lines.map((event) => event.data.peer).sort(), [ids[0], ids[2]].sort());

  // No secret leaks into the output of ordinary commands.
  const token = (await readFile(join(homes[0], 'api-token'), 'utf8')).trim();
  for (const text of [send.message.text, JSON.stringify(status), human.stdout, events.stdout]) assert.ok(!text.includes(token));
  assert.ok(!a.stderr().includes(token) && !a.stdout.join('').includes(token));

  // Stop everything, one command each, and check that no process is left.
  for (let i = 0; i < 3; i += 1) {
    const stop = await runCli(['--data-dir', homes[i], 'stop']);
    assert.equal(stop.code, 0, stop.stderr);
  }
  assert.deepEqual(await Promise.all(nodes.map((node) => node.exited)), [0, 0, 0]);
  for (const node of nodes) assert.equal(isAlive(node.pid), false, `process ${node.pid} is gone`);
  for (const home of homes) {
    assert.equal(await exists(join(home, 'runtime.json')), false);
    assert.equal(await exists(join(home, 'lock')), false);
  }
});

test('a message sent while the destination process is dead waits in the outbox and arrives after it is started again', async (t) => {
  const dir = await tempDir(t, 'e2e-crash');
  const homes = [0, 1].map((i) => join(dir, `node-${i}`));
  const ids = [];
  for (const home of homes) ids.push(await initNode(home));
  const a = await startNode(t, homes[0]);
  const b = await startNode(t, homes[1], ['--bootstrap', a.ready.listen]);
  await eventually(async () => (await cliJson(homes[0], ['routes'])).routes.some((route) => route.dst === ids[1]), { message: 'a route to the second node' });

  // The second node dies without any goodbye.
  b.child.kill('SIGKILL');
  await b.exited;
  assert.equal(isAlive(b.pid), false);
  await eventually(async () => !(await cliJson(homes[0], ['routes'])).routes.some((route) => route.dst === ids[1]), { message: 'the route to the dead node to go' });

  const sent = await cliJson(homes[0], ['send', ids[1], 'sent into the void']);
  const outbox = await cliJson(homes[0], ['outbox']);
  assert.deepEqual(outbox.entries.map((entry) => [entry.id, entry.dst, entry.state]), [[sent.message.id, ids[1], 'waiting']]);

  // Started again on the same data directory (a stale lock and runtime.json from the kill are taken over).
  assert.equal(await exists(join(homes[1], 'lock')), true, 'the kill left its lock behind');
  const again = await startNode(t, homes[1], ['--bootstrap', a.ready.listen]);
  assert.equal(again.ready.nodeId, ids[1], 'the same identity');
  const inbox = await eventually(async () => {
    const page = await cliJson(homes[1], ['inbox', ids[0]]);
    return page.items.length === 1 ? page : null;
  }, { message: 'the waiting message to arrive', timeoutMs: 20_000 });
  assert.equal(inbox.items[0].text, 'sent into the void');
  await eventually(async () => (await cliJson(homes[0], ['outbox'])).total === 0, { message: 'the outbox to drain' });
  assert.equal((await cliJson(homes[0], ['inbox', ids[1]])).items[0].state, 'delivered');

  for (const home of homes) assert.equal((await runCli(['--data-dir', home, 'stop'])).code, 0);
  await Promise.all([a.exited, again.exited]);
  assert.equal(isAlive(a.pid) || isAlive(again.pid), false);
});
