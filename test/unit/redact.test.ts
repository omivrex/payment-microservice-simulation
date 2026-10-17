import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passesLuhn, redact, redactString } from '../../src/logging/redact.ts';

const SK = `sk_test_${'a1'.repeat(8)}_${'Z'.repeat(43)}`;
const PK = `pk_test_${'b2'.repeat(8)}_${'Y'.repeat(43)}`;
const WHSEC = `whsec_${'Q'.repeat(43)}`;

describe('§8.7 redaction layer 1: sensitive keys', () => {
  it('redacts each sensitive key at any depth, case-insensitively', () => {
    const out = redact({
      Authorization: 'Bearer x',
      nested: { deeper: { card: { number: '4242' }, CVC: '123', secret: 's', secretHash: 'h' } },
      list: [{ key: 'k', numberEncrypted: 'n', secretEncrypted: 'e', apiKeys: { a: 1 }, cookie: 'c' }],
    }) as any;
    assert.equal(out.Authorization, '[REDACTED]');
    assert.equal(out.nested.deeper.card, '[REDACTED]');
    assert.equal(out.nested.deeper.CVC, '[REDACTED]');
    assert.equal(out.nested.deeper.secret, '[REDACTED]');
    assert.equal(out.nested.deeper.secretHash, '[REDACTED]');
    for (const k of ['key', 'numberEncrypted', 'secretEncrypted', 'apiKeys', 'cookie']) {
      assert.equal(out.list[0][k], '[REDACTED]', k);
    }
  });

  it('leaves similarly named safe keys alone (keyId, cardId)', () => {
    const out = redact({ keyId: 'key_1', cardId: 'card_1' }) as any;
    assert.deepEqual(out, { keyId: 'key_1', cardId: 'card_1' });
  });
});

describe('§8.7 redaction layer 2: value patterns', () => {
  it('masks API keys, webhook secrets and bearer tokens inside free text', () => {
    const out = redactString(`failed with ${SK} and ${PK}; secret=${WHSEC}; header "Bearer abc.def"`);
    assert.ok(!out.includes(SK) && !out.includes(PK) && !out.includes(WHSEC));
    assert.match(out, /sk_test_\[REDACTED\]/);
    assert.match(out, /pk_test_\[REDACTED\]/);
    assert.match(out, /whsec_\[REDACTED\]/);
    assert.match(out, /Bearer \[REDACTED\]/);
  });

  it('masks Luhn-valid card numbers, with or without spaces/dashes', () => {
    for (const pan of ['4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242', '378282246310005']) {
      assert.equal(redactString(`card ${pan} declined`), 'card [REDACTED_PAN] declined', pan);
    }
  });

  it('masks card numbers inside error messages and stack traces', () => {
    const err = new Error('Unexpected token in JSON at position 10: {"number":"4242424242424242"}');
    const out = JSON.stringify(redact({ err }));
    assert.ok(!out.includes('4242424242424242'));
  });

  it('does not mask timestamps, amounts or Luhn-invalid numbers', () => {
    assert.equal(redactString('t=1760520600000'), 't=1760520600000');
    assert.equal(redactString('amount 100000'), 'amount 100000');
    assert.equal(redactString('4242424242424241'), '4242424242424241');
  });

  it('does not mask digit runs inside identifiers', () => {
    const id = 'req_1234567890123452abcdef0123456789';
    assert.equal(redactString(id), id);
  });

  it('masks our ciphertext format', () => {
    assert.equal(redactString('v1:aGVsbG8=:dGFn:Y3Q='), '[REDACTED_CIPHERTEXT]');
  });
});

describe('§8.7 robustness', () => {
  it('handles circular references, deep nesting and huge strings without throwing', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    let deep: any = { v: 'bottom' };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    const out = redact({ circular, deep, big: 'x'.repeat(1_000_000) }) as any;
    assert.equal(out.circular.self, '[Circular]');
    assert.match(JSON.stringify(out.deep), /\[Truncated\]/);
    assert.ok(out.big.length < 2100);
  });

  it('serializes errors with name, message, stack and cause chain', () => {
    const err = new Error('outer', { cause: new Error('inner') });
    const out = redact({ err }) as any;
    assert.equal(out.err.message, 'outer');
    assert.equal(out.err.cause.message, 'inner');
    assert.ok(out.err.stack);
  });
});

describe('Luhn', () => {
  it('validates known numbers', () => {
    assert.ok(passesLuhn('4242424242424242'));
    assert.ok(!passesLuhn('4242424242424241'));
  });
});
