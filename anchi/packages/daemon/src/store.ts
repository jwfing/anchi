import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent, StoredEvent, TaskRow, TaskStatus } from '@anchi/protocol';

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
  };
}

/** http(s) URLs in agent output, for the task list. */
export function extractLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()"'`\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 10);
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createTask(t: { agentId: string; trigger: string; title: string }): TaskRow {
    // Task ids name cells and guest units: lowercase, digits and "-".
    const id = `t-${randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        "INSERT INTO tasks (id, agent_id, trigger, title, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
      )
      .run(id, t.agentId, t.trigger, t.title.replace(/\s+/g, ' ').slice(0, 120), Date.now());
    return this.getTask(id)!;
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
