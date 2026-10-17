import { randomUUID } from 'node:crypto';
import type { SmokeContext } from './harness.ts';

/** Runs LAST: it deliberately exhausts the sign-up budget. Limits come from the smoke env (see run.ts). */
export async function ratelimits(s: SmokeContext): Promise<void> {
  s.section('Rate limits (exhausting them on purpose)');

  let signups = 0;
  let limited: Awaited<ReturnType<SmokeContext['call']>> | undefined;
  for (let i = 0; i < 200 && !limited; i++) {
    const r = await s.call('POST', '/merchants', { body: { name: 'Flood', email: `${randomUUID()}@flood.test` } });
    if (r.status === 429) limited = r;
    else if (r.status === 201) signups++;
  }
  s.check('sign-up flood eventually → 429 rate_limited', limited?.body?.error?.code === 'rate_limited', { signups });
  const retryAfter = Number(limited?.headers.get('retry-after'));
  s.check('429 carries a sensible Retry-After (1–3600 s)', retryAfter >= 1 && retryAfter <= 3600, retryAfter);
  s.check('rate-limited requests are logged at warn level', await s.logMatches(/"level":"warn","msg":"request rejected"[^\n]*"status":429/));

  const sk = s.state.merchant?.sk as string | undefined;
  if (sk) {
    const me = await s.call('GET', '/merchants/me', { key: sk });
    s.check('existing merchants unaffected by the sign-up limit', me.status === 200);

    let calls = 0;
    let blocked = false;
    while (!blocked && calls < 2000) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => s.call('GET', '/merchants/me', { key: sk })));
      calls += batch.length;
      blocked = batch.some((r) => r.status === 429);
    }
    s.check('per-key general limit → 429 after the configured budget', blocked, { calls });
  }

  const pk = s.state.merchant?.pk as string | undefined;
  if (pk) {
    let tokenCalls = 0;
    let tokenBlocked = false;
    while (!tokenBlocked && tokenCalls < 1000) {
      const batch = await Promise.all(
        Array.from({ length: 25 }, () => s.call('POST', '/tokens', { key: pk, body: { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123' } } })),
      );
      tokenCalls += batch.length;
      tokenBlocked = batch.some((r) => r.status === 429);
    }
    s.check('POST /tokens per-key limit (card-testing protection) → 429', tokenBlocked, { tokenCalls });
  }
  await s.assertAlive('rate-limit floods');
}
