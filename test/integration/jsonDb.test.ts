import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { JsonDb, nodeFileOps, type FileOps } from '../../src/db/jsonDb.ts';
import { CURRENT_SCHEMA_VERSION, emptyDatabase } from '../../src/db/schema.ts';
import { StartupError, StorageError } from '../../src/errors.ts';
import { createLogger } from '../../src/logging/logger.ts';

const logger = createLogger({ level: 'debug' });
let dir: string;
let file: string;
const open = (extra: { fileOps?: FileOps; warnSizeMb?: number } = {}) =>
  JsonDb.open({ file, warnSizeMb: extra.warnSizeMb ?? 20, logger, ...(extra.fileOps ? { fileOps: extra.fileOps } : {}) });

const merchant = (id: string) => ({ id, name: 'M', email: `${id}@x.test`, createdAt: 't', updatedAt: 't' });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jsondb-test-'));
  file = path.join(dir, 'db.json');
});
afterEach(async () => {
  mock.restoreAll();
  await rm(dir, { recursive: true, force: true });
});

describe('§7.12 transactions', () => {
  it('a throwing mutator leaves memory and the file unchanged (byte for byte)', async () => {
    const db = await open();
    await db.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
    });
    const before = await readFile(file, 'utf8');
    await assert.rejects(
      db.transactCentral((d) => {
        d.merchants.m2 = merchant('m2');
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(Object.keys(db.readCentral((c) => c.merchants)), ['m1']);
    await db.close();
  });

  it('a committed change survives reopening the file', async () => {
    let db = await open();
    await db.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
    });
    await db.close();
    db = await open();
    assert.equal(db.readCentral((c) => c.merchants.m1?.email), 'm1@x.test');
    await db.close();
  });

  it('mutating values returned by read() or transact() does not change the database', async () => {
    const db = await open();
    const fromTx = await db.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
      return d.merchants.m1;
    });
    fromTx.name = 'hacked';
    const fromRead = db.readCentral((c) => c.merchants.m1!);
    fromRead.email = 'hacked';
    assert.deepEqual(db.readCentral((c) => c.merchants.m1), merchant('m1'));
    await db.close();
  });

  it('100 concurrent increments → 100, in FIFO order', async () => {
    const db = await open();
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        db.transact('m1', (d) => {
          order.push(i);
          const count = Object.keys(d.events).length;
          d.events[`e${count}`] = { id: `e${count}`, merchantId: 'm1', type: 'payment.created', data: { object: {} }, createdAt: 't' };
        }),
      ),
    );
    assert.equal(db.read('m1', (d) => Object.keys(d.events).length), 100);
    assert.deepEqual(order, [...Array(100).keys()]);
    await db.close();
  });

  it('rejects a mutator that returns a Promise, and changes nothing', async () => {
    const db = await open();
    const asyncMutator: any = async (d: any) => {
      d.merchants.m1 = merchant('m1');
    };
    await assert.rejects(db.transactCentral(asyncMutator), /must be synchronous/);
    assert.equal(db.readCentral((c) => c.merchants.m1), undefined);
    await db.close();
  });

  it('the queue keeps working after a failed transaction', async () => {
    const db = await open();
    await assert.rejects(db.transactCentral(() => { throw new Error('x'); }));
    await db.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
    });
    assert.ok(db.readCentral((c) => c.merchants.m1));
    await db.close();
  });
});

describe('§7.12 scopes', () => {
  it('a merchant transaction only sees that merchant’s data', async () => {
    const db = await open();
    await db.transact('mA', (d) => {
      d.tokens.t1 = { id: 't1', merchantId: 'mA', cardId: 'c', expiresAt: 't', usedAt: null, createdAt: 't' };
    });
    const seen = await db.transact('mB', (d) => Object.keys(d.tokens));
    assert.deepEqual(seen, []);
    await db.close();
  });

  it('reading an unknown merchant returns empty collections and writes nothing', async () => {
    const db = await open();
    const before = await readFile(file, 'utf8');
    assert.deepEqual(db.read('nobody', (d) => d.payments), {});
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(db.merchantIds(), []);
    await db.close();
  });

  it('first write creates the scope; scanMerchants sees every merchant', async () => {
    const db = await open();
    for (const m of ['m1', 'm2']) {
      await db.transact(m, (d) => {
        d.tokens[`t-${m}`] = { id: `t-${m}`, merchantId: m, cardId: 'c', expiresAt: 't', usedAt: null, createdAt: 't' };
      });
    }
    const found = db.scanMerchants((merchantId, d) => Object.keys(d.tokens).map((id) => ({ merchantId, id })));
    assert.deepEqual(found.map((f) => f.id).sort(), ['t-m1', 't-m2']);
    await db.close();
  });
});

describe('§7.12 startup and recovery', () => {
  it('creates a missing file with defaults', async () => {
    const db = await open();
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(doc, emptyDatabase());
    await db.close();
  });

  it('deletes a leftover temp file and loads db.json unchanged', async () => {
    const doc = emptyDatabase();
    doc.central.merchants.m1 = merchant('m1');
    await writeFile(file, JSON.stringify(doc));
    await writeFile(`${file}.tmp`, '{"half":');
    const db = await open();
    await assert.rejects(stat(`${file}.tmp`), { code: 'ENOENT' });
    assert.ok(db.readCentral((c) => c.merchants.m1));
    await db.close();
  });

  it('refuses invalid JSON and leaves the file untouched', async () => {
    await writeFile(file, '{"meta": {"schemaVersion": 1}, "central": ');
    await assert.rejects(open(), (err) => err instanceof StartupError && /not valid JSON/.test(err.message));
    assert.equal(await readFile(file, 'utf8'), '{"meta": {"schemaVersion": 1}, "central": ');
    await assert.rejects(stat(`${file}.lock`), { code: 'ENOENT' }, 'lock released after failed open');
  });

  it('refuses an unexpected structure', async () => {
    await writeFile(file, '[]');
    await assert.rejects(open(), /expected structure/);
  });

  it('refuses a schema version newer than supported, file unchanged', async () => {
    const content = JSON.stringify({ ...emptyDatabase(), meta: { schemaVersion: CURRENT_SCHEMA_VERSION + 1 } });
    await writeFile(file, content);
    await assert.rejects(open(), /newer than supported/);
    assert.equal(await readFile(file, 'utf8'), content);
  });
});

describe('§7.12 single-process lock', () => {
  it('a second open on the same file fails while the first holds it', async () => {
    const db = await open();
    await assert.rejects(open(), (err) => err instanceof StartupError && /locked by another running process/.test(err.message));
    await db.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
    });
    await db.close();
  });

  it('takes over a stale lock left by a dead process', async () => {
    const child = spawn(process.execPath, ['-e', '0']);
    await once(child, 'exit');
    await writeFile(`${file}.lock`, String(child.pid));
    const db = await open();
    assert.equal((await readFile(`${file}.lock`, 'utf8')).trim(), String(process.pid));
    await db.close();
  });

  it('close() removes the lock so the file can be reopened', async () => {
    const db = await open();
    await db.close();
    await assert.rejects(stat(`${file}.lock`), { code: 'ENOENT' });
    const again = await open();
    await again.close();
  });

  it('writes after close() fail with StorageError', async () => {
    const db = await open();
    await db.close();
    await assert.rejects(db.transactCentral(() => {}), StorageError);
  });
});

describe('§7.12 file operations', () => {
  const failingRename = (code: string, failures: number): { ops: FileOps; calls: () => number } => {
    let calls = 0;
    return {
      ops: {
        ...nodeFileOps,
        rename: async (from, to) => {
          calls++;
          if (calls <= failures) throw Object.assign(new Error(code), { code });
          return nodeFileOps.rename(from, to);
        },
      },
      calls: () => calls,
    };
  };

  it('retries rename on EPERM and succeeds', async () => {
    const db = await open();
    await db.close();
    const { ops, calls } = failingRename('EPERM', 2);
    const db2 = await open({ fileOps: ops });
    await db2.transactCentral((d) => {
      d.merchants.m1 = merchant('m1');
    });
    assert.equal(calls(), 3);
    await db2.close();
  });

  it('gives up after 5 EPERM failures with StorageError, memory unchanged', async () => {
    const db0 = await open();
    await db0.close();
    const { ops } = failingRename('EBUSY', 99);
    const db = await open({ fileOps: ops });
    await assert.rejects(
      db.transactCentral((d) => {
        d.merchants.m1 = merchant('m1');
      }),
      StorageError,
    );
    assert.equal(db.readCentral((c) => c.merchants.m1), undefined);
    await db.close();
  });

  it('does not retry other errors (ENOENT)', async () => {
    const db0 = await open();
    await db0.close();
    const { ops, calls } = failingRename('ENOENT', 99);
    const db = await open({ fileOps: ops });
    await assert.rejects(db.transactCentral(() => {}), StorageError);
    assert.equal(calls(), 1);
    await db.close();
  });

  it('writes the temp file, fsyncs, then renames (in that order)', async () => {
    const db0 = await open();
    await db0.close();
    const steps: string[] = [];
    const ops: FileOps = {
      ...nodeFileOps,
      open: async (f, flags, mode) => {
        const handle = await nodeFileOps.open(f, flags, mode);
        if (!f.endsWith('.tmp')) return handle;
        return {
          writeFile: async (data) => { steps.push('write'); await handle.writeFile(data); },
          sync: async () => { steps.push('fsync'); await handle.sync(); },
          close: () => handle.close(),
        };
      },
      rename: async (a, b) => { steps.push('rename'); await nodeFileOps.rename(a, b); },
    };
    const db = await open({ fileOps: ops });
    await db.transactCentral(() => {});
    assert.deepEqual(steps, ['write', 'fsync', 'rename']);
    await db.close();
  });

  it('recovers after a storage failure once the directory is writable again (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const db = await open();
    await chmod(dir, 0o500);
    try {
      await assert.rejects(db.transactCentral((d) => { d.merchants.m1 = merchant('m1'); }), StorageError);
    } finally {
      await chmod(dir, 0o700);
    }
    await db.transactCentral((d) => { d.merchants.m1 = merchant('m1'); });
    assert.ok(db.readCentral((c) => c.merchants.m1));
    await db.close();
  });

  it('database file is 0600 and its directory 0700 (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const nested = path.join(dir, 'nested', 'db.json');
    const db = await JsonDb.open({ file: nested, warnSizeMb: 20, logger });
    await chmod(nested, 0o644);
    await db.transactCentral(() => {});
    assert.equal((await stat(nested)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(nested))).mode & 0o777, 0o700);
    await db.close();
  });
});

describe('§7.12 size warning', () => {
  it('warns once on crossing, not again while over, and again after dropping below and re-crossing', async () => {
    const warnings: string[] = [];
    const spyLogger = { ...logger, warn: (msg: string) => warnings.push(msg) };
    const db = await JsonDb.open({ file, warnSizeMb: 1, logger: spyLogger as any });
    const big = 'x'.repeat(600 * 1024);
    await db.transact('m', (d) => { d.idempotency.a = { id: 'a', merchantId: 'm', requestHash: big, status: 'completed', responseStatus: 200, responseBody: null, createdAt: 't', expiresAt: 't' }; });
    assert.equal(warnings.length, 0);
    await db.transact('m', (d) => { d.idempotency.b = { ...d.idempotency.a!, id: 'b' }; });
    assert.equal(warnings.length, 1, 'crossed');
    await db.transact('m', (d) => { d.idempotency.c = { ...d.idempotency.a!, id: 'c', requestHash: 'small' }; });
    assert.equal(warnings.length, 1, 'still over: no repeat');
    await db.transact('m', (d) => { delete d.idempotency.a; delete d.idempotency.b; });
    await db.transact('m', (d) => { d.idempotency.a = { ...d.idempotency.c!, id: 'a', requestHash: big }; d.idempotency.b = { ...d.idempotency.c!, id: 'b', requestHash: big }; });
    assert.equal(warnings.length, 2, 're-armed after dropping below');
    await db.close();

    const again = await JsonDb.open({ file, warnSizeMb: 1, logger: spyLogger as any });
    assert.equal(warnings.length, 3, 'warned at startup');
    await again.close();
  });
});

describe('§7.8 schema migration v1 → v2 (amount fields renamed to *Minor)', () => {
  it('renames payment, job, event-snapshot and idempotency-replay fields; leaves metadata and error bodies alone; persists v2', async () => {
    const v1Payment = {
      id: 'pay_1', status: 'partially_refunded', amount: 2500, currency: 'USD', captureMethod: 'manual',
      amountCaptured: 2000, amountRefunded: 500, metadata: { amount: 'merchant-owned key' },
      pendingAction: { type: 'refund', amount: 500, jobId: 'job_1', previousStatus: 'captured', requestedAt: 't' },
      history: [{ type: 'created', at: 't' }, { type: 'captured', at: 't', amount: 2000 }],
    };
    const v1 = {
      meta: { schemaVersion: 1 },
      central: { merchants: {}, apiKeys: {} },
      merchants: {
        m1: {
          tokens: {}, cards: {}, webhookEndpoints: {}, webhookDeliveries: {},
          payments: { pay_1: v1Payment },
          jobs: { job_1: { id: 'job_1', type: 'refund', amount: 500 } },
          events: { evt_1: { id: 'evt_1', type: 'payment.created', data: { object: structuredClone(v1Payment) }, createdAt: 't' } },
          idempotency: {
            ok: { id: 'ok', status: 'completed', responseStatus: 202, responseBody: structuredClone(v1Payment) },
            err: { id: 'err', status: 'completed', responseStatus: 400, responseBody: { error: { code: 'validation_error', details: [{ field: 'amount', message: 'x' }] } } },
          },
        },
      },
    };
    await writeFile(file, JSON.stringify(v1));
    const db = await open();
    const d = db.read('m1', (x) => x) as any;
    const p = d.payments.pay_1;
    assert.deepEqual([p.amountMinor, p.amountCapturedMinor, p.amountRefundedMinor], [2500, 2000, 500]);
    assert.ok(!('amount' in p) && !('amountCaptured' in p) && !('amountRefunded' in p));
    assert.equal(p.pendingAction.amountMinor, 500);
    assert.equal(p.history[1].amountMinor, 2000);
    assert.deepEqual(p.metadata, { amount: 'merchant-owned key' }, 'merchant metadata untouched');
    assert.equal(d.jobs.job_1.amountMinor, 500);
    assert.equal(d.events.evt_1.data.object.amountMinor, 2500);
    assert.equal(d.idempotency.ok.responseBody.amountCapturedMinor, 2000);
    assert.equal(d.idempotency.err.responseBody.error.details[0].field, 'amount', 'error bodies untouched');
    await db.close();
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.meta.schemaVersion, 2, 'migrated file persisted immediately');
    assert.equal(onDisk.merchants.m1.payments.pay_1.amountMinor, 2500);
  });
});
