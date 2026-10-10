import type { RuntimeEvent, StoredEvent } from '@anchi/protocol';
import stringWidth from 'string-width';
import { sanitize, sanitizeLine } from '../sanitize.ts';
import { markdownLines } from './markdown.ts';

export type Tone = 'user' | 'assistant' | 'tool' | 'toolOut' | 'error' | 'warn' | 'dim' | 'system';

/** A styled run of text in a line (markdown). */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  dim?: boolean;
}

export interface Line {
  /** The row's plain text; with `spans`, their texts joined. */
  text: string;
  tone: Tone;
  /** Styled runs of the row (rendered markdown); without them, `text` in the tone's style. */
  spans?: Span[];
  /** Set on the summary line of a tool-call group; clicking it toggles the group. */
  group?: string;
}

export interface TranscriptOptions {
  /** Show every tool call with its output (transcript:verbose). */
  verbose?: boolean;
  /** Ids of tool-call groups the user expanded. */
  expanded?: ReadonlySet<string>;
  /** The task's turn is running: its last tool-call group is shown as one live line. */
  live?: boolean;
  /** Prefix of group ids, so they are unique across tasks. */
  prefix?: string;
}

const segmenter = new Intl.Segmenter();

/** Hard-wraps text to `width` terminal cells (CJK and emoji aware). */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    let w = 0;
    let lastSpace = -1;
    for (const { segment } of segmenter.segment(para)) {
      const sw = stringWidth(segment);
      if (w + sw > width) {
        if (segment !== ' ' && lastSpace > 0 && lastSpace > line.length - 30) {
          out.push(line.slice(0, lastSpace));
          line = line.slice(lastSpace + 1);
          w = stringWidth(line);
        } else {
          out.push(line);
          line = '';
          w = 0;
        }
        lastSpace = -1;
        if (segment === ' ') continue;
      }
      if (segment === ' ') lastSpace = line.length;
      line += segment;
      w += sw;
    }
    out.push(line);
  }
  return out;
}

export function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const { segment } of segmenter.segment(text)) {
    const sw = stringWidth(segment);
    if (w + sw > width - 1) break;
    out += segment;
    w += sw;
  }
  return `${out}…`;
}

/** The interesting part of a tool call's JSON input. */
export function summarizeInput(input: string, max = 120): string {
  let s = input;
  try {
    const o = JSON.parse(input) as unknown;
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      const primary = r.command ?? r.path ?? r.query ?? r.url;
      s =
        typeof primary === 'string' ? primary : Array.isArray(primary) ? primary.join(' ') : input;
    }
  } catch {
    // Not JSON; show as is.
  }
  // Codex runs shell commands as `/bin/bash -lc '<command>'`; the wrapper only takes up room.
  const shell = /^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(s);
  if (shell) s = shell[2]!;
  s = sanitizeLine(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function push(lines: Line[], text: string, tone: Tone, width: number) {
  for (const l of wrap(sanitize(text), width)) lines.push({ text: l, tone });
}

function eventLines(event: RuntimeEvent, width: number, lines: Line[], verbose: boolean) {
  switch (event.type) {
    case 'input':
      if (lines.length) lines.push({ text: '', tone: 'dim' });
      push(lines, `› ${event.text}`, 'user', width);
      return;
    case 'message':
      lines.push(...markdownLines(sanitize(event.text), width));
      return;
    case 'tool.call':
      lines.push({
        text: truncate(`▸ ${sanitizeLine(event.name)} ${summarizeInput(event.input, 400)}`, width),
        tone: 'tool',
      });
      return;
    case 'tool.result': {
      const out = sanitize(event.output).trimEnd().split('\n');
      const shown = event.isError || verbose ? out.slice(0, verbose ? 8 : 3) : out.slice(0, 1);
      if (!shown[0] && !event.isError) return;
      for (const l of shown) {
        lines.push({
          text: truncate(`  ⎿ ${l}`, width),
          tone: event.isError ? 'error' : 'toolOut',
        });
      }
      if (out.length > shown.length && (event.isError || verbose)) {
        lines.push({ text: `    … ${out.length - shown.length} more lines`, tone: 'toolOut' });
      }
      return;
    }
    case 'error':
      push(
        lines,
        `${event.fatal ? '✗' : '!'} ${event.message}`,
        event.fatal ? 'error' : 'warn',
        width,
      );
      return;
    case 'notice':
      push(lines, `ℹ ${event.text}`, 'system', width);
      return;
    case 'progress':
      push(lines, `✻ ${event.text}`, 'dim', width);
      return;
    case 'usage':
    case 'session.started':
    case 'turn.completed':
    case 'text.delta':
      return;
  }
}

const isTool = (e: RuntimeEvent) => e.type === 'tool.call' || e.type === 'tool.result';
// Events that neither show anything nor end a run of tool calls. Progress (reasoning, plans)
// shows only in the verbose transcript; while a turn runs, the working line shows the latest.
const isSilent = (e: RuntimeEvent, verbose: boolean) =>
  e.type === 'usage' ||
  e.type === 'session.started' ||
  e.type === 'text.delta' ||
  (e.type === 'progress' && !verbose);

function callLabel(event: RuntimeEvent & { type: 'tool.call' }): string {
  return `${sanitizeLine(event.name)} ${summarizeInput(event.input, 200)}`;
}

/**
 * A run of consecutive tool calls, shown as one line: while the turn runs, the count and the
 * latest call (rewritten in place); afterwards, the count, which expands to the full list.
 */
function groupLines(
  group: StoredEvent[],
  id: string,
  width: number,
  lines: Line[],
  opts: TranscriptOptions,
  live: boolean,
) {
  const calls = group.filter((e) => e.event.type === 'tool.call');
  const failed = group.filter((e) => e.event.type === 'tool.result' && e.event.isError).length;
  const count = `${calls.length} tool call${calls.length === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`;
  const last = calls.at(-1)?.event as (RuntimeEvent & { type: 'tool.call' }) | undefined;
  const open = opts.verbose || opts.expanded?.has(id);
  if (open) {
    lines.push({ text: truncate(`▾ ${count}`, width), tone: 'tool', group: id });
    for (const { event } of group) eventLines(event, width, lines, Boolean(opts.verbose));
    return;
  }
  const text = live
    ? `▸ ${count} · ${last ? callLabel(last) : ''}`
    : `▸ ${count}${last ? ` · last: ${callLabel(last)}` : ''}`;
  const hint = live ? '' : ' · click to expand';
  const room = width - stringWidth(hint);
  lines.push({
    text: room > 20 ? truncate(text, room) + hint : truncate(text, width),
    tone: failed ? 'warn' : 'tool',
    group: id,
  });
}

/** Transcript of one task. Every line is sanitized and wrapped to `width`. */
export function transcriptLines(
  events: StoredEvent[],
  width: number,
  opts: TranscriptOptions = {},
): Line[] {
  const lines: Line[] = [];
  let group: StoredEvent[] = [];
  const flush = (live: boolean) => {
    if (!group.length) return;
    groupLines(group, `${opts.prefix ?? ''}g${group[0]!.seq}`, width, lines, opts, live);
    group = [];
  };
  for (const stored of events) {
    if (isTool(stored.event)) group.push(stored);
    else if (isSilent(stored.event, Boolean(opts.verbose))) continue;
    else {
      flush(false);
      eventLines(stored.event, width, lines, Boolean(opts.verbose));
    }
  }
  flush(Boolean(opts.live));
  return lines;
}
