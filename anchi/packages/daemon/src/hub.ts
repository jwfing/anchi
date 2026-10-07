import { EventEmitter } from 'node:events';
import {
  agentFile,
  BASE_IMAGE,
  type HomeLayout,
  listAgentIds,
  loadImage,
  type ResolvedAgent,
  resolveAgent,
} from '@anchi/core';
import type { AgentStatus, AgentSummary, RuntimeEvent, TaskRow } from '@anchi/protocol';
import { CellSession } from './cell.ts';
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

export interface HubOptions {
  layout: HomeLayout;
  store: Store;
  guest: Guest;
  idleMs?: number;
  /** Longest a single turn may run before it is cancelled and the task fails. */
  turnTimeoutMs?: number;
  log?(msg: string): void;
  /** Agents defined by Anchi itself (the builder); their ids are reserved. */
  builtins?: ResolvedAgent[];
}

export interface HubEvents {
  event: [{ taskId: string; agentId: string; seq?: number; event: RuntimeEvent }];
  task: [TaskRow];
  agents: [AgentSummary[]];
  /** A turn ended; `reply` is the final message (agent-originated). */
  turnEnded: [{ task: TaskRow; reply: string }];
}

function cellKey(agent: ResolvedAgent, imageHash: string): string {
  return JSON.stringify([agent.runtime, agent.image, imageHash, agent.connectors, agent.sandbox]);
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
    this.tools = new ToolDispatcher({ agents: () => this.summaries() });
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

  private state(agentId: string): AgentState {
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

  cancelTask(taskId: string): void {
    const task = this.getTask(taskId);
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
    const seq =
      event.type === 'text.delta' ? undefined : this.opts.store.appendEvent(task.id, event);
    this.emit('event', { taskId: task.id, agentId: task.agentId, seq, event });
  }

  private finish(taskId: string, status: 'done' | 'failed' | 'cancelled', result?: string) {
    if (result !== undefined) this.opts.store.setResult(taskId, result);
    const row = this.opts.store.setStatus(taskId, status);
    this.emit('task', row);
    if (status === 'done') this.emit('turnEnded', { task: row, reply: result ?? '' });
    for (const resolve of this.waiters.get(taskId) ?? []) resolve(row);
    this.waiters.delete(taskId);
  }

  private async execute(state: AgentState, job: Job, signal: AbortSignal): Promise<void> {
    let task = this.getTask(job.taskId);
    const agent = this.resolve(state.id);
    state.agent = agent;
    task = this.opts.store.setStatus(task.id, 'running');
    this.emit('task', task);
    this.record(task, { type: 'input', text: job.text.slice(0, 64_000), source: 'user' });

    let reply = '';
    let failure: string | undefined;
    let timedOut = false;
    try {
      const hash = await this.ensureImage(agent, task);
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
      try {
        for await (const event of cell.session.run({
          turn: turnId,
          input: job.text,
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
    if (existing) this.closeCell(task.id, 'agent settings changed');
    // The guest limits concurrent cells; make room by closing the longest-idle one.
    if (this.cells.size >= MAX_CELLS) {
      const idle = [...this.cells.entries()]
        .filter(([, c]) => c.idle)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) this.closeCell(idle[0], 'making room for another task');
    }
    const child = this.opts.guest.startCell({
      task: task.id,
      agent: agent.id,
      image: agent.image,
      hash,
      connectors: agent.connectors,
      sandbox: agent.sandbox,
      runtime: agent.runtime,
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

  closeCell(taskId: string, reason: string): void {
    const cell = this.cells.get(taskId);
    if (!cell) return;
    clearTimeout(cell.idle);
    this.cells.delete(taskId);
    cell.session.close(reason);
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

  shutdown(): void {
    for (const id of [...this.cells.keys()]) this.closeCell(id, 'daemon stopping');
  }
}
