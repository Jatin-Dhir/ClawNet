# Noise test vectors

`noise-vectors.json` holds published test vectors for the Noise Protocol Framework
(revision 34), suite `25519_ChaChaPoly_SHA256`. They come from two implementations that
share no code with ClawNet or with each other, and they are what
`test/unit/crypto-noise.test.js` checks `src/core/crypto/noise.js` against.

Nothing in the file was produced by ClawNet. Each vector object is copied verbatim from its
source; the only addition is a leading `"source"` field naming where it came from.

## Sources

Both files were fetched on **2026-11-16** from URLs pinned to a commit, so the bytes behind
each URL cannot change.

### cacophony (Haskell)

| | |
| --- | --- |
| Repository | https://github.com/haskell-cryptography/cacophony |
| File | `vectors/cacophony.txt` |
| Exact URL | https://raw.githubusercontent.com/haskell-cryptography/cacophony/18b7348c54fd61fcd0c220298883de0d09c8364d/vectors/cacophony.txt |
| Commit | `18b7348c54fd61fcd0c220298883de0d09c8364d` (last commit to touch the file, 2018-12-16) |
| Git blob | `b8a271ed1aba8b4a56bf429e559d7947827123b4` |
| Size | 1,709,817 bytes, 944 vectors |
| SHA-256 | `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae` |
| Licence | The Unlicense (public domain dedication), per `LICENSE` at that commit |

The snow repository carries a byte-identical copy of this file (same git blob) as
`tests/vectors/cacophony.txt`.

### snow (Rust)

| | |
| --- | --- |
| Repository | https://github.com/mcginty/snow |
| File | `tests/vectors/snow.txt` |
| Exact URL | https://raw.githubusercontent.com/mcginty/snow/d00b360cc61a7fe519ce7539974dca4f36c4654a/tests/vectors/snow.txt |
| Commit | `d00b360cc61a7fe519ce7539974dca4f36c4654a` (last commit to touch the file, 2025-03-04) |
| Git blob | `11f7b7c8b43506f1ad8879dc789cc694cd7c17c0` |
| Size | 883,233 bytes, 408 vectors |
| SHA-256 | `69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3` |
| Licence | `Apache-2.0 OR MIT`, per `Cargo.toml` at that commit; used here under the MIT licence |

The vectors taken from snow are redistributed under the MIT licence, whose notice follows.

> MIT License
>
> Copyright (c) 2021 Jake McGinty
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## What was selected

From each source: every vector whose `protocol_name` is
`Noise_<pattern>_25519_ChaChaPoly_SHA256` with `<pattern>` one of the patterns that
`noise.js` implements. Nothing else was filtered and nothing was reordered. `noise.js`
implements 37 patterns; 36 of them have vectors. The 37th, `XXpsk0`, has none (next
section).

| Patterns | cacophony | snow |
| --- | --- | --- |
| Fundamental one-way: N, K, X | 3 | 3 |
| Fundamental interactive: NN, NK, NX, KN, KK, KX, XN, XK, XX, IN, IK, IX | 12 | 12 |
| Pre-shared key (Noise section 9.4): Npsk0, Kpsk0, Xpsk1, NNpsk0, NNpsk2, NKpsk0, NKpsk2, NXpsk2, XNpsk3, XKpsk3, XXpsk3, KNpsk0, KNpsk2, KKpsk0, KKpsk2, KXpsk2, INpsk1, INpsk2, IKpsk1, IKpsk2, IXpsk2 | 21 | 0 |
| **Total: 51** | 36 | 15 |

The three patterns ClawNet itself uses are covered as follows:

| Pattern | Used for | cacophony | snow |
| --- | --- | --- | --- |
| `Noise_XX_25519_ChaChaPoly_SHA256` | links | yes | yes |
| `Noise_XXpsk0_25519_ChaChaPoly_SHA256` | links on a network with a pre-shared key (DESIGN.md 15.4) | **no** | **no** |
| `Noise_X_25519_ChaChaPoly_SHA256` | end-to-end sealed messages | yes | yes |

`XXpsk3`, which links used before DESIGN.md 15.4, is still implemented and still verified
by its cacophony vector.

## XXpsk0: no published vector

**`Noise_XXpsk0_25519_ChaChaPoly_SHA256` is not verified against a published test vector.**
Neither source publishes one. On **2026-11-16** both files were fetched again from the
pinned URLs above, their SHA-256 matched the values recorded above, and every
`protocol_name` was listed:

- cacophony (944 vectors) has, in the `XX` family for this suite, only `XX`, `XXpsk3` and
  the deferred `XX1`;
- snow (408 vectors) has `XX`, `XX1` and the multi-psk patterns `XXpsk0+psk1`,
  `XXpsk0+psk2`, `XXpsk0+psk3` and `XXpsk0+psk1+psk2+psk3`. Those cannot stand in for
  `XXpsk0`: the protocol name is hashed into the first handshake state, so every byte
  differs, and `noise.js` does not implement multi-psk patterns.

No vector was added to `noise-vectors.json` for it, and none was generated: output of
`noise.js` (or of anything written alongside it) checked against itself is not
verification.

What does exist, and what it is worth:

- Published vectors for the parts. `XXpsk0` is the `XX` token sequence with `psk` placed
  first in message 1. cacophony's `NNpsk0`, `NKpsk0`, `KNpsk0`, `KKpsk0`, `Npsk0` and
  `Kpsk0` vectors verify `psk` as the first token of message 1 followed by `e`, including
  the rule of Noise section 9.2 that in any psk handshake `e` is followed by
  `MixKey(e.public_key)`; the `XX` and `XXpsk3` vectors verify the `XX` messages without and
  with that rule. All of them run through the same table-driven code that runs `XXpsk0`.
- An independent transcription. `crypto-noise.test.js` contains `XXpsk0` written out by
  hand from the specification with `node:crypto` (no code shared with `noise.js`) and checks
  that both agree byte for byte on all three handshake messages, the handshake hash and both
  transport keys, and that dropping the section 9.2 rule changes message 1. This catches a
  table or ordering mistake; it does not catch a misreading of the specification that both
  share. It is a cross-check, not a test vector.
- Behaviour: completion with equal keys; rejection at message 1, before any Diffie-Hellman
  work, when the keys differ or the peer runs plain `XX` or `XXpsk3`.

If a published `XXpsk0` vector for this suite becomes available from an independent
implementation, add it to `noise-vectors.json` and remove `XXpsk0` from
`WITHOUT_PUBLISHED_VECTOR` in `crypto-noise.test.js` (the coverage test fails until that is
done).

Not selected, because `noise.js` deliberately does not implement them: deferred patterns
(`XK1`, `X1X`, ...), patterns with more than one psk modifier (`XXpsk0+psk3`, ...), and all
other DH, cipher and hash choices. snow's file has no single-psk vectors for this suite, so
XXpsk3 and the other psk patterns rest on cacophony alone.

## Vector format

```
protocol_name                       full Noise protocol name
init_prologue, resp_prologue        hex
init_static, resp_static            hex PRIVATE key (the public key is derived)
init_ephemeral, resp_ephemeral      hex PRIVATE key
init_remote_static, resp_remote_static   hex public key known before the handshake
init_psks, resp_psks                list of hex pre-shared keys (at most one is used here)
handshake_hash                      hex, cacophony only: the final handshake hash h
messages                            list of { payload, ciphertext }, both hex
```

Messages are in wire order. The first one, two or three are handshake messages, sent
alternately starting with the initiator. The rest are transport messages encrypted with the
ciphers from `Split()` and an empty associated data: for interactive patterns the parties
keep alternating; for one-way patterns (N, K, X and their psk forms) every transport message
goes from initiator to responder.

## What the test checks

For every one of the 51 vectors, `crypto-noise.test.js` builds an initiator and a responder
`HandshakeState` from the vector's keys and runs every message:

- each handshake ciphertext written by the sender equals the vector byte for byte;
- the receiver decrypts the vector's ciphertext to the vector's payload;
- the handshake hash of both parties equals `handshake_hash` (all 36 cacophony vectors);
- after `split()`, each transport ciphertext equals the vector byte for byte and decrypts to
  its payload, in the direction described above;
- where a vector lists `init_remote_static`, it equals the X25519 public key derived from
  `resp_static`.

A further test asserts that every pattern `noise.js` accepts has a cacophony vector, except
the patterns listed by name in `WITHOUT_PUBLISHED_VECTOR` (only `XXpsk0`, see above), so a
pattern cannot be added to the engine without either a published vector or an explicit,
documented exception.

Between them the vectors exercise every token (`e`, `s`, `ee`, `es`, `se`, `ss`, `psk`),
static-key pre-messages for both roles, psk placement at the start and at the end of a
message, both branches of protocol-name hashing (31- and 32-byte names are padded, longer
ones are hashed), and nonces 0 to 4 of the transport ciphers.

## What the vectors do not cover

These are tested in the same file, but against direct `node:crypto` calls or by behaviour,
not against published vectors:

- nonce encoding for large counters, and the refusal to use nonce 2^64 - 1;
- `Rekey()`;
- the 65535-byte message limit;
- failure handling: tampering, truncation, wrong psk, wrong prologue, out-of-turn calls,
  small-order public keys.

## Regenerating the file

Download the two files from the exact URLs above, check their SHA-256, keep the vectors
matching the selection rule (cacophony's first, then snow's, each in file order), add the
`"source"` field in front of each, and write the result with two-space indentation and a
trailing newline. `sources` in the JSON repeats the URLs, commits, licences and hashes
recorded here.
