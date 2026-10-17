import type { AppContext } from '../app.js';

/** A background loop (payment worker, webhook dispatcher, housekeeping). */
export interface BackgroundLoop {
  readonly name: string;
  /** Runs one pass. Exposed so tests can drive loops deterministically (docs/09-testing.md §9.3). */
  tickOnce(): Promise<void>;
  start(): void;
  /** Stops scheduling ticks and waits for the current one (and its in-flight work) to finish. */
  stop(): Promise<void>;
}

/**
 * Generic polling loop: setTimeout chaining (never overlapping ticks), per-tick
 * error isolation so one failure can't stop the loop (docs/08-error-handling.md §8.8).
 */
export function createPollingLoop(options: {
  name: string;
  intervalMs: number;
  logger: AppContext['logger'];
  tick: () => Promise<void>;
  /** Resolves when work started by ticks (e.g. in-flight jobs) has finished. */
  drain?: () => Promise<void>;
}): BackgroundLoop {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let current: Promise<void> | null = null;

  const runTick = async (): Promise<void> => {
    if (current) return current; // never two ticks at once
    current = (async () => {
      try {
        await options.tick();
      } catch (err) {
        options.logger.error('background tick failed', { loop: options.name, err });
      } finally {
        current = null;
      }
    })();
    return current;
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(() => {
      void runTick().finally(schedule);
    }, options.intervalMs);
  };

  return {
    name: options.name,
    tickOnce: runTick,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await current;
      await options.drain?.();
    },
  };
}

/** Starts every background loop. Modules add their loops here as they are implemented. */
export function startBackgroundLoops(_ctx: AppContext): BackgroundLoop[] {
  const loops: BackgroundLoop[] = [];
  for (const loop of loops) loop.start();
  return loops;
}
