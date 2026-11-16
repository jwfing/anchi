import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const AUDIT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * One JSON object per line, as the Python proxy wrote them: method, host, path, operation,
 * decision, principal; never a header value, a query string or a body. Rotated once at 50 MiB.
 */
export class Audit {
  constructor(readonly file: string) {}

  row(entry: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ...entry, ts: Math.round(Date.now()) / 1000 }, Object.keys({ ...entry, ts: 0 }).sort())}\n`;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      if (statSync(this.file).size > AUDIT_MAX_BYTES) renameSync(this.file, `${this.file}.1`);
    } catch {
      // No file yet.
    }
    appendFileSync(this.file, line, { mode: 0o600 });
  }
}
