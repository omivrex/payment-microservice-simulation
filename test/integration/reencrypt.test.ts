import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Encryptor } from '../../src/crypto/encryption.ts';
import { reencryptAll } from '../../src/maintenance/reencrypt.ts';
import { card, createMerchant } from '../helpers/fixtures.ts';
import { startTestApp } from '../helpers/testApp.ts';

describe('§4.4 master-key rotation (yarn reencrypt)', () => {
  it('rewrites v1 ciphertexts as v2; data still decrypts; second run changes nothing', async () => {
    const v1 = randomBytes(32);
    const app = await startTestApp({ config: { encryptionKeys: new Map([['v1', v1]]), encryptionActiveKeyId: 'v1' } });
    try {
      const m = await createMerchant(app);
      const saved = await app.api('POST', '/cards', { key: m.sk, body: { card: card() } });
      const hook = await app.api('POST', '/webhooks', { key: m.sk, body: { url: 'http://127.0.0.1:9/hook', events: ['*'] } });

      const rotated = new Encryptor(new Map([['v1', v1], ['v2', randomBytes(32)]]), 'v2');
      const counts = await reencryptAll(app.ctx.db, rotated);
      assert.deepEqual(counts, { cards: 1, webhookSecrets: 1 });

      const d = app.ctx.db.read(m.id, (x) => x);
      assert.ok(d.cards[saved.body.id]!.numberEncrypted!.startsWith('v2:'));
      assert.ok(d.webhookEndpoints[hook.body.id]!.secretEncrypted.startsWith('v2:'));
      assert.equal(rotated.decrypt(d.cards[saved.body.id]!.numberEncrypted!, `cards:${saved.body.id}:number`), '4242424242424242');
      assert.equal(rotated.decrypt(d.webhookEndpoints[hook.body.id]!.secretEncrypted, `webhookEndpoints:${hook.body.id}:secret`), hook.body.secret);

      assert.deepEqual(await reencryptAll(app.ctx.db, rotated), { cards: 0, webhookSecrets: 0 });
    } finally {
      await app.close();
    }
  });
});
