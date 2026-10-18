import type { Payment } from '../../db/schema.js';

/** Public payment object: an allow-list, so new internal fields stay hidden by default (docs/02-data-model.md §2.5). */
export interface PaymentView {
  id: string;
  status: Payment['status'];
  amountMinor: number;
  currency: string;
  captureMethod: Payment['captureMethod'];
  amountCapturedMinor: number;
  amountRefundedMinor: number;
  customerId: string | null;
  description: string | null;
  metadata: Record<string, string>;
  paymentMethod: Payment['paymentMethod'];
  authorizationCode: string | null;
  failure: Payment['failure'];
  pendingAction: { type: NonNullable<Payment['pendingAction']>['type']; amountMinor: number | null; requestedAt: string } | null;
  history: Payment['history'];
  createdAt: string;
  updatedAt: string;
}

export function toPaymentView(p: Payment): PaymentView {
  return {
    id: p.id,
    status: p.status,
    amountMinor: p.amountMinor,
    currency: p.currency,
    captureMethod: p.captureMethod,
    amountCapturedMinor: p.amountCapturedMinor,
    amountRefundedMinor: p.amountRefundedMinor,
    customerId: p.customerId,
    description: p.description,
    metadata: { ...p.metadata },
    paymentMethod: { ...p.paymentMethod },
    authorizationCode: p.authorizationCode,
    failure: p.failure ? { ...p.failure } : null,
    pendingAction: p.pendingAction
      ? { type: p.pendingAction.type, amountMinor: p.pendingAction.amountMinor, requestedAt: p.pendingAction.requestedAt }
      : null,
    history: p.history.map((h) => ({ ...h })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
