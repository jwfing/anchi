import type { ReactNode } from 'react';

/**
 * The Markdown agents write (paragraphs, headings, lists, tables, quotes, rules, fenced code,
 * bold, italics, strikethrough, inline code, links), drawn as React elements: the text never
 * becomes HTML, and a link opens the browser only for a web address. The text is sanitized
 * before it gets here.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.split('\n'), 0)}</div>;
}

/** Quotes and lists inside quotes and lists stop nesting here; deeper text stays plain. */
const MAX_DEPTH = 8;
/** Columns past this many are dropped, as a table that wide is not meant to be read. */
const MAX_COLUMNS = 30;

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indent = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;

/** A header row followed by its `|---|:---:|` rule; a rule without pipes is a horizontal rule. */
const tableStart = (line: string, next: string | undefined) =>
  next !== undefined &&
  line.includes('|') &&
  TABLE_RULE.test(next) &&
  (next.includes('|') || line.trim().startsWith('|'));

/** A line that starts its own block, so it ends a list it follows without a blank line. */
const opensBlock = (line: string, next: string | undefined) =>
  /^\s{0,3}(#{1,6}\s|```|>)/.test(line) || RULE.test(line) || tableStart(line, next);

function blocks(lines: string[], depth: number): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={`p${i}`}>{inline(para.join('\n'))}</p>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) code.push(lines[i++]!);
      out.push(
        <pre key={`c${i}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      out.push(
        <p key={`h${i}`} className={`md-h md-h${heading[1]!.length}`}>
          {inline(heading[2]!)}
        </p>,
      );
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push(<hr key={`r${i}`} />);
      i++;
      continue;
    }
    if (tableStart(line, lines[i + 1])) {
      flush();
      const start = i;
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(lines[i++]!);
      }
      out.push(table(lines[start]!, lines[start + 1]!, rows, `t${start}`));
      continue;
    }
    if (depth < MAX_DEPTH && /^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        quoted.push(lines[i++]!.replace(/^\s{0,3}> ?/, ''));
      }
      out.push(<blockquote key={`q${i}`}>{blocks(quoted, depth + 1)}</blockquote>);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      i = list(lines, i, depth, out);
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return out;
}

/**
 * A list from lines[i]: items at its first marker's indent, and what is indented under an item
 * (a nested list, more text) drawn inside it. Blank lines between items keep the list going.
 * Returns the index after the list.
 */
function list(lines: string[], i: number, depth: number, out: ReactNode[]): number {
  const first = LIST_ITEM.exec(lines[i]!)!;
  const base = indent(lines[i]!);
  const ordered = /\d/.test(first[2]!);
  const items: string[][] = [];
  const key = `l${i}`;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = LIST_ITEM.exec(line);
    if (line.trim() === '') {
      let next = i + 1;
      while (next < lines.length && lines[next]!.trim() === '') next++;
      const after = lines[next];
      if (after === undefined) break;
      const sameList = LIST_ITEM.test(after) && indent(after) <= base + 1;
      if (!sameList && indent(after) <= base) break;
      items[items.length - 1]!.push('');
      i++;
      continue;
    }
    if (item && indent(line) <= base + 1 && /\d/.test(item[2]!) === ordered) {
      items.push([item[3]!]);
    } else if (
      (item && indent(line) <= base + 1) ||
      (indent(line) <= base && opensBlock(line, lines[i + 1]))
    ) {
      break;
    } else {
      // More indented: belongs to the item. Not indented and no marker: a lazy continuation.
      items[items.length - 1]!.push(line.slice(Math.min(indent(line), base + 2)));
    }
    i++;
  }
  const children = items.map((lines, k) => {
    const [head, ...rest] = lines;
    const nested = rest.join('\n').trim();
    return (
      <li key={k}>
        {inline(head!)}
        {nested && (depth + 1 < MAX_DEPTH ? blocks(rest, depth + 1) : ['\n', ...inline(nested)])}
      </li>
    );
  });
  const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
  out.push(
    ordered ? (
      <ol key={key} start={start === 1 ? undefined : start}>
        {children}
      </ol>
    ) : (
      <ul key={key}>{children}</ul>
    ),
  );
  return i;
}

/** A row's cells: outer pipes dropped, `\|` kept as a pipe inside a cell. */
function cells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text
    .split(/(?<!\\)\|/)
    .slice(0, MAX_COLUMNS)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(head: string, rule: string, rows: string[], key: string): ReactNode {
  const header = cells(head);
  const align = cells(rule).map((c): 'left' | 'center' | 'right' | undefined =>
    c.startsWith(':') && c.endsWith(':')
      ? 'center'
      : c.endsWith(':')
        ? 'right'
        : c.startsWith(':')
          ? 'left'
          : undefined,
  );
  const style = (k: number) => (align[k] ? { textAlign: align[k] } : undefined);
  return (
    <div key={key} className="md-table">
      <table>
        <thead>
          <tr>
            {header.map((c, k) => (
              <th key={k} style={style(k)}>
                {inline(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const values = cells(row);
            return (
              <tr key={r}>
                {header.map((_, k) => (
                  <td key={k} style={style(k)}>
                    {inline(values[k] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const INLINE = new RegExp(
  [
    '`[^`\\n]+`',
    '\\*\\*(?!\\s)[^\\n]+?\\*\\*',
    '__(?!\\s)[^\\n]+?__',
    '~~(?!\\s)[^~\\n]+?~~',
    '(?<![*\\w])\\*(?![\\s*])[^*\\n]+?(?<!\\s)\\*(?!\\*)',
    '(?<![_\\w])_(?![\\s_])[^_\\n]+?(?<!\\s)_(?![_\\w])',
    '\\[[^\\]\\n]+\\]\\(\\s*https?:\\/\\/[^)\\s]+\\s*\\)',
    'https?:\\/\\/[^\\s<>"\'`)\\]]+',
  ].join('|'),
  'g',
);

export function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  // Emphasis inside emphasis is drawn a few levels deep; past that, as written.
  const inner = (s: string) => (depth < 4 ? inline(s, depth + 1) : [s]);
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const token = m[0];
    const key = m.index!;
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key}>{inner(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('~~')) {
      out.push(<del key={key}>{inner(token.slice(2, -2))}</del>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={key}>{inner(token.slice(1, -1))}</em>);
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']('));
      const url = token.slice(token.indexOf('](') + 2, -1).trim();
      out.push(<WebLink key={key} url={url} label={label} />);
    } else {
      out.push(<WebLink key={key} url={token} label={token} />);
    }
    at = m.index! + token.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The link's real address shows as its tooltip, since the label is the agent's choice. */
function WebLink({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      className="link"
      title={url}
      onClick={() => void window.anchi.openExternal(url)}
    >
      {label}
    </button>
  );
}
