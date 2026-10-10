import { z } from 'zod';

/** Longest text the daemon accepts in one runtime event. The cell runner truncates first. */
export const MAX_EVENT_TEXT = 64 * 1024;
/** Tool output kept per tool result. */
export const MAX_TOOL_OUTPUT = 16 * 1024;

const text = z.string().max(MAX_EVENT_TEXT);
const id = z.string().min(1).max(200);

/** Who sent an input: the user (TUI/CLI) or the daemon itself (task assignment). */
export const inputSourceSchema = z.enum(['user', 'task']);
export type InputSource = z.infer<typeof inputSourceSchema>;

/**
 * Runtime-neutral events. The cell runner produces them from runtime output; rendering,
 * storage and the client protocol depend only on these. Everything here is agent-originated
 * except `input` and `notice`, and is treated as untrusted text by every client.
 */
export const runtimeEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), text, source: inputSourceSchema.optional() }),
  z.strictObject({ type: z.literal('session.started'), resumeId: id }),
  z.strictObject({ type: z.literal('text.delta'), text }),
  z.strictObject({ type: z.literal('message'), text }),
  /** What the agent is doing between messages: a reasoning summary or its current plan. */
  z.strictObject({ type: z.literal('progress'), text }),
  z.strictObject({ type: z.literal('tool.call'), id, name: z.string().max(200), input: text }),
  z.strictObject({
    type: z.literal('tool.result'),
    id,
    output: z.string().max(MAX_TOOL_OUTPUT),
    isError: z.boolean(),
  }),
  /**
   * Tokens a turn used. `cumulative` marks running totals for the session (Claude Code's
   * per-model figures), which the daemon turns into per-turn amounts; otherwise per turn.
   * Input counts follow the runtime: Codex's include cached input, Claude's do not.
   */
  z.strictObject({
    type: z.literal('usage'),
    model: z.string().max(100).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    cumulative: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('error'), message: text, fatal: z.boolean() }),
  /** Something Anchi (not the model) tells the user about the session. */
  z.strictObject({ type: z.literal('notice'), text }),
  z.strictObject({ type: z.literal('turn.completed') }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

/** Cuts a string to `max` UTF-16 units, marking the cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = `\n… [${s.length - max} characters truncated]`;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}
