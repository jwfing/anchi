import { execFileSync } from 'node:child_process';
import type { RuntimeId } from '@anchi/protocol';
import { CLAUDE_PATH, runClaude } from './claude.ts';
import { CODEX_PATH, runCodex } from './codex.ts';
import { startForwarder } from './forward.ts';
import { startRunner } from './runner.ts';

const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
// The cell manager names the agent's runtime; Codex unless told otherwise.
const runtime: RuntimeId = env.ANCHI_RUNTIME === 'claude-code' ? 'claude-code' : 'codex';

await startForwarder();
let version = 'unknown';
try {
  const bin = runtime === 'claude-code' ? CLAUDE_PATH : CODEX_PATH;
  version = execFileSync(bin, ['--version'], { encoding: 'utf8', env }).trim().slice(0, 100);
} catch {
  // Reported as unknown; the first turn will surface the real error.
}
startRunner(
  {
    write: (frame) => process.stdout.write(frame),
    onData: (cb) => process.stdin.on('data', cb),
    onEnd: (cb) => process.stdin.on('end', cb),
    exit: (code) => {
      // Let pending frames flush before exiting.
      process.stdout.write('', () => process.exit(code));
    },
    log: (message) => process.stderr.write(`anchi-runner: ${message}\n`),
  },
  (turn) => (runtime === 'claude-code' ? runClaude({ ...turn, env }) : runCodex({ ...turn, env })),
  version,
  runtime,
);
