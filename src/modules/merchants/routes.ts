import { Router } from 'express';
import { z } from 'zod';
import { signupLimiter } from '../../http/middleware/rateLimit.js';
import {
  commonErrors,
  errorResponse,
  jsonBody,
  jsonResponse,
  ref,
  route,
  secretKeyAuth,
  type OpenApiModule,
} from '../../http/openapi.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { parseBody } from '../../http/validate.js';

const signUpSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).pipe(z.email()),
});

export function merchantsRouter({ ctx, services, auth }: RouteDeps): Router {
  const router = Router();

  // Intentionally unauthenticated: user authentication is out of scope (docs/README.md).
  route(router, 'post', '/merchants', signupLimiter(ctx.config.rateLimits.signupPerHour), async (req, res) => {
    const result = await services.merchants.signUp(parseBody(signUpSchema, req.body));
    res.status(201).json(result);
  });

  route(router, 'get', '/merchants/me', ...auth.secret, (req, res) => {
    res.json(services.merchants.get(req.auth!.merchantId));
  });

  return router;
}

export const merchantsOpenApi: OpenApiModule = {
  tag: { name: 'Merchants', description: 'Sign-up and the current merchant' },
  schemas: {
    Merchant: {
      type: 'object',
      required: ['id', 'name', 'email', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string', example: 'mer_7c1e9a0b2c3d4e5f60718293a4b5c6d7' },
        name: { type: 'string', example: 'Acme Store' },
        email: { type: 'string', format: 'email', example: 'dev@acme.test' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  paths: {
    '/merchants': {
      post: {
        summary: 'Sign up (intentionally unauthenticated)',
        description:
          '**Open sign-up is intentional**: user authentication is outside this project’s scope (see docs/README.md). ' +
          'Returns the merchant and its first key pair. The secret key is shown **only here**. ' +
          'Rate-limited per IP (default 5/hour). Emails are unique, compared case-insensitively.',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100, example: 'Acme Store' },
            email: { type: 'string', format: 'email', maxLength: 254, example: 'dev@acme.test' },
          },
        }),
        responses: {
          '201': jsonResponse('Merchant created', {
            type: 'object',
            required: ['merchant', 'apiKeys'],
            properties: {
              merchant: ref('Merchant'),
              apiKeys: {
                type: 'object',
                required: ['publishable', 'secret'],
                properties: {
                  publishable: { type: 'string', example: 'pk_test_4f1a9c0d2b3e5f60_Qm9vb…' },
                  secret: { type: 'string', example: 'sk_test_a81b77c2d4e09f13_Zx3Lr…' },
                },
              },
            },
          }),
          '400': commonErrors['400'],
          '409': errorResponse('`conflict`: email already registered'),
          '429': commonErrors['429'],
          '500': commonErrors['500'],
          '503': commonErrors['503'],
        },
      },
    },
    '/merchants/me': {
      get: {
        summary: 'The merchant that owns the calling key',
        security: secretKeyAuth,
        responses: {
          '200': jsonResponse('The merchant', ref('Merchant')),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '429': commonErrors['429'],
          '500': commonErrors['500'],
        },
      },
    },
  },
};
