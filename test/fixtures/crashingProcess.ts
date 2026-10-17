/**
 * Process-test fixture: uses the real lifecycle handlers and a real JsonDb lock,
 * then misbehaves on purpose. Mode comes from argv[2]:
 *   rejection  → an unhandled promise rejection whose message contains a card number
 *   exception  → an uncaught exception
 *   hang       → SIGTERM with a background loop whose stop() never resolves
 */
import { JsonDb } from '../../src/db/jsonDb.ts';
import { installProcessHandlers, type LifecycleState } from '../../src/lifecycle.ts';
import { createLogger } from '../../src/logging/logger.ts';

const [mode, dbFile] = process.argv.slice(2) as [string, string];
const logger = createLogger();
const state: LifecycleState = { logger, loops: [] };
installProcessHandlers(state, { shutdownTimeoutMs: 1000 });

state.db = await JsonDb.open({ file: dbFile, warnSizeMb: 20, logger });
logger.info('fixture ready', { mode });

if (mode === 'rejection') {
  void Promise.reject(new Error('charge failed for card 4242424242424242'));
} else if (mode === 'exception') {
  setTimeout(() => {
    throw new TypeError('boom in a timer');
  }, 10);
} else if (mode === 'hang') {
  state.loops.push({
    name: 'stuck',
    tickOnce: async () => {},
    whenIdle: async () => {},
    start: () => {},
    stop: () => new Promise<void>(() => {}),
  });
  setInterval(() => {}, 1000); // keep alive until signalled
}
