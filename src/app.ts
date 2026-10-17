import express, { type Express, type Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Encryptor } from './crypto/encryption.js';
import type { Hasher } from './crypto/hashing.js';
import type { JsonDb } from './db/jsonDb.js';
import { requireKey } from './http/middleware/auth.js';
import { errorHandler, notFound } from './http/middleware/errorHandler.js';
import { generalLimiter } from './http/middleware/rateLimit.js';
import { accessLog, requestContext } from './http/middleware/requestContext.js';
import { buildOpenApiDocument, type OpenApiModule } from './http/openapi.js';
import type { RouteDeps } from './http/routeDeps.js';
import type { Logger } from './logging/logger.js';
import { apiKeysOpenApi, apiKeysRouter } from './modules/apiKeys/routes.js';
import { healthOpenApi, healthRouter } from './modules/health/routes.js';
import { merchantsOpenApi, merchantsRouter } from './modules/merchants/routes.js';
import { createServices, type Services } from './services.js';

/** Infrastructure every module needs. Built in server.ts (or by tests). */
export interface AppContext {
  config: Config;
  db: JsonDb;
  logger: Logger;
  clock: Clock;
  encryptor: Encryptor;
  hasher: Hasher;
}

/** Builds the Express app. No listening, no timers, so tests can use it freely (docs/01-architecture.md §1.7). */
export function createApp(ctx: AppContext, services: Services = createServices(ctx)): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // One shared limiter instance, so the per-key budget spans every authenticated route.
  const general = generalLimiter(ctx.config.rateLimits.generalPerMinute);
  const deps: RouteDeps = {
    ctx,
    services,
    auth: {
      secret: [requireKey(services.apiKeys, ['secret']), general],
      any: [requireKey(services.apiKeys, ['secret', 'publishable']), general],
    },
  };

  const modules: Array<{ router: Router; openapi: OpenApiModule }> = [
    { router: healthRouter(), openapi: healthOpenApi },
    { router: merchantsRouter(deps), openapi: merchantsOpenApi },
    { router: apiKeysRouter(deps), openapi: apiKeysOpenApi },
  ];
  const openapi = buildOpenApiDocument(modules.map((m) => m.openapi));

  app.use(requestContext(ctx.logger));
  app.use(accessLog());
  app.use(express.json({ limit: '100kb' }));

  app.get('/openapi.json', (_req, res) => {
    res.json(openapi);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Payment Service API' }));

  for (const m of modules) app.use(m.router);

  app.use(notFound());
  app.use(errorHandler());
  return app;
}
