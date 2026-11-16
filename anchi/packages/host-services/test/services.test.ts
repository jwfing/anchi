import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ControlClient } from '../src/control/client.ts';
import { HostServices } from '../src/main.ts';

// Unix socket paths are short-lived and short: macOS caps them at 104 bytes.
const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : '/tmp', 'ahs-'));
const KEY = Buffer.alloc(32, 'k').toString('base64');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let services: HostServices | undefined;

afterAll(async () => {
  await services?.stop();
});

describe('host services process', () => {
  it('starts with its CA, answers the daemon over the control socket and keeps the key in memory', async () => {
    services = new HostServices(root, '9.9.9', () => {});
    await services.start();
    const paths = services.paths;
    for (const dir of [paths.state, paths.auth, paths.ca, paths.run]) {
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    }
    expect(statSync(join(paths.ca, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.bundle, 'utf8')).toContain(services.ca.certificate().trim());
    const client = new ControlClient(paths.control, paths.token);
    expect(await client.call({ op: 'version' })).toEqual({
      runtime_version: '9.9.9',
      installed_at: null,
    });
    expect(await client.call({ op: 'vault.status' })).toEqual({
      unlocked: false,
      encrypted_files: 0,
      legacy_files: 0,
    });
    await expect(
      client.call({
        op: 'credentials.import',
        connector: 'github',
        value: `ghp_${'a'.repeat(36)}`,
      }),
    ).rejects.toThrow(/VAULT_LOCKED/);
    await expect(client.call({ op: 'vault.unlock', key: 'short' })).rejects.toThrow(/BAD_REQUEST/);
    expect(await client.call({ op: 'vault.unlock', key: KEY })).toEqual({
      unlocked: true,
      migrated: [],
    });
    const status = (await client.call({
      op: 'credentials.import',
      connector: 'github',
      value: `ghp_${'a'.repeat(36)}`,
    })) as {
      connected: boolean;
    };
    expect(status.connected).toBe(true);
    expect(
      (await client.call({ op: 'credentials.status' })) as Record<string, { connected: boolean }>,
    ).toMatchObject({
      github: { connected: true },
      aws: { connected: false },
    });
    expect(
      await client.call({ op: 'credentials.setAccount', connector: 'github', label: 'octo' }),
    ).toMatchObject({ account: 'octo' });
    // The key is in no file under the root; the encrypted file is.
    const walk = (dir: string): string[] =>
      execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
    for (const file of walk(root)) expect(readFileSync(file, 'latin1'), file).not.toContain(KEY);
    expect(existsSync(join(paths.auth, 'github.json.enc'))).toBe(true);
    // Settings are validated and kept; the approval timeout follows them.
    expect(
      await client.call({
        op: 'settings.set',
        settings: { high_risk_disabled: ['github-merge'], approval_timeout_s: 120 },
      }),
    ).toEqual({
      high_risk_disabled: ['github-merge'],
      approval_timeout_s: 120,
    });
    expect(services.approvals.timeout).toBe(120);
    await expect(
      client.call({ op: 'settings.set', settings: { high_risk_disabled: ['everything'] } }),
    ).rejects.toThrow(/BAD_SETTINGS/);
    expect(JSON.parse(readFileSync(paths.settings, 'utf8'))).toEqual({
      high_risk_disabled: ['github-merge'],
      approval_timeout_s: 120,
    });
    // The principal registers and the listener comes up on its port; a port in use is reported.
    const port = await freePort();
    expect(
      await client.call({ op: 'register', connectors: ['github'], listen_port: port }),
    ).toEqual({ listen_port: port });
    expect(services.proxy.listenPort).toBe(port);
    expect((await client.call({ op: 'list' })) as { cells: unknown[] }).toEqual({ cells: [] });
    const busy = createServer();
    const other = await new Promise<number>((r) =>
      busy.listen(0, '127.0.0.1', () => r((busy.address() as { port: number }).port)),
    );
    await expect(
      client.call({ op: 'register', connectors: [], listen_port: other }),
    ).rejects.toThrow(/PORT_IN_USE/);
    busy.close();
    await expect(
      client.call({ op: 'approvals.decide', id: '0123456789abcdef', allow: true }),
    ).rejects.toThrow(/UNKNOWN_APPROVAL/);
    expect(await client.call({ op: 'unregister' })).toEqual({ removed: true });
    expect(services.proxy.listenPort).toBeNull();
    expect(await client.call({ op: 'vault.lock' })).toEqual({ unlocked: false });
    await expect(
      client.call({ op: 'credentials.remove', connector: 'github' }),
    ).resolves.toMatchObject({ connected: false });
    const rows = readFileSync(paths.audit, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event?: string });
    expect(rows.map((r) => r.event)).toEqual(['start', 'register', 'unregister']);
    await services.stop();
    services = undefined;
    expect(existsSync(paths.control)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
  }, 60_000);
});
