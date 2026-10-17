import type { RequestHandler } from 'express';
import { SecurityError } from '../../errors.js';
import { newId } from '../../ids.js';
import type { Logger } from '../../logging/logger.js';
import '../types.js';

const VALID_INCOMING_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Assigns the request ID (reusing a well-formed proxy-supplied one). See docs/08-error-handling.md §8.5. */
export const requestContext =
  (logger: Logger): RequestHandler =>
  (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && VALID_INCOMING_ID.test(incoming) ? incoming : newId('req');
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };

/** One access-log line per request, written when the response finishes or the client goes away. */
export const accessLog = (): RequestHandler => (req, res, next) => {
  const started = process.hrtime.bigint();
  res.once('close', () => {
    const status = res.statusCode;
    const route = req.route ? `${req.baseUrl}${req.route.path === '/' && req.baseUrl ? '' : req.route.path}` : '(unmatched)';
    const ctx: Record<string, unknown> = {
      method: req.method,
      route,
      status,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      merchantId: req.auth?.merchantId,
      keyId: req.auth?.keyId,
      code: res.locals.errorCode,
    };
    if (!res.writableFinished) ctx.aborted = true;

    if (status >= 500) {
      const err = res.locals.error;
      req.log.error('request failed', { ...ctx, ...(err instanceof SecurityError ? { security: true } : {}), err });
    }
    else if (status === 401 || status === 403 || status === 429) req.log.warn('request rejected', ctx);
    else req.log.info('request completed', ctx);
  });
  next();
};
