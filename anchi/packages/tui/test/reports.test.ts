import type { TaskAudit } from '@anchi/protocol';
import { describe, expect, it } from 'vitest';
import { accessLines, usageLines } from '../src/tui/reports.ts';

const audit: TaskAudit = {
  taskId: 't-1',
  total: 4,
  truncated: false,
  cells: 1,
  registration: { connectors: ['github'], services: [], egress: null, ask: [] },
  requests: 2,
  injected: { 'github-api': 1 },
  credentialsSent: { placeholder: 1, other: 1 },
  hosts: [{ host: 'api.github.com', requests: 2, injected: 1, decisions: { inject: 1, pass: 1 } }],
  refused: [],
  held: [],
  streamed: 0,
  bridge: [],
  scan: null,
  rows: [
    {
      ts: 0,
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      operation: '',
      decision: 'inject',
      rule: 'github-api',
      credential: 'placeholder',
      reason: '',
    },
    {
      ts: 1,
      method: 'GET',
      host: 'evil\u001b]52;c;AAAA\u0007.example',
      path: '/x',
      operation: '',
      decision: 'pass',
      rule: '',
      credential: 'other',
      reason: '',
    },
  ],
};

describe('reports', () => {
  it('heads the access report with whether the cell ever sent its own credential', () => {
    const lines = accessLines(audit, 200);
    expect(lines[0]).toMatchObject({ color: 'red' });
    expect(lines[0]!.text).toContain('the cell sent something other than a placeholder 1 time');
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('egress       any public host');
    expect(text).toContain('writes held  high-risk only');
    expect(text).toContain('! sent its own credential');
    // Agent-originated hosts are rendered without escape sequences.
    expect(text).not.toContain('\u001b');
    expect(accessLines({ ...audit, credentialsSent: { placeholder: 2 } }, 200)[0]).toMatchObject({
      color: 'green',
    });
  });

  it('shows limits as seen and token totals with a total row', () => {
    const lines = usageLines(
      [
        {
          key: 'dev',
          turns: 3,
          inputTokens: 12_000,
          cachedInputTokens: 9_000,
          cacheWriteTokens: 0,
          outputTokens: 800,
          reasoningTokens: 100,
          costUsd: 0,
        },
        {
          key: 'lead',
          turns: 1,
          inputTokens: 1_500_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 2_000,
          reasoningTokens: 0,
          costUsd: 1.25,
        },
      ],
      [
        {
          runtime: 'codex',
          ts: 0,
          status: 200,
          headers: {},
          plan: 'team',
          limited: true,
          windows: [
            { name: 'primary', usedPercent: 40, windowMinutes: 300, resetAt: null },
            { name: 'secondary', usedPercent: 76, windowMinutes: 10_080, resetAt: null },
          ],
        },
        { runtime: 'claude-code', ts: 0, status: 200, headers: { 'retry-after': '120' } },
      ],
      1,
      'agent',
      200,
    ).map((l) => l.text);
    expect(lines).toEqual(
      expect.arrayContaining([
        '  plan              team',
        '  5-hour window     40% used',
        '  weekly window     76% used',
        '  limit reached: new turns are refused until a window resets',
        '  retry after  120',
      ]),
    );
    expect(lines.find((l) => l.startsWith('Tokens'))).toBe('Tokens, last 7 days, by agent');
    expect(lines.find((l) => l.includes('lead'))).toMatch(
      /lead\s+1\s+1\.5M\s+0\s+2\.0k\s+0\s+\$1\.25/,
    );
    expect(lines.find((l) => l.includes('total'))).toMatch(
      /total\s+4\s+1\.5M\s+9\.0k\s+2\.8k\s+100\s+\$1\.25/,
    );
    expect(usageLines([], [], 0, 'model', 200).map((l) => l.text)).toContain(
      '  No turns recorded in this period.',
    );
  });
});
