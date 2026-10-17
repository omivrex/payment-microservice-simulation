import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Smoke-test harness: starts the REAL server (src/server.ts) on a random port
 * with fresh secrets and a temp database, then runs scenario files against it.
 */

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  key?: string;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  headers: Headers;
  body: any;
  text: string;
  ms: number;
}

export interface SmokeContext {
  baseUrl: string;
  port: number;
  dataDir: string;
  call(method: string, urlPath: string, options?: CallOptions): Promise<CallResult>;
  check(name: string, ok: boolean, detail?: unknown): void;
  section(title: string): void;
  serverOutput(): string;
  /** Asserts the server process is still alive and healthy. */
  assertAlive(label: string): Promise<void>;
  /** Shared state between scenarios (e.g. merchant keys). */
  state: Record<string, any>;
  issuedSecrets: Set<string>;
  sleep(ms: number): Promise<void>;
  waitUntil<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs?: number): Promise<T | undefined>;
  /** Log lines are written when a response closes, just after the client sees it, so poll briefly. */
  logMatches(pattern: RegExp, timeoutMs?: number): Promise<boolean>;
}

export interface SmokeServer {
  ctx: SmokeContext;
  results: { passed: number; failed: string[] };
  stop(): Promise<number | null>;
}

const ROOT = path.resolve(import.meta.dirname, '../..');

export async function startSmokeServer(extraEnv: Record<string, string> = {}): Promise<SmokeServer> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'payment-smoke-'));
  const env = {
    PATH: process.env.PATH ?? '',
    ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    ENCRYPTION_ACTIVE_KEY_ID: 'v1',
    HASHING_SECRET: randomBytes(32).toString('base64'),
    PORT: '0',
    DB_FILE: path.join(dataDir, 'db.json'),
    PROCESSOR_LATENCY_MS: '50',
    WEBHOOK_ALLOW_INSECURE_URLS: 'true',
    LOG_LEVEL: 'debug',
    ...extraEnv,
  };

  const child: ChildProcess = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'src/server.ts')], {
    cwd: dataDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  process.on('exit', () => child.kill('SIGKILL'));

  const deadline = Date.now() + 20_000;
  let port = 0;
  while (!port) {
    const m = /"msg":"payment service listening","port":(\d+)/.exec(output);
    if (m) port = Number(m[1]);
    else if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server failed to start:\n${output}`);
    else await new Promise((r) => setTimeout(r, 50));
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const results = { passed: 0, failed: [] as string[] };
  const issuedSecrets = new Set<string>();

  const ctx: SmokeContext = {
    baseUrl,
    port,
    dataDir,
    state: {},
    issuedSecrets,
    async call(method, urlPath, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      let body: string | undefined;
      if (options.rawBody !== undefined) body = options.rawBody;
      else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers['content-type'] ??= 'application/json';
      }
      if (options.key) headers.authorization = `Bearer ${options.key}`;
      const started = Date.now();
      const res = await fetch(baseUrl + urlPath, { method, headers, body });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        /* not JSON */
      }
      for (const m of text.matchAll(/(sk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{43})/g)) issuedSecrets.add(m[1]!);
      return { status: res.status, headers: res.headers, body: parsed, text, ms: Date.now() - started };
    },
    check(name, ok, detail) {
      if (ok) {
        results.passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      } else {
        results.failed.push(name);
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 600)}`);
      }
    },
    section(title) {
      console.log(`\n\x1b[1m${title}\x1b[0m`);
    },
    serverOutput: () => output,
    async assertAlive(label) {
      let ok = child.exitCode === null;
      if (ok) {
        try {
          ok = (await fetch(`${baseUrl}/health`)).status === 200;
        } catch {
          ok = false;
        }
      }
      ctx.check(`server still healthy after: ${label}`, ok);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async logMatches(pattern, timeoutMs = 2000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (pattern.test(output)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return pattern.test(output);
    },
    async waitUntil(label, fn, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 100));
      }
      ctx.check(`timed out waiting for: ${label}`, false);
      return undefined;
    },
  };

  return {
    ctx,
    results,
    async stop() {
      child.kill('SIGTERM');
      const code = await exited;
      const dbText = await readFile(env.DB_FILE, 'utf8').catch(() => '');
      scanForLeaks(ctx, 'server logs', output);
      scanForLeaks(ctx, 'database file', dbText);
      await rm(dataDir, { recursive: true, force: true });
      return code;
    },
  };
}

const CARDS = ['4242424242424242', '5555555555554444', '4000000000000002', '4000000000009995', '4000000000000069', '4000000000000127', '4000000000000119'];

/** The random part of a key: base64url may itself contain '_', so slice by fixed position. */
export const secretPart = (key: string): string => (key.startsWith('whsec_') ? key.slice(6) : key.slice('sk_test_'.length + 17));

function scanForLeaks(ctx: SmokeContext, where: string, text: string): void {
  const flat = text.replace(/[ -]/g, '');
  const leaks: string[] = [];
  for (const pan of CARDS) if (flat.includes(pan)) leaks.push(`card …${pan.slice(-4)}`);
  for (const s of ctx.issuedSecrets) if (text.includes(s) || text.includes(secretPart(s))) leaks.push(`${s.slice(0, 8)}…`);
  if (/"cvc"\s*:\s*"\d{3,4}"/.test(text)) leaks.push('CVC');
  ctx.check(`no card numbers, CVCs or secrets in the ${where}`, leaks.length === 0, leaks);
}
