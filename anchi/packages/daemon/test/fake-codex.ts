import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for `codex app-server`: it logs every request to $CODEX_HOME/calls and behaves as
 * $CODEX_HOME/mode says (ok, bad-url, bad-code, fail, silent). On a finished login it copies
 * $CODEX_HOME/../auth.json to $CODEX_HOME/auth.json, as Codex writes its login there.
 */
const FAKE = `
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const home = process.env.CODEX_HOME;
const mode = existsSync(home + '/../mode') ? readFileSync(home + '/../mode', 'utf8').trim() : 'ok';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(home + '/calls', JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'account/read') send({ id: m.id, result: { account: null } });
  if (m.method === 'account/login/cancel') send({ id: m.id, result: { status: 'canceled' } });
  if (m.method !== 'account/login/start') return;
  const url = mode === 'bad-url' ? 'https://evil.example/codex/device' : 'https://auth.openai.com/codex/device';
  const code = mode === 'bad-code' ? 'abc def' : 'ABCD-EFGHI';
  send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: url, userCode: code } });
  if (mode === 'silent') return;
  setTimeout(() => {
    if (mode === 'ok') copyFileSync(home + '/../auth.json', home + '/auth.json');
    send({ method: 'account/login/completed', params: mode === 'ok'
      ? { loginId: 'login-1', success: true, error: null }
      : { loginId: 'login-1', success: false, error: 'denied in the browser' } });
  }, 30);
});
`;

/**
 * A directory with the fake Codex (`binary`), its behavior (`mode`) and the login it writes
 * (`auth`, as a JSON string). The sign-in's CODEX_HOME is `<home>/codex`.
 */
export function fakeCodex(mode = 'ok', auth = '{"tokens":{}}'): { home: string; binary: string } {
  const home = mkdtempSync(join(tmpdir(), 'anchi-codex-sign-in-'));
  const script = join(home, 'fake-codex.mjs');
  writeFileSync(script, FAKE);
  const binary = join(home, 'fake-codex');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
  writeFileSync(join(home, 'mode'), mode);
  writeFileSync(join(home, 'auth.json'), auth);
  return { home, binary };
}
