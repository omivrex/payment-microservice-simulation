import type { Payment } from '../../db/schema.js';

/** Public payment object: an allow-list, so new internal fields stay hidden by default (docs/02-data-model.md §2.5). */
export interface PaymentView {
  id: string;
  status: Payment['status'];
  amount: number;
  currency: string;
  captureMethod: Payment['captureMethod'];
  amountCaptured: number;
  amountRefunded: number;
  customerId: string | null;
  description: string | null;
  metadata: Record<string, string>;
  paymentMethod: Payment['paymentMethod'];
  authorizationCode: string | null;
  failure: Payment['failure'];
  pendingAction: { type: NonNullable<Payment['pendingAction']>['type']; amount: number | null; requestedAt: string } | null;
  history: Payment['history'];
  createdAt: string;
  updatedAt: string;
}

export function toPaymentView(p: Payment): PaymentView {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    captureMethod: p.captureMethod,
    amountCaptured: p.amountCaptured,
    amountRefunded: p.amountRefunded,
    customerId: p.customerId,
    description: p.description,
    metadata: { ...p.metadata },
    paymentMethod: { ...p.paymentMethod },
    authorizationCode: p.authorizationCode,
    failure: p.failure ? { ...p.failure } : null,
    pendingAction: p.pendingAction
      ? { type: p.pendingAction.type, amount: p.pendingAction.amount, requestedAt: p.pendingAction.requestedAt }
      : null,
    history: p.history.map((h) => ({ ...h })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
