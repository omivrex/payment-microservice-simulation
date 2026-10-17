import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Encryptor } from '../../src/crypto/encryption.ts';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { DAY, SECOND } from '../helpers/fakeClock.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let m: TestMerchant;
let failNextEncrypt = false;

before(async () => {
  app = await startTestApp({
    buildContext: (ctx) => {
      const real = ctx.encryptor;
      const flaky = Object.create(real) as Encryptor;
      flaky.encrypt = (plaintext: string, aad: string) => {
        if (failNextEncrypt) {
          failNextEncrypt = false;
          throw new TypeError('simulated bug');
        }
        return real.encrypt(plaintext, aad);
      };
      return { ...ctx, encryptor: flaky };
    },
  });
  m = await createMerchant(app);
});
after(() => app.close());

const post = (key: string, body: unknown, idemKey?: string, p = '/cards') =>
  app.api('POST', p, { key, body, headers: idemKey ? { 'idempotency-key': idemKey } : {} });

describe('§5.11 idempotency', () => {
  it('same key + same body → replayed response with Idempotent-Replayed: true; only one card created', async () => {
    const body = { card: card(), customerId: 'cus_idem_1' };
    const first = await post(m.sk, body, 'k-1');
    const second = await post(m.sk, body, 'k-1');
    assert.equal(first.status, 201);
    assert.equal(second.status, 201, 'original status replayed (not 200 duplicate)');
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(first.headers.get('idempotent-replayed'), null);
    assert.deepEqual(second.body, first.body);
  });

  it('same fields in a different key order → replay, not 422', async () => {
    const a = await post(m.sk, { customerId: 'cus_order', card: { cvc: '123', expYear: 2030, expMonth: 12, number: '4242424242424242' } }, 'k-order');
    const b = await post(m.sk, { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123' }, customerId: 'cus_order' }, 'k-order');
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(b.body, a.body);
  });

  it('same key + different body → 422 idempotency_key_reused', async () => {
    await post(m.sk, { card: card(), customerId: 'cus_a' }, 'k-reuse');
    const res = await post(m.sk, { card: card(), customerId: 'cus_b' }, 'k-reuse');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'idempotency_key_reused');
  });

  it('4xx responses are replayed too (same answer for the same request)', async () => {
    const bad = { card: card('4242424242424241') };
    const first = await post(m.sk, bad, 'k-400');
    const second = await post(m.sk, bad, 'k-400');
    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
  });

  it('a reservation still in progress → 409; after 60 s it is abandoned and the request runs', async () => {
    const recordId = 'POST:/cards:k-stuck';
    await app.ctx.db.transact(m.id, (d) => {
      d.idempotency[recordId] = {
        id: recordId,
        merchantId: m.id,
        requestHash: '',
        status: 'in_progress',
        responseStatus: null,
        responseBody: null,
        createdAt: app.clock.now().toISOString(),
        expiresAt: new Date(app.clock.now().getTime() + DAY).toISOString(),
      };
    });
    const body = { card: card(), customerId: 'cus_stuck' };
    // A stuck record with a different hash is a 422; craft the matching hash by replaying through a fresh key first.
    const hashFromFresh = await post(m.sk, body, 'k-hash-probe');
    const probe = app.ctx.db.read(m.id, (d) => d.idempotency['POST:/cards:k-hash-probe']!.requestHash);
    await app.ctx.db.transact(m.id, (d) => {
      d.idempotency[recordId]!.requestHash = probe;
    });
    assert.equal(hashFromFresh.status, 201);

    const blocked = await post(m.sk, body, 'k-stuck');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'idempotency_in_progress');

    app.clock.advance(61 * SECOND);
    const retried = await post(m.sk, body, 'k-stuck');
    assert.equal(retried.status, 200, 'runs again (dedupe returns the existing card)');
    assert.equal(retried.headers.get('idempotent-replayed'), null);
  });

  it('the same key on different endpoints is independent', async () => {
    const t = await post(m.pk, { card: card() }, 'k-shared', '/tokens');
    const c = await post(m.sk, { card: card(), customerId: 'cus_shared' }, 'k-shared', '/cards');
    assert.equal(t.status, 201);
    assert.ok(c.status === 201 || c.status === 200);
    assert.equal(c.headers.get('idempotent-replayed'), null);
  });

  it('the same key for two merchants is independent', async () => {
    const other = await createMerchant(app);
    const body = { card: card(), customerId: 'cus_two_merchants' };
    const a = await post(m.sk, body, 'k-merchants');
    const b = await post(other.sk, body, 'k-merchants');
    assert.equal(b.headers.get('idempotent-replayed'), null);
    assert.notEqual(a.body.id, b.body.id);
  });

  it('a key reused after 24 h is processed again', async () => {
    const body = { card: card('5555555555554444'), customerId: 'cus_expiry' };
    await post(m.sk, body, 'k-24h');
    app.clock.advance(DAY + SECOND);
    const res = await post(m.sk, body, 'k-24h');
    assert.equal(res.headers.get('idempotent-replayed'), null);
  });

  it('a 5xx is not stored: the retry with the same key runs again', async () => {
    failNextEncrypt = true;
    const body = { card: card('6011111111111117'), customerId: 'cus_5xx' };
    const first = await post(m.sk, body, 'k-5xx');
    assert.equal(first.status, 500);
    assert.equal(first.body.error.code, 'internal_error');
    assert.ok(!first.text.includes('simulated bug'), 'bug message not exposed');
    const retry = await post(m.sk, body, 'k-5xx');
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), null);
  });

  it('invalid Idempotency-Key values → 400', async () => {
    for (const key of ['x'.repeat(256), 'has space', 'tab\there']) {
      const res = await post(m.sk, { card: card() }, key);
      assert.equal(res.status, 400, JSON.stringify(key));
      assert.equal(res.body.error.details[0].field, 'Idempotency-Key');
    }
  });
});
