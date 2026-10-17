import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type AppContext } from '../../src/app.ts';
import type { Config } from '../../src/config.ts';
import { Encryptor } from '../../src/crypto/encryption.ts';
import { Hasher } from '../../src/crypto/hashing.ts';
import { JsonDb } from '../../src/db/jsonDb.ts';
import { createLogger } from '../../src/logging/logger.ts';
import { createServices, type Services } from '../../src/services.ts';
import { testConfig } from './config.ts';
import { FakeClock } from './fakeClock.ts';
import { findLeaks, registerSecret } from './leakGuard.ts';

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface RequestOptions {
  body?: unknown;
  /** Sent verbatim instead of JSON-encoding `body`. */
  rawBody?: string;
  key?: string;
  headers?: Record<string, string>;
}

export interface TestApp {
  baseUrl: string;
  ctx: AppContext;
  services: Services;
  clock: FakeClock;
  dir: string;
  api<T = any>(method: string, urlPath: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

export async function startTestApp(options: { config?: Partial<Config>; buildContext?: (ctx: AppContext) => AppContext } = {}): Promise<TestApp> {
  const dir = await mkdtemp(path.join(tmpdir(), 'payment-service-test-'));
  const config = testConfig({ dbFile: path.join(dir, 'db.json'), ...options.config });
  const logger = createLogger({ level: config.logLevel });
  const clock = new FakeClock();
  const db = await JsonDb.open({ file: config.dbFile, warnSizeMb: config.dbWarnSizeMb, logger });

  let ctx: AppContext = {
    config,
    db,
    logger,
    clock,
    encryptor: new Encryptor(config.encryptionKeys, config.encryptionActiveKeyId),
    hasher: new Hasher(config.hashingSecret),
  };
  if (options.buildContext) ctx = options.buildContext(ctx);

  const services = createServices(ctx);
  const server: Server = createApp(ctx, services).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function api<T = any>(method: string, urlPath: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    const res = await fetch(baseUrl + urlPath, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON (e.g. Swagger HTML) */
    }
    collectSecrets(parsed);
    return { status: res.status, headers: res.headers, body: parsed as T, text };
  }

  return {
    baseUrl,
    ctx,
    services,
    clock,
    dir,
    api,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      const leaks = findLeaks(await readFile(config.dbFile, 'utf8'));
      await rm(dir, { recursive: true, force: true });
      assert.deepEqual(leaks, [], 'secret found in the database file');
    },
  };
}

/** Registers any issued key or webhook secret seen in a response, for the leak checks. */
function collectSecrets(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const match of text.matchAll(/(sk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{43})/g)) {
    registerSecret(match[1]);
  }
}
