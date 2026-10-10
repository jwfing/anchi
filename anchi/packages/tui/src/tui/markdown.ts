import stringWidth from 'string-width';
import type { Line, Span } from './lines.ts';

/**
 * Markdown for the terminal: agent replies rendered as styled spans, one `Line` per terminal row
 * (scrolling and clicks count rows). Only styling is produced, never escape sequences: the input
 * is already sanitized, and links show their target as text instead of becoming OSC 8 links.
 * Covers what agents write: headings, emphasis, inline code, fenced code, lists, task lists,
 * quotes, rules and pipe tables.
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
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
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
    // A table: a header row, then a delimiter row (|---|:--:|), then body rows with pipes.
    const align = raw.includes('|') ? delimiter(rows[i + 1]) : undefined;
    if (align && cells(raw).length === align.length) {
      const body: string[][] = [];
      for (i += 2; i < rows.length && rows[i]!.includes('|') && rows[i]!.trim(); i++)
        body.push(cells(rows[i]!));
      i--;
      out.push(...table(cells(raw), align, body, width));
      continue;
    }
    emit(inline(raw));
  }
  while (out.length && !out.at(-1)!.text) out.pop();
  return out;
}

type Align = 'left' | 'center' | 'right';

/** The alignments of a table's delimiter row, or undefined when `raw` is not one. */
function delimiter(raw: string | undefined): Align[] | undefined {
  if (!raw?.includes('-')) return undefined;
  const parts = cells(raw);
  if (!parts.length || !parts.every((c) => /^:?-+:?$/.test(c))) return undefined;
  if (parts.length === 1 && !raw.includes('|')) return undefined;
  return parts.map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  );
}

/** A table row's cells: split on unescaped pipes, without the outer ones. */
function cells(raw: string): string[] {
  let row = raw.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const SEP = ' │ ';

/**
 * A table laid out in columns: the header bold above a rule, cells padded to their column and
 * aligned. Columns wider than the room share it and their cells wrap; with no room for columns at
 * all, each body row becomes `header: value` lines.
 */
function table(header: string[], align: Align[], body: string[][], width: number): Line[] {
  const n = header.length;
  const grid = [header, ...body].map((r) =>
    Array.from({ length: n }, (_, c) => inline(r[c] ?? '')),
  );
  grid[0] = grid[0]!.map((spans) => spans.map((s) => ({ ...s, bold: true })));
  const room = width - stringWidth(SEP) * (n - 1);
  if (room < n * 4) {
    const out: Line[] = [];
    for (const r of grid.slice(1)) {
      if (out.length) out.push(line([]));
      r.forEach((spans, c) => {
        const prefix = [...grid[0]![c]!, { text: ': ' }];
        for (const row of wrapSpans(spans, width, prefix, [{ text: '  ' }])) out.push(line(row));
      });
    }
    return out;
  }
  const natural = Array.from({ length: n }, (_, c) =>
    Math.max(1, ...grid.map((r) => stringWidth(r[c]!.map((s) => s.text).join('')))),
  );
  const widths = fitColumns(natural, room);
  const sep: Span = { text: SEP, dim: true };
  const out: Line[] = [];
  grid.forEach((r, ri) => {
    const wrapped = r.map((spans, c) => wrapSpans(spans, widths[c]!));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < height; k++) {
      const spans: Span[] = [];
      wrapped.forEach((rowsOfCell, c) => {
        if (c) spans.push(sep);
        const content = rowsOfCell[k] ?? [];
        const pad = widths[c]! - stringWidth(content.map((s) => s.text).join(''));
        const a = ri === 0 ? 'left' : align[c]!;
        const left = a === 'right' ? pad : a === 'center' ? Math.floor(pad / 2) : 0;
        if (left) spans.push({ text: ' '.repeat(left) });
        spans.push(...content);
        if (pad - left && c < n - 1) spans.push({ text: ' '.repeat(pad - left) });
      });
      out.push(line(spans));
    }
    if (ri === 0) {
      const rule = widths.map((w) => '─'.repeat(w)).join(SEP.replace(/ /g, '─').replace('│', '┼'));
      out.push(line([{ text: rule, dim: true }]));
    }
  });
  return out;
}

/**
 * Column widths within `room`: columns that fit their fair share keep their natural width, the
 * rest share what is left evenly.
 */
function fitColumns(natural: number[], room: number): number[] {
  const widths = [...natural];
  let open = natural.map((_, c) => c);
  let left = room;
  for (;;) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((c) => natural[c]! <= share);
    if (!fits.length) {
      open.forEach((c, k) => (widths[c] = share + (k < left - share * open.length ? 1 : 0)));
      return widths;
    }
    for (const c of fits) left -= natural[c]!;
    open = open.filter((c) => natural[c]! > share);
    if (!open.length) return widths;
  }
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
