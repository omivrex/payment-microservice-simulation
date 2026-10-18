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
import { ValidationError } from '../../errors.js';
import { storeResponse } from '../../http/middleware/idempotency.js';
import type { RouteDeps } from '../../http/routeDeps.js';
import { paginationQuery, parseBody, parseOptionalBody, parseQuery } from '../../http/validate.js';
import { cardInputSchema, customerIdSchema } from '../cards/cardInput.js';
import { MAX_METADATA_KEYS, type CardSource } from './service.js';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NGN', 'JPY'] as const;
export const PAYMENT_STATUSES = ['pending', 'authorized', 'capturing', 'captured', 'refunding', 'partially_refunded', 'refunded', 'cancelling', 'cancelled', 'failed'] as const;
const MAX_AMOUNT = 99_999_999;

/** Old field names on payment requests, answered with what to use instead. */
const RENAMED = { amount: "has been renamed to amountMinor: an integer in the currency's minor unit (2500 = $25.00)" };

/** Shared wording so every amount field in the API docs says exactly what unit it is in. */
const MINOR_UNITS =
  "Integer in the currency's minor (smallest) unit: 2500 USD = $25.00, 1050 EUR = €10.50. " +
  'JPY has no minor unit, so 2500 JPY = ¥2500. Decimals are rejected.';

const amountSchema = z
  .number({ error: `must be a positive integer in minor units (max ${MAX_AMOUNT})` })
  .int({ error: `must be a positive integer in minor units (max ${MAX_AMOUNT})` })
  .min(1, { error: `must be a positive integer in minor units (max ${MAX_AMOUNT})` })
  .max(MAX_AMOUNT, { error: `must be a positive integer in minor units (max ${MAX_AMOUNT})` });

const metadataKey = z.string().min(1, { error: 'keys must be 1 to 40 characters' }).max(40, { error: 'keys must be 1 to 40 characters' });
const tooManyKeys = (v: Record<string, unknown>) => Object.keys(v).length <= MAX_METADATA_KEYS;
const metadataSchema = z
  .record(metadataKey, z.string({ error: 'values must be strings' }).max(500, { error: 'values must be at most 500 characters' }))
  .refine(tooManyKeys, { error: `must have at most ${MAX_METADATA_KEYS} keys` });
const metadataPatchSchema = z
  .record(metadataKey, z.string({ error: 'values must be strings or null' }).max(500, { error: 'values must be at most 500 characters' }).nullable())
  .refine(tooManyKeys, { error: `must have at most ${MAX_METADATA_KEYS} keys` });
const descriptionSchema = z.string().max(500).nullable();

const createSchema = z
  .strictObject({
    amountMinor: amountSchema,
    currency: z
      .string({ error: `must be one of: ${CURRENCIES.join(', ')}` })
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(CURRENCIES, { error: `must be one of: ${CURRENCIES.join(', ')}` })),
    token: z.string().min(1).max(100).optional(),
    cardId: z.string().min(1).max(100).optional(),
    card: cardInputSchema.optional(),
    saveCard: z.boolean().optional(),
    customerId: customerIdSchema.nullable().optional(),
    captureMethod: z.enum(['automatic', 'manual']).optional(),
    description: descriptionSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const sources = [v.token, v.cardId, v.card].filter((s) => s !== undefined).length;
    if (sources !== 1) ctx.addIssue({ code: 'custom', path: ['token'], message: 'exactly one of token, cardId or card is required' });
    if (v.saveCard && v.cardId !== undefined) ctx.addIssue({ code: 'custom', path: ['saveCard'], message: 'cannot be used with cardId (the card is already saved)' });
  });

const updateSchema = z.strictObject({ description: descriptionSchema.optional(), metadata: metadataPatchSchema.optional() });

const amountBodySchema = z.strictObject({ amountMinor: amountSchema.optional() });
const emptyBodySchema = z.strictObject({});

const listSchema = z.strictObject({
  status: z.enum(PAYMENT_STATUSES).optional(),
  customerId: customerIdSchema.optional(),
  ...paginationQuery,
});

export function paymentsRouter({ services, auth, idempotency }: RouteDeps): Router {
  const router = Router();

  route(router, 'post', '/payments', ...auth.secret, idempotency, async (req, res) => {
    const body = parseBody(createSchema, req.body, RENAMED);
    const source: CardSource = body.token !== undefined ? { token: body.token } : body.cardId !== undefined ? { cardId: body.cardId } : { card: body.card! };
    const payment = await services.payments.create(
      req.auth!.merchantId,
      {
        amountMinor: body.amountMinor,
        currency: body.currency,
        source,
        saveCard: body.saveCard ?? false,
        customerId: body.customerId ?? null,
        captureMethod: body.captureMethod ?? 'automatic',
        description: body.description ?? null,
        metadata: body.metadata ?? {},
      },
      req.requestId,
      storeResponse(req, 202),
    );
    res.status(202).json(payment);
  });

  route(router, 'get', '/payments', ...auth.secret, (req, res) => {
    res.json(services.payments.list(req.auth!.merchantId, parseQuery(listSchema, req.query)));
  });

  route(router, 'get', '/payments/:id', ...auth.secret, (req, res) => {
    res.json(services.payments.get(req.auth!.merchantId, req.params.id as string));
  });

  route(router, 'patch', '/payments/:id', ...auth.secret, async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    // Checked after the strict parse so unknown fields are reported on their own.
    if (body.description === undefined && body.metadata === undefined) {
      throw new ValidationError([{ field: 'body', message: 'must include at least one of: description, metadata' }]);
    }
    res.json(await services.payments.update(req.auth!.merchantId, req.params.id as string, body));
  });

  route(router, 'post', '/payments/:id/capture', ...auth.secret, idempotency, async (req, res) => {
    const { amountMinor } = parseOptionalBody(amountBodySchema, req.body, RENAMED);
    res.status(202).json(await services.payments.capture(req.auth!.merchantId, req.params.id as string, amountMinor, req.requestId, storeResponse(req, 202)));
  });

  route(router, 'post', '/payments/:id/refund', ...auth.secret, idempotency, async (req, res) => {
    const { amountMinor } = parseOptionalBody(amountBodySchema, req.body, RENAMED);
    res.status(202).json(await services.payments.refund(req.auth!.merchantId, req.params.id as string, amountMinor, req.requestId, storeResponse(req, 202)));
  });

  route(router, 'post', '/payments/:id/cancel', ...auth.secret, idempotency, async (req, res) => {
    parseOptionalBody(emptyBodySchema, req.body);
    res.status(202).json(await services.payments.cancel(req.auth!.merchantId, req.params.id as string, req.requestId, storeResponse(req, 202)));
  });

  return router;
}

// ---------------------------------------------------------------- OpenAPI

const paymentIdParam = idParam('id', 'pay');
const actionErrors = {
  '400': commonErrors['400'],
  '401': commonErrors['401'],
  '403': commonErrors['403'],
  '404': errorResponse('Unknown payment, or another merchant’s payment'),
  '409': errorResponse('`invalid_state`: not allowed in the current status (or another action is in flight); `idempotency_in_progress`'),
  '422': errorResponse('`idempotency_key_reused`'),
  '429': commonErrors['429'],
  '500': commonErrors['500'],
  '503': commonErrors['503'],
};
const amountBody = jsonBody(
  { type: 'object', additionalProperties: false, properties: { amountMinor: { type: 'integer', minimum: 1, maximum: MAX_AMOUNT, description: MINOR_UNITS, example: 1000 } } },
  false,
);

export const paymentsOpenApi: OpenApiModule = {
  tag: { name: 'Payments', description: 'Create payments and request capture/refund/cancel. All processing is asynchronous.' },
  schemas: {
    Payment: {
      type: 'object',
      required: ['id', 'status', 'amountMinor', 'currency', 'captureMethod', 'amountCapturedMinor', 'amountRefundedMinor', 'customerId', 'description', 'metadata', 'paymentMethod', 'authorizationCode', 'failure', 'pendingAction', 'history', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string', example: 'pay_3f9c0a1b2c3d4e5f60718293a4b5c6d7' },
        status: { type: 'string', enum: PAYMENT_STATUSES },
        amountMinor: { type: 'integer', description: `Authorized/requested amount. ${MINOR_UNITS}`, example: 2500 },
        currency: { type: 'string', enum: CURRENCIES },
        captureMethod: { type: 'string', enum: ['automatic', 'manual'] },
        amountCapturedMinor: { type: 'integer', description: `Amount captured so far. ${MINOR_UNITS}`, example: 2500 },
        amountRefundedMinor: { type: 'integer', description: `Amount refunded so far. ${MINOR_UNITS}`, example: 0 },
        customerId: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
        paymentMethod: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'card' },
            cardId: { type: ['string', 'null'], description: 'Set only once the card is saved' },
            brand: { type: 'string' },
            last4: { type: 'string' },
            expMonth: { type: 'integer' },
            expYear: { type: 'integer' },
          },
        },
        authorizationCode: { type: ['string', 'null'] },
        failure: { type: ['object', 'null'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
        pendingAction: {
          type: ['object', 'null'],
          description: 'The action in flight (one at a time)',
          properties: { type: { type: 'string', enum: ['authorize', 'capture', 'refund', 'cancel'] }, amountMinor: { type: ['integer', 'null'], description: `Amount of the action in flight, in minor units (null for authorize/cancel)` }, requestedAt: { type: 'string', format: 'date-time' } },
        },
        history: {
          type: 'array',
          items: { type: 'object', properties: { type: { type: 'string' }, at: { type: 'string', format: 'date-time' }, amountMinor: { type: 'integer', description: 'Amount of this step, in minor units' }, code: { type: 'string' } } },
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  paths: {
    '/payments': {
      post: {
        summary: 'Create a payment (asynchronous: returns 202 with status "pending")',
        description:
          'Exactly one card source: `token` (recommended, from POST /tokens), `cardId` (a saved card) or `card` (raw details, secret key only). ' +
          'The outcome arrives by webhook or by polling GET /payments/{id}. `saveCard` saves the card **only if the authorization is approved**. ' +
          'Test cards: 4000000000000002 declined, …9995 insufficient funds, …0069 expired, …0127 incorrect CVC, …0119 processing error (retried, then failed).',
        security: secretKeyAuth,
        parameters: [idempotencyHeader],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['amountMinor', 'currency'],
          properties: {
            amountMinor: { type: 'integer', minimum: 1, maximum: MAX_AMOUNT, description: MINOR_UNITS, example: 2500 },
            currency: { type: 'string', enum: CURRENCIES, description: 'Case-insensitive', example: 'usd' },
            token: { type: 'string' },
            cardId: { type: 'string' },
            card: ref('CardInput'),
            saveCard: { type: 'boolean', default: false },
            customerId: { type: ['string', 'null'], maxLength: 100 },
            captureMethod: { type: 'string', enum: ['automatic', 'manual'], default: 'automatic' },
            description: { type: ['string', 'null'], maxLength: 500 },
            metadata: { type: 'object', maxProperties: MAX_METADATA_KEYS, additionalProperties: { type: 'string', maxLength: 500 } },
          },
        }),
        responses: {
          '202': jsonResponse('Accepted for processing', ref('Payment')),
          '400': commonErrors['400'],
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': errorResponse('Unknown `cardId`'),
          '409': errorResponse('`idempotency_in_progress`'),
          '422': errorResponse('`idempotency_key_reused`'),
          '429': commonErrors['429'],
          '500': commonErrors['500'],
          '503': commonErrors['503'],
        },
      },
      get: {
        summary: 'List payments',
        security: secretKeyAuth,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: PAYMENT_STATUSES } },
          { name: 'customerId', in: 'query', schema: { type: 'string' } },
          ...paginationParams,
        ],
        responses: { '200': jsonResponse('Payments, newest first', pageOf(ref('Payment'))), '400': commonErrors['400'], '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/payments/{id}': {
      get: {
        summary: 'Get a payment',
        security: secretKeyAuth,
        parameters: [paymentIdParam],
        responses: { '200': jsonResponse('The payment', ref('Payment')), '401': commonErrors['401'], '403': commonErrors['403'], '404': errorResponse('Unknown payment, or another merchant’s payment') },
      },
      patch: {
        summary: 'Update description and/or metadata (merged; null deletes a key)',
        description: 'Allowed in every status. Status and amounts can only change through capture/refund/cancel. Emits payment.updated.',
        security: secretKeyAuth,
        parameters: [paymentIdParam],
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: ['string', 'null'], maxLength: 500 },
            metadata: { type: 'object', additionalProperties: { type: ['string', 'null'], maxLength: 500 } },
          },
        }),
        responses: { '200': jsonResponse('Updated payment', ref('Payment')), '400': commonErrors['400'], '401': commonErrors['401'], '403': commonErrors['403'], '404': errorResponse('Unknown payment'), '503': commonErrors['503'] },
      },
    },
    '/payments/{id}/capture': {
      post: {
        summary: 'Request capture (status must be "authorized")',
        description: '`amountMinor` (minor units) defaults to the full authorized amount; partial capture releases the rest. Returns 202 with status "capturing".',
        security: secretKeyAuth,
        parameters: [paymentIdParam, idempotencyHeader],
        requestBody: amountBody,
        responses: { '202': jsonResponse('Capture queued', ref('Payment')), ...actionErrors },
      },
    },
    '/payments/{id}/refund': {
      post: {
        summary: 'Request a refund (status "captured" or "partially_refunded")',
        description: '`amountMinor` (minor units) defaults to everything still refundable (captured − refunded). Returns 202 with status "refunding".',
        security: secretKeyAuth,
        parameters: [paymentIdParam, idempotencyHeader],
        requestBody: amountBody,
        responses: { '202': jsonResponse('Refund queued', ref('Payment')), ...actionErrors },
      },
    },
    '/payments/{id}/cancel': {
      post: {
        summary: 'Request cancellation (status must be "authorized")',
        description: 'Not allowed while "pending": wait for "authorized". Returns 202 with status "cancelling".',
        security: secretKeyAuth,
        parameters: [paymentIdParam, idempotencyHeader],
        responses: { '202': jsonResponse('Cancellation queued', ref('Payment')), ...actionErrors },
      },
    },
  },
};
