# Vendored cryptography

The phone web app needs X25519, Ed25519, ChaCha20-Poly1305, SHA-256, HMAC and HKDF in a
browser. A page served over plain HTTP on a home network is not a secure context, so
WebCrypto is not available there, and WebCrypto has no ChaCha20-Poly1305 anyway. The web
core therefore uses three audited pure-JavaScript libraries by Paul Miller, copied here at
pinned versions. The engine itself still uses OpenSSL through `node:crypto` and has no
dependencies; nothing here is installed with npm.

Only `web/core/primitives.js` imports from this directory.

| Package | Version | Files copied | Audits, as the package's own README lists them |
| --- | --- | --- | --- |
| `@noble/hashes` | 2.4.0 | `sha2.js`, `hmac.js`, `hkdf.js`, `utils.js` and their helpers `_md.js`, `_u64.js` | Cure53, January 2022, at version 1.0.0 (everything but blake3, sha3-addons, sha1 and argon2) |
| `@noble/curves` | 2.4.0 | `ed25519.js` (Ed25519 and X25519), `utils.js` and the `abstract/` modules it imports | Trail of Bits, August 2026, at version 2.3.0 (everything); Cure53, September 2024, at 1.6.0 (ed25519 among others); Kudelski Security, September 2023, at 1.2.0 (other modules) |
| `@noble/ciphers` | 2.4.0 | `chacha.js` (ChaCha20-Poly1305), `utils.js`, `_arx.js`, `_poly1305.js` | Cure53, September 2024, at version 1.0.0 (everything) |

Each package is MIT-licensed; its `LICENSE` is copied next to its files. The versions here
are later than the audited ones, so the audits do not cover the changes made since. Some
`abstract/` files (`fft.js`, `frost.js`, `oprf.js`, `hash-to-curve.js`) are not used by
the web core; they are here because `ed25519.js` imports them.

## How the copies are pinned

`scripts/vendor-noble.js` made this directory. For each package it:

1. obtains the tarball with `npm pack <name>@<version>` (or from a directory given with
   `--from`);
2. checks the tarball's SHA-512 against the integrity value written in the script, which
   is the one the npm registry publishes for that version;
3. copies the listed files, byte for byte, with two changes, both recorded: every
   JavaScript file gets one first line that switches off this repository's lint rules
   (they are written for ClawNet's code, not someone else's), and in `@noble/curves` the
   imports of `@noble/hashes` are rewritten to relative paths into `noble-hashes/`,
   because a browser cannot resolve a bare package name;
4. checks that no copied file imports anything outside the copied set;
5. writes `manifest.json`: version, tarball integrity, and for every file the SHA-256 of
   the copy and of the original.

`test/unit/web-vendor.test.js` recomputes every hash in the manifest, checks the import
closure, and checks that the code uses no Node-only global, so a file edited by hand fails
the test suite.

## What the tests check against these libraries

The web core is tested against the engine, which uses OpenSSL: the same hashes, HMAC, HKDF
and AEAD outputs, byte-identical Ed25519 signatures that verify across both, X25519
agreement and the same refusal of small-order points, and the published Noise test vectors
(`test/unit/web-core.test.js`, `web-noise.test.js`).

One difference is known and documented: noble's Ed25519 verification (called with
`zip215: false`, the strict RFC 8032 encoding rules) uses the cofactored equation, OpenSSL
the cofactorless one. They agree on every honestly made signature; a signature built to
fall between them can verify on one side only (`docs/DESIGN.md` section 16, point 8).

## Updating

1. Read the packages' changelogs and security notes for the new version.
2. Get each new integrity value: `npm view @noble/curves@<version> dist.integrity`, and the
   same for hashes and ciphers.
3. Change `version` and `integrity` in `PACKAGES` in `scripts/vendor-noble.js`; if the new
   version's import graph differs, the script says which file is missing from `files`.
4. Run `node scripts/vendor-noble.js` from `clawnet/`, then `npm test` and
   `npx eslint clawnet` from the repository root.
5. Review the diff of this directory like any other code change.
