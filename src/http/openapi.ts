/**
 * OpenAPI 3.1 document, assembled from per-module definitions and served at
 * GET /openapi.json and GET /docs (Swagger UI).
 *
 * Every route registered through `route()` is recorded, and a test checks that
 * each one has a matching OpenAPI operation (and vice versa), so docs can't drift.
 */
import type { RequestHandler, Router } from 'express';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface OpenApiModule {
  tag: { name: string; description: string };
  paths: Record<string, Partial<Record<HttpMethod, Record<string, unknown>>>>;
  schemas?: Record<string, unknown>;
}

const registered: Array<{ method: HttpMethod; path: string }> = [];

/** Registers an Express route and records it for the docs-coverage test. Path uses Express syntax (`/payments/:id`). */
export function route(router: Router, method: HttpMethod, path: string, ...handlers: RequestHandler[]): void {
  if (!registered.some((r) => r.method === method && r.path === path)) registered.push({ method, path });
  router[method](path, ...handlers);
}

export const registeredRoutes = (): ReadonlyArray<{ method: HttpMethod; path: string }> => registered;

/** `/payments/:id` → `/payments/{id}` */
export const toOpenApiPath = (expressPath: string): string => expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

// ---------------------------------------------------------------- helpers for module definitions

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const jsonBody = (schema: unknown, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

export const jsonResponse = (description: string, schema: unknown, headers?: Record<string, unknown>) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema } },
});

export const errorResponse = (description: string) => jsonResponse(description, ref('Error'));

export const idParam = (name: string, prefix: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: `^${prefix}_[0-9a-f]{32}$` },
});

export const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Makes the request safe to retry. See docs/05-api.md §5.1.',
  schema: { type: 'string', minLength: 1, maxLength: 255 },
};

export const paginationParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
];

export const pageOf = (itemSchema: unknown) => ({
  type: 'object',
  required: ['data', 'total', 'limit', 'offset'],
  properties: {
    data: { type: 'array', items: itemSchema },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
});

export const commonErrors = {
  '400': errorResponse('Invalid input (`validation_error`, `invalid_json`)'),
  '401': errorResponse('Missing, malformed, unknown or revoked API key'),
  '403': errorResponse('Valid key of the wrong type for this endpoint'),
  '413': errorResponse('Request body over 100 kb'),
  '429': errorResponse('Rate limited. See `Retry-After`'),
  '500': errorResponse('Unexpected failure. Quote the requestId'),
  '503': errorResponse('Temporary storage failure, nothing changed. See `Retry-After`'),
};

export const secretKeyAuth = [{ secretKey: [] }];
export const anyKeyAuth = [{ secretKey: [] }, { publishableKey: [] }];

// ---------------------------------------------------------------- document

export function buildOpenApiDocument(modules: OpenApiModule[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {
    Error: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'requestId'],
          properties: {
            code: { type: 'string', description: 'Stable, machine-readable code. Branch on this.' },
            message: { type: 'string', description: 'Human-readable. May be reworded.' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                required: ['field', 'message'],
                properties: { field: { type: 'string' }, message: { type: 'string' } },
              },
            },
            requestId: { type: 'string', description: 'Quote this when reporting a problem.' },
          },
        },
      },
      example: {
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          details: [{ field: 'amount', message: 'is required' }],
          requestId: 'req_1b7f0c9e2d4a4f3b8c6d5e7f9a0b1c2d',
        },
      },
    },
  };

  for (const mod of modules) {
    for (const [p, ops] of Object.entries(mod.paths)) {
      paths[p] = { ...(paths[p] ?? {}) };
      for (const [method, op] of Object.entries(ops)) {
        paths[p]![method] = { tags: [mod.tag.name], ...op };
      }
    }
    Object.assign(schemas, mod.schemas ?? {});
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Payment Service (simulator)',
      version: '0.1.0',
      description:
        'Simulated card payment processing. Amounts are integers in minor units. ' +
        'Every response carries `X-Request-Id`. Design docs live in `docs/` in the repository.',
    },
    servers: [{ url: '/' }],
    tags: modules.map((m) => m.tag),
    paths,
    components: {
      schemas,
      securitySchemes: {
        secretKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'sk_test_…',
          description: 'Secret key. Server-side only. Can do everything except sign-up.',
        },
        publishableKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'pk_test_…',
          description: 'Publishable key. Safe for browsers. Can only create card tokens.',
        },
      },
    },
  };
}
