import { randomUUID } from 'node:crypto';
import type { SmokeContext } from './harness.ts';

const card = (number = '4242424242424242', extra: Record<string, unknown> = {}) => ({ number, expMonth: 12, expYear: 2030, cvc: '123', ...extra });

async function newMerchant(s: SmokeContext) {
  const r = await s.call('POST', '/merchants', { body: { name: 'Cards Smoke', email: `${randomUUID()}@smoke.test` } });
  return { id: r.body.merchant.id as string, pk: r.body.apiKeys.publishable as string, sk: r.body.apiKeys.secret as string };
}

export async function cards(s: SmokeContext): Promise<void> {
  const m = s.state.merchant as { pk: string; sk: string };

  s.section('Tokens & cards: happy path');
  const tok = await s.call('POST', '/tokens', { key: m.pk, body: { card: card('4242 4242 4242 4242') } });
  s.check('POST /tokens with publishable key → 201 tok_…', tok.status === 201 && /^tok_/.test(tok.body?.id), tok.body);
  s.check('token response has brand/last4, no number, no CVC', tok.body?.card?.brand === 'visa' && tok.body.card.last4 === '4242' && !tok.text.includes('4242424242424242') && !tok.text.includes('cvc'));

  const saved = await s.call('POST', '/cards', { key: m.sk, body: { token: tok.body.id, customerId: 'cus_smoke' } });
  s.check('POST /cards from token → 201 card_…', saved.status === 201 && /^card_/.test(saved.body?.id), saved.body);
  s.state.savedCardId = saved.body.id;
  const got = await s.call('GET', `/cards/${saved.body.id}`, { key: m.sk });
  s.check('GET /cards/:id → 200', got.status === 200 && got.body.id === saved.body.id);
  const list = await s.call('GET', '/cards?customerId=cus_smoke', { key: m.sk });
  s.check('GET /cards?customerId → the saved card', list.status === 200 && list.body.total === 1 && list.body.data[0].id === saved.body.id);

  s.section('Tokens: hostile card input');
  const badCards: Array<[string, unknown]> = [
    ['Luhn-invalid number', card('4242424242424241')],
    ['full-width unicode digits', card('４２４２４２４２４２４２４２４２')],
    ['90 kb number string', card('4'.repeat(90_000))],
    ['number as integer', card(4242424242424242 as never)],
    ['expired card', card(undefined, { expMonth: 1, expYear: 2020 })],
    ['month 13', card(undefined, { expMonth: 13 })],
    ['float month', card(undefined, { expMonth: 1.5 })],
    ['negative year', card(undefined, { expYear: -2030 })],
    ['CVC with letters', card(undefined, { cvc: '12a' })],
    ['CVC as number', card(undefined, { cvc: 123 })],
    ['extra field "cvv"', { ...card(), cvv: '123' }],
    ['card is null', null],
    ['card is a string', '4242424242424242'],
    ['card is an array', [card()]],
  ];
  for (const [label, c] of badCards) {
    const r = await s.call('POST', '/tokens', { key: m.pk, body: { card: c } });
    s.check(`${label} → 400 (number never echoed)`, r.status === 400 && !r.text.includes('42424242424242'), { status: r.status });
  }
  s.check('no key → 401', (await s.call('POST', '/tokens', { body: { card: card() } })).status === 401);

  s.section('Tokens: reuse, races and isolation');
  const one = await s.call('POST', '/tokens', { key: m.pk, body: { card: card('5555555555554444') } });
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call('POST', '/cards', { key: m.sk, body: { token: one.body.id, customerId: `race_${i}` } })));
  s.check('10 parallel saves with one token → exactly one 201, nine 400', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 400).length === 9, race.map((r) => r.status));

  const other = await newMerchant(s);
  const foreignTok = await s.call('POST', '/tokens', { key: other.pk, body: { card: card() } });
  const useForeign = await s.call('POST', '/cards', { key: m.sk, body: { token: foreignTok.body.id } });
  s.check('using another merchant’s token → 400 (same as unknown token)', useForeign.status === 400 && useForeign.body.error.details?.[0]?.message === 'is invalid, expired or already used');
  s.check('another merchant GET my card → 404', (await s.call('GET', `/cards/${saved.body.id}`, { key: other.sk })).status === 404);
  s.check('another merchant DELETE my card → 404 (card survives)', (await s.call('DELETE', `/cards/${saved.body.id}`, { key: other.sk })).status === 404 && (await s.call('GET', `/cards/${saved.body.id}`, { key: m.sk })).status === 200);
  s.check('another merchant’s card list does not include mine', !(await s.call('GET', '/cards', { key: other.sk })).body.data.some((c: any) => c.id === saved.body.id));
  s.check('publishable key cannot save cards (403)', (await s.call('POST', '/cards', { key: m.pk, body: { card: card() } })).status === 403);

  s.section('Cards: duplicates, deletion, idempotency');
  const dupA = await s.call('POST', '/cards', { key: m.sk, body: { card: card('378282246310005', { cvc: '1234' }), customerId: 'cus_dupe' } });
  const dupB = await s.call('POST', '/cards', { key: m.sk, body: { card: card('3782-822463-10005', { cvc: '9999' }), customerId: 'cus_dupe' } });
  s.check('same card twice for one customer → 200 with the same card', dupA.status === 201 && dupB.status === 200 && dupB.body.id === dupA.body.id);

  const del = await s.call('DELETE', `/cards/${dupA.body.id}`, { key: m.sk });
  s.check('DELETE → 204, second DELETE → 404', del.status === 204 && (await s.call('DELETE', `/cards/${dupA.body.id}`, { key: m.sk })).status === 404);

  const idemBody = { card: card('6011111111111117'), customerId: 'cus_idem' };
  const idemRuns = await Promise.all(Array.from({ length: 6 }, () => s.call('POST', '/cards', { key: m.sk, body: idemBody, headers: { 'idempotency-key': 'smoke-idem-1' } })));
  const created = idemRuns.filter((r) => r.status === 201 && r.headers.get('idempotent-replayed') !== 'true').length;
  s.check('6 parallel requests with one Idempotency-Key → one real creation; others replayed or 409', created === 1 && idemRuns.every((r) => r.status === 201 || r.status === 409), idemRuns.map((r) => `${r.status}${r.headers.get('idempotent-replayed') ? 'R' : ''}`));
  const replay = await s.call('POST', '/cards', { key: m.sk, body: idemBody, headers: { 'idempotency-key': 'smoke-idem-1' } });
  s.check('retry after completion → replayed 201 with header', replay.status === 201 && replay.headers.get('idempotent-replayed') === 'true');
  const reused = await s.call('POST', '/cards', { key: m.sk, body: { ...idemBody, customerId: 'someone_else' }, headers: { 'idempotency-key': 'smoke-idem-1' } });
  s.check('same key, different body → 422 idempotency_key_reused', reused.status === 422 && reused.body.error.code === 'idempotency_key_reused');
  const wallet = await s.call('GET', '/cards?customerId=cus_idem', { key: m.sk });
  s.check('exactly one card exists after all that', wallet.body.total === 1);

  await s.assertAlive('tokens & cards abuse');
}
