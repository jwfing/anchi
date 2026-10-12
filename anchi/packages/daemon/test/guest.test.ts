import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimaTransport } from '../src/guest.ts';

/** A limactl stand-in that exits without reading stdin, like a guest that refuses early. */
function fakeLimactl(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'guest-')), 'limactl');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('LimaTransport.exec', () => {
  it('survives a child that exits before draining stdin instead of crashing on EPIPE', async () => {
    const transport = new LimaTransport('anchi-vm', fakeLimactl('exit 7'));
    // Larger than the pipe buffer, so the write is still pending when the child exits.
    const result = await transport.exec(
      ['anchi-cell', 'skills', 'set', 'agent'],
      'x'.repeat(2 * 1024 * 1024),
    );
    expect(result.code).toBe(7);
  });

  it('returns the child output when stdin is read', async () => {
    const transport = new LimaTransport('anchi-vm', fakeLimactl('cat; echo oops >&2'));
    const result = await transport.exec(['echo'], 'hello');
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: 'oops\n' });
  });
});
