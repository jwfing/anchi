import type { ConnectorId, ServiceConnectorId, SetupStatus } from '@anchi/protocol';

/**
 * A connector's setup guide. The website redirects it to the documentation (landing/nginx.conf),
 * so the links of an app already installed keep working when the documentation moves.
 */
export function guideUrl(id: ConnectorId | ServiceConnectorId): string {
  return `https://anchi.elseward.xyz/docs/connect/${id}`;
}

/** Where each token typed in Settings comes from, shown above its field. */
export const TOKEN_SOURCE: Record<string, string> = {
  github: 'A fine-grained personal access token: GitHub → Settings → Developer settings.',
  linear: 'A personal API key (lin_api_…): Linear → Settings → Security & access.',
  posthog: 'A personal API key (phx_…): PostHog → Settings → Personal API keys.',
  sentry: 'A user auth token (sntryu_…): Sentry → User settings → Personal Tokens.',
  firecrawl: 'An API key (fc-…) from the Firecrawl dashboard.',
  figma: 'A personal access token (figd_…): Figma → Settings → Security.',
  discord: 'The bot token of your application: Discord Developer Portal → your app → Bot.',
  notion: 'The access token (ntn_…) of an Internal connection in Notion’s developer connections.',
  slack:
    'The Bot User OAuth Token (xoxb-…) of a Slack app you installed: api.slack.com/apps → OAuth & Permissions.',
};

/** A browser sign-in that needs an OAuth app the server does not have yet (imported from the CLI). */
export function needsOAuthApp(id: ServiceConnectorId, status: SetupStatus): boolean {
  if (id === 'gmail' || id === 'drive') return !status.googleClient;
  if (id === 'x') return status.xClient === false;
  if (id === 'reddit') return status.redditClient === false;
  return false;
}
