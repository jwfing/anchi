import type {
  AccessSummary,
  QuotaInfo,
  QuotaWindow,
  TaskAudit,
  UsageGroup,
  UsageRow,
} from '@anchi/protocol';
import { auditHeadline } from '@anchi/daemon';
import { highRiskConnector } from '@anchi/core';
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

/**
 * What the proxy held for the user in a cell: the connectors whose writes wait, high-risk
 * operations, and the agent's high-risk exceptions. An exception of a connector that asks for
 * every write changes nothing, so it is shown as still waiting rather than as an exception.
 */
function writesHeld(r: NonNullable<TaskAudit['registration']>): string {
  const held = r.ask.length ? `${r.ask.join(', ')} and high-risk` : 'high-risk only';
  const skipped = r.highRiskDisabled ?? [];
  const through = skipped.filter((id) => !r.ask.includes(highRiskConnector(id)));
  const asked = skipped.filter((id) => r.ask.includes(highRiskConnector(id)));
  return [
    held,
    through.length ? `, except ${through.map(clean).join(', ')}` : '',
    asked.length ? `; ${asked.map(clean).join(', ')} waits anyway (approvals)` : '',
  ].join('');
}

/** The access report of a task: the headline, the cell's scope, hosts, refusals, then requests. */
export function accessLines(a: TaskAudit, width: number): ReportLine[] {
  const fit = (s: string) => truncate(s, width);
  const other = a.credentialsSent.other ?? 0;
  const lines: ReportLine[] = [
    { text: fit(clean(auditHeadline(a))), color: other ? 'red' : 'green' },
    gap,
  ];
  if (a.savedOnly) {
    lines.push(
      {
        text: fit(
          'The VM could not be read: these are the rows saved when the task’s cells closed.',
        ),
        color: 'yellow',
      },
      gap,
    );
  }
  if (a.registration) {
    const r = a.registration;
    lines.push(
      head(`Cell${a.cells > 1 ? `s (${a.cells}; the last one)` : ''}`),
      { text: fit(`  connectors   ${r.connectors.join(', ') || 'none'}`) },
      { text: fit(`  services     ${r.services.join(', ') || 'none'} (through the bridge)`) },
      { text: fit(`  egress       ${r.egress ? r.egress.join(', ') : 'any public host'}`) },
      { text: fit(`  writes held  ${writesHeld(r)}`) },
      gap,
    );
  }
  if (a.hosts.length) {
    lines.push(head('Hosts requested, and what the proxy decided'));
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

/** Hosts the task's cells were refused by the agent's egress list, in the order first refused. */
export function refusedHosts(a: TaskAudit): string[] {
  return [...new Set(a.refused.filter((r) => r.decision === 'egress-denied').map((r) => r.host))];
}

/** The access screen: what every agent reached over a period, and anything that needs a look. */
export function accessSummaryLines(
  s: AccessSummary | null,
  period: number,
  width: number,
): ReportLine[] {
  const fit = (t: string) => truncate(t, width);
  const lines: ReportLine[] = [head(`External access, ${PERIODS[period]!.label}`)];
  if (!s) return [...lines, { text: '  Loading…', dim: true }];
  if (s.partial) {
    lines.push({
      text: fit('  The VM could not be read: running tasks may be missing their latest requests.'),
      color: 'yellow',
    });
  }
  if (!s.agents.length) {
    return [...lines, { text: '  No external access recorded in this period.', dim: true }];
  }
  const other = s.agents.reduce((n, a) => n + a.credentialsOther, 0);
  lines.push(
    {
      text: fit(
        other
          ? `  Cells sent a credential of their own ${other} time${other === 1 ? '' : 's'}: see below.`
          : `  ${s.tasks} task${s.tasks === 1 ? '' : 's'}; the cells sent only placeholders or no credential.`,
      ),
      color: other ? 'red' : 'green',
    },
    gap,
    head('By agent'),
    {
      text: fit(
        `  ${'agent'.padEnd(16)}${'tasks'.padStart(6)}${'requests'.padStart(10)}${'hosts'.padStart(7)}${'bridge'.padStart(8)}${'refused'.padStart(9)}${'held'.padStart(6)}  injected by the proxy`,
      ),
      dim: true,
    },
  );
  for (const a of s.agents) {
    const injected = Object.entries(a.injected)
      .sort((x, y) => y[1] - x[1])
      .map(([rule, n]) => `${clean(rule)} ${n}`)
      .join(', ');
    lines.push({
      text: fit(
        `  ${truncate(clean(a.agent), 15).padEnd(16)}${String(a.tasks).padStart(6)}${String(a.requests).padStart(10)}${String(a.hosts).padStart(7)}${String(a.services ?? 0).padStart(8)}${String(a.refused).padStart(9)}${String(a.held).padStart(6)}  ${injected || '-'}`,
      ),
      color: a.credentialsOther ? 'red' : undefined,
    });
  }
  if (s.credentials.length) {
    lines.push(gap, head('A credential of the cell’s own'));
    for (const r of s.credentials) {
      lines.push({
        text: fit(
          `  ${new Date(r.ts).toLocaleString()}  @${clean(r.agent)} ${r.task}  ${clean(r.method)} ${clean(r.host)}${clean(r.path)}`,
        ),
        color: 'red',
      });
    }
  }
  lines.push(gap, head('Hosts requested'));
  for (const h of s.hosts) {
    const decisions = Object.entries(h.decisions)
      .map(([d, c]) => `${d} ${c}`)
      .join(', ');
    lines.push({
      text: fit(
        `  ${truncate(clean(h.host), 31).padEnd(32)}${String(h.requests).padStart(6)}  ${decisions}  (${h.agents.map((a) => `@${clean(a)}`).join(' ')})`,
      ),
    });
  }
  // A daemon started before bridge calls were summed up sends none.
  const services = s.services ?? [];
  if (services.length) {
    lines.push(gap, head('Gmail, Drive, Notion and Slack calls (through the bridge)'));
    for (const c of services) {
      const name = `${clean(c.service)} ${clean(c.operation)}${c.account ? ` [${clean(c.account)}]` : ''}`;
      lines.push({
        text: fit(
          `  ${truncate(name, 31).padEnd(32)}${String(c.calls).padStart(6)}  (${c.agents.map((a) => `@${clean(a)}`).join(' ')})`,
        ),
      });
    }
  }
  if (s.refused.length) {
    lines.push(gap, head('Refused or held, latest first'));
    for (const r of s.refused) {
      lines.push({
        text: fit(
          `  ${new Date(r.ts).toLocaleString()}  @${clean(r.agent)}  ${r.decision}  ${clean(r.host)}  ${clean(r.operation || r.path)}`,
        ),
        color: 'yellow',
      });
    }
  }
  lines.push(gap, {
    text: fit(
      'From the egress proxy’s audit rows the daemon keeps with each task; hosts and paths come from the agents. The bridge services reach Google, Notion and Slack themselves, so those hosts are not listed. Press a on a task for its detail.',
    ),
    dim: true,
  });
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
    for (const t of quotaText(q)) {
      const used = /(\d+)% used/.exec(t);
      const pct = used ? Number(used[1]) : 0;
      lines.push({ text: fit(t), color: pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : undefined });
    }
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
