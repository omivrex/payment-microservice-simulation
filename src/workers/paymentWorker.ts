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
/** Claim lease. Must exceed PROCESSOR_TIMEOUT_MS (max 25 s), so a run always ends before its lease can expire. */
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
  | { kind: 'transient'; code: string; message: string; bug?: unknown; timedOut?: boolean }
  | { kind: 'permanent'; code: string; message: string; security?: boolean; err?: unknown };

const GENERIC_FAILURE = { code: 'processing_error', message: 'The payment could not be processed.' };

export const retryDelayMs = (attemptsMade: number): number => 2 ** attemptsMade * 1000;

class ProcessorTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Processor did not respond within ${timeoutMs} ms`);
    this.name = 'ProcessorTimeoutError';
  }
}

export function createPaymentWorker(ctx: AppContext, services: Services, processor: Processor): BackgroundLoop {
  const { db, clock } = ctx;
  const inFlight = new Set<Promise<void>>();
  const log = ctx.logger.child({ loop: 'payment-worker' });
  const timeoutMs = ctx.config.processorTimeoutMs;

  const leaseExpired = (job: Job, now: string) => job.status === 'running' && job.lockedUntil !== null && job.lockedUntil < now;
  /** Claimable: queued and due, or a run whose lease expired with attempts left. */
  const isDue = (job: Job, now: string): boolean =>
    (job.status === 'queued' && job.runAt <= now) || (leaseExpired(job, now) && job.attempts < job.maxAttempts);
  /** The final allowed attempt never reported back (process died, or the run hung): give up instead of reclaiming. */
  const isAbandonedOnLastAttempt = (job: Job, now: string): boolean => leaseExpired(job, now) && job.attempts >= job.maxAttempts;

  const groupByMerchant = (rows: Array<{ merchantId: string; id: string }>) => {
    const byMerchant = new Map<string, string[]>();
    for (const { merchantId, id } of rows) byMerchant.set(merchantId, [...(byMerchant.get(merchantId) ?? []), id]);
    return byMerchant;
  };

  async function tick(): Promise<void> {
    const now = isoNow(clock);

    // Give up on exhausted jobs first: it needs no free slot, so it happens even when every slot is busy.
    const abandoned = db.scanMerchants((merchantId, d) =>
      Object.values(d.jobs).filter((j) => isAbandonedOnLastAttempt(j, now)).map((j) => ({ merchantId, id: j.id })),
    );
    for (const [merchantId, ids] of groupByMerchant(abandoned)) {
      const failed = await db.transact(merchantId, (d) => {
        const out: Array<{ jobId: string; paymentId: string; jobType: string; attempts: number }> = [];
        for (const id of ids) {
          const job = d.jobs[id];
          if (!job || !isAbandonedOnLastAttempt(job, now)) continue;
          failJob(d, merchantId, job, d.payments[job.paymentId], { code: 'processing_error', message: 'The action could not be completed.' }, 'lease expired on the final attempt', now);
          out.push({ jobId: job.id, paymentId: job.paymentId, jobType: job.type, attempts: job.attempts });
        }
        return out;
      });
      for (const f of failed) log.error('job failed permanently: no result after the final attempt (lease expired)', { merchantId, ...f });
    }

    const free = ctx.config.workerConcurrency - inFlight.size;
    if (free <= 0) return;
    const due = db
      .scanMerchants((merchantId, d) => Object.values(d.jobs).filter((j) => isDue(j, now)).map((j) => ({ merchantId, id: j.id, runAt: j.runAt })))
      .sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : 0))
      .slice(0, free);

    // One claim transaction per merchant (transactions never span scopes).
    for (const [merchantId, ids] of groupByMerchant(due)) {
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
          out.push({ merchantId, job, payment, card: d.cards[payment.sourceCardId] ?? null }); // copied by JsonDb on return
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
      outcome = fromResult(await callWithTimeout(c));
    } catch (err) {
      if (err instanceof ProcessorTimeoutError) {
        outcome = { kind: 'transient', code: 'processor_timeout', message: 'The processor did not respond in time.', timedOut: true };
      } else if (err instanceof SecurityError) {
        outcome = { kind: 'permanent', ...GENERIC_FAILURE, security: true, err };
      } else if (err instanceof CardUnavailableError) {
        outcome = { kind: 'permanent', ...GENERIC_FAILURE, err };
      } else {
        outcome = { kind: 'transient', ...GENERIC_FAILURE, bug: err };
      }
    }

    if (outcome.kind === 'transient') {
      if (outcome.bug !== undefined) jobLog.error('job handler crashed', { err: outcome.bug });
      else if (outcome.timedOut) jobLog.warn('processor call timed out', { timeoutMs });
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
      // e.g. storage failure: the lease will expire and the job will be retried (or given up at maxAttempts).
      jobLog.error('could not apply job result', { err });
    }
  }

  /**
   * Bounded processor call (PROCESSOR_TIMEOUT_MS). On timeout the call is aborted through its AbortSignal and
   * treated as a transient error, so the job is retried with backoff and its concurrency slot is freed, even if
   * the processor ignores the signal. Retries reuse the job ID as the idempotency reference, so a gateway that
   * did act before the timeout recognises the repeat.
   */
  async function callWithTimeout(c: Claimed): Promise<ProcessorResult<{ authorizationCode?: string }>> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const call = callProcessor(c, controller.signal);
    call.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProcessorTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function callProcessor(c: Claimed, signal: AbortSignal): Promise<ProcessorResult<{ authorizationCode?: string }>> {
    const reference = c.job.id;
    if (c.job.type === 'authorize') {
      if (!c.card || !c.card.numberEncrypted) throw new CardUnavailableError();
      const cardNumber = services.vault.decryptNumber(c.card);
      return processor.authorize({ reference, cardNumber, expMonth: c.card.expMonth, expYear: c.card.expYear, amountMinor: c.payment.amountMinor, currency: c.payment.currency, signal });
    }
    const authorizationCode = c.payment.authorizationCode ?? '';
    if (c.job.type === 'capture') return processor.capture({ reference, authorizationCode, amountMinor: c.job.amountMinor ?? c.payment.amountMinor, signal });
    if (c.job.type === 'refund') return processor.refund({ reference, authorizationCode, amountMinor: c.job.amountMinor ?? 0, signal });
    return processor.cancel({ reference, authorizationCode, signal });
  }

  /** Applies an outcome. Returns false if this run no longer owns the job (stale result). */
  function apply(d: MerchantData, c: Claimed, outcome: Outcome): false | 'success' | 'declined' | 'retry' | 'gave_up' | 'failed' {
    const now = isoNow(clock);
    const job = d.jobs[c.job.id];
    const p = d.payments[c.payment.id];
    if (!job || job.status !== 'running' || job.attempts !== c.job.attempts || job.lockedUntil !== c.job.lockedUntil || !p) return false;

    if (outcome.kind === 'transient' && job.attempts < job.maxAttempts) {
      Object.assign(job, { status: 'queued', runAt: addMs(now, retryDelayMs(job.attempts)), lockedUntil: null, lastError: outcome.code, updatedAt: now });
      return 'retry';
    }

    const emit = (type: Parameters<typeof recordEvent>[2]) => recordEvent(d, c.merchantId, type, toPaymentView(p) as never, now);
    const finishJob = (status: 'succeeded' | 'failed', lastError: string | null = null) =>
      Object.assign(job, { status, lastError, lockedUntil: null, completedAt: now, updatedAt: now });

    if (outcome.kind === 'success') {
      if (job.type === 'authorize') {
        p.authorizationCode = outcome.authorizationCode ?? null;
        p.history.push({ type: 'authorized', at: now, amountMinor: p.amountMinor });
        settleCardAfterAuthorization(d, p, true);
        if (p.captureMethod === 'automatic') {
          const capture = newJob(c.merchantId, p.id, 'capture', p.amountMinor, now, job.requestId);
          d.jobs[capture.id] = capture;
          p.status = 'capturing';
          p.pendingAction = { type: 'capture', amountMinor: p.amountMinor, jobId: capture.id, previousStatus: 'authorized', requestedAt: now };
        } else {
          p.status = 'authorized';
          p.pendingAction = null;
        }
        p.updatedAt = now;
        emit('payment.authorized');
      } else {
        const amount = job.amountMinor ?? 0;
        if (job.type === 'capture') {
          p.status = 'captured';
          p.amountCapturedMinor = amount;
          p.history.push({ type: 'captured', at: now, amountMinor: amount });
        } else if (job.type === 'refund') {
          p.amountRefundedMinor += amount;
          p.status = p.amountRefundedMinor >= p.amountCapturedMinor ? 'refunded' : 'partially_refunded';
          p.history.push({ type: 'refunded', at: now, amountMinor: amount });
        } else {
          p.status = 'cancelled';
          p.history.push({ type: 'cancelled', at: now });
        }
        p.pendingAction = null;
        p.updatedAt = now;
        emit(job.type === 'capture' ? 'payment.captured' : job.type === 'cancel' ? 'payment.cancelled' : p.status === 'refunded' ? 'payment.refunded' : 'payment.partially_refunded');
      }
      finishJob('succeeded');
      return 'success';
    }

    if (outcome.kind === 'declined' && job.type === 'authorize') {
      // A decline is a valid answer, not a failure to get one: the job succeeded, the payment failed.
      failJob(d, c.merchantId, job, p, { code: outcome.code, message: outcome.message }, null, now);
      finishJob('succeeded');
      return 'declined';
    }

    // Permanent failure, or out of retries.
    failJob(d, c.merchantId, job, p, { code: outcome.code, message: outcome.message }, outcome.code, now);
    return outcome.kind === 'transient' ? 'gave_up' : 'failed';
  }

  /**
   * The single "give up" path, shared by: permanent failures, running out of retries, and a lease expiring on the
   * final attempt. An authorization fails the payment (declines keep their code; anything else becomes a generic
   * processing_error, so the merchant learns nothing about internals); a capture/refund/cancel reverts the
   * payment to where it was (§3.4 "When retries run out").
   */
  function failJob(d: MerchantData, merchantId: string, job: Job, p: Payment | undefined, reason: { code: string; message: string }, jobError: string | null, now: string): void {
    Object.assign(job, { status: 'failed', lastError: jobError ?? reason.code, lockedUntil: null, completedAt: now, updatedAt: now });
    if (!p) return;
    const emit = (type: Parameters<typeof recordEvent>[2], extra?: Parameters<typeof recordEvent>[5]) =>
      recordEvent(d, merchantId, type, toPaymentView(p) as never, now, extra);

    if (job.type === 'authorize') {
      const failure = jobError === null ? reason : GENERIC_FAILURE;
      p.status = 'failed';
      p.failure = { code: failure.code, message: failure.message };
      p.pendingAction = null;
      p.history.push({ type: 'failed', at: now, code: failure.code });
      settleCardAfterAuthorization(d, p, false);
      p.updatedAt = now;
      emit('payment.failed');
      return;
    }
    p.status = p.pendingAction?.previousStatus ?? p.status;
    p.pendingAction = null;
    p.history.push({ type: `${job.type}_failed`, at: now, code: reason.code });
    p.updatedAt = now;
    emit('payment.action_failed', { action: { type: job.type, code: reason.code, message: reason.message } });
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
