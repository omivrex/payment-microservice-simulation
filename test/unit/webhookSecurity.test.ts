import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signWebhook, verifyWebhookSignature } from '../../src/modules/webhooks/signature.ts';
import { assertSafeWebhookUrl, isBlockedAddress, UnsafeUrlError, type HostResolver } from '../../src/modules/webhooks/ssrf.ts';

const resolver = (map: Record<string, string[]>): HostResolver => async (host) => {
  const ips = map[host];
  if (!ips) throw new Error('ENOTFOUND');
  return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const dns = resolver({
  'hooks.example.com': ['93.184.216.34'],
  localhost: ['127.0.0.1'],
  'internal.example.com': ['10.1.2.3'],
  'mixed.example.com': ['93.184.216.34', '192.168.0.10'],
  'v6.example.com': ['2606:4700:4700::1111'],
  'empty.example.com': [],
});
const secure = { allowInsecure: false, resolver: dns };

describe('§4.8 SSRF: blocked address ranges', () => {
  const blocked = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'not-an-ip'];
  const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe('§4.13 SSRF: URL validation (fake DNS)', () => {
  const rejected = [
    'http://hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://[::1]/x',
    'https://10.0.0.1/x',
    'https://172.16.0.1/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[fc00::1]/x',
    'https://0.0.0.0/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://2130706433/x',
    'https://0x7f.1/x',
    'https://internal.example.com/x',
    'https://mixed.example.com/x',
    'https://unknown.example.com/x',
    'https://empty.example.com/x',
    'https://user:pass@hooks.example.com/x',
    'ftp://hooks.example.com/x',
    'not a url',
  ];
  for (const url of rejected) {
    it(`rejects ${url}`, async () => {
      await assert.rejects(assertSafeWebhookUrl(url, secure), UnsafeUrlError);
    });
  }

  it('accepts a public https URL (IPv4 and IPv6 hosts)', async () => {
    assert.equal((await assertSafeWebhookUrl('https://hooks.example.com/payments', secure)).hostname, 'hooks.example.com');
    await assertSafeWebhookUrl('https://v6.example.com/x', secure);
    await assertSafeWebhookUrl('https://93.184.216.34/x', secure);
  });

  it('WEBHOOK_ALLOW_INSECURE_URLS relaxes scheme and address checks (but not credentials)', async () => {
    const insecure = { allowInsecure: true, resolver: dns };
    await assertSafeWebhookUrl('http://localhost:4000/webhooks', insecure);
    await assertSafeWebhookUrl('http://127.0.0.1:4000/webhooks', insecure);
    await assert.rejects(assertSafeWebhookUrl('http://user:pw@localhost/x', insecure), UnsafeUrlError);
  });
});

describe('§4.13 webhook signature helper (the code from docs §6.6)', () => {
  const secret = `whsec_${'s'.repeat(43)}`;
  const body = '{"id":"evt_1","type":"payment.captured"}';
  const t = 1_760_520_600;

  it('accepts our own signature', () => {
    assert.equal(verifyWebhookSignature(body, signWebhook(secret, body, t), secret, { nowSeconds: t + 10 }), true);
    assert.equal(verifyWebhookSignature(Buffer.from(body), signWebhook(secret, body, t), secret, { nowSeconds: t }), true);
  });

  it('rejects a body changed by one byte, a wrong secret, an old timestamp, or a malformed header', () => {
    const header = signWebhook(secret, body, t);
    assert.equal(verifyWebhookSignature(body.replace('captured', 'capturee'), header, secret, { nowSeconds: t }), false);
    assert.equal(verifyWebhookSignature(body, header, `whsec_${'x'.repeat(43)}`, { nowSeconds: t }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { nowSeconds: t + 301 }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { nowSeconds: t - 301 }), false);
    assert.equal(verifyWebhookSignature(body, `t=${t}`, secret, { nowSeconds: t }), false);
    assert.equal(verifyWebhookSignature(body, 'garbage', secret, { nowSeconds: t }), false);
    assert.equal(verifyWebhookSignature(body, undefined, secret, { nowSeconds: t }), false);
    assert.equal(verifyWebhookSignature(body, `t=${t},v1=abcd`, secret, { nowSeconds: t }), false);
  });
});
