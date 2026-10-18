import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { card, createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

/**
 * Extracts the webhook receiver script from README.md and runs it exactly as the
 * README instructs, so the documented steps can't silently drift from what works.
 */

const README = readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8');
const match = /<!-- webhook-receiver -->\s*```bash\s*node -e '([\s\S]*?)'\s*```/.exec(README);
const SCRIPT = match?.[1];

let app: TestApp;
let m: TestMerchant;
const children: ChildProcess[] = [];

function startReceiver(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['-e', SCRIPT!], { env: { PATH: process.env.PATH, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const url = new Promise<string>((resolve, reject) => {
    const timer = setInterval(() => {
      const printed = /Receiver listening on (http:\/\/\S+)/.exec(out);
      if (printed) {
        clearInterval(timer);
        resolve(printed[1]!);
      } else if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(out));
      }
    }, 20);
  });
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(out); i++) await new Promise((r) => setTimeout(r, 20));
    return pattern.test(out);
  };
  return { url, output: () => out, waitFor };
}

beforeEach(async () => {
  app = await startTestApp();
  m = await createMerchant(app);
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await app.close();
});

const register = (url: string) => app.api('POST', '/webhooks', { key: m.sk, body: { url, events: ['*'] } });
const pay = () => app.api('POST', '/payments', { key: m.sk, body: { amountMinor: 2500, currency: 'usd', card: card() } });
const deliveries = (endpointId: string) => app.ctx.db.read(m.id, (d) => Object.values(d.webhookDeliveries).filter((x) => x.endpointId === endpointId));

describe('README: webhook receiver script and registration', () => {
  it('the README contains the receiver script', () => {
    assert.ok(SCRIPT, 'receiver block (after <!-- webhook-receiver -->) not found in README.md');
  });

  it('default path: register the printed URL → deliveries succeed and each event is printed', async () => {
    const rx = startReceiver();
    const url = await rx.url;
    assert.match(url, /^http:\/\/localhost:\d+\/webhooks\/payments$/);
    const ep = await register(url);
    assert.equal(ep.status, 201);
    await pay();
    await app.settle();
    await app.runDispatcher();
    const xs = deliveries(ep.body.id);
    assert.equal(xs.length, 3);
    assert.ok(xs.every((x) => x.status === 'succeeded' && x.lastResponseStatus === 200));
    assert.ok(await rx.waitFor(/payment\.captured {2}pay_[0-9a-f]{32} {2}status=captured/));
    assert.match(rx.output(), /payment\.created {2}pay_[0-9a-f]{32} {2}status=pending/);
  });

  it('a custom path of the merchant’s choice (WEBHOOK_PATH=/api/pms/payment) works', async () => {
    const rx = startReceiver({ WEBHOOK_PATH: '/api/pms/payment' });
    const url = await rx.url;
    assert.match(url, /\/api\/pms\/payment$/);
    const ep = await register(url);
    await pay();
    await app.runDispatcher();
    assert.equal(deliveries(ep.body.id)[0]!.lastResponseStatus, 200);
  });

  it('a query string in the registered URL still matches (path-only comparison)', async () => {
    const rx = startReceiver();
    const ep = await register(`${await rx.url}?source=psp`);
    await pay();
    await app.runDispatcher();
    assert.equal(deliveries(ep.body.id)[0]!.lastResponseStatus, 200);
  });

  it('a different registered path → 404 in the delivery log, the receiver says why; PATCH fixes it', async () => {
    const rx = startReceiver();
    const url = await rx.url;
    const ep = await register(url.replace('/webhooks/payments', '/hook'));
    await pay();
    await app.runDispatcher();
    const [x] = deliveries(ep.body.id);
    assert.equal(x!.lastResponseStatus, 404);
    assert.equal(x!.lastError, 'HTTP 404');
    assert.ok(await rx.waitFor(/404: got POST \/hook, but this receiver only accepts POST \/webhooks\/payments/));

    const fixed = await app.api('PATCH', `/webhooks/${ep.body.id}`, { key: m.sk, body: { url } });
    assert.equal(fixed.status, 200);
    app.clock.advance(60_000); // the next retry is 1 minute later
    await app.runDispatcher();
    assert.equal(deliveries(ep.body.id)[0]!.status, 'succeeded');
  });

  for (const [label, host] of [
    ['another program on 127.0.0.1 only (like the Firebase emulator)', '127.0.0.1'],
    ['another program on all addresses', '::'],
  ] as const) {
    it(`port already in use by ${label} → refuses to start, exit 1, tells you to use a free port`, async () => {
      const blocker = createServer().listen(0, host);
      await new Promise((r) => blocker.once('listening', r));
      try {
        const port = (blocker.address() as { port: number }).port;
        const child = spawn(process.execPath, ['-e', SCRIPT!], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        let out = '';
        child.stdout!.on('data', (d) => (out += d));
        child.stderr!.on('data', (d) => (out += d));
        const code = await new Promise((r) => child.once('exit', r));
        assert.equal(code, 1);
        assert.match(out, new RegExp(`Port ${port} is already in use by another program`));
        assert.match(out, /Start the receiver on a free port, e\.g\. PORT=4001, and register that URL/);
        assert.ok(!out.includes('Receiver listening'), 'must not claim to be listening');
      } finally {
        blocker.close();
      }
    });
  }

  it('registering an http://localhost URL without WEBHOOK_ALLOW_INSECURE_URLS → 400 "must use https"', async () => {
    const secure = await startTestApp({ config: { webhookAllowInsecureUrls: false } });
    try {
      const mm = await createMerchant(secure);
      const res = await secure.api('POST', '/webhooks', { key: mm.sk, body: { url: 'http://localhost:4000/webhooks/payments', events: ['*'] } });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.error.details, [{ field: 'url', message: 'must use https' }]);
    } finally {
      await secure.close();
    }
  });
});
