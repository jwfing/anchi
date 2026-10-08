import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent, StoredEvent, TaskQuery, TaskRow, TaskStatus } from '@anchi/protocol';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  resume_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,
  links TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);
CREATE TABLE IF NOT EXISTS trigger_state (
  key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  next_run INTEGER,
  last_run INTEGER,
  last_result TEXT,
  baseline INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trigger_seen (
  key TEXT NOT NULL,
  item TEXT NOT NULL,
  task_id TEXT,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (key, item)
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
`;

/** Events kept per task; the oldest are dropped beyond this (bounded session view). */
export const MAX_EVENTS_PER_TASK = 5000;
export const MAX_RESULT_CHARS = 8000;

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    trigger: r.trigger as string,
    title: r.title as string,
    status: r.status as TaskStatus,
    resumeId: (r.resume_id as string | null) ?? null,
    createdAt: r.created_at as number,
    startedAt: (r.started_at as number | null) ?? null,
    finishedAt: (r.finished_at as number | null) ?? null,
    result: (r.result as string | null) ?? null,
    links: JSON.parse((r.links as string) || '[]') as string[],
    parentId: (r.parent_id as string | null) ?? null,
    rootId: ((r.root_id as string | null) ?? r.id) as string,
    depth: (r.depth as number | null) ?? 0,
    turns: (r.turns as number | null) ?? 0,
    inputTokens: (r.input_tokens as number | null) ?? 0,
    outputTokens: (r.output_tokens as number | null) ?? 0,
  };
}

/** http(s) URLs in agent output, for the task list. */
export function extractLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()"'`\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 10);
}

export interface TriggerState {
  key: string;
  agentId: string;
  nextRun: number | null;
  lastRun: number | null;
  lastResult: string | null;
  /** Polls: the first poll recorded what already existed, without starting tasks. */
  baseline: boolean;
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after phase 1; existing databases gain them in place. */
  private migrate() {
    const have = new Set(
      this.db
        .prepare('PRAGMA table_info(tasks)')
        .all()
        .map((c) => c.name as string),
    );
    const add: [string, string][] = [
      ['parent_id', 'TEXT'],
      ['root_id', 'TEXT'],
      ['depth', 'INTEGER NOT NULL DEFAULT 0'],
      ['turns', 'INTEGER NOT NULL DEFAULT 0'],
      ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
      ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of add) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id); CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_id);',
    );
  }

  close(): void {
    this.db.close();
  }

  createTask(t: { agentId: string; trigger: string; title: string; parent?: TaskRow }): TaskRow {
    // Task ids name cells and guest units: lowercase, digits and "-".
    const id = `t-${randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        "INSERT INTO tasks (id, agent_id, trigger, title, status, created_at, parent_id, root_id, depth) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
      )
      .run(
        id,
        t.agentId,
        t.trigger,
        t.title.replace(/\s+/g, ' ').slice(0, 120),
        Date.now(),
        t.parent?.id ?? null,
        t.parent?.rootId ?? id,
        t.parent ? t.parent.depth + 1 : 0,
      );
    return this.getTask(id)!;
  }

  // ── triggers ────────────────────────────────────────────

  triggerState(key: string): TriggerState | undefined {
    const r = this.db.prepare('SELECT * FROM trigger_state WHERE key = ?').get(key);
    return r
      ? {
          key,
          agentId: r.agent_id as string,
          nextRun: (r.next_run as number | null) ?? null,
          lastRun: (r.last_run as number | null) ?? null,
          lastResult: (r.last_result as string | null) ?? null,
          baseline: r.baseline === 1,
        }
      : undefined;
  }

  saveTriggerState(s: TriggerState): void {
    this.db
      .prepare(
        `INSERT INTO trigger_state (key, agent_id, next_run, last_run, last_result, baseline)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET next_run = excluded.next_run, last_run = excluded.last_run,
           last_result = excluded.last_result, baseline = excluded.baseline`,
      )
      .run(
        s.key,
        s.agentId,
        s.nextRun,
        s.lastRun,
        s.lastResult?.slice(0, 500) ?? null,
        s.baseline ? 1 : 0,
      );
  }

  /** Records an item; false if this trigger saw it before (each item starts one task at most). */
  markSeen(key: string, item: string, taskId: string | null = null): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO trigger_seen (key, item, task_id, seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(key, item, taskId, Date.now());
    return r.changes === 1;
  }

  seen(key: string, item: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM trigger_seen WHERE key = ? AND item = ?').get(key, item),
    );
  }

  setSeenTask(key: string, item: string, taskId: string): void {
    this.db
      .prepare('UPDATE trigger_seen SET task_id = ? WHERE key = ? AND item = ?')
      .run(taskId, key, item);
  }

  children(id: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at')
      .all(id)
      .map(rowToTask);
  }

  /** Counts a turn against the task's delegation tree. */
  countTurn(id: string): void {
    this.db.prepare('UPDATE tasks SET turns = turns + 1 WHERE id = ?').run(id);
  }

  /** Turns run so far by every task in a delegation tree. */
  treeTurns(rootId: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(turns), 0) AS n FROM tasks WHERE root_id = ? OR id = ?')
      .get(rootId, rootId);
    return (r?.n as number) ?? 0;
  }

  getTask(id: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? rowToTask(r) : undefined;
  }

  listTasks(agentId?: string, limit = 100): TaskRow[] {
    const rows = agentId
      ? this.db
          .prepare('SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(agentId, limit)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(rowToTask);
  }

  search(q: TaskQuery): TaskRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.agentId) {
      where.push('agent_id = ?');
      args.push(q.agentId);
    }
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    }
    for (const word of (q.text ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("(title LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')");
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (q.since !== undefined) {
      where.push('created_at >= ?');
      args.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('created_at < ?');
      args.push(q.until);
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 500);
    const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
    return this.db
      .prepare(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
      .map(rowToTask);
  }

  tree(rootId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id = ? OR root_id = ? ORDER BY depth, created_at')
      .all(rootId, rootId)
      .map(rowToTask);
  }

  addUsage(id: string, input = 0, output = 0): void {
    this.db
      .prepare(
        'UPDATE tasks SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?',
      )
      .run(input, output, id);
  }

  /** Deletes tasks (and their events) by id; returns how many went. */
  deleteTasks(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
      n += Number(this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes);
    }
    return n;
  }

  /** Ids of finished tasks created before `before`, for retention. */
  finishedBefore(before: number): string[] {
    return this.db
      .prepare(
        "SELECT id FROM tasks WHERE created_at < ? AND status IN ('done','failed','cancelled')",
      )
      .all(before)
      .map((r) => r.id as string);
  }

  setStatus(id: string, status: TaskStatus): TaskRow {
    const now = Date.now();
    if (status === 'running') {
      this.db
        .prepare(
          'UPDATE tasks SET status = ?, started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?',
        )
        .run(status, now, id);
    } else if (status === 'queued') {
      this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
    } else {
      this.db
        .prepare('UPDATE tasks SET status = ?, finished_at = ? WHERE id = ?')
        .run(status, now, id);
    }
    return this.getTask(id)!;
  }

  setResult(id: string, result: string): void {
    const text = result.slice(0, MAX_RESULT_CHARS);
    const links = extractLinks(text);
    this.db
      .prepare('UPDATE tasks SET result = ?, links = ? WHERE id = ?')
      .run(text, JSON.stringify(links), id);
  }

  setResumeId(id: string, resumeId: string): void {
    this.db.prepare('UPDATE tasks SET resume_id = ? WHERE id = ?').run(resumeId, id);
  }

  /** Tasks that were in flight when the daemon stopped; they cannot be resumed mid-turn. */
  interrupted(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('running', 'queued')")
      .all()
      .map(rowToTask);
  }

  appendEvent(taskId: string, event: RuntimeEvent): number {
    const ts = Date.now();
    const { seq } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE task_id = ?')
      .get(taskId) as { seq: number };
    this.db
      .prepare('INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, seq, ts, event.type, JSON.stringify(event));
    if (seq > MAX_EVENTS_PER_TASK) {
      this.db
        .prepare('DELETE FROM events WHERE task_id = ? AND seq <= ?')
        .run(taskId, seq - MAX_EVENTS_PER_TASK);
    }
    return seq;
  }

  events(taskId: string, afterSeq = 0): StoredEvent[] {
    return this.db
      .prepare('SELECT seq, ts, payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq')
      .all(taskId, afterSeq)
      .map((r) => ({
        seq: r.seq as number,
        ts: r.ts as number,
        event: JSON.parse(r.payload as string) as RuntimeEvent,
      }));
  }
}
