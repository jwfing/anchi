import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  CELL_MAX_FRAME_BYTES,
  type CellCommand,
  type CellMessage,
  cellMessageSchema,
  encodeFrame,
  FrameDecoder,
  type RuntimeEvent,
  type TurnOptions,
} from '@anchi/protocol';

/** Bytes of runner output accepted per turn before the cell is ended. */
export const TURN_MAX_BYTES = 64 * 1024 * 1024;
export const READY_TIMEOUT_MS = 90_000;
export const TURN_TIMEOUT_MS = 60 * 60_000;
const STDERR_KEEP = 8 * 1024;
/** What the user can do about guest errors that stop a cell from starting. */
const START_HINTS: Record<string, string> = {
  CODEX_NOT_CONFIGURED: 'run `anchi setup codex` (Runtimes → i in the TUI)',
  CLAUDE_NOT_CONFIGURED:
    'run `claude setup-token` on this Mac, then `anchi setup claude` (Runtimes → c in the TUI)',
  BASE_IMAGE_NOT_BUILT: 'run `anchi setup install`',
  TOO_MANY_CELLS: 'too many tasks are running; try again when one finishes',
  EGRESS_UNAVAILABLE: 'the egress proxy is not running; run `anchi setup install`',
};

/** Anchi tool calls one turn may make; a limit on runaway loops, not a security control. */
export const TURN_MAX_TOOL_CALLS = 200;

export interface ToolCall {
  turn: string;
  tool: string;
  args: Record<string, unknown>;
}
export type ToolHandler = (call: ToolCall) => Promise<Record<string, unknown>>;

export interface TurnRequest {
  turn: string;
  input: string;
  resumeId?: string;
  options: TurnOptions;
}

type TurnState = {
  turn: string;
  push(event: RuntimeEvent): void;
  end(ok: boolean, reason?: string): void;
};

/**
 * Daemon side of one task cell. The runner is untrusted: every frame is size-limited and
 * schema-checked, events must belong to the turn in progress, and the first violation ends
 * the cell.
 */
export class CellSession extends EventEmitter<{ exit: [string] }> {
  private decoder: FrameDecoder;
  private current?: TurnState;
  private turnBytes = 0;
  private turnToolCalls = 0;
  /** Answers the in-cell MCP server's calls; set by the hub, which knows the task and agent. */
  toolHandler?: ToolHandler;
  private stderr = '';
  private readyResolve?: (version: string) => void;
  private readyReject?: (err: Error) => void;
  readonly ready: Promise<string>;
  closed = false;
  exitReason = '';

  constructor(
    readonly task: string,
    private child: ChildProcessWithoutNullStreams,
    readyTimeoutMs = READY_TIMEOUT_MS,
  ) {
    super();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
    const timer = setTimeout(() => this.fail('cell runner did not start in time'), readyTimeoutMs);
    void this.ready.finally(() => clearTimeout(timer)).catch(() => {});
    this.decoder = new FrameDecoder(
      CELL_MAX_FRAME_BYTES,
      (value) => this.onFrame(value),
      (err) => this.fail(`runner protocol error: ${err.message}`),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      this.turnBytes += chunk.length;
      if (this.current && this.turnBytes > TURN_MAX_BYTES) {
        return this.fail('runner exceeded the per-turn output limit');
      }
      this.decoder.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('close', (code) => this.onExit(code));
    child.on('error', (err) => this.fail(`cannot start cell: ${err.message}`));
    child.stdin.on('error', () => {});
  }

  /** Last lines of the cell manager's stderr, plus a guest error code if it printed one. */
  diagnostics(): string {
    return this.stderr.trim().split('\n').slice(-5).join('\n');
  }

  private onFrame(value: unknown) {
    // The guest manager prints {"error": CODE} on stdout when it fails before the runner starts.
    if (
      !this.closed &&
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      !('type' in value)
    ) {
      const code = String((value as { error: unknown }).error);
      return this.fail(
        `cell start failed: ${code}${START_HINTS[code] ? ` — ${START_HINTS[code]}` : ''}`,
      );
    }
    const parsed = cellMessageSchema.safeParse(value);
    if (!parsed.success) return this.fail('runner sent an invalid message');
    const msg: CellMessage = parsed.data;
    if (msg.type === 'ready') {
      this.readyResolve?.(msg.version);
      return;
    }
    if (!this.current || msg.turn !== this.current.turn) {
      return this.fail('runner sent a message for a turn that is not running');
    }
    if (msg.type === 'event') this.current.push(msg.event);
    else if (msg.type === 'tool.request') void this.onTool(msg);
    else this.current.end(msg.ok);
  }

  private async onTool(msg: Extract<CellMessage, { type: 'tool.request' }>) {
    const answer = (r: { ok: boolean; result?: Record<string, unknown>; error?: string }) =>
      this.send({ type: 'tool.response', id: msg.id, ...r });
    if (++this.turnToolCalls > TURN_MAX_TOOL_CALLS) {
      return answer({
        ok: false,
        error: `more than ${TURN_MAX_TOOL_CALLS} Anchi tool calls in one turn`,
      });
    }
    if (!this.toolHandler) return answer({ ok: false, error: 'no Anchi tools in this cell' });
    try {
      answer({ ok: true, result: await this.toolHandler(msg) });
    } catch (err) {
      answer({ ok: false, error: String((err as Error).message).slice(0, 2000) });
    }
  }

  private send(cmd: CellCommand) {
    if (!this.closed) this.child.stdin.write(encodeFrame(cmd));
  }

  /** Runs one turn; yields its events. Throws if the cell dies or misbehaves. */
  async *run(req: TurnRequest, timeoutMs = TURN_TIMEOUT_MS): AsyncGenerator<RuntimeEvent> {
    await this.ready;
    if (this.current) throw new Error('a turn is already running in this cell');
    if (this.closed) throw new Error(`cell is closed: ${this.exitReason}`);
    const queue: RuntimeEvent[] = [];
    let done: { ok: boolean; reason?: string } | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    this.turnBytes = 0;
    this.turnToolCalls = 0;
    this.current = {
      turn: req.turn,
      push: (e) => {
        queue.push(e);
        notify();
      },
      end: (ok, reason) => {
        done = { ok, reason };
        notify();
      },
    };
    const timer = setTimeout(() => {
      this.cancel(req.turn);
      this.current?.end(false, 'turn timed out');
    }, timeoutMs);
    this.send({
      type: 'run',
      turn: req.turn,
      input: req.input,
      resumeId: req.resumeId,
      options: req.options,
    });
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((r) => (wake = r));
      }
      if (done.reason) throw new Error(done.reason);
    } finally {
      clearTimeout(timer);
      this.current = undefined;
    }
  }

  cancel(turn: string): void {
    this.send({ type: 'cancel', turn });
  }

  /** Ends the runner (and so the cell) by closing its input. */
  close(reason = 'closed'): void {
    if (this.closed) return;
    this.exitReason = reason;
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 15_000).unref();
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.exitReason = reason;
    this.readyReject?.(new Error(reason));
    this.current?.end(false, reason);
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }

  private onExit(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    const reason =
      this.exitReason ||
      `cell exited (${code ?? 'signal'})${this.diagnostics() ? `: ${this.diagnostics()}` : ''}`;
    this.exitReason = reason;
    this.readyReject?.(new Error(reason));
    this.current?.end(false, reason);
    this.emit('exit', reason);
  }
}
