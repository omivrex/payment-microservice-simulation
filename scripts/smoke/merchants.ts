import { randomUUID } from 'node:crypto';
import type { SmokeContext } from './harness.ts';

const email = () => `${randomUUID()}@smoke.test`;

export async function merchants(s: SmokeContext): Promise<void> {
  s.section('Merchants & API keys: happy path');

  const signup = await s.call('POST', '/merchants', { body: { name: 'Smoke Store', email: 'Owner@Smoke.TEST' } });
  s.check('POST /merchants → 201 with merchant + key pair', signup.status === 201 && !!signup.body?.apiKeys?.secret && !!signup.body?.apiKeys?.publishable, signup.body);
  s.check('email stored lowercased', signup.body?.merchant?.email === 'owner@smoke.test');
  const { publishable: pk, secret: sk } = signup.body.apiKeys;
  s.state.merchant = { id: signup.body.merchant.id, pk, sk };

  const me = await s.call('GET', '/merchants/me', { key: sk });
  s.check('GET /merchants/me with the new secret key → 200, same merchant', me.status === 200 && me.body.id === signup.body.merchant.id);
  const keys = await s.call('GET', '/api-keys', { key: sk });
  s.check('GET /api-keys → pk in full, sk masked', keys.status === 200 && keys.body.data.some((k: any) => k.key === pk) && keys.body.data.some((k: any) => k.key === `sk_test_…${sk.slice(-4)}`));

  s.section('Merchants: hostile input');

  const tricky = [
    ["'; DROP TABLE merchants; --", 'SQL injection string'],
    ['<script>alert(1)</script>', 'HTML/script'],
    ['Café 🚀 店', 'unicode + emoji'],
  ];
  for (const [name, label] of tricky) {
    const r = await s.call('POST', '/merchants', { body: { name, email: email() } });
    s.check(`${label} name stored and returned verbatim`, r.status === 201 && r.body.merchant.name === name, r.body);
  }

  const bad: Array<[string, unknown]> = [
    ['whitespace-only name', { name: '   ', email: email() }],
    ['10,000-char name', { name: 'x'.repeat(10_000), email: email() }],
    ['header-injection email', { name: 'A', email: 'a@x.test\r\nBcc: victim@x.test' }],
    ['name as number', { name: 123, email: email() }],
    ['name as array', { name: ['a'], email: email() }],
    ['email as object', { name: 'A', email: { $ne: null } }],
    ['prototype pollution (__proto__)', JSON.parse(`{"name":"A","email":"${email()}","__proto__":{"admin":true}}`)],
    ['constructor key', { name: 'A', email: email(), constructor: { prototype: { admin: true } } }],
    ['typo field', { name: 'A', mail: email() }],
  ];
  for (const [label, body] of bad) {
    const r = await s.call('POST', '/merchants', { body });
    s.check(`${label} → 400 validation_error`, r.status === 400 && r.body?.error?.code === 'validation_error', { status: r.status, body: r.body });
  }

  const dupe = await s.call('POST', '/merchants', { body: { name: 'Dupe', email: 'OWNER@smoke.test' } });
  s.check('duplicate email (different case) → 409 conflict', dupe.status === 409 && dupe.body.error.code === 'conflict');

  const raceEmail = email();
  const race = await Promise.all(Array.from({ length: 8 }, () => s.call('POST', '/merchants', { body: { name: 'Race', email: raceEmail } })));
  s.check('8 simultaneous sign-ups with one email → exactly one 201', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 7, race.map((r) => r.status));

  s.section('Auth: trying to break it');

  const variants: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['empty Bearer', { authorization: 'Bearer ' }],
    ['Basic scheme', { authorization: `Basic ${sk}` }],
    ['key with one char changed', { authorization: `Bearer ${sk.slice(0, -1)}${sk.endsWith('A') ? 'B' : 'A'}` }],
    ['made-up key in valid format', { authorization: `Bearer sk_test_0123456789abcdef_${'A'.repeat(43)}` }],
    ['pk relabelled as sk', { authorization: `Bearer ${pk.replace('pk_', 'sk_')}` }],
    ['8 kb garbage header', { authorization: `Bearer ${'x'.repeat(8000)}` }],
    ['two keys in one header', { authorization: `Bearer ${sk} ${sk}` }],
  ];
  const bodies = new Set<string>();
  for (const [label, headers] of variants) {
    const r = await s.call('GET', '/merchants/me', { headers });
    const { requestId: _r, ...rest } = r.body?.error ?? {};
    bodies.add(JSON.stringify(rest));
    s.check(`${label} → 401`, r.status === 401, r.status);
  }
  s.check('all 401 responses are identical (no hint which part was wrong)', bodies.size === 1, [...bodies]);

  const lower = await s.call('GET', '/merchants/me', { headers: { authorization: `bearer ${sk}` } });
  s.check('lowercase "bearer" scheme accepted', lower.status === 200);
  const pkOnSecret = await s.call('GET', '/merchants/me', { key: pk });
  s.check('publishable key on secret route → 403 forbidden', pkOnSecret.status === 403 && pkOnSecret.body.error.code === 'forbidden');

  s.section('API key rotation');

  const rot = await s.call('POST', '/api-keys/rotate', { key: sk, body: { type: 'secret' } });
  s.check('rotate secret → 200 with a new full key', rot.status === 200 && /^sk_test_/.test(rot.body?.key) && rot.body.key !== sk);
  s.check('old secret key rejected immediately (401)', (await s.call('GET', '/merchants/me', { key: sk })).status === 401);
  s.check('new secret key works', (await s.call('GET', '/merchants/me', { key: rot.body.key })).status === 200);
  s.state.merchant.sk = rot.body.key;

  const many = await Promise.all(Array.from({ length: 10 }, () => s.call('POST', '/api-keys/rotate', { key: s.state.merchant.sk, body: { type: 'secret' } })));
  const issued = many.filter((r) => r.status === 200).map((r) => r.body.key as string);
  const usable: string[] = [];
  for (const k of issued) {
    if ((await s.call('GET', '/merchants/me', { key: k })).status === 200) usable.push(k);
  }
  s.check('10 concurrent rotations → exactly one usable secret key remains', usable.length === 1, { issued: issued.length, usable: usable.length });
  if (usable[0]) s.state.merchant.sk = usable[0];

  const rotPk = await s.call('POST', '/api-keys/rotate', { key: s.state.merchant.sk, body: { type: 'publishable' } });
  s.check('rotate publishable → new pk, secret still works', rotPk.status === 200 && /^pk_test_/.test(rotPk.body.key) && (await s.call('GET', '/merchants/me', { key: s.state.merchant.sk })).status === 200);
  s.state.merchant.pk = rotPk.body.key;

  const badRot = await s.call('POST', '/api-keys/rotate', { key: s.state.merchant.sk, body: { type: 'root' } });
  s.check('rotate with invalid type → 400', badRot.status === 400);
  const pkRot = await s.call('POST', '/api-keys/rotate', { key: s.state.merchant.pk, body: { type: 'secret' } });
  s.check('rotate using a publishable key → 403', pkRot.status === 403);

  const list = await s.call('GET', '/api-keys', { key: s.state.merchant.sk });
  const activeByType = (t: string) => list.body.data.filter((k: any) => k.type === t && k.status === 'active').length;
  s.check('key list: exactly one active key per type, revoked ones kept for audit', activeByType('secret') === 1 && activeByType('publishable') === 1 && list.body.data.some((k: any) => k.status === 'revoked'));

  s.check('401s are logged at warn level ("request rejected")', await s.logMatches(/"level":"warn","msg":"request rejected"[^\n]*"status":401/));
  await s.assertAlive('merchants & auth abuse');
}
