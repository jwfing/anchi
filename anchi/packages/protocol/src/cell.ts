import { z } from 'zod';
import { runtimeEventSchema } from './events.ts';

/**
 * Daemon ⇄ cell runner. The runner's stdin and stdout are the control channel: the guest
 * cell manager connects them to the cell's console, and the daemon reaches them through the
 * fixed `anchi-cell start` command. One runner serves one task and runs one turn at a time.
 */

export const PROTOCOL_VERSION = 2;

export const runtimeIdSchema = z.enum(['codex', 'claude-code']);
export type RuntimeId = z.infer<typeof runtimeIdSchema>;

/** Name of an Anchi tool the in-cell MCP server offers (delegation, task status, connectors). */
const toolName = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const callId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Tool arguments and results stay small: they are JSON, bounded like events. */
const toolPayload = z.record(z.string(), z.unknown());

const turnId = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const turnOptionsSchema = z.strictObject({
  model: z.string().max(100).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  /** Replaces the runtime's base instructions, or is added to them. */
  instructions: z.string().max(200_000).optional(),
  instructionsMode: z.enum(['replace', 'append']).default('append'),
  /** `cell`: the cell is the only boundary. `codex-workspace-write`: Codex's own sandbox too. */
  sandbox: z.enum(['cell', 'codex-workspace-write']).default('cell'),
  /** Absolute path inside the cell. */
  workdir: z.string().startsWith('/').max(1000),
});
export type TurnOptions = z.infer<typeof turnOptionsSchema>;

/** Daemon → runner. */
export const cellCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('run'),
    turn: turnId,
    input: z.string().min(1).max(200_000),
    /** Runtime thread to continue. */
    resumeId: z.string().max(200).optional(),
    options: turnOptionsSchema,
  }),
  z.strictObject({ type: z.literal('cancel'), turn: turnId }),
  /** The daemon's answer to a `tool.request`. */
  z.strictObject({
    type: z.literal('tool.response'),
    id: callId,
    ok: z.boolean(),
    result: toolPayload.optional(),
    error: z.string().max(2000).optional(),
  }),
]);
export type CellCommand = z.infer<typeof cellCommandSchema>;

/** Runner → daemon. Untrusted: the daemon validates every frame and closes on the first error. */
export const cellMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    protocol: z.literal(PROTOCOL_VERSION),
    runtime: runtimeIdSchema,
    version: z.string().max(100),
  }),
  z.strictObject({ type: z.literal('event'), turn: turnId, event: runtimeEventSchema }),
  z.strictObject({ type: z.literal('turn.end'), turn: turnId, ok: z.boolean() }),
  /** An Anchi tool call from the in-cell MCP server, relayed by the runner. */
  z.strictObject({
    type: z.literal('tool.request'),
    turn: turnId,
    id: callId,
    tool: toolName,
    args: toolPayload,
  }),
]);
export type CellMessage = z.infer<typeof cellMessageSchema>;
