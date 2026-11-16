import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  AEAD_TAG_LENGTH,
  MAX_RANDOM_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  assertBytes,
  base32Decode,
  base32Encode,
  base64Decode,
  base64Encode,
  ed25519GenerateKeyPair,
  ed25519HasSmallOrder,
  ed25519PublicFromPrivate,
  ed25519Sign,
  ed25519Verify,
  hkdfExpand,
  hmacSha256,
  randomBytes,
  sha256,
  timingSafeEqual,
  x25519,
  x25519GenerateKeyPair,
  x25519HasSmallOrder,
  x25519PublicFromPrivate,
} from '../../src/core/crypto/primitives.js';
import { AuthError, CryptoError } from '../../src/core/errors.js';

const hex = text => Buffer.from(text, 'hex');
const utf8 = text => Buffer.from(text, 'utf8');
const sequence = (start, length) => Buffer.from(Array.from({ length }, (_, i) => start + i));

/** Points of small order on Curve25519 (Montgomery u-coordinates), as listed by libsodium. */
const X25519_LOW_ORDER = [
  '00'.repeat(32),
  `01${'00'.repeat(31)}`,
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  `ec${'ff'.repeat(30)}7f`,
  `ed${'ff'.repeat(30)}7f`,
  `ee${'ff'.repeat(30)}7f`,
];

/** RFC 8032 section 7.1, tests 1 to 3: [seed, public key, message, signature]. */
const RFC8032 = [
  [
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    '',
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  ],
  [
    '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    '72',
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  ],
  [
    'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    'af82',
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  ],
];

/**
 * For each encoding of a small-order Ed25519 point A: [A, message, signature], where the
 * signature satisfies the RFC 8032 equation [S]B = R + [k]A. Derived offline with exact
 * integer arithmetic (S fixed, R = [S]B - [k]A searched over the at most 8 multiples of A).
 * A verifier that does not refuse small-order keys accepts every row; the test that uses
 * these rows proves that with satisfiesEd25519Equation() below instead of taking it on trust.
 */
const ED25519_SMALL_ORDER_FORGERIES = [
  ['0000000000000000000000000000000000000000000000000000000000000000', 'forged 1', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['0000000000000000000000000000000000000000000000000000000000000080', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['0100000000000000000000000000000000000000000000000000000000000000', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['0100000000000000000000000000000000000000000000000000000000000080', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', 'forged 0', 'e3ec15c6e39445ad6789f9baa9f5617d8761841be1bfccf361cb4f5f8eb5fb31efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'forged 0', '4edf6eb705468c10a5c240c1a10ffa638dc966cce690f78ddeac33d11f339ec0efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', 'forged 0', '0a13ea391c6bba5298760645560a9e82789e7be41e40330c9e34b0a0714a04ceefcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'forged 0', 'c2ec1412f498b8f03bae8b6e41dabef8a34dddc2aeee49e2eb29447aa762cb7eefcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'forged 0', '9f209148fab973ef5a3dbf3e5ef0059c72369933196f08722153cc2ee0cc613fefcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
  ['eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'forged 0', '2b13ebed0b67470fc4517491be2541075cb2223d5111b61d14d6bb85589d3481efcdab8967452301efcdab896745230100000000000000000000000000000000'],
];

/** RFC 8439 section 2.8.2. */
const RFC8439 = {
  key: hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
  nonce: hex('070000004041424344454647'),
  ad: hex('50515253c0c1c2c3c4c5c6c7'),
  plaintext: utf8(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
  ),
  sealed: hex(
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b' +
      '1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc' +
      '3ff4def08e4b7a9de576d26586cec64b6116' +
      '1ae10b594f09e26a7e902ecbd0600691'
  ),
};

test('assertBytes accepts byte arrays of the right length and nothing else', () => {
  const buffer = Buffer.alloc(4);
  assert.equal(assertBytes(buffer, 'x'), buffer);
  assert.doesNotThrow(() => assertBytes(new Uint8Array(4), 'x', 4));
  for (const value of [undefined, null, 'abcd', [1, 2, 3, 4], new ArrayBuffer(4), new DataView(new ArrayBuffer(4)), 4, {}]) {
    assert.throws(() => assertBytes(value, 'x'), CryptoError, inspect(value));
  }
  assert.throws(() => assertBytes(buffer, 'x', 5), { code: 'ERR_CRYPTO', message: 'x must be 5 bytes, got 4' });
});

test('randomBytes returns the requested number of unpredictable bytes', () => {
  assert.equal(randomBytes(0).length, 0);
  assert.equal(randomBytes(32).length, 32);
  assert.equal(randomBytes(MAX_RANDOM_BYTES).length, MAX_RANDOM_BYTES);
  assert.ok(Buffer.isBuffer(randomBytes(8)));
  assert.notDeepEqual(randomBytes(32), randomBytes(32));
  for (const n of [-1, 1.5, NaN, Infinity, '32', undefined, null, MAX_RANDOM_BYTES + 1]) {
    assert.throws(() => randomBytes(n), CryptoError, String(n));
  }
});

test('sha256 matches FIPS 180 known answers and hashes chunks as one message', () => {
  assert.equal(sha256().toString('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(utf8('abc')).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepEqual(sha256(utf8('a'), utf8(''), utf8('bc')), sha256(utf8('abc')));
  assert.equal(
    sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toString('hex'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
  assert.throws(() => sha256('abc'), CryptoError);
  assert.throws(() => sha256(utf8('a'), undefined), CryptoError);
});

test('hmacSha256 matches RFC 4231 test cases 1 and 2', () => {
  assert.equal(
    hmacSha256(Buffer.alloc(20, 0x0b), utf8('Hi There')).toString('hex'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  );
  assert.equal(
    hmacSha256(utf8('Jefe'), utf8('what do ya want '), utf8('for nothing?')).toString('hex'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  );
  assert.throws(() => hmacSha256('Jefe', utf8('x')), CryptoError);
  assert.throws(() => hmacSha256(utf8('Jefe'), 'x'), CryptoError);
});

test('hkdfExpand matches RFC 5869 test cases 1 to 3', () => {
  assert.equal(
    hkdfExpand({
      ikm: Buffer.alloc(22, 0x0b),
      salt: hex('000102030405060708090a0b0c'),
      info: hex('f0f1f2f3f4f5f6f7f8f9'),
      length: 42,
    }).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
  );
  assert.equal(
    hkdfExpand({ ikm: sequence(0x00, 80), salt: sequence(0x60, 80), info: sequence(0xb0, 80), length: 82 }).toString('hex'),
    'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09' +
      'da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87'
  );
  assert.equal(
    hkdfExpand({ ikm: Buffer.alloc(22, 0x0b), salt: Buffer.alloc(0), info: Buffer.alloc(0), length: 42 }).toString('hex'),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
  );
});

test('hkdfExpand is extract-then-expand, and an omitted salt is 32 zero bytes', () => {
  const ikm = utf8('input keying material');
  const salt = utf8('salt');
  const info = utf8('context');
  // RFC 5869 written out with HMAC: PRK = HMAC(salt, IKM); T(n) = HMAC(PRK, T(n-1) | info | n).
  const prk = hmacSha256(salt, ikm);
  const t1 = hmacSha256(prk, info, Buffer.from([1]));
  const t2 = hmacSha256(prk, t1, info, Buffer.from([2]));
  assert.deepEqual(hkdfExpand({ ikm, salt, info, length: 48 }), Buffer.concat([t1, t2]).subarray(0, 48));

  assert.deepEqual(hkdfExpand({ ikm, info, length: 32 }), hkdfExpand({ ikm, salt: Buffer.alloc(32), info, length: 32 }));
  assert.notDeepEqual(hkdfExpand({ ikm, info, length: 32 }), hkdfExpand({ ikm, info: utf8('other'), length: 32 }));
  assert.equal(hkdfExpand({ ikm, info, length: 8160 }).length, 8160);
});

test('hkdfExpand rejects malformed parameters', () => {
  const good = { ikm: Buffer.alloc(32, 1), salt: Buffer.alloc(32, 2), info: utf8('i'), length: 32 };
  assert.equal(hkdfExpand(good).length, 32);
  const bad = [
    { ikm: Buffer.alloc(0) },
    { ikm: 'secret' },
    { ikm: undefined },
    { salt: 'salt' },
    { salt: null },
    { info: undefined },
    { info: 'info' },
    { info: Buffer.alloc(1025) },
    { length: 0 },
    { length: 8161 },
    { length: 1.5 },
    { length: '32' },
  ];
  for (const override of bad) {
    assert.throws(() => hkdfExpand({ ...good, ...override }), CryptoError, inspect(override));
  }
  assert.throws(() => hkdfExpand(), CryptoError);
});

test('x25519 matches the RFC 7748 known answers', () => {
  // Section 5.2, first vector.
  assert.equal(
    x25519(
      hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
      hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    ).toString('hex'),
    'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552'
  );
  // Section 6.1.
  const alice = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bob = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  const alicePublic = x25519PublicFromPrivate(alice);
  const bobPublic = x25519PublicFromPrivate(bob);
  assert.equal(alicePublic.toString('hex'), '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  assert.equal(bobPublic.toString('hex'), 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
  assert.equal(x25519(alice, bobPublic).toString('hex'), shared);
  assert.equal(x25519(bob, alicePublic).toString('hex'), shared);
});

test('x25519 key generation yields a usable, fresh 32-byte pair', () => {
  const a = x25519GenerateKeyPair();
  const b = x25519GenerateKeyPair();
  assert.deepEqual(Object.keys(a).sort(), ['privateKey', 'publicKey']);
  assert.equal(a.privateKey.length, 32);
  assert.equal(a.publicKey.length, 32);
  assert.deepEqual(x25519PublicFromPrivate(a.privateKey), a.publicKey);
  assert.notDeepEqual(a.privateKey, b.privateKey);
  assert.deepEqual(x25519(a.privateKey, b.publicKey), x25519(b.privateKey, a.publicKey));
  assert.equal(x25519(a.privateKey, b.publicKey).length, 32);
});

test('x25519 refuses every small-order public key instead of returning zeros', () => {
  const { privateKey } = x25519GenerateKeyPair();
  let refused = 0;
  for (const point of X25519_LOW_ORDER) {
    // The top bit of a u-coordinate is ignored, so both spellings must be refused.
    for (const topBit of [0x00, 0x80]) {
      const publicKey = hex(point);
      assert.equal(publicKey.length, 32);
      publicKey[31] |= topBit;
      assert.throws(() => x25519(privateKey, publicKey), { name: 'CryptoError', code: 'ERR_CRYPTO' }, point);
      refused += 1;
    }
  }
  assert.equal(refused, 14);
});

test('x25519HasSmallOrder flags exactly the keys x25519 refuses', () => {
  const { privateKey } = x25519GenerateKeyPair();
  let flagged = 0;
  for (const point of X25519_LOW_ORDER) {
    for (const topBit of [0x00, 0x80]) {
      const publicKey = hex(point);
      publicKey[31] |= topBit;
      assert.equal(x25519HasSmallOrder(publicKey), true, `${point} top bit ${topBit}`);
      // The list and the key agreement agree: every flagged key is one x25519 refuses.
      assert.throws(() => x25519(privateKey, publicKey), CryptoError);
      flagged += 1;
    }
  }
  assert.equal(flagged, 14);

  // Ordinary keys, the RFC 7748 keys, and neighbours of listed values are not flagged,
  // and x25519 accepts each of them.
  const ordinary = [
    hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'),
    hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'),
    hex(`02${'00'.repeat(31)}`),
    hex(`09${'00'.repeat(31)}`),
    hex(`eb${'ff'.repeat(30)}7f`),
    hex(`ef${'ff'.repeat(30)}7f`),
  ];
  for (let i = 0; i < 16; i += 1) ordinary.push(x25519GenerateKeyPair().publicKey);
  for (const publicKey of ordinary) {
    assert.equal(x25519HasSmallOrder(publicKey), false, publicKey.toString('hex'));
    assert.equal(x25519(privateKey, publicKey).length, 32);
  }
  // The caller's buffer is not modified by the top-bit masking.
  const spelled = hex(`01${'00'.repeat(30)}80`);
  assert.equal(x25519HasSmallOrder(spelled), true);
  assert.equal(spelled[31], 0x80);

  for (const value of [Buffer.alloc(31), Buffer.alloc(33), '00'.repeat(32), undefined, null]) {
    assert.throws(() => x25519HasSmallOrder(value), { name: 'CryptoError', code: 'ERR_CRYPTO' }, inspect(value));
  }
});

test('x25519 checks key sizes and types, and its errors do not echo key bytes', () => {
  const { privateKey, publicKey } = x25519GenerateKeyPair();
  for (const value of [Buffer.alloc(31), Buffer.alloc(33), privateKey.toString('hex'), undefined, null]) {
    assert.throws(() => x25519(value, publicKey), CryptoError);
    assert.throws(() => x25519(privateKey, value), CryptoError);
    assert.throws(() => x25519PublicFromPrivate(value), CryptoError);
  }
  const errors = [];
  try {
    x25519(privateKey, hex(X25519_LOW_ORDER[0]));
  } catch (err) {
    errors.push(err);
  }
  try {
    x25519(Buffer.concat([privateKey, privateKey]), publicKey);
  } catch (err) {
    errors.push(err);
  }
  assert.equal(errors.length, 2);
  for (const err of errors) {
    const dump = inspect(err, { depth: 8, showHidden: true });
    assert.ok(!dump.includes(privateKey.toString('hex')));
    assert.ok(!dump.includes(privateKey.toString('base64')));
  }
});

test('ed25519 matches the RFC 8032 known answers', () => {
  for (const [seed, publicKey, message, signature] of RFC8032) {
    assert.equal(ed25519PublicFromPrivate(hex(seed)).toString('hex'), publicKey);
    assert.equal(ed25519Sign(hex(seed), hex(message)).toString('hex'), signature);
    assert.equal(ed25519Verify(hex(publicKey), hex(message), hex(signature)), true);
  }
});

test('ed25519Verify rejects any change to message, signature or key', () => {
  const [, publicKey, message, signature] = RFC8032[2].map(hex);
  assert.equal(ed25519Verify(publicKey, message, signature), true);
  assert.equal(ed25519Verify(publicKey, Buffer.concat([message, Buffer.from([0])]), signature), false);
  assert.equal(ed25519Verify(publicKey, Buffer.alloc(0), signature), false);
  assert.equal(ed25519Verify(hex(RFC8032[0][1]), message, signature), false);
  let rejected = 0;
  for (let i = 0; i < signature.length; i += 1) {
    const tampered = Buffer.from(signature);
    tampered[i] ^= 1 << (i % 8);
    assert.equal(ed25519Verify(publicKey, message, tampered), false, `signature byte ${i}`);
    rejected += 1;
  }
  assert.equal(rejected, 64);
});

test('ed25519Verify rejects a signature whose S is not reduced (malleability)', () => {
  const [, publicKey, message, signature] = RFC8032[1].map(hex);
  // S + L encodes the same scalar; a lax verifier would accept it as a second signature.
  const order = 2n ** 252n + 27742317777372353535851937790883648493n;
  const s = BigInt(`0x${Buffer.from(signature.subarray(32)).reverse().toString('hex')}`) + order;
  const malleated = Buffer.concat([
    signature.subarray(0, 32),
    Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse(),
  ]);
  assert.equal(malleated.length, 64);
  assert.notDeepEqual(malleated, signature);
  assert.equal(ed25519Verify(publicKey, message, signature), true);
  assert.equal(ed25519Verify(publicKey, message, malleated), false);
});

test('ed25519Verify never throws and returns false for malformed arguments', () => {
  const { publicKey, privateKey } = ed25519GenerateKeyPair();
  const message = utf8('message');
  const signature = ed25519Sign(privateKey, message);
  assert.equal(ed25519Verify(publicKey, message, signature), true);
  const garbage = [undefined, null, 'text', 42, {}, [], Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(63), Buffer.alloc(65)];
  for (const value of garbage) {
    assert.equal(ed25519Verify(value, message, signature), false);
    assert.equal(ed25519Verify(publicKey, message, value), false);
  }
  for (const value of [undefined, null, 'message', 42, {}]) {
    assert.equal(ed25519Verify(publicKey, value, signature), false);
  }
  // 32 bytes that are not a point on the curve.
  assert.equal(ed25519Verify(Buffer.alloc(32, 0x02), message, signature), false);
  assert.equal(ed25519Verify(Buffer.alloc(32, 0xff), message, signature), false);
});

test('ed25519 key generation, signing and argument checks', () => {
  const a = ed25519GenerateKeyPair();
  const b = ed25519GenerateKeyPair();
  assert.equal(a.privateKey.length, 32);
  assert.equal(a.publicKey.length, 32);
  assert.deepEqual(ed25519PublicFromPrivate(a.privateKey), a.publicKey);
  assert.notDeepEqual(a.privateKey, b.privateKey);
  const message = utf8('hello');
  const signature = ed25519Sign(a.privateKey, message);
  assert.equal(signature.length, 64);
  assert.deepEqual(ed25519Sign(a.privateKey, message), signature);
  assert.equal(ed25519Verify(a.publicKey, message, signature), true);
  assert.equal(ed25519Verify(b.publicKey, message, signature), false);
  assert.throws(() => ed25519Sign(Buffer.alloc(31), message), CryptoError);
  assert.throws(() => ed25519Sign(a.privateKey.toString('hex'), message), CryptoError);
  assert.throws(() => ed25519Sign(a.privateKey, 'hello'), CryptoError);
  assert.throws(() => ed25519PublicFromPrivate(Buffer.alloc(64)), CryptoError);
});

test('ed25519 public keys of small order are recognised and never verify', () => {
  let checked = 0;
  for (const [publicKey, message, signature] of ED25519_SMALL_ORDER_FORGERIES) {
    assert.equal(ed25519HasSmallOrder(hex(publicKey)), true, publicKey);
    assert.equal(ed25519Verify(hex(publicKey), utf8(message), hex(signature)), false, publicKey);
    checked += 1;
  }
  assert.equal(checked, 14);
  // Ordinary keys are not caught by the list.
  for (const [, publicKey] of RFC8032) assert.equal(ed25519HasSmallOrder(hex(publicKey)), false);
  for (let i = 0; i < 32; i += 1) {
    assert.equal(ed25519HasSmallOrder(ed25519GenerateKeyPair().publicKey), false);
  }
  // The base point, and a neighbour of a listed encoding.
  assert.equal(ed25519HasSmallOrder(hex(`58${'66'.repeat(31)}`)), false);
  assert.equal(ed25519HasSmallOrder(hex(`02${'00'.repeat(31)}`)), false);
  assert.throws(() => ed25519HasSmallOrder(Buffer.alloc(31)), CryptoError);
  assert.throws(() => ed25519HasSmallOrder('00'.repeat(32)), CryptoError);
});

test('aead matches the RFC 8439 known answer in both directions', () => {
  const { key, nonce, ad, plaintext, sealed } = RFC8439;
  assert.deepEqual(aeadEncrypt(key, nonce, ad, plaintext), sealed);
  assert.deepEqual(aeadDecrypt(key, nonce, ad, sealed), plaintext);
  assert.equal(sealed.length, plaintext.length + AEAD_TAG_LENGTH);
});

test('aeadDecrypt rejects a flipped bit anywhere in ciphertext or tag', () => {
  const { key, nonce, ad, sealed } = RFC8439;
  let rejected = 0;
  for (let i = 0; i < sealed.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const tampered = Buffer.from(sealed);
      tampered[i] ^= 1 << bit;
      assert.throws(() => aeadDecrypt(key, nonce, ad, tampered), { name: 'AuthError', code: 'ERR_AUTH' });
      rejected += 1;
    }
  }
  assert.equal(rejected, sealed.length * 8);
});

test('aeadDecrypt rejects the wrong key, nonce or associated data, and truncation', () => {
  const { key, nonce, ad, sealed } = RFC8439;
  const flip = buffer => {
    const copy = Buffer.from(buffer);
    copy[0] ^= 1;
    return copy;
  };
  assert.throws(() => aeadDecrypt(flip(key), nonce, ad, sealed), AuthError);
  assert.throws(() => aeadDecrypt(key, flip(nonce), ad, sealed), AuthError);
  assert.throws(() => aeadDecrypt(key, nonce, flip(ad), sealed), AuthError);
  assert.throws(() => aeadDecrypt(key, nonce, Buffer.alloc(0), sealed), AuthError);
  assert.throws(() => aeadDecrypt(key, nonce, Buffer.concat([ad, Buffer.from([0])]), sealed), AuthError);
  // Every proper prefix, including ones shorter than a tag and one with a 15-byte tag.
  for (let length = 0; length < sealed.length; length += 1) {
    assert.throws(() => aeadDecrypt(key, nonce, ad, sealed.subarray(0, length)), AuthError, `length ${length}`);
  }
  assert.throws(() => aeadDecrypt(key, nonce, ad, Buffer.concat([sealed, Buffer.from([0])])), AuthError);
});

test('aead handles empty plaintext and empty associated data', () => {
  const key = randomBytes(32);
  const nonce = Buffer.alloc(12);
  const empty = Buffer.alloc(0);
  const sealed = aeadEncrypt(key, nonce, empty, empty);
  assert.equal(sealed.length, AEAD_TAG_LENGTH);
  assert.deepEqual(aeadDecrypt(key, nonce, empty, sealed), empty);
  assert.throws(() => aeadDecrypt(key, nonce, utf8('x'), sealed), AuthError);
  // Uint8Array inputs behave like Buffers.
  const plaintext = new Uint8Array([1, 2, 3]);
  const viaTyped = aeadEncrypt(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(0), plaintext);
  assert.deepEqual(aeadDecrypt(key, nonce, empty, viaTyped), Buffer.from(plaintext));
});

test('aead preconditions throw CryptoError, not AuthError', () => {
  const key = Buffer.alloc(32, 1);
  const nonce = Buffer.alloc(12, 2);
  const data = Buffer.alloc(40, 3);
  const calls = [
    [Buffer.alloc(31), nonce, data, data],
    [Buffer.alloc(33), nonce, data, data],
    [key.toString('hex'), nonce, data, data],
    [key, Buffer.alloc(8), data, data],
    [key, Buffer.alloc(13), data, data],
    [key, undefined, data, data],
    [key, nonce, 'ad', data],
    [key, nonce, undefined, data],
    [key, nonce, data, 'text'],
    [key, nonce, data, undefined],
  ];
  for (const args of calls) {
    assert.throws(() => aeadEncrypt(...args), { name: 'CryptoError', code: 'ERR_CRYPTO' });
    assert.throws(() => aeadDecrypt(...args), { name: 'CryptoError', code: 'ERR_CRYPTO' });
  }
});

test('timingSafeEqual compares contents and tolerates different lengths', () => {
  assert.equal(timingSafeEqual(hex('0102'), hex('0102')), true);
  assert.equal(timingSafeEqual(hex('0102'), hex('0103')), false);
  assert.equal(timingSafeEqual(hex('0102'), hex('010203')), false);
  assert.equal(timingSafeEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), hex('0102')), true);
  assert.throws(() => timingSafeEqual('0102', hex('0102')), CryptoError);
  assert.throws(() => timingSafeEqual(hex('0102'), undefined), CryptoError);
});

test('base32 matches the RFC 4648 vectors in lowercase without padding', () => {
  const vectors = [
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(utf8(plain)), encoded);
    assert.deepEqual(base32Decode(encoded), utf8(plain));
  }
  // Cross-checked against Python's base64.b32encode for an RFC 8032 public key.
  assert.equal(
    base32Encode(hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')),
    '25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena'
  );
});

test('base32 round-trips every length and all byte values', () => {
  for (let length = 0; length <= 70; length += 1) {
    const bytes = randomBytes(length);
    const encoded = base32Encode(bytes);
    assert.equal(encoded.length, Math.ceil((length * 8) / 5));
    assert.match(encoded, /^[a-z2-7]*$/);
    assert.deepEqual(base32Decode(encoded), bytes);
  }
  assert.deepEqual(base32Decode(base32Encode(sequence(0, 256))), sequence(0, 256));
  assert.deepEqual(base32Decode(base32Encode(Buffer.alloc(32, 0xff))), Buffer.alloc(32, 0xff));
  assert.equal(base32Encode(new Uint8Array([0x66])), 'my');
});

test('base32Decode accepts exactly one spelling per value', () => {
  const rejected = [
    ['MY', 'uppercase'],
    ['My', 'mixed case'],
    ['my======', 'padding'],
    ['m', 'length 1'],
    ['mzx', 'length 3'],
    ['mzxw6y', 'length 6'],
    ['mzxw6ytbo', 'length 9'],
    ['mz', 'trailing bits after 1 byte'],
    ['mzxr', 'trailing bits after 2 bytes'],
    ['mzxw7', 'trailing bits after 3 bytes'],
    ['mzxw6yr', 'trailing bits after 4 bytes'],
    ['m1', 'digit 1'],
    ['m0', 'digit 0'],
    ['m8', 'digit 8'],
    ['m9', 'digit 9'],
    ['m y', 'space'],
    ['my\n', 'newline'],
    ['m-', 'punctuation'],
    [`m${String.fromCodePoint(0xe9)}`, 'non-ASCII letter'],
    [`m${String.fromCodePoint(0x1f600)}`, 'astral character'],
    [`m${String.fromCodePoint(0x161)}`, 'code unit whose low byte is a letter'],
  ];
  for (const [text, why] of rejected) {
    assert.throws(() => base32Decode(text), { name: 'CryptoError', code: 'ERR_CRYPTO' }, why);
  }
  for (const value of [undefined, null, 42, utf8('my'), ['m', 'y']]) {
    assert.throws(() => base32Decode(value), CryptoError);
  }
  assert.throws(() => base32Encode('f'), CryptoError);
});

test('base64 matches the RFC 4648 vectors', () => {
  const vectors = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base64Encode(utf8(plain)), encoded);
    assert.deepEqual(base64Decode(encoded), utf8(plain));
    assert.deepEqual(base64Decode(encoded, plain.length), utf8(plain));
  }
  assert.equal(base64Encode(hex('fbff')), '+/8=');
  assert.deepEqual(base64Decode('+/8='), hex('fbff'));
  for (let length = 0; length <= 70; length += 1) {
    const bytes = randomBytes(length);
    assert.deepEqual(base64Decode(base64Encode(bytes), length), bytes);
  }
  // A view into a larger buffer encodes only its own bytes.
  assert.equal(base64Encode(utf8('xfoox').subarray(1, 4)), 'Zm9v');
  assert.equal(base64Encode(new Uint8Array(utf8('xfoox').buffer, utf8('xfoox').byteOffset + 1, 3)), 'Zm9v');
});

test('base64Decode accepts exactly one spelling per value', () => {
  const rejected = [
    ['Zg', 'missing padding'],
    ['Zg=', 'short padding'],
    ['Zg===', 'long padding'],
    ['Zh==', 'trailing bits after 1 byte'],
    ['Zm9=', 'trailing bits after 2 bytes'],
    ['Zm9v\n', 'trailing newline'],
    [' Zm9v', 'leading space'],
    ['Zm 9v', 'inner space'],
    ['Zm9v====', 'padding after a full group'],
    ['-_8=', 'URL-safe alphabet'],
    ['Zm9v!', 'punctuation'],
    ['=', 'padding only'],
    ['Zg==Zg==', 'concatenated values'],
    [`Zm9${String.fromCodePoint(0xe9)}`, 'non-ASCII'],
  ];
  for (const [text, why] of rejected) {
    assert.throws(() => base64Decode(text), { name: 'CryptoError', code: 'ERR_CRYPTO' }, why);
  }
  for (const value of [undefined, null, 42, utf8('Zg=='), ['Zg==']]) {
    assert.throws(() => base64Decode(value), CryptoError);
  }
  assert.throws(() => base64Encode('f'), CryptoError);
});

test('base64Decode enforces the expected length', () => {
  const key = randomBytes(32);
  assert.deepEqual(base64Decode(base64Encode(key), 32), key);
  assert.throws(() => base64Decode(base64Encode(key), 31), CryptoError);
  assert.throws(() => base64Decode(base64Encode(key), 33), CryptoError);
  assert.throws(() => base64Decode(base64Encode(key.subarray(0, 31)), 32), CryptoError);
  assert.throws(() => base64Decode(base64Encode(Buffer.alloc(64)), 32), CryptoError);
  assert.throws(() => base64Decode('', 32), CryptoError);
  assert.deepEqual(base64Decode('', 0), Buffer.alloc(0));
  for (const length of [-1, 1.5, '32', null]) {
    assert.throws(() => base64Decode(base64Encode(key), length), CryptoError);
  }
});
