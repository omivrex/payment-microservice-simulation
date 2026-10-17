import express, { type Express, type Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Encryptor } from './crypto/encryption.js';
import type { Hasher } from './crypto/hashing.js';
import type { JsonDb } from './db/jsonDb.js';
import { errorHandler, notFound } from './http/middleware/errorHandler.js';
import { accessLog, requestContext } from './http/middleware/requestContext.js';
import { buildOpenApiDocument, type OpenApiModule } from './http/openapi.js';
import type { Logger } from './logging/logger.js';
import { healthOpenApi, healthRouter } from './modules/health/routes.js';

/** Everything the HTTP layer and modules need. Built in server.ts (or by tests). */
export interface AppContext {
  config: Config;
  db: JsonDb;
  logger: Logger;
  clock: Clock;
  encryptor: Encryptor;
  hasher: Hasher;
}

/** Builds the Express app. No listening, no timers, so tests can use it freely (docs/01-architecture.md §1.7). */
export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  const modules: Array<{ router: Router; openapi: OpenApiModule }> = [{ router: healthRouter(), openapi: healthOpenApi }];
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
