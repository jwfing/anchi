import type { AgentSummary, RuntimeId, SetupAction, SetupStatus, TaskRow } from '@anchi/protocol';

// Where a new user stands, from the daemon's status: shared by the TUI's and the desktop app's
// first-run guides.

export type WelcomeStep = 'environment' | 'vault' | 'runtime' | 'agent' | 'task' | 'done';
export const FIRST_TASK = `Review this small JavaScript function. Identify the bug, show a corrected version, and suggest two tests. Do not access the network or change files.

function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].quantity;
  }
  return sum;
}`;

export function suggestedRuntime(setup: SetupStatus): RuntimeId {
  const runtimes: RuntimeId[] = ['codex', 'claude-code', 'hermes'];
  return (
    runtimes.find((r) => runtimeReady(setup, r)) ??
    (setup.hostLogins?.codex.state === 'ready'
      ? 'codex'
      : setup.hostLogins?.claude.state === 'ready'
        ? 'claude-code'
        : undefined) ??
    setup.preparedRuntimes?.[0] ??
    'codex'
  );
}
export function runtimeReady(setup: SetupStatus, runtime?: string): boolean {
  const codex =
    setup.codex.connected && (setup.codex.expiresAt === null || setup.codex.expiresAt > Date.now());
  const claude = Boolean(
    setup.claude?.connected &&
    (setup.claude.expiresAt == null || setup.claude.expiresAt > Date.now()),
  );
  const hermes = Boolean(setup.hermes?.connected);
  if (runtime === 'codex') return codex;
  if (runtime === 'claude-code') return claude;
  if (runtime === 'hermes') return hermes;
  return codex || claude || hermes;
}
export function welcomeStep(
  setup: SetupStatus,
  agents: AgentSummary[],
  tasks: TaskRow[],
): WelcomeStep {
  if (
    setup.vm !== 'running' ||
    !setup.installed ||
    setup.guestOutdated ||
    setup.host?.missing.length
  )
    return 'environment';
  if (!setup.vaultUnlocked) return 'vault';
  const userAgents = agents.filter((a) => a.id !== 'builder');
  if (
    userAgents.length
      ? !userAgents.some((a) => runtimeReady(setup, a.runtime))
      : !runtimeReady(setup)
  )
    return 'runtime';
  if (!userAgents.length) return 'agent';
  return tasks.some((t) => t.agentId !== 'builder' && t.status === 'done') ? 'done' : 'task';
}
export function nextSetupAction(setup: SetupStatus): SetupAction | undefined {
  if (setup.host?.missing.length) return undefined;
  if (setup.vm === 'stopped') return 'vm-start';
  // Components installed by another Anchi version are updated by the same install step.
  if (setup.vm !== 'running' || !setup.installed || setup.guestOutdated) return 'install';
  if (!setup.vaultUnlocked) return setup.vaultKeyPresent === false ? 'vault-init' : 'vault-unlock';
  return undefined;
}
