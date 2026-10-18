import type { ApiKeyType, MerchantData } from '../db/schema.js';
import type { Logger } from '../logging/logger.js';

export interface AuthContext {
  merchantId: string;
  keyId: string;
  keyType: ApiKeyType;
}

/** Set by the idempotency middleware when the request has an Idempotency-Key. */
export interface IdempotencyScope {
  /** Marks this request's record completed with the response. Call inside the action's transaction. */
  commit(draft: MerchantData, status: number, body: unknown): void;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    log: Logger;
    auth?: AuthContext;
    idempotency?: IdempotencyScope;
  }
  interface Locals {
    error?: unknown;
    errorCode?: string;
  }
}
