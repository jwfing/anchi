import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeLayout } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import {
  appVersion,
  HOST_SETUP_STEPS,
  IN_GUEST_SETUP_STEPS,
  installKind,
  SetupRunner,
} from '../src/host.ts';
import { launchdPlist, systemdUnit } from '../src/launch.ts';
import { notifyCommand } from '../src/notify.ts';
import { hostReadiness, versionAtLeast } from '../src/setup.ts';

describe('host integration', () => {
  it('compares dotted versions numerically', () => {
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
    };
    const runner = new SetupRunner(steps, undefined, 300);
    const lines: string[] = [];
    await expect(runner.run('vm-start', (l) => lines.push(l))).rejects.toThrow(
      /vm-start failed: .* did not finish within 1 s and was stopped \(last output: working\)/,
    );
    expect(lines[0]).toMatch(/^\$ /);
  });

  it('never starts a machine when the daemon is inside the guest: the server is always up', async () => {
    expect(JSON.stringify([IN_GUEST_SETUP_STEPS, HOST_SETUP_STEPS])).not.toMatch(/limactl|lima/);
    const runner = new SetupRunner(IN_GUEST_SETUP_STEPS);
    await expect(runner.run('vm-start', () => {})).rejects.toThrow(/does not apply to a remote/);
    // A refused step leaves the runner free for the next one.
    expect(runner.running).toBeUndefined();
    // The install runs the guest scripts on the machine itself, as the login user and root.
    expect(IN_GUEST_SETUP_STEPS.install!.map((s) => s.join(' '))).toEqual([
      'bash scripts/up.sh',
      'bash scripts/install-anchi.sh',
      'sudo -n anchi-image build codex base',
    ]);
    // Nothing to install or start as a command on the host placement.
    expect(HOST_SETUP_STEPS.install).toEqual([]);
    expect(HOST_SETUP_STEPS['vm-start']).toEqual([]);
  });

  it('asks a guest-side daemon for Python and sudo, and the host placement for openssl', () => {
    const host = hostReadiness('local');
    expect(host.missing.filter((m) => /lima|qemu|kvm|openssl/i.test(m))).toEqual([]);
    expect(host.installHint).toMatch(/passwordless sudo/);
    expect(hostReadiness().installHint).toMatch(/openssl/);
  });

  it('reads this Anchi version from the release manifest, else the workspace package', () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const dir = mkdtempSync(join(tmpdir(), 'anchi-version-'));
    writeFileSync(join(dir, 'manifest.json'), '{"version":"9.9.9","target":"test"}');
    expect(appVersion(dir)).toBe('9.9.9');
    expect(appVersion(join(dir, 'nothing'))).toBe('unknown');
  });

  it('calls only a bundle with its manifest and updater a release install', () => {
    // This checkout runs from source, so the desktop app never offers to upgrade it.
    expect(installKind()).toBe('source');
    const dir = mkdtempSync(join(tmpdir(), 'anchi-install-'));
    writeFileSync(join(dir, 'manifest.json'), '{"version":"9.9.9","target":"test"}');
    expect(installKind(dir)).toBe('source');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/update.sh'), '');
    expect(installKind(dir)).toBe('release');
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
    const unit = systemdUnit(layout, '/usr/bin:/opt/$x', undefined);
    expect(unit).toContain(
      'Environment="ANCHI_HOME=/home/u/my anchi%%dir" "PATH=/usr/bin:/opt/$x"\n',
    );
    // A daemon on a remote server drives the guest it runs in; the host placement has none.
    expect(systemdUnit(layout, '/usr/bin', 'local')).toContain(
      '"PATH=/usr/bin" "ANCHI_GUEST=local"\n',
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

  it("runs the vault key's process on this Node with core dumps off, without Python", () => {
    for (const steps of [HOST_SETUP_STEPS, IN_GUEST_SETUP_STEPS]) {
      for (const action of ['vault-init', 'vault-unlock'] as const) {
        const [step] = steps[action]!;
        expect(step!.slice(3)).toEqual([process.execPath, 'scripts/vault.mjs', action.slice(6)]);
      }
    }
    expect(JSON.stringify([HOST_SETUP_STEPS, IN_GUEST_SETUP_STEPS])).not.toMatch(
      /python|vault\.py/,
    );
    // The wrapper really turns core dumps off for what it runs.
    const [sh, flag, script] = HOST_SETUP_STEPS['vault-unlock']![0]!;
    const out = spawnSync(sh!, [flag!, script!, '/bin/sh', '-c', 'ulimit -c'], {
      encoding: 'utf8',
    });
    expect(out.stdout.trim()).toBe('0');
  });
});
