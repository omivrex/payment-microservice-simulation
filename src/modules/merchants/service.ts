import { isoNow, type Clock } from '../../clock.js';
import type { JsonDb } from '../../db/jsonDb.js';
import type { Merchant } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../errors.js';
import { newId } from '../../ids.js';
import type { ApiKeysService } from '../apiKeys/service.js';

export interface MerchantView {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface SignUpResult {
  merchant: MerchantView;
  apiKeys: { publishable: string; secret: string };
}

/**
 * Merchant sign-up is intentionally unauthenticated (docs/README.md: open sign-up).
 * Sign-up touches only the central scope (docs/07-persistence.md §7.2).
 */
export class MerchantsService {
  constructor(
    private readonly db: JsonDb,
    private readonly apiKeys: ApiKeysService,
    private readonly clock: Clock,
  ) {}

  async signUp(input: { name: string; email: string }): Promise<SignUpResult> {
    const now = isoNow(this.clock);
    const email = input.email.toLowerCase();
    const merchant: Merchant = { id: newId('mer'), name: input.name, email, createdAt: now, updatedAt: now };
    const pk = this.apiKeys.issue(merchant.id, 'publishable');
    const sk = this.apiKeys.issue(merchant.id, 'secret');

    await this.db.transactCentral((c) => {
      // Checked inside the transaction so two simultaneous sign-ups can't both succeed.
      if (Object.values(c.merchants).some((m) => m.email === email)) {
        throw new ConflictError('A merchant with this email already exists');
      }
      c.merchants[merchant.id] = merchant;
      c.apiKeys[pk.record.id] = pk.record;
      c.apiKeys[sk.record.id] = sk.record;
    });

    return { merchant: toView(merchant), apiKeys: { publishable: pk.plaintext, secret: sk.plaintext } };
  }

  get(merchantId: string): MerchantView {
    const merchant = this.db.readCentral((c) => c.merchants[merchantId]);
    if (!merchant) throw new NotFoundError('Merchant', merchantId);
    return toView(merchant);
  }
}

const toView = (m: Merchant): MerchantView => ({
  id: m.id,
  name: m.name,
  email: m.email,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});
