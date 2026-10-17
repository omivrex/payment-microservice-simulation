import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createApp, type AppContext } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { Encryptor } from './crypto/encryption.js';
import { Hasher } from './crypto/hashing.js';
import { JsonDb } from './db/jsonDb.js';
import { StartupError } from './errors.js';
import { createLogger, type Logger } from './logging/logger.js';
import { startBackgroundLoops, type BackgroundLoop } from './workers/background.js';

/**
 * Entry point: load config, open the database, start HTTP and background loops,
 * and handle shutdown and fatal errors. See docs/08-error-handling.md §8.9.
 */

const SHUTDOWN_TIMEOUT_MS = 10_000;

let logger: Logger = createLogger();
let server: Server | undefined;
let db: JsonDb | undefined;
let loops: BackgroundLoop[] = [];
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    logger.fatal('shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
    server.closeIdleConnections();
    await closed;
  }
  await Promise.allSettled(loops.map((loop) => loop.stop()));
  await db?.close();
  logger.info('shutdown complete', { exitCode });
  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  void shutdown(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  void shutdown(0);
});
process.on('uncaughtException', (err) => {
  logger.fatal('uncaught exception', { err });
  void shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal('unhandled promise rejection', { err: reason });
  void shutdown(1);
});

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  logger = createLogger({ level: config.logLevel });

  db = await JsonDb.open({ file: config.dbFile, warnSizeMb: config.dbWarnSizeMb, logger });

  const ctx: AppContext = {
    config,
    db,
    logger,
    clock: systemClock,
    encryptor: new Encryptor(config.encryptionKeys, config.encryptionActiveKeyId),
    hasher: new Hasher(config.hashingSecret),
  };

  const app = createApp(ctx);
  server = app.listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  logger.info('payment service listening', { port, dbFile: config.dbFile });

  loops = startBackgroundLoops(ctx);
}

main().catch((err: unknown) => {
  const message =
    err instanceof StartupError
      ? err.message
      : (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? 'Port is already in use'
        : 'Startup failed';
  logger.fatal(message, err instanceof StartupError ? {} : { err });
  void shutdown(1);
});
