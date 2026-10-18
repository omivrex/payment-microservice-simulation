import * as fsp from 'node:fs/promises';
import { Immer } from 'immer';
import path from 'node:path';
import { StartupError, StorageError } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { migrate } from './migrations.js';
import {
  CURRENT_SCHEMA_VERSION,
  emptyDatabase,
  emptyMerchantData,
  type CentralData,
  type DatabaseFile,
  type MerchantData,
} from './schema.js';

/**
 * File-backed JSON database with scoped, serialized, all-or-nothing transactions.
 * See docs/07-persistence.md.
 */

export interface FileHandleLike {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** File operations, injectable so tests can simulate failures on any OS (docs/09-testing.md §9.3). */
export interface FileOps {
  open(file: string, flags: string, mode: number): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  readFile(file: string): Promise<string>;
  unlink(file: string): Promise<void>;
  mkdir(dir: string, mode: number): Promise<void>;
}

export const nodeFileOps: FileOps = {
  open: (file, flags, mode) => fsp.open(file, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  readFile: (file) => fsp.readFile(file, 'utf8'),
  unlink: (file) => fsp.unlink(file),
  mkdir: async (dir, mode) => {
    await fsp.mkdir(dir, { recursive: true, mode });
  },
};

export interface JsonDbOptions {
  file: string;
  warnSizeMb: number;
  logger: Logger;
  fileOps?: FileOps;
}

type Sync<T> = T extends PromiseLike<unknown> ? never : T;

// Auto-freeze off: committed state is only ever replaced (never mutated), and reads return copies anyway.
const immer = new Immer({ autoFreeze: false });

/** Deep plain-JSON copy. Works on Immer drafts (unlike structuredClone). Records are JSON-safe by design. */
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const RENAME_ATTEMPTS = 5;

const isErrno = (err: unknown, ...codes: string[]): boolean =>
  typeof err === 'object' && err !== null && codes.includes((err as NodeJS.ErrnoException).code ?? '');

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrno(err, 'EPERM'); // exists but owned by another user
  }
}

export class JsonDb {
  readonly #file: string;
  readonly #tmpFile: string;
  readonly #lockFile: string;
  readonly #ops: FileOps;
  readonly #logger: Logger;
  readonly #warnBytes: number;
  #data: DatabaseFile;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #overSizeThreshold = false;

  private constructor(options: Required<JsonDbOptions>, data: DatabaseFile) {
    this.#file = path.resolve(options.file);
    this.#tmpFile = `${this.#file}.tmp`;
    this.#lockFile = `${this.#file}.lock`;
    this.#ops = options.fileOps;
    this.#logger = options.logger;
    this.#warnBytes = options.warnSizeMb * 1024 * 1024;
    this.#data = data;
  }

  /** Take the lock, recover from an interrupted commit, load (or create) the file. See §7.8. */
  static async open(options: JsonDbOptions): Promise<JsonDb> {
    const opts: Required<JsonDbOptions> = { fileOps: nodeFileOps, ...options };
    const file = path.resolve(opts.file);
    await opts.fileOps.mkdir(path.dirname(file), 0o700);
    await JsonDb.#acquireLock(opts.fileOps, `${file}.lock`);

    try {
      await opts.fileOps.unlink(`${file}.tmp`).catch((err) => {
        if (!isErrno(err, 'ENOENT')) throw err;
      });

      let raw: string | null = null;
      try {
        raw = await opts.fileOps.readFile(file);
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw new StartupError('Database file could not be read', { cause: err });
      }

      const parsed = raw === null ? null : JsonDb.#parse(raw);
      const db = new JsonDb(opts, parsed?.doc ?? emptyDatabase());
      if (raw === null) await db.#write(db.#data);
      else if (parsed!.migratedTo.length > 0) {
        // Persist immediately, so the file on disk is never left in a mix of old and new shapes.
        await db.#write(db.#data);
        opts.logger.info('database file migrated', { toSchemaVersion: parsed!.migratedTo.at(-1) });
      } else db.#checkSize(Buffer.byteLength(raw), true);
      return db;
    } catch (err) {
      await opts.fileOps.unlink(`${file}.lock`).catch(() => {});
      throw err;
    }
  }

  static #parse(raw: string): { doc: DatabaseFile; migratedTo: number[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StartupError('Database file is not valid JSON; refusing to start so it can be inspected');
    }
    const doc = parsed as Partial<DatabaseFile> | null;
    if (
      !doc ||
      typeof doc !== 'object' ||
      typeof doc.meta?.schemaVersion !== 'number' ||
      typeof doc.central !== 'object' ||
      typeof doc.merchants !== 'object'
    ) {
      throw new StartupError('Database file does not have the expected structure; refusing to start');
    }
    if (doc.meta.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new StartupError(
        `Database file uses schema version ${doc.meta.schemaVersion}, newer than supported (${CURRENT_SCHEMA_VERSION}); refusing to start`,
      );
    }
    const migratedTo = migrate(doc as never, CURRENT_SCHEMA_VERSION);
    return { doc: doc as DatabaseFile, migratedTo };
  }

  static async #acquireLock(ops: FileOps, lockFile: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await ops.open(lockFile, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (err) {
        if (!isErrno(err, 'EEXIST')) throw new StartupError('Could not create database lock file', { cause: err });
        const pid = Number((await ops.readFile(lockFile).catch(() => '')).trim());
        if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
          throw new StartupError(`Database is locked by another running process (PID ${pid}); refusing to start`);
        }
        await ops.unlink(lockFile).catch(() => {}); // stale lock from a crashed process
      }
    }
    throw new StartupError('Could not acquire database lock');
  }

  // ---------------------------------------------------------------- reads

  readCentral<T>(selector: (central: Readonly<CentralData>) => T): T {
    return structuredClone(selector(this.#data.central));
  }

  /** A merchant with no data yet reads as empty collections; nothing is written. */
  read<T>(merchantId: string, selector: (data: Readonly<MerchantData>) => T): T {
    return structuredClone(selector(this.#data.merchants[merchantId] ?? emptyMerchantData()));
  }

  /** Read-only scan across all merchant scopes, for workers and housekeeping. */
  scanMerchants<T>(selector: (merchantId: string, data: Readonly<MerchantData>) => T[]): T[] {
    const out: T[] = [];
    for (const [merchantId, data] of Object.entries(this.#data.merchants)) out.push(...selector(merchantId, data));
    return structuredClone(out);
  }

  merchantIds(): string[] {
    return Object.keys(this.#data.merchants);
  }

  // ---------------------------------------------------------------- writes

  transactCentral<T>(mutator: (draft: CentralData) => Sync<T>): Promise<T> {
    return this.#enqueue(() => {
      const { next, result } = JsonDb.#produce(this.#data.central, mutator);
      return { next: { ...this.#data, central: next }, result };
    });
  }

  transact<T>(merchantId: string, mutator: (draft: MerchantData) => Sync<T>): Promise<T> {
    return this.#enqueue(() => {
      const base = this.#data.merchants[merchantId] ?? emptyMerchantData();
      const { next, result } = JsonDb.#produce(base, mutator);
      return { next: { ...this.#data, merchants: { ...this.#data.merchants, [merchantId]: next } }, result };
    });
  }

  /** Wait for queued transactions, then release the lock. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#ops.unlink(this.#lockFile).catch(() => {});
  }

  get fileSizeBytes(): number {
    return Buffer.byteLength(JSON.stringify(this.#data));
  }

  /**
   * Copy-on-write transaction (docs/07-persistence.md §7.11, option C): the mutator works on an
   * Immer draft, so only the records it changes are copied. Unchanged records are shared with the
   * committed state, which is never mutated. If the mutator throws, the draft is discarded.
   * The result is copied to plain JSON inside the draft, so callers never hold a draft (Proxy).
   */
  static #produce<D extends object, T>(base: D, mutator: (draft: D) => T): { next: D; result: T } {
    let result: T | undefined;
    const next = immer.produce(base, (draft) => {
      const r = mutator(draft as D);
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        throw new TypeError('Transaction mutators must be synchronous; move async work outside the transaction');
      }
      result = r === undefined ? undefined : plain(r);
    });
    return { next, result: result as T };
  }

  #enqueue<T>(prepare: () => { next: DatabaseFile; result: T }): Promise<T> {
    if (this.#closed) return Promise.reject(new StorageError(new Error('Database is closed')));
    const run = this.#tail.then(async () => {
      const { next, result } = prepare(); // throws → rejected, nothing changed
      await this.#write(next);
      this.#data = next;
      return result;
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #write(doc: DatabaseFile): Promise<void> {
    const json = JSON.stringify(doc);
    try {
      const handle = await this.#ops.open(this.#tmpFile, 'w', 0o600);
      try {
        await handle.writeFile(json);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#renameWithRetry();
    } catch (err) {
      await this.#ops.unlink(this.#tmpFile).catch(() => {});
      throw new StorageError(err);
    }
    this.#checkSize(Buffer.byteLength(json), false);
  }

  async #renameWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#ops.rename(this.#tmpFile, this.#file);
      } catch (err) {
        if (attempt >= RENAME_ATTEMPTS || !isErrno(err, 'EPERM', 'EBUSY')) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }

  #checkSize(bytes: number, atStartup: boolean): void {
    const over = bytes > this.#warnBytes;
    if (over && (!this.#overSizeThreshold || atStartup)) {
      this.#logger.warn('database file exceeds the design capacity', {
        sizeMb: Math.round((bytes / 1024 / 1024) * 10) / 10,
        thresholdMb: this.#warnBytes / 1024 / 1024,
        see: 'docs/07-persistence.md §7.9 and §7.11',
      });
    }
    this.#overSizeThreshold = over;
  }
}
