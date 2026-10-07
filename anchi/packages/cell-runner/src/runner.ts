import { mkdirSync } from 'node:fs';
import {
  type CellCommand,
  cellCommandSchema,
  type CellMessage,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type RuntimeEvent,
  truncate,
  MAX_EVENT_TEXT,
} from '@anchi/protocol';

export type RunTurn = (turn: {
  input: string;
  resumeId?: string;
  options: Extract<CellCommand, { type: 'run' }>['options'];
  signal: AbortSignal;
}) => AsyncIterable<RuntimeEvent>;

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
export function startRunner(io: RunnerIO, runTurn: RunTurn, version: string): void {
  let current: { turn: string; controller: AbortController } | undefined;
  const send = (message: CellMessage) => io.write(encodeFrame(message));

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
    io.exit(0);
  });
  send({ type: 'ready', protocol: PROTOCOL_VERSION, runtime: 'codex', version });
}
