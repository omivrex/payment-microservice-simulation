import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { testEnv } from '../helpers/config.ts';
import { listeningPort, spawnServer } from '../helpers/processServer.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'payment-process-test-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const env = (extra: Record<string, string | undefined> = {}) =>
  testEnv({ PORT: '0', DB_FILE: path.join(dir, 'db.json'), ...extra });

describe('§1.9 / §8.9 process behaviour', { timeout: 30_000 }, () => {
  it('missing required config → fatal log naming the variable, exit 1', async () => {
    const server = spawnServer(env({ HASHING_SECRET: undefined }), dir);
    assert.equal(await server.exited(), 1);
    const out = server.output();
    assert.match(out, /"level":"fatal"/);
    assert.match(out, /HASHING_SECRET is required/);
  });

  it('invalid config never prints the value', async () => {
    const shortKey = 'c2hvcnRrZXk=';
    const server = spawnServer(env({ ENCRYPTION_KEYS: `v1:${shortKey}` }), dir);
    assert.equal(await server.exited(), 1);
    assert.ok(!server.output().includes(shortKey));
    assert.match(server.output(), /ENCRYPTION_KEYS key v1 must be 32 bytes/);
  });

  it('SIGTERM → graceful shutdown, lock removed, exit 0', async () => {
    const server = spawnServer(env(), dir);
    const port = await listeningPort(server);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    await stat(path.join(dir, 'db.json.lock'));
    server.child.kill('SIGTERM');
    assert.equal(await server.exited(), 0);
    await assert.rejects(stat(path.join(dir, 'db.json.lock')), { code: 'ENOENT' });
    assert.match(server.output(), /shutdown complete/);
  });

  it('port already in use → fatal "Port is already in use", exit 1, lock released', async () => {
    const blocker = createServer().listen(0, '::'); // same host the server binds by default
    await new Promise((r) => blocker.once('listening', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const server = spawnServer(env({ PORT: String(port) }), dir);
      assert.equal(await server.exited(), 1);
      assert.match(server.output(), /Port is already in use/);
      await assert.rejects(stat(path.join(dir, 'db.json.lock')), { code: 'ENOENT' });
    } finally {
      blocker.close();
    }
  });

  it('invalid JSON database → refuses to start, file untouched, exit 1', async () => {
    await writeFile(path.join(dir, 'db.json'), '{broken');
    const server = spawnServer(env(), dir);
    assert.equal(await server.exited(), 1);
    assert.match(server.output(), /not valid JSON/);
    assert.equal(await readFile(path.join(dir, 'db.json'), 'utf8'), '{broken');
  });

  it('a second instance on the same database refuses to start; the first keeps running', async () => {
    const first = spawnServer(env(), dir);
    const port = await listeningPort(first);
    const second = spawnServer(env(), dir);
    assert.equal(await second.exited(), 1);
    assert.match(second.output(), /locked by another running process/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    first.child.kill('SIGTERM');
    assert.equal(await first.exited(), 0);
  });

  it('restarts cleanly after being killed with SIGKILL (stale lock taken over)', async () => {
    const first = spawnServer(env(), dir);
    await listeningPort(first);
    first.child.kill('SIGKILL');
    await first.exited();
    const second = spawnServer(env(), dir);
    const port = await listeningPort(second);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    second.child.kill('SIGTERM');
    assert.equal(await second.exited(), 0);
  });
});

describe('§8.12 fatal errors and shutdown timeout (fixture using the real lifecycle handlers)', { timeout: 30_000 }, () => {
  const runFixture = (mode: string) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(import.meta.dirname, '../fixtures/crashingProcess.ts'), mode, path.join(dir, 'db.json')], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const exited = once(child, 'exit').then(([code]) => code as number | null);
    return { child, exited, output: () => out };
  };

  it('unhandled rejection → fatal log (redacted), lock released, exit 1', async () => {
    const run = runFixture('rejection');
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /"level":"fatal","msg":"unhandled promise rejection"/);
    assert.ok(!run.output().includes('4242424242424242'), 'card number redacted from the fatal log');
    assert.match(run.output(), /\[REDACTED_PAN\]/);
    await assert.rejects(stat(path.join(dir, 'db.json.lock')), { code: 'ENOENT' });
  });

  it('uncaught exception → fatal log with stack, exit 1', async () => {
    const run = runFixture('exception');
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /"msg":"uncaught exception"[^\n]*"name":"TypeError"[^\n]*"stack"/);
  });

  it('shutdown that hangs → forced exit 1 after the timeout', async () => {
    const run = runFixture('hang');
    while (!run.output().includes('fixture ready')) await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /shutdown timed out; forcing exit/);
    assert.ok(Date.now() - started >= 900, 'waited for the timeout');
  });
});
