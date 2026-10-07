import type { RuntimeEvent, StoredEvent } from '@anchi/protocol';
import stringWidth from 'string-width';
import { sanitize, sanitizeLine } from '../sanitize.ts';

export type Tone = 'user' | 'assistant' | 'tool' | 'toolOut' | 'error' | 'warn' | 'dim' | 'system';

export interface Line {
  text: string;
  tone: Tone;
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
      push(lines, event.text, 'assistant', width);
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
    case 'usage':
    case 'session.started':
    case 'turn.completed':
    case 'text.delta':
      return;
  }
}

/** Transcript of one task. Every line is sanitized and wrapped to `width`. */
export function transcriptLines(events: StoredEvent[], width: number, verbose = false): Line[] {
  const lines: Line[] = [];
  for (const { event } of events) eventLines(event, width, lines, verbose);
  return lines;
}
