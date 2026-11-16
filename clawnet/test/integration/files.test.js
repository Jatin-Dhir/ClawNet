/**
 * File transfer over real ClawNodes on loopback TCP, through a relay, with links cut and
 * healed by the netem proxy (ARCHITECTURE.md 8.2, 11.6). Everything runs on one machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { createFileTransferService } from '../../src/vault/file-transfer.js';
import { startCluster } from '../helpers/cluster.js';
import { tempDir } from '../helpers/tmp.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filesOf = (cluster, i) => cluster.nodes[i].service('files');
const TERMINAL = ['completed', 'failed', 'cancelled', 'rejected'];

/** A cluster whose nodes run the file service, each with its own downloads directory. */
async function filesCluster(t, { size = 3, topology = 'line', netem = true, files = {} } = {}) {
  const roots = [];
  for (let i = 0; i < size; i += 1) roots.push(await tempDir(t, `node${i}`));
  const cluster = await startCluster(t, {
    size,
    topology,
    netem,
    config: (i) => ({ files: { downloadsDir: join(roots[i], 'downloads'), accept: 'auto', ...files } }),
    services: () => [createFileTransferService()],
  });
  await cluster.converged();
  return { cluster, downloads: roots.map((root) => join(root, 'downloads')), roots };
}

async function sourceFile(t, name, bytes) {
  const dir = await tempDir(t, 'src');
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

test('a multi-megabyte random file goes from A to C through B and arrives with the same SHA-256, and the wire never carries its bytes', async (t) => {
  const { cluster, downloads } = await filesCluster(t);
  const data = randomBytes(6 * 1024 * 1024 + 12345);
  const path = await sourceFile(t, 'random.bin', data);
  const sent = await filesOf(cluster, 0).send(cluster.ids[2], path);
  assert.equal(sent.state, 'preparing');
  assert.equal(sent.chunks, Math.ceil(data.length / 32768));
  await cluster.waitFor(() => TERMINAL.includes(filesOf(cluster, 0).get(sent.id).state), { timeoutMs: 30000, message: 'the sender to finish' });
  assert.equal(filesOf(cluster, 0).get(sent.id).state, 'completed');
  await cluster.waitFor(() => filesOf(cluster, 2).get(sent.id)?.state === 'completed', { message: 'the receiver to finish' });

  const received = await readFile(join(downloads[2], 'random.bin'));
  assert.equal(received.length, data.length);
  assert.equal(sha256(received), sha256(data));
  assert.deepEqual(await readdir(downloads[2]), ['random.bin'], 'no part file is left');
  assert.equal(filesOf(cluster, 2).get(sent.id).path, join(downloads[2], 'random.bin'));
  assert.equal(filesOf(cluster, 2).get(sent.id).sha256, Buffer.from(createHash('sha256').update(data).digest()).toString('base64'));

  // The relay forwarded sealed chunks and kept nothing; the file is not in its directory either.
  assert.equal(filesOf(cluster, 1).list().length, 0);
  assert.equal(await readdir(downloads[1]).then((names) => names.length, () => 0), 0);
  const stats = cluster.nodes[0].stats().services.files;
  assert.ok(stats.chunksSent >= sent.chunks && stats.chunksSent <= sent.chunks + 64, `chunks sent ${stats.chunksSent} of ${sent.chunks}`);
  assert.equal(cluster.nodes[2].stats().services.files.bytesReceived >= data.length, true);
  // Neither link's capture holds a slice of the file, taken from the start, middle and end.
  for (const offset of [0, Math.floor(data.length / 2), data.length - 64]) {
    const slice = data.subarray(offset, offset + 64);
    for (const [i, j] of [[0, 1], [1, 2]]) assert.equal(cluster.link(i, j).contains(slice), false, `link ${i}-${j} at ${offset}`);
  }
  assert.equal(cluster.events(2, 'file.completed').length, 1);
  assert.equal(cluster.events(0, 'file.completed').length, 1);
});

test('a transfer interrupted by a cut link resumes and completes without sending again what was acknowledged', async (t) => {
  const { cluster, downloads } = await filesCluster(t, { files: { window: 8, chunkSize: 16384 } });
  // Slow the far hop so the transfer takes a few seconds and the cut lands in the middle.
  cluster.link(1, 2).setLatency(25);
  const data = randomBytes(3 * 1024 * 1024);
  const path = await sourceFile(t, 'cut.bin', data);
  const sent = await filesOf(cluster, 0).send(cluster.ids[2], path);
  await cluster.waitFor(() => (filesOf(cluster, 2).get(sent.id)?.chunksDone ?? 0) >= 30, { timeoutMs: 15000, message: 'a good part of the file' });
  const heldAtCut = filesOf(cluster, 2).get(sent.id).chunksDone;
  assert.ok(heldAtCut < sent.chunks, 'the cut is in the middle of the transfer');
  const sentAtCut = cluster.nodes[0].stats().services.files.chunksSent;

  cluster.partition([0, 1], [2]);
  await cluster.converged();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.notEqual(filesOf(cluster, 2).get(sent.id).state, 'completed');
  cluster.heal();
  await cluster.converged({ timeoutMs: 10000 });
  await cluster.waitFor(() => filesOf(cluster, 2).get(sent.id)?.state === 'completed' && filesOf(cluster, 0).get(sent.id).state === 'completed', { timeoutMs: 40000, message: 'the transfer to complete after the heal' });

  assert.equal(sha256(await readFile(join(downloads[2], 'cut.bin'))), sha256(data));
  const stats = cluster.nodes[0].stats().services.files;
  // What was in flight when the link died is sent again; what the receiver held is not.
  assert.ok(stats.chunksSent <= sent.chunks + 3 * 8 + 16, `${stats.chunksSent} chunks sent for ${sent.chunks}: nothing like a restart from zero`);
  assert.ok(stats.chunksResent <= 3 * 8 + 16, `${stats.chunksResent} chunks sent twice`);
  assert.ok(stats.chunksSent - sentAtCut <= sent.chunks - heldAtCut + 3 * 8 + 16, 'after the cut, only the missing part was sent');
  assert.ok(filesOf(cluster, 2).get(sent.id).bytesDone === data.length);
  assert.deepEqual(await readdir(downloads[2]), ['cut.bin']);
});

test('a source file changed mid-transfer aborts the transfer on both sides and leaves nothing on the receiver', async (t) => {
  const { cluster, downloads } = await filesCluster(t, { files: { window: 4, chunkSize: 16384 } });
  cluster.link(1, 2).setLatency(25);
  const data = randomBytes(3 * 1024 * 1024);
  const path = await sourceFile(t, 'moving.bin', data);
  const sent = await filesOf(cluster, 0).send(cluster.ids[2], path);
  await cluster.waitFor(() => (filesOf(cluster, 2).get(sent.id)?.chunksDone ?? 0) >= 10, { timeoutMs: 15000, message: 'a start' });
  const changed = Buffer.from(data);
  changed.fill(0x5a, 2 * 1024 * 1024, 2 * 1024 * 1024 + 4096); // chunks that have not been sent yet
  await writeFile(path, changed);
  await cluster.waitFor(() => filesOf(cluster, 0).get(sent.id).state === 'failed', { timeoutMs: 20000, message: 'the sender to notice the change' });
  assert.equal(filesOf(cluster, 0).get(sent.id).error, 'source-changed');
  await cluster.waitFor(() => filesOf(cluster, 2).get(sent.id).state === 'failed', { message: 'the receiver to be told' });
  assert.equal(filesOf(cluster, 2).get(sent.id).error, 'source-changed');
  await cluster.waitFor(async () => (await readdir(downloads[2])).length === 0, { message: 'the part file to be removed' });
  await cluster.waitFor(() => cluster.events(0, 'file.failed').length === 1 && cluster.events(2, 'file.failed').length === 1, { message: 'one failure event on each side' });
});

test('hostile file names cannot escape the downloads directory, whatever the sender calls the file', async (t) => {
  const { cluster, downloads, roots } = await filesCluster(t, { size: 2, topology: 'line', netem: false });
  const hostile = [
    '../../escape.txt',
    '..\\..\\escape.txt',
    '/abs/path/escape.txt',
    'C:\\Windows\\escape.txt',
    '..',
    '....',
    'CON',
    'aux.txt',
    `nul${String.fromCodePoint(0)}byte.txt`,
    'trailing. . ',
    'x'.repeat(255),
    `${'y'.repeat(120)}${String.fromCodePoint(0xe9).repeat(60)}.txt`,
  ];
  const contents = new Map();
  for (const [index, name] of hostile.entries()) {
    const data = randomBytes(2000 + index);
    const path = await sourceFile(t, `source-${index}.bin`, data);
    const sent = await filesOf(cluster, 0).send(cluster.ids[1], path, { name });
    await cluster.waitFor(() => filesOf(cluster, 1).get(sent.id)?.state === 'completed', { message: `the transfer named ${JSON.stringify(name).slice(0, 24)}` });
    contents.set(sent.id, data);
  }
  const inside = await readdir(downloads[1]);
  assert.equal(inside.length, hostile.length, 'every file arrived, each under a name of its own');
  for (const [id, data] of contents) {
    const view = filesOf(cluster, 1).get(id);
    const where = relative(downloads[1], view.path);
    assert.ok(!where.startsWith('..') && !where.includes('/') && !where.includes('\\'), `${view.path} is directly inside the downloads directory`);
    assert.equal(sha256(await readFile(view.path)), sha256(data));
  }
  assert.ok(inside.includes('escape.txt'));
  assert.ok(inside.includes('_CON'));
  assert.ok(inside.every((name) => Buffer.byteLength(name) <= 200));
  // Nothing was written beside the downloads directory, or above it.
  assert.deepEqual((await readdir(roots[1])).filter((name) => name !== 'downloads' && name !== 'state'), []);
  for (const directory of [dirname(downloads[1]), dirname(dirname(downloads[1]))]) {
    const names = await readdir(directory);
    assert.equal(names.some((name) => name.startsWith('escape')), false, `no escape.txt in ${directory}`);
  }
});
