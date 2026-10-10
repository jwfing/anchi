import type { AccessSummary, AgentAccess, AuditRow, TaskAudit } from '@anchi/protocol';

/**
 * The external access of one task, from the egress proxy's audit rows: what its cells reached,
 * which requests got credentials, what the cell itself sent as credential, and what was refused
 * or held. The rows are written by the trusted proxy, but hosts and paths come from the agent's
 * requests: clients render them as agent text.
 */

/** Decisions that kept a request from going out (or out with credentials). */
const REFUSED = new Set([
  'deny',
  'egress-denied',
  'blocked-destination',
  'rejected',
  'missing-credential',
]);
const DETAIL_ROWS = 500;

type Row = Record<string, unknown>;

/**
 * A task's rows as the VM has them now, joined with the rows the daemon saved earlier (which
 * the log may have rotated away since). `live` is null when the VM could not be read.
 */
export function mergeAuditRows(
  live: { rows: Row[]; total: number; truncated: boolean } | null,
  saved: Row[],
): { rows: Row[]; total: number; truncated: boolean; savedOnly: boolean } {
  const seen = new Set(saved.map((r) => JSON.stringify(r)));
  const rows = [...saved];
  for (const r of live?.rows ?? []) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  const ts = (r: Row) => (typeof r.ts === 'number' ? r.ts : 0);
  rows.sort((a, b) => ts(a) - ts(b));
  const total = Math.max(live?.total ?? 0, rows.length);
  return { rows, total, truncated: rows.length < total, savedOnly: live === null };
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function summarizeAudit(
  taskId: string,
  raw: { rows: Row[]; total: number; truncated: boolean; savedOnly?: boolean },
  scan: string | null,
): TaskAudit {
  const requests = raw.rows.filter((r) => str(r.method) && str(r.host));
  const injected: Record<string, number> = {};
  const credentials: Record<string, number> = {};
  const hosts = new Map<
    string,
    { host: string; requests: number; injected: number; decisions: Record<string, number> }
  >();
  const refused: AuditRow[] = [];
  const held: { operation: string; host: string; risk: string | null; outcome: string }[] = [];
  let streamed = 0;
  for (const r of requests) {
    const decision = str(r.decision);
    const host = str(r.host);
    const entry = hosts.get(host) ?? { host, requests: 0, injected: 0, decisions: {} };
    entry.requests++;
    entry.decisions[decision] = (entry.decisions[decision] ?? 0) + 1;
    if (decision === 'inject') {
      entry.injected++;
      const rule = str(r.rule) || 'unknown';
      injected[rule] = (injected[rule] ?? 0) + 1;
    }
    hosts.set(host, entry);
    const sent = str(r.client_cred) || 'none';
    credentials[sent] = (credentials[sent] ?? 0) + 1;
    if (decision === 'pass:streamed') streamed++;
    if (REFUSED.has(decision) || decision.startsWith('held-')) refused.push(row(r));
    if (typeof r.approval === 'string') {
      held.push({
        operation: str(r.op),
        host,
        risk: typeof r.risk === 'string' ? r.risk : null,
        outcome: r.approval,
      });
    }
  }
  // Destinations refused before any request (DNS, private addresses, egress lists).
  for (const r of raw.rows) {
    if (!str(r.method) && REFUSED.has(str(r.decision))) refused.push(row(r));
  }
  const bridge = new Map<string, { service: string; operation: string; calls: number }>();
  for (const r of raw.rows.filter((x) => x.event === 'service')) {
    const key = `${str(r.service)} ${str(r.op)}`;
    const b = bridge.get(key) ?? { service: str(r.service), operation: str(r.op), calls: 0 };
    b.calls++;
    bridge.set(key, b);
  }
  const registers = raw.rows.filter((r) => r.event === 'register');
  const last = registers.at(-1);
  return {
    taskId,
    total: raw.total,
    truncated: raw.truncated,
    ...(raw.savedOnly ? { savedOnly: true } : {}),
    cells: registers.length,
    registration: last
      ? {
          connectors: Array.isArray(last.grants) ? last.grants.map(String) : [],
          services: Array.isArray(last.services) ? last.services.map(String) : [],
          egress: Array.isArray(last.egress) ? last.egress.map(String) : null,
          ask: Array.isArray(last.ask) ? last.ask.map(String) : [],
          ...(Array.isArray(last.high_risk_disabled) && last.high_risk_disabled.length
            ? { highRiskDisabled: last.high_risk_disabled.map(String) }
            : {}),
        }
      : null,
    requests: requests.length,
    injected,
    credentialsSent: credentials,
    hosts: [...hosts.values()].sort((a, b) => b.requests - a.requests),
    refused,
    held,
    streamed,
    bridge: [...bridge.values()].sort((a, b) => b.calls - a.calls),
    scan,
    rows: requests.slice(-DETAIL_ROWS).map(row),
  };
}

function row(r: Row): AuditRow {
  return {
    ts: typeof r.ts === 'number' ? r.ts * 1000 : 0,
    method: str(r.method),
    host: str(r.host),
    path: str(r.path),
    operation: str(r.op),
    decision: str(r.decision),
    rule: str(r.rule),
    credential: str(r.client_cred),
    reason: str(r.reason),
  };
}

const LIST_MAX = 50;
const HOSTS_MAX = 30;

/** External access of all tasks in `rows` (audit rows of many tasks), by agent and by host. */
export function summarizeAccess(rows: Row[], since: number, partial: boolean): AccessSummary {
  const agents = new Map<string, AgentAccess & { taskIds: Set<string>; hostSet: Set<string> }>();
  const hosts = new Map<string, AccessSummary['hosts'][number] & { agentSet: Set<string> }>();
  const credentials: AccessSummary['credentials'] = [];
  const refused: AccessSummary['refused'] = [];
  const tasks = new Set<string>();
  for (const r of rows) {
    const agent = str(r.agent);
    const task = str(r.task);
    if (!agent || !task) continue;
    tasks.add(task);
    const a = agents.get(agent) ?? {
      agent,
      tasks: 0,
      requests: 0,
      injected: {},
      credentialsOther: 0,
      refused: 0,
      held: 0,
      hosts: 0,
      taskIds: new Set<string>(),
      hostSet: new Set<string>(),
    };
    agents.set(agent, a);
    a.taskIds.add(task);
    const decision = str(r.decision);
    const isRequest = Boolean(str(r.method) && str(r.host));
    const isRefused = REFUSED.has(decision) || decision.startsWith('held-');
    if (isRefused) {
      a.refused++;
      refused.push({ ...row(r), task, agent });
    }
    if (typeof r.approval === 'string') a.held++;
    if (!isRequest) continue;
    const host = str(r.host);
    a.requests++;
    a.hostSet.add(host);
    if (decision === 'inject') {
      const rule = str(r.rule) || 'unknown';
      a.injected[rule] = (a.injected[rule] ?? 0) + 1;
    }
    if (str(r.client_cred) === 'other') {
      a.credentialsOther++;
      credentials.push({ ...row(r), task, agent });
    }
    const h = hosts.get(host) ?? {
      host,
      requests: 0,
      agents: [],
      decisions: {},
      agentSet: new Set(),
    };
    h.requests++;
    h.agentSet.add(agent);
    h.decisions[decision] = (h.decisions[decision] ?? 0) + 1;
    hosts.set(host, h);
  }
  return {
    since,
    tasks: tasks.size,
    agents: [...agents.values()]
      .map(({ taskIds, hostSet, ...a }) => ({ ...a, tasks: taskIds.size, hosts: hostSet.size }))
      .sort((x, y) => y.requests - x.requests),
    hosts: [...hosts.values()]
      .map(({ agentSet, ...h }) => ({ ...h, agents: [...agentSet].sort() }))
      .sort((x, y) => y.requests - x.requests)
      .slice(0, HOSTS_MAX),
    credentials: credentials.reverse().slice(0, LIST_MAX),
    refused: refused.reverse().slice(0, LIST_MAX),
    partial,
  };
}

/** The one line that says whether the boundary held for this task. */
export function auditHeadline(a: TaskAudit): string {
  const injected = Object.values(a.injected).reduce((x, y) => x + y, 0);
  const other = a.credentialsSent.other ?? 0;
  const parts = [
    `${a.requests} request${a.requests === 1 ? '' : 's'}`,
    `${injected} with credentials injected by the proxy`,
    other
      ? `the cell sent something other than a placeholder ${other} time${other === 1 ? '' : 's'}`
      : 'the cell sent only placeholders or no credential',
  ];
  if (a.refused.length) parts.push(`${a.refused.length} refused or held`);
  if (a.scan) parts.push(a.scan);
  return parts.join('; ');
}
