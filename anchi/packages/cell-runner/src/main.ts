import { execFileSync } from 'node:child_process';
import { CODEX_PATH, runCodex } from './codex.ts';
import { startForwarder } from './forward.ts';
import { startRunner } from './runner.ts';

const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

await startForwarder();
let version = 'unknown';
try {
  version = execFileSync(CODEX_PATH, ['--version'], { encoding: 'utf8', env }).trim().slice(0, 100);
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
  (turn) => runCodex({ ...turn, env }),
  version,
);
