import { homeLayout } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import { launchdPlist, systemdUnit } from '../src/launch.ts';
import { notifyCommand } from '../src/notify.ts';

describe('host integration', () => {
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
});
