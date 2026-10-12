/** @jsxRuntime automatic */
import { Box, Text } from 'ink';
import type { AgentSummary, Approval, SetupStatus, StoredEvent, TaskRow } from '@anchi/protocol';
import { sanitize, sanitizeLine } from '../sanitize.ts';
import { truncate, wrap } from './lines.ts';
import { teamActivity, welcomeStep } from './usability.ts';

/** Seconds before the proxy refuses a held write on its own. */
function secondsLeft(a: Approval, now: number): number {
  return Math.max(0, Math.round(a.timeout - (now - a.createdAt) / 1000));
}

/**
 * Every write waiting for the user's decision, with the chosen one's details as the approval
 * dialog shows them. No agent transcript is drawn here, so y, n and Enter act only on what
 * Anchi itself lists.
 */
export function ApprovalsView({
  approvals,
  cursor,
  pick,
  now,
  width,
  height,
  keys,
}: {
  approvals: Approval[];
  cursor: number;
  pick: { id: string; allow: boolean } | null;
  now: number;
  width: number;
  height: number;
  /** The keys as bound: how to select a decision, and the key that confirms it. */
  keys: { select: string; confirm: string };
}) {
  if (!approvals.length) {
    return (
      <Box flexDirection="column" height={height}>
        <Text>No write is waiting for your decision.</Text>
        <Text> </Text>
        {wrap(
          "Writes wait here when an agent's `approvals` setting says ask for a connector, and for " +
            'the listed high-risk operations (merges, pushes to main, deletions, access changes). ' +
            'Each one is refused on its own after the approval timeout.',
          width,
        ).map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  const chosen = approvals[Math.min(cursor, approvals.length - 1)]!;
  const listRoom = Math.max(1, Math.min(approvals.length, Math.floor(height / 4)));
  const first = Math.max(0, Math.min(cursor - listRoom + 1, approvals.length - listRoom));
  const detailRoom = Math.max(1, height - listRoom - 10);
  const summary = sanitize(chosen.summary).split('\n').slice(0, detailRoom);
  const decided = pick && pick.id === chosen.id ? pick : null;
  return (
    <Box flexDirection="column" height={height}>
      <Text>
        {approvals.length} write{approvals.length === 1 ? '' : 's'} waiting for your decision
      </Text>
      <Text> </Text>
      {approvals.slice(first, first + listRoom).map((a, i) => {
        const selected = first + i === cursor;
        const mark = pick?.id === a.id ? ` → ${pick.allow ? 'approve' : 'deny'}` : '';
        return (
          <Text key={a.id} inverse={selected} wrap="truncate">
            {truncate(
              `${selected ? '› ' : '  '}@${sanitizeLine(a.agent)} · ${sanitizeLine(a.connector)} · ${sanitizeLine(a.operation)} · ${secondsLeft(a, now)} s${mark}`,
              width,
            )}
          </Text>
        );
      })}
      <Text> </Text>
      <Text bold color="red">
        Approve a write by @{sanitizeLine(chosen.agent)}?
      </Text>
      {chosen.reason ? (
        <Text color="yellow">{`why        ${sanitizeLine(chosen.reason)}`}</Text>
      ) : null}
      <Text wrap="truncate">{`started by ${sanitizeLine(chosen.origin || chosen.task)}`}</Text>
      <Text>{`connector  ${sanitizeLine(chosen.connector)} (${sanitizeLine(chosen.host)})`}</Text>
      <Text wrap="truncate">{`operation  ${sanitizeLine(chosen.operation)}`}</Text>
      <Text dimColor>{`refused automatically in about ${secondsLeft(chosen, now)} s`}</Text>
      <Box flexDirection="column" height={detailRoom}>
        {summary.map((l, i) => (
          <Text key={i} wrap="truncate">
            {truncate(l, Math.max(10, width)) || ' '}
          </Text>
        ))}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>The content above comes from the agent. This view is drawn by Anchi.</Text>
      <Text bold>
        {decided
          ? `${decided.allow ? 'Approve' : 'Deny'} selected · ${keys.confirm} · y / n to change`
          : keys.select}
      </Text>
    </Box>
  );
}

export function WelcomeView({
  setup,
  agents,
  tasks,
  width,
  height,
  scroll,
  busy,
  nextKey,
}: {
  setup: SetupStatus | null;
  agents: AgentSummary[];
  tasks: TaskRow[];
  width: number;
  height: number;
  scroll: number;
  busy: string;
  nextKey: string;
}) {
  if (!setup) return <Text>Checking your environment…</Text>;
  const step = welcomeStep(setup, agents, tasks);
  const steps = ['environment', 'vault', 'runtime', 'agent', 'task'] as const;
  const labels = [
    'Prepare local environment',
    'Set up your credentials',
    'Connect a runtime',
    'Create your first agent',
    'Complete your first task',
  ];
  const at = step === 'done' ? steps.length : steps.indexOf(step);
  const lines = [
    'Welcome to Anchi',
    '',
    '✓ Anchi installed',
    ...labels.map((label, i) => `${i < at ? '✓' : i === at ? '→' : '○'} ${label}`),
    '',
  ];
  if (busy) lines.push(busy, 'You can leave this screen; installation keeps running.');
  else if (step === 'environment') {
    if (setup.host?.missing.length)
      lines.push(
        `Missing: ${setup.host.missing.join(', ')}`,
        setup.host.installHint,
        'Install these prerequisites, then press Enter to check again.',
      );
    else if (setup.vm === 'running' && setup.error)
      lines.push(
        `The VM runs but could not be asked: ${sanitizeLine(setup.error)}`,
        `r check again · ${nextKey} reinstall its components if it keeps failing (agents and credentials are kept)`,
      );
    else if (setup.vm === 'running' && setup.guestOutdated)
      lines.push(
        `The VM's components were installed by Anchi ${setup.guestVersion ?? 'an older release'}; this is Anchi ${setup.appVersion ?? 'a newer release'}.`,
        'Update them before running tasks (it refuses while task cells are live).',
        `${nextKey} update · your agents and credentials are kept`,
      );
    else
      lines.push(
        setup.vm === 'stopped'
          ? 'Start your existing VM to continue.'
          : 'Prepare the VM and agent image. First installation can take up to half an hour.',
        `${nextKey} continue · completed steps are detected automatically`,
      );
  } else if (step === 'vault')
    lines.push(
      setup.vaultKeyPresent === false
        ? 'Initialize the vault. Keep a backup of ~/.config/anchi/vault.key.'
        : 'Unlock the vault for this VM session.',
      `${nextKey} continue`,
    );
  else if (step === 'runtime')
    lines.push(
      'Connect one runtime:',
      '[i] Codex — run codex login on this computer, then import it.',
      '[c] Claude Code — run claude setup-token, then paste the token.',
      '[h] Hermes — an OpenAI-compatible endpoint, its API key and a model.',
      agents.some((a) => a.id !== 'builder')
        ? 'Connect the runtime used by your agent.'
        : 'Agent builder uses the first one connected (Codex, then Claude Code, then Hermes); builderRuntime in ~/.anchi/settings.yaml picks one.',
    );
  else if (step === 'agent')
    lines.push(
      'Create a starter using your connected runtime; review its YAML before saving.',
      'No model call, connectors or shared folders are needed to create it.',
      `${nextKey} create a starter agent`,
      'Agent builder is also available for custom roles using a connected runtime.',
    );
  else if (step === 'task')
    lines.push(
      'Give your agent a small first task, for example:',
      '“Explain what tools you have access to. Do not change anything.”',
      `${nextKey} open your agent`,
    );
  else lines.push('Your team is ready.', `${nextKey} open the team overview`);
  const wrapped = lines.flatMap((line) => wrap(line, width));
  const start = Math.min(scroll, Math.max(0, wrapped.length - height));
  return (
    <Box flexDirection="column" height={height}>
      {wrapped.slice(start, start + height).map((line, i) => (
        <Text
          key={i}
          color={line.startsWith('→') ? 'cyan' : line.startsWith('✓') ? 'green' : undefined}
        >
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}

export function TeamView({
  agents,
  tasks,
  approvals,
  logs,
  cursor,
  height,
  hints = 'Open Getting started or Agent builder.',
}: {
  agents: AgentSummary[];
  tasks: TaskRow[];
  approvals: Approval[];
  logs: Record<string, StoredEvent[]>;
  cursor: number;
  height: number;
  /** Where to go without agents, with the keys as bound. */
  hints?: string;
}) {
  const room = Math.max(1, Math.floor((height - 3) / 3));
  const first = Math.max(0, cursor - room + 1);
  return (
    <Box flexDirection="column" height={height}>
      <Text>
        {tasks.filter((t) => t.status === 'running').length} running ·{' '}
        {tasks.filter((t) => t.status === 'queued').length} queued · {approvals.length} waiting for
        approval
      </Text>
      <Text> </Text>
      {!agents.length ? (
        <Text>{`No agents yet. ${hints}`}</Text>
      ) : (
        agents.slice(first, first + room).map((agent, i) => {
          const task = tasks.find(
            (t) => t.agentId === agent.id && ['running', 'queued'].includes(t.status),
          );
          return (
            <Box key={agent.id} flexDirection="column">
              <Text inverse={first + i === cursor} wrap="truncate">
                {first + i === cursor ? '› ' : '  '}@{agent.id} · {sanitizeLine(agent.name)}
              </Text>
              <Text wrap="truncate">
                {' '}
                {teamActivity(agent, tasks, approvals, task ? logs[task.id] : [])}
              </Text>
              <Text> </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
