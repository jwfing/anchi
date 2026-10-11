export interface MouseEvent {
  kind: 'press' | 'release' | 'wheelUp' | 'wheelDown';
  button: number;
  /** 1-based terminal column / row. */
  x: number;
  y: number;
}

// SGR extended mouse reports: ESC [ < button ; x ; y (M = press, m = release)
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function parseMouse(data: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  const rest = data.replace(SGR_MOUSE, (_m, b: string, x: string, y: string, t: string) => {
    const button = Number(b);
    const kind =
      button === 64 ? 'wheelUp' : button === 65 ? 'wheelDown' : t === 'M' ? 'press' : 'release';
    events.push({ kind, button, x: Number(x), y: Number(y) });
    return '';
  });
  return { events, rest };
}

// Ink only treats "\r" as Return. Some terminal setups send Enter as a bare "\n".
// With xterm modifyOtherKeys, a modified key arrives as ESC [ 27 ; mod ; code ~, which Ink does
// not parse: Ctrl+C would not quit and the Ctrl+X leader would type text. The same key in CSI u
// form (ESC [ code ; mod u) is one Ink parses, so the sequence is rewritten to it.
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS = /\u001b\[27;(\d+);(\d+)~/g;

export function normalizeKeys(data: string): string {
  if (data === '\n') return '\r';
  return data.replace(MODIFY_OTHER_KEYS, (_m, mod: string, code: string) =>
    mod === '1' && code === '13' ? '\r' : `\u001b[${code};${mod}u`,
  );
}

export const MOUSE_ON = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_OFF = '\u001b[?1000l\u001b[?1006l';

/**
 * Ink drops mouse reports, so they are taken out of stdin before Ink reads it: `read()` is
 * wrapped to strip SGR mouse sequences and hand them to `onMouse` (and to normalize Enter and
 * modified keys).
 * Returns a function that restores stdin and turns mouse reporting off.
 */
export function captureMouse(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  onMouse: (e: MouseEvent) => void,
): () => void {
  const originalRead = stdin.read.bind(stdin);
  stdin.read = ((size?: number) => {
    const chunk = originalRead(size) as string | Buffer | null;
    if (chunk === null) return null;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let rest = normalizeKeys(text);
    if (rest.includes('\u001b[<')) {
      const parsed = parseMouse(rest);
      for (const e of parsed.events) onMouse(e);
      rest = parsed.rest;
    }
    if (rest === text) return chunk;
    return typeof chunk === 'string' ? rest : Buffer.from(rest, 'utf8');
  }) as typeof stdin.read;
  stdout.write(MOUSE_ON);
  return () => {
    stdin.read = originalRead as typeof stdin.read;
    stdout.write(MOUSE_OFF);
  };
}
