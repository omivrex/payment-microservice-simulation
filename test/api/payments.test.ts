import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let m: TestMerchant;
before(async () => {
  app = await startTestApp();
  m = await createMerchant(app);
});
after(() => app.close());

const pay = (body: Record<string, unknown>, key = m.sk) =>
  app.api('POST', '/payments', { key, body: { amountMinor: 1000, currency: 'usd', ...body } });
const get = (id: string, key = m.sk) => app.api('GET', `/payments/${id}`, { key });
const action = (id: string, kind: 'capture' | 'refund' | 'cancel', body?: unknown, key = m.sk) =>
  app.api('POST', `/payments/${id}/${kind}`, { key, ...(body === undefined ? {} : { body }) });
const events = (merchantId: string, paymentId: string) =>
  app.ctx.db.read(merchantId, (d) => Object.values(d.events).filter((e) => (e.data.object as any).id === paymentId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((e) => e.type));

/** Creates a payment and lets the worker settle it. */
async function settled(body: Record<string, unknown>) {
  const res = await pay(body);
  assert.equal(res.status, 202, res.text);
  await app.settle();
  return (await get(res.body.id)).body;
}

describe('§5.8 POST /payments', () => {
  it('202 Accepted with status pending, documented shape, payment.created recorded', async () => {
    const res = await pay({ card: card(), description: 'Order #1', metadata: { orderId: '1' }, customerId: 'cus_1' });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.currency, 'USD');
    assert.match(res.body.id, /^pay_[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'amountCapturedMinor', 'amountMinor', 'amountRefundedMinor', 'authorizationCode', 'captureMethod', 'createdAt', 'currency', 'customerId',
      'description', 'failure', 'history', 'id', 'metadata', 'paymentMethod', 'pendingAction', 'status', 'updatedAt',
    ]);
    assert.deepEqual(res.body.paymentMethod, { type: 'card', cardId: null, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
    assert.equal(res.body.pendingAction.type, 'authorize');
    assert.deepEqual(events(m.id, res.body.id), ['payment.created']);
    for (const hidden of ['sourceCardId', 'saveCardOnApproval', 'merchantId']) assert.ok(!(hidden in res.body), hidden);
  });

  it('automatic capture: pending → capturing → captured; events created, authorized, captured', async () => {
    const res = await pay({ card: card() });
    await app.runWorker();
    const mid = (await get(res.body.id)).body;
    assert.equal(mid.status, 'capturing');
    assert.equal(mid.pendingAction.type, 'capture');
    await app.runWorker();
    const done = (await get(res.body.id)).body;
    assert.equal(done.status, 'captured');
    assert.equal(done.amountCapturedMinor, 1000);
    assert.equal(done.pendingAction, null);
    assert.deepEqual(done.history.map((h: any) => h.type), ['created', 'authorized', 'captured']);
    assert.deepEqual(events(m.id, res.body.id), ['payment.created', 'payment.authorized', 'payment.captured']);
    const jobs = app.ctx.db.read(m.id, (d) => Object.values(d.jobs).filter((j) => j.paymentId === res.body.id).map((j) => j.type).sort());
    assert.deepEqual(jobs, ['authorize', 'capture'], 'two jobs: a failed capture never re-authorizes');
  });

  it('manual capture: pending → authorized, then capture → captured', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    assert.equal(p.status, 'authorized');
    assert.match(p.authorizationCode, /^[0-9A-F]{6}$/);
    const cap = await action(p.id, 'capture');
    assert.equal(cap.status, 202);
    assert.equal(cap.body.status, 'capturing');
    await app.settle();
    assert.equal((await get(p.id)).body.status, 'captured');
  });

  const testCards: Array<[string, string]> = [
    ['4000000000000002', 'card_declined'],
    ['4000000000009995', 'insufficient_funds'],
    ['4000000000000069', 'expired_card'],
    ['4000000000000127', 'incorrect_cvc'],
  ];
  for (const [number, code] of testCards) {
    it(`test card ${number} → failed with ${code}, after exactly one attempt`, async () => {
      const p = await settled({ card: card(number) });
      assert.equal(p.status, 'failed');
      assert.equal(p.failure.code, code);
      const attempts = app.ctx.db.read(m.id, (d) => Object.values(d.jobs).find((j) => j.paymentId === p.id)!.attempts);
      assert.equal(attempts, 1);
      assert.deepEqual(events(m.id, p.id), ['payment.created', 'payment.failed']);
    });
  }

  it('test card 4000000000000119 (processing_error) is retried, then fails with processing_error', async () => {
    const res = await pay({ card: card('4000000000000119') });
    for (let i = 0; i < 6; i++) {
      await app.runWorker();
      app.clock.advance(20_000);
    }
    const p = (await get(res.body.id)).body;
    assert.equal(p.status, 'failed');
    assert.equal(p.failure.code, 'processing_error');
    const job = app.ctx.db.read(m.id, (d) => Object.values(d.jobs).find((j) => j.paymentId === p.id)!);
    assert.equal(job.attempts, 5);
    assert.equal(job.status, 'failed');
  });

  it('a card valid at tokenization but expired by processing time → expired_card', async () => {
    app.clock.set('2026-10-31T23:50:00.000Z');
    const tok = await app.api('POST', '/tokens', { key: m.pk, body: { card: card(undefined, { expMonth: 10, expYear: 2026 }) } });
    assert.equal(tok.status, 201);
    const res = await pay({ token: tok.body.id });
    app.clock.set('2026-11-01T00:05:00.000Z');
    await app.settle();
    const p = (await get(res.body.id)).body;
    app.clock.set('2026-10-15T09:00:00.000Z');
    assert.equal(p.status, 'failed');
    assert.equal(p.failure.code, 'expired_card');
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ['no card source', { card: undefined }, 'token'],
    ['two sources', { card: card(), token: 'tok_x' }, 'token'],
    ['saveCard with cardId', { cardId: 'card_x', saveCard: true, card: undefined }, 'saveCard'],
    ['amount 0', { amountMinor: 0, card: card() }, 'amountMinor'],
    ['amount -1', { amountMinor: -1, card: card() }, 'amountMinor'],
    ['amount 10.5', { amountMinor: 10.5, card: card() }, 'amountMinor'],
    ['amount as string', { amountMinor: '1000', card: card() }, 'amountMinor'],
    ['amount 100,000,000', { amountMinor: 100_000_000, card: card() }, 'amountMinor'],
    ['amount null', { amountMinor: null, card: card() }, 'amountMinor'],
    ['unsupported currency', { currency: 'XYZ', card: card() }, 'currency'],
    ['2-letter currency', { currency: 'US', card: card() }, 'currency'],
    ['numeric currency', { currency: 840, card: card() }, 'currency'],
    ['typo field captureMetod', { captureMetod: 'manual', card: card() }, 'captureMetod'],
    ['21 metadata keys', { card: card(), metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) }, 'metadata'],
    ['metadata key 41 chars', { card: card(), metadata: { ['k'.repeat(41)]: 'v' } }, `metadata.${'k'.repeat(41)}`],
    ['metadata value 501 chars', { card: card(), metadata: { k: 'v'.repeat(501) } }, 'metadata.k'],
    ['metadata number value', { card: card(), metadata: { k: 1 } }, 'metadata.k'],
    ['metadata null value on create', { card: card(), metadata: { k: null } }, 'metadata.k'],
    ['description 501 chars', { card: card(), description: 'd'.repeat(501) }, 'description'],
    ['invalid captureMethod', { card: card(), captureMethod: 'later' }, 'captureMethod'],
  ];
  for (const [label, body, field] of invalid) {
    it(`400: ${label}`, async () => {
      const res = await pay(body);
      assert.equal(res.status, 400, res.text);
      assert.ok(res.body.error.details.some((d: any) => d.field === field), JSON.stringify(res.body.error.details));
    });
  }

  it('the old field name "amount" → 400 explaining it was renamed to amountMinor (create, capture, refund)', async () => {
    const created = await app.api('POST', '/payments', { key: m.sk, body: { amount: 1000, currency: 'usd', card: card() } });
    assert.equal(created.status, 400);
    const hint = created.body.error.details.find((d: any) => d.field === 'amount');
    assert.match(hint.message, /renamed to amountMinor.*minor unit \(2500 = \$25\.00\)/);
    const p = await settled({ card: card(), captureMethod: 'manual' });
    for (const kind of ['capture', 'refund'] as const) {
      const res = await action(p.id, kind, { amount: 100 });
      assert.equal(res.status, 400, kind);
      assert.match(res.body.error.details[0].message, /renamed to amountMinor/);
    }
    const tok = await app.api('POST', '/tokens', { key: m.pk, body: { card: card(), amount: 5 } });
    assert.equal(tok.body.error.details[0].message, 'is not a recognized field', 'hint only where amount existed');
  });

  it('amountMinor is in minor units: 2500 USD stays 2500 (= $25.00), 2500 JPY stays 2500 (= ¥2500)', async () => {
    const usd = await pay({ amountMinor: 2500, currency: 'usd', card: card() });
    const jpy = await pay({ amountMinor: 2500, currency: 'jpy', card: card() });
    assert.equal(usd.body.amountMinor, 2500);
    assert.equal(jpy.body.amountMinor, 2500);
    assert.equal(jpy.body.currency, 'JPY');
  });

  it('boundary values accepted: amount 1 and 99,999,999; 20 metadata keys; 500-char description', async () => {
    for (const amount of [1, 99_999_999]) assert.equal((await pay({ amountMinor: amount, card: card() })).status, 202);
    const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(500)]));
    assert.equal((await pay({ card: card(), metadata: meta, description: 'd'.repeat(500) })).status, 202);
  });

  it('token sources: used token → 400; expired token → 400; another merchant’s token → 400', async () => {
    const tok = (await app.api('POST', '/tokens', { key: m.pk, body: { card: card() } })).body.id;
    assert.equal((await pay({ token: tok })).status, 202);
    assert.equal((await pay({ token: tok })).status, 400);
    const tok2 = (await app.api('POST', '/tokens', { key: m.pk, body: { card: card() } })).body.id;
    app.clock.advance(15 * 60_000 + 1);
    assert.equal((await pay({ token: tok2 })).status, 400);
    app.clock.set('2026-10-15T09:00:00.000Z');
    const other = await createMerchant(app);
    const foreign = (await app.api('POST', '/tokens', { key: other.pk, body: { card: card() } })).body.id;
    const res = await pay({ token: foreign });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].message, 'is invalid, expired or already used');
  });

  it('cardId of another merchant or unknown → 404', async () => {
    const other = await createMerchant(app);
    const theirs = await app.api('POST', '/cards', { key: other.sk, body: { card: card() } });
    assert.equal((await pay({ cardId: theirs.body.id })).status, 404);
    assert.equal((await pay({ cardId: 'card_00000000000000000000000000000000' })).status, 404);
  });

  it('publishable key cannot create payments (403)', async () => {
    assert.equal((await pay({ card: card() }, m.pk)).status, 403);
  });
});

describe('§3.6 card handling', () => {
  it('unsaved card is deleted after authorization (approved and declined)', async () => {
    const approved = await settled({ card: card() });
    const declined = await settled({ card: card('4000000000000002') });
    for (const p of [approved, declined]) {
      const sourceCardId = app.ctx.db.read(m.id, (d) => d.payments[p.id]!.sourceCardId);
      assert.equal(app.ctx.db.read(m.id, (d) => d.cards[sourceCardId]), undefined, p.status);
    }
  });

  it('saveCard + approval → card saved with customerId, paymentMethod.cardId set', async () => {
    const p = await settled({ card: card('5555555555554444'), saveCard: true, customerId: 'cus_save' });
    assert.equal(p.status, 'captured');
    assert.match(p.paymentMethod.cardId, /^card_/);
    const saved = await app.api('GET', `/cards/${p.paymentMethod.cardId}`, { key: m.sk });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.customerId, 'cus_save');
  });

  it('saveCard + decline → card NOT saved, cardId stays null', async () => {
    const p = await settled({ card: card('4000000000009995'), saveCard: true, customerId: 'cus_nosave' });
    assert.equal(p.status, 'failed');
    assert.equal(p.paymentMethod.cardId, null);
    assert.equal((await app.api('GET', '/cards?customerId=cus_nosave', { key: m.sk })).body.total, 0);
  });

  it('saveCard for a card this customer already saved → reuses the existing card (no duplicate)', async () => {
    const existing = await app.api('POST', '/cards', { key: m.sk, body: { card: card('6011111111111117'), customerId: 'cus_dupe_pay' } });
    const p = await settled({ card: card('6011111111111117'), saveCard: true, customerId: 'cus_dupe_pay' });
    assert.equal(p.paymentMethod.cardId, existing.body.id);
    assert.equal((await app.api('GET', '/cards?customerId=cus_dupe_pay', { key: m.sk })).body.total, 1);
  });

  it('paying with a saved card keeps it; DELETE while pending → 409, after authorization → 204', async () => {
    const saved = await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'cus_del_pending' } });
    const res = await pay({ cardId: saved.body.id });
    assert.equal(res.body.paymentMethod.cardId, saved.body.id);
    const blocked = await app.api('DELETE', `/cards/${saved.body.id}`, { key: m.sk });
    assert.equal(blocked.status, 409);
    await app.settle();
    assert.equal((await app.api('GET', `/cards/${saved.body.id}`, { key: m.sk })).status, 200, 'saved card survives authorization');
    assert.equal((await app.api('DELETE', `/cards/${saved.body.id}`, { key: m.sk })).status, 204);
    const after = (await get(res.body.id)).body;
    assert.equal(after.paymentMethod.last4, '4242', 'snapshot survives card deletion');
  });

  it('no CVC and no plain card number in the database file', async () => {
    const file = await readFile(app.ctx.config.dbFile, 'utf8');
    assert.ok(!/"cvc"/.test(file));
    assert.ok(!file.includes('4242424242424242'));
  });
});

describe('§3.6 amounts', () => {
  it('capture bounds: amount+1 → 400, 0 → 400, exact amount OK', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    assert.equal((await action(p.id, 'capture', { amountMinor: 1001 })).status, 400);
    assert.equal((await action(p.id, 'capture', { amountMinor: 0 })).status, 400);
    assert.equal((await action(p.id, 'capture', { amountMinor: 1000 })).status, 202);
  });

  it('refunds are bounded by the CAPTURED amount, not the authorized amount', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    await action(p.id, 'capture', { amountMinor: 600 });
    await app.settle();
    assert.equal((await get(p.id)).body.amountCapturedMinor, 600);
    const over = await action(p.id, 'refund', { amountMinor: 601 });
    assert.equal(over.status, 400);
    assert.match(over.body.error.details[0].message, /refundable amount \(600 in minor units\)/);
    assert.equal((await action(p.id, 'refund', { amountMinor: 600 })).status, 202);
    await app.settle();
    assert.equal((await get(p.id)).body.status, 'refunded');
  });

  it('running total: 300 + 300 + 400 of 1000 → partially, partially, refunded', async () => {
    const p = await settled({ card: card() });
    const statuses: string[] = [];
    for (const amount of [300, 300, 400]) {
      assert.equal((await action(p.id, 'refund', { amountMinor: amount })).status, 202);
      await app.settle();
      statuses.push((await get(p.id)).body.status);
    }
    assert.deepEqual(statuses, ['partially_refunded', 'partially_refunded', 'refunded']);
    assert.deepEqual(events(m.id, p.id).slice(-3), ['payment.partially_refunded', 'payment.partially_refunded', 'payment.refunded']);
  });

  it('no amount → full capture / remaining refund', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    await action(p.id, 'capture');
    await app.settle();
    await action(p.id, 'refund', { amountMinor: 250 });
    await app.settle();
    const rest = await action(p.id, 'refund');
    assert.equal(rest.body.pendingAction.amountMinor, 750);
    await app.settle();
    const done = (await get(p.id)).body;
    assert.equal(done.amountRefundedMinor, 1000);
    assert.equal(done.status, 'refunded');
  });

  it('second capture after a partial capture → 409', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    await action(p.id, 'capture', { amountMinor: 500 });
    await app.settle();
    assert.equal((await action(p.id, 'capture', { amountMinor: 100 })).status, 409);
  });

  it('action bodies: unknown field → 400; cancel with a body field → 400', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    assert.equal((await action(p.id, 'capture', { amountMinor: 100, reason: 'x' })).status, 400);
    assert.equal((await action(p.id, 'cancel', { amountMinor: 100 })).status, 400);
  });
});

describe('§3.6 concurrency', () => {
  it('10 simultaneous full refunds → exactly one 202, nine 409; never over-refunded', async () => {
    const p = await settled({ card: card() });
    const results = await Promise.all(Array.from({ length: 10 }, () => action(p.id, 'refund')));
    assert.deepEqual(results.map((r) => r.status).sort(), [202, ...Array(9).fill(409)]);
    await app.settle();
    const done = (await get(p.id)).body;
    assert.ok(done.amountRefundedMinor <= done.amountCapturedMinor);
    assert.equal(done.amountRefundedMinor, 1000);
  });

  it('refund while refunding → 409 invalid_state naming the status', async () => {
    const p = await settled({ card: card() });
    await action(p.id, 'refund', { amountMinor: 100 });
    const res = await action(p.id, 'refund', { amountMinor: 100 });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /refunding/);
  });
});

describe('§5.8 PATCH /payments/:id', () => {
  it('merges metadata (null deletes), updates description, emits payment.updated', async () => {
    const res = await pay({ card: card(), metadata: { orderId: '1', channel: 'web' } });
    const patched = await app.api('PATCH', `/payments/${res.body.id}`, { key: m.sk, body: { description: 'Gift', metadata: { channel: null, note: 'wrap' } } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.description, 'Gift');
    assert.deepEqual(patched.body.metadata, { orderId: '1', note: 'wrap' });
    assert.equal(patched.body.history.at(-1).type, 'updated');
    assert.ok(events(m.id, res.body.id).includes('payment.updated'));
  });

  it('a merge that would exceed 20 keys → 400 (cap cannot be bypassed by repeated merges)', async () => {
    const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v']));
    const res = await pay({ card: card(), metadata: meta });
    const patched = await app.api('PATCH', `/payments/${res.body.id}`, { key: m.sk, body: { metadata: { extra: 'v' } } });
    assert.equal(patched.status, 400);
    assert.equal(Object.keys((await get(res.body.id)).body.metadata).length, 20, 'unchanged');
  });

  it('empty body, amount or status → 400 naming the field; works in a terminal status', async () => {
    const p = await settled({ card: card('4000000000000002') });
    assert.equal(p.status, 'failed');
    assert.equal((await app.api('PATCH', `/payments/${p.id}`, { key: m.sk, body: {} })).status, 400);
    const bad = await app.api('PATCH', `/payments/${p.id}`, { key: m.sk, body: { amountMinor: 1, status: 'captured' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.map((d: any) => d.field).sort(), ['amountMinor', 'status']);
    assert.equal((await app.api('PATCH', `/payments/${p.id}`, { key: m.sk, body: { description: 'post-mortem' } })).status, 200);
  });
});

describe('§5.8 listing and isolation', () => {
  it('filters by status and customerId (combined filters intersect), newest first', async () => {
    const a = await settled({ card: card(), customerId: 'cus_list' });
    app.clock.advance(1000); // distinct createdAt: same-millisecond records are ordered by id, not by insertion
    const b = await settled({ card: card('4000000000000002'), customerId: 'cus_list' });
    const both = await app.api('GET', '/payments?customerId=cus_list', { key: m.sk });
    assert.equal(both.body.total, 2);
    assert.equal(both.body.data[0].id, b.id, 'newest first');
    const failed = await app.api('GET', '/payments?customerId=cus_list&status=failed', { key: m.sk });
    assert.deepEqual(failed.body.data.map((p: any) => p.id), [b.id]);
    assert.ok(a.id);
    assert.equal((await app.api('GET', '/payments?status=bogus', { key: m.sk })).status, 400);
  });

  it('another merchant gets 404 for every action on my payment, and never sees it in lists', async () => {
    const p = await settled({ card: card(), captureMethod: 'manual' });
    const other = await createMerchant(app);
    assert.equal((await get(p.id, other.sk)).status, 404);
    assert.equal((await app.api('PATCH', `/payments/${p.id}`, { key: other.sk, body: { description: 'x' } })).status, 404);
    for (const kind of ['capture', 'refund', 'cancel'] as const) assert.equal((await action(p.id, kind, undefined, other.sk)).status, 404, kind);
    assert.equal((await app.api('GET', '/payments', { key: other.sk })).body.total, 0);
    assert.equal((await get(p.id)).body.status, 'authorized', 'untouched');
  });
});

describe('§3.6 state machine (every status × every action)', () => {
  const ALLOWED: Record<string, string[]> = { authorized: ['capture', 'cancel'], captured: ['refund'], partially_refunded: ['refund'] };
  const statuses = ['pending', 'authorized', 'capturing', 'captured', 'refunding', 'partially_refunded', 'refunded', 'cancelling', 'cancelled', 'failed'] as const;

  for (const status of statuses) {
    for (const kind of ['capture', 'refund', 'cancel'] as const) {
      const allowed = ALLOWED[status]?.includes(kind) ?? false;
      it(`${status} × ${kind} → ${allowed ? '202' : '409'}`, async () => {
        const res = await pay({ card: card(), captureMethod: 'manual' });
        await app.ctx.db.transact(m.id, (d) => {
          const p = d.payments[res.body.id]!;
          for (const j of Object.values(d.jobs)) if (j.paymentId === p.id) j.status = 'succeeded';
          p.status = status;
          p.authorizationCode = 'AUTH42';
          p.amountCapturedMinor = ['captured', 'partially_refunded', 'refunded', 'refunding'].includes(status) ? 1000 : 0;
          p.amountRefundedMinor = status === 'partially_refunded' ? 400 : status === 'refunded' ? 1000 : 0;
          const transitional = ['pending', 'capturing', 'refunding', 'cancelling'].includes(status);
          p.pendingAction = transitional ? { type: 'capture', amountMinor: null, jobId: 'job_x', previousStatus: 'authorized', requestedAt: p.createdAt } : null;
        });
        const r = await action(res.body.id, kind);
        assert.equal(r.status, allowed ? 202 : 409, r.text);
        if (!allowed) {
          assert.equal(r.body.error.code, 'invalid_state');
          assert.match(r.body.error.message, new RegExp(status));
        }
      });
    }
  }
});
