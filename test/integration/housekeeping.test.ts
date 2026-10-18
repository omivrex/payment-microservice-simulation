import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createHousekeeping } from '../../src/workers/housekeeping.ts';
import type { BackgroundLoop } from '../../src/workers/background.ts';
import { DAY, HOUR, MINUTE } from '../helpers/fakeClock.ts';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { startReceiver } from '../helpers/receiver.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let m: TestMerchant;
let hk: BackgroundLoop;

beforeEach(async () => {
  app = await startTestApp({ config: { retentionDays: 7 } });
  m = await createMerchant(app);
  hk = createHousekeeping(app.ctx);
});
afterEach(() => app.close());

const data = () => app.ctx.db.read(m.id, (d) => d);
const tokenize = async () => (await app.api('POST', '/tokens', { key: m.pk, body: { card: card() } })).body.id as string;

describe('§2.7 retention', () => {
  it('unused expired token → token and its unsaved card deleted', async () => {
    const tok = await tokenize();
    const cardId = data().tokens[tok]!.cardId;
    app.clock.advance(15 * MINUTE + 1);
    await hk.tickOnce();
    assert.equal(data().tokens[tok], undefined);
    assert.equal(data().cards[cardId], undefined);
  });

  it('expired token whose card a PENDING payment still needs → card kept', async () => {
    const tok = await tokenize();
    const cardId = data().tokens[tok]!.cardId;
    const p = await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', token: tok } });
    assert.equal(p.status, 202);
    app.clock.advance(20 * MINUTE); // token expired, worker hasn't run
    await hk.tickOnce();
    assert.equal(data().tokens[tok], undefined, 'token record pruned');
    assert.ok(data().cards[cardId], 'card kept for the pending payment');
    await app.settle();
    assert.equal(data().payments[p.body.id]!.status, 'captured', 'payment still processes fine');
  });

  it('pending raw-card payment keeps its card', async () => {
    const p = await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', card: card() } });
    app.clock.advance(30 * DAY);
    await hk.tickOnce();
    assert.ok(data().cards[data().payments[p.body.id]!.sourceCardId]);
  });

  it('saved cards are never pruned', async () => {
    const saved = await app.api('POST', '/cards', { key: m.sk, body: { card: card() } });
    app.clock.advance(400 * DAY);
    await hk.tickOnce();
    assert.ok(data().cards[saved.body.id]);
  });

  it('finished jobs older than RETENTION_DAYS are deleted; queued/running jobs of any age are kept', async () => {
    const done = await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', card: card() } });
    await app.settle();
    const queued = await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', card: card() } });
    app.clock.advance(7 * DAY + HOUR);
    await hk.tickOnce();
    const jobs = Object.values(data().jobs);
    assert.ok(!jobs.some((j) => j.paymentId === done.body.id), 'completed jobs pruned');
    assert.ok(jobs.some((j) => j.paymentId === queued.body.id && j.status === 'queued'), 'queued job kept');
    assert.ok(data().payments[done.body.id], 'payment itself never pruned');
  });

  it('jobs completed within the retention window are kept', async () => {
    await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', card: card() } });
    await app.settle();
    app.clock.advance(6 * DAY);
    await hk.tickOnce();
    assert.equal(Object.values(data().jobs).length, 2);
  });

  it('finished deliveries and old events are deleted; pending deliveries and their events are kept', async () => {
    const ok = await startReceiver(() => ({ status: 200 }));
    const failing = await startReceiver(() => ({ status: 500 }));
    try {
      await app.api('POST', '/webhooks', { key: m.sk, body: { url: ok.url(), events: ['payment.created'] } });
      const bad = await app.api('POST', '/webhooks', { key: m.sk, body: { url: failing.url(), events: ['payment.created'] } });
      await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 100, currency: 'usd', card: card() } });
      await app.runDispatcher();
      app.clock.advance(8 * DAY);
      await hk.tickOnce();
      const deliveries = Object.values(data().webhookDeliveries);
      assert.equal(deliveries.length, 1, 'succeeded delivery pruned, pending one kept');
      assert.equal(deliveries[0]!.endpointId, bad.body.id);
      assert.ok(data().events[deliveries[0]!.eventId], 'event of the pending delivery kept');
      assert.ok(data().webhookEndpoints[bad.body.id], 'endpoints never pruned');
    } finally {
      await ok.close();
      await failing.close();
    }
  });

  it('idempotency records past 24 h are deleted and the key works again', async () => {
    const headers = { 'idempotency-key': 'hk-1' };
    await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'c1' }, headers });
    app.clock.advance(DAY + MINUTE);
    await hk.tickOnce();
    assert.equal(Object.keys(data().idempotency).length, 0);
    const again = await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'c1' }, headers });
    assert.equal(again.headers.get('idempotent-replayed'), null);
  });

  it('merchants and API keys are never pruned', async () => {
    app.clock.advance(1000 * DAY);
    await hk.tickOnce();
    assert.equal((await app.api('GET', '/merchants/me', { key: m.sk })).status, 200);
  });

  it('a pass with nothing to prune does not write the file', async () => {
    await hk.tickOnce();
    const before = (await stat(app.ctx.config.dbFile)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await hk.tickOnce();
    assert.equal((await stat(app.ctx.config.dbFile)).mtimeMs, before);
  });
});
