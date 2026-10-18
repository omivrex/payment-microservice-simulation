import { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../errors.js';

/**
 * Request validation. Messages are always ours and never contain the received
 * value, because the value may be the secret (docs/08-error-handling.md §8.4).
 */

z.config({
  customError: (iss) => {
    switch (iss.code) {
      case 'invalid_type':
        return iss.input === undefined ? 'is required' : `must be ${iss.expected === 'int' ? 'an integer' : `a ${iss.expected}`}`;
      case 'too_small':
        if (iss.origin === 'string') return `must be at least ${iss.minimum} characters`;
        if (iss.origin === 'array') return `must contain at least ${iss.minimum} items`;
        return `must be at least ${iss.minimum}`;
      case 'too_big':
        if (iss.origin === 'string') return `must be at most ${iss.maximum} characters`;
        if (iss.origin === 'array') return `must contain at most ${iss.maximum} items`;
        if (iss.origin === 'object') return `must have at most ${iss.maximum} keys`;
        return `must be at most ${iss.maximum}`;
      case 'invalid_format':
        return iss.format === 'email' ? 'must be a valid email address' : 'is not in a valid format';
      case 'invalid_value':
        return `must be one of: ${iss.values.map(String).join(', ')}`;
      default:
        return 'is invalid';
    }
  },
});

/** Per-endpoint messages for renamed fields: sending the old name explains what to use instead. */
export type RenamedFields = Record<string, string>;

function toDetails(error: z.ZodError, renamed: RenamedFields = {}): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of error.issues) {
    const parent = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        details.push({ field: parent ? `${parent}.${key}` : key, message: renamed[key] ?? 'is not a recognized field' });
      }
    } else {
      details.push({ field: parent || 'body', message: issue.message });
    }
  }
  return details;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseBody<S extends z.ZodType>(schema: S, body: unknown, renamed?: RenamedFields): z.output<S> {
  if (!isPlainObject(body)) throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  return parseWith(schema, body, renamed);
}

/** Body that may be omitted entirely (treated as {}). */
export function parseOptionalBody<S extends z.ZodType>(schema: S, body: unknown, renamed?: RenamedFields): z.output<S> {
  return parseBody(schema, body === undefined || body === null ? {} : body, renamed);
}

export function parseQuery<S extends z.ZodType>(schema: S, query: unknown): z.output<S> {
  return parseWith(schema, query ?? {});
}

function parseWith<S extends z.ZodType>(schema: S, input: unknown, renamed?: RenamedFields): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(toDetails(result.error, renamed));
  return result.data;
}

// ---------------------------------------------------------------- shared schemas

/** Query-string integer within bounds (query values arrive as strings; repeated params as arrays). */
export const queryInt = (min: number, max: number, fallback: number) =>
  z
    .string({ error: 'must be a single value' })
    .regex(/^\d+$/, { error: `must be an integer between ${min} and ${max}` })
    .transform(Number)
    .pipe(z.number().int().min(min, { error: `must be an integer between ${min} and ${max}` }).max(max, { error: `must be an integer between ${min} and ${max}` }))
    .optional()
    .transform((v) => v ?? fallback);

export const paginationQuery = {
  limit: queryInt(1, 100, 20),
  offset: queryInt(0, 1_000_000_000, 0),
};

export interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Newest first, ties broken by id descending so paging is deterministic (docs/05-api.md §5.1). */
export function paginate<T extends { createdAt: string; id: string }>(items: T[], limit: number, offset: number): Page<T> {
  const sorted = [...items].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1,
  );
  return { data: sorted.slice(offset, offset + limit), total: sorted.length, limit, offset };
}
