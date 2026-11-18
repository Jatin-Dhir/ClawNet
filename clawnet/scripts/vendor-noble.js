#!/usr/bin/env node
/**
 * Copy the pinned noble cryptography libraries into web/vendor (web/vendor/README.md).
 *
 * The phone app runs in a browser page served over plain http on a home network. Such a
 * page is not a secure context, so WebCrypto is unavailable, and WebCrypto has no
 * ChaCha20-Poly1305 anyway. The browser code therefore uses three audited pure-JavaScript
 * libraries by Paul Miller: @noble/hashes, @noble/curves and @noble/ciphers. They are
 * vendored, not installed, because the engine has no dependencies and serves the app
 * itself.
 *
 * What this script does, and nothing else:
 *
 *   1. obtains each package tarball, either from a directory you name (`--from`) or with
 *      `npm pack <name>@<version>` into a fresh temporary directory;
 *   2. checks the tarball's SHA-512 against the integrity value pinned below, which is
 *      the one the npm registry publishes for that version;
 *   3. copies the listed files out of the tarball, byte for byte, with two documented
 *      changes: every JavaScript file gets one first line, LINT_HEADER, because the
 *      repository's lint rules are written for ClawNet's own code and this is someone
 *      else's; and in @noble/curves the bare imports of @noble/hashes become relative
 *      paths to the vendored copy, because a browser cannot resolve a bare specifier;
 *   4. checks that the copied files import nothing outside the copied set;
 *   5. writes web/vendor/manifest.json with the version, the tarball integrity and the
 *      SHA-256 of every file before and after step 3.
 *
 * The test `test/unit/web-vendor.test.js` recomputes those hashes, so a vendored file
 * that is edited by hand fails the suite.
 *
 * Usage: node scripts/vendor-noble.js [--from <directory with the three .tgz files>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'web', 'vendor');

/**
 * The pinned packages. `integrity` is the npm registry's `dist.integrity` for that exact
 * version (checked on 18 November 2026); `files` is the transitive import closure of the
 * entry points the web core uses (ed25519.js, sha2.js, hmac.js, hkdf.js, utils.js,
 * chacha.js), plus the licence.
 */
export const PACKAGES = Object.freeze([
  {
    name: '@noble/hashes',
    version: '2.4.0',
    integrity: 'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==',
    dir: 'noble-hashes',
    files: ['LICENSE', '_md.js', '_u64.js', 'hkdf.js', 'hmac.js', 'sha2.js', 'utils.js'],
  },
  {
    name: '@noble/curves',
    version: '2.4.0',
    integrity: 'sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==',
    dir: 'noble-curves',
    files: [
      'LICENSE',
      'abstract/curve.js',
      'abstract/edwards.js',
      'abstract/fft.js',
      'abstract/frost.js',
      'abstract/hash-to-curve.js',
      'abstract/modular.js',
      'abstract/montgomery.js',
      'abstract/oprf.js',
      'ed25519.js',
      'utils.js',
    ],
  },
  {
    name: '@noble/ciphers',
    version: '2.4.0',
    integrity: 'sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==',
    dir: 'noble-ciphers',
    files: ['LICENSE', '_arx.js', '_poly1305.js', 'chacha.js', 'utils.js'],
  },
]);

/** The directory the rewritten @noble/hashes imports of step 3 point to. */
const HASHES_DIR = 'noble-hashes';

/** First line added to every vendored JavaScript file in step 3. */
export const LINT_HEADER =
  '/* eslint-disable -- third-party code, vendored by scripts/vendor-noble.js; see web/vendor/README.md */\n';

function main(argv) {
  const fromIndex = argv.indexOf('--from');
  const from = fromIndex === -1 ? null : argv[fromIndex + 1];
  if (fromIndex !== -1 && (from === undefined || from.startsWith('--'))) {
    throw new Error('--from needs a directory');
  }
  const work = from === null ? mkdtempSync(join(tmpdir(), 'clawnet-noble-')) : resolve(from);
  try {
    const manifest = {
      about:
        'Pinned copies of the noble cryptography libraries used by the ClawNet web core. Written by scripts/vendor-noble.js; do not edit by hand. See README.md.',
      packages: [],
    };
    for (const pkg of PACKAGES) manifest.packages.push(vendorPackage(pkg, work, from === null));
    checkClosure();
    writeFileSync(join(VENDOR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`vendored ${manifest.packages.length} packages into ${VENDOR}\n`);
  } finally {
    if (from === null) rmSync(work, { recursive: true, force: true });
  }
}

function tarballName(pkg) {
  return `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`;
}

function vendorPackage(pkg, work, fetch) {
  const tarball = join(work, tarballName(pkg));
  if (fetch) {
    // npm checks the registry's integrity value itself; the check below pins it here too.
    // Through the shell, so that Windows finds npm.cmd; every argument is a constant.
    execFileSync(`npm pack ${pkg.name}@${pkg.version} --silent --pack-destination "${work}"`, {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: true,
    });
  }
  if (!existsSync(tarball)) throw new Error(`missing ${tarball}`);
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== pkg.integrity) {
    throw new Error(`${pkg.name}@${pkg.version}: tarball integrity ${integrity} is not the pinned ${pkg.integrity}`);
  }
  const entries = readTar(gunzipSync(bytes));
  const meta = JSON.parse(entries.get('package/package.json').toString('utf8'));
  if (meta.name !== pkg.name || meta.version !== pkg.version) {
    throw new Error(`${tarball} holds ${meta.name}@${meta.version}`);
  }
  const files = [];
  for (const file of pkg.files) {
    const original = entries.get(`package/${file}`);
    if (original === undefined) throw new Error(`${pkg.name}: no ${file} in the tarball`);
    let vendored = pkg.dir === 'noble-curves' ? rewriteHashesImports(original, file) : original;
    if (file.endsWith('.js')) vendored = Buffer.concat([Buffer.from(LINT_HEADER, 'utf8'), vendored]);
    const target = join(VENDOR, pkg.dir, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, vendored);
    files.push({
      path: `${pkg.dir}/${file}`,
      sha256: sha256Hex(vendored),
      ...(vendored.equals(original) ? {} : { originalSha256: sha256Hex(original) }),
    });
  }
  return {
    name: pkg.name,
    version: pkg.version,
    integrity: pkg.integrity,
    license: meta.license,
    dir: pkg.dir,
    files,
  };
}

/**
 * Step 3: in an import statement (a line that starts with `import`), `'@noble/hashes/x.js'`
 * becomes the relative path to `noble-hashes/x.js`. Usage examples in comments are left
 * as they are.
 */
function rewriteHashesImports(buffer, file) {
  const text = buffer.toString('utf8');
  const fromDir = posix.dirname(`noble-curves/${file}`);
  const statement = /^(import\s[^\n;]*?from\s+)(['"])@noble\/hashes\/([a-z0-9_.-]+\.js)\2/gm;
  const rewritten = text.replace(statement, (_all, lead, quote, name) => {
    let rel = posix.relative(fromDir, `${HASHES_DIR}/${name}`);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
  return Buffer.from(rewritten, 'utf8');
}

/** Step 4: every static import of every vendored module resolves to a vendored file. */
function checkClosure() {
  const vendored = new Set();
  for (const pkg of PACKAGES) for (const file of pkg.files) if (file.endsWith('.js')) vendored.add(`${pkg.dir}/${file}`);
  for (const path of vendored) {
    const text = readFileSync(join(VENDOR, ...path.split('/')), 'utf8');
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('.')) throw new Error(`${path} still imports the bare specifier ${spec}`);
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!vendored.has(target)) throw new Error(`${path} imports ${spec}, which is not vendored`);
    }
    if (/\bimport\s*\(/.test(stripComments(text))) throw new Error(`${path} has a dynamic import`);
  }
}

/**
 * The module specifiers of the static `import` and `export ... from` statements of an
 * ES module, comments ignored. Good enough for compiled library output; shared with the
 * vendor test.
 *
 * @param {string} text module source
 * @returns {string[]}
 */
export function importSpecifiers(text) {
  const code = stripComments(text);
  const out = [];
  const pattern = /(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  for (const match of code.matchAll(pattern)) out.push(match[1]);
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The regular files of a POSIX tar archive (ustar, with pax `path` headers), by path.
 *
 * @param {Buffer} tar
 * @returns {Map<string, Buffer>}
 */
function readTar(tar) {
  const files = new Map();
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString('utf8');
    };
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(345, 155);
    const name = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (type === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = match === null ? null : match[1];
    } else {
      if (type === '0') files.set(paxPath ?? name, Buffer.from(data));
      paxPath = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
