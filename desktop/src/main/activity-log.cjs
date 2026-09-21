const fs = require('node:fs/promises');
const path = require('node:path');
/**
 * Durable activity metadata for the desktop. Chat text, approval payloads and RPC
 * responses are never written; only event type, time and short identifiers are kept.
 */
const CONTENT_TYPES = new Set(['assistant', 'user', 'response']);
const FIELDS = [
  'type',
  'time',
  'text',
  'tool',
  'approval_id',
  'success',
  'cancelled',
  'error',
  'code',
  'is_error',
];
class ActivityLog {
  constructor(file, { maxBytes = 1024 * 1024, keep = 1000 } = {}) {
    Object.assign(this, { file, maxBytes, keep });
    this.entries = [];
    this.tail = Promise.resolve();
  }
  static sanitize(event) {
    if (!event || typeof event !== 'object' || CONTENT_TYPES.has(event.type)) return null;
    const entry = { time: new Date().toISOString() };
    for (const key of FIELDS) {
      const value = event[key];
      if (value === undefined) continue;
      if (typeof value === 'string') entry[key] = value.slice(0, 500);
      else if (typeof value === 'boolean' || typeof value === 'number') entry[key] = value;
    }
    if (typeof entry.type !== 'string') return null;
    return entry;
  }
  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const entries = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value && typeof value.type === 'string') entries.push(value);
        } catch {}
      }
      this.entries = entries.slice(-this.keep);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.entries;
  }
  recent(count) {
    return this.entries.slice(-count);
  }
  append(event) {
    const entry = ActivityLog.sanitize(event);
    if (!entry) return Promise.resolve();
    this.entries.push(entry);
    if (this.entries.length > this.keep) this.entries = this.entries.slice(-this.keep);
    const work = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const stat = await fs.stat(this.file).catch(() => null);
      if (stat && stat.size > this.maxBytes) {
        const temp = this.file + '.tmp';
        await fs.writeFile(temp, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', {
          mode: 0o600,
        });
        await fs.rename(temp, this.file);
      } else {
        await fs.appendFile(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
module.exports = { ActivityLog };
