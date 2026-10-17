import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { registeredRoutes, toOpenApiPath } from '../../src/http/openapi.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

describe('§1.9 app wiring', () => {
  it('GET /health → 200 {status: ok}', async () => {
    const res = await app.api('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('unknown route → JSON 404 with requestId (no HTML)', async () => {
    const res = await app.api('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.match(res.body.error.requestId, /^req_[0-9a-f]{32}$/);
    assert.match(res.headers.get('content-type')!, /application\/json/);
  });

  it('no X-Powered-By header', async () => {
    const res = await app.api('GET', '/health');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('§8.5 request IDs', () => {
  it('every response has X-Request-Id, matching the error body', async () => {
    const ok = await app.api('GET', '/health');
    assert.match(ok.headers.get('x-request-id')!, /^req_[0-9a-f]{32}$/);
    const err = await app.api('GET', '/missing');
    assert.equal(err.headers.get('x-request-id'), err.body.error.requestId);
  });

  it('reuses a well-formed incoming X-Request-Id', async () => {
    const res = await app.api('GET', '/missing', { headers: { 'x-request-id': 'proxy-abc_123' } });
    assert.equal(res.headers.get('x-request-id'), 'proxy-abc_123');
    assert.equal(res.body.error.requestId, 'proxy-abc_123');
  });

  it('replaces invalid incoming IDs (bad chars, too long)', async () => {
    for (const bad of ['has space', 'x'.repeat(65), 'a"b', 'a\tb']) {
      const res = await app.api('GET', '/health', { headers: { 'x-request-id': bad } });
      assert.match(res.headers.get('x-request-id')!, /^req_[0-9a-f]{32}$/, JSON.stringify(bad));
    }
  });
});

describe('§8.4 error contract for unreadable bodies', () => {
  it('malformed JSON → 400 invalid_json without echoing the body', async () => {
    const res = await app.api('POST', '/health', {
      rawBody: '{"card":{"number":"4242424242424242"',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_json');
    assert.ok(!res.text.includes('4242424242424242'));
  });

  it('body over 100 kb → 413 payload_too_large', async () => {
    const res = await app.api('POST', '/health', { body: { pad: 'x'.repeat(110 * 1024) } });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'payload_too_large');
  });
});

describe('Swagger / OpenAPI', () => {
  it('serves /openapi.json and the Swagger UI at /docs', async () => {
    const spec = await app.api('GET', '/openapi.json');
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, '3.1.0');
    const ui = await app.api('GET', '/docs/');
    assert.equal(ui.status, 200);
    assert.match(ui.text, /swagger/i);
  });

  it('every registered route is documented, and every documented operation is registered', async () => {
    const spec = (await app.api('GET', '/openapi.json')).body;
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries<Record<string, unknown>>(spec.paths)) {
      for (const method of Object.keys(ops)) documented.add(`${method} ${p}`);
    }
    const registered = new Set(registeredRoutes().map((r) => `${r.method} ${toOpenApiPath(r.path)}`));
    assert.deepEqual([...registered].filter((r) => !documented.has(r)), [], 'routes missing from OpenAPI');
    assert.deepEqual([...documented].filter((d) => !registered.has(d)), [], 'documented operations with no route');
  });
});
