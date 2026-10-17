import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonDb } from '../src/db/jsonDb.ts';
import { emptyDatabase, emptyMerchantData, type Payment } from '../src/db/schema.ts';
import { createLogger } from '../src/logging/logger.ts';

/**
 * yarn bench:db — measures JsonDb commit time as data grows (docs/07-persistence.md §7.9).
 * Worst case modelled: one heavy merchant holding everything, each payment with
 * 2 jobs and 3 events still inside the retention window.
 */

const SIZES = (process.argv[2] ?? '1000,10000,50000').split(',').map(Number);
const COMMITS = 20;
const logger = createLogger({ level: 'error' });
const iso = new Date().toISOString();

function payment(i: number): Payment {
  const id = `pay_${i.toString(16).padStart(32, '0')}`;
  return {
    id,
    merchantId: 'mer_bench',
    status: 'captured',
    amount: 2500,
    currency: 'USD',
    captureMethod: 'automatic',
    amountCaptured: 2500,
    amountRefunded: 0,
    customerId: `cus_${i % 500}`,
    description: `Order #${i}`,
    metadata: { orderId: String(i), channel: 'web' },
    paymentMethod: { type: 'card', cardId: null, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
    sourceCardId: `card_${i}`,
    saveCardOnApproval: false,
    authorizationCode: 'A1B2C3',
    failure: null,
    pendingAction: null,
    history: [
      { type: 'created', at: iso },
      { type: 'authorized', at: iso, amount: 2500 },
      { type: 'captured', at: iso, amount: 2500 },
    ],
    createdAt: iso,
    updatedAt: iso,
  };
}

console.log('payments | file size | open (ms) | commit avg (ms) | commit p95 (ms) | max commits/s | heap used');
console.log('---------|-----------|-----------|-----------------|-----------------|---------------|----------');

for (const n of SIZES) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-db-'));
  const file = path.join(dir, 'db.json');
  const doc = emptyDatabase();
  const md = emptyMerchantData();
  for (let i = 0; i < n; i++) {
    const p = payment(i);
    md.payments[p.id] = p;
    for (let j = 0; j < 2; j++) {
      const jobId = `job_${i}_${j}`;
      md.jobs[jobId] = { id: jobId, merchantId: 'mer_bench', paymentId: p.id, type: j ? 'capture' : 'authorize', amount: 2500, status: 'succeeded', attempts: 1, maxAttempts: 5, runAt: iso, lockedUntil: null, lastError: null, requestId: null, createdAt: iso, updatedAt: iso, completedAt: iso };
    }
    for (const type of ['payment.created', 'payment.authorized', 'payment.captured'] as const) {
      const evtId = `evt_${i}_${type}`;
      md.events[evtId] = { id: evtId, merchantId: 'mer_bench', type, data: { object: p as unknown as Record<string, unknown> }, createdAt: iso };
    }
  }
  doc.merchants.mer_bench = md;
  await writeFile(file, JSON.stringify(doc));
  const size = (await stat(file)).size;

  global.gc?.();
  const t0 = performance.now();
  const db = await JsonDb.open({ file, warnSizeMb: 100_000, logger });
  const openMs = performance.now() - t0;

  const times: number[] = [];
  for (let c = 0; c < COMMITS; c++) {
    const start = performance.now();
    await db.transact('mer_bench', (d) => {
      d.payments[`pay_${(c % n).toString(16).padStart(32, '0')}`]!.metadata.touched = randomBytes(4).toString('hex');
    });
    times.push(performance.now() - start);
  }
  const heap = process.memoryUsage().heapUsed;
  await db.close();
  await rm(dir, { recursive: true, force: true });

  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95) - 1] ?? times.at(-1)!;
  console.log(
    `${String(n).padStart(8)} | ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB | ${openMs.toFixed(0).padStart(9)} | ${avg.toFixed(1).padStart(15)} | ${p95.toFixed(1).padStart(15)} | ${(1000 / avg).toFixed(0).padStart(13)} | ${(heap / 1024 / 1024).toFixed(0)} MB`,
  );
}
