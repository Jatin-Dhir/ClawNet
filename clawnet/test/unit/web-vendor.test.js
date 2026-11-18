/**
 * Guards for the code the phone downloads:
 *
 *   - the vendored noble libraries are byte for byte what scripts/vendor-noble.js wrote from
 *     the pinned npm tarballs (web/vendor/manifest.json), so a hand edit fails here;
 *   - everything the app imports is a file the web app server serves, with no `node:`
 *     module, no bare specifier and no dynamic import anywhere in the graph;
 *   - the browser core still works in a runtime that has no Buffer, which is what a
 *     browser is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LINT_HEADER, PACKAGES, importSpecifiers } from '../../scripts/vendor-noble.js';
import { INDEX_PATH, SERVED_DIRS, SHARED_MODULES } from '../../src/gate/webapp-server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'web', 'vendor', 'manifest.json'), 'utf8'));

test('every vendored file matches the manifest written from the pinned tarballs', () => {
  assert.deepEqual(manifest.packages.map((p) => `${p.name}@${p.version}`), PACKAGES.map((p) => `${p.name}@${p.version}`));
  let files = 0;
  for (const pkg of manifest.packages) {
    const pinned = PACKAGES.find((p) => p.name === pkg.name);
    assert.equal(pkg.integrity, pinned.integrity);
    assert.equal(pkg.license, 'MIT');
    for (const file of pkg.files) {
      const bytes = readFileSync(join(ROOT, 'web', 'vendor', ...file.path.split('/')));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
      if (file.path.endsWith('.js')) {
        assert.ok(bytes.toString('utf8').startsWith(LINT_HEADER), `${file.path} starts with the lint header`);
        assert.ok(file.originalSha256 !== undefined, 'the original hash is recorded for a changed file');
      }
      files += 1;
    }
  }
  assert.equal(files, PACKAGES.reduce((n, p) => n + p.files.length, 0));
});

/** Static import graph from an entry point, as URL paths relative to the engine root. */
function importGraph(entry) {
  const seen = new Set();
  const problems = [];
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(join(ROOT, ...path.split('/')), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/\bimport\s*\(/.test(code)) problems.push(`${path}: dynamic import`);
    // Uses, not words: "process" may appear in a message. canonical.js names Buffer only in
    // canonicalBytes, which the browser code never calls (the Buffer-free run below proves it).
    const nodeGlobal = /\b(?:require\s*\(|process\.|Buffer\.|__dirname\b|__filename\b)/;
    if (nodeGlobal.test(code) && !path.startsWith('web/vendor/') && path !== 'src/core/wire/canonical.js') {
      problems.push(`${path}: uses a Node.js global`);
    }
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('.')) {
        problems.push(`${path}: imports ${spec}`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!existsSync(join(ROOT, ...target.split('/')))) problems.push(`${path}: ${spec} does not exist`);
      else visit(target);
    }
  };
  visit(entry);
  return { files: [...seen], problems };
}

test('the browser code imports only files the web app server serves, and nothing from Node', () => {
  const entries = ['web/core/node.js'];
  if (existsSync(join(ROOT, 'web', 'app', 'main.js'))) entries.push('web/app/main.js');
  const served = (path) => SERVED_DIRS.some((dir) => path.startsWith(`${dir}/`)) || SHARED_MODULES.includes(path);
  for (const entry of entries) {
    const { files, problems } = importGraph(entry);
    assert.deepEqual(problems, [], entry);
    const unserved = files.filter((path) => !served(path));
    assert.deepEqual(unserved, [], `${entry} imports files the server does not serve`);
    assert.ok(files.length > 20, `${entry} graph has ${files.length} files`);
  }
  assert.ok(INDEX_PATH.startsWith('web/app/'));
});

test('the shared engine modules are pure: no Node.js module, nothing but their own imports', () => {
  for (const path of SHARED_MODULES) {
    const text = readFileSync(join(ROOT, ...path.split('/')), 'utf8');
    for (const spec of importSpecifiers(text)) {
      assert.ok(spec.startsWith('.'), `${path} imports ${spec}`);
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      assert.ok(SHARED_MODULES.includes(target), `${path} imports ${target}, which is not shared with the browser`);
    }
  }
});

test('the browser core runs with no Buffer, as in a browser', () => {
  const script = `
    delete globalThis.Buffer;
    if (typeof Buffer !== 'undefined') throw new Error('Buffer is still there');
    const root = ${JSON.stringify(pathToFileURL(ROOT).href)};
    const { Identity } = await import(root + '/web/core/identity.js');
    const { sealMessage, openMessage } = await import(root + '/web/core/envelope.js');
    const { HandshakeState } = await import(root + '/web/core/noise.js');
    const { LwwDataset } = await import(root + '/web/core/lww.js');
    const { encodePacket, decodePacket } = await import(root + '/web/core/codec.js');
    const a = Identity.generate();
    const b = Identity.generate();
    const id = '0123456789abcdef0123456789abcdef';
    const body = sealMessage({ sender: a, recipientE2eKey: b.e2eKeyPair.publicKey, dst: b.nodeId, id, meta: { kind: 'msg', ack: true }, content: new TextEncoder().encode('hi') });
    const opened = openMessage({ recipient: b, dst: b.nodeId, id, body });
    if (opened.senderId !== a.nodeId || new TextDecoder().decode(opened.content) !== 'hi') throw new Error('seal/open');
    const i = new HandshakeState({ pattern: 'XXpsk0', initiator: true, prologue: new Uint8Array(1), s: a.linkKeyPair, psk: new Uint8Array(32).fill(3) });
    const r = new HandshakeState({ pattern: 'XXpsk0', initiator: false, prologue: new Uint8Array(1), s: b.linkKeyPair, psk: new Uint8Array(32).fill(3) });
    r.readMessage(i.writeMessage());
    i.readMessage(r.writeMessage());
    r.readMessage(i.writeMessage());
    const set = new LwwDataset({ name: 'lsa', key: (x) => x.origin, version: (x) => x.seq, check: () => ({ ok: true }), maxEntries: 10 });
    set.offer(a.signRecord('lsa', { seq: 1, ts: 1, links: [], caps: { relay: false, mailbox: false, transit: false } }));
    if (set.syncSummary().length !== 64) throw new Error('summary');
    const packet = decodePacket(encodePacket({ type: 1, header: { n: '0123456789abcdef' } }));
    if (packet.header.n !== '0123456789abcdef') throw new Error('codec');
    console.log('ok');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(out.trim(), 'ok');
});
