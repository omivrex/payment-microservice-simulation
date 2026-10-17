import { aadFor, type Encryptor } from '../crypto/encryption.js';
import type { JsonDb } from '../db/jsonDb.js';

/**
 * Rewrites every ciphertext not encrypted with the active key, as step 3 of
 * master-key rotation (docs/04-security.md §4.4). Run with the service stopped:
 * the database lock enforces that.
 */
export async function reencryptAll(db: JsonDb, encryptor: Encryptor): Promise<{ cards: number; webhookSecrets: number }> {
  const totals = { cards: 0, webhookSecrets: 0 };
  for (const merchantId of db.merchantIds()) {
    const counts = await db.transact(merchantId, (d) => {
      const c = { cards: 0, webhookSecrets: 0 };
      for (const card of Object.values(d.cards)) {
        if (card.numberEncrypted && encryptor.needsReencryption(card.numberEncrypted)) {
          const aad = aadFor('cards', card.id, 'number');
          card.numberEncrypted = encryptor.encrypt(encryptor.decrypt(card.numberEncrypted, aad), aad);
          c.cards++;
        }
      }
      for (const endpoint of Object.values(d.webhookEndpoints)) {
        if (encryptor.needsReencryption(endpoint.secretEncrypted)) {
          const aad = aadFor('webhookEndpoints', endpoint.id, 'secret');
          endpoint.secretEncrypted = encryptor.encrypt(encryptor.decrypt(endpoint.secretEncrypted, aad), aad);
          c.webhookSecrets++;
        }
      }
      return c;
    });
    totals.cards += counts.cards;
    totals.webhookSecrets += counts.webhookSecrets;
  }
  return totals;
}
