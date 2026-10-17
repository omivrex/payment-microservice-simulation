import { randomBytes } from 'node:crypto';
import { isoNow, type Clock } from '../../clock.js';
import { randomSecret, safeEqual, type Hasher } from '../../crypto/hashing.js';
import type { JsonDb } from '../../db/jsonDb.js';
import type { ApiKey, ApiKeyType, CentralData } from '../../db/schema.js';
import { UnauthorizedError } from '../../errors.js';
import type { AuthContext } from '../../http/types.js';

/**
 * API keys: `pk_test_<16 hex id>_<43 chars>` / `sk_test_<16 hex id>_<43 chars>`.
 * Secret keys are stored only as HMAC hashes. See docs/04-security.md §4.2–4.3.
 */

const KEY_PATTERN = /^(pk|sk)_test_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const PREFIX: Record<ApiKeyType, string> = { publishable: 'pk', secret: 'sk' };

export interface ApiKeyView {
  id: string;
  type: ApiKeyType;
  status: 'active' | 'revoked';
  key: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface IssuedKey {
  record: ApiKey;
  /** Full key. Returned to the caller once and never stored for secret keys. */
  plaintext: string;
}

export class ApiKeysService {
  constructor(
    private readonly db: JsonDb,
    private readonly hasher: Hasher,
    private readonly clock: Clock,
  ) {}

  /** Builds a new active key. Pure: callers insert the record inside their own transaction. */
  issue(merchantId: string, type: ApiKeyType): IssuedKey {
    const shortId = randomBytes(8).toString('hex');
    const secret = randomSecret();
    const plaintext = `${PREFIX[type]}_test_${shortId}_${secret}`;
    const record: ApiKey = {
      id: `key_${shortId}`,
      merchantId,
      type,
      status: 'active',
      publishableKey: type === 'publishable' ? plaintext : null,
      secretHash: type === 'secret' ? this.hasher.hashApiKeySecret(secret) : null,
      last4: plaintext.slice(-4),
      createdAt: isoNow(this.clock),
      revokedAt: null,
    };
    return { record, plaintext };
  }

  /**
   * Resolves a raw key to its merchant. Every failure (malformed, unknown,
   * revoked, wrong secret) throws the same UnauthorizedError.
   */
  authenticate(rawKey: string | undefined): AuthContext {
    const match = rawKey ? KEY_PATTERN.exec(rawKey) : null;
    if (!match) throw new UnauthorizedError();
    const [, prefix, shortId, secret] = match as unknown as [string, 'pk' | 'sk', string, string];

    const record = this.db.readCentral((c) => c.apiKeys[`key_${shortId}`]);
    const type: ApiKeyType = prefix === 'pk' ? 'publishable' : 'secret';
    if (!record || record.type !== type || record.status !== 'active') throw new UnauthorizedError();

    const valid =
      type === 'secret'
        ? safeEqual(this.hasher.hashApiKeySecret(secret), record.secretHash ?? '')
        : safeEqual(rawKey!, record.publishableKey ?? '');
    if (!valid) throw new UnauthorizedError();

    return { merchantId: record.merchantId, keyId: record.id, keyType: type };
  }

  list(merchantId: string): ApiKeyView[] {
    return this.db
      .readCentral((c) => Object.values(c.apiKeys).filter((k) => k.merchantId === merchantId))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      .map(toView);
  }

  /** Revokes the active key of `type` and issues a replacement, atomically. See §4.3. */
  async rotate(merchantId: string, type: ApiKeyType): Promise<ApiKeyView> {
    const issued = this.issue(merchantId, type);
    await this.db.transactCentral((c) => {
      revokeActive(c, merchantId, type, issued.record.createdAt);
      c.apiKeys[issued.record.id] = issued.record;
    });
    return { ...toView(issued.record), key: issued.plaintext };
  }
}

function revokeActive(c: CentralData, merchantId: string, type: ApiKeyType, at: string): void {
  for (const key of Object.values(c.apiKeys)) {
    if (key.merchantId === merchantId && key.type === type && key.status === 'active') {
      key.status = 'revoked';
      key.revokedAt = at;
    }
  }
}

export function toView(key: ApiKey): ApiKeyView {
  return {
    id: key.id,
    type: key.type,
    status: key.status,
    key: key.type === 'publishable' ? key.publishableKey! : `sk_test_…${key.last4}`,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
  };
}
