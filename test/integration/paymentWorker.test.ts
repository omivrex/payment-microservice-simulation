import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Encryptor } from '../../src/crypto/encryption.ts';
import { Hasher } from '../../src/crypto/hashing.ts';
import { JsonDb } from '../../src/db/jsonDb.ts';
import { createLogger } from '../../src/logging/logger.ts';
import { createServices } from '../../src/services.ts';
import { createPaymentWorker, retryDelayMs } from '../../src/workers/paymentWorker.ts';
import { testConfig } from '../helpers/config.ts';
import { FakeClock, SECOND } from '../helpers/fakeClock.ts';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { crash, declined, ScriptedProcessor, transient } from '../helpers/scriptedProcessor.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let proc: ScriptedProcessor;
let m: TestMerchant;

beforeEach(async () => {
  proc = new ScriptedProcessor();
  app = await startTestApp({ processor: proc, config: { workerConcurrency: 5 } });
  m = await createMerchant(app);
});
afterEach(() => app.close());

const pay = async (body: Record<string, unknown> = {}) => {
  const res = await app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 1000, currency: 'usd', card: card(), ...body } });
  assert.equal(res.status, 202, res.text);
  return res.body.id as string;
};
const payment = (id: string) => app.ctx.db.read(m.id, (d) => d.payments[id]!);
const jobsOf = (id: string) => app.ctx.db.read(m.id, (d) => Object.values(d.jobs).filter((j) => j.paymentId === id));
const eventTypes = (id: string) =>
  app.ctx.db.read(m.id, (d) => Object.values(d.events).filter((e) => (e.data.object as any).id === id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((e) => e.type));

describe('§3.6 retries and backoff', () => {
  it('transient errors retry at exactly +2 s, +4 s, +8 s, +16 s and not before', async () => {
    proc.script('authorize', transient(), transient(), transient(), transient());
    const id = await pay({ captureMethod: 'manual' });
    await app.runWorker();
    for (const delay of [2, 4, 8, 16]) {
      const job = jobsOf(id)[0]!;
      assert.equal(job.status, 'queued');
      assert.equal(Date.parse(job.runAt) - app.clock.now().getTime(), delay * SECOND, `delay before next attempt`);
      app.clock.advance(delay * SECOND - 1);
      await app.runWorker();
      assert.equal(jobsOf(id)[0]!.attempts, proc.calls.length, 'not retried early');
      app.clock.advance(1);
      await app.runWorker();
    }
    assert.equal(proc.calls.length, 5);
    assert.equal(payment(id).status, 'authorized', '5th attempt succeeded');
  });

  it('retryDelayMs follows 2^attempts seconds', () => {
    assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [2000, 4000, 8000, 16000]);
  });

  it('5 transient errors on authorize → failed processing_error + payment.failed', async () => {
    proc.script('authorize', ...Array.from({ length: 5 }, () => transient()));
    const id = await pay();
    for (let i = 0; i < 5; i++) {
      await app.runWorker();
      app.clock.advance(20 * SECOND);
    }
    assert.equal(payment(id).status, 'failed');
    assert.equal(payment(id).failure?.code, 'processing_error');
    assert.equal(jobsOf(id)[0]!.status, 'failed');
    assert.deepEqual(eventTypes(id), ['payment.created', 'payment.failed']);
  });

  it('decline is not retried (exactly one processor call)', async () => {
    proc.script('authorize', declined('insufficient_funds'));
    const id = await pay();
    await app.settle();
    app.clock.advance(60 * SECOND);
    await app.settle();
    assert.equal(proc.calls.length, 1);
    assert.equal(payment(id).failure?.code, 'insufficient_funds');
  });
});

describe('§3.6 reverting failed actions', () => {
  it('capture fails permanently → back to authorized + payment.action_failed with the reason', async () => {
    const id = await pay({ captureMethod: 'manual' });
    await app.settle();
    proc.script('capture', ...Array.from({ length: 5 }, () => transient('gateway_timeout')));
    await app.api('POST', `/payments/${id}/capture`, { key: m.sk });
    for (let i = 0; i < 5; i++) {
      await app.runWorker();
      app.clock.advance(20 * SECOND);
    }
    const p = payment(id);
    assert.equal(p.status, 'authorized');
    assert.equal(p.pendingAction, null);
    assert.equal(p.amountCapturedMinor, 0);
    assert.equal(p.history.at(-1)?.type, 'capture_failed');
    const evt = app.ctx.db.read(m.id, (d) => Object.values(d.events).find((e) => e.type === 'payment.action_failed')!);
    assert.deepEqual(evt.data.action, { type: 'capture', code: 'gateway_timeout', message: 'temporarily unavailable' });
    const retry = await app.api('POST', `/payments/${id}/capture`, { key: m.sk });
    assert.equal(retry.status, 202, 'merchant can try again');
  });

  it('refund fails permanently from partially_refunded → back to partially_refunded precisely', async () => {
    const id = await pay();
    await app.settle();
    await app.api('POST', `/payments/${id}/refund`, { key: m.sk, body: { amountMinor: 300 } });
    await app.settle();
    assert.equal(payment(id).status, 'partially_refunded');
    proc.script('refund', ...Array.from({ length: 5 }, () => transient()));
    await app.api('POST', `/payments/${id}/refund`, { key: m.sk, body: { amountMinor: 200 } });
    for (let i = 0; i < 5; i++) {
      await app.runWorker();
      app.clock.advance(20 * SECOND);
    }
    assert.equal(payment(id).status, 'partially_refunded');
    assert.equal(payment(id).amountRefundedMinor, 300, 'failed refund not counted');
  });

  it('cancel fails permanently → back to authorized', async () => {
    const id = await pay({ captureMethod: 'manual' });
    await app.settle();
    proc.script('cancel', ...Array.from({ length: 5 }, () => transient()));
    await app.api('POST', `/payments/${id}/cancel`, { key: m.sk });
    for (let i = 0; i < 5; i++) {
      await app.runWorker();
      app.clock.advance(20 * SECOND);
    }
    assert.equal(payment(id).status, 'authorized');
  });
});

describe('§3.6 leases and stale results', () => {
  it('a run that never finishes is reclaimed after 30 s; the late result is discarded (applied once)', async () => {
    proc.blocking = true;
    const id = await pay({ captureMethod: 'manual' });
    await app.worker.tickOnce(); // run #1 claims and blocks
    assert.equal(proc.inFlight, 1);
    app.clock.advance(31 * SECOND);
    await app.worker.tickOnce(); // lease expired → run #2 reclaims and blocks
    assert.equal(proc.inFlight, 2);
    assert.equal(jobsOf(id)[0]!.attempts, 2);
    proc.release();
    await app.worker.whenIdle();
    const p = payment(id);
    assert.equal(p.status, 'authorized');
    assert.equal(p.history.filter((h) => h.type === 'authorized').length, 1, 'transition applied exactly once');
    assert.deepEqual(eventTypes(id), ['payment.created', 'payment.authorized']);
  });

  it('a job whose lease has not expired is not claimed twice', async () => {
    proc.blocking = true;
    await pay();
    await app.worker.tickOnce();
    app.clock.advance(29 * SECOND);
    await app.worker.tickOnce();
    assert.equal(proc.calls.length, 1);
    proc.release();
    await app.worker.whenIdle();
  });
});

describe('§3.6 concurrency limit', () => {
  it('20 due jobs, WORKER_CONCURRENCY=5 → never more than 5 processor calls in flight', async () => {
    proc.blocking = true;
    for (let i = 0; i < 20; i++) await pay({ captureMethod: 'manual' });
    await app.worker.tickOnce();
    assert.equal(proc.inFlight, 5);
    await app.worker.tickOnce(); // no free slots → claims nothing
    assert.equal(proc.inFlight, 5);
    for (let round = 0; round < 10 && proc.calls.length < 20; round++) {
      proc.release();
      await new Promise((r) => setTimeout(r, 5));
      await app.worker.tickOnce();
    }
    proc.blocking = false;
    proc.release();
    await app.settle();
    assert.equal(proc.maxInFlight, 5);
    const authorized = app.ctx.db.read(m.id, (d) => Object.values(d.payments).filter((p) => p.status === 'authorized').length);
    assert.equal(authorized, 20);
  });

  it('concurrent tickOnce() calls share one tick (no double claiming)', async () => {
    for (let i = 0; i < 3; i++) await pay({ captureMethod: 'manual' });
    await Promise.all([app.worker.tickOnce(), app.worker.tickOnce(), app.worker.tickOnce()]);
    await app.worker.whenIdle();
    assert.equal(proc.calls.length, 3);
  });
});

describe('§8.8 errors inside jobs', () => {
  it('a crashing job handler is retried like a transient error; other jobs in the same tick complete', async () => {
    proc.script('authorize', crash(), { outcome: 'success', authorizationCode: 'OK0001' });
    const bad = await pay({ captureMethod: 'manual' });
    const good = await pay({ captureMethod: 'manual' });
    await app.runWorker();
    const statuses = [payment(bad).status, payment(good).status].sort();
    assert.deepEqual(statuses, ['authorized', 'pending'], 'one crashed and was requeued, the other completed');
    app.clock.advance(5 * SECOND);
    await app.settle();
    assert.equal(payment(bad).status, 'authorized');
    assert.equal(payment(good).status, 'authorized');
  });

  it('decryption failure (tampered card) → no retry, failed with generic processing_error', async () => {
    const id = await pay();
    await app.ctx.db.transact(m.id, (d) => {
      const c = d.cards[d.payments[id]!.sourceCardId]!;
      c.numberEncrypted = c.numberEncrypted!.replace(/:([A-Za-z0-9+/]{4})/, ':AAAA');
    });
    await app.settle();
    app.clock.advance(60 * SECOND);
    await app.settle();
    assert.equal(proc.calls.length, 0, 'processor never called');
    assert.equal(payment(id).status, 'failed');
    assert.equal(payment(id).failure?.code, 'processing_error');
    assert.equal(jobsOf(id)[0]!.attempts, 1);
  });

  it('the card disappearing before authorization → failed processing_error (no retry)', async () => {
    const id = await pay();
    await app.ctx.db.transact(m.id, (d) => {
      delete d.cards[d.payments[id]!.sourceCardId];
    });
    await app.settle();
    assert.equal(payment(id).status, 'failed');
    assert.equal(jobsOf(id)[0]!.attempts, 1);
  });
});

describe('§3.6 recovery across restarts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'worker-restart-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('queued jobs in the database file are processed after a restart', async () => {
    const config = testConfig({ dbFile: path.join(dir, 'db.json') });
    const logger = createLogger({ level: 'debug' });
    const clock = new FakeClock();
    const build = async () => {
      const db = await JsonDb.open({ file: config.dbFile, warnSizeMb: 20, logger });
      const ctx = { config, db, logger, clock, encryptor: new Encryptor(config.encryptionKeys, config.encryptionActiveKeyId), hasher: new Hasher(config.hashingSecret) };
      return { ctx, services: createServices(ctx) };
    };

    const first = await build();
    const merchantId = 'mer_restart';
    const created = await first.services.payments.create(
      merchantId,
      { amountMinor: 500, currency: 'USD', source: { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123' } }, saveCard: false, customerId: null, captureMethod: 'manual', description: null, metadata: {} },
      null,
    );
    await first.ctx.db.close(); // "crash" before any worker ran

    const second = await build();
    const scripted = new ScriptedProcessor();
    const worker = createPaymentWorker(second.ctx, second.services, scripted);
    await worker.tickOnce();
    await worker.whenIdle();
    assert.equal(second.ctx.db.read(merchantId, (d) => d.payments[created.id]!.status), 'authorized');
    await worker.stop();
    await second.ctx.db.close();
  });
});

describe('§3.4 processor time limit and giving up on reclaimed leases', () => {
  // These tests use a short real-time limit; leases use the fake clock.
  let tApp: TestApp;
  let tProc: ScriptedProcessor;
  let tm: TestMerchant;
  const TIMEOUT = 150;

  beforeEach(async () => {
    tProc = new ScriptedProcessor();
    tApp = await startTestApp({ processor: tProc, config: { workerConcurrency: 2, processorTimeoutMs: TIMEOUT } });
    tm = await createMerchant(tApp);
  });
  afterEach(async () => {
    tProc.blocking = false;
    tProc.release();
    await tApp.close();
  });

  const tPay = async (body: Record<string, unknown> = {}) =>
    (await tApp.api('POST', '/payments', { key: tm.sk, body: { amountMinor: 1000, currency: 'usd', card: card(), captureMethod: 'manual', ...body } })).body.id as string;
  const tPayment = (id: string) => tApp.ctx.db.read(tm.id, (d) => d.payments[id]!);
  const tJob = (id: string, type = 'authorize') => tApp.ctx.db.read(tm.id, (d) => Object.values(d.jobs).find((j) => j.paymentId === id && j.type === type)!);

  it('a hung call is abandoned at the time limit: the slot is freed, the job is requeued, other payments proceed', async () => {
    tProc.blocking = true; // calls never answer, and ignore the abort signal (worst case)
    const ids = [await tPay(), await tPay(), await tPay()];
    const started = Date.now();
    await tApp.runWorker(); // claims 2 (concurrency 2); both hang, then time out
    assert.ok(Date.now() - started < TIMEOUT * 10, 'did not wait forever');
    assert.equal(tProc.inFlight, 2, 'the processor calls themselves are still hung');
    for (const id of ids.slice(0, 2)) {
      const job = tJob(id);
      assert.equal(job.status, 'queued', 'requeued, not stuck as running');
      assert.equal(job.lastError, 'processor_timeout');
      assert.equal(job.lockedUntil, null, 'lease released');
    }
    tProc.blocking = false;
    await tApp.runWorker(); // slots are free again: the third payment is claimed
    assert.equal(tPayment(ids[2]!).status, 'authorized', 'other payments are not blocked by hung calls');
  });

  it('the database stays writable while processor calls hang', async () => {
    tProc.blocking = true;
    const id = await tPay();
    await tApp.worker.tickOnce();
    const t0 = Date.now();
    const created = await tApp.api('POST', '/payments', { key: tm.sk, body: { amountMinor: 1, currency: 'usd', card: card() } });
    const patched = await tApp.api('PATCH', `/payments/${id}`, { key: tm.sk, body: { description: 'during hang' } });
    assert.equal(created.status, 202);
    assert.equal(patched.status, 200);
    assert.ok(Date.now() - t0 < 1000, 'writes are not blocked by the hung call');
    await tApp.worker.whenIdle();
  });

  it('retries are not refused: after a timeout the job runs again (backoff) and can succeed', async () => {
    tProc.blocking = true;
    const id = await tPay();
    await tApp.runWorker();
    assert.equal(tJob(id).attempts, 1);
    tProc.blocking = false;
    tApp.clock.advance(2000); // backoff after attempt 1
    await tApp.runWorker();
    assert.equal(tJob(id).attempts, 2);
    assert.equal(tPayment(id).status, 'authorized');
  });

  it('every attempt times out → after maxAttempts the payment fails (processing_error), never retried forever', async () => {
    tProc.blocking = true;
    const id = await tPay();
    for (let i = 0; i < 7; i++) {
      await tApp.runWorker();
      tApp.clock.advance(20_000);
    }
    const job = tJob(id);
    assert.equal(job.attempts, 5);
    assert.equal(job.status, 'failed');
    assert.equal(tPayment(id).status, 'failed');
    assert.equal(tPayment(id).failure?.code, 'processing_error');
    assert.equal(tProc.calls.length, 5, 'exactly maxAttempts calls');
  });

  it('a capture whose every attempt times out → reverted to authorized with payment.action_failed (processor_timeout)', async () => {
    const id = await tPay();
    await tApp.runWorker();
    await tApp.api('POST', `/payments/${id}/capture`, { key: tm.sk });
    tProc.blocking = true;
    for (let i = 0; i < 7; i++) {
      await tApp.runWorker();
      tApp.clock.advance(20_000);
    }
    assert.equal(tPayment(id).status, 'authorized');
    assert.equal(tJob(id, 'capture').status, 'failed');
    const evt = tApp.ctx.db.read(tm.id, (d) => Object.values(d.events).find((e) => e.type === 'payment.action_failed')!);
    assert.equal(evt.data.action?.code, 'processor_timeout');
  });

  it('lease expired on the FINAL attempt → given up (not reclaimed), even while every slot is busy', async () => {
    tProc.blocking = true;
    const stuck = await tPay();
    // Simulate a process that died during the 5th (last) attempt: running, lease expired, attempts = max.
    await tApp.ctx.db.transact(tm.id, (d) => {
      const job = Object.values(d.jobs).find((j) => j.paymentId === stuck)!;
      Object.assign(job, { status: 'running', attempts: job.maxAttempts, lockedUntil: new Date(tApp.clock.now().getTime() - 1000).toISOString() });
    });
    // Fill both slots with hung calls from other payments.
    await tPay();
    await tPay();
    await tApp.worker.tickOnce();
    tApp.clock.advance(1000);
    await tApp.worker.tickOnce(); // slots are full, but the give-up check doesn't need one
    const job = tJob(stuck);
    assert.equal(job.status, 'failed');
    assert.equal(job.lastError, 'lease expired on the final attempt');
    assert.equal(job.attempts, 5, 'not incremented past maxAttempts');
    assert.equal(tPayment(stuck).status, 'failed');
    assert.ok(!tProc.calls.some((c) => c.reference === job.id), 'never sent to the processor again');
    tProc.blocking = false;
    tProc.release();
    await tApp.worker.whenIdle();
  });

  it('a capture whose lease expired on the final attempt → reverted to authorized, not stuck in capturing', async () => {
    const id = await tPay();
    await tApp.runWorker();
    await tApp.api('POST', `/payments/${id}/capture`, { key: tm.sk });
    await tApp.ctx.db.transact(tm.id, (d) => {
      const job = Object.values(d.jobs).find((j) => j.paymentId === id && j.type === 'capture')!;
      Object.assign(job, { status: 'running', attempts: job.maxAttempts, lockedUntil: new Date(tApp.clock.now().getTime() - 1).toISOString() });
    });
    await tApp.worker.tickOnce();
    assert.equal(tPayment(id).status, 'authorized');
    assert.equal(tPayment(id).pendingAction, null);
    assert.equal((await tApp.api('POST', `/payments/${id}/capture`, { key: tm.sk })).status, 202, 'the merchant can try again');
  });

  it('a late answer arriving after the time limit is ignored (no double transition)', async () => {
    tProc.blocking = true;
    const id = await tPay();
    await tApp.runWorker(); // times out, requeued
    tProc.blocking = false;
    tApp.clock.advance(2000);
    await tApp.runWorker(); // attempt 2 succeeds → authorized
    tProc.release(); // attempt 1's hung call finally answers
    await new Promise((r) => setTimeout(r, 20));
    const p = tPayment(id);
    assert.equal(p.status, 'authorized');
    assert.equal(p.history.filter((h) => h.type === 'authorized').length, 1);
  });
});

describe('§3.5 simulated processor honours the abort signal', () => {
  it('stops waiting as soon as the call is aborted', async () => {
    const { createSimulatedProcessor } = await import('../../src/processor/simulatedProcessor.ts');
    const sim = createSimulatedProcessor({ latencyMs: 5000, failureRate: 0, clock: new FakeClock() });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await assert.rejects(sim.capture({ reference: 'job_1', authorizationCode: 'A', amountMinor: 1, signal: controller.signal }));
    assert.ok(Date.now() - started < 1000);
  });
});
