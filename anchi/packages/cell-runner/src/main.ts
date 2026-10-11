import { execFileSync } from 'node:child_process';
import type { RuntimeId } from '@anchi/protocol';
import { CLAUDE_PATH, runClaude } from './claude.ts';
import { CODEX_PATH, runCodex } from './codex.ts';
import { HERMES_PATH, runHermes } from './hermes.ts';
import { startForwarder } from './forward.ts';
import { startRunner } from './runner.ts';

const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
// The cell manager names the agent's runtime; Codex unless told otherwise.
const runtime: RuntimeId =
  env.ANCHI_RUNTIME === 'claude-code' || env.ANCHI_RUNTIME === 'hermes'
    ? env.ANCHI_RUNTIME
    : 'codex';
const BINARIES: Record<RuntimeId, string> = {
  codex: CODEX_PATH,
  'claude-code': CLAUDE_PATH,
  hermes: HERMES_PATH,
};

await startForwarder();
let version = 'unknown';
try {
  const bin = BINARIES[runtime];
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
  (turn) =>
    runtime === 'claude-code'
      ? runClaude({ ...turn, env })
      : runtime === 'hermes'
        ? runHermes({ ...turn, env })
        : runCodex({ ...turn, env }),
  version,
  runtime,
);
