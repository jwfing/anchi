import { styleText } from 'node:util';
import type { RuntimeEvent } from '@anchi/protocol';
import { sanitize, sanitizeLine } from './sanitize.ts';
import { summarizeInput } from './tui/lines.ts';

/**
 * Streams task events to a terminal (CLI). Agent text is sanitized like in the TUI. Without
 * --verbose, a run of tool calls is one line: rewritten in place on a terminal, printed once
 * when the run ends otherwise.
 */
export class TerminalRenderer {
  private calls = 0;
  private failed = 0;
  private last = '';

  constructor(
    private out: NodeJS.WriteStream = process.stdout,
    private verbose = false,
  ) {}

  private line(s: string) {
    this.out.write(`${s}\n`);
  }

  private get live(): boolean {
    return Boolean(this.out.isTTY);
  }

  private groupText(final: boolean): string {
    const count = `${this.calls} tool call${this.calls === 1 ? '' : 's'}${this.failed ? ` (${this.failed} failed)` : ''}`;
    const text = `▸ ${count} · ${final ? 'last: ' : ''}${this.last}`;
    const width = Math.max(20, (this.out.columns ?? 120) - 1);
    return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  }

  /** Ends the current run of tool calls with its summary line. */
  flush(): void {
    if (!this.calls) return;
    const color = this.failed ? 'yellow' : 'dim';
    if (this.live) this.out.write('\r\u001b[2K');
    this.line(styleText(color, this.groupText(true)));
    this.calls = this.failed = 0;
    this.last = '';
  }

  render(event: RuntimeEvent): void {
    if (!this.verbose) {
      if (event.type === 'tool.call') {
        this.calls++;
        this.last = `${sanitizeLine(event.name)} ${summarizeInput(event.input)}`;
        if (this.live) this.out.write(`\r\u001b[2K${styleText('dim', this.groupText(false))}`);
        return;
      }
      if (event.type === 'tool.result') {
        if (event.isError) this.failed++;
        return;
      }
      // Reasoning and plans only with --verbose; a line here would break the live tool line.
      if (event.type === 'progress') return;
      if (
        event.type !== 'usage' &&
        event.type !== 'text.delta' &&
        event.type !== 'session.started'
      ) {
        this.flush();
      }
    }
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
      case 'progress':
        return this.line(styleText('dim', `✻ ${sanitizeLine(event.text)}`));
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
