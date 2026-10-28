import { randomBytes } from 'node:crypto';
import { executionSchema } from '@anchi/protocol';
import { TeamCoordinator } from './team-coordinator.ts';
import { TeamWorker } from './team.ts';
import { listServers } from './remote.ts';
import type { DaemonClient } from './rpc.ts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer, type Server } from 'node:net';
import {
  agentFile,
  agentLayerSchema,
  HIGH_RISK_IDS,
  type HomeLayout,
  idSchema,
  listAgentIds,
  listImageIds,
  parseYamlAs,
  resolveAgent,
  type Runtime,
  runtimeSchema,
} from '@anchi/core';
import {
  type AgentDeletion,
  type AgentDeletionPreview,
  type AgentSettings,
  type ConnectorSecret,
  type ConnectorStatus,
  type Inventory,
  type MethodName,
  type QuotaInfo,
  type Methods,
  SETUP_ACTIONS,
  type SetupAction,
  type ResetPreview,
  type ServiceConnectorId,
  type SetupStatus,
  type TaskStatus,
  TOKEN_CONNECTOR_IDS,
  type TokenConnectorId,
  type VmSize,
} from '@anchi/protocol';
import { ApprovalWatcher } from './approvals.ts';
import { mergeAuditRows, summarizeAccess, summarizeAudit } from './audit.ts';
import { QuotaAlerts } from './quota.ts';
import {
  builderAgent,
  BUILDER_ID,
  chooseBuilderRuntime,
  parseBlocks,
  Proposals,
} from './builder.ts';
import { Guest, type VmTransport, vmTransport } from './guest.ts';
import {
  APP_VERSION,
  AWS_PROFILE,
  awsExport,
  ghToken,
  hostConnectorsFile,
  hostOutput,
  hostResources,
  IN_GUEST_SETUP_STEPS,
  migrateLegacyVm,
  readHostConnectors,
  RESET_STEPS,
  SetupRunner,
  SETUP_STEPS,
  VAULT_KEY,
  vmSizeEnv,
  writeHostConnectors,
} from './host.ts';
import { CELL_CEILING, DEFAULT_MAX_CELLS, Hub } from './hub.ts';
import {
  agentSummary,
  type BuilderAgentInfo,
  builderInventoryText,
  listWorkspaceDirs,
} from './inventory.ts';
import { tryConnect } from './launch.ts';
import { desktopNotify } from './notify.ts';
import { Peer } from './rpc.ts';
import {
  claudeStatus,
  hermesStatus,
  codexStatus,
  jwtExpiry,
  CONNECTOR_IDS,
  connectorStatuses,
  readHostCodexLogin,
  prepareEnvironment,
  setupStatus,
} from './setup.ts';
import { EVENTS_PAGE_LIMIT, Store } from './store.ts';
import { HostLogins, type ClaudeLogin } from './host-logins.ts';
import { ACCOUNT, SERVICE_IDS, ServiceSetup } from './services.ts';
import {
  allowEgressHost,
  delegatorsOf,
  parsePatch,
  removeDelegate,
  removeTemplateDelegate,
  agentSettingsView,
  settingsView,
  templateDelegatorsOf,
  updateAgentFile,
} from './settings.ts';
import { type SkillRemote, SkillStore } from './skills.ts';
import { TriggerRunner } from './triggers.ts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

function serviceId(v: unknown): ServiceConnectorId {
  if (!SERVICE_IDS.includes(v as ServiceConnectorId)) throw new Error('unknown service connector');
  return v as ServiceConnectorId;
}

/** A Google account name for Gmail or Drive; omitted means `default`. */
function optionalAccount(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !ACCOUNT.test(v)) throw new Error('invalid account name');
  return v;
}

const STATUSES: TaskStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

const AWS_REFRESH_EVERY_MS = 5 * 60_000;
const AWS_REFRESH_AHEAD_MS = 15 * 60_000;

export interface DaemonOptions {
  layout: HomeLayout;
  guest?: Guest;
  vm?: VmTransport;
  log?(msg: string): void;
  /** Skip desktop notifications (tests). */
  quiet?: boolean;
  /** How long a task waits for a free cell (tests). */
  roomWaitMs?: number;
  idleMs?: number;
  turnTimeoutMs?: number;
  /** Host commands of setup steps and of connector imports (tests replace them). */
  setupSteps?: Partial<Record<SetupAction, string[][]>>;
  /** Host commands of `setup.reset` (tests replace them; the default deletes the VM). */
  resetSteps?: string[][];
  hostRun?: typeof hostOutput;
  /**
   * Rename a VM created as `secure-vm` and move the vault key at start (scripts/vm-name.sh).
   * Off unless set: only the real daemon may stop and rename the machine's VM.
   */
  migrateVm?: boolean;
  /** Keep runtime access tokens in step with host logins (default true). */
  hostLoginSync?: boolean;
  /** Host credential readers; tests use temporary files and a fake Keychain. */
  hostLogins?: HostLogins;
  /** ~/AnchiWorkspaces by default; tests point it elsewhere. */
  workspaceRoot?: string;
  /** Where GitHub skills are fetched from; tests replace it. */
  skillRemote?: SkillRemote;
  /** Opens a URL for the user (Google sign-in); tests replace it. */
  openUrl?: (url: string) => void;
  /** Run schedule and polling triggers (default true). */
  triggers?: boolean;
  /** Watch the egress proxy's approval queue (default true). */
  approvals?: boolean;
  /** Shows a desktop notification; tests replace it. */
  notify?: (title: string, message: string) => Promise<void>;
  /** Reap guest cells at start (default true). */
  reap?: boolean;
  /** The vault key a remote server unlocks its vault with at start; tests point it elsewhere. */
  vaultKeyFile?: string;
  /** Tests connect real daemon sockets in place of SSH, with the same RPC boundary. */
  teamConnect?: (target: string) => Promise<DaemonClient>;
  teamPollMs?: number;
}

type Handlers = {
  [M in MethodName]: (
    params: Methods[M][0],
    clientId: string,
  ) => Promise<Methods[M][1]> | Methods[M][1];
};

const TASK_ID = /^t-[0-9a-f]{10}$/;

/** `setup.run`'s `vmSize`: two numbers; their range is checked against the host. */
function vmSizeParam(v: unknown): VmSize {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('BAD_VM_SIZE: vmSize must be {cpus, memoryGiB}');
  }
  const { cpus, memoryGiB, ...rest } = v as Record<string, unknown>;
  if (Object.keys(rest).length || typeof cpus !== 'number' || typeof memoryGiB !== 'number') {
    throw new Error('BAD_VM_SIZE: vmSize must be {cpus, memoryGiB}');
  }
  return { cpus, memoryGiB };
}

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new Error(`invalid ${what}`);
  return v;
}

function taskId(v: unknown): string {
  if (typeof v !== 'string' || !TASK_ID.test(v)) throw new Error('invalid task id');
  return v;
}

function connectorSecret(p: unknown): ConnectorSecret {
  const v = (p ?? {}) as Record<string, unknown>;
  if (TOKEN_CONNECTOR_IDS.includes(v.id as TokenConnectorId))
    return { id: v.id as TokenConnectorId, token: str(v.token, 'token', 1000) };
  if (v.id === 'aws') {
    return {
      id: 'aws',
      accessKeyId: str(v.accessKeyId, 'access key id', 200),
      secretAccessKey: str(v.secretAccessKey, 'secret access key', 200),
      sessionToken: v.sessionToken ? str(v.sessionToken, 'session token', 4096) : undefined,
      region: str(v.region, 'region', 40),
    };
  }
  throw new Error('unknown connector');
}

export class Daemon {
  readonly store: Store;
  readonly hub: Hub;
  readonly guest: Guest;
  readonly vm: VmTransport;
  readonly proposals: Proposals;
  readonly approvals: ApprovalWatcher;
  readonly team: TeamCoordinator;
  readonly worker: TeamWorker;
  private quotaAlerts: QuotaAlerts;
  readonly triggers: TriggerRunner;
  readonly skills: SkillStore;
  readonly workspaceRoot: string;
  /** The last inventory, so proposals can be checked without asking the VM again. */
  private lastInventory: Inventory | undefined;
  readonly services: ServiceSetup;
  private server?: Server;
  private watchers: FSWatcher[] = [];
  private clients = new Map<string, Peer>();
  private startedAt = Date.now();
  private log: (msg: string) => void;
  private setup: SetupRunner;
  private preparing: Runtime | undefined;
  private hostRun: typeof hostOutput;
  private awsTimer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private hostLoginTimer?: NodeJS.Timeout;
  private hostLoginDebounce?: NodeJS.Timeout;
  private stopping = false;
  private hostLogins: HostLogins;
  private hostLoginSync?: Promise<void>;
  private codexImporting = false;

  /**
   * Keeps the vault's Codex access token current (phase 3, F4: on by default, off with
   * `codexAutoImport: false`). When the Mac's Codex CLI has refreshed its login, the newer
   * access token and the account id are imported, as `setup codex` does; the refresh token
   * stays on the Mac.
   */
  async syncCodex(file = this.hostLogins.codexFile): Promise<boolean> {
    if (this.settings().codexAutoImport === false || this.codexImporting) return false;
    let login: { accessToken: string; accountId: string };
    try {
      login = readHostCodexLogin(file);
    } catch {
      return false; // not logged in on this Mac
    }
    const hostExpiry = jwtExpiry(login.accessToken);
    if (!hostExpiry || hostExpiry <= Date.now() + 60_000) return false;
    this.codexImporting = true;
    try {
      const vault = await codexStatus(this.guest).catch(() => null);
      if (
        !vault ||
        (vault.connected &&
          (vault.accountId !== login.accountId || (vault.expiresAt ?? 0) >= hostExpiry))
      )
        return false;
      await this.guest.importCodex(login.accessToken, login.accountId);
      this.log(`codex token imported; valid until ${new Date(hostExpiry).toISOString()}`);
      void this.refreshSetup();
      return true;
    } catch {
      this.log('codex token import failed; retry from Runtimes');
      return false;
    } finally {
      this.codexImporting = false;
    }
  }

  /** Discovery is read-only until the existing VM and vault are ready. Never replaces a manual Claude token. */
  async syncHostLogins(): Promise<void> {
    if (this.stopping) return;
    if (this.hostLoginSync) return this.hostLoginSync;
    this.hostLoginSync = this.importHostLogins();
    try {
      await this.hostLoginSync;
    } finally {
      this.hostLoginSync = undefined;
    }
  }

  private async importHostLogins(): Promise<void> {
    const settings = this.settings();
    const found = await this.hostLogins.read({
      codex: settings.codexAutoImport !== false,
      claude: settings.claudeAutoImport !== false,
    });
    const status = await setupStatus(this.guest, this.vm, this.services).catch(() => null);
    if (
      !status ||
      status.vm !== 'running' ||
      !status.installed ||
      !status.vaultUnlocked ||
      status.error ||
      status.guestOutdated
    )
      return;
    if (found.codex) await this.syncCodex();
    if (found.claude) await this.syncClaude(found.claude);
  }

  private async syncClaude(login: ClaudeLogin): Promise<void> {
    try {
      const vault = await this.guest.claudeStatus();
      // A null expiry is a manually supplied setup-token or API key, including older installs.
      if (
        vault.configured &&
        (vault.expires_at == null || vault.expires_at * 1000 >= login.expiresAt)
      )
        return;
      await this.guest.importClaude(login.token, login.expiresAt);
      this.log('claude host login imported');
    } catch {
      this.log('claude host login import failed; retry from Runtimes');
    }
  }

  private async readSetupStatus(): Promise<SetupStatus> {
    await this.hostLoginSync;
    return {
      ...(await setupStatus(this.guest, this.vm, this.services)),
      hostLogins: this.hostLogins.status,
    };
  }

  private settings(): Record<string, unknown> {
    try {
      const value = parseYaml(
        readFileSync(join(this.opts.layout.root, 'settings.yaml'), 'utf8'),
      ) as unknown;
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * A desktop notification (macOS; Linux with notify-send), unless `quiet` (tests) or
   * `desktopNotifications: false` in ~/.anchi/settings.yaml.
   */
  private notify(title: string, message: string): void {
    if (this.opts.quiet || this.settings().desktopNotifications === false) return;
    void (this.opts.notify ?? desktopNotify)(title, message);
  }

  /**
   * How long the egress proxy holds a write for the user's approval, in seconds:
   * `approvalTimeoutMinutes` in ~/.anchi/settings.yaml (1 to 720), else the proxy's default
   * (5 minutes). Writes held by the connector services keep the policy service's ten minutes.
   */
  approvalTimeoutS(): number | undefined {
    const raw = this.settings().approvalTimeoutMinutes;
    if (raw === undefined || raw === null) return undefined;
    const minutes = Number(raw);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 720) return minutes * 60;
    this.warnOnce(
      `settings.yaml: approvalTimeoutMinutes ${String(raw)} is not a whole number from 1 to 720; using the default (5)`,
    );
    return undefined;
  }

  /** `highRisk.disable` of ~/.anchi/settings.yaml: exempt for every agent. */
  private globalHighRisk(): string[] {
    const highRisk = this.settings().highRisk as { disable?: unknown } | undefined;
    return Array.isArray(highRisk?.disable) ? highRisk.disable.map(String) : [];
  }

  /**
   * Sends the user's settings the egress proxy applies to the egress proxy: high-risk
   * exceptions (`highRisk: {disable: [ids]}`) and the approval timeout.
   */
  async pushEgressSettings(): Promise<void> {
    const disabled = this.globalHighRisk();
    const timeout = this.approvalTimeoutS();
    try {
      const r = await this.guest.transport.exec(
        ['anchi-cell', 'egress-settings'],
        JSON.stringify({
          high_risk_disabled: disabled,
          ...(timeout === undefined ? {} : { approval_timeout_s: timeout }),
        }),
      );
      if (r.code !== 0) this.log(`egress settings not applied: ${r.stdout.trim().slice(0, 200)}`);
    } catch (err) {
      this.log(`egress settings not applied: ${(err as Error).message}`);
    }
  }

  /**
   * Cells working at once: `maxCells` in ~/.anchi/settings.yaml (1–16), default 4. Each working
   * cell can use up to 2 GB of the VM's memory; raise the VM's memory with it. A number outside
   * the range becomes the nearest one allowed, and anything else the default; both are logged,
   * so a typo does not silently halve the cells the user asked for.
   */
  maxCells(): number {
    const raw = this.settings().maxCells;
    if (raw === undefined || raw === null) return DEFAULT_MAX_CELLS;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.warnOnce(`settings.yaml: maxCells is not a number; using ${DEFAULT_MAX_CELLS}`);
      return DEFAULT_MAX_CELLS;
    }
    const value = Math.min(Math.max(Math.round(n), 1), CELL_CEILING);
    if (value !== n) {
      this.warnOnce(`settings.yaml: maxCells ${n} is outside 1–${CELL_CEILING}; using ${value}`);
    }
    return value;
  }

  /** The same settings warning every time a cell starts would fill the log. */
  private warned = '';
  private warnOnce(message: string) {
    if (this.warned === message) return;
    this.warned = message;
    this.log(message);
  }

  /** The builder's runtime when settings.yaml names none: the first connected one. */
  private autoBuilderRuntime: Runtime = 'codex';

  /**
   * The runtime the builder runs on: `builderRuntime` in ~/.anchi/settings.yaml, else the first
   * connected of codex, claude-code and hermes (`chooseBuilderRuntime`). Read when a builder
   * task starts; a task keeps the runtime its session started on.
   */
  builderRuntime(): Runtime {
    const raw = this.settings().builderRuntime;
    if (raw === undefined || raw === null) return this.autoBuilderRuntime;
    const parsed = runtimeSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.warnOnce(
      `settings.yaml: builderRuntime ${String(raw)} is not codex, claude-code or hermes; using ${this.autoBuilderRuntime}`,
    );
    return this.autoBuilderRuntime;
  }

  /** The VM's components come from another Anchi version; set by the latest setup status. */
  private guestOutdated?: { guest: string | null; app: string };
  private warnedGuest = false;

  /** What a fresh setup status changes: the builder's runtime and the outdated-guest warning. */
  private noteSetup(status: SetupStatus): void {
    if (status.vm === 'running') {
      const runtime = chooseBuilderRuntime(status);
      if (runtime !== this.autoBuilderRuntime) {
        this.autoBuilderRuntime = runtime;
        this.log(`builder runtime: ${runtime} (the first runtime connected)`);
        this.hub.reload();
      }
    }
    this.guestOutdated = status.guestOutdated
      ? { guest: status.guestVersion ?? null, app: status.appVersion ?? APP_VERSION }
      : undefined;
    if (this.guestOutdated && !this.warnedGuest) {
      this.warnedGuest = true;
      this.log(this.guestWarning());
    }
  }

  private guestWarning(): string {
    const { guest, app } = this.guestOutdated ?? { guest: null, app: APP_VERSION };
    return `⚠ the VM's components were installed by Anchi ${guest ?? 'an older release'}; this is Anchi ${app}: run anchi setup install (Runtimes → I) to update them`;
  }

  /** Reads the setup status for its side effects; a VM that is not up is not an error. */
  /**
   * A remote server's restart (a reboot, a disk resize) clears the vault's master key from tmpfs,
   * and its triggers and tasks then fail until someone unlocks it. Its vault key lies on the same
   * machine as the encrypted vault, so staying locked protects nothing there: unlock it at start.
   * The Lima VM is different: its key stays on this computer, outside the VM's disk.
   */
  private async unlockServerVault(): Promise<void> {
    if (!existsSync(this.opts.vaultKeyFile ?? VAULT_KEY)) return;
    try {
      if (!(await this.guest.servicesInstalled())) return;
      if ((await this.guest.vaultStatus()).unlocked) return;
      await this.setup.run('vault-unlock', () => {});
      this.log('unlocked the vault with the vault key on this server');
    } catch (err) {
      this.log(`the vault stays locked: ${(err as Error).message}`);
    }
  }

  private async refreshSetup(): Promise<void> {
    const status = await setupStatus(this.guest, this.vm, this.services).catch(() => undefined);
    if (status) this.noteSetup(status);
  }

  /** Days finished tasks are kept: `retentionDays` in ~/.anchi/settings.yaml, default 90. */
  retentionDays(): number {
    const file = join(this.opts.layout.root, 'settings.yaml');
    try {
      const value = parseYaml(readFileSync(file, 'utf8')) as { retentionDays?: unknown } | null;
      const days = Number(value?.retentionDays);
      if (Number.isInteger(days) && days >= 1 && days <= 3650) return days;
    } catch {
      // No settings file: the default.
    }
    return 90;
  }
  private awsRefreshFailing = false;

  constructor(private opts: DaemonOptions) {
    this.hostLogins = opts.hostLogins ?? new HostLogins();
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.vm = opts.vm ?? vmTransport();
    this.guest = opts.guest ?? new Guest(this.vm);
    this.store = new Store(opts.layout.dbFile);
    this.workspaceRoot = opts.workspaceRoot ?? join(homedir(), 'AnchiWorkspaces');
    this.skills = new SkillStore(join(opts.layout.root, 'skills'), opts.skillRemote);
    this.proposals = new Proposals(opts.layout, () => ({
      inventory: this.quickInventory(),
      workspaceRoot: this.workspaceRoot,
    }));
    const inGuest = this.vm.placement === 'local';
    // Inside a remote server the browser is the client's: it opens the URL the call returns.
    this.services = new ServiceSetup(
      this.guest,
      (r) => this.broadcast('oauth', r),
      opts.openUrl ?? (inGuest ? () => {} : undefined),
    );
    this.setup = new SetupRunner(
      opts.setupSteps ?? (inGuest ? IN_GUEST_SETUP_STEPS : SETUP_STEPS),
      undefined,
      opts.resetSteps ?? (inGuest ? null : RESET_STEPS),
    );
    this.approvals = new ApprovalWatcher(this.guest.transport, this.log, (id) =>
      this.hub.origin(id),
    );
    this.approvals.on('changed', () =>
      this.broadcast('approvals', { approvals: this.allApprovals() }),
    );
    this.approvals.on('added', (a) => {
      this.hub.notice(
        a.task,
        `⏸ waiting for your approval: ${a.operation} (${a.reason || a.connector})`,
      );
      // Also while the TUI is open: the user may be in another window, and the write is
      // refused when nobody answers in time.
      this.notify(
        `Anchi: @${a.agent} asks for approval`,
        `${a.connector}: ${a.operation}${a.reason ? ` · ${a.reason}` : ''} · ${Math.max(1, Math.round(a.timeout / 60))} min to decide`,
      );
    });
    this.approvals.on('credential', (c) => {
      const task = this.store.getTask(c.task);
      if (!task) return;
      this.hub.notice(
        task.id,
        `⚠ the cell sent a credential of its own (not an Anchi placeholder) to ${c.host}: ${c.method} ${c.path}`,
      );
      this.log(`${task.id} sent a credential of its own to ${c.host}`);
      this.notify(
        `Anchi: @${task.agentId} sent a credential of its own`,
        `${task.id}: to ${c.host}. Anchi's credentials never enter a cell; see the task's access (a).`,
      );
    });
    this.approvals.on('notice', ({ task, text }) => {
      if (this.store.getTask(task)) this.hub.notice(task, text);
    });
    this.approvals.on('resolved', ({ approval, decided }) => {
      if (!decided) this.hub.notice(approval.task, `⏹ approval for ${approval.operation} expired`);
    });
    this.hostRun = opts.hostRun ?? hostOutput;
    this.hub = new Hub({
      team: () => this.team,
      worker: () => this.worker,
      layout: opts.layout,
      store: this.store,
      guest: this.guest,
      idleMs: opts.idleMs,
      roomWaitMs: opts.roomWaitMs,
      maxCells: () => this.maxCells(),
      turnTimeoutMs: opts.turnTimeoutMs,
      skills: this.skills,
      workspaceRoot: this.workspaceRoot,
      // The builder starts each turn knowing what exists (skills, connectors, directories,
      // agents, with the files of those the message names).
      turnInput: async (agent, text) =>
        agent.id === BUILDER_ID
          ? `${builderInventoryText(await this.inventory(), this.builderAgents(), text)}\n\n${text}`
          : text,
      onPolicyApproval: (task, connector, id) =>
        this.approvals.addPolicy(this.guest, task, connector, id),
      log: this.log,
      // The builder runs on whichever runtime is connected (or the one settings.yaml names).
      builtins: [
        { id: BUILDER_ID, agent: (runtime) => builderAgent(runtime ?? this.builderRuntime()) },
      ],
    });
    this.team = new TeamCoordinator({
      layout: opts.layout,
      store: this.store,
      tools: this.hub.tools,
      origin: (id) => this.hub.originChain(id),
      record: (task, event) => this.hub.record(task, event),
      changed: () => this.broadcast('approvals', { approvals: this.allApprovals() }),
      connect: opts.teamConnect,
      pollMs: opts.teamPollMs,
    });
    this.worker = new TeamWorker({
      layout: opts.layout,
      store: this.store,
      hub: this.hub,
      approvals: () => this.approvals.list(),
      decide: (id, allow) => this.approvals.decide(id, allow, this.guest),
    });
    this.triggers = new TriggerRunner(
      {
        agents: () => this.hub.resolvedAgents(),
        start: (agentId, text, trigger) => this.hub.createTask(agentId, text, trigger),
      },
      this.store,
      this.guest,
      this.log,
    );
    this.hub.on('event', (e) => this.broadcast('event', e));
    this.hub.on('agents', (agents) => this.broadcast('agents', { agents }));
    this.hub.on('scanPartial', ({ taskId, agentId, files, reason }) => {
      this.log(`credential scan of ${taskId} stopped at its ${reason} limit after ${files} files`);
      this.notify(
        `Anchi: the credential scan of @${agentId}'s cell was cut short`,
        `${taskId}: ${files} files checked before the ${reason} limit; the rest was not scanned. See the task.`,
      );
    });
    this.hub.on('scanFinding', ({ taskId, agentId, labels }) => {
      this.log(`credential scan of ${taskId} found ${labels.join(', ')}`);
      this.notify(
        `Anchi: credential found in @${agentId}'s cell`,
        `${taskId}: ${labels.join(', ')}`,
      );
    });
    this.hub.on('task', (task) => {
      this.broadcast('tasks', { task });
      if (task.status === 'done' || task.status === 'failed') {
        this.log(`task ${task.id} (${task.agentId}) ${task.status}`);
        // Only without a client: the TUI shows the result itself.
        if (this.clients.size === 0)
          this.notify(`@${task.agentId} ${task.status}`, task.result ?? '');
      }
    });
    this.quotaAlerts = new QuotaAlerts(
      () => this.quota(),
      (title, message) => {
        this.log(`${title}: ${message}`);
        this.notify(title, message);
      },
    );
    this.hub.on('turnEnded', () => {
      void this.quotaAlerts.check().catch(() => {});
    });
    this.hub.on('turnEnded', ({ task, reply }) => {
      if (task.agentId !== BUILDER_ID) return;
      const proposal = this.proposals.add(parseBlocks(reply));
      if (proposal) this.broadcast('proposal', { proposal });
    });
  }

  /**
   * What agents can be given: installed skills, connectors (asked from the VM; null when it
   * cannot answer), directories under ~/AnchiWorkspaces, agents and images.
   */
  /** The subscription limits the egress proxy last saw, by runtime. */
  private async quota(): Promise<QuotaInfo[]> {
    const runtimes: Record<string, string> = { codex: 'codex', anthropic: 'claude-code' };
    return Object.entries(await this.guest.quota()).map(([rule, q]) => ({
      runtime: runtimes[rule] ?? rule,
      ts: Math.round(q.ts * 1000),
      status: q.status,
      headers: q.headers ?? {},
      ...(q.windows
        ? {
            plan: q.plan ?? null,
            limited: q.limited === true,
            windows: q.windows.map((w) => ({
              name: w.name,
              usedPercent: w.used_percent,
              windowMinutes: w.window_minutes,
              resetAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null,
            })),
          }
        : {}),
    }));
  }

  async inventory(): Promise<Inventory> {
    const status = await setupStatus(this.guest, this.vm, this.services).catch(() => undefined);
    const known = status?.vm === 'running' && status.vaultUnlocked;
    const inventory: Inventory = {
      servers: listServers(this.opts.layout.root)
        .filter((server) => server.name !== 'local')
        .map((server) => server.name),
      skills: this.skills.list().map(({ id, name, description }) => ({ id, name, description })),
      connectors: [
        ...(status?.connectors ?? []).map((c) => ({
          id: c.id,
          connected: known ? c.connected : null,
        })),
        ...SERVICE_IDS.map((id) => {
          const svc = status?.services?.find((x) => x.id === id);
          const accounts = svc?.accounts?.filter((a) => a.connected).map((a) => a.name) ?? [];
          return {
            id,
            connected: known && svc ? svc.connected : null,
            ...(known && accounts.length ? { accounts } : {}),
          };
        }),
      ],
      runtimes: [
        { id: 'codex', connected: known ? status.codex.connected : null },
        { id: 'claude-code', connected: known ? status.claude.connected : null },
        { id: 'hermes', connected: known ? (status.hermes?.connected ?? false) : null },
      ],
      workspaces: {
        shared: status?.vm === 'running' ? status.workspaces : null,
        dirs: listWorkspaceDirs(this.workspaceRoot),
      },
      agents: this.hub
        .summaries()
        .map((a) => a.id)
        .filter((id) => id !== BUILDER_ID),
      images: listImageIds(this.opts.layout),
      highRisk: [...HIGH_RISK_IDS],
    };
    if (!status) {
      const quick = this.quickInventory();
      inventory.connectors = quick.connectors;
      inventory.runtimes = quick.runtimes;
    }
    this.lastInventory = inventory;
    return inventory;
  }

  /** The inventory without asking the VM: connector states from the last full one. */
  private quickInventory(): Pick<
    Inventory,
    'skills' | 'connectors' | 'runtimes' | 'agents' | 'servers'
  > {
    return {
      servers: listServers(this.opts.layout.root)
        .filter((server) => server.name !== 'local')
        .map((server) => server.name),
      skills: this.skills.list(),
      connectors: this.lastInventory?.connectors ?? [],
      runtimes: this.lastInventory?.runtimes ?? [],
      agents: this.hub
        .summaries()
        .map((a) => a.id)
        .filter((id) => id !== BUILDER_ID),
    };
  }

  /** Existing agents for the builder: a summary of each and its own file. */
  private builderAgents(): BuilderAgentInfo[] {
    return listAgentIds(this.opts.layout)
      .filter((id) => id !== BUILDER_ID)
      .map((id) => {
        let summary: string;
        try {
          summary = agentSummary(resolveAgent(id, this.opts.layout));
        } catch (err) {
          summary = `does not load: ${(err as Error).message}`;
        }
        let yaml = '';
        try {
          yaml = readFileSync(agentFile(this.opts.layout, id), 'utf8');
        } catch {
          // Listed a moment ago; gone now.
        }
        return { id, summary, yaml };
      });
  }

  private async agentSettings(
    params: { agentId: string } | { proposalId: string },
  ): Promise<AgentSettings> {
    const view = await this.fileSettings(params);
    // The proxy refuses settings.yaml with an unknown id, so only known ones are shown.
    const global = this.globalHighRisk().filter((h) => HIGH_RISK_IDS.some((id) => id === h));
    if (global.length) view.fixed.highRiskGlobal = global;
    return view;
  }

  /** An agent's settings from its files (or a proposal's), without ~/.anchi/settings.yaml. */
  private async fileSettings(
    params: { agentId: string } | { proposalId: string },
  ): Promise<AgentSettings> {
    const inventory = await this.inventory();
    if ('proposalId' in params) {
      const proposal = this.proposals.get(str(params.proposalId, 'proposal', 20));
      const id = proposal.agentId;
      // A patch proposal is the agent's file as it would be: templates still apply.
      const view =
        proposal.kind === 'update'
          ? agentSettingsView(this.opts.layout, id, proposal.agentYaml)
          : settingsView({ ...parseYamlAs(proposal.agentYaml, agentLayerSchema), id });
      return { agentId: id, editable: true, ...view, inventory };
    }
    const id = str(params.agentId, 'agent', 40);
    if (id === BUILDER_ID) {
      return {
        agentId: id,
        editable: false,
        reason: 'the builder is built in; its settings are fixed',
        ...settingsView({ id }),
        inventory,
      };
    }
    try {
      return {
        agentId: id,
        editable: true,
        ...agentSettingsView(this.opts.layout, id),
        inventory,
      };
    } catch (err) {
      return {
        agentId: id,
        editable: false,
        reason: `fix the agent file first: ${(err as Error).message}`,
        ...settingsView({ id }),
        inventory,
      };
    }
  }

  private deletableId(raw: unknown): string {
    const id = idSchema.safeParse(raw);
    if (!id.success) throw new Error('invalid agent id');
    if (id.data === BUILDER_ID) throw new Error('the builder is built in and cannot be deleted');
    return id.data;
  }

  deletionPreview(raw: unknown): AgentDeletionPreview {
    const id = this.deletableId(raw);
    const tree = this.hub.agentTaskTree(id);
    const own = tree.filter((t) => t.agentId === id).length;
    let agent: ReturnType<typeof resolveAgent> | undefined;
    try {
      agent = resolveAgent(id, this.opts.layout);
    } catch {
      // A broken file can be deleted too; it just has no triggers or workspaces to list.
    }
    return {
      agentId: id,
      exists: listAgentIds(this.opts.layout).includes(id),
      tasks: own,
      delegated: tree.length - own,
      running: tree.filter((t) => t.status === 'running' || t.status === 'queued').length,
      delegatedBy: delegatorsOf(this.opts.layout, id),
      delegatedByTemplates: templateDelegatorsOf(this.opts.layout, id),
      triggers: agent?.triggers.length ?? 0,
      workspaces: agent?.workspaces.map((w) => w.path) ?? [],
    };
  }

  /**
   * Deletes an agent and what Anchi keeps for it; see `agents.delete`. The steps on this machine
   * run first, so a VM that is not running only leaves its part for a later run.
   */
  async deleteAgent(raw: unknown, confirm: unknown): Promise<AgentDeletion> {
    const id = this.deletableId(raw);
    if (confirm !== id) throw new Error(`type the agent id "${id}" to confirm`);
    const preview = this.deletionPreview(id);
    const warnings: string[] = [];
    const editedAgents: string[] = [];
    const editedTemplates: string[] = [];
    let deletedTasks = 0;
    this.hub.beginDeleting(id);
    try {
      deletedTasks = await this.hub.deleteAgentTasks(id);
      for (const other of preview.delegatedBy) {
        try {
          removeDelegate(this.opts.layout, other, id);
          editedAgents.push(other);
        } catch (err) {
          warnings.push(`@${other} still lists @${id} as a delegate: ${(err as Error).message}`);
        }
      }
      // Templates too: every agent extending one would otherwise inherit a delegate that no
      // longer exists, and new agents from the template with it.
      for (const template of preview.delegatedByTemplates) {
        try {
          removeTemplateDelegate(this.opts.layout, template, id);
          editedTemplates.push(template);
        } catch (err) {
          warnings.push(
            `template ${template} still lists @${id} as a delegate: ${(err as Error).message}`,
          );
        }
      }
      if (preview.exists) rmSync(agentFile(this.opts.layout, id), { force: true });
      this.store.deleteTriggerState(id);
    } finally {
      this.hub.endDeleting(id);
      this.hub.reload();
      this.broadcast('tasksDeleted', {});
    }
    let vm: AgentDeletion['vm'] = null;
    try {
      vm = await this.guest.purgeAgent(id);
    } catch (err) {
      warnings.push(
        `the VM kept @${id}'s home and skills (${(err as Error).message}); delete @${id} again once the VM runs`,
      );
    }
    this.log(
      `agent ${id} deleted: ${deletedTasks} tasks, delegates edited in ${editedAgents.length} agents and ${editedTemplates.length} templates`,
    );
    return { agentId: id, deletedTasks, editedAgents, editedTemplates, vm, warnings };
  }

  private broadcast(method: string, params: unknown) {
    for (const peer of this.clients.values()) peer.notify(method, params);
  }

  private allApprovals() {
    return [...this.approvals.list(), ...(this.team?.listApprovals() ?? [])];
  }

  private handlers: Handlers = {
    'team.describe': (params) => this.worker.describe(params),
    'team.run': (params) => this.worker.run(params),
    'team.poll': (params) => this.worker.poll(params),
    'team.reply': (params) => this.worker.reply(params),
    'team.cancel': (params) => this.worker.cancel(params),
    'team.approve': (params) => this.worker.approve(params),
    'team.nodes': () => listServers(this.opts.layout.root).filter((node) => node.name !== 'local'),
    'team.preview': async (raw) => {
      const { agentId, execution } = z
        .strictObject({ agentId: idSchema, execution: executionSchema })
        .parse(raw);
      const description = await this.team.describe(execution);
      return this.proposals.remoteStarter(agentId, execution, description);
    },
    'daemon.status': () => ({
      pid: process.pid,
      home: this.opts.layout.root,
      startedAt: this.startedAt,
      clients: this.clients.size,
      cells: this.hub.cellCount(),
    }),
    'daemon.shutdown': () => {
      setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
      return null;
    },
    'agents.list': () => this.hub.summaries(),
    'agents.createPreview': (params) => this.proposals.starter(params),
    'agents.reload': () => this.hub.reload(),
    'agents.settings': async (params) => this.agentSettings(params),
    'agents.deletePreview': ({ agentId }) => this.deletionPreview(agentId),
    'agents.delete': ({ agentId, confirm }) => this.deleteAgent(agentId, confirm),
    'agents.allowHost': async ({ agentId, host }) => {
      const id = str(agentId, 'agent', 40);
      if (id === BUILDER_ID) throw new Error('the builder is built in; its settings are fixed');
      const result = allowEgressHost(this.opts.layout, id, str(host, 'host', 260), {
        inventory: await this.inventory(),
        workspaceRoot: this.workspaceRoot,
      });
      this.log(`${host} added to the egress list of ${id}`);
      this.hub.reload();
      return result;
    },
    'agents.update': async ({ agentId, patch, apply, base }) => {
      const id = str(agentId, 'agent', 40);
      if (id === BUILDER_ID) throw new Error('the builder is built in; its settings are fixed');
      const result = updateAgentFile(this.opts.layout, id, parsePatch(patch), {
        apply: apply === true,
        base: typeof base === 'string' ? base : undefined,
        inventory: await this.inventory(),
        workspaceRoot: this.workspaceRoot,
      });
      if (result.applied) {
        this.log(`settings of ${id} changed from the TUI`);
        this.hub.reload();
      }
      return result;
    },
    'tasks.create': ({ agentId, text }) => {
      const task = this.hub.createTask(str(agentId, 'agent', 40), str(text, 'text', 200_000));
      // CLI users see no Runtimes screen: say it where they look.
      if (this.guestOutdated) this.hub.notice(task.id, this.guestWarning());
      return task;
    },
    'tasks.list': ({ agentId, limit }) =>
      this.store.listTasks(agentId, Math.min(Math.max(Number(limit) || 100, 1), 500)),
    'tasks.get': ({ taskId: id }) => this.hub.getTask(taskId(id)),
    'tasks.search': (q) =>
      this.store.search({
        agentId: q.agentId ? str(q.agentId, 'agent', 40) : undefined,
        status: q.status && STATUSES.includes(q.status) ? q.status : undefined,
        text: q.text ? str(q.text, 'text', 200) : undefined,
        since: typeof q.since === 'number' ? q.since : undefined,
        until: typeof q.until === 'number' ? q.until : undefined,
        limit: typeof q.limit === 'number' ? q.limit : undefined,
        offset: typeof q.offset === 'number' ? q.offset : undefined,
      }),
    'tasks.tree': ({ taskId: id }) => this.store.tree(this.hub.getTask(taskId(id)).rootId),
    'tasks.delete': async ({ taskId: id }) => {
      const deleted = await this.hub.deleteTask(taskId(id));
      this.broadcast('tasksDeleted', {});
      return { deleted };
    },
    'tasks.send': ({ taskId: id, text }) => {
      const task = this.hub.getTask(taskId(id));
      if (task.teamOrigin) throw new Error('Continue this team task on its coordinator.');
      return this.hub.sendTask(task.id, str(text, 'text', 200_000));
    },
    'tasks.audit': async ({ taskId: id }) => {
      const task = this.hub.getTask(taskId(id));
      if (task.execution)
        throw new Error(
          `View this task's egress audit on ${task.execution.server}, under @${task.execution.agent}; raw audit logs remain on the execution node.`,
        );
      const scan = this.store
        .events(task.id)
        .map((e) => e.event)
        .filter((e) => e.type === 'notice' && e.text.startsWith('credential scan'))
        .map((e) => (e as { text: string }).text)
        .at(-1);
      let live: Awaited<ReturnType<Guest['audit']>> | null = null;
      try {
        live = await this.guest.audit(task.id);
        if (this.store.getTask(task.id)) this.store.saveAuditRows(task.id, live.rows);
      } catch (err) {
        if (!this.store.auditRows(task.id).length) throw err;
      }
      return summarizeAudit(
        task.id,
        mergeAuditRows(live, this.store.auditRows(task.id)),
        scan ?? null,
      );
    },
    'tasks.retry': ({ taskId: id, fresh }) => {
      const task = this.hub.getTask(taskId(id));
      if (task.teamOrigin) throw new Error('Retry this team task on its coordinator.');
      return this.hub.retryTask(task.id, fresh === true);
    },
    'tasks.cancel': ({ taskId: id }) => {
      this.hub.cancelTask(taskId(id));
      return null;
    },
    'tasks.events': ({ taskId: id, afterSeq, limit }) =>
      this.store.events(
        taskId(id),
        Number(afterSeq) || 0,
        Math.min(Math.max(Number(limit) || EVENTS_PAGE_LIMIT, 1), EVENTS_PAGE_LIMIT),
      ),
    'tasks.wait': ({ taskId: id }) => this.hub.wait(taskId(id)),
    'tasks.scan': async ({ taskId: id }) => {
      const task = taskId(id);
      if (!this.hub.liveTasks().includes(task)) {
        throw new Error('the task has no live cell; scan within the idle timeout after a turn');
      }
      return this.guest.scan(task);
    },
    'setup.status': async () => {
      const status = await this.readSetupStatus();
      this.noteSetup(status);
      return { ...status, preparing: this.preparing };
    },
    'setup.prepare': async (params) => {
      const { runtime, vmSize } = z
        .strictObject({
          runtime: runtimeSchema,
          confirm: z.literal(true),
          vmSize: z
            .strictObject({ cpus: z.number().int(), memoryGiB: z.number().int() })
            .optional(),
        })
        .parse(params);
      if (this.preparing || this.setup.running)
        throw new Error('Environment setup is already running.');
      const env = vmSize ? vmSizeEnv(vmSize, hostResources()) : {};
      this.preparing = runtime;
      try {
        await prepareEnvironment(
          runtime,
          () => setupStatus(this.guest, this.vm, this.services),
          async (action) => {
            await this.setup.run(
              action,
              (line) => this.broadcast('setup', { action, line }),
              action === 'install' ? env : {},
            );
          },
          async (selected) => {
            this.broadcast('setup', {
              action: 'install',
              line: `Preparing ${selected} runtime image`,
            });
            await this.guest.buildImage(`runtime-${selected}`, 'runtime');
          },
        );
        await this.syncHostLogins();
        const status = await this.readSetupStatus();
        this.noteSetup(status);
        return status;
      } finally {
        this.preparing = undefined;
      }
    },
    'setup.importClaude': async ({ token }) => {
      await this.hostLoginSync;
      await this.guest.importClaude(str(token, 'token', 500).trim());
      void this.refreshSetup();
      return claudeStatus(this.guest);
    },
    'setup.importHermes': async ({ baseUrl, apiKey, model }) => {
      await this.guest.importHermes(
        str(baseUrl, 'baseUrl', 300).trim(),
        str(apiKey, 'apiKey', 500).trim(),
        str(model, 'model', 100).trim(),
      );
      void this.refreshSetup();
      return hermesStatus(this.guest);
    },
    'setup.importCodex': async () => {
      await this.hostLoginSync;
      const login = readHostCodexLogin(this.hostLogins.codexFile);
      await this.guest.importCodex(login.accessToken, login.accountId);
      void this.refreshSetup();
      return codexStatus(this.guest);
    },
    'setup.run': async ({ action, vmSize }) => {
      if (this.preparing) throw new Error('Environment setup is already running.');
      if (!SETUP_ACTIONS.includes(action)) throw new Error('unknown setup step');
      if (vmSize !== undefined && action !== 'install') {
        throw new Error('BAD_VM_SIZE: only install creates a VM');
      }
      const env = vmSize === undefined ? {} : vmSizeEnv(vmSizeParam(vmSize), hostResources());
      this.log(
        `setup ${action} started${vmSize ? ` (a new VM: ${env.ANCHI_VM_CPUS} CPUs, ${env.ANCHI_VM_MEMORY_GIB} GiB)` : ''}`,
      );
      await this.setup.run(action, (line) => this.broadcast('setup', { action, line }), env);
      this.log(`setup ${action} done`);
      await this.syncHostLogins();
      const status = await this.readSetupStatus();
      this.noteSetup(status);
      return status;
    },
    'setup.resetPreview': async () => this.resetPreview(),
    'setup.reset': async ({ confirm }) => {
      if (this.preparing) throw new Error('Environment setup is already running.');
      if (confirm !== 'reset') throw new Error('type reset to confirm');
      const { busy } = await this.resetPreview();
      if (busy) throw new Error(`${busy} task(s) running or queued; cancel them or wait first`);
      // Idle cells end with the VM anyway; closing them first keeps their transcripts whole.
      await Promise.all(this.hub.liveTasks().map((t) => this.hub.closeCell(t, 'reset')));
      this.log('setup reset started');
      await this.setup.run('reset', (line) => this.broadcast('reset', { line }));
      this.log('setup reset done: the VM is deleted');
      return setupStatus(this.guest, this.vm);
    },
    'connectors.set': async (params) => {
      const secret = connectorSecret(params);
      // Keys entered by hand replace a profile the daemon was refreshing.
      if (secret.id === 'aws') this.setAwsProfile(undefined);
      return this.connect(secret);
    },
    'connectors.importGh': async () =>
      this.connect({ id: 'github', token: await ghToken(this.hostRun) }),
    'connectors.awsProfile': async ({ profile }) => {
      const name = str(profile, 'profile', 64);
      if (!AWS_PROFILE.test(name)) throw new Error('invalid AWS profile name');
      const exported = await awsExport(name, this.hostRun);
      const { expiresAt, ...secret } = exported;
      const status = await this.connect({ id: 'aws', ...secret });
      this.setAwsProfile({ profile: name, expiresAt });
      return { ...status, profile: name };
    },
    'connectors.remove': async ({ id }) => {
      if (!CONNECTOR_IDS.includes(id)) throw new Error('unknown connector');
      await this.guest.removeConnector(id);
      if (id === 'aws') this.setAwsProfile(undefined);
      return this.connectorStatus(id);
    },
    'builder.proposal': ({ proposalId }) => this.proposals.get(str(proposalId, 'proposal', 20)),
    'builder.apply': ({ proposalId }) => {
      const { imageId } = this.proposals.apply(str(proposalId, 'proposal', 20));
      const agents = this.hub.reload();
      if (imageId) this.log(`image "${imageId}" will be built on the first task that uses it`);
      return agents;
    },
    'approvals.list': () => this.allApprovals(),
    'triggers.list': () => this.triggers.list(),
    'skills.list': () => this.skills.list(),
    'usage.quota': () => this.quota(),
    'access.summary': async ({ since }) => {
      const from = typeof since === 'number' && since >= 0 ? since : Date.now() - 7 * 86_400_000;
      // Finished cells' rows are saved; running ones are read now (and saved).
      let partial = false;
      for (const id of this.hub.liveTasks()) {
        try {
          const live = await this.guest.audit(id);
          if (this.store.getTask(id)) this.store.saveAuditRows(id, live.rows);
        } catch {
          partial = true;
        }
      }
      return summarizeAccess(this.store.auditRowsSince(from), from, partial);
    },
    'usage.summary': ({ since, by }) => {
      const group = by ?? 'agent';
      if (!['agent', 'runtime', 'model', 'day'].includes(group))
        throw new Error('unknown grouping');
      const from = typeof since === 'number' && since >= 0 ? since : Date.now() - 30 * 86_400_000;
      return this.store.usageSummary(from, group);
    },
    'services.setToken': async ({ id, token }) => {
      await this.services.setToken(serviceId(id), str(token, 'token', 500).trim());
      return null;
    },
    'services.disconnect': async ({ id, account }) => {
      await this.services.disconnect(serviceId(id), optionalAccount(account));
      return null;
    },
    'services.setMode': async ({ id, mode }) => {
      if (mode !== 'auto' && mode !== 'ask') throw new Error('mode is auto or ask');
      await this.services.setMode(serviceId(id), mode);
      return null;
    },
    'services.googleClient': async ({ json }) => {
      await this.services.setGoogleClient(str(json, 'client JSON', 16_384));
      return null;
    },
    'services.redditClient': async (params) => {
      const { clientId, developerUsername } = z
        .strictObject({
          clientId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
          developerUsername: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/),
        })
        .parse(params);
      await this.services.setRedditClient(clientId, developerUsername);
      return null;
    },
    'services.redditLogin': async (params) => {
      z.strictObject({}).parse(params);
      return { url: await this.services.redditLogin() };
    },
    'services.xClient': async (params) => {
      const { clientId } = z
        .strictObject({ clientId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) })
        .parse(params);
      await this.services.setXClient(clientId);
      return null;
    },
    'services.xLogin': async (params) => {
      z.strictObject({}).parse(params);
      return { url: await this.services.xLogin() };
    },
    'services.googleLogin': async ({ id, account }) => ({
      url: await this.services.googleLogin(serviceId(id), optionalAccount(account)),
    }),
    'services.removeGoogleClient': async () => {
      await this.services.removeGoogleClient();
      return null;
    },
    'skills.add': async ({ source, id }) => {
      const result = await this.skills.add(
        str(source, 'source', 500),
        id ? str(id, 'id', 40) : undefined,
      );
      this.hub.reload();
      return result;
    },
    'skills.remove': ({ id }) => {
      this.skills.remove(str(id, 'id', 40));
      this.hub.reload();
      return null;
    },
    'approvals.decide': async ({ id, allow }) => {
      if (await this.team.decide(str(id, 'approval', 40), allow === true)) return null;
      const a = this.approvals.list().find((x) => x.id === id);
      await this.approvals.decide(str(id, 'approval', 40), allow === true, this.guest);
      if (a)
        this.hub.notice(a.task, `${allow === true ? '✓ approved' : '✗ denied'}: ${a.operation}`);
      return null;
    },
    'builder.revise': async ({ proposalId, patch }) => {
      await this.inventory();
      return this.proposals.revise(str(proposalId, 'proposal', 20), parsePatch(patch));
    },
    'skills.checkUpdate': ({ id }) => this.skills.checkUpdate(str(id, 'id', 40)),
    'skills.update': async ({ id, commit }) => {
      const skill = await this.skills.update(str(id, 'id', 40), str(commit, 'commit', 40));
      this.hub.reload();
      return skill;
    },
    'builder.discard': ({ proposalId }) => {
      this.proposals.discard(str(proposalId, 'proposal', 20));
      return null;
    },
  };

  private async resetPreview(): Promise<ResetPreview> {
    const busy = (['running', 'queued'] as const).reduce(
      (n, status) => n + this.store.search({ status, limit: 500 }).length,
      0,
    );
    return {
      vm: await this.vm.vmStatus(),
      busy,
      cells: this.hub.cellCount(),
      home: this.opts.layout.root,
      vaultKey: VAULT_KEY,
    };
  }

  /** Stores a credential, verifies it with the service and records the account it reports. */
  private async connect(secret: ConnectorSecret): Promise<ConnectorStatus> {
    await this.guest.setConnector(secret);
    let account: string;
    try {
      account = await this.guest.verifyConnector(secret.id);
    } catch (err) {
      // A credential the service refuses is removed rather than left to fail inside tasks.
      await this.guest.removeConnector(secret.id).catch(() => {});
      throw new Error(`${secret.id} did not accept the credential: ${(err as Error).message}`);
    }
    await this.guest.setConnectorAccount(secret.id, account);
    return this.connectorStatus(secret.id);
  }

  private async connectorStatus(id: ConnectorStatus['id']): Promise<ConnectorStatus> {
    const status = (await connectorStatuses(this.guest)).find((c) => c.id === id)!;
    if (id !== 'aws') return status;
    return { ...status, profile: this.hostConnectors().aws?.profile ?? null };
  }

  private hostConnectors() {
    return readHostConnectors(hostConnectorsFile(this.opts.layout.root));
  }

  private setAwsProfile(aws: { profile: string; expiresAt: number | null } | undefined) {
    const value = this.hostConnectors();
    if (aws) value.aws = aws;
    else delete value.aws;
    writeHostConnectors(hostConnectorsFile(this.opts.layout.root), value);
  }

  /**
   * Re-imports the AWS profile's temporary credentials before they expire. The host AWS CLI
   * refreshes the SSO token while the SSO session lasts; after that the user logs in again.
   */
  async refreshAws(now = Date.now()): Promise<void> {
    const aws = this.hostConnectors().aws;
    if (!aws || aws.expiresAt === null || aws.expiresAt - now > AWS_REFRESH_AHEAD_MS) return;
    try {
      const { expiresAt, ...secret } = await awsExport(aws.profile, this.hostRun);
      await this.connect({ id: 'aws', ...secret });
      this.setAwsProfile({ profile: aws.profile, expiresAt });
      this.awsRefreshFailing = false;
      this.log(`aws credentials of profile ${aws.profile} refreshed`);
    } catch (err) {
      this.log(`aws refresh failed: ${(err as Error).message}`);
      if (!this.awsRefreshFailing && !this.opts.quiet) {
        void desktopNotify(
          'Anchi: AWS credentials expire soon',
          `Run \`aws sso login --profile ${aws.profile}\` on this Mac.`,
        );
      }
      this.awsRefreshFailing = true;
    }
  }

  /** Closes cells left behind by a previous daemon. A VM that is not up yet is not an error. */
  private async reapCells(): Promise<void> {
    try {
      const reaped = await this.guest.reap();
      if (reaped.length) this.log(`reaped orphaned cells: ${reaped.join(', ')}`);
    } catch (err) {
      this.log(`cell reap skipped: ${(err as Error).message}`);
    }
  }

  async start(): Promise<void> {
    const { layout } = this.opts;
    for (const dir of [layout.root, layout.runDir, layout.dataDir, layout.agentsDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const existing = await tryConnect(layout);
    if (existing) {
      existing.close();
      throw new Error(`another daemon is already listening on ${layout.socketFile}`);
    }
    if (existsSync(layout.socketFile)) rmSync(layout.socketFile);

    // In the background: restarting a running VM takes longer than clients wait for the socket.
    const migration =
      this.opts.migrateVm && this.vm.placement === 'lima'
        ? migrateLegacyVm((line) => this.log(line))
        : undefined;
    // Cells from a previous daemon cannot be reattached: their runner channel was its stdio. With
    // a migration under way the reap waits for it: those cells are in the VM being renamed, which
    // still answers to `secure-vm` until the rename lands.
    if (this.opts.reap !== false) {
      if (migration) void migration.then(() => this.reapCells());
      else await this.reapCells();
    }
    // Which runtime the builder gets and whether the guest is outdated, before any client asks.
    if (migration) void migration.then(() => this.refreshSetup());
    else if (this.vm.placement === 'local')
      void this.unlockServerVault().then(() => this.refreshSetup());
    else void this.refreshSetup();
    this.hub.recoverInterrupted();

    this.server = createServer((socket) => {
      const clientId = randomBytes(4).toString('hex');
      const peer = new Peer(socket, async (method, params) => {
        // Own keys only: `constructor` or `toString` would otherwise find Object's.
        const handler = Object.hasOwn(this.handlers, method)
          ? (this.handlers[method as MethodName] as (p: unknown, c: string) => unknown)
          : undefined;
        if (!handler) throw new Error(`unknown method ${method}`);
        return handler(params, clientId);
      });
      this.clients.set(clientId, peer);
      peer.on('close', () => this.clients.delete(clientId));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(layout.socketFile, () => resolve());
    });
    chmodSync(layout.socketFile, 0o600);
    this.watchConfig();
    if (this.opts.approvals !== false) this.approvals.start();
    if (this.opts.triggers !== false) this.triggers.start();
    void this.pushEgressSettings();
    if (this.opts.hostLoginSync !== false) {
      void this.syncHostLogins();
      this.hostLoginTimer = setInterval(() => void this.syncHostLogins(), 5 * 60_000);
      this.hostLoginTimer.unref();
      for (const file of [this.hostLogins.codexFile, this.hostLogins.claudeFile]) {
        try {
          this.watchers.push(
            watch(dirname(file), (_e, name) => {
              if (String(name) === basename(file)) {
                clearTimeout(this.hostLoginDebounce);
                this.hostLoginDebounce = setTimeout(() => void this.syncHostLogins(), 1000);
                this.hostLoginDebounce.unref();
              }
            }),
          );
        } catch {
          // A CLI not installed yet is picked up by the timer.
        }
      }
    }
    // Retention: finished tasks older than the configured number of days.
    const purge = () => {
      const n = this.hub.purge(this.retentionDays());
      if (n) this.log(`retention: deleted ${n} task(s) older than ${this.retentionDays()} days`);
    };
    purge();
    this.purgeTimer = setInterval(purge, 6 * 3600_000);
    this.purgeTimer.unref();
    this.awsTimer = setInterval(() => void this.refreshAws(), AWS_REFRESH_EVERY_MS);
    this.awsTimer.unref();
    this.log(`daemon ${process.pid} listening on ${layout.socketFile}`);
  }

  /** Reloads agents when any configuration file changes. */
  private watchConfig() {
    const { layout } = this.opts;
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.hub.reload(), 300);
    };
    for (const dir of [layout.agentsDir, layout.templatesDir, layout.imagesDir]) {
      if (!existsSync(dir)) continue;
      try {
        this.watchers.push(
          watch(dir, (_e, name) => name && /\.ya?ml$|\.md$/.test(String(name)) && onChange()),
        );
      } catch {
        // Watching is a convenience; `agents.reload` still works.
      }
    }
    let settingsTimer: NodeJS.Timeout | undefined;
    try {
      this.watchers.push(
        watch(layout.root, (_e, name) => {
          if (String(name) !== 'settings.yaml') return;
          clearTimeout(settingsTimer);
          settingsTimer = setTimeout(() => {
            void this.pushEgressSettings();
            // A higher maxCells lets tasks waiting for a cell start now.
            this.hub.roomChanged();
          }, 300);
        }),
      );
    } catch {
      // Settings also apply at the next start.
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.hub.suspend();
    this.worker.stop();
    await this.team.stop();
    clearTimeout(this.hostLoginDebounce);
    await this.hostLoginSync;
    await this.hub.shutdown();
    this.approvals.stop();
    this.triggers.stop();
    this.services.stop();
    clearInterval(this.purgeTimer);
    clearInterval(this.hostLoginTimer);
    clearInterval(this.awsTimer);
    for (const w of this.watchers) w.close();
    for (const p of this.clients.values()) p.close();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    if (existsSync(this.opts.layout.socketFile)) rmSync(this.opts.layout.socketFile);
    this.store.close();
  }
}
