import type { QuotaInfo, QuotaWindow } from '@anchi/protocol';

/** Usage of a subscription window that is worth a notification, in percent. */
export const QUOTA_THRESHOLDS = [80, 95] as const;
const CHECK_INTERVAL_MS = 60_000;

/** A window's length in words: `5-hour`, `weekly`. */
export function windowLabel(w: QuotaWindow): string {
  const m = w.windowMinutes;
  if (m === null) return w.name;
  if (m === 10_080) return 'weekly';
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

const RUNTIME: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };

/**
 * Notifies once when a subscription window passes 80% and once past 95% (per window period,
 * keyed by its reset time), and once when a limit is reached. Read after turns, at most once a
 * minute; the limits are what the egress proxy last saw.
 */
export class QuotaAlerts {
  private sent = new Set<string>();
  private last = -Infinity;

  constructor(
    private read: () => Promise<QuotaInfo[]>,
    private notify: (title: string, message: string) => void,
    private now: () => number = Date.now,
  ) {}

  /** Checks the limits (unless checked within the last minute); returns the alerts sent. */
  async check(): Promise<string[]> {
    if (this.now() - this.last < CHECK_INTERVAL_MS) return [];
    this.last = this.now();
    const sent: string[] = [];
    const send = (key: string, title: string, message: string) => {
      if (this.sent.has(key)) return;
      this.sent.add(key);
      sent.push(title);
      this.notify(title, message);
    };
    for (const q of await this.read()) {
      const name = RUNTIME[q.runtime] ?? q.runtime;
      for (const w of q.windows ?? []) {
        const used = w.usedPercent;
        if (used === null) continue;
        const threshold = [...QUOTA_THRESHOLDS].reverse().find((t) => used >= t);
        if (threshold === undefined) continue;
        const resets = w.resetAt ? `; it resets ${new Date(w.resetAt).toLocaleString()}` : '';
        send(
          `${q.runtime}:${w.name}:${w.resetAt}:${threshold}`,
          `Anchi: ${name} ${windowLabel(w)} window ${used}% used`,
          `Past ${threshold}% of the ${windowLabel(w)} window${resets}. Scheduled and polling agents use it too.`,
        );
      }
      const resetAt = Math.max(0, ...(q.windows ?? []).map((w) => w.resetAt ?? 0));
      if (q.limited || q.status === 429) {
        send(
          `${q.runtime}:limited:${resetAt || Math.floor(q.ts / 3_600_000)}`,
          `Anchi: ${name} limit reached`,
          `${name} refuses new turns until a window resets${resetAt ? ` (${new Date(resetAt).toLocaleString()})` : ''}.`,
        );
      }
    }
    return sent;
  }
}
