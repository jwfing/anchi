import stringWidth from 'string-width';

/**
 * A multiline text input with a cursor, edited with the keys terminals and shells use (Emacs
 * style). Positions count code points, so a CJK character or an emoji is one step.
 */
export interface Draft {
  text: string;
  /** Code points before the cursor. */
  cursor: number;
}

export const EMPTY_DRAFT: Draft = { text: '', cursor: 0 };

export const draftOf = (text: string): Draft => ({ text, cursor: [...text].length });

const chars = (d: Draft) => [...d.text];

export function insert(d: Draft, text: string): Draft {
  const c = chars(d);
  const add = [...text];
  return {
    text: [...c.slice(0, d.cursor), ...add, ...c.slice(d.cursor)].join(''),
    cursor: d.cursor + add.length,
  };
}

/** Start of the word before `at`: skip spaces, then non-spaces. */
function wordStart(c: string[], at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(c[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(c[i - 1]!)) i--;
  return i;
}

/** End of the word after `at`: skip spaces, then non-spaces. */
function wordEnd(c: string[], at: number): number {
  let i = at;
  while (i < c.length && /\s/.test(c[i]!)) i++;
  while (i < c.length && !/\s/.test(c[i]!)) i++;
  return i;
}

const cut = (c: string[], from: number, to: number, cursor: number): Draft => ({
  text: [...c.slice(0, from), ...c.slice(to)].join(''),
  cursor,
});

/** Applies a line-editing keystroke (see `LINE_EDIT_KEYS`); undefined when it is not one. */
export function edit(d: Draft, stroke: string): Draft | undefined {
  const c = chars(d);
  const at = Math.min(d.cursor, c.length);
  const lineStart = at === 0 ? 0 : c.lastIndexOf('\n', at - 1) + 1;
  const nextBreak = c.indexOf('\n', at);
  const lineEnd = nextBreak < 0 ? c.length : nextBreak;
  const boundaries = [0];
  for (const { segment } of new Intl.Segmenter().segment(d.text))
    boundaries.push(boundaries.at(-1)! + [...segment].length);
  const previous = boundaries.filter((n) => n < at).at(-1) ?? 0;
  const next = boundaries.find((n) => n > at) ?? c.length;
  switch (stroke) {
    case 'left':
    case 'ctrl+b':
      return { ...d, cursor: previous };
    case 'right':
    case 'ctrl+f':
      return { ...d, cursor: next };
    case 'home':
    case 'ctrl+a':
      return { ...d, cursor: lineStart };
    case 'end':
    case 'ctrl+e':
      return { ...d, cursor: lineEnd };
    case 'alt+b':
      return { ...d, cursor: wordStart(c, at) };
    case 'alt+f':
      return { ...d, cursor: wordEnd(c, at) };
    case 'backspace':
    case 'ctrl+h':
      return at ? cut(c, previous, at, previous) : d;
    case 'ctrl+d':
      return cut(c, at, next, at);
    case 'ctrl+w':
    case 'alt+backspace': {
      const from = wordStart(c, at);
      return cut(c, from, at, from);
    }
    case 'alt+d':
      return cut(c, at, wordEnd(c, at), at);
    case 'ctrl+u':
      return cut(c, lineStart, at, lineStart);
    case 'ctrl+k':
      return cut(c, at, lineEnd, at);
    default:
      return undefined;
  }
}

/**
 * What fits in `width` columns around the cursor: text before it, the character under it (a
 * space at the end) and text after it. The cursor always stays visible.
 */
export function inputWindow(
  d: Draft,
  width: number,
): { before: string; at: string; after: string } {
  const c = chars(d);
  const at = Math.min(d.cursor, c.length);
  const under = c[at] ?? ' ';
  let room = Math.max(1, width - stringWidth(under));
  // Keep a little of what follows the cursor in view when the line is long.
  const reserve = at < c.length - 1 ? Math.min(8, Math.floor(room / 4)) : 0;
  const before: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const w = stringWidth(c[i]!);
    if (w > room - reserve) break;
    before.unshift(c[i]!);
    room -= w;
  }
  const after: string[] = [];
  for (let i = at + 1; i < c.length; i++) {
    const w = stringWidth(c[i]!);
    if (w > room) break;
    after.push(c[i]!);
    room -= w;
  }
  return { before: before.join(''), at: under, after: after.join('') };
}

/** Wrapped input rows with a visible cursor; cursor positions remain Unicode code points. */
export function inputRows(
  d: Draft,
  width: number,
  maxRows = 5,
): {
  rows: { before: string; at: string; after: string; cursor: boolean }[];
  hiddenAbove: number;
  hiddenBelow: number;
} {
  width = Math.max(2, width);
  const rows: { text: string; start: number; end: number }[] = [];
  let text = '';
  let start = 0;
  let pos = 0;
  let cells = 0;
  for (const { segment } of new Intl.Segmenter().segment(d.text)) {
    const size = [...segment].length;
    if (segment === '\n') {
      rows.push({ text, start, end: pos });
      pos += size;
      start = pos;
      text = '';
      cells = 0;
      continue;
    }
    const w = stringWidth(segment);
    if (cells + w > width) {
      rows.push({ text, start, end: pos });
      start = pos;
      text = '';
      cells = 0;
    }
    text += segment;
    cells += w;
    pos += size;
  }
  if (cells >= width && d.cursor === pos) {
    rows.push({ text, start, end: pos });
    text = '';
    start = pos;
  }
  rows.push({ text, start, end: pos });
  let cursorRow = rows.findIndex(
    (row, i) =>
      d.cursor >= row.start &&
      (d.cursor < row.end || (d.cursor === row.end && rows[i + 1]?.start !== row.end)),
  );
  if (cursorRow < 0) cursorRow = rows.length - 1;
  const first = Math.max(0, Math.min(cursorRow - maxRows + 1, rows.length - maxRows));
  return {
    hiddenAbove: first,
    hiddenBelow: Math.max(0, rows.length - first - maxRows),
    rows: rows.slice(first, first + maxRows).map((row, i) => {
      if (first + i !== cursorRow) return { before: row.text, at: '', after: '', cursor: false };
      const c = [...row.text];
      const at = Math.max(0, d.cursor - row.start);
      const rest = c.slice(at).join('');
      const cluster =
        new Intl.Segmenter().segment(rest)[Symbol.iterator]().next().value?.segment ?? ' ';
      return {
        before: c.slice(0, at).join(''),
        at: cluster,
        after: c.slice(at + [...cluster].length).join(''),
        cursor: true,
      };
    }),
  };
}
