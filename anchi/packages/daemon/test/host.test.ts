import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeLayout } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import { appVersion, SetupRunner, workspaceSteps } from '../src/host.ts';
import { launchdPlist, systemdUnit } from '../src/launch.ts';
import { notifyCommand } from '../src/notify.ts';
import { limaMinimum, parseLimaVersion, versionAtLeast } from '../src/setup.ts';

describe('host integration', () => {
  it('compares the installed Lima with the version the VM template needs', () => {
    expect(limaMinimum()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(limaMinimum(join(tmpdir(), 'no-such-checkout'))).toBe('0.0.0');
    expect(parseLimaVersion('limactl version 2.2.0')).toBe('2.2.0');
    expect(parseLimaVersion('limactl version 2.10.1-1-gabcdef')).toBe('2.10.1');
    expect(parseLimaVersion('')).toBeNull();
    expect(versionAtLeast('2.2.0', '2.2.0')).toBe(true);
    // Numeric, not textual: 2.10 is newer than 2.2.
    expect(versionAtLeast('2.10.0', '2.2.0')).toBe(true);
    expect(versionAtLeast('1.0.9', '2.2.0')).toBe(false);
    expect(versionAtLeast('2.1.9', '2.2.0')).toBe(false);
  });

  it('names the step and the limit when a setup command runs too long', async () => {
    const steps = {
      'vm-start': [[process.execPath, '-e', 'console.log("working"); setTimeout(() => {}, 10000)']],
      install: [],
      'vault-init': [],
      'vault-unlock': [],
      workspaces: [],
    };
    const runner = new SetupRunner(steps, undefined, [], 300);
    const lines: string[] = [];
    await expect(runner.run('vm-start', (l) => lines.push(l))).rejects.toThrow(
      /vm-start failed: .* did not finish within 1 s and was stopped \(last output: working\)/,
    );
    expect(lines[0]).toMatch(/^\$ /);
  });

  it('reads this Anchi version from the release manifest, else the workspace package', () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const dir = mkdtempSync(join(tmpdir(), 'anchi-version-'));
    writeFileSync(join(dir, 'manifest.json'), '{"version":"9.9.9","target":"test"}');
    expect(appVersion(dir)).toBe('9.9.9');
    expect(appVersion(join(dir, 'nothing'))).toBe('unknown');
  });

  it('passes agent text to notifiers as flattened arguments', () => {
    const text = 'line1\nline2 "quoted" $(rm -rf ~) \u0007';
    const [cmd, args] = notifyCommand('linux', 'title', text)!;
    expect(cmd).toBe('notify-send');
    expect(args).toEqual(['--app-name=Anchi', '--', 'title', 'line1 line2 "quoted" $(rm -rf ~) ']);
    const [mac, script] = notifyCommand('darwin', 'a"b', text)!;
    expect(mac).toBe('osascript');
    expect(script[1]).toContain('with title "a\\"b"');
    expect(script[1]).toContain('\\"quoted\\"');
    expect(notifyCommand('win32', 't', 'm')).toBeUndefined();
    expect(notifyCommand('linux', 't', 'x'.repeat(1000))![1][3]).toHaveLength(240);
  });

  it('writes a systemd user unit equivalent to the launchd agent', () => {
    const layout = homeLayout('/home/u/my anchi%dir');
    const unit = systemdUnit(layout, '/usr/bin:/opt/$x');
    expect(unit).toContain(
      'Environment="ANCHI_HOME=/home/u/my anchi%%dir" "PATH=/usr/bin:/opt/$x"',
    );
    expect(unit).toMatch(
      /^ExecStart="[^"]*node[^"]*" "--import" "[^"]*tsx[^"]*" "[^"]*main\.ts"$/m,
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StandardOutput=append:/home/u/my anchi%%dir/');
    expect(unit).toContain('WantedBy=default.target');
    expect(() => systemdUnit(homeLayout('/home/u/a\nb'))).toThrow(/line breaks/);
    expect(launchdPlist(layout)).toContain('<string>/home/u/my anchi%dir</string>');
  });

  it('shares workspaces over virtiofs on macOS, and over 9p mapped by the guest on Linux', () => {
    const mac = workspaceSteps('darwin').map((s) => s.join(' '));
    expect(mac.find((s) => s.startsWith('limactl edit'))).toContain(
      '"mountPoint":"/mnt/anchi-host","writable":true}] --set .mountType="virtiofs"',
    );
    expect(mac.some((s) => s.includes('install-anchi'))).toBe(false);
    const linux = workspaceSteps('linux').map((s) => s.join(' '));
    expect(linux.find((s) => s.startsWith('limactl edit'))).toContain(
      '"mountPoint":"/mnt/anchi-host-raw/share","writable":true}] --set .mountType="9p"',
    );
    // The guest pieces bring the bindfs mapping; then the vault, locked by the restart.
    expect(linux.slice(-3)).toEqual([
      'limactl start --tty=false anchi-vm',
      'bash scripts/install-anchi.sh',
      'python3 scripts/vault.py unlock',
    ]);
  });
});
