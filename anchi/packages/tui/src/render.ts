import { styleText } from 'node:util';
import type { RuntimeEvent } from '@anchi/protocol';
import { sanitize, sanitizeLine } from './sanitize.ts';
import { summarizeInput } from './tui/lines.ts';

/** Streams task events to a terminal (CLI). Agent text is sanitized like in the TUI. */
export class TerminalRenderer {
  constructor(
    private out: NodeJS.WriteStream = process.stdout,
    private verbose = false,
  ) {}

  private line(s: string) {
    this.out.write(`${s}\n`);
  }

  render(event: RuntimeEvent): void {
    switch (event.type) {
      case 'input':
        return this.line(styleText('cyan', `› ${sanitize(event.text)}`));
      case 'message':
        return this.line(sanitize(event.text));
      case 'tool.call':
        return this.line(
          styleText('yellow', `▸ ${sanitizeLine(event.name)} `) +
            styleText('dim', summarizeInput(event.input)),
        );
      case 'tool.result': {
        if (!event.isError && !this.verbose) return;
        const lines = sanitize(event.output).trimEnd().split('\n');
        const shown = lines.slice(0, 4).map((l) => `    ${l.slice(0, 160)}`);
        if (lines.length > 4) shown.push(`    … ${lines.length - 4} more lines`);
        return this.line(styleText(event.isError ? 'red' : 'dim', shown.join('\n')));
      }
      case 'error':
        return this.line(
          styleText(
            event.fatal ? 'red' : 'yellow',
            `${event.fatal ? '✗' : '!'} ${sanitize(event.message)}`,
          ),
        );
      case 'notice':
        return this.line(styleText('blue', `ℹ ${sanitize(event.text)}`));
      case 'usage':
        if (this.verbose)
          this.line(
            styleText('dim', `· in ${event.inputTokens ?? '?'} · out ${event.outputTokens ?? '?'}`),
          );
        return;
      default:
        return;
    }
  }
}
