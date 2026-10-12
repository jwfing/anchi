/** @jsxRuntime automatic */
// Render the actual TUI with synthetic fixtures; never connects to a daemon, VM or account.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import type { DaemonClient } from '@anchi/daemon';
import type { AgentSummary, TaskRow } from '@anchi/protocol';
import { App } from '../src/tui/App.tsx';

const now = Date.now();
const agents: AgentSummary[] = ['developer', 'reviewer', 'ops'].map((id, i) => ({
  id,
  name: id,
  runtime: i === 0 ? 'codex' : i === 1 ? 'claude-code' : 'hermes',
  image: 'codex',
  connectors: i === 2 ? ['aws'] : ['github'],
  sandbox: 'cell',
  status: 'idle',
  running: 0,
  queued: 0,
  maxTasks: 1,
  file: `/example/agents/${id}.yaml`,
}));
const tasks: TaskRow[] = agents.map((a, i) => ({
  id: `t-example${i}`,
  agentId: a.id,
  trigger: i === 1 ? 'delegate' : 'user',
  title: [
    'Fix the login validation test',
    'Review the proposed fix',
    'Explain the test account bill',
  ][i]!,
  status: 'done',
  resumeId: null,
  createdAt: now - 120000,
  startedAt: now - 120000,
  finishedAt: now - 60000,
  result: [
    'Updated the validation and tests.',
    'Reviewed the fix; tests pass.',
    'Summarized the example account usage.',
  ][i]!,
  links: [],
  parentId: i === 1 ? 't-example0' : null,
  rootId: i === 1 ? 't-example0' : `t-example${i}`,
  depth: i === 1 ? 1 : 0,
  turns: 1,
  inputTokens: 0,
  outputTokens: 0,
}));
const client = {
  call: async (method: string) =>
    method === 'setup.status'
      ? {
          vm: 'running',
          installed: true,
          vaultUnlocked: true,
          codex: { runtime: 'codex', connected: true, accountId: 'example', expiresAt: null },
          connectors: [],
        }
      : [],
  on: () => () => {},
  onClose: () => {},
  close: () => {},
} as unknown as DaemonClient;
const ui = render(
  <App client={client} initialAgents={agents} initialTasks={tasks} initialView="team" />,
);
await new Promise((done) => setTimeout(done, 100));
const frame = stripVTControlCharacters(ui.lastFrame() ?? '');
ui.unmount();
if (!frame.includes('Team')) throw new Error('TUI did not render the team overview');
const escape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const lines = frame.split('\n');
const width = 720,
  height = 72 + lines.length * 16;
// Explicit terminal columns avoid SVG viewers collapsing spaces or widening box-drawing glyphs.
const rows = lines
  .map((line, row) => {
    let column = 0;
    return [...line]
      .map((char) => {
        const cells = stringWidth(char);
        const x = 24 + column * 6.7;
        column += cells;
        return char === ' ' || !cells
          ? ''
          : `<text x="${x}" y="${52 + row * 16}" textLength="${cells * 6.7}" lengthAdjust="spacingAndGlyphs">${escape(char)}</text>`;
      })
      .join('');
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Anchi terminal UI: team overview</title><desc id="desc">Actual TUI rendering with synthetic example tasks for a developer, reviewer and operations agent. No live accounts.</desc>
<rect width="100%" height="100%" rx="12" fill="#10120f"/>
<text x="24" y="28" fill="#c0e889" font-family="monospace" font-size="12">ANCHI · TEAM OVERVIEW · EXAMPLE DATA</text>
<g fill="#e6e9dd" font-family="Menlo,Consolas,monospace" font-size="11">${rows}</g></svg>\n`;
const out = resolve(import.meta.dirname, '../../../../docs/assets/tui-team.svg');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(out);
