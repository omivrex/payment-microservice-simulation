import { Router } from 'express';
import { z } from 'zod';
import { EVENT_TYPES, type EventType } from '../../db/schema.js';
import { ValidationError } from '../../errors.js';
import {
  commonErrors,
  errorResponse,
  idParam,
  jsonBody,
  jsonResponse,
  pageOf,
  paginationParams,
  ref,
  route,
  secretKeyAuth,
  type OpenApiModule,
} from '../../http/openapi.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { paginationQuery, parseBody, parseQuery } from '../../http/validate.js';
import { MAX_ENDPOINTS_PER_MERCHANT } from './service.js';

const eventsSchema = z
  .array(z.enum(['*', ...EVENT_TYPES], { error: `must be "*" or known event types: ${EVENT_TYPES.join(', ')}` }))
  .min(1)
  .max(EVENT_TYPES.length + 1)
  .transform((v) => [...new Set(v)])
  .refine((v) => !v.includes('*') || v.length === 1, { error: '"*" must be the only entry when used' })
  .transform((v) => v as EventType[] | ['*']);

const urlSchema = z.string().trim().min(1).max(2048);
const descriptionSchema = z.string().max(500).nullable();

const createSchema = z.strictObject({ url: urlSchema, events: eventsSchema, description: descriptionSchema.optional() });
const updateSchema = z.strictObject({ url: urlSchema.optional(), events: eventsSchema.optional(), enabled: z.boolean().optional(), description: descriptionSchema.optional() });
const deliveriesQuery = z.strictObject({ status: z.enum(['pending', 'sending', 'succeeded', 'failed']).optional(), ...paginationQuery });

export function webhooksRouter({ services, auth }: RouteDeps): Router {
  const router = Router();
  const webhooks = services.webhooks;

  // Not idempotent on purpose: the response contains a secret that is never stored in plain text.
  route(router, 'post', '/webhooks', ...auth.secret, async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const { endpoint, secret } = await webhooks.create(req.auth!.merchantId, { url: body.url, events: body.events, description: body.description ?? null });
    res.status(201).json({ ...endpoint, secret });
  });

  route(router, 'get', '/webhooks', ...auth.secret, (req, res) => {
    res.json({ data: webhooks.list(req.auth!.merchantId) });
  });

  route(router, 'get', '/webhooks/:id', ...auth.secret, (req, res) => {
    res.json(webhooks.get(req.auth!.merchantId, req.params.id as string));
  });

  route(router, 'patch', '/webhooks/:id', ...auth.secret, async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    if (Object.values(body).every((v) => v === undefined)) {
      throw new ValidationError([{ field: 'body', message: 'must include at least one of: url, events, enabled, description' }]);
    }
    res.json(await webhooks.update(req.auth!.merchantId, req.params.id as string, body));
  });

  route(router, 'delete', '/webhooks/:id', ...auth.secret, async (req, res) => {
    await webhooks.delete(req.auth!.merchantId, req.params.id as string);
    res.status(204).end();
  });

  route(router, 'post', '/webhooks/:id/rotate-secret', ...auth.secret, async (req, res) => {
    res.json(await webhooks.rotateSecret(req.auth!.merchantId, req.params.id as string));
  });

  route(router, 'get', '/webhooks/:id/deliveries', ...auth.secret, (req, res) => {
    res.json(webhooks.listDeliveries(req.auth!.merchantId, req.params.id as string, parseQuery(deliveriesQuery, req.query)));
  });

  return router;
}

const endpointIdParam = idParam('id', 'we');
const eventsOpenApi = {
  type: 'array',
  minItems: 1,
  items: { type: 'string', enum: ['*', ...EVENT_TYPES] },
  description: '`["*"]` for all events, or a list of event types',
};

export const webhooksOpenApi: OpenApiModule = {
  tag: { name: 'Webhooks', description: 'Endpoints that receive signed events, and their delivery log' },
  schemas: {
    WebhookEndpoint: {
      type: 'object',
      required: ['id', 'url', 'events', 'enabled', 'description', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string', example: 'we_b20c1d2e3f405162738495a6b7c8d9e0' },
        url: { type: 'string', example: 'https://acme.test/webhooks/payments' },
        events: eventsOpenApi,
        enabled: { type: 'boolean' },
        description: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    WebhookDelivery: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'whd_e81a…' },
        eventId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'sending', 'succeeded', 'failed'] },
        attempts: { type: 'integer', maximum: 8 },
        lastResponseStatus: { type: ['integer', 'null'] },
        lastError: { type: ['string', 'null'], example: 'HTTP 500' },
        lastAttemptAt: { type: ['string', 'null'], format: 'date-time' },
        nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        completedAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
  },
  paths: {
    '/webhooks': {
      post: {
        summary: 'Register an endpoint (returns the signing secret ONCE)',
        description:
          'URLs must be https and resolve only to public addresses (private, loopback, link-local and reserved ranges are rejected; ' +
          'relaxed with WEBHOOK_ALLOW_INSECURE_URLS=true for local development). ' +
          `At most ${MAX_ENDPOINTS_PER_MERCHANT} endpoints per merchant, and each URL only once (to receive different events at one URL, update that endpoint\'s events). Deliveries are signed: ` +
          '`Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Verify with the secret only (no API key needed).',
        security: secretKeyAuth,
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', maxLength: 2048, example: 'https://acme.test/webhooks/payments' },
            events: eventsOpenApi,
            description: { type: ['string', 'null'], maxLength: 500 },
          },
        }),
        responses: {
          '201': jsonResponse('Endpoint created', {
            allOf: [ref('WebhookEndpoint'), { type: 'object', required: ['secret'], properties: { secret: { type: 'string', example: 'whsec_…' } } }],
          }),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': errorResponse(`\`conflict\`: this URL is already registered (the message names the existing endpoint), or the merchant already has ${MAX_ENDPOINTS_PER_MERCHANT} endpoints`),
          '429': commonErrors['429'],
          '503': commonErrors['503'],
        },
      },
      get: {
        summary: 'List endpoints (never includes secrets)',
        security: secretKeyAuth,
        responses: {
          '200': jsonResponse('Endpoints', { type: 'object', properties: { data: { type: 'array', items: ref('WebhookEndpoint') } } }),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
        },
      },
    },
    '/webhooks/{id}': {
      get: {
        summary: 'Get an endpoint',
        security: secretKeyAuth,
        parameters: [endpointIdParam],
        responses: { '200': jsonResponse('The endpoint', ref('WebhookEndpoint')), '401': commonErrors['401'], '404': errorResponse('Unknown endpoint') },
      },
      patch: {
        summary: 'Update url / events / enabled / description',
        description: 'Disabling stops new deliveries AND marks pending ones failed ("endpoint disabled"); the events remain in GET /events.',
        security: secretKeyAuth,
        parameters: [endpointIdParam],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          properties: { url: { type: 'string' }, events: eventsOpenApi, enabled: { type: 'boolean' }, description: { type: ['string', 'null'] } },
        }),
        responses: { '200': jsonResponse('Updated endpoint', ref('WebhookEndpoint')), '400': commonErrors['400'], '401': commonErrors['401'], '404': errorResponse('Unknown endpoint'), '409': errorResponse('`conflict`: another endpoint already uses this URL') },
      },
      delete: {
        summary: 'Delete an endpoint (pending deliveries are marked failed, not sent)',
        security: secretKeyAuth,
        parameters: [endpointIdParam],
        responses: { '204': { description: 'Deleted' }, '401': commonErrors['401'], '404': errorResponse('Unknown endpoint') },
      },
    },
    '/webhooks/{id}/rotate-secret': {
      post: {
        summary: 'Rotate the signing secret (the old one stops working immediately)',
        security: secretKeyAuth,
        parameters: [endpointIdParam],
        responses: {
          '200': jsonResponse('The new secret, shown once', { type: 'object', properties: { secret: { type: 'string', example: 'whsec_…' } } }),
          '401': commonErrors['401'],
          '404': errorResponse('Unknown endpoint'),
        },
      },
    },
    '/webhooks/{id}/deliveries': {
      get: {
        summary: 'Delivery log for an endpoint',
        security: secretKeyAuth,
        parameters: [endpointIdParam, { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'sending', 'succeeded', 'failed'] } }, ...paginationParams],
        responses: { '200': jsonResponse('Deliveries, newest first', pageOf(ref('WebhookDelivery'))), '400': commonErrors['400'], '401': commonErrors['401'], '404': errorResponse('Unknown endpoint') },
      },
    },
  },
};
