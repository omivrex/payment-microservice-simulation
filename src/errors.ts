/**
 * Error hierarchy. See docs/08-error-handling.md §8.2.
 *
 * AppError subclasses are "expected" errors: their status, code and message are
 * safe to return to the client. Anything that is not an AppError is treated as a
 * bug (or a SecurityError) and is never described to the client.
 */

export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details?: ErrorDetail[];
  readonly retryAfterSeconds?: number;

  constructor(message: string, options?: { details?: ErrorDetail[]; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options?.details) this.details = options.details;
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = 'validation_error';
  constructor(details: ErrorDetail[], message = 'Invalid request') {
    super(message, { details });
  }
}

export class InvalidJsonError extends AppError {
  readonly status = 400;
  readonly code = 'invalid_json';
  constructor() {
    super('Request body is not valid JSON');
  }
}

export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly code = 'unauthorized';
  constructor() {
    super('Missing or invalid API key');
  }
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = 'forbidden';
  constructor(message = 'This API key is not allowed to perform this request') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'not_found';
  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} not found` : `${resource} not found`);
  }
}

export class InvalidStateError extends AppError {
  readonly status = 409;
  readonly code = 'invalid_state';
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = 'conflict';
}

export class IdempotencyInProgressError extends AppError {
  readonly status = 409;
  readonly code = 'idempotency_in_progress';
  constructor() {
    super('A request with this Idempotency-Key is still being processed');
  }
}

export class PayloadTooLargeError extends AppError {
  readonly status = 413;
  readonly code = 'payload_too_large';
  constructor() {
    super('Request body is too large');
  }
}

export class IdempotencyKeyReusedError extends AppError {
  readonly status = 422;
  readonly code = 'idempotency_key_reused';
  constructor() {
    super('This Idempotency-Key was already used with a different request body');
  }
}

export class RateLimitedError extends AppError {
  readonly status = 429;
  readonly code = 'rate_limited';
  override readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Too many requests');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class StorageError extends AppError {
  readonly status = 503;
  readonly code = 'service_unavailable';
  override readonly retryAfterSeconds = 30;
  constructor(cause: unknown) {
    super('The service is temporarily unable to save data. Retry later.', { cause });
  }
}

/** Decryption/integrity failures. Deliberately NOT an AppError: its message must never reach a client. */
export class SecurityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecurityError';
  }
}

/** Raised during startup (config, database file, lock). The process exits with code 1. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StartupError';
  }
}
