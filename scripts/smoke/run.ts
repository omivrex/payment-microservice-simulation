import { foundation } from './foundation.ts';
import { startSmokeServer, type SmokeContext } from './harness.ts';

/**
 * Smoke tests against the real running server.
 *   yarn smoke                 # every scenario
 *   yarn smoke foundation      # one or more named scenarios
 */

const SCENARIOS: Record<string, (s: SmokeContext) => Promise<void>> = {
  foundation,
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(SCENARIOS);
const unknown = names.filter((n) => !SCENARIOS[n]);
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const server = await startSmokeServer();
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
