/**
 * Preloaded into every test process (--import ./test/setup.ts).
 * Captures console output for the log-leak check and keeps test output quiet
 * (set TEST_LOGS=1 to see logs).
 */
import { after } from 'node:test';
import { captured, findLeaks } from './helpers/leakGuard.ts';

const show = process.env.TEST_LOGS === '1';
for (const method of ['log', 'warn', 'error'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
    if (show) original(...args);
  };
}

after(() => {
  const leaks = findLeaks(captured.join('\n'));
  if (leaks.length > 0) {
    throw new Error(`Secret leak in console output: ${[...new Set(leaks)].join(', ')}`);
  }
});
