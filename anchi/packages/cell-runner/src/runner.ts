import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import {
  type CellCommand,
  cellCommandSchema,
  type CellMessage,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type RuntimeEvent,
  type RuntimeId,
  truncate,
  MAX_EVENT_TEXT,
} from '@anchi/protocol';
import { TOOLS_SOCKET } from './paths.ts';

export type RunTurn = (turn: {
  input: string;
  resumeId?: string;
  options: Extract<CellCommand, { type: 'run' }>['options'];
  signal: AbortSignal;
}) => AsyncIterable<RuntimeEvent>;

export { TOOLS_SOCKET };
const MAX_PENDING_TOOLS = 8;

export interface RunnerIO {
  write(frame: string): void;
  onData(cb: (chunk: Buffer) => void): void;
  onEnd(cb: () => void): void;
  exit(code: number): void;
  log(message: string): void;
}

/**
 * The cell runner's loop: one turn at a time, events out as frames, cancellation by turn id.
 * Commands come from the daemon; the runner still validates them.
 */
export function startRunner(
  io: RunnerIO,
  runTurn: RunTurn,
  version: string,
  runtime: RuntimeId = 'codex',
  toolsSocket: string | null = TOOLS_SOCKET,
): void {
  let current: { turn: string; controller: AbortController } | undefined;
  const send = (message: CellMessage) => io.write(encodeFrame(message));
  // Tool calls waiting for the daemon, by call id.
  const pending = new Map<string, (r: { ok: boolean; result?: unknown; error?: string }) => void>();
  let nextCall = 0;

  /** Relays one tool call to the daemon, tagged with the turn in progress. */
  const callTool = (tool: string, args: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      if (!current) return resolve({ ok: false, error: 'no turn is running' });
      // A malformed frame would end the cell; refuse it here instead.
      if (!/^[a-z][a-z0-9_.]{0,63}$/.test(tool))
        return resolve({ ok: false, error: 'unknown tool' });
      if (Array.isArray(args)) return resolve({ ok: false, error: 'arguments must be an object' });
      if (pending.size >= MAX_PENDING_TOOLS)
        return resolve({ ok: false, error: 'too many tool calls at once' });
      const id = `c${++nextCall}`;
      pending.set(id, resolve);
      send({ type: 'tool.request', turn: current.turn, id, tool, args });
    });
  let tools: Server | undefined;
  if (toolsSocket) tools = serveTools(toolsSocket, callTool, io.log);

  const execute = async (cmd: Extract<CellCommand, { type: 'run' }>) => {
    const controller = new AbortController();
    current = { turn: cmd.turn, controller };
    let ok = true;
    try {
      mkdirSync(cmd.options.workdir, { recursive: true });
      for await (const event of runTurn({
        input: cmd.input,
        resumeId: cmd.resumeId,
        options: cmd.options,
        signal: controller.signal,
      })) {
        if (event.type === 'error' && event.fatal) ok = false;
        send({ type: 'event', turn: cmd.turn, event });
      }
    } catch (err) {
      ok = false;
      const message = controller.signal.aborted
        ? 'interrupted'
        : String((err as Error).message ?? err);
      send({
        type: 'event',
        turn: cmd.turn,
        event: { type: 'error', message: truncate(message, MAX_EVENT_TEXT), fatal: true },
      });
    } finally {
      current = undefined;
      // Calls still waiting belong to the turn that ended.
      for (const resolve of pending.values()) resolve({ ok: false, error: 'the turn ended' });
      pending.clear();
      send({ type: 'turn.end', turn: cmd.turn, ok: ok && !controller.signal.aborted });
    }
  };

  const decoder = new FrameDecoder(
    1024 * 1024,
    (value) => {
      const parsed = cellCommandSchema.safeParse(value);
      if (!parsed.success) {
        io.log('invalid command; exiting');
        return io.exit(2);
      }
      const cmd = parsed.data;
      if (cmd.type === 'tool.response') {
        const resolve = pending.get(cmd.id);
        pending.delete(cmd.id);
        resolve?.({ ok: cmd.ok, result: cmd.result, error: cmd.error });
        return;
      }
      if (cmd.type === 'cancel') {
        if (current?.turn === cmd.turn) current.controller.abort();
        return;
      }
      if (current) {
        send({
          type: 'event',
          turn: cmd.turn,
          event: { type: 'error', message: 'a turn is already running', fatal: true },
        });
        send({ type: 'turn.end', turn: cmd.turn, ok: false });
        return;
      }
      void execute(cmd);
    },
    (err) => {
      io.log(`protocol error: ${err.message}`);
      io.exit(2);
    },
  );
  io.onData((chunk) => decoder.push(chunk));
  io.onEnd(() => {
    // The daemon closed the channel: idle timeout or task cancelled. The cell ends with us.
    current?.controller.abort();
    tools?.close();
    io.exit(0);
  });
  send({ type: 'ready', protocol: PROTOCOL_VERSION, runtime, version });
}

/**
 * Serves the in-cell MCP server: one JSON line per request (`{tool, args}`), one per answer.
 * Anything in the cell can connect; the daemon decides what each call may do.
 */
function serveTools(
  path: string,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  log: (m: string) => void,
): Server {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 256 * 1024) return conn.destroy();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let req: { tool?: unknown; args?: unknown };
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          conn.write(`${JSON.stringify({ ok: false, error: 'bad request' })}\n`);
          continue;
        }
        const args =
          req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {};
        void call(String(req.tool), args).then((r) => conn.write(`${JSON.stringify(r)}\n`));
      }
    });
    conn.on('error', () => {});
  });
  server.on('error', (err) => log(`tool socket: ${err.message}`));
  server.listen(path);
  return server;
}
