import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startSmokeServer, type SmokeContext } from './harness.ts';

/** Receiver-side verification, written independently of the service code (mirrors docs/06-webhooks.md §6.6). */
function verify(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(parts.v1, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

async function receiver() {
  const got: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let mode: 'ok' | 'fail' | 'hang' = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ path: req.url ?? '', headers: req.headers, body });
      if (mode === 'hang') return; // never answer
      res.statusCode = mode === 'fail' ? 500 : 200;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    got,
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    setMode: (m: typeof mode) => (mode = m),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function webhooks(s: SmokeContext): Promise<void> {
  const { sk } = s.state.merchant as { sk: string };
  const rx = await receiver();
  try {
    s.section('Webhooks: signed delivery end to end');
    const ep = await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url('/all'), events: ['*'], description: 'smoke' } });
    s.check('POST /webhooks → 201 with whsec_ secret (shown once)', ep.status === 201 && /^whsec_/.test(ep.body?.secret ?? ''), ep.body);
    const fetched = await s.call('GET', `/webhooks/${ep.body.id}`, { key: sk });
    s.check('GET /webhooks/:id never includes the secret', fetched.status === 200 && !fetched.text.includes('whsec_'));

    const pay = await s.call('POST', '/payments', { key: sk, body: { amountMinor: 4200, currency: 'eur', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123' } } });
    await s.waitUntil('3 webhook deliveries (created, authorized, captured)', async () => rx.got.filter((r) => r.path === '/all' && JSON.parse(r.body).data.object.id === pay.body.id).length >= 3 || undefined, 15_000);
    const mine = rx.got.filter((r) => JSON.parse(r.body).data.object.id === pay.body.id);
    s.check('events received: payment.created, payment.authorized, payment.captured', JSON.stringify(mine.map((r) => JSON.parse(r.body).type).sort()) === '["payment.authorized","payment.captured","payment.created"]');
    s.check('every delivery verifies with the secret (independent HMAC check)', mine.every((r) => verify(r.body, r.headers['webhook-signature'] as string, ep.body.secret)));
    s.check('Webhook-Id equals event id; Webhook-Event equals event type', mine.every((r) => r.headers['webhook-id'] === JSON.parse(r.body).id && r.headers['webhook-event'] === JSON.parse(r.body).type));
    s.check('a tampered body fails verification', !verify(mine[0]!.body.replace('4200', '1'), mine[0]!.headers['webhook-signature'] as string, ep.body.secret));
    s.check('data.object of payment.created is the pending snapshot', JSON.parse(mine.find((r) => JSON.parse(r.body).type === 'payment.created')!.body).data.object.status === 'pending');

    const events = await s.call('GET', '/events?type=payment.captured', { key: sk });
    s.check('GET /events?type=payment.captured includes this payment', events.body.data.some((e: any) => e.data.object.id === pay.body.id));

    s.section('Webhooks: failures, retries and rotation');
    const rot = await s.call('POST', `/webhooks/${ep.body.id}/rotate-secret`, { key: sk });
    s.check('rotate-secret → new secret', rot.status === 200 && rot.body.secret !== ep.body.secret);
    const before = rx.got.length;
    await s.call('PATCH', `/payments/${pay.body.id}`, { key: sk, body: { description: 'rotated' } });
    await s.waitUntil('payment.updated delivery', async () => rx.got.length > before || undefined);
    const latest = rx.got.at(-1)!;
    s.check('after rotation: verifies with new secret, not the old one', verify(latest.body, latest.headers['webhook-signature'] as string, rot.body.secret) && !verify(latest.body, latest.headers['webhook-signature'] as string, ep.body.secret));

    rx.setMode('fail');
    const failing = await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url('/failing'), events: ['payment.updated'] } });
    await s.call('PATCH', `/payments/${pay.body.id}`, { key: sk, body: { description: 'will fail' } });
    const log = await s.waitUntil('a failed attempt in the delivery log', async () => {
      const r = await s.call('GET', `/webhooks/${failing.body.id}/deliveries`, { key: sk });
      return r.body.data[0]?.lastResponseStatus === 500 ? r.body.data[0] : undefined;
    });
    s.check('receiver 500 → delivery pending, lastError "HTTP 500", retry ≈ 1 min later', log?.status === 'pending' && log.lastError === 'HTTP 500' && Math.abs(Date.parse(log.nextAttemptAt) - Date.parse(log.lastAttemptAt) - 60_000) < 1000, log);
    const del = await s.call('DELETE', `/webhooks/${failing.body.id}`, { key: sk });
    const afterDelete = await s.call('GET', `/webhooks/${failing.body.id}/deliveries`, { key: sk });
    s.check('deleting an endpoint → 204; its log is gone with it (404)', del.status === 204 && afterDelete.status === 404);
    s.check('server logged the receiver failure at warn (not error)', await s.logMatches(/"level":"warn","msg":"webhook delivery failed"[^\n]*"status":500/));

    rx.setMode('hang');
    const hanging = await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url('/hang'), events: ['payment.updated'] } });
    await s.call('PATCH', `/payments/${pay.body.id}`, { key: sk, body: { description: 'hang' } });
    const timedOut = await s.waitUntil('timeout recorded (10 s)', async () => {
      const r = await s.call('GET', `/webhooks/${hanging.body.id}/deliveries`, { key: sk });
      return r.body.data[0]?.lastError === 'timeout' ? r.body.data[0] : undefined;
    }, 20_000);
    s.check('receiver that never answers → "timeout" after ~10 s', timedOut?.lastError === 'timeout');
    await s.call('DELETE', `/webhooks/${hanging.body.id}`, { key: sk });
    rx.setMode('ok');

    s.section('Webhooks: hostile input and limits');
    const bad: Array<[string, unknown]> = [
      ['unknown event type', { url: rx.url('/x'), events: ['payment.exploded'] }],
      ['"*" mixed with types', { url: rx.url('/x'), events: ['*', 'payment.failed'] }],
      ['empty events', { url: rx.url('/x'), events: [] }],
      ['javascript: URL', { url: 'javascript:alert(1)', events: ['*'] }],
      ['file: URL', { url: 'file:///etc/passwd', events: ['*'] }],
      ['credentials in URL', { url: 'http://admin:secret@127.0.0.1/x', events: ['*'] }],
      ['3 kb URL', { url: `${rx.url('/')}${'a'.repeat(3000)}`, events: ['*'] }],
    ];
    for (const [label, body] of bad) {
      const r = await s.call('POST', '/webhooks', { key: sk, body });
      s.check(`${label} → 400`, r.status === 400, r.status);
    }
    const dup = await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url('/all'), events: ['payment.failed'] } });
    s.check('registering the same URL again → 409 naming the existing endpoint', dup.status === 409 && dup.body.error.message.includes(ep.body.id), dup.body);
    const dupNormalized = await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url('/all').replace('http://127.0.0.1', 'HTTP://127.0.0.1') + '#frag', events: ['*'] } });
    s.check('same URL with different case / #fragment → still 409 (compared normalized)', dupNormalized.status === 409);
    const existing = (await s.call('GET', '/webhooks', { key: sk })).body.data.length;
    const created: number[] = [];
    for (let i = existing; i < 6; i++) created.push((await s.call('POST', '/webhooks', { key: sk, body: { url: rx.url(`/n${i}`), events: ['payment.failed'] } })).status);
    s.check('6th endpoint → 409 conflict (limit of 5 per merchant)', created.at(-1) === 409 && created.slice(0, -1).every((c) => c === 201), created);

    const other = await s.call('POST', '/merchants', { body: { name: 'Hook Snoop', email: `hooksnoop-${Date.now()}@smoke.test` } });
    const otherSk = other.body.apiKeys.secret;
    s.check('another merchant cannot read, change or rotate my endpoint (404)', (await Promise.all([
      s.call('GET', `/webhooks/${ep.body.id}`, { key: otherSk }),
      s.call('PATCH', `/webhooks/${ep.body.id}`, { key: otherSk, body: { url: 'http://127.0.0.1:1/steal' } }),
      s.call('POST', `/webhooks/${ep.body.id}/rotate-secret`, { key: otherSk }),
    ])).every((r) => r.status === 404));
    s.check('another merchant sees none of my events', (await s.call('GET', '/events', { key: otherSk })).body.total === 0);
  } finally {
    rx.close();
  }

  s.section('Webhooks: SSRF protection (second server in secure mode, real DNS)');
  const secure = await startSmokeServer({ WEBHOOK_ALLOW_INSECURE_URLS: 'false' });
  try {
    const signup = await secure.ctx.call('POST', '/merchants', { body: { name: 'SSRF', email: 'ssrf@smoke.test' } });
    const key = signup.body.apiKeys.secret;
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://2130706433/hook',
      'https://0x7f.1/hook',
      'https://0.0.0.0/hook',
    ]) {
      const r = await secure.ctx.call('POST', '/webhooks', { key, body: { url, events: ['*'] } });
      s.check(`secure mode rejects ${url}`, r.status === 400 && r.body?.error?.details?.[0]?.field === 'url', r.body?.error);
    }
  } finally {
    await secure.stop();
  }
  await s.assertAlive('webhooks abuse');
}
