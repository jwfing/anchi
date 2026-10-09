import type { QuotaInfo, QuotaWindow, TaskAudit, UsageGroup, UsageRow } from '@anchi/protocol';
import { auditHeadline } from '@anchi/daemon';
import { sanitizeLine } from '../sanitize.ts';
import { truncate } from './lines.ts';

/** A line of a report view: text with an optional style. Agent-originated parts are sanitized. */
export interface ReportLine {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const head = (text: string): ReportLine => ({ text, bold: true });
/** Agent-originated text (hosts, paths, operations, reasons) without escapes or line breaks. */
const clean = (s: string) => sanitizeLine(s);
const gap: ReportLine = { text: '' };
const n = (x: number) =>
  x >= 1_000_000
    ? `${(x / 1_000_000).toFixed(1)}M`
    : x >= 1000
      ? `${(x / 1000).toFixed(1)}k`
      : String(x);
const time = (ms: number) => new Date(ms).toLocaleTimeString();

/** The access report of a task: the headline, the cell's scope, hosts, refusals, then requests. */
export function accessLines(a: TaskAudit, width: number): ReportLine[] {
  const fit = (s: string) => truncate(s, width);
  const other = a.credentialsSent.other ?? 0;
  const lines: ReportLine[] = [
    { text: fit(clean(auditHeadline(a))), color: other ? 'red' : 'green' },
    gap,
  ];
  if (a.registration) {
    const r = a.registration;
    lines.push(
      head(`Cell${a.cells > 1 ? `s (${a.cells}; the last one)` : ''}`),
      { text: fit(`  connectors   ${r.connectors.join(', ') || 'none'}`) },
      { text: fit(`  services     ${r.services.join(', ') || 'none'} (through the bridge)`) },
      { text: fit(`  egress       ${r.egress ? r.egress.join(', ') : 'any public host'}`) },
      { text: fit(`  writes held  ${r.ask.length ? r.ask.join(', ') : 'high-risk only'}`) },
      gap,
    );
  }
  if (a.hosts.length) {
    lines.push(head('Hosts reached'));
    for (const h of a.hosts) {
      const decisions = Object.entries(h.decisions)
        .map(([d, c]) => `${d} ${c}`)
        .join(', ');
      lines.push({
        text: fit(`  ${clean(h.host).padEnd(32)} ${String(h.requests).padStart(5)}  ${decisions}`),
      });
    }
    lines.push(gap);
  }
  if (a.refused.length || a.held.length) {
    lines.push(head('Refused or held'));
    for (const r of a.refused) {
      lines.push({
        text: fit(
          `  ${time(r.ts)}  ${r.decision}  ${clean(r.host)}  ${clean(r.operation || r.path)}${r.reason ? `  (${clean(r.reason)})` : ''}`,
        ),
        color: 'yellow',
      });
    }
    for (const h of a.held) {
      lines.push({
        text: fit(
          `  held ${h.outcome}: ${clean(h.operation)} on ${clean(h.host)}${h.risk ? ` (high-risk: ${h.risk})` : ''}`,
        ),
        color: h.outcome === 'approved' ? undefined : 'yellow',
      });
    }
    lines.push(gap);
  }
  if (a.bridge.length) {
    lines.push(head('Gmail, Drive, Notion and Slack calls'));
    for (const b of a.bridge)
      lines.push({ text: fit(`  ${clean(b.service)} ${clean(b.operation)}  ${b.calls}`) });
    lines.push(gap);
  }
  if (a.streamed) {
    lines.push(
      {
        text: fit(`${a.streamed} request(s) over 8 MiB left without credentials (pass:streamed)`),
        color: 'yellow',
      },
      gap,
    );
  }
  lines.push(head(`Latest requests${a.truncated ? ` (the latest of ${a.total} rows)` : ''}`));
  if (!a.rows.length) lines.push({ text: '  none recorded for this task', dim: true });
  for (const r of [...a.rows].reverse()) {
    lines.push({
      text: fit(
        `  ${time(r.ts)}  ${clean(r.method).padEnd(6)} ${clean(r.host)}${clean(r.path)}  ${r.decision}${r.credential === 'other' ? '  ! sent its own credential' : ''}`,
      ),
      color: r.credential === 'other' ? 'red' : r.decision === 'inject' ? undefined : 'gray',
    });
  }
  return lines;
}

export const PERIODS = [
  { label: 'last 24 hours', ms: 86_400_000 },
  { label: 'last 7 days', ms: 7 * 86_400_000 },
  { label: 'last 30 days', ms: 30 * 86_400_000 },
] as const;
export const GROUPS: UsageGroup[] = ['agent', 'model', 'runtime', 'day'];

/** A window's length in words: `5-hour`, `weekly`, `90-minute`. */
function windowName(w: QuotaWindow): string {
  const m = w.windowMinutes;
  if (m === null) return w.name;
  if (m === 10_080) return 'weekly';
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

/** When a window resets: the time today, or the date and time later. */
function resetText(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** What the limits say, briefly: `5-hour window  40% used, resets 14:05`, or the headers. */
function quotaText(q: QuotaInfo): string[] {
  if (q.windows) {
    const lines = q.windows.map(
      (w) =>
        `  ${`${windowName(w)} window`.padEnd(18)}${w.usedPercent === null ? 'unknown' : `${w.usedPercent}% used`}${w.resetAt ? `, resets ${resetText(w.resetAt)}` : ''}`,
    );
    if (q.plan) lines.unshift(`  plan              ${clean(q.plan)}`);
    if (q.limited) lines.push('  limit reached: new turns are refused until a window resets');
    return lines.length ? lines : ['  no limit information'];
  }
  const entries = Object.entries(q.headers);
  if (!entries.length) return [`  ${q.status === 429 ? 'rate limited' : 'no limit information'}`];
  return entries.map(
    ([k, v]) =>
      `  ${clean(k.replace(/^(x-codex-|anthropic-ratelimit-)/, '').replaceAll('-', ' '))}  ${clean(v)}`,
  );
}

/** The usage screen: subscription limits as last seen by the proxy, then token totals. */
export function usageLines(
  rows: UsageRow[] | null,
  quota: QuotaInfo[] | null,
  period: number,
  group: UsageGroup,
  width: number,
): ReportLine[] {
  const fit = (s: string) => truncate(s, width);
  const lines: ReportLine[] = [
    head('Subscription limits (from the providers’ responses, read by the egress proxy)'),
  ];
  if (!quota) lines.push({ text: '  Loading…', dim: true });
  else if (!quota.length) {
    lines.push({
      text: fit(
        '  Not seen yet: they appear after a turn of each runtime since the egress proxy started.',
      ),
      dim: true,
    });
  }
  for (const q of quota ?? []) {
    lines.push({
      text: fit(
        `${q.runtime}  (seen ${new Date(q.ts).toLocaleString()}${q.status === 429 || q.limited ? ', rate limited' : ''})`,
      ),
      color: q.status === 429 || q.limited ? 'red' : undefined,
    });
    for (const t of quotaText(q)) lines.push({ text: fit(t) });
  }
  lines.push(gap, head(`Tokens, ${PERIODS[period]!.label}, by ${group}`));
  if (!rows) return [...lines, { text: '  Loading…', dim: true }];
  if (!rows.length) return [...lines, { text: '  No turns recorded in this period.', dim: true }];
  const cost = rows.some((r) => r.costUsd > 0);
  lines.push({
    text: fit(
      `  ${'name'.padEnd(26)}${'turns'.padStart(7)}${'input'.padStart(9)}${'cached'.padStart(9)}${'output'.padStart(9)}${'reason.'.padStart(9)}${cost ? '  est. cost' : ''}`,
    ),
    dim: true,
  });
  const total = rows.reduce(
    (t, r) => ({
      turns: t.turns + r.turns,
      input: t.input + r.inputTokens,
      cached: t.cached + r.cachedInputTokens,
      output: t.output + r.outputTokens,
      reasoning: t.reasoning + r.reasoningTokens,
      cost: t.cost + r.costUsd,
    }),
    { turns: 0, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
  );
  const row = (name: string, t: typeof total, bold = false): ReportLine => ({
    text: fit(
      `  ${truncate(clean(name), 25).padEnd(26)}${String(t.turns).padStart(7)}${n(t.input).padStart(9)}${n(t.cached).padStart(9)}${n(t.output).padStart(9)}${n(t.reasoning).padStart(9)}${cost ? `  $${t.cost.toFixed(2)}` : ''}`,
    ),
    bold,
  });
  for (const r of rows) {
    lines.push(
      row(r.key, {
        turns: r.turns,
        input: r.inputTokens,
        cached: r.cachedInputTokens,
        output: r.outputTokens,
        reasoning: r.reasoningTokens,
        cost: r.costUsd,
      }),
    );
  }
  lines.push(row('total', total, true));
  lines.push(gap, {
    text: fit(
      'Codex counts cached input inside input; Claude Code counts it apart. Cost is Claude Code’s estimate, notional on a subscription.',
    ),
    dim: true,
  });
  return lines;
}
