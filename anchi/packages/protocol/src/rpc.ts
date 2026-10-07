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
  /** Tasks waiting behind the running one. */
  queued: number;
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
export type SetupAction = 'vm-start' | 'install' | 'vault-init' | 'vault-unlock';
export const SETUP_ACTIONS: readonly SetupAction[] = [
  'vm-start',
  'install',
  'vault-init',
  'vault-unlock',
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

export interface SetupStatus {
  vm: 'missing' | 'stopped' | 'running' | 'unknown';
  vaultUnlocked: boolean;
  installed: boolean;
  codex: RuntimeAccountStatus;
  claude: ClaudeAccountStatus;
  connectors: ConnectorStatus[];
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

export interface BuilderProposal {
  id: string;
  agentId: string;
  /** Candidate agent YAML and image recipe, exactly as they would be written. */
  agentYaml: string;
  imageYaml: string | null;
  /** Unified diffs against the current files ('' for new files). */
  agentDiff: string;
  imageDiff: string;
  /** Problems that block applying; empty when the proposal is valid. */
  errors: string[];
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
  /** Creates a task and queues its first turn. */
  'tasks.create': [{ agentId: string; text: string }, TaskRow];
  'tasks.list': [{ agentId?: string; limit?: number }, TaskRow[]];
  'tasks.get': [{ taskId: string }, TaskRow];
  /** Follow-up turn in the same task (and cell, while it is alive). */
  'tasks.send': [{ taskId: string; text: string }, TaskRow];
  'tasks.cancel': [{ taskId: string }, null];
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
}

/** Daemon → client notifications. */
export interface Notifications {
  event: { taskId: string; agentId: string; seq?: number; event: RuntimeEvent };
  tasks: { task: TaskRow };
  agents: { agents: AgentSummary[] };
  proposal: { proposal: BuilderProposal };
  /** One line of a running setup step's output (host command output; sanitize for display). */
  setup: { action: SetupAction; line: string };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M][0];
export type Result<M extends MethodName> = Methods[M][1];
