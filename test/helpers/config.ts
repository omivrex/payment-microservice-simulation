import { randomBytes } from 'node:crypto';
import type { Config } from '../../src/config.ts';

export const testEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'v1',
  HASHING_SECRET: randomBytes(32).toString('base64'),
  ...overrides,
});

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    dbFile: 'unused.json',
    encryptionKeys: new Map([['v1', randomBytes(32)]]),
    encryptionActiveKeyId: 'v1',
    hashingSecret: randomBytes(32),
    processorLatencyMs: 0,
    processorFailureRate: 0,
    workerConcurrency: 5,
    webhookAllowInsecureUrls: true,
    retentionDays: 7,
    dbWarnSizeMb: 20,
    logLevel: 'debug',
    ...overrides,
  };
}
