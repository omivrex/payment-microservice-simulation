import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
  AppError,
  InvalidJsonError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../errors.js';
import '../types.js';

/** Unknown route → JSON 404 (never Express's HTML page). */
export const notFound = (): RequestHandler => (req, _res, next) => {
  next(new NotFoundError('Route', `${req.method} ${req.path}`));
};

const INTERNAL_MESSAGE = 'An unexpected error occurred. Quote the requestId if you contact support.';

/**
 * The ONLY place errors become responses. See docs/08-error-handling.md §8.3.
 * Logging happens once, in the access log, which reads res.locals.
 */
export const errorHandler = (): ErrorRequestHandler => (err, req, res, _next) => {
  if (res.headersSent) {
    req.log.error('error after response headers were sent', { err });
    res.destroy();
    return;
  }

  let appError: AppError | null = null;
  if (err instanceof AppError) appError = err;
  else if (isBodyParserError(err)) {
    // The parser's own message can quote the request body, so it is dropped entirely.
    if (err.type === 'entity.too.large') appError = new PayloadTooLargeError();
    else if (err.type === 'entity.parse.failed') appError = new InvalidJsonError();
    else appError = new ValidationError([{ field: 'body', message: 'could not be read' }]);
  }

  if (appError) {
    res.locals.errorCode = appError.code;
    if (appError.status >= 500) res.locals.error = appError;
    if (appError.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(appError.retryAfterSeconds));
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
        requestId: req.requestId,
      },
    });
    return;
  }

  // Bugs and security events: generic response, full detail in the log only.
  res.locals.errorCode = 'internal_error';
  res.locals.error = err;
  res.status(500).json({ error: { code: 'internal_error', message: INTERNAL_MESSAGE, requestId: req.requestId } });
};

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { type?: unknown }).type === 'string' &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (err as { status: number }).status < 500
  );
}
