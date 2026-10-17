import { addMs, isoNow } from '../clock.js';
import type { Card, Job, MerchantData, Payment } from '../db/schema.js';
import { SecurityError } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { recordEvent } from '../modules/events/outbox.js';
import { newJob } from '../modules/payments/service.js';
import { toPaymentView } from '../modules/payments/view.js';
import type { Processor, ProcessorResult } from '../processor/processor.js';
import type { AppContext } from '../app.js';
import type { Services } from '../services.js';
import { createPollingLoop, type BackgroundLoop } from './background.js';

/**
 * The payment worker: claims due jobs, calls the processor outside any
 * transaction, then applies the result. See docs/03-payment-lifecycle.md §3.4
 * and docs/08-error-handling.md §8.8.
 */

export const WORKER_INTERVAL_MS = 500;
export const LEASE_MS = 30_000;

interface Claimed {
  merchantId: string;
  job: Job;
  payment: Payment;
  card: Card | null;
}

type Outcome =
  | { kind: 'success'; authorizationCode?: string }
  | { kind: 'declined'; code: string; message: string }
  | { kind: 'transient'; code: string; message: string; bug?: unknown }
  | { kind: 'permanent'; code: string; message: string; security?: boolean; err?: unknown };

export const retryDelayMs = (attemptsMade: number): number => 2 ** attemptsMade * 1000;

export function createPaymentWorker(ctx: AppContext, services: Services, processor: Processor): BackgroundLoop {
  const { db, clock } = ctx;
  const inFlight = new Set<Promise<void>>();
  const log = ctx.logger.child({ loop: 'payment-worker' });

  const isDue = (job: Job, now: string): boolean =>
    (job.status === 'queued' && job.runAt <= now) || (job.status === 'running' && job.lockedUntil !== null && job.lockedUntil < now);

  async function tick(): Promise<void> {
    const free = ctx.config.workerConcurrency - inFlight.size;
    if (free <= 0) return;
    const now = isoNow(clock);
    const due = db
      .scanMerchants((merchantId, d) => Object.values(d.jobs).filter((j) => isDue(j, now)).map((j) => ({ merchantId, id: j.id, runAt: j.runAt })))
      .sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : 0))
      .slice(0, free);

    // One claim transaction per merchant (transactions never span scopes).
    const byMerchant = new Map<string, string[]>();
    for (const { merchantId, id } of due) byMerchant.set(merchantId, [...(byMerchant.get(merchantId) ?? []), id]);

    for (const [merchantId, ids] of byMerchant) {
      const claimed = await db.transact(merchantId, (d) => {
        const out: Claimed[] = [];
        for (const id of ids) {
          const job = d.jobs[id];
          if (!job || !isDue(job, now)) continue; // changed since the scan
          const payment = d.payments[job.paymentId];
          if (!payment) {
            Object.assign(job, { status: 'failed', lastError: 'payment not found', completedAt: now, updatedAt: now, lockedUntil: null });
            continue;
          }
          Object.assign(job, { status: 'running', attempts: job.attempts + 1, lockedUntil: addMs(now, LEASE_MS), updatedAt: now });
          out.push({ merchantId, job: structuredClone(job), payment: structuredClone(payment), card: structuredClone(d.cards[payment.sourceCardId] ?? null) });
        }
        return out;
      });
      for (const c of claimed) {
        const run = runJob(c).finally(() => inFlight.delete(run));
        inFlight.add(run);
      }
    }
  }

  async function runJob(c: Claimed): Promise<void> {
    const jobLog = log.child({ jobId: c.job.id, jobType: c.job.type, paymentId: c.payment.id, merchantId: c.merchantId, attempt: c.job.attempts, requestId: c.job.requestId ?? undefined });
    let outcome: Outcome;
    try {
      outcome = fromResult(await callProcessor(c));
    } catch (err) {
      if (err instanceof SecurityError) {
        outcome = { kind: 'permanent', code: 'processing_error', message: 'The payment could not be processed.', security: true, err };
      } else if (err instanceof CardUnavailableError) {
        outcome = { kind: 'permanent', code: 'processing_error', message: 'The payment could not be processed.', err };
      } else {
        outcome = { kind: 'transient', code: 'processing_error', message: 'The payment could not be processed.', bug: err };
      }
    }

    if (outcome.kind === 'transient') {
      if (outcome.bug !== undefined) jobLog.error('job handler crashed', { err: outcome.bug });
      else jobLog.warn('processor transient error', { code: outcome.code });
    } else if (outcome.kind === 'permanent') {
      jobLog.error('job failed permanently', { code: outcome.code, err: outcome.err, ...(outcome.security ? { security: true } : {}) });
    }

    try {
      const applied = await db.transact(c.merchantId, (d) => apply(d, c, outcome));
      if (!applied) jobLog.warn('stale job result discarded (lease expired and job was reclaimed)');
      else if (applied === 'gave_up') jobLog.error('job failed permanently after retries', { code: outcome.kind === 'transient' ? outcome.code : undefined });
      else jobLog.info('job processed', { result: applied });
    } catch (err) {
      // e.g. storage failure: the lease will expire and the job will be retried.
      jobLog.error('could not apply job result', { err });
    }
  }

  async function callProcessor(c: Claimed): Promise<ProcessorResult<{ authorizationCode?: string }>> {
    const reference = c.job.id;
    if (c.job.type === 'authorize') {
      if (!c.card || !c.card.numberEncrypted) throw new CardUnavailableError();
      const cardNumber = services.vault.decryptNumber(c.card);
      return processor.authorize({ reference, cardNumber, expMonth: c.card.expMonth, expYear: c.card.expYear, amount: c.payment.amount, currency: c.payment.currency });
    }
    const authorizationCode = c.payment.authorizationCode ?? '';
    if (c.job.type === 'capture') return processor.capture({ reference, authorizationCode, amount: c.job.amount ?? c.payment.amount });
    if (c.job.type === 'refund') return processor.refund({ reference, authorizationCode, amount: c.job.amount ?? 0 });
    return processor.cancel({ reference, authorizationCode });
  }

  /** Applies an outcome. Returns false if this run no longer owns the job (stale result). */
  function apply(d: MerchantData, c: Claimed, outcome: Outcome): false | 'success' | 'declined' | 'retry' | 'gave_up' | 'failed' {
    const now = isoNow(clock);
    const job = d.jobs[c.job.id];
    const p = d.payments[c.payment.id];
    if (!job || job.status !== 'running' || job.attempts !== c.job.attempts || job.lockedUntil !== c.job.lockedUntil || !p) return false;

    const finishJob = (status: 'succeeded' | 'failed', lastError: string | null = null) =>
      Object.assign(job, { status, lastError, lockedUntil: null, completedAt: now, updatedAt: now });

    if (outcome.kind === 'transient' && job.attempts < job.maxAttempts) {
      Object.assign(job, { status: 'queued', runAt: addMs(now, retryDelayMs(job.attempts)), lockedUntil: null, lastError: outcome.code, updatedAt: now });
      return 'retry';
    }

    const touch = () => (p.updatedAt = now);
    const emit = (type: Parameters<typeof recordEvent>[2], extra?: Parameters<typeof recordEvent>[5]) =>
      recordEvent(d, c.merchantId, type, toPaymentView(p) as never, now, extra);

    if (job.type === 'authorize') {
      if (outcome.kind === 'success') {
        p.authorizationCode = outcome.authorizationCode ?? null;
        p.history.push({ type: 'authorized', at: now, amount: p.amount });
        settleCardAfterAuthorization(d, p, true);
        if (p.captureMethod === 'automatic') {
          const capture = newJob(c.merchantId, p.id, 'capture', p.amount, now, job.requestId);
          d.jobs[capture.id] = capture;
          p.status = 'capturing';
          p.pendingAction = { type: 'capture', amount: p.amount, jobId: capture.id, previousStatus: 'authorized', requestedAt: now };
        } else {
          p.status = 'authorized';
          p.pendingAction = null;
        }
        touch();
        emit('payment.authorized');
        finishJob('succeeded');
        return 'success';
      }
      // Declined, permanently failed, or out of retries.
      const failure = outcome.kind === 'declined' ? outcome : { code: 'processing_error', message: 'The payment could not be processed.' };
      p.status = 'failed';
      p.failure = { code: failure.code, message: failure.message };
      p.pendingAction = null;
      p.history.push({ type: 'failed', at: now, code: failure.code });
      settleCardAfterAuthorization(d, p, false);
      touch();
      emit('payment.failed');
      if (outcome.kind === 'declined') {
        finishJob('succeeded');
        return 'declined';
      }
      finishJob('failed', failure.code);
      return outcome.kind === 'transient' ? 'gave_up' : 'failed';
    }

    // capture / refund / cancel
    if (outcome.kind === 'success') {
      const amount = job.amount ?? 0;
      if (job.type === 'capture') {
        p.status = 'captured';
        p.amountCaptured = amount;
        p.history.push({ type: 'captured', at: now, amount });
        p.pendingAction = null;
        touch();
        emit('payment.captured');
      } else if (job.type === 'refund') {
        p.amountRefunded += amount;
        p.status = p.amountRefunded >= p.amountCaptured ? 'refunded' : 'partially_refunded';
        p.history.push({ type: 'refunded', at: now, amount });
        p.pendingAction = null;
        touch();
        emit(p.status === 'refunded' ? 'payment.refunded' : 'payment.partially_refunded');
      } else {
        p.status = 'cancelled';
        p.history.push({ type: 'cancelled', at: now });
        p.pendingAction = null;
        touch();
        emit('payment.cancelled');
      }
      finishJob('succeeded');
      return 'success';
    }

    // The action didn't happen: revert to where the payment was (§3.4 "When retries run out").
    const reason = { code: outcome.code, message: outcome.message };
    p.status = p.pendingAction?.previousStatus ?? p.status;
    p.pendingAction = null;
    p.history.push({ type: `${job.type}_failed`, at: now, code: reason.code });
    touch();
    emit('payment.action_failed', { action: { type: job.type, code: reason.code, message: reason.message } });
    finishJob('failed', reason.code);
    return outcome.kind === 'transient' ? 'gave_up' : 'failed';
  }

  /** After authorization: save the card (approved + saveCard) or purge an unsaved card's number (§3.3). */
  function settleCardAfterAuthorization(d: MerchantData, p: Payment, approved: boolean): void {
    const card = d.cards[p.sourceCardId];
    if (!card || card.saved) return;
    if (approved && p.saveCardOnApproval) {
      const duplicate = Object.values(d.cards).find((c) => c.saved && c.id !== card.id && c.fingerprint === card.fingerprint && c.customerId === p.customerId);
      if (duplicate) {
        delete d.cards[card.id];
        p.sourceCardId = duplicate.id;
        p.paymentMethod.cardId = duplicate.id;
      } else {
        card.saved = true;
        card.customerId = p.customerId;
        p.paymentMethod.cardId = card.id;
      }
    } else {
      delete d.cards[card.id];
    }
  }

  return createPollingLoop({
    name: 'payment-worker',
    intervalMs: WORKER_INTERVAL_MS,
    logger: log,
    tick,
    drain: async () => {
      await Promise.allSettled([...inFlight]);
    },
  });
}

class CardUnavailableError extends Error {
  constructor() {
    super('The card for this payment is no longer available');
    this.name = 'CardUnavailableError';
  }
}

function fromResult(result: ProcessorResult<{ authorizationCode?: string }>): Outcome {
  if (result.outcome === 'success') return { kind: 'success', ...(result.authorizationCode ? { authorizationCode: result.authorizationCode } : {}) };
  if (result.outcome === 'declined') return { kind: 'declined', code: result.code, message: result.message };
  return { kind: 'transient', code: result.code, message: result.message };
}
