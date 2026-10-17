import type { RequestHandler } from 'express';
import type { AppContext } from '../app.js';
import type { Services } from '../services.js';

/** What every module router receives. Auth chains include the shared per-key rate limiter. */
export interface RouteDeps {
  ctx: AppContext;
  services: Services;
  auth: {
    /** Secret key only. */
    secret: RequestHandler[];
    /** Secret or publishable key. */
    any: RequestHandler[];
  };
}
