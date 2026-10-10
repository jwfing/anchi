import type {
  AgentSummary,
  Approval,
  SetupAction,
  SetupStatus,
  StoredEvent,
  TaskRow,
} from '@anchi/protocol';
import { sanitize, sanitizeLine } from '../sanitize.ts';
import { summarizeInput, wrap, type Line } from './lines.ts';

export type WelcomeStep = 'environment' | 'vault' | 'runtime' | 'agent' | 'task' | 'done';
export function runtimeReady(setup: SetupStatus, runtime?: string): boolean {
  const codex =
    setup.codex.connected && (setup.codex.expiresAt === null || setup.codex.expiresAt > Date.now());
  const claude = Boolean(setup.claude?.connected);
  return runtime === 'codex' ? codex : runtime === 'claude-code' ? claude : codex || claude;
}
export function welcomeStep(
  setup: SetupStatus,
  agents: AgentSummary[],
  tasks: TaskRow[],
): WelcomeStep {
  if (setup.vm !== 'running' || !setup.installed || setup.host?.missing.length)
    return 'environment';
  if (!setup.vaultUnlocked) return 'vault';
  if (!runtimeReady(setup, agents.some((a) => a.id !== 'builder') ? undefined : 'codex'))
    return 'runtime';
  if (!agents.some((a) => a.id !== 'builder')) return 'agent';
  return tasks.some((t) => t.agentId !== 'builder' && t.status === 'done') ? 'done' : 'task';
}
export function nextSetupAction(setup: SetupStatus): SetupAction | undefined {
  if (setup.host?.missing.length) return undefined;
  if (setup.vm === 'stopped') return 'vm-start';
  if (setup.vm !== 'running' || !setup.installed) return 'install';
  if (!setup.vaultUnlocked) return setup.vaultKeyPresent === false ? 'vault-init' : 'vault-unlock';
  return undefined;
}
export interface Recovery {
  title: string;
  explanation: string;
  label: string;
  action: 'setup' | 'codex' | 'claude' | 'access' | 'retry' | 'refresh';
}
export function recoveryFor(message: string): Recovery {
  if (/vault|master key|vault.key/i.test(message))
    return {
      title: 'Unlock your credentials',
      explanation:
        'Initialize or unlock the vault in Getting started. If encrypted accounts already exist, restore the original key; never replace it.',
      label: 'Open setup',
      action: 'setup',
    };
  if (/codex|token expired/i.test(message))
    return {
      title: 'Reconnect Codex',
      explanation:
        'Run codex login on this computer, then import the refreshed login. Your draft is kept.',
      label: 'Import Codex login',
      action: 'codex',
    };
  if (/claude|anthropic/i.test(message))
    return {
      title: 'Reconnect Claude Code',
      explanation:
        'Run claude setup-token on this computer, then paste the token into the protected connection screen.',
      label: 'Connect Claude Code',
      action: 'claude',
    };
  if (/egress|refused host|host.*denied/i.test(message))
    return {
      title: 'Review network access',
      explanation:
        'Inspect the task access report and explicitly review any host you want to allow.',
      label: 'Review access',
      action: 'access',
    };
  if (/vm|guest|base.image|lima|limactl|python|qemu|kvm|not installed|ENOENT/i.test(message))
    return {
      title: 'Prepare the local environment',
      explanation:
        'Getting started checks prerequisites and resumes environment setup. Your agents and credentials are kept.',
      label: 'Open setup',
      action: 'setup',
    };
  return {
    title: 'The operation did not finish',
    explanation:
      'Your draft is kept. Check the task status before retrying: a connection failure does not prove the request was rejected.',
    label: 'Check task status',
    action: 'refresh',
  };
}
export function setupPhase(action: SetupAction, line: string): string {
  if (action === 'vault-init') return 'Initializing the vault';
  if (action === 'vault-unlock') return 'Unlocking credentials';
  if (action === 'vm-start') return 'Starting the VM';
  if (/anchi-image|base image|rootfs|debootstrap/i.test(line)) return 'Building the agent image';
  if (/install-anchi|bootstrap|trusted|egress|services/i.test(line)) return 'Installing services';
  if (/download|fetch|pulling/i.test(line)) return 'Downloading runtime components';
  return action === 'workspaces' ? 'Sharing workspaces' : 'Preparing the VM';
}
export function teamActivity(
  agent: AgentSummary,
  tasks: TaskRow[],
  approvals: Approval[],
  events: StoredEvent[] = [],
): string {
  const held = approvals.filter((a) => a.agent === agent.id);
  if (held.length) return `Waiting for your approval (${held.length})`;
  const task = tasks.find(
    (t) => t.agentId === agent.id && ['running', 'queued'].includes(t.status),
  );
  if (!task) {
    const last = tasks.find((t) => t.agentId === agent.id);
    return agent.error
      ? `Needs attention: ${sanitizeLine(agent.error)}`
      : last?.status === 'failed'
        ? `Failed: ${sanitizeLine(last.title)}`
        : last?.status === 'done'
          ? `Completed: ${sanitizeLine(last.title)}`
          : 'Ready for a task';
  }
  const children = tasks.filter(
    (t) => t.parentId === task.id && ['running', 'queued'].includes(t.status),
  );
  if (children.length)
    return `Delegated work in progress: ${children.map((t) => '@' + t.agentId).join(', ')}`;
  if (task.status === 'queued') return `Queued: ${sanitizeLine(task.title)}`;
  const pending = new Map<string, { name: string; input: string }>();
  for (const { event } of events) {
    if (event.type === 'tool.call') pending.set(event.id, event);
    if (event.type === 'tool.result') pending.delete(event.id);
  }
  const tool = [...pending.values()].at(-1);
  return tool
    ? `${sanitizeLine(tool.name)}: ${summarizeInput(tool.input)}`
    : `Working: ${sanitizeLine(task.title)}`;
}
export function resultLines(task: TaskRow, width: number, tasks: TaskRow[]): Line[] {
  const result: Line[] = [];
  const add = (text: string, tone: Line['tone']) => {
    for (const line of wrap(sanitize(text), width)) result.push({ text: line, tone });
  };
  add(
    task.status === 'done'
      ? 'Result'
      : task.status === 'failed'
        ? 'Needs attention'
        : 'Task stopped',
    task.status === 'failed' ? 'error' : 'system',
  );
  // Keep the complete result (including any next steps), with its original line breaks.
  add(task.result || 'No result was returned.', task.status === 'failed' ? 'error' : 'assistant');
  if (task.links.length) {
    add('Artifacts and links', 'system');
    for (const link of task.links) add(sanitizeLine(link), 'assistant');
  }
  const children = tasks.filter((t) => t.parentId === task.id);
  if (children.length) {
    add('Delegated work', 'system');
    for (const child of children)
      add(`@${child.agentId}: ${child.status} · ${sanitizeLine(child.title)}`, 'dim');
  }
  return result;
}
