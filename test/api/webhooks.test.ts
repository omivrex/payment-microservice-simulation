import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { recordEvent } from '../../src/modules/events/outbox.ts';
import { verifyWebhookSignature } from '../../src/modules/webhooks/signature.ts';
import { RETRY_SCHEDULE_MS } from '../../src/workers/webhookDispatcher.ts';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { SECOND } from '../helpers/fakeClock.ts';
import { startReceiver } from '../helpers/receiver.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
let m: TestMerchant;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

beforeEach(async () => {
  app = await startTestApp({ dispatcher: { timeoutMs: 300 } });
  m = await createMerchant(app);
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
  await app.close();
});

// Each registration gets its own path: a URL can only be registered once per merchant.
let hookPath = 0;
const register = (body: Record<string, unknown>, key = m.sk) =>
  app.api('POST', '/webhooks', { key, body: { url: receiver.url(`/hook-${++hookPath}`), events: ['*'], ...body } });
const pay = (body: Record<string, unknown> = {}) => app.api('POST', '/payments', { key: m.sk, body: { amount: 1000, currency: 'usd', card: card(), ...body } });
const deliveries = (endpointId: string) => app.ctx.db.read(m.id, (d) => Object.values(d.webhookDeliveries).filter((x) => x.endpointId === endpointId));
const nowSeconds = () => Math.floor(app.clock.now().getTime() / 1000);

describe('§5.9 webhook endpoint management', () => {
  it('create returns the secret once; GET/list never include it; stored encrypted', async () => {
    const res = await register({ description: 'All events' });
    assert.equal(res.status, 201);
    assert.match(res.body.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'description', 'enabled', 'events', 'id', 'secret', 'updatedAt', 'url']);
    const got = await app.api('GET', `/webhooks/${res.body.id}`, { key: m.sk });
    assert.ok(!('secret' in got.body) && !got.text.includes(res.body.secret));
    const list = await app.api('GET', '/webhooks', { key: m.sk });
    assert.ok(!list.text.includes('whsec_'));
    const file = await readFile(app.ctx.config.dbFile, 'utf8');
    assert.ok(!file.includes(res.body.secret), 'secret encrypted at rest');
  });

  it('validation: unknown event type, "*" mixed with others, empty list, bad URL, unknown field → 400', async () => {
    for (const body of [
      { events: ['payment.exploded'] },
      { events: ['*', 'payment.captured'] },
      { events: [] },
      { url: 'not a url' },
      { url: 'ftp://x.test/' },
      { url: 'http://user:pw@127.0.0.1/' },
      { secret: 'mine' },
    ]) {
      const res = await register(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('duplicate event types are collapsed', async () => {
    const res = await register({ events: ['payment.captured', 'payment.captured'] });
    assert.deepEqual(res.body.events, ['payment.captured']);
  });

  it('6th endpoint → 409 conflict (limit of 5 per merchant)', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await register({ description: `#${i}` })).status, 201);
    const res = await register({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conflict');
    assert.match(res.body.error.message, /at most 5 webhook endpoints/);
  });

  it('deleting an endpoint frees a slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await register({})).body.id);
    await app.api('DELETE', `/webhooks/${ids[0]}`, { key: m.sk });
    assert.equal((await register({})).status, 201);
  });

  it('the same URL twice → 409 naming the existing endpoint; only one endpoint exists', async () => {
    const url = receiver.url('/dup');
    const first = await register({ url });
    const second = await register({ url, events: ['payment.captured'] });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'conflict');
    assert.ok(second.body.error.message.includes(first.body.id), 'names the existing endpoint');
    assert.match(second.body.error.message, /update that endpoint's "events"/);
    assert.equal((await app.api('GET', '/webhooks', { key: m.sk })).body.data.length, 1);
  });

  it('URLs are compared normalized: host case, default port and #fragment do not make a new URL', async () => {
    const base = await register({ url: 'http://localhost:80/norm' });
    assert.equal(base.body.url, 'http://localhost/norm', 'stored normalized');
    for (const variant of ['HTTP://LOCALHOST/norm', 'http://localhost/norm#section', 'http://LocalHost:80/norm']) {
      assert.equal((await register({ url: variant })).status, 409, variant);
    }
    for (const different of ['http://localhost/norm/', 'http://localhost/norm?x=1', 'http://localhost:8080/norm', 'http://localhost/NORM']) {
      assert.equal((await register({ url: different })).status, 201, `${different} is a different URL`);
    }
  });

  it('a disabled endpoint still holds its URL', async () => {
    const url = receiver.url('/disabled-dup');
    const ep = await register({ url });
    await app.api('PATCH', `/webhooks/${ep.body.id}`, { key: m.sk, body: { enabled: false } });
    assert.equal((await register({ url })).status, 409);
  });

  it('after deleting an endpoint its URL can be registered again', async () => {
    const url = receiver.url('/reuse');
    const ep = await register({ url });
    await app.api('DELETE', `/webhooks/${ep.body.id}`, { key: m.sk });
    assert.equal((await register({ url })).status, 201);
  });

  it('PATCH to a URL another endpoint uses → 409; PATCH keeping its own URL → 200', async () => {
    const a = await register({ url: receiver.url('/a') });
    const b = await register({ url: receiver.url('/b') });
    const clash = await app.api('PATCH', `/webhooks/${b.body.id}`, { key: m.sk, body: { url: receiver.url('/a') } });
    assert.equal(clash.status, 409);
    assert.ok(clash.body.error.message.includes(a.body.id));
    const same = await app.api('PATCH', `/webhooks/${a.body.id}`, { key: m.sk, body: { url: receiver.url('/a'), description: 'same url' } });
    assert.equal(same.status, 200);
  });

  it('5 simultaneous registrations of one URL → exactly one 201', async () => {
    const url = receiver.url('/race');
    const results = await Promise.all(Array.from({ length: 5 }, () => register({ url })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  });

  it('two merchants may register the same URL (uniqueness is per merchant)', async () => {
    const url = receiver.url('/shared');
    const other = await createMerchant(app);
    assert.equal((await register({ url })).status, 201);
    assert.equal((await register({ url }, other.sk)).status, 201);
  });

  it('each event is delivered once per URL', async () => {
    const url = receiver.url('/once');
    await register({ url, events: ['payment.created'] });
    await register({ url, events: ['payment.created'] }); // rejected duplicate
    await pay();
    await app.runDispatcher();
    assert.equal(receiver.requests.filter((r) => r.path === '/once').length, 1);
  });

  it('PATCH updates fields; empty PATCH → 400; another merchant → 404 everywhere', async () => {
    const ep = (await register({})).body;
    const patched = await app.api('PATCH', `/webhooks/${ep.id}`, { key: m.sk, body: { events: ['payment.failed'], description: null } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.events, ['payment.failed']);
    assert.equal((await app.api('PATCH', `/webhooks/${ep.id}`, { key: m.sk, body: {} })).status, 400);
    const other = await createMerchant(app);
    for (const [method, p] of [['GET', `/webhooks/${ep.id}`], ['PATCH', `/webhooks/${ep.id}`], ['DELETE', `/webhooks/${ep.id}`], ['POST', `/webhooks/${ep.id}/rotate-secret`], ['GET', `/webhooks/${ep.id}/deliveries`]] as const) {
      const res = await app.api(method, p, { key: other.sk, ...(method === 'PATCH' ? { body: { enabled: false } } : {}) });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
    assert.equal((await app.api('GET', `/webhooks/${ep.id}`, { key: m.sk })).body.enabled, true, 'untouched');
  });
});

describe('§6.8 outbox and fan-out', () => {
  it('a transaction that records an event then throws stores nothing', async () => {
    await register({});
    await assert.rejects(
      app.ctx.db.transact(m.id, (d) => {
        recordEvent(d, m.id, 'payment.created', { id: 'pay_x' }, app.clock.now().toISOString());
        throw new Error('boom');
      }),
    );
    assert.equal(app.ctx.db.read(m.id, (d) => Object.keys(d.events).length), 0);
    assert.equal(app.ctx.db.read(m.id, (d) => Object.keys(d.webhookDeliveries).length), 0);
  });

  it('filtered endpoint gets only its types; "*" gets all; disabled gets none; capturing/refunding produce no events', async () => {
    const onlyCaptured = (await register({ events: ['payment.captured'] })).body;
    const all = (await register({ events: ['*'] })).body;
    const disabled = (await register({ events: ['*'] })).body;
    await app.api('PATCH', `/webhooks/${disabled.id}`, { key: m.sk, body: { enabled: false } });
    const p = (await pay()).body;
    await app.settle();
    await app.api('POST', `/payments/${p.id}/refund`, { key: m.sk });
    await app.settle();
    const typesFor = (id: string) => deliveries(id).map((x) => app.ctx.db.read(m.id, (d) => d.events[x.eventId]!.type)).sort();
    assert.deepEqual(typesFor(onlyCaptured.id), ['payment.captured']);
    assert.deepEqual(typesFor(all.id), ['payment.authorized', 'payment.captured', 'payment.created', 'payment.refunded']);
    assert.deepEqual(typesFor(disabled.id), []);
  });

  it('an endpoint created after an event gets no delivery for it; events without endpoints are still listed', async () => {
    const p = (await pay()).body;
    const late = (await register({})).body;
    assert.equal(deliveries(late.id).length, 0);
    const events = await app.api('GET', '/events', { key: m.sk });
    assert.ok(events.body.data.some((e: any) => e.type === 'payment.created' && e.data.object.id === p.id));
  });
});

describe('§6.8 delivery outcomes', () => {
  for (const status of [200, 204, 299]) {
    it(`receiver ${status} → succeeded`, async () => {
      receiver.setHandler(() => ({ status }));
      const ep = (await register({})).body;
      await pay();
      await app.runDispatcher();
      const [x] = deliveries(ep.id);
      assert.equal(x!.status, 'succeeded');
      assert.equal(x!.lastResponseStatus, status);
    });
  }

  for (const [status, error] of [[302, 'redirect not followed (HTTP 302)'], [400, 'HTTP 400'], [410, 'HTTP 410'], [500, 'HTTP 500']] as const) {
    it(`receiver ${status} → failed attempt, retry scheduled ("${error}")`, async () => {
      receiver.setHandler(() => ({ status, location: 'http://169.254.169.254/' }));
      const ep = (await register({})).body;
      await pay();
      await app.runDispatcher();
      const [x] = deliveries(ep.id);
      assert.equal(x!.status, 'pending');
      assert.equal(x!.lastError, error);
      assert.equal(Date.parse(x!.nextAttemptAt!) - Date.parse(x!.lastAttemptAt!), RETRY_SCHEDULE_MS[0]);
      assert.equal(receiver.requests.length, 1, 'redirect not followed');
    });
  }

  it('receiver that never responds → "timeout"', async () => {
    receiver.setHandler(() => ({ status: 200, hang: true }));
    const ep = (await register({})).body;
    await pay();
    await app.runDispatcher();
    assert.equal(deliveries(ep.id)[0]!.lastError, 'timeout');
  });

  it('nothing listening → "connection refused"', async () => {
    const dead = await startReceiver();
    const url = dead.url();
    await dead.close();
    const ep = (await register({ url })).body;
    await pay();
    await app.runDispatcher();
    assert.equal(deliveries(ep.id)[0]!.lastError, 'connection refused');
  });

  it('a 10 MB response is not buffered; attempt completes', async () => {
    receiver.setHandler(() => ({ status: 200, streamBytes: 10 * 1024 * 1024 }));
    const ep = (await register({})).body;
    await pay();
    await app.runDispatcher();
    assert.equal(deliveries(ep.id)[0]!.status, 'succeeded');
  });

  it('a hanging endpoint does not delay a healthy one (parallel deliveries)', async () => {
    const slow = await startReceiver(() => ({ status: 200, hang: true }));
    try {
      const slowEp = (await register({ url: slow.url() })).body;
      const fastEp = (await register({})).body;
      await pay();
      const started = Date.now();
      await app.runDispatcher();
      assert.ok(Date.now() - started < 1000, 'both ran in parallel within one timeout');
      assert.equal(deliveries(fastEp.id)[0]!.status, 'succeeded');
      assert.equal(deliveries(slowEp.id)[0]!.lastError, 'timeout');
    } finally {
      await slow.close();
    }
  });
});

describe('§6.8 retry schedule', () => {
  it('always failing: attempts spaced 1m, 5m, 30m, 2h, 6h, 12h, 24h; failed after the 8th', async () => {
    receiver.setHandler(() => ({ status: 500 }));
    const ep = (await register({ events: ['payment.created'] })).body;
    await pay();
    await app.runDispatcher();
    for (const delay of RETRY_SCHEDULE_MS) {
      const x = deliveries(ep.id)[0]!;
      assert.equal(Date.parse(x.nextAttemptAt!) - Date.parse(x.lastAttemptAt!), delay);
      app.clock.advance(delay - 1);
      await app.runDispatcher();
      assert.equal(deliveries(ep.id)[0]!.attempts, x.attempts, 'not retried early');
      app.clock.advance(1);
      await app.runDispatcher();
    }
    const final = deliveries(ep.id)[0]!;
    assert.equal(final.attempts, 8);
    assert.equal(final.status, 'failed');
    assert.equal(final.nextAttemptAt, null);
    app.clock.advance(48 * 3_600_000);
    await app.runDispatcher();
    assert.equal(receiver.requests.length, 8, 'no further attempts');
  });

  it('receiver recovers at attempt 4 → succeeded, no more sends', async () => {
    let n = 0;
    receiver.setHandler(() => ({ status: ++n < 4 ? 503 : 200 }));
    const ep = (await register({ events: ['payment.created'] })).body;
    await pay();
    for (let i = 0; i < 6; i++) {
      await app.runDispatcher();
      app.clock.advance(3 * 3_600_000);
    }
    assert.equal(deliveries(ep.id)[0]!.status, 'succeeded');
    assert.equal(receiver.requests.length, 4);
  });
});

describe('§6.8 signatures and headers', () => {
  it('every delivery verifies with the documented receiver code and the endpoint secret', async () => {
    const ep = (await register({})).body;
    await pay();
    await app.settle();
    await app.runDispatcher();
    assert.ok(receiver.requests.length >= 3);
    for (const req of receiver.requests) {
      assert.equal(verifyWebhookSignature(req.body, req.headers['webhook-signature'] as string, ep.secret, { nowSeconds: nowSeconds() }), true);
      const body = JSON.parse(req.body);
      assert.equal(req.headers['webhook-id'], body.id);
      assert.equal(req.headers['webhook-event'], body.type);
      assert.match(req.headers['content-type'] as string, /application\/json/);
      assert.match(req.headers['webhook-signature'] as string, new RegExp(`^t=${nowSeconds()},v1=[0-9a-f]{64}$`));
    }
  });

  it('after rotate-secret, deliveries verify with the new secret and fail with the old one', async () => {
    const ep = (await register({})).body;
    const rotated = await app.api('POST', `/webhooks/${ep.id}/rotate-secret`, { key: m.sk });
    assert.equal(rotated.status, 200);
    await pay();
    await app.runDispatcher();
    const req = receiver.requests[0]!;
    const sig = req.headers['webhook-signature'] as string;
    assert.equal(verifyWebhookSignature(req.body, sig, rotated.body.secret, { nowSeconds: nowSeconds() }), true);
    assert.equal(verifyWebhookSignature(req.body, sig, ep.secret, { nowSeconds: nowSeconds() }), false);
  });

  it('data.object is the payment as it was when the event happened', async () => {
    await register({ events: ['payment.created'] });
    const p = (await pay({ description: 'before' })).body;
    await app.api('PATCH', `/payments/${p.id}`, { key: m.sk, body: { description: 'after' } });
    await app.runDispatcher();
    assert.equal(JSON.parse(receiver.requests[0]!.body).data.object.description, 'before');
  });
});

describe('§6.8 endpoint changes during delivery', () => {
  it('deleted endpoint → pending deliveries failed ("endpoint deleted"), nothing sent', async () => {
    const ep = (await register({})).body;
    await pay();
    assert.equal((await app.api('DELETE', `/webhooks/${ep.id}`, { key: m.sk })).status, 204);
    await app.runDispatcher();
    assert.equal(receiver.requests.length, 0);
    const xs = deliveries(ep.id);
    assert.ok(xs.length > 0 && xs.every((x) => x.status === 'failed' && x.lastError === 'endpoint deleted'));
  });

  it('disabled endpoint → pending deliveries failed ("endpoint disabled"), nothing sent', async () => {
    const ep = (await register({})).body;
    await pay();
    await app.api('PATCH', `/webhooks/${ep.id}`, { key: m.sk, body: { enabled: false } });
    await app.runDispatcher();
    assert.equal(receiver.requests.length, 0);
    assert.ok(deliveries(ep.id).every((x) => x.lastError === 'endpoint disabled'));
  });

  it('URL changed while a retry is pending → next attempt goes to the new URL', async () => {
    receiver.setHandler(() => ({ status: 500 }));
    const ep = (await register({ events: ['payment.created'] })).body;
    await pay();
    await app.runDispatcher();
    const second = await startReceiver();
    try {
      await app.api('PATCH', `/webhooks/${ep.id}`, { key: m.sk, body: { url: second.url('/new') } });
      app.clock.advance(RETRY_SCHEDULE_MS[0]!);
      await app.runDispatcher();
      assert.equal(second.requests.length, 1);
      assert.equal(second.requests[0]!.path, '/new');
      assert.equal(deliveries(ep.id)[0]!.status, 'succeeded');
    } finally {
      await second.close();
    }
  });
});

describe('§6.8 guarantees', () => {
  it('lease expires mid-send → sent again with the same Webhook-Id; stale result discarded', async () => {
    receiver.setHandler(() => ({ status: 200, hang: true }));
    const slowApp = await startTestApp({ dispatcher: { timeoutMs: 5000 } });
    try {
      const mm = await createMerchant(slowApp);
      await slowApp.api('POST', '/webhooks', { key: mm.sk, body: { url: receiver.url(), events: ['payment.created'] } });
      await slowApp.api('POST', '/payments', { key: mm.sk, body: { amount: 1, currency: 'usd', card: card() } });
      await slowApp.dispatcher.tickOnce(); // attempt 1 claimed, receiver holds it
      await new Promise((r) => setTimeout(r, 50));
      slowApp.clock.advance(31 * SECOND);
      await slowApp.dispatcher.tickOnce(); // lease expired → reclaimed, attempt 2
      await new Promise((r) => setTimeout(r, 50));
      receiver.releaseHeld(200);
      await slowApp.dispatcher.whenIdle();
      assert.equal(receiver.requests.length, 2);
      assert.equal(receiver.requests[0]!.headers['webhook-id'], receiver.requests[1]!.headers['webhook-id']);
      const xs = slowApp.ctx.db.read(mm.id, (d) => Object.values(d.webhookDeliveries));
      assert.equal(xs[0]!.status, 'succeeded');
      assert.equal(xs[0]!.attempts, 2);
    } finally {
      await slowApp.close();
    }
  });

  it('concurrent tickOnce() calls send each delivery once', async () => {
    await register({ events: ['payment.created'] });
    await pay();
    await pay();
    await Promise.all([app.dispatcher.tickOnce(), app.dispatcher.tickOnce(), app.dispatcher.tickOnce()]);
    await app.dispatcher.whenIdle();
    assert.equal(receiver.requests.length, 2);
  });
});

describe('§4.13 SSRF at registration and delivery (fake DNS, secure mode)', () => {
  it('DNS rebinding: public at registration, private at delivery → blocked, no connection', async () => {
    let target = '93.184.216.34';
    const secureApp = await startTestApp({
      config: { webhookAllowInsecureUrls: false },
      buildContext: (ctx) => ({ ...ctx, resolveHost: async () => [{ address: target, family: 4 }] }),
    });
    try {
      const mm = await createMerchant(secureApp);
      const created = await secureApp.api('POST', '/webhooks', { key: mm.sk, body: { url: 'https://hooks.rebind.test/x', events: ['*'] } });
      assert.equal(created.status, 201);
      target = '127.0.0.1';
      await secureApp.api('POST', '/payments', { key: mm.sk, body: { amount: 1, currency: 'usd', card: card() } });
      await secureApp.runDispatcher();
      const x = secureApp.ctx.db.read(mm.id, (d) => Object.values(d.webhookDeliveries)[0]!);
      assert.match(x.lastError!, /^blocked:/);
      assert.equal(x.status, 'pending', 'counted as a failed attempt');
    } finally {
      await secureApp.close();
    }
  });

  it('registration rejects private targets in secure mode', async () => {
    const secureApp = await startTestApp({
      config: { webhookAllowInsecureUrls: false },
      buildContext: (ctx) => ({ ...ctx, resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] }),
    });
    try {
      const mm = await createMerchant(secureApp);
      for (const url of ['https://internal.test/x', 'http://hooks.example.com/x', 'https://169.254.169.254/', 'https://[::ffff:127.0.0.1]/']) {
        const res = await secureApp.api('POST', '/webhooks', { key: mm.sk, body: { url, events: ['*'] } });
        assert.equal(res.status, 400, url);
        assert.equal(res.body.error.details[0].field, 'url');
      }
    } finally {
      await secureApp.close();
    }
  });
});

describe('§5.10 events API and delivery log', () => {
  it('GET /events filters by type, newest first; GET /events/:id; isolation', async () => {
    const p = (await pay()).body;
    await app.settle();
    const captured = await app.api('GET', '/events?type=payment.captured', { key: m.sk });
    assert.equal(captured.body.total, 1);
    assert.equal(captured.body.data[0].data.object.id, p.id);
    assert.equal(captured.body.data[0].data.object.status, 'captured');
    const one = await app.api('GET', `/events/${captured.body.data[0].id}`, { key: m.sk });
    assert.equal(one.status, 200);
    const other = await createMerchant(app);
    assert.equal((await app.api('GET', `/events/${captured.body.data[0].id}`, { key: other.sk })).status, 404);
    assert.equal((await app.api('GET', '/events', { key: other.sk })).body.total, 0);
    assert.equal((await app.api('GET', '/events?type=payment.nope', { key: m.sk })).status, 400);
  });

  it('GET /webhooks/:id/deliveries lists attempts with status filter', async () => {
    receiver.setHandler(() => ({ status: 500 }));
    const ep = (await register({ events: ['payment.created'] })).body;
    await pay();
    await app.runDispatcher();
    const log = await app.api('GET', `/webhooks/${ep.id}/deliveries?status=pending`, { key: m.sk });
    assert.equal(log.status, 200);
    assert.equal(log.body.total, 1);
    assert.equal(log.body.data[0].lastResponseStatus, 500);
    assert.equal(log.body.data[0].lastError, 'HTTP 500');
    assert.equal((await app.api('GET', `/webhooks/${ep.id}/deliveries?status=succeeded`, { key: m.sk })).body.total, 0);
  });
});

