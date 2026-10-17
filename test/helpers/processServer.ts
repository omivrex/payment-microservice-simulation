import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

export interface SpawnedServer {
  child: ChildProcess;
  output: () => string;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  exited(): Promise<number | null>;
}

const ROOT = path.resolve(import.meta.dirname, '../..');

// Never leave a server running if a test fails or times out.
const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

/** Starts the real server (src/server.ts) as a child process. */
export function spawnServer(env: Record<string, string | undefined>, cwd = ROOT): SpawnedServer {
  // Resolve tsx from the project, not from the child's working directory.
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'src/server.ts')], {
    cwd,
    env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  child.once('exit', () => live.delete(child));
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exit = once(child, 'exit').then(([code]) => code as number | null);

  return {
    child,
    output: () => out,
    async waitFor(pattern, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = out.match(pattern);
        if (match) return match[0];
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting for ${pattern}. Output:\n${out}`);
    },
    exited: () => exit,
  };
}

export const listeningPort = async (server: SpawnedServer): Promise<number> => {
  const line = await server.waitFor(/"msg":"payment service listening"[^\n]*/);
  return Number(/"port":(\d+)/.exec(line)![1]);
};
