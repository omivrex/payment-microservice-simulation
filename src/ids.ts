import { randomUUID } from 'node:crypto';

/** ID prefixes, see docs/02-data-model.md §2.1. */
export type IdPrefix = 'mer' | 'tok' | 'card' | 'pay' | 'job' | 'evt' | 'we' | 'whd' | 'req';

export const newId = (prefix: IdPrefix): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export const isId = (prefix: IdPrefix, value: unknown): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value);
