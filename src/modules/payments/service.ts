import { isoNow, type Clock } from '../../clock.js';
import { getOwn, type InTransaction, type JsonDb } from '../../db/jsonDb.js';
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
  amountMinor: number;
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

export function newJob(merchantId: string, paymentId: string, type: JobType, amountMinor: number | null, now: string, requestId: string | null): Job {
  return {
    id: newId('job'),
    merchantId,
    paymentId,
    type,
    amountMinor,
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

  async create(merchantId: string, input: CreatePaymentInput, requestId: string | null, inTx?: InTransaction<PaymentView>): Promise<PaymentView> {
    const rawCard = 'card' in input.source ? this.vault.build(merchantId, input.source.card, { saved: false, customerId: null }) : null;
    const now = isoNow(this.clock);

    return this.db.transact(merchantId, (d) => {
      let card: Card;
      if ('token' in input.source) card = consumeToken(d, input.source.token, now);
      else if ('cardId' in input.source) {
        const saved = getOwn(d.cards, input.source.cardId);
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
        amountMinor: input.amountMinor,
        currency: input.currency,
        captureMethod: input.captureMethod,
        amountCapturedMinor: 0,
        amountRefundedMinor: 0,
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
        pendingAction: { type: 'authorize', amountMinor: null, jobId: job.id, previousStatus: null, requestedAt: now },
        history: [{ type: 'created', at: now }],
        createdAt: now,
        updatedAt: now,
      };
      d.payments[paymentId] = payment;
      d.jobs[job.id] = job;
      const view = toPaymentView(payment);
      recordEvent(d, merchantId, 'payment.created', view as never, now);
      inTx?.(d, view);
      return view;
    });
  }

  get(merchantId: string, paymentId: string): PaymentView {
    const payment = this.db.read(merchantId, (d) => getOwn(d.payments, paymentId));
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

  /**
   * PATCH: description/metadata (merged; null deletes a key), and optionally a status change.
   *
   * A status change is accepted only to meet the project requirement that a payment's status can be
   * updated through PATCH (docs/05-api.md §5.8). It is not a free-form status write: `captured`,
   * `refunded` and `cancelled` run exactly the same rules and job as POST /capture, /refund and
   * /cancel, so the state machine (docs/03-payment-lifecycle.md §3.2) still applies. Everything in
   * one request commits in one transaction, or not at all.
   */
  async update(
    merchantId: string,
    paymentId: string,
    input: PaymentUpdate,
    requestId: string | null,
    inTx?: InTransaction<PaymentUpdateResult>,
  ): Promise<PaymentUpdateResult> {
    const now = isoNow(this.clock);
    return this.db.transact(merchantId, (d) => {
      const p = findPayment(d, paymentId);
      // The status change goes first, so a rejected one (409/400) leaves the labels unchanged too.
      if (input.status !== undefined) {
        const { type, plan } = this.#statusAction(input.status, input.amountMinor);
        this.#applyAction(d, p, type, requestId, now, plan);
      }
      const labelsChanged = input.description !== undefined || input.metadata !== undefined;
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
      if (labelsChanged) {
        p.history.push({ type: 'updated', at: now });
        p.updatedAt = now;
        recordEvent(d, merchantId, 'payment.updated', toPaymentView(p) as never, now);
      }
      const result: PaymentUpdateResult = { payment: toPaymentView(p), statusChangeRequested: input.status !== undefined };
      inTx?.(d, result);
      return result;
    });
  }

  capture(merchantId: string, paymentId: string, amountMinor: number | undefined, requestId: string | null, inTx?: InTransaction<PaymentView>): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'capture', requestId, inTx, capturePlan(amountMinor));
  }

  refund(merchantId: string, paymentId: string, amountMinor: number | undefined, requestId: string | null, inTx?: InTransaction<PaymentView>): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'refund', requestId, inTx, refundPlan(amountMinor));
  }

  cancel(merchantId: string, paymentId: string, requestId: string | null, inTx?: InTransaction<PaymentView>): Promise<PaymentView> {
    return this.#requestAction(merchantId, paymentId, 'cancel', requestId, inTx, cancelPlan());
  }

  /** Maps a requested status to the action that produces it (the only three allowed). */
  #statusAction(status: StatusUpdate, amountMinor: number | undefined): { type: ActionType; plan: ActionPlan } {
    if (status === 'captured') return { type: 'capture', plan: capturePlan(amountMinor) };
    if (status === 'refunded') return { type: 'refund', plan: refundPlan(amountMinor) };
    return { type: 'cancel', plan: cancelPlan() };
  }

  #requestAction(
    merchantId: string,
    paymentId: string,
    type: ActionType,
    requestId: string | null,
    inTx: InTransaction<PaymentView> | undefined,
    plan: ActionPlan,
  ): Promise<PaymentView> {
    const now = isoNow(this.clock);
    return this.db.transact(merchantId, (d) => {
      const p = findPayment(d, paymentId);
      this.#applyAction(d, p, type, requestId, now, plan);
      const view = toPaymentView(p);
      inTx?.(d, view);
      return view;
    });
  }

  /**
   * Shared shape of capture/refund/cancel (and PATCH status): state check (409), amount check (400),
   * queue a job, move to the transitional status. One pending action at a time. Runs in the caller's transaction.
   */
  #applyAction(d: MerchantData, p: Payment, type: ActionType, requestId: string | null, now: string, plan: ActionPlan): void {
    const planned = p.pendingAction ? null : plan(p);
    if (!planned) throw new InvalidStateError(`Cannot ${type} a payment with status "${p.status}"`);
    const job = newJob(p.merchantId, p.id, type, planned.amountMinor, now, requestId);
    d.jobs[job.id] = job;
    p.pendingAction = { type, amountMinor: planned.amountMinor, jobId: job.id, previousStatus: p.status, requestedAt: now };
    p.status = planned.nextStatus;
    p.updatedAt = now;
  }
}

// ---------------------------------------------------------------- action rules (shared by the action endpoints and PATCH status)

type ActionType = Exclude<JobType, 'authorize'>;
type ActionPlan = (p: Payment) => { amountMinor: number | null; nextStatus: PaymentStatus } | null;

/** The only statuses PATCH accepts, each produced by the matching action. */
export const STATUS_UPDATES = ['captured', 'refunded', 'cancelled'] as const;
export type StatusUpdate = (typeof STATUS_UPDATES)[number];

export interface PaymentUpdate {
  description?: string | null | undefined;
  metadata?: Record<string, string | null> | undefined;
  status?: StatusUpdate | undefined;
  /** Only with status captured/refunded: partial capture/refund, as on the action endpoints. */
  amountMinor?: number | undefined;
}

export interface PaymentUpdateResult {
  payment: PaymentView;
  /** True when a status change was queued: the route answers 202 like the action endpoints. */
  statusChangeRequested: boolean;
}

const capturePlan =
  (amountMinor: number | undefined): ActionPlan =>
  (p) => {
    if (p.status !== 'authorized') return null;
    const toCapture = amountMinor ?? p.amountMinor;
    if (toCapture > p.amountMinor) {
      throw new ValidationError([{ field: 'amountMinor', message: `cannot exceed the authorized amount (${p.amountMinor} in minor units)` }]);
    }
    return { amountMinor: toCapture, nextStatus: 'capturing' };
  };

const refundPlan =
  (amountMinor: number | undefined): ActionPlan =>
  (p) => {
    if (p.status !== 'captured' && p.status !== 'partially_refunded') return null;
    const refundable = p.amountCapturedMinor - p.amountRefundedMinor;
    const toRefund = amountMinor ?? refundable;
    if (toRefund > refundable) {
      throw new ValidationError([{ field: 'amountMinor', message: `cannot exceed the refundable amount (${refundable} in minor units)` }]);
    }
    return { amountMinor: toRefund, nextStatus: 'refunding' };
  };

const cancelPlan = (): ActionPlan => (p) => (p.status === 'authorized' ? { amountMinor: null, nextStatus: 'cancelling' } : null);

export function findPayment(d: MerchantData, paymentId: string): Payment {
  const p = getOwn(d.payments, paymentId);
  if (!p) throw new NotFoundError('Payment', paymentId);
  return p;
}
