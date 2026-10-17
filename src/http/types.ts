import type { ApiKeyType } from '../db/schema.js';
import type { Logger } from '../logging/logger.js';

export interface AuthContext {
  merchantId: string;
  keyId: string;
  keyType: ApiKeyType;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    log: Logger;
    auth?: AuthContext;
  }
  interface Locals {
    error?: unknown;
    errorCode?: string;
  }
}
