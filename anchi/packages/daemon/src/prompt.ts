import { type ResolvedAgent, WORKSPACE_ROOT, workspaceName } from '@anchi/core';

export const WORKDIR = '/home/agent/work';
/** Where the cell manager binds an agent's workspaces (guest/anchi_cell.py). */
export const WORKSPACES_DIR = '/home/agent/workspaces';

const CONNECTOR_NOTES: Record<string, string> = {
  github:
    'GitHub: `git` over HTTPS and `gh` work without login; authentication is added outside your ' +
    'environment. Never ask for or configure tokens, SSH keys or credential helpers.',
  aws:
    'AWS: the AWS CLI and SDKs work with the configured environment; requests are signed outside ' +
    'your environment. Creating keys, sessions or roles is refused.',
  linear:
    'Linear: call the GraphQL API at https://api.linear.app/graphql with ' +
    '`Authorization: $LINEAR_API_KEY`; the real key is added outside your environment.',
};

/** Instructions Anchi adds to every agent: where it runs and what it can reach. */
export function environmentNote(agent: ResolvedAgent): string {
  const lines = [
    '## Environment',
    `You are the Anchi agent "${agent.name}" (@${agent.id}), working in a disposable Linux cell.`,
    `Your persistent working directory is ${WORKDIR}; files elsewhere${agent.workspaces.length ? ' (except in the shared directories below)' : ''} are discarded when the task ends.`,
    ...workspaceLines(agent),
    'Network access goes through an egress proxy. Credentials never enter this cell: environment ' +
      'variables that look like tokens are placeholders, and that is expected.',
  ];
  if (agent.connectors.length) {
    lines.push('Connected services:');
    for (const c of agent.connectors) lines.push(`- ${CONNECTOR_NOTES[c] ?? c}`);
  } else {
    lines.push('No services are connected; authenticated APIs will reject your requests.');
  }
  lines.push(
    'When you finish, reply with a short summary of what you did and include links to anything ' +
      'you created (pull requests, issues, comments).',
  );
  return lines.join('\n');
}

/**
 * Where the user's shared directories are. Without this, an agent told to work in a workspace
 * still finds ${WORKDIR} named as its working directory, and may keep its files there, in the VM,
 * where the user never sees them.
 */
function workspaceLines(agent: ResolvedAgent): string[] {
  if (!agent.workspaces.length) return [];
  const writable = agent.workspaces.some((w) => w.mode === 'rw');
  return [
    `${WORKDIR} stays inside Anchi's VM: the user does not see files there on their computer.`,
    "Directories of the user's computer shared with you:",
    ...agent.workspaces.map(
      (w) =>
        `- ${WORKSPACES_DIR}/${workspaceName(w)}: the user's ${WORKSPACE_ROOT}/${w.path}, ` +
        (w.mode === 'rw'
          ? 'read-write; what you create or change here is on their computer at once.'
          : 'read-only.'),
    ),
    writable
      ? 'Work on the projects and files the user means in these directories, and put repositories ' +
        `you clone or results the user should see in a read-write one, not in ${WORKDIR}.`
      : `Read the user's files there; keep your own work in ${WORKDIR}.`,
    // Every file operation there crosses into the user's computer; a dependency install of
    // thousands of small files took many minutes and stalled the other cells' shared directories.
    'Shared directories are much slower than local disk for many small files. Keep dependencies, ' +
      `virtual environments, caches and build output in ${WORKDIR}: install and build in a clone ` +
      `or worktree there (or point node_modules, .venv or target/ there), and keep the sources ` +
      'you change and the results for the user in the shared directory.',
  ];
}

/** Instructions for a turn: the agent's own prompt plus the environment note. */
export function instructions(agent: ResolvedAgent): { text: string; mode: 'replace' | 'append' } {
  const own = agent.prompt.text.trim();
  const note = environmentNote(agent);
  return { text: own ? `${own}\n\n${note}` : note, mode: agent.prompt.mode };
}
