import { describe, expect, it } from 'vitest';
import { type Draft, draftOf, edit, insert, inputWindow, inputRows } from '../src/tui/lineedit.ts';

const apply = (d: Draft, ...strokes: string[]) => strokes.reduce((x, s) => edit(x, s)!, d);

describe('line editing', () => {
  it('moves and edits at the cursor', () => {
    let d = draftOf('helo world');
    d = apply(d, 'ctrl+a', 'right', 'right', 'right');
    d = insert(d, 'l');
    expect(d).toEqual({ text: 'hello world', cursor: 4 });
    expect(apply(d, 'ctrl+e')).toEqual({ text: 'hello world', cursor: 11 });
    expect(apply(d, 'ctrl+k').text).toBe('hell');
    expect(apply(d, 'ctrl+u')).toEqual({ text: 'o world', cursor: 0 });
    expect(apply(d, 'ctrl+d').text).toBe('hell world');
    expect(apply(d, 'backspace').text).toBe('helo world');
    expect(apply(draftOf('hello big world'), 'ctrl+w').text).toBe('hello big ');
    expect(apply(draftOf('hello big world'), 'alt+b', 'alt+b').cursor).toBe(6);
    expect(apply(draftOf('hello big world'), 'home', 'alt+d').text).toBe(' big world');
    expect(apply(draftOf(''), 'backspace', 'left', 'ctrl+d')).toEqual({ text: '', cursor: 0 });
    expect(edit(d, 'ctrl+x')).toBeUndefined();
  });

  it('steps over CJK characters and emoji one at a time', () => {
    let d = draftOf('的错误呀');
    d = apply(d, 'left', 'left');
    d = insert(d, '👍');
    expect(d).toEqual({ text: '的错👍误呀', cursor: 3 });
    expect(apply(d, 'backspace').text).toBe('的错误呀');
  });

  it('keeps the cursor visible in a narrow input', () => {
    const long = draftOf('a'.repeat(50));
    const end = inputWindow(long, 20);
    expect(end.at).toBe(' ');
    expect(end.before).toHaveLength(19);
    const start = inputWindow({ ...long, cursor: 0 }, 20);
    expect(start.before).toBe('');
    expect(start.at).toBe('a');
    expect(start.after).toHaveLength(19);
    // Wide characters take two columns each.
    const wide = inputWindow(draftOf('的'.repeat(30)), 21);
    expect(wide.before).toHaveLength(10);
    const middle = inputWindow({ text: 'x'.repeat(100), cursor: 50 }, 40);
    expect(middle.after.length).toBeGreaterThan(0);
    expect(middle.before.length + 1 + middle.after.length).toBeLessThanOrEqual(40);
  });
});

describe('multiline composer', () => {
  it('edits line boundaries and deletes whole grapheme clusters', () => {
    expect(edit(draftOf('first\n你好👨‍👩‍👧‍👦'), 'backspace')?.text).toBe('first\n你好');
    expect(edit(draftOf('first\nsecond'), 'ctrl+u')?.text).toBe('first\n');
    expect(edit({ text: '\ntext', cursor: 0 }, 'home')?.cursor).toBe(0);
    expect(edit(draftOf('é'), 'left')?.cursor).toBe(0);
  });
  it('wraps CJK and keeps the cursor in a bounded growing viewport', () => {
    const view = inputRows(draftOf('你好世界\nlast'), 4, 2);
    expect(view.rows).toHaveLength(2);
    expect(view.hiddenAbove).toBeGreaterThan(0);
    expect(view.rows.at(-1)?.cursor).toBe(true);
    expect(view.rows.at(-1)?.at).toBe(' ');
  });
});
