import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestApp } from './testApp.ts';

export interface TestMerchant {
  id: string;
  pk: string;
  sk: string;
}

export async function createMerchant(app: TestApp, name = 'Test Merchant'): Promise<TestMerchant> {
  const res = await app.api('POST', '/merchants', { body: { name, email: `${randomUUID()}@merchant.test` } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.merchant.id, pk: res.body.apiKeys.publishable, sk: res.body.apiKeys.secret };
}

export const card = (number = '4242424242424242', overrides: Record<string, unknown> = {}) => ({
  number,
  expMonth: 12,
  expYear: 2030,
  cvc: '123',
  ...overrides,
});
