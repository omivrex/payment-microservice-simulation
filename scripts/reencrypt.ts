import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { Encryptor } from '../src/crypto/encryption.ts';
import { JsonDb } from '../src/db/jsonDb.ts';
import { createLogger } from '../src/logging/logger.ts';
import { reencryptAll } from '../src/maintenance/reencrypt.ts';

/**
 * yarn reencrypt — step 3 of master-key rotation (docs/04-security.md §4.4).
 * Stop the service first; the database lock refuses to open a file in use.
 */
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const db = await JsonDb.open({ file: config.dbFile, warnSizeMb: config.dbWarnSizeMb, logger });
try {
  const encryptor = new Encryptor(config.encryptionKeys, config.encryptionActiveKeyId);
  const counts = await reencryptAll(db, encryptor);
  logger.info('re-encryption complete', { activeKeyId: config.encryptionActiveKeyId, ...counts });
} finally {
  await db.close();
}
