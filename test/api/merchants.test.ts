import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { createMerchant, type TestMerchant } from '../helpers/fixtures.ts';
import { startTestApp, type TestApp } from '../helpers/testApp.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

describe('§5.4 POST /merchants (open sign-up)', () => {
  it('returns 201 with the merchant and a working key pair', async () => {
    const res = await app.api('POST', '/merchants', { body: { name: 'Acme Store', email: 'Dev@Acme.TEST' } });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['apiKeys', 'merchant']);
    assert.deepEqual(Object.keys(res.body.merchant).sort(), ['createdAt', 'email', 'id', 'name', 'updatedAt']);
    assert.match(res.body.merchant.id, /^mer_[0-9a-f]{32}$/);
    assert.equal(res.body.merchant.email, 'dev@acme.test', 'email stored lowercased');
    assert.match(res.body.apiKeys.publishable, /^pk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    assert.match(res.body.apiKeys.secret, /^sk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);

    const me = await app.api('GET', '/merchants/me', { key: res.body.apiKeys.secret });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, res.body.merchant.id);
  });

  it('works without any Authorization header, and ignores one if sent', async () => {
    const res = await app.api('POST', '/merchants', {
      body: { name: 'X', email: 'ignore-key@x.test' },
      headers: { authorization: 'Bearer garbage' },
    });
    assert.equal(res.status, 201);
  });

  it('rejects a duplicate email case-insensitively → 409 conflict', async () => {
    await app.api('POST', '/merchants', { body: { name: 'A', email: 'dup@x.test' } });
    const res = await app.api('POST', '/merchants', { body: { name: 'B', email: 'DUP@X.test' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conflict');
  });

  it('two simultaneous sign-ups with the same email → exactly one succeeds', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => app.api('POST', '/merchants', { body: { name: 'R', email: 'race@x.test' } })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  });

  const invalid: Array<[string, unknown, string]> = [
    ['missing name', { email: 'a@x.test' }, 'name'],
    ['missing email', { name: 'A' }, 'email'],
    ['blank name', { name: '   ', email: 'a@x.test' }, 'name'],
    ['name over 100 chars', { name: 'n'.repeat(101), email: 'a@x.test' }, 'name'],
    ['invalid email', { name: 'A', email: 'not-an-email' }, 'email'],
    ['email over 254 chars', { name: 'A', email: `${'e'.repeat(250)}@x.test` }, 'email'],
    ['non-string name', { name: 42, email: 'a@x.test' }, 'name'],
    ['unknown field (typo)', { name: 'A', email: 'a@x.test', emial: 'x' }, 'emial'],
  ];
  for (const [label, body, field] of invalid) {
    it(`400 validation_error: ${label}`, async () => {
      const res = await app.api('POST', '/merchants', { body });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      assert.ok(res.body.error.details.some((d: any) => d.field === field), JSON.stringify(res.body.error.details));
    });
  }

  it('accepts a name of exactly 100 chars and trims whitespace', async () => {
    const res = await app.api('POST', '/merchants', { body: { name: `  ${'n'.repeat(100)}  `, email: 'trim@x.test' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.merchant.name.length, 100);
  });

  it('non-object bodies and missing Content-Type → 400', async () => {
    for (const rawBody of ['[]', '"x"', 'null']) {
      const res = await app.api('POST', '/merchants', { rawBody, headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 400, rawBody);
    }
    const noType = await app.api('POST', '/merchants', { rawBody: '{"name":"A","email":"a@x.test"}' });
    assert.equal(noType.status, 400);
  });

  it('validation details never echo the submitted value', async () => {
    const res = await app.api('POST', '/merchants', { body: { name: 'A', email: 'secret-value-xyz' } });
    assert.ok(!res.text.includes('secret-value-xyz'));
  });
});

describe('§4.13 authentication', () => {
  let m: TestMerchant;
  before(async () => {
    m = await createMerchant(app);
  });

  it('every bad-key variant → 401 with an identical body (apart from requestId)', async () => {
    const fakeSecret = m.sk.replace(/.{4}$/, 'AAAA');
    const unknownId = m.sk.replace(/^sk_test_[0-9a-f]{16}/, 'sk_test_0000000000000000');
    const variants: Array<Record<string, string>> = [
      {},
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-key' },
      { authorization: `Basic ${m.sk}` },
      { authorization: `Bearer ${fakeSecret}` },
      { authorization: `Bearer ${unknownId}` },
      { authorization: `Bearer ${m.sk}extra` },
      { authorization: `Bearer ${m.pk.replace('pk_test_', 'sk_test_')}` },
    ];
    const bodies = new Set<string>();
    for (const headers of variants) {
      const res = await app.api('GET', '/merchants/me', { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
      const { requestId: _ignored, ...rest } = res.body.error;
      bodies.add(JSON.stringify(rest));
    }
    assert.equal(bodies.size, 1, 'all 401 bodies identical');
  });

  it('the Bearer scheme is case-insensitive', async () => {
    const res = await app.api('GET', '/merchants/me', { headers: { authorization: `bearer ${m.sk}` } });
    assert.equal(res.status, 200);
  });

  it('publishable key on a secret-only route → 403 forbidden', async () => {
    for (const [method, p] of [['GET', '/merchants/me'], ['GET', '/api-keys'], ['POST', '/api-keys/rotate']] as const) {
      const res = await app.api(method, p, { key: m.pk, body: method === 'POST' ? { type: 'secret' } : undefined });
      assert.equal(res.status, 403, `${method} ${p}`);
      assert.equal(res.body.error.code, 'forbidden');
    }
  });

  it('each merchant only sees itself', async () => {
    const other = await createMerchant(app, 'Other');
    const me = await app.api('GET', '/merchants/me', { key: other.sk });
    assert.equal(me.body.id, other.id);
    assert.notEqual(me.body.id, m.id);
  });

  it('the database stores no secret key material (only hashes)', async () => {
    const file = await readFile(app.ctx.config.dbFile, 'utf8');
    assert.ok(!file.includes(m.sk));
    assert.ok(!file.includes(m.sk.split('_').at(-1)!));
  });
});

describe('§5.5 GET /api-keys', () => {
  it('lists both keys: publishable in full, secret masked to last 4', async () => {
    const m = await createMerchant(app);
    const res = await app.api('GET', '/api-keys', { key: m.sk });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2);
    const pk = res.body.data.find((k: any) => k.type === 'publishable');
    const sk = res.body.data.find((k: any) => k.type === 'secret');
    assert.equal(pk.key, m.pk);
    assert.equal(sk.key, `sk_test_…${m.sk.slice(-4)}`);
    for (const k of res.body.data) {
      assert.deepEqual(Object.keys(k).sort(), ['createdAt', 'id', 'key', 'revokedAt', 'status', 'type']);
      assert.match(k.id, /^key_[0-9a-f]{16}$/);
    }
  });
});

describe('§4.13 rotation', () => {
  it('rotating the secret key revokes the old one immediately; the new one works', async () => {
    const m = await createMerchant(app);
    const res = await app.api('POST', '/api-keys/rotate', { key: m.sk, body: { type: 'secret' } });
    assert.equal(res.status, 200);
    assert.match(res.body.key, /^sk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.status, 'active');
    assert.equal((await app.api('GET', '/merchants/me', { key: m.sk })).status, 401, 'old key dead');
    assert.equal((await app.api('GET', '/merchants/me', { key: res.body.key })).status, 200, 'new key works');
  });

  it('rotating the publishable key leaves the secret key working', async () => {
    const m = await createMerchant(app);
    const res = await app.api('POST', '/api-keys/rotate', { key: m.sk, body: { type: 'publishable' } });
    assert.equal(res.status, 200);
    assert.match(res.body.key, /^pk_test_/);
    assert.equal((await app.api('GET', '/merchants/me', { key: m.sk })).status, 200);
    const list = await app.api('GET', '/api-keys', { key: m.sk });
    const pks = list.body.data.filter((k: any) => k.type === 'publishable');
    assert.equal(pks.length, 2);
    assert.equal(pks.filter((k: any) => k.status === 'active').length, 1);
    assert.ok(pks.find((k: any) => k.status === 'revoked').revokedAt);
  });

  it('5 simultaneous rotations → exactly one active secret key, and it works', async () => {
    const m = await createMerchant(app);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => app.api('POST', '/api-keys/rotate', { key: m.sk, body: { type: 'secret' } })),
    );
    const ok = results.filter((r) => r.status === 200);
    assert.ok(ok.length >= 1);
    const db = app.ctx.db.readCentral((c) => Object.values(c.apiKeys).filter((k) => k.merchantId === m.id && k.type === 'secret'));
    assert.equal(db.filter((k) => k.status === 'active').length, 1);
    const working = await Promise.all(ok.map((r) => app.api('GET', '/merchants/me', { key: r.body.key })));
    assert.equal(working.filter((r) => r.status === 200).length, 1, 'only the last issued key works');
  });

  it('invalid rotate bodies → 400', async () => {
    const m = await createMerchant(app);
    for (const body of [{}, { type: 'admin' }, { type: 'secret', extra: true }]) {
      const res = await app.api('POST', '/api-keys/rotate', { key: m.sk, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});

describe('§4.9 rate limits', () => {
  it('6th sign-up from one IP within the window → 429 with Retry-After', async () => {
    const limited = await startTestApp({ config: { rateLimits: { signupPerHour: 5, tokensPerMinute: 60, generalPerMinute: 300 } } });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await limited.api('POST', '/merchants', { body: { name: 'L', email: `limit${i}@x.test` } });
        assert.equal(res.status, 201);
      }
      const res = await limited.api('POST', '/merchants', { body: { name: 'L', email: 'limit6@x.test' } });
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'rate_limited');
      const retryAfter = Number(res.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 3600, `Retry-After ${retryAfter}`);
    } finally {
      await limited.close();
    }
  });

  it('per-key general limit: one key exhausted does not affect another merchant', async () => {
    const limited = await startTestApp({ config: { rateLimits: { signupPerHour: 100, tokensPerMinute: 60, generalPerMinute: 3 } } });
    try {
      const a = await createMerchant(limited);
      const b = await createMerchant(limited);
      for (let i = 0; i < 3; i++) assert.equal((await limited.api('GET', '/merchants/me', { key: a.sk })).status, 200);
      const blocked = await limited.api('GET', '/merchants/me', { key: a.sk });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      assert.equal((await limited.api('GET', '/merchants/me', { key: b.sk })).status, 200);
    } finally {
      await limited.close();
    }
  });
});
