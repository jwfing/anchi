import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guestPlacement, InGuestTransport } from '../src/guest.ts';

/** A sudo stand-in that exits without reading stdin, like a guest that refuses early. */
function fakeSudo(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'guest-')), 'sudo');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('InGuestTransport.exec', () => {
  it('survives a child that exits before draining stdin instead of crashing on EPIPE', async () => {
    const transport = new InGuestTransport(fakeSudo('exit 7'));
    // Larger than the pipe buffer, so the write is still pending when the child exits.
    const result = await transport.exec(
      ['anchi-cell', 'skills', 'set', 'agent'],
      'x'.repeat(2 * 1024 * 1024),
    );
    expect(result.code).toBe(7);
  });

  it('returns the child output when stdin is read', async () => {
    const transport = new InGuestTransport(fakeSudo('cat; echo oops >&2'));
    const result = await transport.exec(['echo'], 'hello');
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: 'oops\n' });
  });
});

describe('InGuestTransport', () => {
  it('runs the same fixed guest-root argv through sudo -n, secrets on stdin', async () => {
    const transport = new InGuestTransport(fakeSudo('printf "%s|" "$@"; cat'));
    const result = await transport.exec(['anchi-cell', 'list'], 'secret-on-stdin');
    expect(result).toEqual({ code: 0, stdout: '-n|anchi-cell|list|secret-on-stdin', stderr: '' });
  });

  it('reports a guest that is always running', async () => {
    const transport = new InGuestTransport();
    expect(transport.placement).toBe('local');
    expect(await transport.vmStatus()).toBe('running');
  });
});

describe('guestPlacement', () => {
  it('is the host placement by default and the guest itself for ANCHI_GUEST=local', () => {
    expect(guestPlacement(undefined)).toBe('host');
    expect(guestPlacement('host')).toBe('host');
    expect(guestPlacement('local')).toBe('local');
  });

  it('refuses an unknown or removed placement instead of falling back to one', () => {
    for (const value of ['ssh', 'lima', '']) {
      expect(() => guestPlacement(value)).toThrow(/ANCHI_GUEST must be local or host/);
    }
  });
});
