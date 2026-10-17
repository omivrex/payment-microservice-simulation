import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Keyed hashing with domain-separated sub-keys derived from HASHING_SECRET.
 * See docs/04-security.md §4.3–4.4.
 */
export class Hasher {
  readonly #apiKeyKey: Buffer;
  readonly #fingerprintKey: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('HASHING_SECRET must be at least 32 bytes');
    this.#apiKeyKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'api-key-hash', 32));
    this.#fingerprintKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'card-fingerprint', 32));
  }

  hashApiKeySecret(secret: string): string {
    return createHmac('sha256', this.#apiKeyKey).update(secret).digest('hex');
  }

  fingerprintCard(cardNumber: string): string {
    return createHmac('sha256', this.#fingerprintKey).update(cardNumber).digest('hex');
  }
}

/** Constant-time string comparison. Different lengths return false instead of throwing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep the work roughly constant
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** 256 bits of randomness, base64url (43 chars). */
export const randomSecret = (): string => randomBytes(32).toString('base64url');

export const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

/** JSON with object keys sorted recursively, so equivalent bodies hash the same (docs/05-api.md §5.1). */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, normalize((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value) ?? null);
}
