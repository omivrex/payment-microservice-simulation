import { Router } from 'express';
import { z } from 'zod';
import {
  commonErrors,
  errorResponse,
  idempotencyHeader,
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
import { cardInputSchema, customerIdSchema } from './cardInput.js';

const saveCardSchema = z
  .strictObject({
    token: z.string().min(1).max(100).optional(),
    card: cardInputSchema.optional(),
    customerId: customerIdSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.token === undefined) === (v.card === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['token'], message: 'exactly one of token or card is required' });
    }
  });

const listQuery = z.strictObject({ customerId: customerIdSchema.optional(), ...paginationQuery });

export function cardsRouter({ services, auth, idempotency }: RouteDeps): Router {
  const router = Router();

  route(router, 'post', '/cards', ...auth.secret, idempotency, async (req, res) => {
    const body = parseBody(saveCardSchema, req.body);
    const customerId = body.customerId ?? null;
    const input = body.token !== undefined ? { token: body.token, customerId } : { card: body.card!, customerId };
    const { card, created } = await services.cards.save(req.auth!.merchantId, input);
    res.status(created ? 201 : 200).json(card);
  });

  route(router, 'get', '/cards', ...auth.secret, (req, res) => {
    res.json(services.cards.list(req.auth!.merchantId, parseQuery(listQuery, req.query)));
  });

  route(router, 'get', '/cards/:id', ...auth.secret, (req, res) => {
    res.json(services.cards.get(req.auth!.merchantId, req.params.id as string));
  });

  route(router, 'delete', '/cards/:id', ...auth.secret, async (req, res) => {
    await services.cards.delete(req.auth!.merchantId, req.params.id as string);
    res.status(204).end();
  });

  return router;
}

const cardIdParam = idParam('id', 'card');

export const cardsOpenApi: OpenApiModule = {
  tag: { name: 'Cards', description: 'Saved cards (the encrypted vault)' },
  schemas: {
    Card: {
      type: 'object',
      required: ['id', 'customerId', 'brand', 'last4', 'expMonth', 'expYear', 'createdAt'],
      properties: {
        id: { type: 'string', example: 'card_9f2e1d0c3b4a5968778695a4b3c2d1e0' },
        customerId: { type: ['string', 'null'], example: 'cus_from_my_system_42' },
        brand: { type: 'string', enum: ['visa', 'mastercard', 'amex', 'discover', 'unknown'] },
        last4: { type: 'string', example: '4242' },
        expMonth: { type: 'integer' },
        expYear: { type: 'integer' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  paths: {
    '/cards': {
      post: {
        summary: 'Save a card (from a token or raw details)',
        description:
          'Exactly one of `token` or `card`. If this `customerId` (including "no customer") already saved the same card, ' +
          'the existing card is returned with **200** instead of creating a duplicate.',
        security: secretKeyAuth,
        parameters: [idempotencyHeader],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string', example: 'tok_51d0a9c8e7f6b5a4c3d2e1f0a9b8c7d6' },
            card: ref('CardInput'),
            customerId: { type: ['string', 'null'], maxLength: 100, example: 'cus_from_my_system_42' },
          },
        }),
        responses: {
          '201': jsonResponse('Card saved', ref('Card')),
          '200': jsonResponse('This customer already has this card: the existing card is returned', ref('Card')),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': errorResponse('`idempotency_in_progress`'),
          '422': errorResponse('`idempotency_key_reused`'),
          '429': commonErrors['429'],
          '500': commonErrors['500'],
          '503': commonErrors['503'],
        },
      },
      get: {
        summary: 'List saved cards',
        security: secretKeyAuth,
        parameters: [{ name: 'customerId', in: 'query', schema: { type: 'string' } }, ...paginationParams],
        responses: {
          '200': jsonResponse('Saved cards, newest first', pageOf(ref('Card'))),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '429': commonErrors['429'],
        },
      },
    },
    '/cards/{id}': {
      get: {
        summary: 'Get a saved card',
        security: secretKeyAuth,
        parameters: [cardIdParam],
        responses: {
          '200': jsonResponse('The card', ref('Card')),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': errorResponse('Unknown card, or another merchant’s card'),
        },
      },
      delete: {
        summary: 'Delete a saved card (permanently removes the encrypted number)',
        description: 'Payments made with the card keep their display snapshot (brand, last 4).',
        security: secretKeyAuth,
        parameters: [cardIdParam],
        responses: {
          '204': { description: 'Deleted' },
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': errorResponse('Unknown card, or another merchant’s card'),
          '409': errorResponse('`conflict`: a pending payment is still waiting to be authorized with this card'),
          '503': commonErrors['503'],
        },
      },
    },
  },
};
