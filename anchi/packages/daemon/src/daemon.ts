import { randomBytes } from 'node:crypto';
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
  type HomeLayout,
  idSchema,
  listAgentIds,
  listImageIds,
  parseYamlAs,
  resolveAgent,
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
  type TaskStatus,
} from '@anchi/protocol';
import { ApprovalWatcher } from './approvals.ts';
import { mergeAuditRows, summarizeAccess, summarizeAudit } from './audit.ts';
import { QuotaAlerts } from './quota.ts';
import { builderAgent, BUILDER_ID, parseBlocks, Proposals } from './builder.ts';
import { Guest, LimaTransport } from './guest.ts';
import {
  AWS_PROFILE,
  awsExport,
  ghToken,
  hostConnectorsFile,
  hostOutput,
  migrateLegacyVm,
  readHostConnectors,
  SetupRunner,
  SETUP_STEPS,
  VAULT_KEY,
  writeHostConnectors,
} from './host.ts';
import { Hub } from './hub.ts';
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
  codexStatus,
  HOST_CODEX_LOGIN,
  jwtExpiry,
  CONNECTOR_IDS,
  connectorStatuses,
  readHostCodexLogin,
  setupStatus,
} from './setup.ts';
import { Store } from './store.ts';
import { ACCOUNT, SERVICE_IDS, ServiceSetup } from './services.ts';
import {
  allowEgressHost,
  delegatorsOf,
  parsePatch,
  removeDelegate,
  agentSettingsView,
  settingsView,
  updateAgentFile,
} from './settings.ts';
import { type SkillRemote, SkillStore } from './skills.ts';
import { TriggerRunner } from './triggers.ts';
import { parse as parseYaml } from 'yaml';

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
  lima?: LimaTransport;
  log?(msg: string): void;
  /** Skip desktop notifications (tests). */
  quiet?: boolean;
  /** How long a task waits for a free cell (tests). */
  roomWaitMs?: number;
  idleMs?: number;
  turnTimeoutMs?: number;
  /** Host commands of setup steps and of connector imports (tests replace them). */
  setupSteps?: Record<SetupAction, string[][]>;
  /** Host commands of `setup.reset` (tests replace them; the default deletes the VM). */
  resetSteps?: string[][];
  hostRun?: typeof hostOutput;
  /**
   * Rename a VM created as `secure-vm` and move the vault key at start (scripts/vm-name.sh).
   * Off unless set: only the real daemon may stop and rename the machine's VM.
   */
  migrateVm?: boolean;
  /** Keep the vault's Codex token in step with the Mac's login (default true). */
  codexSync?: boolean;
  /** The Mac's Codex login file; tests point it elsewhere. */
  codexLogin?: string;
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
  /** Reap guest cells at start (default true). */
  reap?: boolean;
}

type Handlers = {
  [M in MethodName]: (
    params: Methods[M][0],
    clientId: string,
  ) => Promise<Methods[M][1]> | Methods[M][1];
};

const TASK_ID = /^t-[0-9a-f]{10}$/;

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
  if (v.id === 'github' || v.id === 'linear')
    return { id: v.id, token: str(v.token, 'token', 1000) };
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
  readonly lima: LimaTransport;
  readonly proposals: Proposals;
  readonly approvals: ApprovalWatcher;
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
  private hostRun: typeof hostOutput;
  private awsTimer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private codexTimer?: NodeJS.Timeout;
  private codexImporting = false;

  /**
   * Keeps the vault's Codex access token current (phase 3, F4: on by default, off with
   * `codexAutoImport: false`). When the Mac's Codex CLI has refreshed its login, the newer
   * access token and the account id are imported, as `setup codex` does; the refresh token
   * stays on the Mac.
   */
  async syncCodex(file = this.opts.codexLogin ?? HOST_CODEX_LOGIN): Promise<boolean> {
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
      if (!vault || (vault.connected && (vault.expiresAt ?? 0) >= hostExpiry)) return false;
      await this.guest.importCodex(login.accessToken, login.accountId);
      this.log(`codex token imported; valid until ${new Date(hostExpiry).toISOString()}`);
      return true;
    } catch (err) {
      this.log(`codex token import failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.codexImporting = false;
    }
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

  /** Sends the user's high-risk exceptions (`highRisk: {disable: [ids]}`) to the egress proxy. */
  async pushEgressSettings(): Promise<void> {
    const highRisk = this.settings().highRisk as { disable?: unknown } | undefined;
    const disabled = Array.isArray(highRisk?.disable) ? highRisk.disable.map(String) : [];
    try {
      const r = await this.guest.transport.exec(
        ['anchi-cell', 'egress-settings'],
        JSON.stringify({ high_risk_disabled: disabled }),
      );
      if (r.code !== 0) this.log(`egress settings not applied: ${r.stdout.trim().slice(0, 200)}`);
    } catch (err) {
      this.log(`egress settings not applied: ${(err as Error).message}`);
    }
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
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.lima = opts.lima ?? new LimaTransport();
    this.guest = opts.guest ?? new Guest(this.lima);
    this.store = new Store(opts.layout.dbFile);
    this.workspaceRoot = opts.workspaceRoot ?? join(homedir(), 'AnchiWorkspaces');
    this.skills = new SkillStore(join(opts.layout.root, 'skills'), opts.skillRemote);
    this.proposals = new Proposals(opts.layout, () => ({
      inventory: this.quickInventory(),
      workspaceRoot: this.workspaceRoot,
    }));
    this.services = new ServiceSetup(this.guest, (r) => this.broadcast('oauth', r), opts.openUrl);
    this.setup = new SetupRunner(opts.setupSteps ?? SETUP_STEPS, undefined, opts.resetSteps);
    this.approvals = new ApprovalWatcher(this.guest.transport, this.log, (id) =>
      this.hub.origin(id),
    );
    this.approvals.on('changed', (approvals) => this.broadcast('approvals', { approvals }));
    this.approvals.on('added', (a) => {
      this.hub.notice(
        a.task,
        `⏸ waiting for your approval: ${a.operation} (${a.reason || a.connector})`,
      );
      if (!this.opts.quiet && this.clients.size === 0) {
        void desktopNotify(
          `Anchi: @${a.agent} asks for approval`,
          `${a.connector}: ${a.operation}`,
        );
      }
    });
    this.approvals.on('credential', (c) => {
      const task = this.store.getTask(c.task);
      if (!task) return;
      this.hub.notice(
        task.id,
        `⚠ the cell sent a credential of its own (not an Anchi placeholder) to ${c.host}: ${c.method} ${c.path}`,
      );
      this.log(`${task.id} sent a credential of its own to ${c.host}`);
      if (!this.opts.quiet) {
        void desktopNotify(
          `Anchi: @${task.agentId} sent a credential of its own`,
          `${task.id}: to ${c.host}. Anchi's credentials never enter a cell; see the task's access (a).`,
        );
      }
    });
    this.approvals.on('notice', ({ task, text }) => {
      if (this.store.getTask(task)) this.hub.notice(task, text);
    });
    this.approvals.on('resolved', ({ approval, decided }) => {
      if (!decided) this.hub.notice(approval.task, `⏹ approval for ${approval.operation} expired`);
    });
    this.hostRun = opts.hostRun ?? hostOutput;
    this.hub = new Hub({
      layout: opts.layout,
      store: this.store,
      guest: this.guest,
      idleMs: opts.idleMs,
      roomWaitMs: opts.roomWaitMs,
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
      builtins: [builderAgent()],
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
    this.hub.on('scanFinding', ({ taskId, agentId, labels }) => {
      this.log(`credential scan of ${taskId} found ${labels.join(', ')}`);
      if (!this.opts.quiet) {
        void desktopNotify(
          `Anchi: credential found in @${agentId}'s cell`,
          `${taskId}: ${labels.join(', ')}`,
        );
      }
    });
    this.hub.on('task', (task) => {
      this.broadcast('tasks', { task });
      if (task.status === 'done' || task.status === 'failed') {
        this.log(`task ${task.id} (${task.agentId}) ${task.status}`);
        if (!this.opts.quiet && this.clients.size === 0) {
          void desktopNotify(`@${task.agentId} ${task.status}`, task.result ?? '');
        }
      }
    });
    this.quotaAlerts = new QuotaAlerts(
      () => this.quota(),
      (title, message) => {
        this.log(`${title}: ${message}`);
        if (!this.opts.quiet) void desktopNotify(title, message);
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
    const status = await setupStatus(this.guest, this.lima, this.services).catch(() => undefined);
    const known = status?.vm === 'running' && status.vaultUnlocked;
    const inventory: Inventory = {
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
  private quickInventory(): Pick<Inventory, 'skills' | 'connectors' | 'runtimes' | 'agents'> {
    return {
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
      `agent ${id} deleted: ${deletedTasks} tasks, delegates edited in ${editedAgents.length}`,
    );
    return { agentId: id, deletedTasks, editedAgents, vm, warnings };
  }

  private broadcast(method: string, params: unknown) {
    for (const peer of this.clients.values()) peer.notify(method, params);
  }

  private handlers: Handlers = {
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
    'tasks.create': ({ agentId, text }) =>
      this.hub.createTask(str(agentId, 'agent', 40), str(text, 'text', 200_000)),
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
    'tasks.send': ({ taskId: id, text }) =>
      this.hub.sendTask(taskId(id), str(text, 'text', 200_000)),
    'tasks.audit': async ({ taskId: id }) => {
      const task = this.hub.getTask(taskId(id));
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
    'tasks.retry': ({ taskId: id, fresh }) => this.hub.retryTask(taskId(id), fresh === true),
    'tasks.cancel': ({ taskId: id }) => {
      this.hub.cancelTask(taskId(id));
      return null;
    },
    'tasks.events': ({ taskId: id, afterSeq }) =>
      this.store.events(taskId(id), Number(afterSeq) || 0),
    'tasks.wait': ({ taskId: id }) => this.hub.wait(taskId(id)),
    'tasks.scan': async ({ taskId: id }) => {
      const task = taskId(id);
      if (!this.hub.liveTasks().includes(task)) {
        throw new Error('the task has no live cell; scan within the idle timeout after a turn');
      }
      return this.guest.scan(task);
    },
    'setup.status': () => setupStatus(this.guest, this.lima, this.services),
    'setup.importClaude': async ({ token }) => {
      await this.guest.importClaude(str(token, 'token', 500).trim());
      return claudeStatus(this.guest);
    },
    'setup.importCodex': async () => {
      const login = readHostCodexLogin();
      await this.guest.importCodex(login.accessToken, login.accountId);
      return codexStatus(this.guest);
    },
    'setup.run': async ({ action }) => {
      if (!SETUP_ACTIONS.includes(action)) throw new Error('unknown setup step');
      this.log(`setup ${action} started`);
      await this.setup.run(action, (line) => this.broadcast('setup', { action, line }));
      this.log(`setup ${action} done`);
      return setupStatus(this.guest, this.lima);
    },
    'setup.resetPreview': async () => this.resetPreview(),
    'setup.reset': async ({ confirm }) => {
      if (confirm !== 'reset') throw new Error('type reset to confirm');
      const { busy } = await this.resetPreview();
      if (busy) throw new Error(`${busy} task(s) running or queued; cancel them or wait first`);
      // Idle cells end with the VM anyway; closing them first keeps their transcripts whole.
      await Promise.all(this.hub.liveTasks().map((t) => this.hub.closeCell(t, 'reset')));
      this.log('setup reset started');
      await this.setup.run('reset', (line) => this.broadcast('reset', { line }));
      this.log('setup reset done: the VM is deleted');
      return setupStatus(this.guest, this.lima);
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
    'approvals.list': () => this.approvals.list(),
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
    'services.googleLogin': async ({ id, account }) => ({
      url: await this.services.googleLogin(serviceId(id), optionalAccount(account)),
    }),
    'services.removeGoogleClient': async () => {
      await this.services.removeGoogleClient();
      return null;
    },
    'skills.add': async ({ source, id }) => {
      const skill = await this.skills.add(
        str(source, 'source', 500),
        id ? str(id, 'id', 40) : undefined,
      );
      this.hub.reload();
      return skill;
    },
    'skills.remove': ({ id }) => {
      this.skills.remove(str(id, 'id', 40));
      this.hub.reload();
      return null;
    },
    'approvals.decide': async ({ id, allow }) => {
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
      vm: await this.lima.vmStatus(),
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
    const migration = this.opts.migrateVm ? migrateLegacyVm((line) => this.log(line)) : undefined;
    // Cells from a previous daemon cannot be reattached: their runner channel was its stdio. With
    // a migration under way the reap waits for it: those cells are in the VM being renamed, which
    // still answers to `secure-vm` until the rename lands.
    if (this.opts.reap !== false) {
      if (migration) void migration.then(() => this.reapCells());
      else await this.reapCells();
    }
    this.hub.recoverInterrupted();

    this.server = createServer((socket) => {
      const clientId = randomBytes(4).toString('hex');
      const peer = new Peer(socket, async (method, params) => {
        const handler = this.handlers[method as MethodName] as
          ((p: unknown, c: string) => unknown) | undefined;
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
    if (this.opts.codexSync !== false) {
      void this.syncCodex();
      this.codexTimer = setInterval(() => void this.syncCodex(), 5 * 60_000);
      this.codexTimer.unref();
      try {
        const file = this.opts.codexLogin ?? HOST_CODEX_LOGIN;
        this.watchers.push(
          watch(dirname(file), (_e, name) => {
            if (String(name) === basename(file)) setTimeout(() => void this.syncCodex(), 1000);
          }),
        );
      } catch {
        // No ~/.codex yet; the timer still checks.
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
          settingsTimer = setTimeout(() => void this.pushEgressSettings(), 300);
        }),
      );
    } catch {
      // Settings also apply at the next start.
    }
  }

  async stop(): Promise<void> {
    await this.hub.shutdown();
    this.approvals.stop();
    this.triggers.stop();
    this.services.stop();
    clearInterval(this.purgeTimer);
    clearInterval(this.codexTimer);
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
