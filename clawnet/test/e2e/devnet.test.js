/**
 * `clawnet devnet`: real node processes started by the launcher, joined into a network,
 * reachable through the console URLs it prints, and all gone after it stops. Everything
 * runs on one machine, on 127.0.0.1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { ApiClient } from '../../src/cli/client.js';
import { startDevnet } from '../../src/cli/devnet.js';
import { main } from '../../src/cli/main.js';
import { eventually, isAlive } from '../helpers/cli.js';
import { removeDir } from '../helpers/tmp.js';

const exists = (path) => access(path).then(() => true, () => false);

/** An ApiClient for a node, built from its console URL exactly as the console does. */
function clientFromConsoleUrl(consoleUrl) {
  const url = new URL(consoleUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.hash, /^#token=[0-9a-f]{64}$/);
  return new ApiClient({ url: url.origin, token: url.hash.slice('#token='.length) });
}

test('a three-node line: each node\'s console URL works, a message crosses the line, and stop() leaves nothing', async (t) => {
  const devnet = await startDevnet({ nodes: 3, topology: 'line' });
  t.after(() => devnet.stop());
  const baseDir = devnet.baseDir;
  assert.equal(devnet.nodes.length, 3);
  assert.deepEqual(devnet.nodes.map((node) => node.index), [0, 1, 2]);
  for (const node of devnet.nodes) {
    assert.match(node.nodeId, /^[a-z2-7]{52}$/);
    assert.match(node.listen, /^tcp:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    assert.match(node.api, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    assert.equal(node.console.startsWith(`${node.api}/#token=`), true);
    assert.equal(isAlive(node.pid), true);
    assert.equal(await exists(node.dataDir), true);
  }
  assert.equal(new Set(devnet.nodes.map((node) => node.dataDir)).size, 3, 'a data directory each');
  assert.equal(new Set(devnet.nodes.flatMap((node) => [node.listen, node.api])).size, 6, 'six distinct ports');

  const clients = devnet.nodes.map((node) => clientFromConsoleUrl(node.console));
  // The mesh formed exactly as a line: the middle node has two links, the ends one.
  const linked = await Promise.all(clients.map(async (client) => (await client.request('GET', '/status')).peers.linked));
  assert.deepEqual(linked, [1, 2, 1]);
  await eventually(async () => (await clients[0].request('GET', '/topology/routes')).routes.length === 2, { message: 'routes to both other nodes' });
  assert.deepEqual((await clients[0].request('GET', '/topology/routes')).routes.map((route) => route.hops), [1, 2]);

  const [a, , c] = devnet.nodes;
  const sent = await clients[0].request('POST', '/messages', { to: c.nodeId, text: 'across the devnet' });
  assert.equal(sent.message.text, 'across the devnet');
  const inbox = await eventually(async () => {
    const page = await clients[2].request('GET', `/conversations/${a.nodeId}`);
    return page.items.length === 1 ? page : null;
  }, { message: 'the message to reach the last node' });
  assert.equal(inbox.items[0].text, 'across the devnet');

  // Every node is a real process of its own; the launcher knows their pids.
  const pids = devnet.nodes.map((node) => node.pid);
  assert.equal(new Set(pids).size, 3);
  assert.ok(pids.every((pid) => pid !== process.pid));

  await devnet.stop();
  for (const pid of pids) assert.equal(isAlive(pid), false, `process ${pid} is gone`);
  await devnet.exited;
  assert.equal(await exists(baseDir), false, 'a temporary base directory is removed');
  await assert.rejects(clients[0].request('GET', '/status'), { exitCode: 3 });
});

test('a ring forms the links it says, and a base directory that was given is kept', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'clawnet-devnet-keep-'));
  t.after(() => removeDir(base));
  const ring = await startDevnet({ nodes: 4, topology: 'ring', baseDir: base });
  t.after(() => ring.stop());
  const clients = ring.nodes.map((node) => clientFromConsoleUrl(node.console));
  assert.deepEqual(await Promise.all(clients.map(async (client) => (await client.request('GET', '/status')).peers.linked)), [2, 2, 2, 2]);
  const pids = ring.nodes.map((node) => node.pid);
  await ring.stop();
  assert.ok(pids.every((pid) => !isAlive(pid)));
  assert.equal(await exists(join(base, 'node-0', 'keystore.json')), true, 'the directories the user named stay');
});

test('a star links every node to the first and to nothing else', async (t) => {
  const star = await startDevnet({ nodes: 4, topology: 'star' });
  t.after(() => star.stop());
  const clients = star.nodes.map((node) => clientFromConsoleUrl(node.console));
  assert.deepEqual(await Promise.all(clients.map(async (client) => (await client.request('GET', '/status')).peers.linked)), [3, 1, 1, 1]);
  // Two leaves reach each other through the hub.
  const routes = await clients[1].request('GET', '/topology/routes');
  assert.deepEqual(routes.routes.find((route) => route.dst === star.nodes[2].nodeId).path, [star.nodes[1].nodeId, star.nodes[0].nodeId, star.nodes[2].nodeId]);
});

test('clawnet devnet prints each node\'s console URL and stops every node on Ctrl+C', async (t) => {
  const signals = new EventEmitter();
  const out = [];
  const err = [];
  const io = {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    stdin: { isTTY: false },
    env: process.env,
    signals,
    exit: () => assert.fail('no forced exit'),
  };
  const running = main(['devnet', '--nodes', '3', '--topology', 'mesh'], io);
  t.after(async () => {
    signals.emit('SIGINT');
    await running;
  });
  await eventually(() => out.join('').includes('Press Ctrl+C'), { timeoutMs: 40_000, message: 'the devnet to print its nodes' });
  const text = out.join('');
  assert.match(text, /^ClawNet devnet: 3 nodes, mesh topology, in /);
  assert.match(text, /Every listener is on 127\.0\.0\.1/);
  const urls = [...text.matchAll(/console (http:\/\/127\.0\.0\.1:[0-9]+\/#token=[0-9a-f]{64})/g)].map((match) => match[1]);
  const pids = [...text.matchAll(/pid ([0-9]+)/g)].map((match) => Number(match[1]));
  assert.equal(urls.length, 3);
  assert.equal(pids.length, 3);
  assert.deepEqual([...text.matchAll(/^node ([0-9])/gm)].map((match) => match[1]), ['0', '1', '2']);

  // A mesh: every node is linked to the two others.
  const clients = urls.map(clientFromConsoleUrl);
  assert.deepEqual(await Promise.all(clients.map(async (client) => (await client.request('GET', '/status')).peers.linked)), [2, 2, 2]);
  assert.ok(pids.every((pid) => isAlive(pid)));

  signals.emit('SIGINT');
  assert.equal(await running, 0);
  for (const pid of pids) assert.equal(isAlive(pid), false, `process ${pid} is gone`);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(err.join(''), '');
});

test('clawnet devnet exits by itself when every node has been stopped, and --json prints one document', async (t) => {
  const signals = new EventEmitter();
  const out = [];
  const io = {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: () => {} },
    stdin: { isTTY: false },
    env: process.env,
    signals,
    exit: () => assert.fail('no forced exit'),
  };
  const running = main(['--json', 'devnet', '--nodes', '2', '--topology', 'line'], io);
  t.after(async () => {
    signals.emit('SIGINT');
    await running;
  });
  await eventually(() => out.join('').endsWith('\n'), { timeoutMs: 40_000, message: 'the devnet document' });
  const document = JSON.parse(out.join(''));
  assert.deepEqual(Object.keys(document).sort(), ['baseDir', 'nodes', 'topology']);
  assert.equal(document.nodes.length, 2);
  for (const node of document.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['api', 'console', 'dataDir', 'index', 'listen', 'nodeId', 'pid']);
    await clientFromConsoleUrl(node.console).request('POST', '/shutdown', {});
  }
  assert.equal(await running, 0, 'the launcher ends when the nodes are gone');
  for (const node of document.nodes) assert.equal(isAlive(node.pid), false);
});
