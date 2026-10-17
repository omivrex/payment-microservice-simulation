import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { MINUTE } from '../helpers/fakeClock.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let m: TestMerchant;
before(async () => {
  app = await startTestApp();
  m = await createMerchant(app);
});
after(() => app.close());

const tokenize = (key: string, c: unknown = card()) => app.api('POST', '/tokens', { key, body: { card: c } });

describe('§5.6 POST /tokens', () => {
  it('works with the publishable key; response has brand/last4 but never the number or CVC', async () => {
    const res = await tokenize(m.pk, card('4242 4242 4242 4242'));
    assert.equal(res.status, 201);
    assert.match(res.body.id, /^tok_[0-9a-f]{32}$/);
    assert.deepEqual(res.body.card, { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
    assert.deepEqual(Object.keys(res.body).sort(), ['card', 'createdAt', 'expiresAt', 'id']);
    assert.equal(Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt), 15 * MINUTE);
    assert.ok(!res.text.includes('4242424242424242') && !res.text.includes('"cvc"'));
  });

  it('also works with the secret key', async () => {
    assert.equal((await tokenize(m.sk)).status, 201);
  });

  it('detects brands', async () => {
    const brands: Record<string, string> = {
      '4242424242424242': 'visa',
      '5555555555554444': 'mastercard',
      '378282246310005': 'amex',
      '6011111111111117': 'discover',
    };
    for (const [number, brand] of Object.entries(brands)) {
      const cvc = brand === 'amex' ? '1234' : '123';
      assert.equal((await tokenize(m.pk, card(number, { cvc }))).body.card.brand, brand, number);
    }
  });

  const invalidCards: Array<[string, unknown, string]> = [
    ['Luhn failure', card('4242424242424241'), 'card.number'],
    ['letters in number', card('4242abcd42424242'), 'card.number'],
    ['too short', card('42424242424'), 'card.number'],
    ['too long', card('42424242424242424242'), 'card.number'],
    ['number as integer', card(4242424242424242 as never), 'card.number'],
    ['month 0', card(undefined, { expMonth: 0 }), 'card.expMonth'],
    ['month 13', card(undefined, { expMonth: 13 }), 'card.expMonth'],
    ['month as string', card(undefined, { expMonth: '12' }), 'card.expMonth'],
    ['2-digit year', card(undefined, { expYear: 30 }), 'card.expYear'],
    ['expired card', card(undefined, { expMonth: 9, expYear: 2026 }), 'card.expYear'],
    ['2-digit CVC', card(undefined, { cvc: '12' }), 'card.cvc'],
    ['5-digit CVC', card(undefined, { cvc: '12345' }), 'card.cvc'],
    ['numeric CVC', card(undefined, { cvc: 123 }), 'card.cvc'],
    ['unknown card field (cvv)', { ...card(), cvv: '123' }, 'card.cvv'],
  ];
  for (const [label, c, field] of invalidCards) {
    it(`400: ${label}`, async () => {
      const res = await tokenize(m.pk, c);
      assert.equal(res.status, 400, res.text);
      assert.ok(res.body.error.details.some((d: any) => d.field === field), JSON.stringify(res.body.error.details));
      assert.ok(!res.text.includes('424242424242424'), 'number never echoed');
    });
  }

  it('a card expiring this month is still accepted (valid through month end)', async () => {
    app.clock.set('2026-10-31T23:00:00.000Z');
    assert.equal((await tokenize(m.pk, card(undefined, { expMonth: 10, expYear: 2026 }))).status, 201);
    app.clock.set('2026-10-15T09:00:00.000Z');
  });

  it('missing card / extra top-level field → 400', async () => {
    assert.equal((await app.api('POST', '/tokens', { key: m.pk, body: {} })).status, 400);
    assert.equal((await app.api('POST', '/tokens', { key: m.pk, body: { card: card(), amount: 5 } })).status, 400);
  });

  it('no key → 401', async () => {
    assert.equal((await app.api('POST', '/tokens', { body: { card: card() } })).status, 401);
  });
});

describe('§5.7 cards', () => {
  it('save from a token → 201; token is single-use', async () => {
    const tok = (await tokenize(m.pk)).body.id;
    const saved = await app.api('POST', '/cards', { key: m.sk, body: { token: tok, customerId: 'cus_1' } });
    assert.equal(saved.status, 201);
    assert.match(saved.body.id, /^card_[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(saved.body).sort(), ['brand', 'createdAt', 'customerId', 'expMonth', 'expYear', 'id', 'last4']);
    assert.equal(saved.body.customerId, 'cus_1');
    const again = await app.api('POST', '/cards', { key: m.sk, body: { token: tok, customerId: 'cus_other' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.details[0].field, 'token');
  });

  it('expired token → same 400 as unknown token', async () => {
    const tok = (await tokenize(m.pk)).body.id;
    app.clock.advance(15 * MINUTE + 1);
    const expired = await app.api('POST', '/cards', { key: m.sk, body: { token: tok } });
    const unknown = await app.api('POST', '/cards', { key: m.sk, body: { token: 'tok_00000000000000000000000000000000' } });
    app.clock.set('2026-10-15T09:00:00.000Z');
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body.error.details, unknown.body.error.details);
  });

  it('another merchant’s token → same 400 as an unknown token', async () => {
    const other = await createMerchant(app);
    const tok = (await tokenize(other.pk)).body.id;
    const res = await app.api('POST', '/cards', { key: m.sk, body: { token: tok } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].message, 'is invalid, expired or already used');
  });

  it('save from raw card details → 201', async () => {
    const res = await app.api('POST', '/cards', { key: m.sk, body: { card: card('5555555555554444'), customerId: 'cus_raw' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.brand, 'mastercard');
  });

  it('exactly one of token/card: both or neither → 400', async () => {
    const tok = (await tokenize(m.pk)).body.id;
    assert.equal((await app.api('POST', '/cards', { key: m.sk, body: { token: tok, card: card() } })).status, 400);
    assert.equal((await app.api('POST', '/cards', { key: m.sk, body: { customerId: 'x' } })).status, 400);
  });

  it('duplicate card for the same customer → 200 with the SAME card; different customer → new card', async () => {
    const first = await app.api('POST', '/cards', { key: m.sk, body: { card: card('378282246310005', { cvc: '1234' }), customerId: 'cus_dup' } });
    const tok = (await tokenize(m.pk, card('378282246310005', { cvc: '1234' }))).body.id;
    const second = await app.api('POST', '/cards', { key: m.sk, body: { token: tok, customerId: 'cus_dup' } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    const other = await app.api('POST', '/cards', { key: m.sk, body: { card: card('378282246310005', { cvc: '1234' }), customerId: 'cus_dup2' } });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.id, first.body.id);
    const list = await app.api('GET', '/cards?customerId=cus_dup', { key: m.sk });
    assert.equal(list.body.total, 1, 'no duplicate in the customer wallet');
  });

  it('duplicates are detected within the "no customer" group too', async () => {
    const a = await app.api('POST', '/cards', { key: m.sk, body: { card: card('6011111111111117') } });
    const b = await app.api('POST', '/cards', { key: m.sk, body: { card: card('6011 1111 1111 1117'), customerId: null } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
  });

  it('a duplicate save via token does not leave an orphan temporary card behind', async () => {
    const before = app.ctx.db.read(m.id, (d) => Object.keys(d.cards).length);
    const tok = (await tokenize(m.pk, card('6011111111111117'))).body.id;
    await app.api('POST', '/cards', { key: m.sk, body: { token: tok } });
    assert.equal(app.ctx.db.read(m.id, (d) => Object.keys(d.cards).length), before);
  });

  it('GET /cards filters by customerId, excludes temporary token cards, paginates', async () => {
    await tokenize(m.pk); // temporary card, must not be listed
    const all = await app.api('GET', '/cards', { key: m.sk });
    assert.ok(all.body.data.every((c: any) => typeof c.id === 'string'));
    const unsavedCount = app.ctx.db.read(m.id, (d) => Object.values(d.cards).filter((c) => !c.saved).length);
    assert.ok(unsavedCount > 0);
    assert.equal(all.body.total, app.ctx.db.read(m.id, (d) => Object.values(d.cards).filter((c) => c.saved).length));
    const page = await app.api('GET', '/cards?limit=1&offset=1', { key: m.sk });
    assert.equal(page.body.data.length, 1);
    assert.equal(page.body.limit, 1);
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'limit=1&limit=2', 'unknown=1']) {
      assert.equal((await app.api('GET', `/cards?${q}`, { key: m.sk })).status, 400, q);
    }
  });

  it('GET /cards/:id; another merchant’s card or a temporary card → 404', async () => {
    const saved = await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'cus_get' } });
    assert.equal((await app.api('GET', `/cards/${saved.body.id}`, { key: m.sk })).status, 200);
    const other = await createMerchant(app);
    const res = await app.api('GET', `/cards/${saved.body.id}`, { key: other.sk });
    const madeUp = await app.api('GET', '/cards/card_00000000000000000000000000000000', { key: other.sk });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message.replace(saved.body.id, 'X'), madeUp.body.error.message.replace('card_00000000000000000000000000000000', 'X'));
    const tempCardId = app.ctx.db.read(m.id, (d) => Object.values(d.cards).find((c) => !c.saved)!.id);
    assert.equal((await app.api('GET', `/cards/${tempCardId}`, { key: m.sk })).status, 404);
  });

  it('DELETE /cards/:id → 204, then 404; other merchant cannot delete', async () => {
    const saved = await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'cus_del' } });
    const other = await createMerchant(app);
    assert.equal((await app.api('DELETE', `/cards/${saved.body.id}`, { key: other.sk })).status, 404);
    assert.equal((await app.api('DELETE', `/cards/${saved.body.id}`, { key: m.sk })).status, 204);
    assert.equal((await app.api('DELETE', `/cards/${saved.body.id}`, { key: m.sk })).status, 404);
    assert.equal(app.ctx.db.read(m.id, (d) => d.cards[saved.body.id]), undefined, 'record and ciphertext gone');
  });

  it('publishable key cannot save, list or delete cards', async () => {
    assert.equal((await app.api('POST', '/cards', { key: m.pk, body: { card: card() } })).status, 403);
    assert.equal((await app.api('GET', '/cards', { key: m.pk })).status, 403);
  });

  it('the database stores only ciphertext and never a CVC', async () => {
    const file = await readFile(app.ctx.config.dbFile, 'utf8');
    assert.ok(!file.includes('4242424242424242'));
    assert.ok(!/"cvc"/.test(file));
    assert.match(file, /"numberEncrypted":"v1:/);
  });
});

describe('§4.13 card data tampering', () => {
  it('a ciphertext copied onto another card record fails to decrypt (AAD)', async () => {
    const a = await app.api('POST', '/cards', { key: m.sk, body: { card: card(), customerId: 'cus_aad_a' } });
    const b = await app.api('POST', '/cards', { key: m.sk, body: { card: card('5555555555554444'), customerId: 'cus_aad_b' } });
    const cards = app.ctx.db.read(m.id, (d) => d.cards);
    const moved = { ...cards[b.body.id]!, numberEncrypted: cards[a.body.id]!.numberEncrypted };
    assert.throws(() => app.services.vault.decryptNumber(moved), { name: 'SecurityError' });
    assert.equal(app.services.vault.decryptNumber(cards[a.body.id]!), '4242424242424242');
  });
});
