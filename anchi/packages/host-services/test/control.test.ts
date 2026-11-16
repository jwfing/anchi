import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlClient, ControlError, ControlServer } from '../src/index.ts';

// Unix socket paths are short-lived and short: macOS caps them at 104 bytes.
const dir = () => mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ahc-'));

/** One raw line to the socket, the answer line back. */
function raw(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(line));
    socket.on('data', (b: Buffer) => (data += b.toString()));
    socket.on('close', () => resolve(data.trim()));
  });
}

describe('control socket', () => {
  let server: ControlServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('answers only a caller with the token, with validated requests', async () => {
    const root = dir();
    const paths = { socket: join(root, 'control.sock'), token: join(root, 'control.token') };
    const seen: string[] = [];
    server = new ControlServer(paths.socket, paths.token, {
      version: () => ({ runtime_version: '1.2.3' }),
      list: () => {
        seen.push('list');
        return { cells: [] };
      },
      verify: (r) => {
        if (r.op !== 'verify') throw new Error('shape');
        throw new ControlError('NO_CREDENTIAL');
      },
      quota: () => {
        throw new Error('boom');
      },
    });
    await server.start();
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(statSync(paths.token).mode & 0o777).toBe(0o600);
    const client = new ControlClient(paths.socket, paths.token);
    expect(await client.call({ op: 'version' })).toEqual({ runtime_version: '1.2.3' });
    expect(await client.call({ op: 'list' })).toEqual({ cells: [] });
    await expect(client.call({ op: 'verify', connector: 'github' })).rejects.toThrow(
      /^NO_CREDENTIAL$/,
    );
    // An exception that is not a ControlError says nothing about itself.
    await expect(client.call({ op: 'quota' })).rejects.toThrow(/^CONTROL_FAILED$/);
    // Without the token, or with a wrong one, nothing is answered but the refusal.
    const token = readFileSync(paths.token, 'utf8');
    expect(await raw(paths.socket, '{"op":"list"}\n')).toBe('{"ok":false,"error":"CALLER_DENIED"}');
    expect(await raw(paths.socket, `{"op":"list","token":"${'0'.repeat(64)}"}\n`)).toBe(
      '{"ok":false,"error":"CALLER_DENIED"}',
    );
    expect(await raw(paths.socket, `{"op":"list","token":"${token}x"}\n`)).toBe(
      '{"ok":false,"error":"CALLER_DENIED"}',
    );
    expect(seen).toEqual(['list']);
    // Shape checks after the token: unknown operations, unknown fields, out-of-range values.
    expect(await raw(paths.socket, `{"op":"nope","token":"${token}"}\n`)).toBe(
      '{"ok":false,"error":"UNKNOWN_OP"}',
    );
    expect(await raw(paths.socket, `{"op":"list","token":"${token}","extra":1}\n`)).toBe(
      '{"ok":false,"error":"BAD_REQUEST"}',
    );
    expect(
      await raw(
        paths.socket,
        `{"op":"approvals.decide","token":"${token}","id":"zz","allow":true}\n`,
      ),
    ).toBe('{"ok":false,"error":"BAD_REQUEST"}');
    expect(await raw(paths.socket, 'not json\n')).toBe('{"ok":false,"error":"BAD_REQUEST"}');
    expect(await raw(paths.socket, `${'x'.repeat(70_000)}\n`)).toBe(
      '{"ok":false,"error":"BAD_REQUEST"}',
    );
    // A missing token file is reported, not sent as an empty token.
    writeFileSync(paths.token, '');
    await expect(client.call({ op: 'list' })).rejects.toThrow(/CALLER_DENIED/);
  });

  it('validates a registration before any handler runs', async () => {
    const root = dir();
    const paths = { socket: join(root, 'c.sock'), token: join(root, 'c.token') };
    const registered: unknown[] = [];
    server = new ControlServer(paths.socket, paths.token, {
      register: (r) => {
        registered.push(r);
        return { listen_port: (r as { listen_port: number }).listen_port };
      },
    });
    await server.start();
    const client = new ControlClient(paths.socket, paths.token);
    const good = { op: 'register' as const, connectors: ['github' as const], listen_port: 18180 };
    expect(await client.call(good)).toEqual({ listen_port: 18180 });
    for (const bad of [
      { ...good, connectors: ['gmail'] },
      { ...good, listen_port: 80 },
      { ...good, listen_port: '18180' },
      { ...good, ask: ['aws'], high_risk_disabled: ['Bad Id'] },
      { ...good, egress: ['*.example'] },
      { ...good, task: 'other' },
    ]) {
      await expect(client.call(bad as never)).rejects.toThrow(/BAD_REQUEST/);
    }
    expect(registered.length).toBe(1);
    expect(registered[0]).toMatchObject({ ask: [], high_risk_disabled: [], egress: null });
  });

  it('streams a watch until the client leaves', async () => {
    const root = dir();
    const paths = { socket: join(root, 'w.sock'), token: join(root, 'w.token') };
    let push: ((line: string) => void) | undefined;
    let closed = false;
    server = new ControlServer(paths.socket, paths.token, {}, (write, onClose) => {
      push = write;
      onClose(() => {
        closed = true;
      });
      write('{"type":"ping"}');
    });
    await server.start();
    const client = new ControlClient(paths.socket, paths.token);
    const lines: string[] = [];
    let ended = false;
    const stop = client.watch(
      (line) => lines.push(line),
      () => {
        ended = true;
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    push!('{"type":"pending","approval":{"id":"0123456789abcdef"}}');
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual([
      '{"type":"ping"}',
      '{"type":"pending","approval":{"id":"0123456789abcdef"}}',
    ]);
    stop();
    await new Promise((r) => setTimeout(r, 100));
    expect([closed, ended]).toEqual([true, true]);
  });
});
