import { Router } from 'express';
import { z } from 'zod';
import {
  commonErrors,
  jsonBody,
  jsonResponse,
  ref,
  route,
  secretKeyAuth,
  type OpenApiModule,
} from '../../http/openapi.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { parseBody } from '../../http/validate.js';

const rotateSchema = z.strictObject({ type: z.enum(['secret', 'publishable']) });

export function apiKeysRouter({ services, auth }: RouteDeps): Router {
  const router = Router();

  route(router, 'get', '/api-keys', ...auth.secret, (req, res) => {
    res.json({ data: services.apiKeys.list(req.auth!.merchantId) });
  });

  route(router, 'post', '/api-keys/rotate', ...auth.secret, async (req, res) => {
    const { type } = parseBody(rotateSchema, req.body);
    res.json(await services.apiKeys.rotate(req.auth!.merchantId, type));
  });

  return router;
}

export const apiKeysOpenApi: OpenApiModule = {
  tag: { name: 'API keys', description: 'List and rotate publishable/secret keys' },
  schemas: {
    ApiKey: {
      type: 'object',
      required: ['id', 'type', 'status', 'key', 'createdAt', 'revokedAt'],
      properties: {
        id: { type: 'string', example: 'key_4f1a9c0d2b3e5f60' },
        type: { type: 'string', enum: ['publishable', 'secret'] },
        status: { type: 'string', enum: ['active', 'revoked'] },
        key: {
          type: 'string',
          description: 'Full key for publishable keys; only the last 4 characters for secret keys (except in the rotate response).',
          example: 'sk_test_…r9Xa',
        },
        createdAt: { type: 'string', format: 'date-time' },
        revokedAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
  },
  paths: {
    '/api-keys': {
      get: {
        summary: 'List keys (including revoked ones, for audit)',
        security: secretKeyAuth,
        responses: {
          '200': jsonResponse('Keys, newest first', {
            type: 'object',
            required: ['data'],
            properties: { data: { type: 'array', items: ref('ApiKey') } },
          }),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '429': commonErrors['429'],
          '500': commonErrors['500'],
        },
      },
    },
    '/api-keys/rotate': {
      post: {
        summary: 'Rotate a key: the old key of that type is revoked IMMEDIATELY',
        description:
          'Issues a new key and revokes the previous active key of the same type in one transaction. ' +
          'There is no grace period: anything still using the old key gets 401 from the next request. ' +
          'Rotating the secret key you are calling with is allowed; the response carries the new key. ' +
          'Not idempotent: the response contains a secret that is never stored.',
        security: secretKeyAuth,
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { type: 'string', enum: ['secret', 'publishable'] } },
        }),
        responses: {
          '200': jsonResponse('The new key, shown in full this once', ref('ApiKey')),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '429': commonErrors['429'],
          '500': commonErrors['500'],
          '503': commonErrors['503'],
        },
      },
    },
  },
};
