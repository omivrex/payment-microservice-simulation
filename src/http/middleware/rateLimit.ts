import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RateLimitedError } from '../../errors.js';
import '../types.js';

/**
 * In-memory rate limits (single process). See docs/04-security.md §4.9.
 * Limit hits are turned into RateLimitedError so the normal error contract applies.
 */
function limiter(options: { windowMs: number; limit: number; key: 'ip' | 'apiKey' }): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: false,
    legacyHeaders: false,
    // Built-in validations print to the console directly, bypassing the redacting logger.
    validate: false,
    ...(options.key === 'apiKey' ? { keyGenerator: (req: Request) => req.auth?.keyId ?? 'anonymous' } : {}),
    handler: (req, _res, next) => {
      const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
      const resetTime = info?.resetTime?.getTime() ?? Date.now() + options.windowMs;
      next(new RateLimitedError(Math.max(1, Math.ceil((resetTime - Date.now()) / 1000))));
    },
  });
}

export const signupLimiter = (perHour: number) => limiter({ windowMs: 60 * 60 * 1000, limit: perHour, key: 'ip' });
export const tokensLimiter = (perMinute: number) => limiter({ windowMs: 60 * 1000, limit: perMinute, key: 'apiKey' });
export const generalLimiter = (perMinute: number) => limiter({ windowMs: 60 * 1000, limit: perMinute, key: 'apiKey' });
