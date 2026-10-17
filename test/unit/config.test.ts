import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { StartupError } from '../../src/errors.ts';
import { testEnv } from '../helpers/config.ts';

const fails = (env: Record<string, string | undefined>, pattern: RegExp) => {
  assert.throws(
    () => loadConfig(env),
    (err: unknown) => err instanceof StartupError && pattern.test(err.message),
  );
};

describe('§1.9 configuration', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(testEnv());
    assert.equal(c.port, 3000);
    assert.equal(c.dbFile, 'data/db.json');
    assert.equal(c.processorLatencyMs, 300);
    assert.equal(c.processorFailureRate, 0);
    assert.equal(c.workerConcurrency, 5);
    assert.equal(c.webhookAllowInsecureUrls, false);
    assert.equal(c.retentionDays, 7);
    assert.equal(c.dbWarnSizeMb, 10);
    assert.equal(c.logLevel, 'info');
  });

  for (const name of ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID', 'HASHING_SECRET']) {
    it(`fails naming ${name} when it is missing`, () => {
      fails(testEnv({ [name]: undefined }), new RegExp(`${name} is required`));
    });
  }

  it('rejects an encryption key that is not 32 bytes', () => {
    fails(testEnv({ ENCRYPTION_KEYS: `v1:${randomBytes(16).toString('base64')}` }), /key v1 must be 32 bytes/);
  });

  it('rejects bad base64 and malformed entries', () => {
    fails(testEnv({ ENCRYPTION_KEYS: 'v1:not base64!!' }), /must be 32 bytes/);
    fails(testEnv({ ENCRYPTION_KEYS: 'key1' }), /entries must look like/);
  });

  it('rejects a duplicate key version', () => {
    const k = randomBytes(32).toString('base64');
    fails(testEnv({ ENCRYPTION_KEYS: `v1:${k},v1:${k}` }), /more than once/);
  });

  it('rejects an active key id that is not configured', () => {
    fails(testEnv({ ENCRYPTION_ACTIVE_KEY_ID: 'v2' }), /must name a key version present/);
  });

  it('rejects a short hashing secret', () => {
    fails(testEnv({ HASHING_SECRET: randomBytes(16).toString('base64') }), /HASHING_SECRET must be at least 32 bytes/);
  });

  it('rejects out-of-range values', () => {
    fails(testEnv({ PORT: 'abc' }), /PORT/);
    fails(testEnv({ WORKER_CONCURRENCY: '0' }), /WORKER_CONCURRENCY/);
    fails(testEnv({ PROCESSOR_FAILURE_RATE: '1.5' }), /PROCESSOR_FAILURE_RATE/);
    fails(testEnv({ RETENTION_DAYS: '-1' }), /RETENTION_DAYS/);
    fails(testEnv({ LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
    fails(testEnv({ WEBHOOK_ALLOW_INSECURE_URLS: 'yes' }), /WEBHOOK_ALLOW_INSECURE_URLS/);
  });

  it('reports every problem at once', () => {
    fails({}, /ENCRYPTION_KEYS is required.*ENCRYPTION_ACTIVE_KEY_ID is required.*HASHING_SECRET is required/);
  });

  it('never includes a value in the error message', () => {
    const shortKey = randomBytes(16).toString('base64');
    const shortSecret = randomBytes(8).toString('base64');
    try {
      loadConfig(testEnv({ ENCRYPTION_KEYS: `v1:${shortKey}`, HASHING_SECRET: shortSecret }));
      assert.fail('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      assert.ok(!message.includes(shortKey) && !message.includes(shortSecret));
    }
  });
});
