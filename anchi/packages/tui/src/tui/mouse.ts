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

// Ink only treats "\r" as Return. Some terminal setups send Enter as a bare "\n"
// or, with xterm modifyOtherKeys, as ESC [ 27 ; mod ; 13 ~.
// eslint-disable-next-line no-control-regex
const MODIFIED_ENTER = /\u001b\[27;1;13~/g;

export function normalizeEnter(data: string): string {
  return data === '\n' ? '\r' : data.replace(MODIFIED_ENTER, '\r');
}

export const MOUSE_ON = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_OFF = '\u001b[?1000l\u001b[?1006l';

/**
 * Ink drops mouse reports, so they are taken out of stdin before Ink reads it: `read()` is
 * wrapped to strip SGR mouse sequences and hand them to `onMouse` (and to normalize Enter).
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
    let rest = normalizeEnter(text);
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
