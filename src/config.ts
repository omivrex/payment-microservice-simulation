import { LOG_LEVELS, type LogLevel } from './logging/logger.js';
import { StartupError } from './errors.js';

/**
 * Reads and validates environment variables. Fails fast with a message naming
 * each bad variable, never its value. See docs/01-architecture.md §1.6.
 */

export interface Config {
  port: number;
  dbFile: string;
  encryptionKeys: Map<string, Buffer>;
  encryptionActiveKeyId: string;
  hashingSecret: Buffer;
  processorLatencyMs: number;
  processorFailureRate: number;
  workerConcurrency: number;
  webhookAllowInsecureUrls: boolean;
  retentionDays: number;
  dbWarnSizeMb: number;
  logLevel: LogLevel;
  rateLimits: {
    signupPerHour: number;
    tokensPerMinute: number;
    generalPerMinute: number;
  };
}

type Env = Record<string, string | undefined>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const required = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined || value.trim() === '') problems.push(`${name} is required`);
    return value?.trim() || undefined;
  };

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  const decimal = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${name} must be a number between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };

  // ENCRYPTION_KEYS=v1:<base64 32 bytes>,v2:<base64 32 bytes>
  const encryptionKeys = new Map<string, Buffer>();
  const rawKeys = required('ENCRYPTION_KEYS');
  if (rawKeys) {
    for (const entry of rawKeys.split(',')) {
      const sep = entry.indexOf(':');
      const id = entry.slice(0, sep).trim();
      const b64 = entry.slice(sep + 1).trim();
      if (sep < 1 || !/^v\d{1,6}$/.test(id)) {
        problems.push('ENCRYPTION_KEYS entries must look like v1:<base64>');
        continue;
      }
      if (encryptionKeys.has(id)) {
        problems.push(`ENCRYPTION_KEYS contains key version ${id} more than once`);
        continue;
      }
      const key = BASE64.test(b64) ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
      if (key.length !== 32) {
        problems.push(`ENCRYPTION_KEYS key ${id} must be 32 bytes encoded as base64`);
        continue;
      }
      encryptionKeys.set(id, key);
    }
  }

  const activeKeyId = required('ENCRYPTION_ACTIVE_KEY_ID') ?? '';
  if (activeKeyId && encryptionKeys.size > 0 && !encryptionKeys.has(activeKeyId)) {
    problems.push('ENCRYPTION_ACTIVE_KEY_ID must name a key version present in ENCRYPTION_KEYS');
  }

  const rawHashing = required('HASHING_SECRET');
  let hashingSecret = Buffer.alloc(0);
  if (rawHashing) {
    hashingSecret = BASE64.test(rawHashing) ? Buffer.from(rawHashing, 'base64') : Buffer.alloc(0);
    if (hashingSecret.length < 32) problems.push('HASHING_SECRET must be at least 32 bytes encoded as base64');
  }

  const rawLevel = env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  const config: Config = {
    port: int('PORT', 3000, 0, 65535),
    dbFile: env.DB_FILE?.trim() || 'data/db.json',
    encryptionKeys,
    encryptionActiveKeyId: activeKeyId,
    hashingSecret,
    processorLatencyMs: int('PROCESSOR_LATENCY_MS', 300, 0, 60_000),
    processorFailureRate: decimal('PROCESSOR_FAILURE_RATE', 0, 0, 1),
    workerConcurrency: int('WORKER_CONCURRENCY', 5, 1, 100),
    webhookAllowInsecureUrls: bool('WEBHOOK_ALLOW_INSECURE_URLS', false),
    retentionDays: int('RETENTION_DAYS', 7, 1, 3650),
    dbWarnSizeMb: int('DB_WARN_SIZE_MB', 10, 1, 100_000),
    logLevel: rawLevel as LogLevel,
    rateLimits: {
      signupPerHour: int('RATE_LIMIT_SIGNUP_PER_HOUR', 5, 1, 1_000_000),
      tokensPerMinute: int('RATE_LIMIT_TOKENS_PER_MINUTE', 60, 1, 1_000_000),
      generalPerMinute: int('RATE_LIMIT_GENERAL_PER_MINUTE', 300, 1, 1_000_000),
    },
  };

  if (problems.length > 0) {
    throw new StartupError(`Invalid configuration: ${problems.join('; ')}`);
  }
  return config;
}
