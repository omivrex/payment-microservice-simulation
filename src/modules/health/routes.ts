import { Router } from 'express';
import { jsonResponse, route, type OpenApiModule } from '../../http/openapi.js';

export function healthRouter(): Router {
  const router = Router();
  route(router, 'get', '/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return router;
}

export const healthOpenApi: OpenApiModule = {
  tag: { name: 'Health', description: 'Liveness check' },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness check',
        security: [],
        responses: {
          '200': jsonResponse('Service is running', {
            type: 'object',
            properties: { status: { type: 'string', const: 'ok' } },
          }),
        },
      },
    },
  },
};
