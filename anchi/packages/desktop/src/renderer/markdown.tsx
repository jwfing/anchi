import type { ReactNode } from 'react';

/**
 * The Markdown agents write (paragraphs, headings, lists, fenced code, bold, inline code, links),
 * drawn as React elements: the text never becomes HTML, and a link opens the browser only for a
 * web address. The text is sanitized before it gets here.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
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
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
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
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== '') {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (item) items.push(item[2]!);
        else if (items.length) items[items.length - 1] += `\n${lines[i]!.trim()}`;
        i++;
      }
      const children = items.map((t, k) => <li key={k}>{inline(t)}</li>);
      out.push(ordered ? <ol key={`l${i}`}>{children}</ol> : <ul key={`l${i}`}>{children}</ul>);
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return out;
}

const INLINE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(\s*https?:\/\/[^)\s]+\s*\)|https?:\/\/[^\s<>"'`)\]]+)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const token = m[0];
    const key = m.index!;
    if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
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
