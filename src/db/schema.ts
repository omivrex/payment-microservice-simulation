/**
 * Stored record shapes. See docs/02-data-model.md.
 * Merchant-owned records live inside their merchant's scope (§2.3).
 */

export interface Merchant {
  id: string;
  name: string;
  email: string; // stored lowercased; unique
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyType = 'publishable' | 'secret';

export interface ApiKey {
  id: string; // key_<16 hex>
  merchantId: string;
  type: ApiKeyType;
  status: 'active' | 'revoked';
  publishableKey: string | null;
  secretHash: string | null;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';

export interface Card {
  id: string;
  merchantId: string;
  customerId: string | null;
  saved: boolean;
  numberEncrypted: string | null;
  fingerprint: string;
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  createdAt: string;
}

export interface Token {
  id: string;
  merchantId: string;
  cardId: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'capturing'
  | 'captured'
  | 'refunding'
  | 'partially_refunded'
  | 'refunded'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export type JobType = 'authorize' | 'capture' | 'refund' | 'cancel';

export interface PaymentHistoryEntry {
  type: string;
  at: string;
  amount?: number;
  code?: string;
}

export interface Payment {
  id: string;
  merchantId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  captureMethod: 'automatic' | 'manual';
  amountCaptured: number;
  amountRefunded: number;
  customerId: string | null;
  description: string | null;
  metadata: Record<string, string>;
  paymentMethod: {
    type: 'card';
    cardId: string | null;
    brand: CardBrand;
    last4: string;
    expMonth: number;
    expYear: number;
  };
  sourceCardId: string;
  saveCardOnApproval: boolean;
  authorizationCode: string | null;
  failure: { code: string; message: string } | null;
  pendingAction: {
    type: JobType;
    amount: number | null;
    jobId: string;
    previousStatus: PaymentStatus | null;
    requestedAt: string;
  } | null;
  history: PaymentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  merchantId: string;
  paymentId: string;
  type: JobType;
  amount: number | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedUntil: string | null;
  lastError: string | null;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const EVENT_TYPES = [
  'payment.created',
  'payment.authorized',
  'payment.captured',
  'payment.partially_refunded',
  'payment.refunded',
  'payment.cancelled',
  'payment.failed',
  'payment.updated',
  'payment.action_failed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface StoredEvent {
  id: string;
  merchantId: string;
  type: EventType;
  /** `action` is present on payment.action_failed: which action failed and why. */
  data: { object: Record<string, unknown>; action?: { type: JobType; code: string; message: string } };
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  events: EventType[] | ['*'];
  enabled: boolean;
  description: string | null;
  secretEncrypted: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  merchantId: string;
  endpointId: string;
  eventId: string;
  status: 'pending' | 'sending' | 'succeeded' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  lockedUntil: string | null;
  lastAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface IdempotencyRecord {
  id: string;
  merchantId: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface CentralData {
  merchants: Record<string, Merchant>;
  apiKeys: Record<string, ApiKey>;
}

export interface MerchantData {
  tokens: Record<string, Token>;
  cards: Record<string, Card>;
  payments: Record<string, Payment>;
  jobs: Record<string, Job>;
  events: Record<string, StoredEvent>;
  webhookEndpoints: Record<string, WebhookEndpoint>;
  webhookDeliveries: Record<string, WebhookDelivery>;
  idempotency: Record<string, IdempotencyRecord>;
}

export interface DatabaseFile {
  meta: { schemaVersion: number };
  central: CentralData;
  merchants: Record<string, MerchantData>;
}

export const CURRENT_SCHEMA_VERSION = 1;

export const emptyCentral = (): CentralData => ({ merchants: {}, apiKeys: {} });

export const emptyMerchantData = (): MerchantData => ({
  tokens: {},
  cards: {},
  payments: {},
  jobs: {},
  events: {},
  webhookEndpoints: {},
  webhookDeliveries: {},
  idempotency: {},
});

export const emptyDatabase = (): DatabaseFile => ({
  meta: { schemaVersion: CURRENT_SCHEMA_VERSION },
  central: emptyCentral(),
  merchants: {},
});
