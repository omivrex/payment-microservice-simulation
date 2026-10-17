import { z } from 'zod';
import { passesLuhn } from '../../cardNumber.js';

/**
 * Raw card details as accepted by POST /tokens, POST /cards and POST /payments.
 * The number may contain spaces or dashes; it's normalised to digits only.
 * The CVC is validated for format and then dropped: it is never stored (docs/04-security.md §4.5).
 */
export const cardInputSchema = z.strictObject({
  number: z
    .string({ error: 'must be a valid card number' })
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{12,19}$/.test(v) && passesLuhn(v), { error: 'must be a valid card number' }),
  expMonth: z.number({ error: 'must be an integer from 1 to 12' }).int().min(1, { error: 'must be an integer from 1 to 12' }).max(12, { error: 'must be an integer from 1 to 12' }),
  expYear: z.number({ error: 'must be a 4-digit year' }).int().min(2000, { error: 'must be a 4-digit year' }).max(2100, { error: 'must be a 4-digit year' }),
  cvc: z.string({ error: 'must be 3 or 4 digits' }).regex(/^\d{3,4}$/, { error: 'must be 3 or 4 digits' }),
});

export type CardInput = z.output<typeof cardInputSchema>;

export const customerIdSchema = z.string().trim().min(1).max(100);

export const cardInputOpenApi = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'expMonth', 'expYear', 'cvc'],
  properties: {
    number: { type: 'string', description: 'Spaces and dashes allowed. Must pass the Luhn check.', example: '4242 4242 4242 4242' },
    expMonth: { type: 'integer', minimum: 1, maximum: 12, example: 12 },
    expYear: { type: 'integer', minimum: 2000, maximum: 2100, example: 2030 },
    cvc: { type: 'string', pattern: '^\\d{3,4}$', description: 'Checked for format, then discarded. Never stored.', example: '123' },
  },
};
