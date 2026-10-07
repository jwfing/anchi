import type { ResolvedAgent } from '@anchi/core';

export const WORKDIR = '/home/agent/work';

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
    `Your persistent working directory is ${WORKDIR}; files elsewhere are discarded when the task ends.`,
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

/** Instructions for a turn: the agent's own prompt plus the environment note. */
export function instructions(agent: ResolvedAgent): { text: string; mode: 'replace' | 'append' } {
  const own = agent.prompt.text.trim();
  const note = environmentNote(agent);
  return { text: own ? `${own}\n\n${note}` : note, mode: agent.prompt.mode };
}
