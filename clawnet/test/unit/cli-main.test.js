/**
 * The command line, in-process: argument parsing, usage errors and exit codes, init,
 * running a node in the foreground until a signal, and every client command against a real
 * node. Streams, environment and signals are injected, so nothing here touches the real
 * process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ExitCode, UsageError } from '../../src/cli/errors.js';
import { resolveNodeId } from '../../src/cli/commands.js';
import { devnetEdges } from '../../src/cli/devnet.js';
import { duration, table } from '../../src/cli/format.js';
import { parseListen } from '../../src/cli/lifecycle.js';
import { helpText, main, parseCommandLine } from '../../src/cli/main.js';
import { Identity } from '../../src/core/crypto/identity.js';
import { startApiNode } from '../helpers/api.js';
import { tempDir } from '../helpers/tmp.js';

function makeIo(overrides = {}) {
  const out = [];
  const err = [];
  const exits = [];
  const signals = new EventEmitter();
  const io = {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    stdin: { isTTY: false },
    env: {},
    signals,
    exit: (code) => exits.push(code),
    ...overrides,
  };
  return { io, signals, exits, out: () => out.join(''), err: () => err.join(''), lines: () => out.join('').split('\n').filter(Boolean) };
}

async function run(argv, overrides) {
  const cli = makeIo(overrides);
  const code = await main(argv, cli.io);
  return { code, ...cli };
}

const exists = (path) => access(path).then(() => true, () => false);
const waitFor = async (predicate, { timeoutMs = 8000, message = 'condition' } = {}) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// ---------------------------------------------------------------------------------------
// Parsing and usage
// ---------------------------------------------------------------------------------------

test('global options may stand before or after the command, and values are not mistaken for commands', () => {
  const a = parseCommandLine(['--data-dir', 'x', 'status', '--json']);
  assert.deepEqual([a.name, a.values['data-dir'], a.values.json, a.args], ['status', 'x', true, []]);
  const b = parseCommandLine(['status', '-d', 'y']);
  assert.deepEqual([b.name, b.values['data-dir']], ['status', 'y']);
  const c = parseCommandLine(['send', 'abcdefgh', 'hello', 'there', '--json']);
  assert.deepEqual([c.name, c.args], ['send', ['abcdefgh', 'hello', 'there']]);
  const d = parseCommandLine(['start', '--bootstrap', 'tcp://a:1', '--bootstrap', 'tcp://b:2', '--no-multicast']);
  assert.deepEqual([d.values.bootstrap, d.values['no-multicast']], [['tcp://a:1', 'tcp://b:2'], true]);
  const e = parseCommandLine(['ping', 'abcdefgh', '-c', '3']);
  assert.equal(e.values.count, '3');
  assert.equal(parseCommandLine([]).name, null);
});

test('a wrong command line is a usage error: unknown command or option, missing or extra arguments', () => {
  const usage = (argv) => assert.throws(() => parseCommandLine(argv), (error) => error instanceof UsageError && error.exitCode === ExitCode.USAGE, argv.join(' '));
  usage(['frobnicate']);
  usage(['status', '--nope']);
  usage(['status', 'extra']);
  usage(['send']);
  usage(['send', 'abcdefgh']);
  usage(['connect']);
  usage(['connect', 'a', 'b']);
  usage(['init', '--passphrase-file']);
  usage(['ping', 'abcdefgh', '--count']);
  usage(['start', '--listen']);
  usage(['--bogus']);
  usage(['__proto__']);
  usage(['constructor']);
});

test('help and usage output', async () => {
  const none = await run([]);
  assert.equal(none.code, ExitCode.USAGE);
  assert.match(none.out(), /^usage: clawnet/);
  for (const command of ['init', 'start', 'status', 'send', 'inbox', 'ping', 'trace', 'events', 'stop', 'devnet', 'connect', 'routes', 'topology', 'peers', 'id']) {
    assert.match(helpText(), new RegExp(`^  ${command} `, 'm'), command);
  }
  const help = await run(['help']);
  assert.equal(help.code, ExitCode.OK);
  assert.equal(help.out(), helpText());
  const one = await run(['help', 'send']);
  assert.equal(one.code, ExitCode.OK);
  assert.match(one.out(), /usage: clawnet .*send <id> <text\.\.\.>/);
  assert.equal((await run(['send', '--help'])).out(), one.out());
  assert.equal((await run(['help', 'nope'])).code, ExitCode.USAGE);
  assert.equal((await run(['--version'])).out(), 'clawnet/0.1.0\n');
  const bad = await run(['frobnicate']);
  assert.equal(bad.code, ExitCode.USAGE);
  assert.match(bad.err(), /^clawnet: unknown command "frobnicate"\nTry "clawnet help"\./);
  assert.equal(bad.out(), '');
});

test('listen addresses are parsed as host:port, [v6]:port or a bare port', () => {
  assert.deepEqual(parseListen('127.0.0.1:0'), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(parseListen('localhost:47470'), { host: 'localhost', port: 47470 });
  assert.deepEqual(parseListen('[::1]:5'), { host: '::1', port: 5 });
  assert.deepEqual(parseListen('47470'), { host: '0.0.0.0', port: 47470 });
  for (const bad of ['', 'host', 'host:', ':5', '127.0.0.1:99999', '127.0.0.1:-1', 'a:b:5', '1.2.3.4:5x']) {
    assert.throws(() => parseListen(bad), UsageError, bad);
  }
});

test('devnet topologies: each link is a later node dialing an earlier one', () => {
  assert.deepEqual(devnetEdges('line', 4), [[1, 0], [2, 1], [3, 2]]);
  assert.deepEqual(devnetEdges('ring', 4), [[1, 0], [2, 1], [3, 2], [3, 0]]);
  assert.deepEqual(devnetEdges('ring', 2), [[1, 0]]);
  assert.deepEqual(devnetEdges('star', 4), [[1, 0], [2, 0], [3, 0]]);
  assert.deepEqual(devnetEdges('mesh', 4), [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2]]);
  assert.deepEqual(devnetEdges('mesh', 1), []);
  assert.throws(() => devnetEdges('torus', 3), /unknown topology/);
  for (const topology of ['line', 'ring', 'star', 'mesh']) {
    assert.ok(devnetEdges(topology, 6).every(([i, j]) => j < i), topology);
  }
});

test('devnet refuses a bad size or topology before starting anything', async () => {
  for (const argv of [['devnet'], ['devnet', '--nodes', '0'], ['devnet', '--nodes', '33'], ['devnet', '--nodes', 'x'], ['devnet', '--nodes', '2', '--topology', 'torus']]) {
    const result = await run(argv);
    assert.equal(result.code, ExitCode.USAGE, argv.join(' '));
    assert.equal(result.out(), '');
  }
});

test('table and duration formatting', () => {
  assert.equal(table(['A', 'LONGER'], [['x', 'y'], ['wide value', null]]), 'A           LONGER\nx           y\nwide value  -\n');
  assert.equal(table(['A'], []), '');
  assert.equal(duration(999), '0s');
  assert.equal(duration(61_000), '1m 01s');
  assert.equal(duration(3_660_000), '1h 01m');
  assert.equal(duration(null), '-');
});

// ---------------------------------------------------------------------------------------
// init and start
// ---------------------------------------------------------------------------------------

test('init creates the identity, config and network record, refuses to overwrite, and warns when unencrypted', async (t) => {
  const dir = await tempDir(t, 'cli-init');
  const target = join(dir, 'node');
  const first = await run(['--data-dir', target, 'init', '--no-passphrase', '--network', 'cli-test']);
  assert.equal(first.code, 0, first.err());
  assert.match(first.out(), /^initialised .*\nnode id [a-z2-7]{52}\n$/);
  assert.match(first.err(), /not encrypted/);
  for (const file of ['keystore.json', 'config.json', 'network-id']) assert.equal(await exists(join(target, file)), true, file);
  assert.equal((await readFile(join(target, 'network-id'), 'utf8')).trim(), 'cli-test');
  assert.deepEqual(JSON.parse(await readFile(join(target, 'config.json'), 'utf8')), { networkId: 'cli-test' });
  const keystore = await readFile(join(target, 'keystore.json'), 'utf8');
  const nodeId = /node id ([a-z2-7]{52})/.exec(first.out())[1];
  assert.ok(!keystore.includes(nodeId), 'the keystore does not hold the id in the clear');

  const second = await run(['--data-dir', target, 'init', '--no-passphrase']);
  assert.equal(second.code, ExitCode.FAILURE);
  assert.match(second.err(), /already holds an identity; refusing to overwrite/);
  assert.equal(await readFile(join(target, 'keystore.json'), 'utf8'), keystore, 'nothing was changed');

  const json = await run(['--data-dir', join(dir, 'other'), '--json', 'init', '--no-passphrase']);
  assert.deepEqual(Object.keys(JSON.parse(json.out())).sort(), ['dataDir', 'encrypted', 'nodeId']);
  assert.equal(JSON.parse(json.out()).encrypted, false);
});

test('init without a way to protect the keystore, or with two, is a usage error', async (t) => {
  const dir = await tempDir(t, 'cli-init');
  const none = await run(['--data-dir', join(dir, 'a'), 'init']);
  assert.equal(none.code, ExitCode.USAGE);
  assert.match(none.err(), /--passphrase-file .* or --no-passphrase/);
  assert.equal(await exists(join(dir, 'a', 'keystore.json')), false);
  await writeFile(join(dir, 'pass'), 'pw\n');
  const both = await run(['--data-dir', join(dir, 'b'), 'init', '--no-passphrase', '--passphrase-file', join(dir, 'pass')]);
  assert.equal(both.code, ExitCode.USAGE);
  const missing = await run(['--data-dir', join(dir, 'c'), 'init', '--passphrase-file', join(dir, 'nope')]);
  assert.equal(missing.code, ExitCode.FAILURE);
  assert.match(missing.err(), /cannot read the passphrase file/);
  await writeFile(join(dir, 'empty'), '\n');
  assert.match((await run(['--data-dir', join(dir, 'd'), 'init', '--passphrase-file', join(dir, 'empty')])).err(), /is empty/);
  const fromEnv = await run(['--data-dir', join(dir, 'e'), 'init'], { env: { CLAWNET_PASSPHRASE: 'from the environment' } });
  assert.equal(fromEnv.code, 0, fromEnv.err());
  assert.doesNotMatch(fromEnv.err(), /not encrypted/);
});

test('start runs a node in the foreground, prints one ready line, and a signal stops it cleanly', async (t) => {
  const dir = await tempDir(t, 'cli-start');
  const target = join(dir, 'node');
  await writeFile(join(dir, 'pass'), 'correct horse\n');
  assert.equal((await run(['-d', target, 'init', '--passphrase-file', join(dir, 'pass'), '--network', 'cli-test'])).code, 0);

  const cli = makeIo();
  const running = main(['-d', target, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast', '--passphrase-file', join(dir, 'pass')], cli.io);
  await waitFor(() => cli.out().includes('\n'), { message: 'the ready line' });
  assert.equal(cli.lines().length, 1, 'exactly one line on standard output');
  const ready = JSON.parse(cli.lines()[0]);
  assert.deepEqual(Object.keys(ready).sort(), ['api', 'dataDir', 'event', 'listen', 'nodeId']);
  assert.equal(ready.event, 'ready');
  assert.match(ready.nodeId, /^[a-z2-7]{52}$/);
  assert.match(ready.listen, /^tcp:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.match(ready.api, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.equal(ready.dataDir, target);
  assert.equal(await exists(join(target, 'runtime.json')), true);
  assert.equal(await exists(join(target, 'lock')), true);

  // A client command finds it.
  const id = await run(['-d', target, 'id']);
  assert.equal(id.out(), `${ready.nodeId}\n`);
  // A second node on the same data directory is refused, without a stack trace.
  const second = await run(['-d', target, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast', '--passphrase-file', join(dir, 'pass')]);
  assert.equal(second.code, ExitCode.FAILURE);
  assert.match(second.err(), /already in use/);
  assert.doesNotMatch(second.err(), /\n\s+at /);
  assert.equal(second.out(), '', 'no ready line');
  // The refused start left the first one alone.
  assert.equal((await run(['-d', target, 'id'])).out(), `${ready.nodeId}\n`);

  cli.signals.emit('SIGINT');
  assert.equal(await running, ExitCode.OK);
  assert.equal(await exists(join(target, 'runtime.json')), false);
  assert.equal(await exists(join(target, 'lock')), false);
  assert.equal(cli.signals.listenerCount('SIGINT'), 0, 'the handlers are removed');
  assert.equal(cli.lines().length, 1);
  const gone = await run(['-d', target, 'status']);
  assert.equal(gone.code, ExitCode.NOT_RUNNING);
  assert.match(gone.err(), /no node is running/);
});

test('start fails with a plain message for a missing identity, a wrong passphrase and a bad flag', async (t) => {
  const dir = await tempDir(t, 'cli-start');
  const none = await run(['-d', join(dir, 'empty'), 'start']);
  assert.equal(none.code, ExitCode.FAILURE);
  assert.match(none.err(), /no identity in .*"clawnet init"/);

  const target = join(dir, 'node');
  await writeFile(join(dir, 'right'), 'right');
  await writeFile(join(dir, 'wrong'), 'wrong');
  await run(['-d', target, 'init', '--passphrase-file', join(dir, 'right')]);
  const wrong = await run(['-d', target, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast', '--passphrase-file', join(dir, 'wrong')]);
  assert.equal(wrong.code, ExitCode.FAILURE);
  assert.match(wrong.err(), /cannot unlock the keystore/);
  assert.doesNotMatch(wrong.err(), /\n\s+at |right|wrong\b.*passphrase.*:/);
  assert.equal(wrong.out(), '');
  assert.equal(await exists(join(target, 'lock')), false, 'a failed start leaves no lock behind');

  const noPassphrase = await run(['-d', target, 'start', '--no-multicast']);
  assert.equal(noPassphrase.code, ExitCode.USAGE);
  assert.match(noPassphrase.err(), /passphrase is needed/);

  for (const flag of [['--listen', 'nonsense'], ['--api-port', '99999'], ['--network-key-file', join(dir, 'missing')], ['--network', 'other-network']]) {
    const bad = await run(['-d', target, 'start', '--passphrase-file', join(dir, 'right'), ...flag]);
    assert.ok([ExitCode.FAILURE, ExitCode.USAGE].includes(bad.code), flag.join(' '));
    assert.doesNotMatch(bad.err(), /\n\s+at /);
    assert.equal(bad.out(), '');
  }
  const network = await run(['-d', target, 'start', '--passphrase-file', join(dir, 'right'), '--network', 'other-network']);
  assert.match(network.err(), /belongs to network/);
});

// ---------------------------------------------------------------------------------------
// Client commands against a real node
// ---------------------------------------------------------------------------------------

test('every client command prints what the API answers, as text or as one JSON document', async (t) => {
  const node = await startApiNode(t);
  const dir = node.dataDir;
  const cli = (...argv) => run(['-d', dir, ...argv]);

  const status = await cli('status');
  assert.equal(status.code, 0, status.err());
  assert.match(status.out(), new RegExp(`node +${node.node.id} \\(running\\)`));
  assert.match(status.out(), /services +messages, diag, api/);
  const statusJson = JSON.parse((await cli('--json', 'status')).out());
  assert.equal(statusJson.nodeId, node.node.id);

  assert.equal((await cli('id')).out(), `${node.node.id}\n`);
  assert.equal(JSON.parse((await cli('--json', 'id')).out()).card.id, node.node.id);
  assert.equal((await cli('peers')).out(), 'no links\n');
  assert.equal((await cli('routes')).out(), 'no routes\n');
  assert.match((await cli('topology')).out(), /\(this node\)/);
  assert.equal((await cli('outbox')).out(), 'the outbox is empty\n');
  assert.equal((await cli('inbox')).out(), 'no conversations\n');
  assert.equal((await cli('inbox', node.node.id)).out(), 'no messages\n');
  assert.deepEqual(JSON.parse((await cli('--json', 'inbox', node.node.id)).out()), { peer: node.node.id, items: [], nextBefore: null });
  assert.deepEqual(Object.keys(JSON.parse((await cli('--json', 'counters')).out())).sort(), ['at', 'rates', 'totals', 'uptimeMs', 'windowMs']);
  assert.match((await cli('counters')).out(), /COUNTER +TOTAL/);
  const config = JSON.parse((await cli('config')).out());
  assert.equal(config.networkId, 'api-test');

  // Failures carry the API's code and a non-zero exit.
  const stranger = Identity.generate().nodeId;
  const send = await cli('send', stranger, 'hello', 'world');
  assert.equal(send.code, ExitCode.FAILURE);
  assert.match(send.err(), /^clawnet: unknown_destination: no identity card known for that node\n$/);
  const refused = await cli('connect', '127.0.0.1:1');
  assert.equal(refused.code, ExitCode.FAILURE);
  assert.match(refused.err(), /connect_failed/);
  assert.equal((await cli('disconnect', stranger)).code, ExitCode.FAILURE);
  const silent = await cli('ping', stranger, '-c', '1');
  assert.equal(silent.code, ExitCode.FAILURE, 'no answer is a failure, as with ping(8)');
  assert.match(silent.out(), /probe 1: no answer\n1 sent, 0 received, 100% loss/);

  // Usage errors are caught before any request.
  assert.equal((await cli('send', 'short', 'x')).code, ExitCode.USAGE);
  assert.match((await cli('send', 'abcdefgh', 'x')).err(), /no node known to this node starts with "abcdefgh"/);
  assert.equal((await cli('ping', stranger, '-c', '0')).code, ExitCode.USAGE);
  assert.equal((await cli('inbox', stranger, '--limit', '501')).code, ExitCode.USAGE);
  assert.equal((await cli('trace', stranger, '--max-hops', '99')).code, ExitCode.USAGE);
});

test('events prints one JSON event per line, replays from the start on request, and stops after --count', async (t) => {
  const node = await startApiNode(t);
  const result = await run(['-d', node.dataDir, 'events', '--replay', '--types', 'node.*,api.listening', '--count', '2']);
  assert.equal(result.code, 0, result.err());
  const events = result.lines().map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ['api.listening', 'node.started']);
  assert.ok(events.every((event) => Number.isInteger(event.seq) && typeof event.ts === 'number' && 'data' in event));
  assert.equal(events[0].data.port, node.port);

  // Following live: an event emitted after the command started is printed.
  const live = run(['-d', node.dataDir, 'events', '--types', 'cli.test', '--count', '1']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  node.node.events.emit('cli.test', { hello: 'world' });
  const done = await live;
  assert.equal(done.code, 0);
  assert.deepEqual(JSON.parse(done.out()).data, { hello: 'world' });

  const bad = await run(['-d', node.dataDir, 'events', '--types', 'Bad Type']);
  assert.equal(bad.code, ExitCode.FAILURE);
  assert.match(bad.err(), /invalid_request/);
});

test('stop asks the node to shut down, waits until it has gone, and later commands exit with 3', async (t) => {
  const node = await startApiNode(t);
  const stopped = await run(['-d', node.dataDir, 'stop']);
  assert.equal(stopped.code, 0, stopped.err());
  assert.equal(stopped.out(), 'stopped\n');
  assert.equal(node.node.state, 'stopped');
  assert.equal(await exists(join(node.dataDir, 'runtime.json')), false);
  const again = await run(['-d', node.dataDir, 'stop']);
  assert.equal(again.code, ExitCode.NOT_RUNNING);
  assert.equal((await run(['-d', node.dataDir, 'peers'])).code, ExitCode.NOT_RUNNING);
});

test('a stale runtime.json (the process is gone) is reported as not running, and a wrong token as a failure', async (t) => {
  const node = await startApiNode(t);
  const stale = await tempDir(t, 'cli-stale');
  await writeFile(join(stale, 'runtime.json'), JSON.stringify({ pid: 2 ** 22, api: 'http://127.0.0.1:1' }));
  await writeFile(join(stale, 'api-token'), `${'0'.repeat(64)}\n`);
  const gone = await run(['-d', stale, 'status']);
  assert.equal(gone.code, ExitCode.NOT_RUNNING);
  assert.match(gone.err(), /cannot reach the node/);

  await writeFile(join(stale, 'runtime.json'), JSON.stringify({ api: node.url }));
  const wrongToken = await run(['-d', stale, 'status']);
  assert.equal(wrongToken.code, ExitCode.FAILURE);
  assert.match(wrongToken.err(), /unauthorized/);
  assert.equal((await stat(join(stale, 'api-token'))).isFile(), true);
  assert.ok(!wrongToken.err().includes('0'.repeat(64)), 'the token is not echoed');
});

test('ids may be shortened to a unique prefix of at least 8 characters', async () => {
  const a = `${'a'.repeat(8)}${'b'.repeat(44)}`.replace(/b{44}$/, 'q'.repeat(44));
  const b = `${'a'.repeat(8)}${'c'.repeat(43)}a`;
  const c = `${'z'.repeat(8)}${'d'.repeat(43)}q`;
  const client = {
    request: async (method, path) => (path === '/topology'
      ? { nodes: [{ id: a }, { id: c }] }
      : { peers: [{ id: b }] }),
  };
  assert.equal(await resolveNodeId(client, c.slice(0, 8)), c);
  assert.equal(await resolveNodeId(client, b.slice(0, 20)), b);
  assert.equal(await resolveNodeId(client, a), a, 'a full id is passed through');
  await assert.rejects(resolveNodeId(client, 'a'.repeat(8)), /ambiguous/);
  await assert.rejects(resolveNodeId(client, 'y'.repeat(8)), /no node known/);
  for (const bad of ['short', 'UPPERCASE1', 'with-dash1', 'a'.repeat(53), '0'.repeat(10)]) {
    await assert.rejects(resolveNodeId(client, bad), UsageError, bad);
  }
});
