import stringWidth from 'string-width';

/**
 * A one-line text input with a cursor, edited with the keys terminals and shells use (Emacs
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
  switch (stroke) {
    case 'left':
    case 'ctrl+b':
      return { ...d, cursor: Math.max(0, at - 1) };
    case 'right':
    case 'ctrl+f':
      return { ...d, cursor: Math.min(c.length, at + 1) };
    case 'home':
    case 'ctrl+a':
      return { ...d, cursor: 0 };
    case 'end':
    case 'ctrl+e':
      return { ...d, cursor: c.length };
    case 'alt+b':
      return { ...d, cursor: wordStart(c, at) };
    case 'alt+f':
      return { ...d, cursor: wordEnd(c, at) };
    case 'backspace':
    case 'ctrl+h':
      return at ? cut(c, at - 1, at, at - 1) : d;
    case 'ctrl+d':
      return cut(c, at, at + 1, at);
    case 'ctrl+w':
    case 'alt+backspace': {
      const from = wordStart(c, at);
      return cut(c, from, at, from);
    }
    case 'alt+d':
      return cut(c, at, wordEnd(c, at), at);
    case 'ctrl+u':
      return cut(c, 0, at, 0);
    case 'ctrl+k':
      return cut(c, at, c.length, at);
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
