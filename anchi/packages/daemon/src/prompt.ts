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
  posthog:
    'PostHog: call the API at https://us.posthog.com/api/ (or https://eu.posthog.com/api/ for ' +
    'an EU account) with `Authorization: Bearer $POSTHOG_PERSONAL_API_KEY`; the real key is ' +
    'added outside your environment. Managing API keys is refused.',
  sentry:
    'Sentry: call the API at https://sentry.io/api/0/ with ' +
    '`Authorization: Bearer $SENTRY_AUTH_TOKEN` (sentry-cli reads it too); the real token is ' +
    'added outside your environment. Creating tokens is refused.',
  firecrawl:
    'Firecrawl: call the API at https://api.firecrawl.dev with ' +
    '`Authorization: Bearer $FIRECRAWL_API_KEY`; the real key is added outside your environment.',
  figma:
    'Figma: call the REST API at https://api.figma.com with ' +
    '`X-Figma-Token: $FIGMA_ACCESS_TOKEN`; the real token is added outside your environment.',
  discord:
    'Discord: call the REST API at https://discord.com/api/v10 with ' +
    '`Authorization: Bot $DISCORD_BOT_TOKEN`; the real token is added outside your environment. ' +
    'The gateway (WebSocket) does not work, and listing or creating webhooks is refused.',
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
