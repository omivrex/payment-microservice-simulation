import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, it } from 'node:test';
import { applySecrets, PLACEHOLDER_COMMENT } from '../../scripts/generate-secrets.ts';
import { loadConfig } from '../../src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');

describe('yarn gen:secrets', () => {
  it('fills the three secrets in .env.example with values the server accepts', () => {
    const { content, set } = applySecrets(example, { force: false });
    assert.deepEqual(set, ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID', 'HASHING_SECRET']);
    const config = loadConfig(parseEnv(content));
    assert.equal(config.encryptionKeys.get('v1')?.length, 32);
    assert.equal(config.encryptionActiveKeyId, 'v1');
    assert.ok(config.hashingSecret.length >= 32);
  });

  it('adds the placeholder comment once, directly above the keys', () => {
    const first = applySecrets(example, { force: false }).content;
    assert.equal(first.split(PLACEHOLDER_COMMENT).length - 1, 1);
    assert.ok(first.includes(`${PLACEHOLDER_COMMENT}\nENCRYPTION_KEYS=v1:`));
    assert.match(first, /placeholder keys/);
    const again = applySecrets(first, { force: true }).content;
    assert.equal(again.split(PLACEHOLDER_COMMENT).length - 1, 1, 'not duplicated on rerun');
  });

  it('keeps existing keys unless --force (replacing them would break existing data)', () => {
    const first = applySecrets(example, { force: false }).content;
    const rerun = applySecrets(first, { force: false });
    assert.equal(rerun.content, first);
    assert.deepEqual(rerun.kept, ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID', 'HASHING_SECRET']);
    const forced = applySecrets(first, { force: true });
    assert.notEqual(parseEnv(forced.content).ENCRYPTION_KEYS, parseEnv(first).ENCRYPTION_KEYS);
    assert.notEqual(parseEnv(forced.content).HASHING_SECRET, parseEnv(first).HASHING_SECRET);
  });

  it('keeps a custom active key id when the encryption keys are kept', () => {
    const custom = 'ENCRYPTION_KEYS=v1:aaa,v2:bbb\nENCRYPTION_ACTIVE_KEY_ID=v2\nHASHING_SECRET=\n';
    const { content, kept, set } = applySecrets(custom, { force: false });
    assert.match(content, /^ENCRYPTION_ACTIVE_KEY_ID=v2$/m);
    assert.deepEqual(kept, ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID']);
    assert.deepEqual(set, ['HASHING_SECRET']);
  });

  it('appends variables that are missing entirely and leaves other settings alone', () => {
    const { content } = applySecrets('PORT=4000\n# HASHING_SECRET=commented-out\n', { force: false });
    const env = parseEnv(content);
    assert.equal(env.PORT, '4000');
    assert.ok(env.ENCRYPTION_KEYS?.startsWith('v1:'));
    assert.ok(env.HASHING_SECRET);
    assert.match(content, /^# HASHING_SECRET=commented-out$/m, 'comments untouched');
  });

  it('end to end: creates .env from .env.example (mode 0600); a second run keeps the keys', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-secrets-'));
    try {
      copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
      const run = () => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'scripts/generate-secrets.ts')], { cwd: dir, encoding: 'utf8' });
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /\.env created/);
      const created = readFileSync(path.join(dir, '.env'), 'utf8');
      if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
      assert.doesNotThrow(() => loadConfig(parseEnv(created)));
      assert.ok(!first.stdout.includes(parseEnv(created).HASHING_SECRET!), 'secrets are not printed');

      const second = run();
      assert.match(second.stdout, /kept: ENCRYPTION_KEYS, ENCRYPTION_ACTIVE_KEY_ID, HASHING_SECRET/);
      assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), created);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
