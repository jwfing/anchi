import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { StoredEvent } from '@anchi/protocol';

export interface ToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
}

/** One entry of a transcript as the window draws it. All text is agent-originated and sanitized. */
export type Item =
  | { kind: 'input'; seq: number; text: string; fromTask: boolean }
  | { kind: 'message'; seq: number; text: string }
  | { kind: 'progress'; seq: number; text: string }
  | { kind: 'notice'; seq: number; text: string }
  | { kind: 'error'; seq: number; text: string; fatal: boolean }
  | { kind: 'tools'; seq: number; calls: ToolCall[] };

/**
 * Folds stored events into transcript items: consecutive tool calls and their results become one
 * group (the TUI's "N tool calls · last: …"); bookkeeping events are left out.
 */
export function transcript(events: StoredEvent[]): Item[] {
  const items: Item[] = [];
  let group: Extract<Item, { kind: 'tools' }> | undefined;
  for (const { seq, event } of events) {
    if (event.type === 'tool.call' || event.type === 'tool.result') {
      if (!group) {
        group = { kind: 'tools', seq, calls: [] };
        items.push(group);
      }
      if (event.type === 'tool.call') {
        group.calls.push({
          id: event.id,
          name: sanitizeLine(event.name),
          input: sanitize(event.input),
        });
      } else {
        const call = group.calls.find((c) => c.id === event.id);
        if (call) {
          call.output = sanitize(event.output);
          call.isError = event.isError;
        }
      }
      continue;
    }
    switch (event.type) {
      case 'input':
        group = undefined;
        items.push({
          kind: 'input',
          seq,
          text: sanitize(event.text),
          fromTask: event.source === 'task',
        });
        break;
      case 'message':
      case 'progress':
      case 'notice':
        group = undefined;
        items.push({ kind: event.type, seq, text: sanitize(event.text) });
        break;
      case 'error':
        group = undefined;
        items.push({ kind: 'error', seq, text: sanitize(event.message), fatal: event.fatal });
        break;
      default:
        // usage, session.started, turn.completed, text.delta: not part of what is read.
        break;
    }
  }
  return items;
}

/** "7 tool calls (1 failed) · last: shell pnpm test" */
export function toolSummary(calls: ToolCall[]): string {
  const failed = calls.filter((c) => c.isError).length;
  const last = calls.at(-1);
  const lastText = last ? `${last.name} ${sanitizeLine(last.input)}`.slice(0, 120) : '';
  return `${calls.length} tool call${calls.length === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}${lastText ? ` · last: ${lastText}` : ''}`;
}

/** What a running task is doing now: its latest progress, tool call or message. */
export function doing(items: Item[]): string | undefined {
  const last = items.at(-1);
  if (!last) return undefined;
  if (last.kind === 'tools') {
    const call = last.calls.at(-1);
    return call ? `${call.name} ${sanitizeLine(call.input)}`.slice(0, 140) : undefined;
  }
  if (last.kind === 'input') return undefined;
  return sanitizeLine(last.text).slice(0, 140);
}
