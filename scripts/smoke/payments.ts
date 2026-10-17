import type { CallResult, SmokeContext } from './harness.ts';

const card = (number = '4242424242424242', extra: Record<string, unknown> = {}) => ({ number, expMonth: 12, expYear: 2030, cvc: '123', ...extra });

export async function payments(s: SmokeContext): Promise<void> {
  const { sk, pk } = s.state.merchant as { sk: string; pk: string };
  const create = (body: Record<string, unknown>, headers?: Record<string, string>) =>
    s.call('POST', '/payments', { key: sk, body: { amount: 2500, currency: 'usd', ...body }, ...(headers ? { headers } : {}) });
  const get = (id: string) => s.call('GET', `/payments/${id}`, { key: sk });
  const act = (id: string, kind: string, body?: unknown) => s.call('POST', `/payments/${id}/${kind}`, { key: sk, ...(body ? { body } : {}) });
  const waitFor = (label: string, id: string, statuses: string[], timeoutMs = 10_000) =>
    s.waitUntil(label, async () => {
      const r = await get(id);
      return statuses.includes(r.body?.status) ? (r.body as Record<string, any>) : undefined;
    }, timeoutMs);

  // Started first: the processing_error card needs ~30 s of retries before it gives up.
  const slow = await create({ card: card('4000000000000119') });

  s.section('Payments: asynchronous happy paths');
  const tok = await s.call('POST', '/tokens', { key: pk, body: { card: card() } });
  const auto = await create({ token: tok.body.id, description: 'Smoke order', metadata: { orderId: 'A1' }, customerId: 'cus_pay' });
  s.check('POST /payments with token → 202 pending', auto.status === 202 && auto.body.status === 'pending', auto.body);
  const autoDone = await waitFor('automatic capture to finish', auto.body.id, ['captured']);
  s.check('automatic capture: → captured with amountCaptured = amount', autoDone?.amountCaptured === 2500);
  s.check('history = created, authorized, captured', JSON.stringify(autoDone?.history.map((h: any) => h.type)) === '["created","authorized","captured"]');
  s.check('worker log correlates with the creating request (same requestId)', await s.logMatches(new RegExp(`"msg":"job processed"[^\\n]*"requestId":"${auto.headers.get('x-request-id')}"`)));

  const manual = await create({ card: card('5555555555554444'), captureMethod: 'manual' });
  const authorized = await waitFor('manual payment to be authorized', manual.body.id, ['authorized']);
  s.check('manual capture: → authorized with an authorization code', /^[0-9A-F]{6}$/.test(authorized?.authorizationCode ?? ''));
  const cap = await act(manual.body.id, 'capture', { amount: 2000 });
  s.check('partial capture 2000/2500 → 202 capturing', cap.status === 202 && cap.body.status === 'capturing');
  await waitFor('capture', manual.body.id, ['captured']);
  const r1 = await act(manual.body.id, 'refund', { amount: 500 });
  s.check('refund 500 → 202 refunding', r1.status === 202 && r1.body.status === 'refunding');
  const partially = await waitFor('partial refund', manual.body.id, ['partially_refunded']);
  s.check('→ partially_refunded, amountRefunded 500', partially?.amountRefunded === 500);
  const r2 = await act(manual.body.id, 'refund');
  s.check('refund the rest (no amount) → refunds remaining 1500', r2.body?.pendingAction?.amount === 1500);
  const refunded = await waitFor('full refund', manual.body.id, ['refunded']);
  s.check('→ refunded; amountRefunded equals amountCaptured (2000), not amount', refunded?.amountRefunded === 2000);

  const toCancel = await create({ card: card(), captureMethod: 'manual' });
  await waitFor('authorization before cancel', toCancel.body.id, ['authorized']);
  const cancel = await act(toCancel.body.id, 'cancel');
  s.check('cancel authorized → 202 cancelling → cancelled', cancel.status === 202 && !!(await waitFor('cancel', toCancel.body.id, ['cancelled'])));

  s.section('Payments: test cards');
  const outcomes: Array<[string, string]> = [
    ['4000000000000002', 'card_declined'],
    ['4000000000009995', 'insufficient_funds'],
    ['4000000000000069', 'expired_card'],
    ['4000000000000127', 'incorrect_cvc'],
  ];
  const declinedIds = await Promise.all(outcomes.map(([n]) => create({ card: card(n) })));
  for (let i = 0; i < outcomes.length; i++) {
    const done = await waitFor(`decline ${outcomes[i]![0]}`, declinedIds[i]!.body.id, ['failed']);
    s.check(`${outcomes[i]![0]} → failed / ${outcomes[i]![1]}`, done?.failure?.code === outcomes[i]![1], done?.failure);
  }

  s.section('Payments: trying to break the state machine');
  const pending = await create({ card: card(), captureMethod: 'manual' });
  s.check('cancel while pending → 409 invalid_state', (await act(pending.body.id, 'cancel')).status === 409);
  s.check('refund while pending → 409', (await act(pending.body.id, 'refund')).status === 409);
  await waitFor('authorization', pending.body.id, ['authorized']);
  s.check('refund before capture → 409', (await act(pending.body.id, 'refund')).status === 409);
  s.check('capture more than authorized → 400', (await act(pending.body.id, 'capture', { amount: 2501 })).status === 400);
  const race = await Promise.all([act(pending.body.id, 'capture'), act(pending.body.id, 'cancel'), act(pending.body.id, 'capture'), act(pending.body.id, 'cancel')]);
  s.check('capture and cancel fired together → exactly one accepted', race.filter((r) => r.status === 202).length === 1 && race.filter((r) => r.status === 409).length === 3, race.map((r) => r.status));
  await waitFor('race winner to finish', pending.body.id, ['captured', 'cancelled']);

  const refundRace = await create({ card: card() });
  await waitFor('capture for refund race', refundRace.body.id, ['captured']);
  const refunds = await Promise.all(Array.from({ length: 10 }, () => act(refundRace.body.id, 'refund')));
  s.check('10 simultaneous full refunds → exactly one 202', refunds.filter((r) => r.status === 202).length === 1, refunds.map((r) => r.status));
  const afterRace = await waitFor('race refund', refundRace.body.id, ['refunded']);
  s.check('never over-refunded (amountRefunded ≤ amountCaptured)', !!afterRace && afterRace.amountRefunded <= afterRace.amountCaptured);
  s.check('refund after fully refunded → 409', (await act(refundRace.body.id, 'refund', { amount: 1 })).status === 409);

  const failed = declinedIds[0]!.body.id;
  s.check('capture a failed payment → 409', (await act(failed, 'capture')).status === 409);

  s.section('Payments: hostile input');
  const bad: Array<[string, Record<string, unknown>]> = [
    ['negative amount', { amount: -100, card: card() }],
    ['float amount', { amount: 10.99, card: card() }],
    ['amount as string', { amount: '2500', card: card() }],
    ['amount 1e9', { amount: 1e9, card: card() }],
    ['amount NaN-ish (null)', { amount: null, card: card() }],
    ['unknown currency', { currency: 'BTC', card: card() }],
    ['no card source', {}],
    ['token + card together', { token: tok.body.id, card: card() }],
    ['already-used token', { token: tok.body.id }],
    ['saveCard with cardId', { cardId: s.state.savedCardId, saveCard: true }],
    ['21 metadata keys', { card: card(), metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) }],
    ['metadata value is an object', { card: card(), metadata: { nested: { a: 1 } } }],
    ['typo field "ammount"', { ammount: 5, card: card() }],
  ];
  for (const [label, body] of bad) {
    const res = await s.call('POST', '/payments', { key: sk, body: { amount: 2500, currency: 'usd', ...body } });
    s.check(`${label} → 400`, res.status === 400, { status: res.status, details: res.body?.error?.details });
  }
  s.check('unknown cardId → 404', (await create({ cardId: 'card_00000000000000000000000000000000' })).status === 404);
  s.check('publishable key cannot create payments → 403', (await s.call('POST', '/payments', { key: pk, body: { amount: 1, currency: 'usd', card: card() } })).status === 403);
  const patchStatus = await s.call('PATCH', `/payments/${auto.body.id}`, { key: sk, body: { status: 'refunded', amount: 1 } });
  s.check('PATCH status/amount → 400 naming both fields', patchStatus.status === 400 && patchStatus.body.error.details.length === 2);
  const patchOk = await s.call('PATCH', `/payments/${auto.body.id}`, { key: sk, body: { metadata: { orderId: null, note: 'gift' } } });
  s.check('PATCH metadata merge (null deletes)', patchOk.status === 200 && JSON.stringify(patchOk.body.metadata) === '{"note":"gift"}');

  s.section('Payments: idempotency and isolation');
  const idemHeaders = { 'idempotency-key': 'smoke-pay-1' };
  const first = await create({ card: card(), customerId: 'cus_idem_pay' }, idemHeaders);
  const again = await create({ card: card(), customerId: 'cus_idem_pay' }, idemHeaders);
  s.check('retried create with same Idempotency-Key → same payment, replayed', again.body?.id === first.body?.id && again.headers.get('idempotent-replayed') === 'true');
  const diff = await create({ card: card(), customerId: 'cus_idem_pay', amount: 1 }, idemHeaders);
  s.check('same key with a different amount → 422', diff.status === 422);
  const list = await s.call('GET', '/payments?customerId=cus_idem_pay', { key: sk });
  s.check('exactly one payment exists for that key', list.body.total === 1);

  const other = await s.call('POST', '/merchants', { body: { name: 'Snoop', email: `snoop-${Date.now()}@smoke.test` } });
  const otherSk = other.body.apiKeys.secret;
  const snoop: CallResult[] = [
    await s.call('GET', `/payments/${auto.body.id}`, { key: otherSk }),
    await s.call('PATCH', `/payments/${auto.body.id}`, { key: otherSk, body: { description: 'pwned' } }),
    await s.call('POST', `/payments/${auto.body.id}/refund`, { key: otherSk }),
  ];
  s.check('another merchant: get/patch/refund my payment → all 404', snoop.every((r) => r.status === 404), snoop.map((r) => r.status));
  s.check('my payment untouched by the other merchant', (await get(auto.body.id)).body.description === 'Smoke order');

  s.section('Payments: saved cards');
  const saveOk = await create({ card: card('6011111111111117'), saveCard: true, customerId: 'cus_wallet' });
  const saveOkDone = await waitFor('saveCard approved', saveOk.body.id, ['captured']);
  s.check('saveCard + approval → paymentMethod.cardId set and card listed', !!saveOkDone?.paymentMethod.cardId && (await s.call('GET', '/cards?customerId=cus_wallet', { key: sk })).body.total === 1);
  const saveNo = await create({ card: card('4000000000000002'), saveCard: true, customerId: 'cus_wallet_declined' });
  await waitFor('saveCard declined', saveNo.body.id, ['failed']);
  s.check('saveCard + decline → card not saved', (await s.call('GET', '/cards?customerId=cus_wallet_declined', { key: sk })).body.total === 0);

  const withSaved = await create({ cardId: saveOkDone?.paymentMethod.cardId });
  const del = await s.call('DELETE', `/cards/${saveOkDone?.paymentMethod.cardId}`, { key: sk });
  const stateAtDelete = (await get(withSaved.body.id)).body.status;
  s.check('deleting a card used by a just-created payment: 409 while pending (or 204 if already processed)', (del.status === 409) || (del.status === 204 && stateAtDelete !== 'pending'), { del: del.status, stateAtDelete });

  s.section('Payments: processing_error card (retries, then gives up)');
  const slowDone = await waitFor('processing_error card to exhaust retries', slow.body.id, ['failed'], 60_000);
  s.check('4000000000000119 → failed processing_error after retries', slowDone?.failure?.code === 'processing_error');
  s.check('transient errors logged at warn, final failure at error', (await s.logMatches(/"level":"warn","msg":"processor transient error"/)) && (await s.logMatches(/"level":"error","msg":"job failed permanently after retries"/)));

  await s.assertAlive('payments abuse');
}
