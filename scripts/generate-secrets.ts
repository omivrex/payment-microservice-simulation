import { randomBytes } from 'node:crypto';

/** Prints freshly generated secrets for a local .env file. See docs/01-architecture.md §1.6. */
const key = randomBytes(32).toString('base64');
const hashing = randomBytes(32).toString('base64');

console.log(`# Generated ${new Date().toISOString()}. Keep these secret. Never commit them.
ENCRYPTION_KEYS=v1:${key}
ENCRYPTION_ACTIVE_KEY_ID=v1
HASHING_SECRET=${hashing}`);
