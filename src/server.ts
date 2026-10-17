import { existsSync } from 'node:fs';
import { createApp, type AppContext } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { Encryptor } from './crypto/encryption.js';
import { Hasher } from './crypto/hashing.js';
import { JsonDb } from './db/jsonDb.js';
import { StartupError } from './errors.js';
import { installProcessHandlers, type LifecycleState } from './lifecycle.js';
import { createLogger } from './logging/logger.js';
import { createServices } from './services.js';
import { startBackgroundLoops } from './workers/background.js';

/**
 * Entry point: load config, open the database, start HTTP and background loops.
 * Shutdown and fatal errors are handled in lifecycle.ts (docs/08-error-handling.md §8.9).
 */

const state: LifecycleState = { logger: createLogger(), loops: [] };
const shutdown = installProcessHandlers(state);

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  state.logger = createLogger({ level: config.logLevel });

  state.db = await JsonDb.open({ file: config.dbFile, warnSizeMb: config.dbWarnSizeMb, logger: state.logger });

  const ctx: AppContext = {
    config,
    db: state.db,
    logger: state.logger,
    clock: systemClock,
    encryptor: new Encryptor(config.encryptionKeys, config.encryptionActiveKeyId),
    hasher: new Hasher(config.hashingSecret),
  };

  const services = createServices(ctx);
  const server = createApp(ctx, services).listen(config.port);
  state.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  state.logger.info('payment service listening', { port, dbFile: config.dbFile });

  state.loops = startBackgroundLoops(ctx, services);
}

main().catch((err: unknown) => {
  const message =
    err instanceof StartupError
      ? err.message
      : (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? 'Port is already in use'
        : 'Startup failed';
  state.logger.fatal(message, err instanceof StartupError ? {} : { err });
  void shutdown(1);
});
