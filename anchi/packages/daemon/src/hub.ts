import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  agentFile,
  BASE_IMAGE,
  type HomeLayout,
  listAgentIds,
  loadImage,
  type ResolvedAgent,
  resolveAgent,
  workspaceName,
} from '@anchi/core';
import type { AgentStatus, AgentSummary, RuntimeEvent, TaskRow } from '@anchi/protocol';
import { CellSession } from './cell.ts';
import type { SkillStore } from './skills.ts';
import { audit, snapshot, type Snapshot } from './workspace-audit.ts';
import { ToolDispatcher } from './tools.ts';
import type { Guest } from './guest.ts';
import { instructions, WORKDIR } from './prompt.ts';
import type { Store } from './store.ts';

export const IDLE_MS = 10 * 60_000;
export const MAX_CELLS = 4;

interface Job {
  taskId: string;
  text: string;
}

interface AgentState {
  id: string;
  agent?: ResolvedAgent;
  error?: string;
  queue: Job[];
  running?: { job: Job; controller: AbortController };
}

interface LiveCell {
  session: CellSession;
  agentId: string;
  /** Agent settings the cell was started with; a change means a new cell. */
  key: string;
  idle?: NodeJS.Timeout;
  lastUsed: number;
}

export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;
const SCAN_TIMEOUT_MS = 120_000;
const SHUTDOWN_SCAN_MS = 30_000;

/**
 * Delegation limits. They stop runaway loops and cost; they are not a security control (the
 * `delegates` allowlist is).
 */
export const DELEGATION = { maxDepth: 3, maxChildren: 10, maxTreeTurns: 60 };

export interface HubOptions {
  layout: HomeLayout;
  store: Store;
  guest: Guest;
  idleMs?: number;
  /** Scan each cell for real credential values before closing it (default true). */
  scanOnClose?: boolean;
  /** Skills copied into an agent's cells. */
  skills?: SkillStore;
  /** ~/AnchiWorkspaces on the Mac, where writable workspaces are audited after each turn. */
  workspaceRoot?: string;
  /** A connector service holds a cell's write for approval (see ApprovalWatcher.addPolicy). */
  onPolicyApproval?(task: TaskRow, connector: string, id: string): Promise<void>;
  /** Longest a single turn may run before it is cancelled and the task fails. */
  turnTimeoutMs?: number;
  log?(msg: string): void;
  /** Agents defined by Anchi itself (the builder); their ids are reserved. */
  builtins?: ResolvedAgent[];
  /** Rewrites a turn's input before the runtime sees it (the builder's inventory). */
  turnInput?: (agent: ResolvedAgent, text: string) => string | Promise<string>;
}

export interface HubEvents {
  event: [{ taskId: string; agentId: string; seq?: number; event: RuntimeEvent }];
  task: [TaskRow];
  agents: [AgentSummary[]];
  /** A turn ended; `reply` is the final message (agent-originated). */
  turnEnded: [{ task: TaskRow; reply: string }];
  /** The credential scan taken before a cell closed found real credential values. */
  scanFinding: [{ taskId: string; agentId: string; labels: string[] }];
}

function cellKey(agent: ResolvedAgent, imageHash: string): string {
  return JSON.stringify([
    agent.runtime,
    agent.image,
    imageHash,
    agent.connectors,
    agent.sandbox,
    agent.workspaces,
    agent.egress ?? null,
  ]);
}

/**
 * Owns agents, tasks and cells: one turn at a time per agent, a FIFO queue behind it, a cell
 * per task that stays alive between turns until the idle timeout.
 */
export class Hub extends EventEmitter<HubEvents> {
  private states = new Map<string, AgentState>();
  private cells = new Map<string, LiveCell>();
  private waiters = new Map<string, ((t: TaskRow) => void)[]>();
  private builds = new Map<string, Promise<void>>();
  private log: (msg: string) => void;

  readonly tools: ToolDispatcher;

  constructor(private opts: HubOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.tools = new ToolDispatcher({
      agents: () => this.summaries(),
      delegate: (parent, agent, target, text) => this.delegate(parent, agent, target, text),
      sendTask: (id, text) => this.sendTask(id, text),
      getTask: (id) => this.getTask(id),
      children: (id) => this.children(id),
      wait: (id) => this.wait(id),
      policyApproval: async (task, connector, id) => {
        if (!this.opts.onPolicyApproval) throw new Error('approvals are not available');
        await this.opts.onPolicyApproval(task, connector, id);
      },
    });
    this.reload();
  }

  // ── agents ───────────────────────────────────────────────

  private builtin(id: string): ResolvedAgent | undefined {
    return this.opts.builtins?.find((a) => a.id === id);
  }

  private resolve(id: string): ResolvedAgent {
    return this.builtin(id) ?? resolveAgent(id, this.opts.layout);
  }

  reload(): AgentSummary[] {
    const builtinIds = (this.opts.builtins ?? []).map((a) => a.id);
    const ids = [...new Set([...builtinIds, ...listAgentIds(this.opts.layout)])];
    for (const [id, s] of this.states) {
      if (!ids.includes(id) && !s.running && !s.queue.length) this.states.delete(id);
    }
    for (const id of ids) {
      const state = this.states.get(id) ?? { id, queue: [] };
      try {
        state.agent = this.resolve(id);
        state.error = undefined;
      } catch (err) {
        state.agent = undefined;
        state.error = (err as Error).message;
      }
      this.states.set(id, state);
    }
    return this.emitAgents();
  }

  /** Agents that loaded without errors, as configured (triggers, connectors…). */
  resolvedAgents(): ResolvedAgent[] {
    return [...this.states.values()].flatMap((s) => (s.agent ? [s.agent] : []));
  }

  summaries(): AgentSummary[] {
    return [...this.states.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => {
        const status: AgentStatus = s.running ? 'working' : s.error ? 'error' : 'idle';
        return {
          id: s.id,
          name: s.agent?.name ?? s.id,
          description: s.agent?.description,
          runtime: s.agent?.runtime,
          model: s.agent?.model,
          image: s.agent?.image,
          connectors: s.agent?.connectors ?? [],
          sandbox: s.agent?.sandbox,
          status,
          queued: s.queue.length,
          triggers: s.agent?.triggers.length ?? 0,
          workspaces: s.agent?.workspaces.map((w) => `${workspaceName(w)} (${w.mode})`) ?? [],
          delegates: s.agent?.delegates ?? [],
          skills: s.agent?.skills ?? [],
          error: s.error,
          file: s.agent?.sourceFiles.at(-1) ?? agentFile(this.opts.layout, s.id),
        };
      });
  }

  private emitAgents(): AgentSummary[] {
    const list = this.summaries();
    this.emit('agents', list);
    return list;
  }

  /** Agents being deleted: no task or turn starts for them meanwhile. */
  private deleting = new Set<string>();

  beginDeleting(agentId: string): void {
    this.deleting.add(agentId);
  }

  endDeleting(agentId: string): void {
    this.deleting.delete(agentId);
  }

  private state(agentId: string): AgentState {
    if (this.deleting.has(agentId)) throw new Error(`@${agentId} is being deleted`);
    // A file created just now may not have reached the watcher yet.
    if (!this.states.has(agentId)) this.reload();
    const s = this.states.get(agentId);
    if (!s) throw new Error(`unknown agent "${agentId}"`);
    return s;
  }

  cellCount(): number {
    return this.cells.size;
  }

  liveTasks(): string[] {
    return [...this.cells.keys()];
  }

  // ── tasks ────────────────────────────────────────────────

  createTask(agentId: string, text: string, trigger = 'user'): TaskRow {
    const state = this.state(agentId);
    if (!state.agent) throw new Error(`agent "${agentId}" has a config error: ${state.error}`);
    if (!text.trim()) throw new Error('empty task');
    const task = this.opts.store.createTask({ agentId, trigger, title: text });
    this.emit('task', task);
    this.enqueue(state, { taskId: task.id, text });
    return task;
  }

  sendTask(taskId: string, text: string): TaskRow {
    const task = this.getTask(taskId);
    const state = this.state(task.agentId);
    if (!state.agent) throw new Error(`agent "${task.agentId}" has a config error: ${state.error}`);
    if (state.running?.job.taskId === taskId || state.queue.some((j) => j.taskId === taskId)) {
      throw new Error('this task already has a turn in progress');
    }
    const row = this.opts.store.setStatus(taskId, 'queued');
    this.emit('task', row);
    this.enqueue(state, { taskId, text });
    return row;
  }

  getTask(taskId: string): TaskRow {
    const task = this.opts.store.getTask(taskId);
    if (!task) throw new Error(`unknown task "${taskId}"`);
    return task;
  }

  /**
   * Starts a task for `targetId` on behalf of a running task. The parent agent must list the
   * target in `delegates`, and the target must not already work on an ancestor of this task:
   * that agent would wait for itself.
   */
  delegate(parent: TaskRow, parentAgent: ResolvedAgent, targetId: string, text: string): TaskRow {
    if (!parentAgent.delegates.includes(targetId)) {
      throw new Error(`@${parentAgent.id} may not delegate to @${targetId}; see list_agents`);
    }
    if (parent.depth + 1 > DELEGATION.maxDepth) {
      throw new Error(`delegation is limited to ${DELEGATION.maxDepth} levels`);
    }
    if (this.opts.store.children(parent.id).length >= DELEGATION.maxChildren) {
      throw new Error(`a task may start at most ${DELEGATION.maxChildren} delegated tasks`);
    }
    if (this.opts.store.treeTurns(parent.rootId) >= DELEGATION.maxTreeTurns) {
      throw new Error(`this task tree used its ${DELEGATION.maxTreeTurns} turns`);
    }
    for (
      let t: TaskRow | undefined = parent;
      t;
      t = t.parentId ? this.opts.store.getTask(t.parentId) : undefined
    ) {
      if (t.agentId === targetId) {
        throw new Error(`@${targetId} is already working on a task above this one`);
      }
    }
    const state = this.state(targetId);
    if (!state.agent) throw new Error(`agent "${targetId}" has a config error: ${state.error}`);
    if (!text.trim()) throw new Error('empty task');
    const task = this.opts.store.createTask({
      agentId: targetId,
      trigger: 'delegation',
      title: text,
      parent,
    });
    this.emit('task', task);
    this.record(parent, { type: 'notice', text: `↳ delegated to @${targetId} as ${task.id}` });
    this.enqueue(state, { taskId: task.id, text });
    return task;
  }

  /**
   * How a task came to exist, root first: `you`, `schedule`, `poll`, then each delegation,
   * e.g. `poll → @lead (t-1) → @developer (t-2)`.
   */
  origin(taskId: string): string {
    const chain: TaskRow[] = [];
    for (let t = this.opts.store.getTask(taskId); t && chain.length < 10;) {
      chain.unshift(t);
      t = t.parentId ? this.opts.store.getTask(t.parentId) : undefined;
    }
    if (!chain.length) return '';
    const root = chain[0]!.trigger === 'user' ? 'you' : chain[0]!.trigger;
    return [root, ...chain.map((t) => `@${t.agentId} (${t.id})`)].join(' → ');
  }

  /** A line from Anchi in a task's transcript (approvals, delegation). */
  notice(taskId: string, text: string): void {
    const task = this.opts.store.getTask(taskId);
    if (task) this.record(task, { type: 'notice', text: text.slice(0, 2000) });
  }

  /**
   * Deletes a task with the tasks it delegated (and theirs), once none of them is running.
   * The task's cell, if still idle, goes too.
   */
  async deleteTask(taskId: string): Promise<number> {
    const task = this.getTask(taskId);
    const ids: string[] = [];
    const walk = (t: TaskRow) => {
      if (t.status === 'running' || t.status === 'queued') {
        throw new Error(`${t.id} is still ${t.status}; cancel it first`);
      }
      ids.push(t.id);
      for (const child of this.opts.store.children(t.id)) walk(child);
    };
    walk(task);
    await Promise.all(ids.map((id) => this.closeCell(id, 'task deleted')));
    return this.opts.store.deleteTasks(ids);
  }

  /** Deletes finished tasks older than `days`; their cells are long gone. */
  purge(days: number, now = Date.now()): number {
    return this.opts.store.deleteTasks(this.opts.store.finishedBefore(now - days * 86_400_000));
  }

  children(taskId: string): TaskRow[] {
    return this.opts.store.children(taskId);
  }

  cancelTask(taskId: string): void {
    const task = this.getTask(taskId);
    // Delegated work goes with the task that asked for it.
    for (const child of this.opts.store.children(taskId)) {
      if (child.status === 'running' || child.status === 'queued') this.cancelTask(child.id);
    }
    const state = this.states.get(task.agentId);
    if (state) {
      const before = state.queue.length;
      state.queue = state.queue.filter((j) => j.taskId !== taskId);
      if (state.running?.job.taskId === taskId) state.running.controller.abort();
      else if (before !== state.queue.length) this.finish(taskId, 'cancelled', 'cancelled');
    }
    this.closeCell(taskId, 'task cancelled');
    if (task.status === 'done' || task.status === 'failed') return;
    if (!state?.running || state.running.job.taskId !== taskId) {
      this.finish(taskId, 'cancelled', 'cancelled');
    }
  }

  /**
   * Every task of an agent with the tasks they delegated, whoever ran them: what deleting the
   * agent deletes.
   */
  agentTaskTree(agentId: string): TaskRow[] {
    const out = new Map<string, TaskRow>();
    const walk = (t: TaskRow) => {
      if (out.has(t.id)) return;
      out.set(t.id, t);
      for (const child of this.opts.store.children(t.id)) walk(child);
    };
    for (const id of this.opts.store.taskIdsOfAgent(agentId)) walk(this.getTask(id));
    return [...out.values()];
  }

  /**
   * Deletes an agent's task tree (see `agentTaskTree`), cancelling running and queued tasks
   * first and closing their cells. A surviving task that had delegated one of them gets a
   * notice. Returns how many tasks went.
   */
  async deleteAgentTasks(agentId: string): Promise<number> {
    const tasks = this.agentTaskTree(agentId);
    const ids = new Set(tasks.map((t) => t.id));
    const busy = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
    for (const t of busy) this.cancelTask(t.id);
    const settle = (id: string) =>
      Promise.race([this.wait(id), new Promise((r) => setTimeout(r, 60_000).unref())]);
    await Promise.all(busy.map((t) => settle(t.id)));
    await Promise.all([...ids].map((id) => this.closeCell(id, `@${agentId} deleted`)));
    for (const t of tasks) {
      if (t.parentId && !ids.has(t.parentId)) {
        this.notice(
          t.parentId,
          `delegated task ${t.id} (@${t.agentId}) was deleted with @${agentId}`,
        );
      }
    }
    return this.opts.store.deleteTasks([...ids]);
  }

  /** Resolves when the task's current turn ends. */
  wait(taskId: string): Promise<TaskRow> {
    const task = this.getTask(taskId);
    if (task.status !== 'queued' && task.status !== 'running') return Promise.resolve(task);
    return new Promise((resolve) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push(resolve);
      this.waiters.set(taskId, list);
    });
  }

  private enqueue(state: AgentState, job: Job) {
    state.queue.push(job);
    this.emitAgents();
    void this.pump(state);
  }

  private async pump(state: AgentState): Promise<void> {
    if (state.running) return;
    const job = state.queue.shift();
    if (!job) return;
    const controller = new AbortController();
    state.running = { job, controller };
    this.emitAgents();
    try {
      await this.execute(state, job, controller.signal);
    } catch (err) {
      this.log(`task ${job.taskId}: ${(err as Error).message}`);
    }
    state.running = undefined;
    this.emitAgents();
    void this.pump(state);
  }

  private record(task: TaskRow, event: RuntimeEvent): void {
    if (event.type === 'usage')
      this.opts.store.addUsage(task.id, event.inputTokens, event.outputTokens);
    const seq =
      event.type === 'text.delta' ? undefined : this.opts.store.appendEvent(task.id, event);
    this.emit('event', { taskId: task.id, agentId: task.agentId, seq, event });
  }

  private finish(taskId: string, status: 'done' | 'failed' | 'cancelled', result?: string) {
    if (result !== undefined) this.opts.store.setResult(taskId, result);
    const row = this.opts.store.setStatus(taskId, status);
    this.emit('task', row);
    if (status === 'done') this.emit('turnEnded', { task: row, reply: result ?? '' });
    if (row.parentId) {
      const parent = this.opts.store.getTask(row.parentId);
      const outcome = row.links[0] ?? (row.result ?? '').replace(/\s+/g, ' ').slice(0, 120);
      if (parent)
        this.record(parent, {
          type: 'notice',
          text: `↳ ${row.id} (@${row.agentId}) ${status}: ${outcome}`,
        });
    }
    for (const resolve of this.waiters.get(taskId) ?? []) resolve(row);
    this.waiters.delete(taskId);
  }

  private async execute(state: AgentState, job: Job, signal: AbortSignal): Promise<void> {
    let task = this.getTask(job.taskId);
    const agent = this.resolve(state.id);
    state.agent = agent;
    if (task.depth > 0 && this.opts.store.treeTurns(task.rootId) >= DELEGATION.maxTreeTurns) {
      return this.finish(
        task.id,
        'failed',
        `this task tree used its ${DELEGATION.maxTreeTurns} turns`,
      );
    }
    this.opts.store.countTurn(task.id);
    task = this.opts.store.setStatus(task.id, 'running');
    this.emit('task', task);
    this.record(task, {
      type: 'input',
      text: job.text.slice(0, 64_000),
      source: task.trigger === 'user' ? 'user' : 'task',
    });

    let reply = '';
    let failure: string | undefined;
    let timedOut = false;
    let before = new Map<string, Snapshot>();
    try {
      const hash = await this.ensureImage(agent, task);
      await this.syncSkills(agent);
      before = this.snapshotWorkspaces(agent);
      if (signal.aborted) throw new Error('cancelled');
      const cell = await this.cellFor(task, agent, hash);
      const turnId = `turn-${Date.now().toString(36)}`;
      const onAbort = () => cell.session.cancel(turnId);
      signal.addEventListener('abort', onAbort, { once: true });
      const limit = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        cell.session.cancel(turnId);
        // A runner that ignores the cancel loses its cell.
        setTimeout(() => this.closeCell(task.id, 'turn timed out'), 10_000).unref();
      }, limit);
      const prompt = instructions(agent);
      // Without the extra context the turn still runs, on the user's text alone.
      const input = this.opts.turnInput
        ? await Promise.resolve()
            .then(() => this.opts.turnInput!(agent, job.text))
            .catch(() => job.text)
        : job.text;
      try {
        for await (const event of cell.session.run({
          turn: turnId,
          input,
          resumeId: task.resumeId ?? undefined,
          options: {
            model: agent.model,
            effort: agent.effort,
            instructions: prompt.text,
            instructionsMode: prompt.mode,
            sandbox: agent.sandbox,
            workdir: WORKDIR,
          },
        })) {
          if (event.type === 'session.started') {
            this.opts.store.setResumeId(task.id, event.resumeId);
            task = { ...task, resumeId: event.resumeId };
          }
          if (event.type === 'message') reply = event.text;
          if (event.type === 'error' && event.fatal) failure = event.message;
          this.record(task, event);
        }
      } finally {
        clearTimeout(timer);
        this.auditWorkspaces(agent, task, before);
        signal.removeEventListener('abort', onAbort);
        cell.lastUsed = Date.now();
        this.armIdle(task.id);
      }
    } catch (err) {
      failure = signal.aborted ? 'cancelled' : (err as Error).message;
      this.record(task, { type: 'error', message: failure.slice(0, 60_000), fatal: true });
    }
    if (signal.aborted) {
      this.closeCell(task.id, 'task cancelled');
      return this.finish(task.id, 'cancelled', reply || 'cancelled');
    }
    if (timedOut) {
      const minutes = Math.round((this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60_000);
      const message = `turn timed out after ${minutes} min`;
      this.record(task, { type: 'error', message, fatal: true });
      return this.finish(task.id, 'failed', reply ? `${reply}\n\n(${message})` : message);
    }
    if (failure !== undefined && !reply) return this.finish(task.id, 'failed', failure);
    this.finish(task.id, failure === undefined ? 'done' : 'failed', reply || failure || '');
  }

  // ── images and cells ─────────────────────────────────────

  private skillDigests = new Map<string, string>();

  private workspaceDirs(agent: ResolvedAgent): [string, string][] {
    const root = this.opts.workspaceRoot;
    if (!root) return [];
    return agent.workspaces
      .filter((w) => w.mode === 'rw')
      .map((w) => [workspaceName(w), join(root, ...w.path.split('/'))]);
  }

  private snapshotWorkspaces(agent: ResolvedAgent): Map<string, Snapshot> {
    return new Map(this.workspaceDirs(agent).map(([name, dir]) => [name, snapshot(dir)]));
  }

  /** Reports code-running paths a turn added to writable workspaces (see workspace-audit). */
  private auditWorkspaces(agent: ResolvedAgent, task: TaskRow, before: Map<string, Snapshot>) {
    for (const [name, dir] of this.workspaceDirs(agent)) {
      const was = before.get(name);
      if (!was) continue;
      for (const finding of audit(dir, was, snapshot(dir)).slice(0, 20)) {
        this.record(task, { type: 'notice', text: `⚠ workspace ${name}: ${finding}` });
      }
    }
  }

  /** Sends the agent's skills to the VM when they changed since the last cell. */
  private async syncSkills(agent: ResolvedAgent): Promise<void> {
    if (!this.opts.skills) return;
    if (!agent.skills.length && !this.skillDigests.has(agent.id)) return;
    const { files, digest } = this.opts.skills.bundle(agent.skills);
    if (this.skillDigests.get(agent.id) === digest) return;
    await this.opts.guest.setSkills(agent.id, agent.skills.length ? files : {});
    this.skillDigests.set(agent.id, digest);
  }

  private async ensureImage(agent: ResolvedAgent, task: TaskRow): Promise<string> {
    const image = loadImage(agent.image, this.opts.layout);
    const build = async (
      id: string,
      hash: string,
      recipe?: { packages: string[]; run: string[] },
    ) => {
      const key = `${id}@${hash}`;
      let pending = this.builds.get(key);
      if (!pending) {
        pending = (async () => {
          if (await this.opts.guest.imageStatus(id, hash)) return;
          this.record(task, {
            type: 'notice',
            text: `Building image "${id}"; this can take a few minutes.`,
          });
          const meta = await this.opts.guest.buildImage(id, hash, recipe);
          this.record(task, {
            type: 'notice',
            text: `Image "${id}" built in ${meta.seconds}s (${Math.round(meta.size / 1e6)} MB).`,
          });
        })().finally(() => this.builds.delete(key));
        this.builds.set(key, pending);
      }
      await pending;
    };
    await build(BASE_IMAGE, 'base');
    if (image.id !== BASE_IMAGE) {
      await build(image.id, image.hash, { packages: image.recipe.packages, run: image.recipe.run });
    }
    return image.hash;
  }

  private async cellFor(task: TaskRow, agent: ResolvedAgent, hash: string): Promise<LiveCell> {
    const key = cellKey(agent, hash);
    const existing = this.cells.get(task.id);
    if (existing && !existing.session.closed && existing.key === key) {
      clearTimeout(existing.idle);
      return existing;
    }
    if (existing) await this.closeCell(task.id, 'agent settings changed');
    // The guest limits concurrent cells; make room by closing the longest-idle one.
    if (this.cells.size >= MAX_CELLS) {
      const idle = [...this.cells.entries()]
        .filter(([, c]) => c.idle)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) await this.closeCell(idle[0], 'making room for another task');
    }
    const child = this.opts.guest.startCell({
      task: task.id,
      agent: agent.id,
      image: agent.image,
      hash,
      connectors: agent.connectors,
      sandbox: agent.sandbox,
      runtime: agent.runtime,
      ask: Object.entries(agent.approvals)
        .filter(([, mode]) => mode === 'ask')
        .map(([connector]) => connector),
      workspaces: agent.workspaces.map((w) => ({
        name: workspaceName(w),
        path: w.path,
        mode: w.mode,
      })),
      egress: agent.egress,
    });
    const session = new CellSession(task.id, child);
    // The cell belongs to this task; its tool calls act as this task's agent.
    session.toolHandler = ({ tool, args }) =>
      this.tools.call({ task: this.getTask(task.id), agent: this.resolve(agent.id) }, tool, args);
    const cell: LiveCell = { session, agentId: agent.id, key, lastUsed: Date.now() };
    this.cells.set(task.id, cell);
    session.on('exit', (reason) => {
      if (this.cells.get(task.id) === cell) this.cells.delete(task.id);
      clearTimeout(cell.idle);
      this.log(`cell ${task.id} ended: ${reason}`);
    });
    const version = await session.ready;
    this.log(`cell ${task.id} ready (${version})`);
    return cell;
  }

  private armIdle(taskId: string) {
    const cell = this.cells.get(taskId);
    if (!cell) return;
    clearTimeout(cell.idle);
    cell.idle = setTimeout(
      () => this.closeCell(taskId, 'idle timeout'),
      this.opts.idleMs ?? IDLE_MS,
    );
    cell.idle.unref();
  }

  /**
   * Closes a task's cell. A live cell is scanned for real credential values first (the
   * credential invariant, checked on every cell rather than on request); the result goes to
   * the task's transcript, and a finding is reported. No longer reusable from the start.
   */
  closeCell(taskId: string, reason: string): Promise<void> {
    const cell = this.cells.get(taskId);
    if (!cell) return Promise.resolve();
    clearTimeout(cell.idle);
    this.cells.delete(taskId);
    const closing = this.scanBeforeClose(taskId, cell).finally(() => {
      cell.session.close(reason);
      this.closing.delete(closing);
    });
    this.closing.add(closing);
    return closing;
  }

  private closing = new Set<Promise<void>>();

  private async scanBeforeClose(taskId: string, cell: LiveCell): Promise<void> {
    if (this.opts.scanOnClose === false || cell.session.closed) return;
    const task = this.opts.store.getTask(taskId);
    if (!task) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), SCAN_TIMEOUT_MS);
    });
    try {
      const r = await Promise.race([this.opts.guest.scan(taskId), timeout]);
      if (!this.opts.store.getTask(taskId)) return; // deleted meanwhile
      if (r.clean) {
        this.record(task, {
          type: 'notice',
          text: `credential scan before closing the cell: clean (${r.files} files)`,
        });
      } else {
        const labels = [
          ...new Set(
            (r.findings as { credential?: unknown; where?: unknown }[]).map(
              (f) =>
                `${String(f.credential ?? 'credential').slice(0, 40)} in ${String(f.where ?? '?').slice(0, 80)}`,
            ),
          ),
        ].slice(0, 10);
        this.record(task, {
          type: 'error',
          message: `credential scan before closing the cell found real credential values: ${labels.join(', ')}`,
          fatal: false,
        });
        this.emit('scanFinding', { taskId, agentId: task.agentId, labels });
      }
    } catch (err) {
      if (!this.opts.store.getTask(taskId)) return;
      this.record(task, {
        type: 'notice',
        text: `credential scan before closing the cell did not complete: ${(err as Error).message}`.slice(
          0,
          500,
        ),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Marks tasks interrupted by a daemon restart as failed; their cells were reaped. */
  recoverInterrupted(): void {
    for (const task of this.opts.store.interrupted()) {
      this.record(task, {
        type: 'error',
        message: 'The daemon stopped while this task was running; send a follow-up to continue.',
        fatal: true,
      });
      this.finish(task.id, 'failed', 'interrupted by a daemon restart');
    }
  }

  /** Closes every cell, waiting for their scans up to SHUTDOWN_SCAN_MS. */
  async shutdown(): Promise<void> {
    for (const id of [...this.cells.keys()]) void this.closeCell(id, 'daemon stopping');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.closing]),
      new Promise((r) => (timer = setTimeout(r, SHUTDOWN_SCAN_MS))),
    ]);
    clearTimeout(timer);
  }
}
