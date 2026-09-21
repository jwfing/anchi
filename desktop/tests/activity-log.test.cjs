const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActivityLog } = require('../src/main/activity-log.cjs');
async function fixture(t, options) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-activity-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return {
    file: path.join(base, 'activity.jsonl'),
    log: new ActivityLog(path.join(base, 'activity.jsonl'), options),
  };
}
test('chat and approval payloads are never persisted; metadata survives restart', async (t) => {
  const { file, log } = await fixture(t);
  await log.load();
  await log.append({ type: 'assistant', text: 'SECRET_REPLY' });
  await log.append({ type: 'user', text: 'SECRET_PROMPT' });
  await log.append({ type: 'response', result: { token: 'SECRET' } });
  await log.append({
    type: 'tool_end',
    tool: 'gmail_read',
    is_error: false,
    payload: { body: 'SECRET_MAIL' },
  });
  await log.append({ type: 'activity', text: '目录授权已生效', time: '2026-09-20T00:00:00.000Z' });
  await log.append({
    type: 'approval_required',
    approval_id: 'a'.repeat(32),
    request_id: 'r'.repeat(32),
  });
  const raw = await fs.readFile(file, 'utf8');
  assert(!raw.includes('SECRET'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const reopened = new ActivityLog(file);
  const entries = await reopened.load();
  assert.deepEqual(
    entries.map((e) => e.type),
    ['tool_end', 'activity', 'approval_required'],
  );
  assert.equal(entries[1].time, '2026-09-20T00:00:00.000Z');
  assert.equal(entries[2].request_id, undefined);
  assert.deepEqual(reopened.recent(1)[0].type, 'approval_required');
});
test('oversized logs are compacted to the retained window and corrupt lines are skipped', async (t) => {
  const { file, log } = await fixture(t, { maxBytes: 200, keep: 3 });
  for (let i = 0; i < 10; i++) await log.append({ type: 'activity', text: 'x'.repeat(50) + i });
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert(lines.length <= 4, `expected compaction, got ${lines.length} lines`);
  await fs.appendFile(file, '{broken\n');
  const reopened = new ActivityLog(file, { keep: 3 });
  assert.equal((await reopened.load()).length, 3);
});
