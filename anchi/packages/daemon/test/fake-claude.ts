import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TOKEN = `sk-ant-oat01-${'A'.repeat(60)}-${'b'.repeat(35)}`;
export const LOCAL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=s';
export const PASTE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s';

/**
 * A stand-in for `claude setup-token`, run in the real pseudo-terminal: it opens the localhost
 * page with $BROWSER, prints the paste page inside an OSC 8 link as Claude Code does, and then
 * behaves as $CLAUDE_CONFIG_DIR/../mode says: auto (prints the token, wrapped at 80 columns),
 * code (waits for GOOD#CODE-123 on stdin), fail (exits), bad (prints a malformed token),
 * nopage (prints nothing).
 */
const FAKE = `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = readFileSync(process.env.ANCHI_FAKE_MODE, 'utf8').trim();
const token = ${JSON.stringify(TOKEN)};
const success = (t) => {
  process.stdout.write('\\x1b[32m✓ Long-lived authentication token created successfully!\\x1b[0m\\r\\n\\r\\n');
  process.stdout.write('Your OAuth token (valid for 1 year):\\r\\n\\r\\n');
  process.stdout.write(t.slice(0, 80) + '\\r\\n' + t.slice(80) + '\\r\\n\\r\\n');
  process.stdout.write('Store this token securely. You won\\'t be able to see it again.\\r\\n');
};
if (mode === 'nopage') setTimeout(() => {}, 60000);
else {
  execFileSync(process.env.BROWSER, [${JSON.stringify(LOCAL)}]);
  process.stdout.write('Browser didn\\'t open? Use the url below to sign in (c to copy)\\r\\n');
  process.stdout.write('\\x1b]8;id=1;' + ${JSON.stringify(PASTE)} + '\\x07' + ${JSON.stringify(PASTE)} + '\\x1b]8;;\\x07\\r\\n');
  process.stdout.write('Paste code here if prompted > ');
  if (mode === 'auto') setTimeout(() => success(token), 300);
  if (mode === 'bad') setTimeout(() => success('sk-ant-oat01-short'), 300);
  if (mode === 'fail') setTimeout(() => process.exit(1), 300);
  if (mode === 'code') {
    createInterface({ input: process.stdin }).on('line', (line) => {
      if (line.trim() === 'GOOD#CODE-123') success(token);
      else { process.stdout.write('Invalid code\\r\\n'); process.exit(1); }
    });
  }
}
`;

/**
 * The fake Claude Code in a new directory, set to `mode` for whatever runs it next (the mode is
 * read from the file ANCHI_FAKE_MODE names, which this sets).
 */
export function fakeClaude(mode: string): { home: string; binary: string } {
  const home = mkdtempSync(join(tmpdir(), 'anchi-claude-sign-in-'));
  const script = join(home, 'fake-claude.mjs');
  writeFileSync(script, FAKE);
  const binary = join(home, 'fake-claude');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
  writeFileSync(join(home, 'mode'), mode);
  process.env.ANCHI_FAKE_MODE = join(home, 'mode');
  return { home, binary };
}
