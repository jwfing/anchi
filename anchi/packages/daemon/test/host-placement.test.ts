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
  hostCommand,
  hostExec,
  hostPaths,
  hostSpec,
  hostStatus,
  HostTransport,
  opensslAvailable,
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
  caCert: '/h/.anchi/host/state/ca/ca.pem',
  denyRead: ['/h/.anchi/host', '/h/.ssh'],
};

describe('host placement: guest commands on the host', () => {
  it('answers the daemon from the services, with canned answers where the host has no counterpart', async () => {
    const calls: unknown[] = [];
    const call = async (request: unknown) => {
      calls.push(request);
      const op = (request as { op: string }).op;
      if (op === 'verify') throw new Error('NO_CREDENTIAL:NOT_CONNECTED');
      return { answered: op };
    };
    const run = (args: string[], stdin = '') => hostExec(args, stdin, call);
    expect(await run(['anchi-cell', 'version'])).toEqual({
      code: 0,
      stdout: '{"answered":"version"}',
      stderr: '',
    });
    expect(JSON.parse((await run(['anchi-cell', 'list'])).stdout)).toEqual({ cells: [] });
    expect(JSON.parse((await run(['anchi-cell', 'reap', 't1'])).stdout)).toEqual({ reaped: [] });
    await run(['anchi-cell', 'egress-settings'], '{"high_risk_disabled": ["github-merge"]}');
    expect(calls.at(-1)).toEqual({
      op: 'settings.set',
      settings: { high_risk_disabled: ['github-merge'] },
    });
    await run(['anchi-cell', 'register'], '{"connectors": ["github"], "listen_port": 18180}');
    expect(calls.at(-1)).toEqual({ op: 'register', connectors: ['github'], listen_port: 18180 });
    await run(['anchi-cell', 'approvals', 'decide', '0123456789abcdef', 'deny']);
    expect(calls.at(-1)).toEqual({ op: 'approvals.decide', id: '0123456789abcdef', allow: false });
    // The services' refusal reaches the daemon as the guest's would: a code, exit 1.
    expect(await run(['anchi-cell', 'verify', 'github'])).toEqual({
      code: 1,
      stdout: '{"error":"NO_CREDENTIAL:NOT_CONNECTED"}',
      stderr: '',
    });
    await run(
      ['/usr/bin/python3', '/opt/secure-vm/services/admin.py', 'import-token', 'github'],
      '{"token": "ghp_x"}',
    );
    expect(calls.at(-1)).toEqual({ op: 'credentials.import', connector: 'github', value: 'ghp_x' });
    await run(
      ['/usr/bin/python3', '/opt/secure-vm/services/admin.py', 'import-aws', 'aws'],
      '{"access_key_id": "AKIA1", "secret_access_key": "s", "region": "us-east-1", "session_token": "t"}',
    );
    expect(calls.at(-1)).toEqual({
      op: 'credentials.importAws',
      access_key_id: 'AKIA1',
      secret_access_key: 's',
      region: 'us-east-1',
      session_token: 't',
    });
    await run(
      ['/usr/bin/python3', '/opt/secure-vm/services/admin.py', 'set-account', 'aws'],
      '{"account": "bot"}',
    );
    expect(calls.at(-1)).toEqual({ op: 'credentials.setAccount', connector: 'aws', label: 'bot' });
    await run(['/usr/bin/python3', '/opt/secure-vm/services/admin.py', 'disconnect', 'linear']);
    expect(calls.at(-1)).toEqual({ op: 'credentials.remove', connector: 'linear' });
    await run(['/usr/bin/python3', '/opt/secure-vm/services/vault_admin.py', 'status']);
    expect(calls.at(-1)).toEqual({ op: 'vault.status' });
    // The runtimes stay the user's own logins: never configured in the vault on the host.
    for (const script of ['codex_admin.py', 'claude_admin.py', 'hermes_admin.py']) {
      const r = await run(['/usr/bin/python3', `/opt/secure-vm/services/${script}`, 'status']);
      expect(JSON.parse(r.stdout).configured).toBe(false);
      expect(
        (await run(['/usr/bin/python3', `/opt/secure-vm/services/${script}`, 'import-token'])).code,
      ).toBe(1);
    }
    // Nothing else runs: no policy administration, no cell manager, no unknown script, no polls.
    const before = calls.length;
    for (const args of [
      ['/usr/bin/python3', '/opt/secure-vm/services/policy_admin.py', 'show', 'x'],
      ['/usr/bin/python3', '/opt/secure-vm/services/../../etc/passwd', 'status'],
      ['sudo', '-n', 'anchi-cell', 'list'],
      ['anchi-image', 'remove', 'x'],
      ['anchi-cell', 'start', 't', 'a'],
      ['anchi-cell', 'poll'],
      ['anchi-cell', 'approvals', 'decide', 'x', 'maybe'],
    ]) {
      expect(await run(args), args.join(' ')).toEqual({
        code: 1,
        stdout: '{"error":"HOST_PLACEMENT"}',
        stderr: '',
      });
    }
    expect(calls.length).toBe(before);
    // Images are always present and nothing mounts: the setup status needs no VM.
    expect(JSON.parse((await run(['anchi-image', 'status', 'codex', 'base'])).stdout)).toEqual({
      present: true,
    });
    expect(await run(['test', '-f', '/opt/secure-vm/services/vault_admin.py'])).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect(await run(['mountpoint', '-q', '/mnt/anchi-host'])).toEqual({
      code: 1,
      stdout: '',
      stderr: '',
    });
    // A body the daemon sends is checked before it is forwarded.
    expect((await run(['anchi-cell', 'register'], '[1]')).stdout).toBe('{"error":"BAD_REQUEST"}');
  });

  it('is a transport that reports the services as running once their socket exists', async () => {
    const { paths } = home();
    const transport = new HostTransport(paths, { services: ['x'], cli: ['y'] });
    expect(transport.placement).toBe('host');
    expect(transport.running()).toBe(false);
    expect(await transport.vmStatus()).toBe('stopped');
    // Without the services, a call that needs them says so, and never hangs.
    const r = await transport.exec(['anchi-cell', 'version']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('HOST_SERVICES_UNAVAILABLE');
    mkdirSync(paths.run, { recursive: true });
    writeFileSync(paths.control, '');
    writeFileSync(paths.token, 'x');
    expect(transport.running()).toBe(true);
    expect(await transport.vmStatus()).toBe('running');
    // A canned answer comes back through spawn for anything but the approval stream.
    const child = transport.spawn(['anchi-cell', 'start', 't']);
    const out: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect([code, Buffer.concat(out).toString()]).toEqual([1, '{"error":"HOST_PLACEMENT"}']);
  });

  it('starts the services from the sources in a checkout and from lib/ in a release', () => {
    const command = hostCommand();
    expect(command.services[0]).toBe(process.execPath);
    expect(command.services.at(-1)).toMatch(/host-services\/src\/main\.ts$/);
    expect(command.cli.at(-1)).toMatch(/host-services\/src\/cli\.ts$/);
    expect(opensslAvailable('/nonexistent')).toBe(false);
  });

  it('asks a host-placement daemon for openssl, not Python', () => {
    const host = hostReadiness('host');
    expect(host.missing.filter((m) => /python|sudo/i.test(m))).toEqual([]);
    expect(host.installHint).toMatch(/openssl/);
  });

  it('keeps the placement in the login-time daemon definitions', () => {
    const layout = homeLayout('/home/u/.anchi');
    expect(launchdPlist(layout, '/usr/bin', 'host')).toContain(
      '<key>ANCHI_GUEST</key>\n    <string>host</string>',
    );
    expect(launchdPlist(layout, '/usr/bin', undefined)).not.toContain('ANCHI_GUEST');
    expect(systemdUnit(layout, '/usr/bin', 'host')).toContain('"ANCHI_GUEST=host"');
    expect(systemdUnit(layout, '/usr/bin', 'ssh')).not.toContain('ANCHI_GUEST');
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
    expect(managed.previousEnv.SSL_CERT_FILE).toBe('/mine.pem');
    expect(managed.previousEnv.CURL_CA_BUNDLE).toBeUndefined();
    expect(JSON.parse(claudeSettingsRestored(text, managed))).toEqual({
      model: 'opus',
      env: { EDITOR: 'vim', SSL_CERT_FILE: '/mine.pem' },
    });
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
    const again = codexConfigText(text, { ...spec, denyRead: ['/other'] });
    expect(again.split('anchi host placement >>>').length).toBe(2);
    expect(again).toContain('"/other" = "deny"');
    expect(again).not.toContain('/h/.ssh');
    expect(codexConfigRestored(again)).toBe(before);
    expect(codexConfigRestored(codexConfigText(undefined, spec))).toBe('');
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
    expect(() => enableHost(paths, files, ['github'], undefined, root)).toThrow(/HOST_NOT_RUNNING/);
    expect(existsSync(paths.manifest)).toBe(false);
    mkdirSync(paths.ca, { recursive: true });
    writeFileSync(paths.caCert, 'CA');
    writeFileSync(paths.caBundle, 'ROOTS\nCA');
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
      shimOnPath: true,
      claude: { file: files.claudeSettings, managed: true, excludedCommands: [] },
      codex: { file: files.codexConfig, managed: true },
      connectors: ['github'],
    });
    expect(hostStatus(paths, files, [], false, '/nonexistent')).toMatchObject({
      shimOnPath: false,
      installed: false,
      missing: ['openssl'],
    });
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
