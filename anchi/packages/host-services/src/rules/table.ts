/**
 * The egress rules, as data: a port of the tables in services/egress_rules.py, which stay the
 * VM's source of truth. scripts/gen-egress-fixtures.py replays the Python rules over a corpus
 * and the tests here check every decision agrees, so a change on either side is caught.
 */

export const PLACEHOLDER_MARK = 'anchi-placeholder';
export const PLACEHOLDER_COMPACT = 'anchiplaceholder';
export const PLACEHOLDER_AWS_KEY = 'AKIAANCHIPLACEHOLDER';
export const CONNECTORS = [
  'github',
  'aws',
  'linear',
  'posthog',
  'sentry',
  'firecrawl',
  'figma',
  'discord',
] as const;
export const RUNTIMES = ['codex', 'claude', 'hermes'] as const;
export const PLACEHOLDER_HERMES = `sk-anchi-placeholder-${'0'.repeat(40)}`;
export const PLACEHOLDER_CLAUDE_OAUTH = `sk-ant-oat01-anchi-placeholder-${'0'.repeat(40)}`;
export const PLACEHOLDER_CLAUDE_KEY = `sk-ant-api03-anchi-placeholder-${'0'.repeat(40)}`;

/** bearer | basic | raw | bot (Discord) | figma | aws_sigv4 | anthropic | none (deny-only) */
export type RuleKind =
  'bearer' | 'basic' | 'raw' | 'bot' | 'figma' | 'aws_sigv4' | 'anthropic' | 'none';

export interface Rule {
  name: string;
  hosts: readonly string[];
  kind: RuleKind;
  /** Connector or runtime that grants this rule; null applies to every session. */
  grant: string | null;
  /** Patterns on the operation (`METHOD /path`, `service:Action`, `graphql:names`). */
  deny: readonly RegExp[];
  /** When set, only matching paths are injected; others pass through untouched. */
  path?: RegExp;
  /** Inject only when the client sent a placeholder, never into an unauthenticated request. */
  replaceOnly?: boolean;
}

const rule = (r: Omit<Rule, 'deny'> & { deny?: readonly RegExp[] }): Rule => ({
  deny: [],
  ...r,
});

export const RULES: readonly Rule[] = [
  // ChatGPT Apps (Codex's codex_apps MCP server) and plugins act on the accounts the user
  // linked in ChatGPT, outside the session's connectors, approvals and audit.
  rule({
    name: 'codex',
    hosts: ['chatgpt.com'],
    kind: 'bearer',
    grant: 'codex',
    replaceOnly: true,
    deny: [/^\S+ \/backend-api\/(ps|plugins|aip|connectors)(\/|$)/],
  }),
  // Token refresh happens on the trusted side; a refresh from a session would return a new
  // credential in the response body.
  rule({
    name: 'openai-auth',
    hosts: ['auth.openai.com'],
    kind: 'none',
    grant: null,
    deny: [/.*/],
  }),
  // Claude Code: a subscription token (Authorization: Bearer) or an API key (x-api-key),
  // whichever the vault holds; organization administration (API key management) is denied.
  rule({
    name: 'anthropic',
    hosts: ['api.anthropic.com'],
    kind: 'anthropic',
    grant: 'claude',
    replaceOnly: true,
    deny: [/^\S+ \/v1\/organizations(\/|$)/],
  }),
  // OAuth token exchange would return a new credential to the session.
  rule({
    name: 'anthropic-auth',
    hosts: ['console.anthropic.com', 'platform.claude.com', 'claude.ai'],
    kind: 'none',
    grant: null,
    deny: [/\/oauth\/token/i],
  }),
  rule({
    name: 'github-api',
    hosts: ['api.github.com'],
    kind: 'bearer',
    grant: 'github',
    deny: [
      /^POST \/user\/keys$/,
      /^POST \/user\/gpg_keys$/,
      /^POST \/user\/ssh_signing_keys$/,
      /^POST \/repos\/[^/]+\/[^/]+\/keys$/,
      /^POST \/app\/installations\/[^/]+\/access_tokens$/,
      /^POST \/applications\/[^/]+\/token/,
      /^POST \/authorizations/,
      /^(GET|PUT|DELETE|POST) \/repos\/[^/]+\/[^/]+\/(actions|codespaces|dependabot)\/secrets/,
      /^(GET|PUT|DELETE|POST) \/orgs\/[^/]+\/(actions|codespaces|dependabot)\/secrets/,
      /^(GET|PUT|DELETE|POST) \/repos\/[^/]+\/[^/]+\/environments\/[^/]+\/secrets/,
      /^(GET|PUT|DELETE|POST) \/user\/codespaces\/secrets/,
    ],
  }),
  rule({
    name: 'github-git',
    hosts: ['github.com'],
    kind: 'basic',
    grant: 'github',
    // Git smart HTTP only; release downloads and web pages pass through.
    path: /^\/[^/]+\/[^/]+?(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/,
  }),
  rule({
    name: 'aws',
    hosts: ['*.amazonaws.com'],
    kind: 'aws_sigv4',
    grant: 'aws',
    deny: [
      /^iam:(?!Get|List|Simulate).*/,
      /^sts:(?!GetCallerIdentity$).*/,
      /^sso:.*/,
      /^sso-oauth:.*/,
      /^signin:.*/,
    ],
  }),
  rule({
    name: 'linear',
    hosts: ['api.linear.app'],
    kind: 'raw',
    grant: 'linear',
    deny: [/\b(apiKeyCreate|apiKeyDelete|oauthClient\w*|oauthToken\w*)\b/],
  }),
  // US and EU Cloud; ingestion (`*.i.posthog.com`) takes the public project key, not this one.
  rule({
    name: 'posthog',
    hosts: ['us.posthog.com', 'eu.posthog.com'],
    kind: 'bearer',
    grant: 'posthog',
    path: /^\/api\//,
    deny: [
      /^\S+ \/api\/personal_api_keys(\/|$)/,
      // Resetting or rotating a project's keys returns the new key.
      /^\S+ \/api\/.*\/(reset_token|rotate_secret_token)\/?$/,
    ],
  }),
  // The API only; event ingestion (`/api/<project>/envelope/`) authenticates with the DSN.
  rule({
    name: 'sentry',
    hosts: ['sentry.io', 'us.sentry.io', 'de.sentry.io'],
    kind: 'bearer',
    grant: 'sentry',
    path: /^\/api\/0\//,
    deny: [
      /^\S+ \/api\/0\/api-tokens(\/|$)/,
      /^\S+ \/api\/0\/organizations\/[^/]+\/org-auth-tokens(\/|$)/,
      /^\S+ \/api\/0\/sentry-apps\/[^/]+\/(api-tokens|rotate-secret)(\/|$)/,
      /^\S+ \/api\/0\/sentry-app-installations\/[^/]+\/authorizations(\/|$)/,
    ],
  }),
  rule({ name: 'firecrawl', hosts: ['api.firecrawl.dev'], kind: 'bearer', grant: 'firecrawl' }),
  rule({ name: 'figma', hosts: ['api.figma.com'], kind: 'figma', grant: 'figma' }),
  // REST only; the gateway (a WebSocket that carries the token in a message) is not supported.
  rule({
    name: 'discord',
    hosts: ['discord.com', 'discordapp.com'],
    kind: 'bot',
    grant: 'discord',
    path: /^\/api\//,
    deny: [
      // Webhook objects carry the webhook's own token: listing, creating or reading one by
      // id returns it. Executing a webhook (`/webhooks/<id>/<token>`) stays possible.
      /^\S+ \/api(\/v\d+)?\/(channels|guilds)\/\d+\/webhooks\/?$/,
      /^\S+ \/api(\/v\d+)?\/webhooks\/\d+\/?$/,
      /^\S+ \/api(\/v\d+)?\/oauth2\/token(\/|$)/,
    ],
  }),
];

export const S3_SUBRESOURCES = [
  'delete',
  'policy',
  'acl',
  'publicAccessBlock',
  'ownershipControls',
  'lifecycle',
  'replication',
  'encryption',
  'versioning',
  'cors',
  'website',
  'notification',
  'object-lock',
  'retention',
  'legal-hold',
] as const;

/** Held for the user's approval for every session: id, rule, pattern on the operation (or on
 * git ref updates), and what the dialog says. The user can disable entries by id. */
export const HIGH_RISK: readonly [string, string, RegExp, string][] = [
  [
    'github-merge',
    'github-api',
    /^PUT \/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/,
    'merge a pull request',
  ],
  ['github-repo-delete', 'github-api', /^DELETE \/repos\/[^/]+\/[^/]+$/, 'delete a repository'],
  [
    'github-repo-settings',
    'github-api',
    /^PATCH \/repos\/[^/]+\/[^/]+$/,
    'change repository settings',
  ],
  [
    'github-repo-transfer',
    'github-api',
    /^POST \/repos\/[^/]+\/[^/]+\/transfer$/,
    'transfer a repository',
  ],
  [
    'github-protection',
    'github-api',
    /^(PUT|POST|PATCH|DELETE) \/repos\/[^/]+\/[^/]+\/(branches\/[^/]+\/protection|rulesets)/,
    'change branch protection',
  ],
  [
    'github-access',
    'github-api',
    /^(PUT|POST|PATCH|DELETE) \/repos\/[^/]+\/[^/]+\/(collaborators|hooks|keys|deployments)/,
    'change repository access or hooks',
  ],
  [
    'github-ref-delete',
    'github-api',
    /^DELETE \/repos\/[^/]+\/[^/]+\/git\/refs\//,
    'delete a branch or tag',
  ],
  [
    'github-graphql',
    'github-api',
    /graphql-mutation:.*\b(mergePullRequest|deleteRepository|updateRepository|(create|update|delete)BranchProtectionRule|(create|update|delete)Ruleset|deleteRef)\b/,
    'a high-risk GitHub mutation',
  ],
  ['git-default-branch', 'github-git', /refs\/heads\/(main|master)$/, 'push to main or master'],
  ['git-ref-delete', 'github-git', /^delete /, 'delete a branch or tag on push'],
  [
    'aws-destroy',
    'aws',
    /^[a-z0-9-]+:(Delete|Terminate|Remove|Revoke|Detach|Disable|ScheduleKeyDeletion|Put\w*Policy)/,
    'delete, terminate or change access to an AWS resource',
  ],
  [
    'aws-s3-delete',
    'aws',
    /^s3:(DELETE |POST \S*\?delete$|PUT \S*\?lifecycle$)/,
    'delete S3 objects or buckets, or set expiry rules',
  ],
  [
    'aws-s3-access',
    'aws',
    /^s3:PUT \S*\?(policy|acl|publicAccessBlock|ownershipControls)$/,
    'change who can access an S3 bucket or object',
  ],
  ['linear-delete', 'linear', /graphql:.*\b\w+(Delete|Archive)\b/, 'delete or archive in Linear'],
  [
    'posthog-delete',
    'posthog',
    /^DELETE \/api\/(organizations|projects|environments)\/[^/]+\/?$/,
    'delete a PostHog organization or project',
  ],
  [
    'posthog-access',
    'posthog',
    /^(POST|PUT|PATCH|DELETE) \/api\/organizations\/[^/]+\/(members|invites)(\/|$)/,
    'change who can access a PostHog organization',
  ],
  [
    'sentry-delete',
    'sentry',
    /^DELETE \/api\/0\/(organizations\/[^/]+|projects\/[^/]+\/[^/]+|teams\/[^/]+\/[^/]+)\/?$/,
    'delete a Sentry organization, project or team',
  ],
  [
    'sentry-access',
    'sentry',
    /^(POST|PUT|PATCH|DELETE) \/api\/0\/organizations\/[^/]+\/(members|invite-requests)(\/|$)/,
    'change who can access a Sentry organization',
  ],
  [
    'figma-webhook',
    'figma',
    /^(POST|PUT) \/v2\/(webhooks|teams\/[^/]+\/webhooks)(\/|$)/,
    'create or change a Figma webhook, which sends future events to a URL',
  ],
  [
    'discord-delete',
    'discord',
    /^DELETE \/api(\/v\d+)?\/(channels|guilds)\/\d+\/?$/,
    'delete a Discord channel or server',
  ],
  [
    'discord-members',
    'discord',
    /^(PUT|PATCH|DELETE) \/api(\/v\d+)?\/guilds\/\d+\/(bans|members)\/\d+/,
    'ban, kick, time out or change roles of Discord members',
  ],
  [
    'discord-access',
    'discord',
    /^((POST|PATCH|PUT|DELETE) \/api(\/v\d+)?\/(guilds\/\d+\/roles|channels\/\d+\/permissions)|PATCH \/api(\/v\d+)?\/(guilds\/\d+|applications\/@me)\/?$)/,
    'change Discord roles, channel permissions, server or bot settings',
  ],
];

export const HIGH_RISK_IDS: readonly string[] = HIGH_RISK.map(([id]) => id);

/** What each grant needs to reach besides a session's own egress list. */
export const BASE_EGRESS: Record<string, readonly string[]> = {
  // Codex fetches files it lists (plugin files, attachments) from OpenAI's content CDN, at
  // links chatgpt.com hands out; chatgpt.com is reachable anyway.
  codex: ['chatgpt.com', '*.chatgpt.com', '*.oaiusercontent.com'],
  claude: ['api.anthropic.com'],
  // Model metadata (context lengths); the endpoint's own host comes from the Hermes rule.
  hermes: ['models.dev'],
  github: ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'],
  aws: ['*.amazonaws.com'],
  linear: ['api.linear.app'],
  posthog: ['us.posthog.com', 'eu.posthog.com'],
  sentry: ['sentry.io', 'us.sentry.io', 'de.sentry.io'],
  firecrawl: ['api.firecrawl.dev'],
  // Rendered images are links to Figma's S3 bucket.
  figma: ['api.figma.com', 'figma-alpha-api.s3.us-west-2.amazonaws.com'],
  discord: ['discord.com', 'cdn.discordapp.com', 'media.discordapp.net'],
};

/** One fixed, read-only identity endpoint per connector, tried in order until one answers. */
export const VERIFY_ENDPOINTS: Record<string, [string, readonly string[], string]> = {
  github: ['GET', ['https://api.github.com/user'], ''],
  linear: ['POST', ['https://api.linear.app/graphql'], '{"query":"{ viewer { email name } }"}'],
  aws: [
    'POST',
    ['https://sts.{region}.amazonaws.com/'],
    'Action=GetCallerIdentity&Version=2011-06-15',
  ],
  // A key belongs to one region's cloud; the other refuses it.
  posthog: [
    'GET',
    ['https://us.posthog.com/api/users/@me/', 'https://eu.posthog.com/api/users/@me/'],
    '',
  ],
  sentry: ['GET', ['https://sentry.io/api/0/organizations/'], ''],
  firecrawl: ['GET', ['https://api.firecrawl.dev/v2/team/credit-usage'], ''],
  figma: ['GET', ['https://api.figma.com/v1/me'], ''],
  discord: ['GET', ['https://discord.com/api/v10/users/@me'], ''],
};
