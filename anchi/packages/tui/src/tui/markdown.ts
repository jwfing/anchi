import stringWidth from 'string-width';
import type { Line, Span } from './lines.ts';

/**
 * Markdown for the terminal: agent replies rendered as styled spans, one `Line` per terminal row
 * (scrolling and clicks count rows). Only styling is produced, never escape sequences: the input
 * is already sanitized, and links show their target as text instead of becoming OSC 8 links.
 * Covers what agents write: headings, emphasis, inline code, fenced code, lists, task lists,
 * quotes, rules and pipe tables (kept as text).
 */
export function markdownLines(text: string, width: number): Line[] {
  const out: Line[] = [];
  const emit = (spans: Span[], prefix: Span[] = [], hanging?: Span[]) => {
    for (const row of wrapSpans(spans, width, prefix, hanging ?? indentOf(prefix))) {
      out.push(line(row));
    }
  };
  let fence: string | undefined;
  let blank = false;
  for (const raw of text.split('\n')) {
    if (fence !== undefined) {
      if (raw.trim().startsWith(fence) && raw.trim().replace(/[`~]/g, '') === '') {
        fence = undefined;
        continue;
      }
      emit([{ text: raw, code: true }], [{ text: '│ ', dim: true }]);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw);
    if (open) {
      fence = open[1]!;
      if (open[2]) out.push(line([{ text: open[2], dim: true }]));
      blank = false;
      continue;
    }
    if (!raw.trim()) {
      // Runs of blank lines collapse into one.
      if (!blank && out.length) out.push(line([]));
      blank = true;
      continue;
    }
    blank = false;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const major = heading[1]!.length <= 2;
      emit(inline(heading[2]!).map((s) => ({ ...s, bold: true, underline: major || s.underline })));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(line([{ text: '─'.repeat(Math.max(1, Math.min(width, 40))), dim: true }]));
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(raw);
    if (quote) {
      emit(
        inline(quote[1]!).map((s) => ({ ...s, dim: true })),
        [{ text: '│ ', dim: true }],
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const depth = Math.floor(item[1]!.replace(/\t/g, '  ').length / 2);
      const marker = item[3] ? (item[3] === ' ' ? '☐' : '☑') : /\d/.test(item[2]!) ? item[2]! : '•';
      emit(inline(item[4]!), [{ text: `${'  '.repeat(depth)}${marker} ` }]);
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      // A table's delimiter row (|---|:--:|) becomes a rule; cells keep their text.
      if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(raw)) {
        out.push(line([{ text: raw.replace(/[-:]/g, '─').trim(), dim: true }]));
      } else emit(inline(raw.trim()));
      continue;
    }
    emit(inline(raw));
  }
  while (out.length && !out.at(-1)!.text) out.pop();
  return out;
}

function line(spans: Span[]): Line {
  return { text: spans.map((s) => s.text).join(''), tone: 'assistant', spans };
}

const indentOf = (prefix: Span[]): Span[] => {
  const w = stringWidth(prefix.map((s) => s.text).join(''));
  return w ? [{ text: ' '.repeat(w) }] : [];
};

// Code spans first, so emphasis markers inside them stay literal.
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline markdown of one line as spans. */
export function inline(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) spans.push({ ...style, text: text.slice(last, m.index) });
    if (m[2] !== undefined) spans.push({ ...style, text: m[2].trim() || m[2], code: true });
    else if (m[3] !== undefined || m[4] !== undefined)
      spans.push(...inline(m[3] ?? m[4]!, { ...style, bold: true }));
    else if (m[5] !== undefined) spans.push(...inline(m[5], { ...style, strike: true }));
    else if (m[6] !== undefined || m[7] !== undefined)
      spans.push(...inline(m[6] ?? m[7]!, { ...style, italic: true }));
    else {
      spans.push(...inline(m[8]!, { ...style, underline: true }));
      if (m[9] !== m[8]) spans.push({ ...style, text: ` (${m[9]})`, dim: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ ...style, text: text.slice(last) });
  return spans;
}

const segmenter = new Intl.Segmenter();
type Cell = { seg: string; style: Omit<Span, 'text'> };

/**
 * Word-wraps styled spans to `width` cells like `wrap` does for plain text: the first row starts
 * with `prefix` (a bullet, a quote bar), the following rows with `hanging`.
 */
export function wrapSpans(
  spans: Span[],
  width: number,
  prefix: Span[] = [],
  hanging: Span[] = [],
): Span[][] {
  const rows: Cell[][] = [];
  const room = (first: boolean) =>
    Math.max(1, width - stringWidth((first ? prefix : hanging).map((s) => s.text).join('')));
  let row: Cell[] = [];
  let w = 0;
  let lastSpace = -1;
  for (const span of spans) {
    const { text, ...style } = span;
    for (const { segment } of segmenter.segment(text)) {
      const sw = stringWidth(segment);
      if (w + sw > room(rows.length === 0)) {
        if (segment !== ' ' && lastSpace > 0 && lastSpace > row.length - 30) {
          rows.push(row.slice(0, lastSpace));
          row = row.slice(lastSpace + 1);
          w = row.reduce((n, c) => n + stringWidth(c.seg), 0);
        } else {
          rows.push(row);
          row = [];
          w = 0;
        }
        lastSpace = -1;
        if (segment === ' ') continue;
      }
      if (segment === ' ') lastSpace = row.length;
      row.push({ seg: segment, style });
      w += sw;
    }
  }
  rows.push(row);
  return rows.map((cells, i) => [...(i === 0 ? prefix : hanging), ...merge(cells)]);
}

/** Adjacent cells with the same style become one span. */
function merge(cells: Cell[]): Span[] {
  const spans: Span[] = [];
  for (const { seg, style } of cells) {
    const prev = spans.at(-1);
    if (prev && sameStyle(prev, style)) prev.text += seg;
    else spans.push({ ...style, text: seg });
  }
  return spans;
}

const KEYS = ['bold', 'italic', 'underline', 'strike', 'code', 'dim'] as const;
const sameStyle = (a: Omit<Span, 'text'>, b: Omit<Span, 'text'>) =>
  KEYS.every((k) => Boolean(a[k]) === Boolean(b[k]));
