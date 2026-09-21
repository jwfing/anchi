import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionPath, listSessions } from '../sessions.mjs';

test('resume accepts an existing session but rejects traversal, symlinks and mismatched headers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sessions-'));
  const id = '12345678-1234-1234-1234-123456789012';
  const file = path.join(dir, `time_${id}.jsonl`);
  try {
    const header = { type: 'session', id, cwd: '/workspace' };
    await fs.writeFile(file, JSON.stringify(header) + '\n');
    assert.equal(await sessionPath(id, dir), file);
    await assert.rejects(sessionPath('../auth.json', dir), /INVALID_SESSION_ID/);
    await fs.writeFile(file, JSON.stringify({ ...header, id: 'wrong' }) + '\n');
    await assert.rejects(sessionPath(id, dir), /INVALID_SESSION_FILE/);
    await fs.unlink(file);
    await fs.symlink('/etc/passwd', file);
    await assert.rejects(sessionPath(id, dir), /INVALID_SESSION_FILE/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listing skips traversal names, symlinks and foreign headers while keeping valid sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sessions-'));
  try {
    const good = 'aaaaaaaa-1111-2222-3333-444444444444',
      bad = 'bbbbbbbb-1111-2222-3333-444444444444';
    await fs.writeFile(
      path.join(dir, `2026_${good}.jsonl`),
      JSON.stringify({ type: 'session', id: good, cwd: '/workspace' }) + '\n',
    );
    await fs.writeFile(
      path.join(dir, `2026_${bad}.jsonl`),
      JSON.stringify({ type: 'session', id: bad, cwd: '/elsewhere' }) + '\n',
    );
    await fs.symlink(
      '/etc/passwd',
      path.join(dir, '2026_cccccccc-1111-2222-3333-444444444444.jsonl'),
    );
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    const sessions = await listSessions(dir);
    assert.deepEqual(
      sessions.map((s) => s.session_id),
      [good],
    );
    assert.deepEqual(await listSessions(path.join(dir, 'missing')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
