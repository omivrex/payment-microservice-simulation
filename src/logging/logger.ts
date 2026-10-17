import { redact } from './redact.js';

/**
 * The only code that writes to the console. One JSON line per entry, redacted.
 * See docs/08-error-handling.md §8.6.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

// Resolved at call time (not captured at creation) so tests can intercept console output.
const write = (level: LogLevel, line: string): void => {
  if (level === 'warn') console.warn(line);
  else if (level === 'error' || level === 'fatal') console.error(line);
  else console.log(line);
};

export function createLogger(options: { level?: LogLevel; base?: LogContext } = {}): Logger {
  const minRank = RANK[options.level ?? 'info'];
  const base = options.base ?? {};

  const log = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    if (RANK[level] < minRank) return;
    const entry = redact({ time: new Date().toISOString(), level, msg, ...base, ...ctx });
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level, msg: '[unserializable log entry]' });
    }
    write(level, line);
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
    fatal: (msg, ctx) => log('fatal', msg, ctx),
    child: (ctx) => createLogger({ level: options.level ?? 'info', base: { ...base, ...ctx } }),
  };
}
