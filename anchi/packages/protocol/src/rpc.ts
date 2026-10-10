import type { RuntimeEvent } from './events.ts';

/**
 * Daemon ⇄ client (TUI, CLI): JSON-RPC over the daemon's Unix socket, mode 0600 in the
 * user's Anchi home. Request `{id, method, params}`, response `{id, result}` or
 * `{id, error: {message}}`, notification `{method, params}`.
 */

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskRow {
  id: string;
  agentId: string;
  /** What started the task: `user`, `delegation`, `schedule` or `poll`. */
  trigger: string;
  title: string;
  status: TaskStatus;
  /** Runtime thread, once the first turn has started. */
  resumeId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Final message of the last turn, or the error. Agent-originated text. */
  result: string | null;
  /** URLs found in the result, for the task list. */
  links: string[];
  /** Delegation: the task that started this one, the root of its tree and its depth (root 0). */
  parentId: string | null;
  rootId: string;
  depth: number;
  /** Turns run and model tokens used, summed over the task's turns. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

/** Task search: every field narrows the result. */
export interface TaskQuery {
  agentId?: string;
  status?: TaskStatus;
  /** Words found in the title or the result. */
  text?: string;
  /** Created at or after / before (ms since the epoch). */
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface StoredEvent {
  seq: number;
  ts: number;
  event: RuntimeEvent;
}

export type AgentStatus = 'idle' | 'working' | 'error';

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  runtime?: string;
  model?: string;
  image?: string;
  connectors: string[];
  sandbox?: string;
  status: AgentStatus;
  /** Turns running now, up to `maxTasks`. */
  running: number;
  /** Turns waiting for one of the agent's `maxTasks` slots. */
  queued: number;
  /** How many of the agent's tasks run at the same time. */
  maxTasks: number;
  /** Directories of the Mac bound into the agent's cells, as `name (ro|rw)`. */
  workspaces?: string[];
  /** Number of schedule and polling triggers. */
  triggers?: number;
  delegates?: string[];
  skills?: string[];
  /** Configuration error; the agent cannot run until it is fixed. */
  error?: string;
  file: string;
}

export type ConnectorId = 'github' | 'aws' | 'linear';

export interface ConnectorStatus {
  id: ConnectorId;
  connected: boolean;
  /** Non-secret label, such as the GitHub login or AWS account id. */
  account: string | null;
  /** AWS only: the host profile whose temporary credentials the daemon keeps refreshed. */
  profile?: string | null;
}

/**
 * Setup steps the daemon runs for the user, each a fixed host command from the checkout:
 * `vm-start` starts the existing VM; `install` creates or updates the VM, installs the trusted
 * services and the agent team, and builds the base image; `vault-init` and `vault-unlock` use
 * the host-held vault key (read by `scripts/vault.py`, never by the daemon).
 */
export type SetupAction = 'vm-start' | 'install' | 'vault-init' | 'vault-unlock' | 'workspaces';
export const SETUP_ACTIONS: readonly SetupAction[] = [
  'vm-start',
  'install',
  'vault-init',
  'vault-unlock',
  'workspaces',
];

export interface RuntimeAccountStatus {
  runtime: 'codex';
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
}

/** Claude Code credential in the vault: a subscription token or an API key. */
export interface ClaudeAccountStatus {
  runtime: 'claude-code';
  connected: boolean;
  kind: 'oauth' | 'api_key' | null;
}

/** Connectors served by trusted services in the VM (formerly set up in the desktop app). */
export type ServiceConnectorId = 'gmail' | 'drive' | 'notion' | 'slack';

/** A named Google account of Gmail or Drive (`default` unless the user named it). */
export interface ServiceAccountStatus {
  /** Slug agents refer to in `accounts: {gmail: work}`. */
  name: string;
  connected: boolean;
  /** Label the service reported, such as the email address. */
  account: string | null;
  reauthRequired: boolean;
  /** Disconnected, but Google has not confirmed the revocation; disconnect again to retry. */
  revocationPending: boolean;
}

export interface ServiceConnectorStatus {
  id: ServiceConnectorId;
  /** Any account connected. */
  connected: boolean;
  /** The default account's label, else the first connected account's. */
  account: string | null;
  /** Google: the refresh token stopped working; sign in again. */
  reauthRequired: boolean;
  /** `ask`: every write waits for approval. */
  mode: 'auto' | 'ask';
  /** Gmail and Drive: their accounts, by name; empty for Notion and Slack. */
  accounts: ServiceAccountStatus[];
}

/** `user`: imported by the user (takes precedence); `builtin`: shipped with Anchi. */
export type GoogleClientSource = 'user' | 'builtin' | null;

/** What `setup.reset` deletes; `--all` (CLI only) also deletes the vault key and Anchi home. */
export interface ResetPreview {
  vm: SetupStatus['vm'];
  /** Running or queued tasks; reset refuses while there are any. */
  busy: number;
  /** Live (idle) cells; closed first. */
  cells: number;
  home: string;
  vaultKey: string;
}

export interface SetupStatus {
  /** Host-only readiness; optional for clients connected to an older daemon. */
  vaultKeyPresent?: boolean;
  host?: { platform: string; missing: string[]; installHint: string };
  vm: 'missing' | 'stopped' | 'running' | 'unknown';
  vaultUnlocked: boolean;
  installed: boolean;
  codex: RuntimeAccountStatus;
  claude: ClaudeAccountStatus;
  connectors: ConnectorStatus[];
  services: ServiceConnectorStatus[];
  /** Whether a Google OAuth client is available (needed for Gmail and Drive). */
  googleClient: boolean;
  /** Where that client comes from; optional for clients connected to an older daemon. */
  googleClientSource?: GoogleClientSource;
  /** Whether ~/AnchiWorkspaces is mounted in the VM (agent `workspaces`). */
  workspaces: boolean;
}

/** Secret-bearing connector input. Values travel only daemon → guest stdin → vault. */
export type ConnectorSecret =
  | { id: 'github'; token: string }
  | { id: 'linear'; token: string }
  | {
      id: 'aws';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      region: string;
    };

/**
 * A write held by the egress proxy until the user decides (agent `approvals: {x: ask}`).
 * `summary` shows what would be written: git refs, or the start of the request body. It is
 * agent-originated text.
 */
export interface Approval {
  id: string;
  /** `proxy`: a held HTTP write. `policy`: a connector service write (Gmail, Drive, Notion, Slack). */
  kind: 'proxy' | 'policy';
  task: string;
  agent: string;
  connector: string;
  operation: string;
  host: string;
  summary: string;
  createdAt: number;
  /** Seconds after `createdAt` when the proxy refuses the write. */
  timeout: number;
  /** Why it is held: a high-risk operation (held for every agent) or the agent's settings. */
  reason: string;
  /** How the task came to exist: the user, a trigger, and the delegation chain. */
  origin: string;
}

/** A schedule or polling trigger of an agent, with when it last and next runs. */
export interface TriggerInfo {
  agentId: string;
  key: string;
  kind: 'schedule' | 'poll';
  spec: string;
  nextRun: number | null;
  lastRun: number | null;
  lastResult: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** `local`, or the GitHub URL it was fetched from. */
  source: string;
  /** The commit a GitHub skill was fetched at. */
  commit: string | null;
}

export interface BuilderProposal {
  id: string;
  agentId: string;
  /**
   * `create`: a new agent; `replace`: a whole new file for an existing agent; `update`: a
   * settings patch to an existing agent's file (the rest of the file, comments included, stays).
   */
  kind: 'create' | 'replace' | 'update';
  /** Candidate agent YAML and image recipe, exactly as they would be written. */
  agentYaml: string;
  imageYaml: string | null;
  /** Unified diffs against the current files ('' for new files). */
  agentDiff: string;
  imageDiff: string;
  /** Problems that block applying; empty when the proposal is valid. */
  errors: string[];
  /** Worth knowing but not blocking, such as a connector that is not connected yet. */
  warnings: string[];
  /** For `update`: the patch, and the digest of the file it was made against. */
  patch?: AgentPatch;
  base?: string;
}

/** A directory of ~/AnchiWorkspaces bound into an agent's cells. */
export interface WorkspaceSetting {
  path: string;
  mode: 'ro' | 'rw';
  name?: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * The settings the agent settings panel edits; omitted fields stay as they are. An empty
 * description, model or effort removes the key (the template's value or the runtime default).
 */
export interface AgentPatch {
  name?: string;
  description?: string;
  runtime?: 'codex' | 'claude-code';
  model?: string;
  effort?: Effort | '';
  prompt?: { mode?: 'append' | 'replace'; text?: string };
  skills?: string[];
  connectors?: string[];
  workspaces?: WorkspaceSetting[];
}

/** An agent's editable settings, as resolved (templates included). */
export interface AgentSettingValues {
  name: string;
  description: string;
  runtime: 'codex' | 'claude-code';
  /** '' for the runtime default. */
  model: string;
  effort: Effort | '';
  prompt: { mode: 'append' | 'replace'; text: string };
  skills: string[];
  connectors: string[];
  workspaces: WorkspaceSetting[];
}

/** Settings the panel shows but does not edit (they are changed in the agent file). */
export interface FixedSettings {
  /** The template the agent extends. */
  extends?: string;
  /** Set when the agent's own file takes its prompt from a file: the prompt is read-only. */
  promptFile?: string;
  image: string;
  sandbox: string;
  delegates: string[];
  /** One line per trigger. */
  triggers: string[];
  approvals: Record<string, string>;
  /** High-risk operations that do not wait for approval for this agent, by id. */
  highRisk?: string[];
  /** null: any public host. */
  egress: string[] | null;
  /** Named Google accounts of gmail and drive (`default` when absent). */
  accounts?: Record<string, string>;
}

/** What can be given to agents now. */
export interface Inventory {
  skills: { id: string; name: string; description: string }[];
  /** `connected` is null when the VM could not be asked. */
  connectors: {
    id: string;
    connected: boolean | null;
    /** Gmail and Drive: names of the connected accounts, for an agent's `accounts:`. */
    accounts?: string[];
  }[];
  /** Runtimes an agent can run on; `connected` is null when the VM could not be asked. */
  runtimes: { id: 'codex' | 'claude-code'; connected: boolean | null }[];
  /** Directories under ~/AnchiWorkspaces (two levels); `shared` once the VM mounts it. */
  workspaces: { shared: boolean | null; dirs: string[] };
  agents: string[];
  images: string[];
}

/** An agent's (or a builder proposal's) current settings and what is available. */
export interface AgentSettings {
  agentId: string;
  /** False for the built-in builder, or an agent whose file cannot be edited. */
  editable: boolean;
  reason?: string;
  current: AgentSettingValues;
  /** Fields of `current` whose value comes from the template, not the agent's own file. */
  inherited: (keyof AgentSettingValues)[];
  fixed: FixedSettings;
  inventory: Inventory;
}

/** The change `agents.update` makes (or made) to the agent file. */
export interface AgentUpdate {
  diff: string;
  errors: string[];
  warnings: string[];
  /** Digest of the file the diff was made against; `apply` requires it unchanged. */
  base: string;
  applied: boolean;
}

/** One request the egress proxy saw for a task. Host and path are agent-originated text. */
export interface AuditRow {
  ts: number;
  method: string;
  host: string;
  path: string;
  operation: string;
  /** `inject`, `pass`, `deny`, `held-denied`, `egress-denied`, `pass:streamed`, … */
  decision: string;
  rule: string;
  /** What the cell sent as credential: `placeholder`, `none` or `other`. */
  credential: string;
  reason: string;
}

/** A task's external access, from the egress proxy's audit log. */
export interface TaskAudit {
  taskId: string;
  /** Rows of the task known (in the VM's log or saved by the daemon), and whether only the latest are here. */
  total: number;
  truncated: boolean;
  /** The VM could not be read: only the rows the daemon saved earlier are here. */
  savedOnly?: boolean;
  /** Cells the task ran in, and the last one's registration. */
  cells: number;
  registration: {
    connectors: string[];
    services: string[];
    egress: string[] | null;
    ask: string[];
    /** High-risk entries that did not wait for approval for this agent. */
    highRiskDisabled?: string[];
  } | null;
  requests: number;
  /** Requests whose credentials the proxy injected, by rule. */
  injected: Record<string, number>;
  /** What the cell itself sent as credential, counted. */
  credentialsSent: Record<string, number>;
  hosts: { host: string; requests: number; injected: number; decisions: Record<string, number> }[];
  refused: AuditRow[];
  held: { operation: string; host: string; risk: string | null; outcome: string }[];
  /** Large requests that left without credentials (see the proxy's streaming limit). */
  streamed: number;
  /** Calls to Gmail, Drive, Notion and Slack through the bridge. */
  bridge: { service: string; operation: string; calls: number }[];
  /** The credential scan before the cell closed, as noted in the task. */
  scan: string | null;
  /** The latest request rows. */
  rows: AuditRow[];
}

/** The latest quota information a runtime's responses carried, read by the egress proxy. */
/** One agent's external access over a period, across its tasks. */
export interface AgentAccess {
  agent: string;
  tasks: number;
  requests: number;
  /** Requests whose credentials the proxy injected, by rule. */
  injected: Record<string, number>;
  /** Requests where the cell sent a credential of its own (not a placeholder). */
  credentialsOther: number;
  refused: number;
  held: number;
  hosts: number;
  /** Calls to Gmail, Drive, Notion and Slack through the bridge. */
  services: number;
}

/** External access of all tasks over a period, from the audit rows the daemon has. */
export interface AccessSummary {
  since: number;
  tasks: number;
  agents: AgentAccess[];
  /** The hosts most requested, with the agents that requested them (agent-originated). */
  hosts: { host: string; requests: number; agents: string[]; decisions: Record<string, number> }[];
  /**
   * Calls to Gmail, Drive, Notion and Slack through the bridge, with the Google account the
   * bridge pinned. The services reach their providers themselves, so these hosts are not above.
   */
  services: {
    service: string;
    operation: string;
    account: string | null;
    calls: number;
    agents: string[];
  }[];
  /** Requests where a cell sent a credential of its own, latest first. */
  credentials: (AuditRow & { task: string; agent: string })[];
  /** Refusals and held writes, latest first. */
  refused: (AuditRow & { task: string; agent: string })[];
  /** Some running tasks' rows could not be read from the VM. */
  partial: boolean;
}

/** A usage window of a subscription plan, as the provider reported it. */
export interface QuotaWindow {
  /** `primary` (Codex: 5 hours) or `secondary` (Codex: a week). */
  name: string;
  usedPercent: number | null;
  windowMinutes: number | null;
  /** When the window resets, in ms. */
  resetAt: number | null;
}

/** The latest limits of a runtime's subscription, as the egress proxy last saw them. */
export interface QuotaInfo {
  runtime: string;
  ts: number;
  status: number;
  /** Rate-limit headers of the responses (Claude Code). */
  headers: Record<string, string>;
  /** Codex: the plan and its windows, from the rate-limit message of the model stream. */
  plan?: string | null;
  limited?: boolean;
  windows?: QuotaWindow[];
}

export type UsageGroup = 'agent' | 'runtime' | 'model' | 'day';

/** Token totals of one group. Input follows the runtime: Codex's includes cached input. */
export interface UsageRow {
  key: string;
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** As the runtime estimates it (Claude Code); notional on a subscription. */
  costUsd: number;
}

/** What deleting an agent deletes and changes, for the confirmation dialog. */
export interface AgentDeletionPreview {
  agentId: string;
  /** Whether the agent file exists (false: only leftovers remain). */
  exists: boolean;
  /** The agent's tasks, and tasks of other agents in their delegation trees. */
  tasks: number;
  delegated: number;
  /** Running or queued among them; cancelled first. */
  running: number;
  /** Agents whose `delegates` list it; it is removed from them. */
  delegatedBy: string[];
  triggers: number;
  /** Its workspaces: directories of the Mac, left as they are. */
  workspaces: string[];
}

export interface AgentDeletion {
  agentId: string;
  deletedTasks: number;
  editedAgents: string[];
  /** What the VM removed; null when it could not be reached (run the deletion again). */
  vm: { home: boolean; skills: boolean; policy: string[] } | null;
  warnings: string[];
}

/** What updating a GitHub skill to the latest commit of its ref would change. */
export interface SkillUpdate {
  id: string;
  url: string;
  current: string | null;
  latest: string;
  upToDate: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface DaemonStatus {
  pid: number;
  home: string;
  startedAt: number;
  clients: number;
  cells: number;
}

/** Request methods: name → [params, result]. */
export interface Methods {
  'daemon.status': [Record<string, never>, DaemonStatus];
  'daemon.shutdown': [Record<string, never>, null];
  'agents.list': [Record<string, never>, AgentSummary[]];
  'agents.reload': [Record<string, never>, AgentSummary[]];
  /** Current settings and what is available, for an agent or a pending builder proposal. */
  'agents.settings': [{ agentId: string } | { proposalId: string }, AgentSettings];
  /**
   * Applies a settings patch to the agent file, keeping its comments. Without `apply` it only
   * returns the diff; with it, `base` must match the diff the user reviewed.
   */
  /** Adds one exact host to an agent's egress list (confirmed by the user in a dialog). */
  'agents.allowHost': [{ agentId: string; host: string }, { egress: string[] }];
  'agents.update': [
    { agentId: string; patch: AgentPatch; apply?: boolean; base?: string },
    AgentUpdate,
  ];
  /** Creates a task and queues its first turn. */
  'tasks.create': [{ agentId: string; text: string }, TaskRow];
  'tasks.list': [{ agentId?: string; limit?: number }, TaskRow[]];
  'tasks.search': [TaskQuery, TaskRow[]];
  /** The task's delegation tree, root first, in creation order. */
  'tasks.tree': [{ taskId: string }, TaskRow[]];
  /** Deletes a finished task, its delegated tasks and their events. */
  'tasks.delete': [{ taskId: string }, { deleted: number }];
  'tasks.get': [{ taskId: string }, TaskRow];
  /** Follow-up turn in the same task (and cell, while it is alive). */
  'tasks.send': [{ taskId: string; text: string }, TaskRow];
  /**
   * Runs a failed or cancelled task again: a follow-up that continues its session (keeping its
   * work), or with `fresh` a new task with the original request. Returns the task that runs.
   */
  'tasks.retry': [{ taskId: string; fresh?: boolean }, TaskRow];
  'tasks.cancel': [{ taskId: string }, null];
  /** The task's external access, from the egress audit log in the VM. */
  'tasks.audit': [{ taskId: string }, TaskAudit];
  'tasks.events': [{ taskId: string; afterSeq?: number }, StoredEvent[]];
  /**
   * Credential-invariant scan of the task's live cell (before its idle timeout destroys it):
   * process environments, command lines and files, compared against the vault's real values.
   */
  'tasks.scan': [{ taskId: string }, { clean: boolean; findings: unknown[]; files: number }];
  /** Waits until the task's current turn ends (CLI). */
  'tasks.wait': [{ taskId: string }, TaskRow];
  'setup.status': [Record<string, never>, SetupStatus];
  /** Imports the host Codex login into the vault; the caller has the user's consent. */
  'setup.importCodex': [Record<string, never>, RuntimeAccountStatus];
  /** Stores a `claude setup-token` token or an Anthropic API key in the vault. */
  'setup.importClaude': [{ token: string }, ClaudeAccountStatus];
  /** Runs a setup step; the caller has the user's consent. Progress arrives as `setup`. */
  'setup.run': [{ action: SetupAction }, SetupStatus];
  /** What `setup.reset` would delete and whether anything blocks it; changes nothing. */
  'setup.resetPreview': [Record<string, never>, ResetPreview];
  /**
   * Deletes the secure-vm VM with everything in it (vault contents included), for a
   * first-launch state; refused while tasks run. `confirm` is `reset`, typed by the user.
   * Progress arrives as `reset`. The vault key and Anchi home stay (the CLI's `--all` deletes
   * them after stopping the daemon).
   */
  'setup.reset': [{ confirm: string }, SetupStatus];
  'connectors.set': [ConnectorSecret, ConnectorStatus];
  /** Imports the token of the host GitHub CLI (`gh auth token`); the caller has consent. */
  'connectors.importGh': [Record<string, never>, ConnectorStatus];
  /**
   * Connects AWS through a host profile (SSO or any credential process): the daemon exports
   * its temporary credentials with the host AWS CLI and imports them again before they expire.
   */
  'connectors.awsProfile': [{ profile: string }, ConnectorStatus];
  'connectors.remove': [{ id: ConnectorId }, ConnectorStatus];
  /** Builder output for an agent, validated; nothing is written. */
  'builder.proposal': [{ proposalId: string }, BuilderProposal];
  /** Writes a proposal after the user confirmed it in a modal. */
  'builder.apply': [{ proposalId: string }, AgentSummary[]];
  'builder.discard': [{ proposalId: string }, null];
  /** What deleting the agent would delete; changes nothing. */
  'agents.deletePreview': [{ agentId: string }, AgentDeletionPreview];
  /**
   * Deletes the agent: its file, its tasks (cancelled first) with what they delegated, its
   * trigger state, its entry in other agents' delegates, and its home, skills and policy rules
   * in the VM. Workspaces on the Mac are not touched. `confirm` is the id the user typed.
   */
  'agents.delete': [{ agentId: string; confirm: string }, AgentDeletion];
  /** The proposal with a settings patch applied (checked again); replaces the old one. */
  'builder.revise': [{ proposalId: string; patch: AgentPatch }, BuilderProposal];
  'approvals.list': [Record<string, never>, Approval[]];
  'triggers.list': [Record<string, never>, TriggerInfo[]];
  'skills.list': [Record<string, never>, SkillInfo[]];
  /** Token totals since `since` (ms, default 30 days ago), grouped. */
  'usage.summary': [{ since?: number; by?: UsageGroup }, UsageRow[]];
  /** What the runtimes' responses last said about subscription limits (empty until seen). */
  'usage.quota': [Record<string, never>, QuotaInfo[]];
  'access.summary': [{ since?: number }, AccessSummary];
  'services.setToken': [{ id: ServiceConnectorId; token: string }, null];
  /** Gmail and Drive: one account (`default` when omitted). */
  'services.disconnect': [{ id: ServiceConnectorId; account?: string }, null];
  'services.setMode': [{ id: ServiceConnectorId; mode: 'auto' | 'ask' }, null];
  /** The Google Cloud Desktop OAuth client JSON (its text), for Gmail and Drive. */
  'services.googleClient': [{ json: string }, null];
  /** Starts Google sign-in; returns the URL (also opened in the browser). Ends with `oauth`. */
  'services.googleLogin': [{ id: ServiceConnectorId; account?: string }, { url: string }];
  /**
   * Removes the imported Google client, so the built-in one applies (when Anchi ships one).
   * Refused while any Google account is connected (DISCONNECT_BEFORE_REPLACING_CLIENT).
   */
  'services.removeGoogleClient': [Record<string, never>, null];
  /** Adds a skill from a local directory or a GitHub tree URL (pinned to its commit). */
  'skills.add': [{ source: string; id?: string }, SkillInfo];
  'skills.remove': [{ id: string }, null];
  /** Compares a GitHub skill with the latest commit of its ref; changes nothing. */
  'skills.checkUpdate': [{ id: string }, SkillUpdate];
  /** Replaces a GitHub skill with its content at `commit`, the one the user reviewed. */
  'skills.update': [{ id: string; commit: string }, SkillInfo];
  /** The caller showed the approval in a full-screen dialog and the user decided. */
  'approvals.decide': [{ id: string; allow: boolean }, null];
}

/** Daemon → client notifications. */
export interface Notifications {
  event: { taskId: string; agentId: string; seq?: number; event: RuntimeEvent };
  tasks: { task: TaskRow };
  agents: { agents: AgentSummary[] };
  proposal: { proposal: BuilderProposal };
  /** One line of a running setup step's output (host command output; sanitize for display). */
  setup: { action: SetupAction; line: string };
  /** A Google sign-in finished. */
  oauth: { id: ServiceConnectorId; account?: string; ok: boolean; error?: string };
  /** One line of `setup.reset` output (host command output; sanitize for display). */
  reset: { line: string };
  /** Tasks were deleted; clients reload their task list. */
  tasksDeleted: Record<string, never>;
  /** The pending approvals, whenever they change. */
  approvals: { approvals: Approval[] };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M][0];
export type Result<M extends MethodName> = Methods[M][1];
