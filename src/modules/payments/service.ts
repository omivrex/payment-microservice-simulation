import { isoNow, type Clock } from '../../clock.js';
import type { JsonDb } from '../../db/jsonDb.js';
import type { Card, Job, JobType, MerchantData, Payment, PaymentStatus } from '../../db/schema.js';
import { InvalidStateError, NotFoundError, ValidationError } from '../../errors.js';
import { newId } from '../../ids.js';
import { paginate, type Page } from '../../http/validate.js';
import type { CardInput } from '../cards/cardInput.js';
import type { CardVault } from '../cards/vault.js';
import { recordEvent } from '../events/outbox.js';
import { consumeToken } from '../tokens/service.js';
import { toPaymentView, type PaymentView } from './view.js';

/**
 * Payments: creation and action requests. Everything that talks to the
 * processor is queued as a job and done by the payment worker (§3.1).
 */

export const MAX_JOB_ATTEMPTS = 5;
export const MAX_METADATA_KEYS = 20;

export type CardSource = { token: string } | { cardId: string } | { card: CardInput };

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  source: CardSource;
  saveCard: boolean;
  customerId: string | null;
  captureMethod: 'automatic' | 'manual';
  description: string | null;
  metadata: Record<string, string>;
}

export interface ListPaymentsQuery {
  status?: PaymentStatus | undefined;
  customerId?: string | undefined;
  limit: number;
  offset: number;
}

export function newJob(merchantId: string, paymentId: string, type: JobType, amount: number | null, now: string, requestId: string | null): Job {
  return {
    id: newId('job'),
    merchantId,
    paymentId,
    type,
    amount,
    status: 'queued',
    attempts: 0,
    maxAttempts: MAX_JOB_ATTEMPTS,
    runAt: now,
    lockedUntil: null,
    lastError: null,
    requestId,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

export class PaymentsService {
  constructor(
    private readonly db: JsonDb,
    private readonly vault: CardVault,
    private readonly clock: Clock,
  ) {}

  async create(merchantId: string, input: CreatePaymentInput, requestId: string | null): Promise<PaymentView> {
    const rawCard = 'card' in input.source ? this.vault.build(merchantId, input.source.card, { saved: false, customerId: null }) : null;
    const now = isoNow(this.clock);

    return this.db.transact(merchantId, (d) => {
      let card: Card;
      if ('token' in input.source) card = consumeToken(d, input.source.token, now);
      else if ('cardId' in input.source) {
        const saved = d.cards[input.source.cardId];
        if (!saved || !saved.saved) throw new NotFoundError('Card', input.source.cardId);
        card = saved;
      } else {
        card = rawCard!;
        d.cards[card.id] = card;
      }

      const paymentId = newId('pay');
      const job = newJob(merchantId, paymentId, 'authorize', null, now, requestId);
      const payment: Payment = {
        id: paymentId,
        merchantId,
        status: 'pending',
        amount: input.amount,
        currency: input.currency,
        captureMethod: input.captureMethod,
        amountCaptured: 0,
        amountRefunded: 0,
        customerId: input.customerId,
        description: input.description,
        metadata: input.metadata,
        paymentMethod: {
          type: 'card',
          cardId: card.saved ? card.id : null,
          brand: card.brand,
          last4: card.last4,
          expMonth: card.expMonth,
          expYear: card.expYear,
        },
        sourceCardId: card.id,
        saveCardOnApproval: input.saveCard && !card.saved,
        authorizationCode: null,
        failure: null,
        pendingAction: { type: 'authorize', amount: null, jobId: job.id, previousStatus: null, requestedAt: now },
        history: [{ type: 'created', at: now }],
        createdAt: now,
        updatedAt: now,
      };
      d.payments[paymentId] = payment;
      d.jobs[job.id] = job;
      const view = toPaymentView(payment);
      recordEvent(d, merchantId, 'payment.created', view as never, now);
      return view;
    });
  }

  get(merchantId: string, paymentId: string): PaymentView {
    const payment = this.db.read(merchantId, (d) => d.payments[paymentId]);
    if (!payment) throw new NotFoundError('Payment', paymentId);
    return toPaymentView(payment);
  }

  list(merchantId: string, query: ListPaymentsQuery): Page<PaymentView> {
    const payments = this.db.read(merchantId, (d) =>
      Object.values(d.payments).filter(
        (p) => (query.status === undefined || p.status === query.status) && (query.customerId === undefined || p.customerId === query.customerId),
      ),
    );
    const page = paginate(payments, query.limit, query.offset);
    return { ...page, data: page.data.map(toPaymentView) };
  }

  /** Description/metadata only. Metadata is merged; null deletes a key. Allowed in every status (§3.2). */
  async update(merchantId: string, paymentId: string, input: { description?: string | null | undefined; metadata?: Record<string, string | null> | undefined }): Promise<PaymentView> {
    const now = isoNow(this.clock);
    return this.db.transact(merchantId, (d) => {
      const p = findPayment(d, paymentId);
      if (input.description !== undefined) p.description = input.description;
      if (input.metadata !== undefined) {
        for (const [key, value] of Object.entries(input.metadata)) {
          if (value === null) delete p.metadata[key];
          else p.metadata[key] = value;
        }
        if (Object.keys(p.metadata).length > MAX_METADATA_KEYS) {
          throw new ValidationError([{ field: 'metadata', message: `would exceed ${MAX_METADATA_KEYS} keys after merging` }]);
        }
      }
      p.history.push({ type: 'updated', at: now });
      p.updatedAt = now;
      const view = toPaymentView(p);
      recordEvent(d, merchantId, 'payment.updated', view as never, now);
      return view;
    });
  }

  capture(merchantId: string, paymentId: string, amount: number | undefined, requestId: string | null): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'capture', requestId, (p) => {
      if (p.status !== 'authorized') return null;
      const toCapture = amount ?? p.amount;
      if (toCapture > p.amount) {
        throw new ValidationError([{ field: 'amount', message: `cannot exceed the authorized amount (${p.amount})` }]);
      }
      return { amount: toCapture, nextStatus: 'capturing' };
    });
  }

  refund(merchantId: string, paymentId: string, amount: number | undefined, requestId: string | null): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'refund', requestId, (p) => {
      if (p.status !== 'captured' && p.status !== 'partially_refunded') return null;
      const refundable = p.amountCaptured - p.amountRefunded;
      const toRefund = amount ?? refundable;
      if (toRefund > refundable) {
        throw new ValidationError([{ field: 'amount', message: `cannot exceed the refundable amount (${refundable})` }]);
      }
      return { amount: toRefund, nextStatus: 'refunding' };
    });
  }

  cancel(merchantId: string, paymentId: string, requestId: string | null): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'cancel', requestId, (p) =>
      p.status === 'authorized' ? { amount: null, nextStatus: 'cancelling' } : null,
    );
  }

  /**
   * Shared shape of capture/refund/cancel: state check (409), amount check (400),
   * queue a job, move to the transitional status. One pending action at a time.
   */
  #requestAction(
    merchantId: string,
    paymentId: string,
    type: Exclude<JobType, 'authorize'>,
    requestId: string | null,
    plan: (p: Payment) => { amount: number | null; nextStatus: PaymentStatus } | null,
  ): Promise<PaymentView> {
    const now = isoNow(this.clock);
    return this.db.transact(merchantId, (d) => {
      const p = findPayment(d, paymentId);
      const planned = p.pendingAction ? null : plan(p);
      if (!planned) throw new InvalidStateError(`Cannot ${type} a payment with status "${p.status}"`);
      const job = newJob(merchantId, p.id, type, planned.amount, now, requestId);
      d.jobs[job.id] = job;
      p.pendingAction = { type, amount: planned.amount, jobId: job.id, previousStatus: p.status, requestedAt: now };
      p.status = planned.nextStatus;
      p.updatedAt = now;
      return toPaymentView(p);
    });
  }
}

export function findPayment(d: MerchantData, paymentId: string): Payment {
  const p = d.payments[paymentId];
  if (!p) throw new NotFoundError('Payment', paymentId);
  return p;
}
