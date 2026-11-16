import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeLayout } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import {
  claudeSettingsRestored,
  claudeSettingsText,
  codexConfigRestored,
  codexConfigText,
  denyReadPaths,
  disableHost,
  enableHost,
  HOST_PORT_DEFAULT,
  hostPaths,
  hostRoute,
  hostSpec,
  hostStatus,
  HostTransport,
  readProfile,
  shimEnvironment,
  shimText,
} from '../src/host-placement.ts';
import { launchdPlist, systemdUnit } from '../src/launch.ts';
import { hostReadiness } from '../src/setup.ts';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'anchi-host-'));
  const layout = homeLayout(join(root, '.anchi'));
  const paths = hostPaths(layout);
  const files = {
    claudeSettings: join(root, '.claude/settings.json'),
    codexConfig: join(root, '.codex/config.toml'),
  };
  return { root, layout, paths, files };
}

const spec = {
  port: 18180,
  caBundle: '/h/.anchi/host/ca-bundle.pem',
  caCert: '/h/.anchi/host/state/mitm/mitmproxy-ca-cert.pem',
  denyRead: ['/h/.anchi/host', '/h/.ssh'],
};

describe('host placement: guest commands on the host', () => {
  it('routes anchi-cell and the admin scripts to the host Python, and answers the rest', () => {
    const { paths } = home();
    const route = (args: string[]) => hostRoute(args, paths, '/repo/services');
    expect(route(['anchi-cell', 'approvals', 'watch'])).toEqual({
      argv: [paths.python, '/repo/services/host_control.py', 'approvals', 'watch'],
    });
    expect(route(['/usr/bin/python3', '/opt/secure-vm/services/vault_admin.py', 'status'])).toEqual(
      { argv: [paths.python, '/repo/services/vault_admin.py', 'status'] },
    );
    expect(
      route(['/usr/bin/python3', '/opt/secure-vm/services/admin.py', 'import-token', 'github']),
    ).toEqual({ argv: [paths.python, '/repo/services/admin.py', 'import-token', 'github'] });
    // The runtimes stay the user's own logins: never configured in the vault on the host.
    for (const script of ['codex_admin.py', 'claude_admin.py', 'hermes_admin.py']) {
      const r = route(['/usr/bin/python3', `/opt/secure-vm/services/${script}`, 'status']);
      expect('answer' in r && JSON.parse(r.answer.stdout).configured).toBe(false);
      const refused = route([
        '/usr/bin/python3',
        `/opt/secure-vm/services/${script}`,
        'import-token',
      ]);
      expect('answer' in refused && refused.answer.code).toBe(1);
    }
    // Nothing else runs: no policy administration, no cell manager, no unknown script.
    for (const args of [
      ['/usr/bin/python3', '/opt/secure-vm/services/policy_admin.py', 'show', 'x'],
      ['/usr/bin/python3', '/opt/secure-vm/services/../../etc/passwd', 'status'],
      ['limactl', 'shell'],
      ['anchi-image', 'remove', 'x'],
    ]) {
      const r = route(args);
      expect('answer' in r && r.answer).toEqual({
        code: 1,
        stdout: '{"error":"HOST_PLACEMENT"}',
        stderr: '',
      });
    }
    // Not installed: no services, no images; installed: everything present, nothing to build.
    expect(route(['test', '-f', '/opt/secure-vm/services/vault_admin.py'])).toEqual({
      answer: { code: 1, stdout: '', stderr: '' },
    });
    mkdirSync(join(paths.venv, 'bin'), { recursive: true });
    writeFileSync(paths.python, '');
    expect(route(['test', '-f', '/opt/secure-vm/services/vault_admin.py'])).toEqual({
      answer: { code: 0, stdout: '', stderr: '' },
    });
    const image = route(['anchi-image', 'status', 'codex', 'base']);
    expect('answer' in image && JSON.parse(image.answer.stdout)).toEqual({ present: true });
    expect(route(['mountpoint', '-q', '/mnt/anchi-host'])).toEqual({
      answer: { code: 1, stdout: '', stderr: '' },
    });
  });

  it('is a transport that reports installed once the venv has Python and mitmdump', async () => {
    const { paths } = home();
    const transport = new HostTransport(paths, '/repo/services');
    expect(transport.placement).toBe('host');
    expect(await transport.vmStatus()).toBe('missing');
    // A canned answer comes back through exec and spawn alike.
    expect(await transport.exec(['mountpoint', '-q', '/x'])).toEqual({
      code: 1,
      stdout: '',
      stderr: '',
    });
    const child = transport.spawn(['anchi-image', 'status', 'codex', 'base']);
    const out: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect([code, Buffer.concat(out).toString()]).toEqual([0, '{"present":false}']);
    mkdirSync(join(paths.venv, 'bin'), { recursive: true });
    writeFileSync(paths.python, '');
    writeFileSync(paths.mitmdump, '');
    expect(await transport.vmStatus()).toBe('running');
    expect((await transport.vmSize()).cpus).toBeGreaterThan(0);
  });

  it('asks a host-placement daemon for Python 3.11+, not Lima', () => {
    const host = hostReadiness('host');
    expect(host.missing.filter((m) => /lima|qemu|kvm/i.test(m))).toEqual([]);
    expect(host.installHint).toMatch(/Python 3\.11/);
  });

  it('keeps the placement in the login-time daemon definitions', () => {
    const layout = homeLayout('/home/u/.anchi');
    expect(launchdPlist(layout, '/usr/bin', 'host')).toContain(
      '<key>ANCHI_GUEST</key>\n    <string>host</string>',
    );
    expect(launchdPlist(layout, '/usr/bin', undefined)).not.toContain('ANCHI_GUEST');
    expect(systemdUnit(layout, '/usr/bin', 'host')).toContain('"ANCHI_GUEST=host"');
    expect(systemdUnit(layout, '/usr/bin', 'lima')).not.toContain('ANCHI_GUEST');
  });
});

describe("host placement: the runtimes' settings", () => {
  it("merges Anchi's sandbox and trust keys into Claude Code's settings and undoes them", () => {
    const before = JSON.stringify({
      model: 'opus',
      env: { EDITOR: 'vim', SSL_CERT_FILE: '/mine.pem' },
    });
    const { text, managed, excludedCommands } = claudeSettingsText(before, spec);
    const value = JSON.parse(text);
    expect(value.model).toBe('opus');
    expect(value.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { httpProxyPort: 18180 },
      filesystem: { denyRead: spec.denyRead },
    });
    expect(value.env).toMatchObject({
      EDITOR: 'vim',
      SSL_CERT_FILE: spec.caBundle,
      NODE_EXTRA_CA_CERTS: spec.caCert,
      GIT_SSL_CAINFO: spec.caBundle,
    });
    expect(excludedCommands).toEqual([]);
    // What was there before is remembered, so disabling puts it back and nothing else.
    expect(managed.previousEnv.SSL_CERT_FILE).toBe('/mine.pem');
    expect(managed.previousEnv.CURL_CA_BUNDLE).toBeUndefined();
    expect(JSON.parse(claudeSettingsRestored(text, managed))).toEqual({
      model: 'opus',
      env: { EDITOR: 'vim', SSL_CERT_FILE: '/mine.pem' },
    });
    // An empty or missing file is fine; a file that is not JSON is not.
    expect(JSON.parse(claudeSettingsText(undefined, spec).text).sandbox.enabled).toBe(true);
    expect(() => claudeSettingsText('{not json', spec)).toThrow(/CLAUDE_SETTINGS_UNREADABLE/);
    expect(() => claudeSettingsText('[1]', spec)).toThrow(/CLAUDE_SETTINGS_UNREADABLE/);
  });

  it('refuses a sandbox block Anchi did not write, and rewrites one it did', () => {
    const theirs = JSON.stringify({ sandbox: { enabled: true, excludedCommands: ['gh *'] } });
    expect(() => claudeSettingsText(theirs, spec)).toThrow(/CLAUDE_SETTINGS_HAS_SANDBOX/);
    const first = claudeSettingsText('{}', spec);
    const again = claudeSettingsText(first.text, { ...spec, port: 19000 }, first.managed);
    expect(JSON.parse(again.text).sandbox.network.httpProxyPort).toBe(19000);
    expect(again.managed).toEqual(first.managed);
    // Commands the user excluded run outside the sandbox: reported, never silently kept.
    const excluded = claudeSettingsText(
      JSON.stringify({ sandbox: { excludedCommands: ['gh *', 7] } }),
      spec,
      first.managed,
    );
    expect(excluded.excludedCommands).toEqual(['gh *']);
    expect(JSON.parse(excluded.text).sandbox.excludedCommands).toBeUndefined();
  });

  it("adds a marked block and the profile selection to Codex's config and strips them again", () => {
    const before = '# mine\nmodel = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n';
    const text = codexConfigText(before, spec);
    expect(text.startsWith('default_permissions = "anchi" # anchi host placement\n# mine\n')).toBe(
      true,
    );
    expect(text).toContain(
      '[permissions.anchi.filesystem]\n"/h/.anchi/host" = "deny"\n"/h/.ssh" = "deny"',
    );
    expect(text).toContain('[permissions.anchi.network]\nenabled = true\nenable_socks5 = false');
    expect(text).toContain('[features.network_proxy]\nenabled = true');
    expect(text.indexOf('[mcp_servers.x]')).toBeLessThan(
      text.indexOf('# >>> anchi host placement >>>'),
    );
    // Enabling again replaces the block instead of stacking a second one.
    const again = codexConfigText(text, { ...spec, denyRead: ['/other'] });
    expect(again.split('anchi host placement >>>').length).toBe(2);
    expect(again).toContain('"/other" = "deny"');
    expect(again).not.toContain('/h/.ssh');
    expect(codexConfigRestored(again)).toBe(before);
    expect(codexConfigRestored(codexConfigText(undefined, spec))).toBe('');
    // A path with a quote or a backslash stays one TOML string.
    expect(codexConfigText('', { ...spec, denyRead: ['/a"b\\c'] })).toContain(
      '"/a\\"b\\\\c" = "deny"',
    );
  });

  it('refuses a Codex config that already selects a profile or runs its own network proxy', () => {
    for (const [text, why] of [
      ['default_permissions = "mine"\n', /default_permissions is already set/],
      ['[permissions.anchi]\nextends = ":workspace"\n', /permissions\.anchi profile exists/],
      ['[permissions.anchi.network]\nenabled = true\n', /permissions\.anchi profile exists/],
      ['[features]\nnetwork_proxy = true\n', /network_proxy is already configured/],
    ] as const) {
      expect(() => codexConfigText(text, spec)).toThrow(why);
    }
  });

  it('gives the shim the proxy, the trust bundle and placeholders, never a credential', () => {
    const env = shimEnvironment(spec, ['github', 'aws', 'linear', 'discord']);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:18180');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.GH_TOKEN).toBe('anchi-placeholder-github');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAANCHIPLACEHOLDER');
    expect(env.LINEAR_API_KEY).toBe('lin_api_anchiplaceholder0000');
    expect(env.DISCORD_BOT_TOKEN).toMatch(/^MTAwMDAwMDAwMDAwMDAwMDAw\.AAAAAA\.anchiplaceholder0+$/);
    expect(env.FIGMA_ACCESS_TOKEN).toBeUndefined();
    const text = shimText('claude', { ...env, ODD: `it's "quoted"` });
    expect(text.startsWith('#!/bin/bash\n')).toBe(true);
    expect(text).toContain(`export ODD='it'\\''s "quoted"'`);
    expect(text).toContain('[[ -x $dir/claude ]]');
    expect(text.trimEnd().endsWith('exec "$real" "$@"')).toBe(true);
    expect(() => shimText('../x', env)).toThrow(/BAD_SHIM_NAME/);
  });

  it('enables and disables on disk, refusing before the first write and restoring exactly', () => {
    const { root, paths, files } = home();
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(files.codexConfig, 'model = "o3"\n');
    // No proxy CA yet: nothing is written, not even the manifest.
    expect(() => enableHost(paths, files, ['github'], undefined, root)).toThrow(/HOST_NOT_RUNNING/);
    expect(existsSync(paths.manifest)).toBe(false);
    mkdirSync(join(paths.state, 'mitm'), { recursive: true });
    writeFileSync(paths.caCert, 'CA');
    writeFileSync(paths.caBundle, 'ROOTS\nCA');
    // Claude's file is refused for its own sandbox block: Codex's file and the shims stay untouched.
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(files.claudeSettings, '{"sandbox": {"enabled": false}}');
    expect(() => enableHost(paths, files, ['github'], undefined, root)).toThrow(/HAS_SANDBOX/);
    expect(readFileSync(files.codexConfig, 'utf8')).toBe('model = "o3"\n');
    expect(existsSync(join(paths.bin, 'claude'))).toBe(false);
    writeFileSync(files.claudeSettings, '{"model": "opus"}');
    const { excludedCommands } = enableHost(paths, files, ['github'], undefined, root);
    expect(excludedCommands).toEqual([]);
    const claude = JSON.parse(readFileSync(files.claudeSettings, 'utf8'));
    expect(claude.sandbox.network.httpProxyPort).toBe(HOST_PORT_DEFAULT);
    expect(claude.sandbox.filesystem.denyRead).toEqual(denyReadPaths(paths, root));
    expect(claude.env.SSL_CERT_FILE).toBe(paths.caBundle);
    expect(readFileSync(files.codexConfig, 'utf8')).toMatch(/^default_permissions = "anchi"/);
    for (const name of ['claude', 'codex']) {
      const shim = join(paths.bin, name);
      expect(statSync(shim).mode & 0o777).toBe(0o700);
      expect(readFileSync(shim, 'utf8')).toContain("export GH_TOKEN='anchi-placeholder-github'");
    }
    const status = hostStatus(paths, files, ['github'], true, `${paths.bin}:/usr/bin`);
    expect(status).toMatchObject({
      placement: 'host',
      enabled: true,
      running: true,
      installed: false,
      shimOnPath: true,
      claude: { file: files.claudeSettings, managed: true, excludedCommands: [] },
      codex: { file: files.codexConfig, managed: true },
      connectors: ['github'],
    });
    expect(hostStatus(paths, files, [], false, '/usr/bin').shimOnPath).toBe(false);
    expect(disableHost(paths)).toBe(true);
    expect(JSON.parse(readFileSync(files.claudeSettings, 'utf8'))).toEqual({ model: 'opus' });
    expect(readFileSync(files.codexConfig, 'utf8')).toBe('model = "o3"\n');
    expect(existsSync(join(paths.bin, 'claude'))).toBe(false);
    expect(existsSync(paths.manifest)).toBe(false);
    expect(disableHost(paths)).toBe(false);
    expect(hostStatus(paths, files, [], false).enabled).toBe(false);
  });

  it('reads the profile with defaults and drops what it cannot use', () => {
    const { paths } = home();
    expect(readProfile(paths)).toEqual({ port: HOST_PORT_DEFAULT, ask: [], egress: null });
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.profile,
      JSON.stringify({ port: 80, ask: ['github', 'gmail', 3], egress: ['api.github.com', 5] }),
    );
    expect(readProfile(paths)).toEqual({
      port: HOST_PORT_DEFAULT,
      ask: ['github'],
      egress: ['api.github.com'],
    });
    writeFileSync(paths.profile, JSON.stringify({ port: 19000 }));
    expect(hostSpec(paths, readProfile(paths), '/h').port).toBe(19000);
    writeFileSync(paths.profile, 'nope');
    expect(readProfile(paths).port).toBe(HOST_PORT_DEFAULT);
  });
});
