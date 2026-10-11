import { describe, expect, it } from 'vitest';
import { markdownLines } from '../src/tui/markdown.ts';

const texts = (md: string, width = 40) => markdownLines(md, width).map((l) => l.text);

describe('markdown', () => {
  it('styles headings, emphasis, code and links without escape sequences', () => {
    const [heading, para] = markdownLines(
      '## Plan\n**bold** and `x*y*` see [docs](https://d.example)',
      80,
    );
    expect(heading!.text).toBe('Plan');
    expect(heading!.spans).toEqual([{ text: 'Plan', bold: true, underline: true }]);
    expect(para!.spans).toEqual([
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'x*y*', code: true },
      { text: ' see ' },
      { text: 'docs', underline: true },
      { text: ' (https://d.example)', dim: true },
    ]);
    for (const l of markdownLines('# a\n- b\n> c\n```\nd\n```', 20)) {
      expect(l.text).not.toContain('\u001b');
    }
  });

  it('renders lists, task lists, quotes, rules and fenced code', () => {
    expect(
      texts(
        '- one\n  - nested\n1. first\n- [ ] todo\n- [x] done\n> quoted\n---\n```yaml\na: 1\n```',
      ),
    ).toEqual([
      '• one',
      '  • nested',
      '1. first',
      '☐ todo',
      '☑ done',
      '│ quoted',
      '─'.repeat(40),
      'yaml',
      '│ a: 1',
    ]);
  });

  it('wraps to the width with a hanging indent, one line per row, and collapses blank runs', () => {
    const lines = texts('- alpha beta gamma delta\n\n\n\nnext', 14);
    expect(lines).toEqual(['• alpha beta', '  gamma delta', '', 'next']);
    for (const l of texts('你好世界你好世界', 4)) expect(l.length).toBeLessThanOrEqual(2);
  });

  it('keeps underscores inside words and markers inside code literal', () => {
    expect(texts('snake_case_name and `a_b_c` or `**x**`')).toEqual([
      'snake_case_name and a_b_c or **x**',
    ]);
  });

  it('lays out pipe tables in aligned columns with a bold header', () => {
    const md = '| Name | Count |\n|:-----|------:|\n| **a** | 1 |\n| longer | 12 |\nafter';
    const lines = markdownLines(md, 40);
    expect(lines.map((l) => l.text)).toEqual([
      'Name   │ Count',
      '───────┼──────',
      'a      │     1',
      'longer │    12',
      'after',
    ]);
    expect(lines[0]!.spans![0]).toEqual({ text: 'Name', bold: true });
    expect(lines[2]!.spans).toContainEqual({ text: 'a', bold: true });
  });

  it('accepts tables without outer pipes and escaped pipes in cells', () => {
    expect(texts('a | b\n--- | ---\nx \\| y | `z`')).toEqual([
      'a     │ b',
      '──────┼──',
      'x | y │ z',
    ]);
  });

  it('wraps cells of a table wider than the room, and lists rows when columns cannot fit', () => {
    const md = '| k | description |\n|---|---|\n| id | one two three four five six |';
    const lines = texts(md, 20);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
    expect(lines).toEqual([
      'k  │ description',
      '───┼────────────────',
      'id │ one two three',
      '   │ four five six',
    ]);
    expect(texts('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |', 12)).toEqual([
      'a: 1',
      'b: 2',
      'c: 3',
    ]);
  });

  it('keeps a pipe line without a delimiter row as text', () => {
    expect(texts('| just | text |')).toEqual(['| just | text |']);
  });
});
