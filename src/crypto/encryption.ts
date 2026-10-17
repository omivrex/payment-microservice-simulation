import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecurityError } from '../errors.js';

/**
 * AES-256-GCM field encryption with key versions and AAD.
 * Stored format: `<keyId>:<iv b64>:<authTag b64>:<ciphertext b64>`.
 * See docs/04-security.md §4.4.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** AAD binding a ciphertext to its record and field, e.g. `cards:card_123:number`. */
export const aadFor = (collection: string, recordId: string, field: string): string =>
  `${collection}:${recordId}:${field}`;

export class Encryptor {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #activeKeyId: string;

  constructor(keys: ReadonlyMap<string, Buffer>, activeKeyId: string) {
    const active = keys.get(activeKeyId);
    if (!active) throw new Error(`Active encryption key ${activeKeyId} is not configured`);
    for (const [id, key] of keys) {
      if (key.length !== 32) throw new Error(`Encryption key ${id} must be 32 bytes`);
    }
    this.#keys = keys;
    this.#activeKeyId = activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.#keys.get(this.#activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [this.#activeKeyId, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string, aad: string): string {
    const parts = typeof payload === 'string' ? payload.split(':') : [];
    if (parts.length !== 4) throw new SecurityError('Malformed ciphertext');
    const [keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    if (![ivB64, tagB64, ctB64].every((p) => B64.test(p))) throw new SecurityError('Malformed ciphertext');

    const key = this.#keys.get(keyId);
    if (!key) throw new SecurityError(`Unknown encryption key version ${keyId.slice(0, 16)}`);

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecurityError('Malformed ciphertext');

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw new SecurityError('Ciphertext failed integrity check', { cause });
    }
  }

  /** True if the payload was encrypted with a key other than the active one (used by re-encryption). */
  needsReencryption(payload: string): boolean {
    return !payload.startsWith(`${this.#activeKeyId}:`);
  }
}
