import { cards } from './cards.ts';
import { foundation } from './foundation.ts';
import { startSmokeServer, type SmokeContext } from './harness.ts';
import { merchants } from './merchants.ts';
import { payments } from './payments.ts';
import { ratelimits } from './ratelimits.ts';
import { webhooks } from './webhooks.ts';

/**
 * Smoke tests against the real running server.
 *   yarn smoke                 # every scenario
 *   yarn smoke foundation      # one or more named scenarios
 */

// Order matters: later scenarios reuse merchants created earlier; ratelimits runs last.
const SCENARIOS: Record<string, (s: SmokeContext) => Promise<void>> = {
  foundation,
  merchants,
  cards,
  payments,
  webhooks,
  ratelimits,
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(SCENARIOS);
if (requested.length && !requested.includes('merchants') && requested.some((n) => n !== 'foundation')) names.unshift('merchants');
if (requested.includes('payments') && !names.includes('cards')) names.splice(names.indexOf('merchants') + 1, 0, 'cards');
const unknown = names.filter((n) => !SCENARIOS[n]);
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

// Limits raised from the defaults so scenarios have room to work; ratelimits.ts exhausts them on purpose.
const server = await startSmokeServer({
  RATE_LIMIT_SIGNUP_PER_HOUR: '40',
  RATE_LIMIT_TOKENS_PER_MINUTE: '120',
  RATE_LIMIT_GENERAL_PER_MINUTE: '600',
  // Chaos mode: PROCESSOR_FAILURE_RATE=0.3 yarn smoke  (random transient processor failures; some
  // final-state checks may then legitimately fail, but the server must never crash or leak).
  ...(process.env.PROCESSOR_FAILURE_RATE ? { PROCESSOR_FAILURE_RATE: process.env.PROCESSOR_FAILURE_RATE } : {}),
});
console.log(`Smoke testing the real server at ${server.ctx.baseUrl}`);
try {
  for (const name of names) await SCENARIOS[name]!(server.ctx);
} catch (err) {
  server.ctx.check(`scenario crashed: ${(err as Error).message}`, false, (err as Error).stack);
} finally {
  server.ctx.section('Shutdown and leak scan');
  const code = await server.stop();
  server.ctx.check('server exits cleanly on SIGTERM (code 0)', code === 0, code);
}

const { passed, failed } = server.results;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
