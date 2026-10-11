/** @jsxRuntime automatic */
import { Box, Text } from 'ink';
import type { AgentSummary, Approval, SetupStatus, StoredEvent, TaskRow } from '@anchi/protocol';
import { sanitizeLine } from '../sanitize.ts';
import { wrap } from './lines.ts';
import { teamActivity, welcomeStep } from './usability.ts';

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
    'Connect Codex or Claude Code',
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
    else
      lines.push(
        setup.vm === 'stopped'
          ? 'Start your existing VM to continue.'
          : 'Prepare the VM and agent image. This can take several minutes.',
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
      'Choose one runtime:',
      '[i] Codex — run codex login on this computer, then import it.',
      '[c] Claude Code — run claude setup-token, then paste the token.',
      agents.some((a) => a.id !== 'builder')
        ? 'Connect the runtime used by your agent.'
        : 'Agent builder currently requires Codex to create your first agent.',
    );
  else if (step === 'agent')
    lines.push(
      'Describe a role to Agent builder, then review and save its proposal.',
      `${nextKey} open Agent builder`,
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
}: {
  agents: AgentSummary[];
  tasks: TaskRow[];
  approvals: Approval[];
  logs: Record<string, StoredEvent[]>;
  cursor: number;
  height: number;
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
        <Text>No agents yet. Open Getting started or Agent builder.</Text>
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
