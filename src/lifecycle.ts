import type { Server } from 'node:http';
import type { JsonDb } from './db/jsonDb.js';
import type { Logger } from './logging/logger.js';
import type { BackgroundLoop } from './workers/background.js';

/**
 * Process lifecycle: signal handling, fatal-error handling and graceful shutdown.
 * See docs/08-error-handling.md §8.9.
 */

export interface LifecycleState {
  logger: Logger;
  server?: Server | undefined;
  db?: JsonDb | undefined;
  loops: BackgroundLoop[];
}

export function installProcessHandlers(state: LifecycleState, options: { shutdownTimeoutMs?: number } = {}): (exitCode: number) => Promise<void> {
  const timeoutMs = options.shutdownTimeoutMs ?? 10_000;
  let shuttingDown = false;

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      state.logger.fatal('shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs).unref();

    if (state.server?.listening) {
      const closed = new Promise<void>((resolve) => state.server!.close(() => resolve()));
      state.server.closeIdleConnections();
      await closed;
    }
    await Promise.allSettled(state.loops.map((loop) => loop.stop()));
    await state.db?.close();
    state.logger.info('shutdown complete', { exitCode });
    process.exit(exitCode);
  }

  process.on('SIGTERM', () => {
    state.logger.info('SIGTERM received, shutting down');
    void shutdown(0);
  });
  process.on('SIGINT', () => {
    state.logger.info('SIGINT received, shutting down');
    void shutdown(0);
  });
  process.on('uncaughtException', (err) => {
    state.logger.fatal('uncaught exception', { err });
    void shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    state.logger.fatal('unhandled promise rejection', { err: reason });
    void shutdown(1);
  });

  return shutdown;
}
