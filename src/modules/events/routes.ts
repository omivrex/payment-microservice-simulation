import { Router } from 'express';
import { z } from 'zod';
import { EVENT_TYPES } from '../../db/schema.js';
import { commonErrors, errorResponse, idParam, jsonResponse, pageOf, paginationParams, ref, route, secretKeyAuth, type OpenApiModule } from '../../http/openapi.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { paginationQuery, parseQuery } from '../../http/validate.js';

const listQuery = z.strictObject({ type: z.enum(EVENT_TYPES).optional(), ...paginationQuery });

export function eventsRouter({ services, auth }: RouteDeps): Router {
  const router = Router();
  route(router, 'get', '/events', ...auth.secret, (req, res) => {
    res.json(services.events.list(req.auth!.merchantId, parseQuery(listQuery, req.query)));
  });
  route(router, 'get', '/events/:id', ...auth.secret, (req, res) => {
    res.json(services.events.get(req.auth!.merchantId, req.params.id as string));
  });
  return router;
}

export const eventsOpenApi: OpenApiModule = {
  tag: { name: 'Events', description: 'The event log: reconcile after missed webhooks. Kept for RETENTION_DAYS (default 7).' },
  schemas: {
    Event: {
      type: 'object',
      required: ['id', 'type', 'data', 'createdAt'],
      properties: {
        id: { type: 'string', example: 'evt_44c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8' },
        type: { type: 'string', enum: EVENT_TYPES },
        data: {
          type: 'object',
          properties: {
            object: { ...ref('Payment'), description: 'The payment as it was when the event happened' },
            action: { type: 'object', description: 'Only on payment.action_failed', properties: { type: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } },
          },
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  paths: {
    '/events': {
      get: {
        summary: 'List events, newest first',
        security: secretKeyAuth,
        parameters: [{ name: 'type', in: 'query', schema: { type: 'string', enum: EVENT_TYPES } }, ...paginationParams],
        responses: { '200': jsonResponse('Events', pageOf(ref('Event'))), '400': commonErrors['400'], '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/events/{id}': {
      get: {
        summary: 'Get one event',
        security: secretKeyAuth,
        parameters: [idParam('id', 'evt')],
        responses: { '200': jsonResponse('The event', ref('Event')), '401': commonErrors['401'], '404': errorResponse('Unknown event') },
      },
    },
  },
};
