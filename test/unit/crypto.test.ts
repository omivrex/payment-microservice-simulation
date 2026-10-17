import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { aadFor, Encryptor } from '../../src/crypto/encryption.ts';
import { canonicalJson, Hasher, randomSecret, safeEqual } from '../../src/crypto/hashing.ts';
import { SecurityError } from '../../src/errors.ts';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const enc = new Encryptor(new Map([['v1', k1]]), 'v1');
const AAD = aadFor('cards', 'card_abc', 'number');

const flipByte = (payload: string, part: number): string => {
  const parts = payload.split(':');
  const buf = Buffer.from(parts[part]!, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  parts[part] = buf.toString('base64');
  return parts.join(':');
};

describe('§4.4 encryption', () => {
  it('round-trips empty, ASCII and multi-byte UTF-8 strings', () => {
    for (const value of ['', '4242424242424242', 'héllo wörld ✓ 日本']) {
      assert.equal(enc.decrypt(enc.encrypt(value, AAD), AAD), value);
    }
  });

  it('uses a fresh IV every time (same plaintext → different ciphertext)', () => {
    assert.notEqual(enc.encrypt('same', AAD), enc.encrypt('same', AAD));
  });

  it('writes the documented format v1:<iv>:<tag>:<ct>', () => {
    const [kid, iv, tag] = enc.encrypt('x', AAD).split(':');
    assert.equal(kid, 'v1');
    assert.equal(Buffer.from(iv!, 'base64').length, 12);
    assert.equal(Buffer.from(tag!, 'base64').length, 16);
  });

  it('detects tampering with the IV, tag or ciphertext', () => {
    const payload = enc.encrypt('4242424242424242', AAD);
    for (const part of [1, 2, 3]) {
      assert.throws(() => enc.decrypt(flipByte(payload, part), AAD), SecurityError, `part ${part}`);
    }
  });

  it('refuses a ciphertext moved to another record or field (AAD)', () => {
    const payload = enc.encrypt('4242424242424242', AAD);
    assert.throws(() => enc.decrypt(payload, aadFor('cards', 'card_other', 'number')), SecurityError);
    assert.throws(() => enc.decrypt(payload, aadFor('webhookEndpoints', 'card_abc', 'secret')), SecurityError);
  });

  it('rejects unknown key versions and malformed payloads with SecurityError', () => {
    const payload = enc.encrypt('x', AAD);
    for (const bad of [payload.replace(/^v1/, 'v9'), 'garbage', 'v1:a:b', 'v1:!!:!!:!!', '']) {
      assert.throws(() => enc.decrypt(bad, AAD), SecurityError, bad);
    }
  });

  it('decrypts old data after a key rotation, and encrypts new data with the new key', () => {
    const old = enc.encrypt('legacy', AAD);
    const rotated = new Encryptor(new Map([['v1', k1], ['v2', k2]]), 'v2');
    assert.equal(rotated.decrypt(old, AAD), 'legacy');
    assert.ok(rotated.encrypt('new', AAD).startsWith('v2:'));
    assert.ok(rotated.needsReencryption(old));
  });

  it('refuses to construct with a missing active key or a short key', () => {
    assert.throws(() => new Encryptor(new Map([['v1', k1]]), 'v2'));
    assert.throws(() => new Encryptor(new Map([['v1', randomBytes(16)]]), 'v1'));
  });
});

describe('§4.4 hashing and fingerprints', () => {
  const hasher = new Hasher(randomBytes(32));

  it('fingerprints are deterministic and differ per card', () => {
    assert.equal(hasher.fingerprintCard('4242424242424242'), hasher.fingerprintCard('4242424242424242'));
    assert.notEqual(hasher.fingerprintCard('4242424242424242'), hasher.fingerprintCard('5555555555554444'));
  });

  it('fingerprints depend on HASHING_SECRET (keyed)', () => {
    const other = new Hasher(randomBytes(32));
    assert.notEqual(hasher.fingerprintCard('4242424242424242'), other.fingerprintCard('4242424242424242'));
  });

  it('uses separate sub-keys for API keys and fingerprints (domain separation)', () => {
    assert.notEqual(hasher.hashApiKeySecret('same-input'), hasher.fingerprintCard('same-input'));
  });

  it('rejects a short hashing secret', () => {
    assert.throws(() => new Hasher(randomBytes(16)));
  });
});

describe('helpers', () => {
  it('safeEqual handles different lengths without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', 'x'), false);
  });

  it('randomSecret has 256 bits of entropy as 43 base64url chars', () => {
    const s = randomSecret();
    assert.match(s, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(s, randomSecret());
  });

  it('canonicalJson ignores key order at any depth', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } }), canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  });
});
