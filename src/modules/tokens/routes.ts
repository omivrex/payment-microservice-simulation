import { Router } from 'express';
import { z } from 'zod';
import {
  anyKeyAuth,
  commonErrors,
  idempotencyHeader,
  jsonBody,
  jsonResponse,
  ref,
  route,
  type OpenApiModule,
} from '../../http/openapi.js';
import { storeResponse } from '../../http/middleware/idempotency.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { parseBody } from '../../http/validate.js';
import { cardInputOpenApi, cardInputSchema } from '../cards/cardInput.js';

const createTokenSchema = z.strictObject({ card: cardInputSchema });

export function tokensRouter({ services, auth, tokensLimiter, idempotency }: RouteDeps): Router {
  const router = Router();

  route(router, 'post', '/tokens', ...auth.any, tokensLimiter, idempotency, async (req, res) => {
    const { card } = parseBody(createTokenSchema, req.body);
    res.status(201).json(await services.tokens.create(req.auth!.merchantId, card, storeResponse(req, 201)));
  });

  return router;
}

export const tokensOpenApi: OpenApiModule = {
  tag: { name: 'Tokens', description: 'Client-side card tokenization (publishable key)' },
  schemas: {
    CardInput: cardInputOpenApi,
    Token: {
      type: 'object',
      required: ['id', 'card', 'expiresAt', 'createdAt'],
      properties: {
        id: { type: 'string', example: 'tok_51d0a9c8e7f6b5a4c3d2e1f0a9b8c7d6' },
        card: {
          type: 'object',
          required: ['brand', 'last4', 'expMonth', 'expYear'],
          properties: {
            brand: { type: 'string', enum: ['visa', 'mastercard', 'amex', 'discover', 'unknown'] },
            last4: { type: 'string', example: '4242' },
            expMonth: { type: 'integer' },
            expYear: { type: 'integer' },
          },
        },
        expiresAt: { type: 'string', format: 'date-time', description: '15 minutes after creation' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  paths: {
    '/tokens': {
      post: {
        summary: 'Tokenize a card (single use, expires in 15 minutes)',
        description:
          'Call this from the browser with the **publishable** key, so the card number never touches the merchant server. ' +
          'Validates the Luhn check, expiry and CVC format. Whether the card is approved is decided later, asynchronously. ' +
          'Rate-limited per key (default 60/min). The response never contains the number or CVC.',
        security: anyKeyAuth,
        parameters: [idempotencyHeader],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['card'],
          properties: { card: ref('CardInput') },
        }),
        responses: {
          '201': jsonResponse('Token created', ref('Token')),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '409': jsonResponse('`idempotency_in_progress`', ref('Error')),
          '422': jsonResponse('`idempotency_key_reused`', ref('Error')),
          '429': commonErrors['429'],
          '500': commonErrors['500'],
          '503': commonErrors['503'],
        },
      },
    },
  },
};
