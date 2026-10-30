import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { SERVICE_CONNECTORS } from '@anchi/core';
import { CONNECTOR_IDS, TOKEN_CONNECTOR_IDS } from '@anchi/protocol';
import type {
  AgentSettingValues,
  AgentSummary,
  Approval,
  SetupStatus,
  StoredEvent,
  TaskRow,
} from '@anchi/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkCall, DESKTOP_METHODS, externalUrl, guardedCall } from '../src/main/bridge.ts';
import { mergePath, parseShellPath } from '../src/main/env.ts';
import { type AppContext, Ctx } from '../src/renderer/App.tsx';
import type { ServerState } from '../src/shared.ts';
import { count } from '../src/renderer/format.ts';
import { guideUrl, needsOAuthApp, TOKEN_SOURCE } from '../src/renderer/guides.ts';
import { ConnectorLogo, connectorName } from '../src/renderer/logos.tsx';
import { Markdown } from '../src/renderer/markdown.tsx';
import { agentActivity, EMPTY_MODEL, reduce } from '../src/renderer/model.ts';
import { toolSummary, transcript } from '../src/renderer/transcript.ts';
import { clampWidth, PANEL_WIDTH } from '../src/renderer/ui.tsx';
import { bodyClickOpens, TaskTurn } from '../src/renderer/views/Agent.tsx';
import { DelegationChoices, settingsPatch } from '../src/renderer/views/AgentSettings.tsx';
import { ApprovalCard } from '../src/renderer/views/Approvals.tsx';
import {
  codexLoginHelp,
  ProbeNote,
  Runtimes,
  disconnectable,
  SecretForm,
  Services,
  ServerCard,
} from '../src/renderer/views/Settings.tsx';
import { onboarded, setOnboarded, stageFor } from '../src/renderer/views/Welcome.tsx';
import { vaultLocked } from '../src/renderer/vault.tsx';

const ev = (seq: number, event: StoredEvent['event']): StoredEvent => ({ seq, ts: seq, event });

describe('bridge', () => {
  it('requires a system confirmation before a proposal selects a remote execution profile', async () => {
    const calls: string[] = [];
    const read = async (method: string) => {
      calls.push(method);
      return {
        agentId: 'developer',
        agentYaml: 'runtime: codex\nexecution: {server: cloud, agent: coder}\n',
      };
    };
    await expect(
      guardedCall('builder.apply', { proposalId: 'p-1' }, read, async (q) => {
        expect(q.message).toContain('cloud');
        expect(q.detail).toContain('@coder');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(calls).toEqual(['builder.proposal']);
  });
  it('allows the explicit agent deletion flow while blocking task deletion, reset and shutdown', () => {
    expect(checkCall('tasks.create', { agentId: 'dev', text: 'x' }).method).toBe('tasks.create');
    expect(
      checkCall('team.preview', { agentId: 'dev', execution: { server: 'cloud', agent: 'coder' } })
        .method,
    ).toBe('team.preview');
    expect(checkCall('approvals.decide', { id: 'a', allow: false }).method).toBe(
      'approvals.decide',
    );
    expect(checkCall('setup.importHermes', {}).method).toBe('setup.importHermes');
    expect(checkCall('services.setToken', { id: 'slack', token: 'x' }).method).toBe(
      'services.setToken',
    );
    expect(checkCall('services.xClient', { clientId: 'x' }).method).toBe('services.xClient');
    for (const method of [
      'daemon.shutdown',
      'team.run',
      'team.reply',
      'team.cancel',
      'team.approve',
      'team.poll',
      'setup.reset',
      'setup.run',
      'tasks.delete',
      'agents.allowHost',
      // Only the main process imports a Google client, from a file the user picked.
      'services.googleClient',
      'services.removeGoogleClient',
      'nope',
      42,
    ]) {
      expect(() => checkCall(method, {}), String(method)).toThrow(/does not call/);
    }
    expect([...DESKTOP_METHODS].filter((m) => /delete|reset|shutdown|setup\.run/.test(m))).toEqual([
      'agents.deletePreview',
      'agents.delete',
    ]);
  });

  it('takes only plain objects as parameters', () => {
    expect(checkCall('agents.list', undefined).params).toEqual({});
    expect(() => checkCall('tasks.get', ['t-1'])).toThrow(/must be an object/);
    expect(() => checkCall('tasks.get', 't-1')).toThrow(/must be an object/);
  });

  it('opens only web pages from agent links', () => {
    expect(externalUrl('https://github.com/jwfing/anchi/pull/151')).toBe(
      'https://github.com/jwfing/anchi/pull/151',
    );
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'anchi://x',
      'not a url',
      7,
      'https://x/' + 'a'.repeat(3000),
    ]) {
      expect(externalUrl(bad), String(bad).slice(0, 30)).toBeUndefined();
    }
  });
});

describe('model', () => {
  it('keeps a transcript in seq order and drops repeats, streaming deltas and unloaded tasks', () => {
    let m = reduce(EMPTY_MODEL, {
      type: 'events',
      taskId: 't',
      events: [ev(1, { type: 'input', text: 'hi' }), ev(2, { type: 'message', text: 'a' })],
    });
    m = reduce(m, {
      type: 'event',
      taskId: 't',
      seq: 2,
      event: { type: 'message', text: 'a again' },
      ts: 0,
    });
    m = reduce(m, { type: 'event', taskId: 't', event: { type: 'text.delta', text: 'x' }, ts: 0 });
    m = reduce(m, {
      type: 'event',
      taskId: 't',
      seq: 3,
      event: { type: 'message', text: 'b' },
      ts: 0,
    });
    m = reduce(m, {
      type: 'event',
      taskId: 'other',
      seq: 1,
      event: { type: 'message', text: 'c' },
      ts: 0,
    });
    expect(m.events.t!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(m.events.other).toBeUndefined();
  });

  it('says an agent waits for approval before it says it is running', () => {
    const agent = {
      id: 'dev',
      name: 'Dev',
      connectors: [],
      status: 'working',
      running: 1,
      queued: 0,
      maxTasks: 3,
      file: '',
    } as AgentSummary;
    const approval = { id: 'a', agent: 'dev' } as Approval;
    expect(agentActivity({ ...EMPTY_MODEL, approvals: [approval] }, agent)).toEqual({
      tone: 'approval',
      text: 'Waiting for your approval (1)',
    });
    expect(agentActivity(EMPTY_MODEL, agent).tone).toBe('working');
    expect(agentActivity(EMPTY_MODEL, { ...agent, error: 'bad yaml' }).tone).toBe('error');
  });

  it('replaces a proposal for the same agent and forgets it once decided', () => {
    const p = { id: 'p1', agentId: 'notes' } as never;
    let m = reduce(EMPTY_MODEL, { type: 'proposal', proposal: p });
    m = reduce(m, { type: 'proposal', proposal: { id: 'p2', agentId: 'notes' } as never });
    expect(Object.values(m.proposals).map((x) => x.id)).toEqual(['p2']);
    expect(reduce(m, { type: 'proposalDone', proposalId: 'p2' }).proposals).toEqual({});
  });

  it('replaces the task list on reload', () => {
    const t = (id: string) => ({ id, agentId: 'dev' }) as TaskRow;
    const m = reduce(reduce(EMPTY_MODEL, { type: 'tasks', tasks: [t('a'), t('b')] }), {
      type: 'tasks',
      tasks: [t('c')],
      replace: true,
    });
    expect(Object.keys(m.tasks)).toEqual(['c']);
  });
});

describe('transcript', () => {
  it('folds tool calls and results into one group and leaves bookkeeping out', () => {
    const items = transcript([
      ev(1, { type: 'input', text: 'go' }),
      ev(2, { type: 'session.started', resumeId: 'r' }),
      ev(3, { type: 'tool.call', id: 'c1', name: 'shell', input: 'ls' }),
      ev(4, { type: 'tool.result', id: 'c1', output: 'a b', isError: false }),
      ev(5, { type: 'tool.call', id: 'c2', name: 'shell', input: 'false' }),
      ev(6, { type: 'tool.result', id: 'c2', output: 'exit 1', isError: true }),
      ev(7, { type: 'usage', inputTokens: 5 }),
      ev(8, { type: 'message', text: 'done' }),
      ev(9, { type: 'turn.completed' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['input', 'tools', 'message']);
    const tools = items[1]!;
    expect(tools.kind === 'tools' && toolSummary(tools.calls)).toBe(
      '2 tool calls (1 failed) · last: shell false',
    );
  });

  it('strips terminal escapes, control characters and bidi overrides from agent text', () => {
    const [item] = transcript([
      ev(1, { type: 'message', text: 'safe\u001b[31m red\u0007 ‮evil‬ end' }),
    ]);
    expect(item).toMatchObject({ kind: 'message', text: 'safe red evil end' });
  });
});

describe('markdown', () => {
  const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

  it('draws the usual agent formatting', () => {
    const out = html('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n```\nls -la\n```');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<pre><code>ls -la</code></pre>');
  });

  it('draws tables with their alignment, and formatting inside cells', () => {
    const out = html(
      [
        '博通主要经营两类业务：',
        '',
        '| 业务 | 2026 财年 Q3 收入 | 占比 |',
        '|---|---:|:---:|',
        '| 半导体解决方案 | **20.839** | 70% |',
        '| 基础设施软件 | 8.752 |',
        '',
        '最新季度',
      ].join('\n'),
    );
    expect(out).toContain('<div class="md-table"><table><thead><tr><th>业务</th>');
    expect(out).toContain('<th style="text-align:right">2026 财年 Q3 收入</th>');
    expect(out).toContain('<td style="text-align:right"><strong>20.839</strong></td>');
    expect(out, 'a short row is padded to the header').toContain(
      '<td style="text-align:right">8.752</td><td style="text-align:center"></td>',
    );
    expect(out).toContain('<p>最新季度</p>');
    expect(out).not.toContain('|---');
  });

  it('draws rules, quotes, nested and loose lists, italics and strikethrough', () => {
    const out = html(
      [
        '估值置信度为**中等**。',
        '',
        '---',
        '',
        '> quoted **text**',
        '',
        '3. third',
        '',
        '4. fourth',
        '   - nested',
        '- other kind',
        '',
        '*italic* and ~~gone~~ but snake_case_name and 2*3*4 stay',
      ].join('\n'),
    );
    expect(out).toContain('<hr/>');
    expect(out).toContain('<blockquote><p>quoted <strong>text</strong></p></blockquote>');
    expect(out).toContain(
      '<ol start="3"><li>third</li><li>fourth<ul><li>nested</li></ul></li></ol>',
    );
    expect(out).toContain('<ul><li>other kind</li></ul>');
    expect(out).toContain('<em>italic</em> and <del>gone</del> but snake_case_name and 2*3*4 stay');
  });

  it('ends a list at a heading or table that follows it without a blank line', () => {
    const out = html('- one\n## Next\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain(
      '<ul><li>one</li></ul><p class="md-h md-h2">Next</p><div class="md-table">',
    );
  });

  it('bounds what agent text can make it nest or draw', () => {
    const deep = html('>'.repeat(50) + ' deep');
    expect(deep.match(/<blockquote>/g)).toHaveLength(8);
    const wide = html(`|${' c |'.repeat(100)}\n|${'---|'.repeat(100)}`);
    expect(wide.match(/<th>/g)).toHaveLength(30);
  });

  it('never turns agent text into HTML or a non-web link', () => {
    const out = html(
      '<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com/a)',
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('[click](javascript:alert(1))');
    expect(out).toContain('title="https://example.com/a"');
    expect(out.match(/<button/g)).toHaveLength(1);
  });
});

describe('approval card', () => {
  it('shows who asks for what and why, with the full summary, before deny and approve', () => {
    const approval: Approval = {
      id: 'ap-1',
      kind: 'policy',
      task: 't-1',
      agent: 'assistant',
      connector: 'x',
      operation: 'create_post',
      host: 'api.x.com',
      summary: 'Anchi 0.3.6 ships‮ a remote server',
      createdAt: Date.now(),
      timeout: 600,
      reason: 'Publishing on X always requires approval',
      origin: 'schedule → @lead (t-0) → @assistant',
    };
    const ctx = { act: async () => undefined } as unknown as AppContext;
    const out = renderToStaticMarkup(
      <Ctx.Provider value={ctx}>
        <ApprovalCard approval={approval} />
      </Ctx.Provider>,
    );
    for (const text of [
      'Approve a write by @assistant?',
      'x (api.x.com)',
      'create_post',
      'Publishing on X always requires approval',
      'schedule → @lead (t-0) → @assistant',
      'Anchi 0.3.6 ships a remote server',
      'refused automatically in 10:00',
    ]) {
      expect(out).toContain(text);
    }
    expect(out).not.toContain('‮');
    expect(out.indexOf('>Deny<')).toBeLessThan(out.indexOf('>Approve<'));
  });
});

describe('agent conversation', () => {
  const turn = (status: TaskRow['status']) =>
    renderToStaticMarkup(
      <Ctx.Provider value={{ model: EMPTY_MODEL } as unknown as AppContext}>
        <TaskTurn
          task={{ id: 't-1', agentId: 'dev', title: 'go', status, trigger: 'user' } as TaskRow}
          selected={false}
          onSelect={() => undefined}
          onContinue={() => undefined}
        />
      </Ctx.Provider>,
    );

  it('offers to continue a task only once its turn has ended', () => {
    expect(turn('done')).toContain('Continue this task');
    expect(turn('failed')).toContain('Continue this task');
    expect(turn('running')).not.toContain('Continue this task');
    expect(turn('queued')).not.toContain('Continue this task');
  });

  it('shows that a task card opens its conversation', () => {
    expect(turn('running')).toContain('Details');
    expect(turn('running')).toContain('task-card-body opens');
    expect(turn('done')).toContain('Continue task t-1');
    expect(turn('done')).not.toContain('btn btn-small');
  });

  it('opens a task from its body, except on its controls or after selecting text', () => {
    const at = (control: boolean) => ({ closest: () => (control ? {} : null) });
    expect(bodyClickOpens(at(false), '')).toBe(true);
    expect(bodyClickOpens(at(true), ''), 'Continue, links, tool calls').toBe(false);
    expect(bodyClickOpens(at(false), 'copied text')).toBe(false);
    expect(bodyClickOpens(null, '')).toBe(true);
  });

  it('keeps the task panel and the conversation beside it usable while resizing', () => {
    expect(clampWidth(700, 560, 600)).toBe(700);
    expect(clampWidth(2000, 560, 600)).toBe(560 + 600 - PANEL_WIDTH.main);
    expect(clampWidth(100, 560, 600)).toBe(PANEL_WIDTH.min);
    expect(clampWidth(900, 560, 200)).toBe(400);
    expect(clampWidth(900, 400, 100)).toBe(PANEL_WIDTH.min);
  });
});

describe('app identity', () => {
  it('gives the dock an icon that is transparent around the tile', () => {
    const png = readFileSync(new URL('../assets/icon.png', import.meta.url));
    const chunks: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const size = png.readUInt32BE(at);
      if (png.toString('latin1', at + 4, at + 8) === 'IDAT') {
        chunks.push(png.subarray(at + 8, at + 8 + size));
      }
      at += size + 12;
    }
    expect(png[25], 'colour type: RGBA').toBe(6);
    // The first pixel of the first row is stored as is whatever the row's filter.
    const corner = inflateSync(Buffer.concat(chunks)).subarray(1, 5);
    expect(corner[3], 'corner alpha').toBe(0);
  });

  it('uses the landing page mark as its icon', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(read('../assets/icon.svg')).toBe(read('../../../../landing/dist/favicon.svg'));
  });
});

describe('settings', () => {
  const html = (node: React.ReactNode) =>
    renderToStaticMarkup(
      <Ctx.Provider value={{ act: async () => undefined } as unknown as AppContext}>
        {node}
      </Ctx.Provider>,
    );

  it('marks each runtime connected or not set up, with the button that fits', () => {
    const status = {
      codex: { runtime: 'codex', connected: true, accountId: null, expiresAt: null },
      claude: { runtime: 'claude-code', connected: false, kind: null },
      hermes: { runtime: 'hermes', connected: false, baseUrl: null, model: null },
    } as unknown as SetupStatus;
    const out = html(<Runtimes status={status} server="local" onChange={() => undefined} />);
    expect(out.match(/>Connected</g)).toHaveLength(1);
    expect(out.match(/>Not set up</g)).toHaveLength(2);
    expect(out.match(/>Replace</g)).toHaveLength(1);
    expect(out.match(/>Set up</g)).toHaveLength(2);
  });

  it('connects Slack and Notion with a token and the others through a browser sign-in', () => {
    const service = (id: string, connected = false) => ({
      id,
      connected,
      mode: 'auto',
      accounts: [],
    });
    const status = {
      services: [service('gmail'), service('notion'), service('slack'), service('x', true)],
      googleClient: true,
    } as unknown as SetupStatus;
    const rows = html(<Services status={status} onChange={() => undefined} />).split(
      'class="connector-group"',
    );
    const buttons = (row: string) =>
      [...row.matchAll(/class="btn btn-small"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(rows.slice(1).map(buttons)).toEqual([
      ['Sign in'],
      ['Connect'],
      ['Connect'],
      ['Disconnect'],
    ]);
  });

  it('disconnects each connected or pending Google account by name, else the service', () => {
    const account = (name: string, connected: boolean, revocationPending = false) => ({
      name,
      connected,
      account: null,
      reauthRequired: false,
      revocationPending,
    });
    const service = (
      connected: boolean,
      accounts: ReturnType<typeof account>[] = [],
      pending = false,
    ) => ({ id: 'gmail', connected, mode: 'ask', accounts, revocationPending: pending }) as never;
    const names = (s: never) => disconnectable(s).map((t) => [t.account, t.pending]);
    expect(
      names(
        service(true, [account('work', true), account('old', false, true), account('gone', false)]),
      ),
    ).toEqual([
      ['work', false],
      ['old', true],
    ]);
    expect(names(service(true))).toEqual([[undefined, false]]);
    expect(names(service(false, [], true))).toEqual([[undefined, true]]);
    expect(names(service(false))).toEqual([]);
  });

  it('points a sign-in without its OAuth app to the guide instead of signing in', () => {
    const status = {
      services: [{ id: 'gmail', connected: false, mode: 'ask', accounts: [] }],
      googleClient: false,
    } as unknown as SetupStatus;
    const out = html(<Services status={status} onChange={() => undefined} />);
    expect(out).toContain('Needs an OAuth app');
    expect(out).toContain(`title="${guideUrl('gmail')}"`);
    expect(out).not.toContain('Sign in');
    expect(out).toMatch(/aria-controls="connect-gmail"[^>]*>Add app</);
    expect(needsOAuthApp('x', { xClient: undefined } as SetupStatus), 'older daemon').toBe(false);
    expect(needsOAuthApp('x', { xClient: false } as SetupStatus)).toBe(true);
    expect(needsOAuthApp('slack', {} as SetupStatus)).toBe(false);
  });

  it('asks for secrets in password fields and keeps Save off until every field is filled', () => {
    const out = html(
      <SecretForm
        id="f"
        fields={[
          { key: 'baseUrl', label: 'Base URL' },
          { key: 'apiKey', label: 'API key', secret: true },
        ]}
        note=""
        submit={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(out.match(/type="password"/g)).toHaveLength(1);
    expect(out.match(/type="text"/g)).toHaveLength(1);
    expect(out).toMatch(/<button type="submit"[^>]*disabled/);
  });
});

describe('confirmations', () => {
  const settings = {
    current: {
      connectors: ['github'],
      workspaces: [{ path: 'notes', mode: 'ro' }],
    },
  };
  const daemon = () => {
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return method === 'agents.settings' ? settings : { applied: true };
    };
    return { sent, read };
  };
  const update = (patch: object, apply = true) => ({ agentId: 'dev', patch, apply, base: 'b' });

  it('asks before an agent gets a new connector, directory or write access', async () => {
    for (const patch of [
      { connectors: ['github', 'gmail'] },
      { workspaces: [{ path: 'notes', mode: 'rw' }] },
      {
        workspaces: [
          { path: 'notes', mode: 'ro' },
          { path: 'code', mode: 'ro' },
        ],
      },
    ]) {
      const { sent, read } = daemon();
      const asked: string[] = [];
      await expect(
        guardedCall('agents.update', update(patch), read, async (q) => {
          asked.push(q.detail);
          return false;
        }),
      ).rejects.toThrow('cancelled');
      expect(asked, JSON.stringify(patch)).toHaveLength(1);
      expect(sent, 'refused: the update never reaches the daemon').toEqual(['agents.settings']);
    }
  });

  it('sends the change once confirmed, and does not ask for narrowing or reviews', async () => {
    const { sent, read } = daemon();
    await guardedCall('agents.update', update({ connectors: ['gmail'] }), read, async () => true);
    expect(sent).toEqual(['agents.settings', 'agents.update']);
    const never = async () => {
      throw new Error('asked');
    };
    for (const params of [
      update({ model: 'gpt-5' }),
      update({ connectors: [] }),
      update({ workspaces: [{ path: 'notes', mode: 'ro' }] }),
      update({ connectors: ['gmail'] }, false),
    ]) {
      await expect(
        guardedCall('agents.update', params, daemon().read, never),
      ).resolves.toBeTruthy();
    }
  });
});

describe('agent settings', () => {
  const current = {
    name: 'Dev',
    description: '',
    runtime: 'codex',
    model: '',
    effort: '',
    prompt: { mode: 'append', text: 'Be brief.' },
    skills: ['a'],
    connectors: ['github'],
    workspaces: [{ path: 'notes', mode: 'ro' }],
  } as AgentSettingValues;

  it('sends only what changed', () => {
    expect(settingsPatch(current, current)).toEqual({});
    expect(
      settingsPatch(current, {
        ...current,
        model: 'gpt-5',
        prompt: { mode: 'append', text: 'Be thorough.' },
        workspaces: [{ path: 'notes', mode: 'rw' }],
      }),
    ).toEqual({
      model: 'gpt-5',
      prompt: { mode: 'append', text: 'Be thorough.' },
      workspaces: [{ path: 'notes', mode: 'rw' }],
    });
  });
});

describe('skills', () => {
  it('takes skill sources from GitHub only; host paths come from the folder picker', () => {
    expect(
      checkCall('skills.add', { source: 'https://github.com/anthropics/skills/tree/main/x' })
        .method,
    ).toBe('skills.add');
    for (const source of [
      '/etc',
      '../x',
      '~/.ssh',
      'file:///etc/passwd',
      'http://github.com/a/b',
      'https://github.com.evil.example/a/b',
      'https://user@github.com/a/b',
      42,
      undefined,
    ]) {
      expect(() => checkCall('skills.add', { source }), String(source)).toThrow(/github/);
    }
  });

  it('removes a skill only after the dialog, naming the agents that list it', async () => {
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return method === 'agents.list'
        ? [
            { id: 'dev', skills: ['pdf'] },
            { id: 'ops', skills: [] },
          ]
        : null;
    };
    let detail = '';
    await expect(
      guardedCall('skills.remove', { id: 'pdf' }, read, async (q) => {
        detail = q.detail;
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(detail).toContain('@dev lists it');
    expect(detail).not.toContain('@ops');
    expect(sent, 'refused: nothing removed').toEqual(['agents.list']);
    await guardedCall('skills.remove', { id: 'pdf' }, read, async () => true);
    expect(sent.at(-1)).toBe('skills.remove');
  });
});

describe('packaged app PATH', () => {
  it('reads the PATH a login shell printed, whatever else its startup files print', () => {
    expect(parseShellPath('Welcome!\n__ANCHI_PATH__/a:/b__ANCHI_PATH__')).toBe('/a:/b');
    expect(parseShellPath('zsh: command not found: nvm')).toBeUndefined();
    expect(parseShellPath('__ANCHI_PATH____ANCHI_PATH__')).toBeUndefined();
  });

  it("keeps the app's PATH first, then the shell's, then the installer's, each once", () => {
    expect(mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:relative', '/home/u')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/home/u/.local/bin:/usr/local/bin',
    );
    expect(mergePath('/usr/bin', undefined, '/home/u')).toBe(
      '/usr/bin:/home/u/.local/bin:/opt/homebrew/bin:/usr/local/bin',
    );
  });
});

describe('format', () => {
  it('counts in the singular for one', () => {
    expect(count(1, 'skill')).toBe('1 skill');
    expect(count(2, 'task')).toBe('2 tasks');
    expect(count(0, 'trigger')).toBe('0 triggers');
  });
});

describe('connector logos', () => {
  it('names and marks every connector, with an initial where there is no mark', () => {
    for (const id of [...CONNECTOR_IDS, ...SERVICE_CONNECTORS]) {
      expect(connectorName(id), id).not.toBe(id);
      expect(renderToStaticMarkup(<ConnectorLogo id={id} />)).toContain('aria-hidden="true"');
    }
    expect(renderToStaticMarkup(<ConnectorLogo id="github" />)).toMatch(/^<svg class="logo"/);
    expect(renderToStaticMarkup(<ConnectorLogo id="aws" />)).toContain('>A</span>');
    expect(connectorName('someday')).toBe('someday');
  });
});

describe('setup guides', () => {
  const repo = new URL('../../../../', import.meta.url);
  const nginx = readFileSync(new URL('landing/nginx.conf', repo), 'utf8');
  const slug = (heading: string) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .replace(/ /g, '-');

  it('says where every token comes from', () => {
    for (const id of [...TOKEN_CONNECTOR_IDS, 'notion', 'slack']) {
      expect(TOKEN_SOURCE[id], id).toBeTruthy();
    }
  });

  it('sends every connector to a section that exists in the documentation', () => {
    for (const id of [...CONNECTOR_IDS, ...SERVICE_CONNECTORS]) {
      const path = new URL(guideUrl(id)).pathname;
      const target = nginx.match(new RegExp(`^\\s*${path}\\s+(\\S+);$`, 'm'))?.[1];
      expect(target, `${id}: no redirect in landing/nginx.conf`).toBeTruthy();
      const [file, anchor] = target!.split('#');
      const doc = readFileSync(new URL(`docs/${file}`, repo), 'utf8');
      const anchors = [...doc.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]!));
      expect(anchors, `${id}: docs/${file} has no #${anchor}`).toContain(anchor);
    }
  });
});

describe('servers', () => {
  const note = (probe: Parameters<typeof ProbeNote>[0]['added']['probe']) =>
    renderToStaticMarkup(
      <ProbeNote
        added={{ saved: { name: 'box', target: 'ssh:dev@box' }, probe }}
        onUse={() => {}}
      />,
    );

  it('offers initialization when a saved host has no Anchi yet, and offers a server that answers', () => {
    expect(
      note({ kind: 'bridge-missing', detail: 'x', hint: 'scripts/remote.sh ssh:dev@box' }),
    ).toContain('Choose Initialize');
    expect(note({ kind: 'ok' })).toContain('Use box');
    expect(note({ kind: 'unreachable', detail: 'no route\u001b[31m' })).toContain('no route');
    expect(note({ kind: 'unreachable', detail: 'no route\u001b[31m' })).not.toContain('\u001b');
  });

  it('keeps initialization available for saved machines and disables it while installing', () => {
    for (const status of ['needs-setup', 'installing'] as const) {
      const server = { name: 'instabox:dora', label: 'dora', status };
      const ctx: AppContext = {
        model: EMPTY_MODEL,
        dispatch: () => {},
        server,
        connections: [server],
        selectServer: () => {},
        call: async () => {
          throw new Error('unexpected RPC while rendering');
        },
        loadEvents: () => {},
        act: async (fn) => fn(),
        setView: () => {},
        deleteAgent: () => {},
      };
      const out = renderToStaticMarkup(
        <Ctx.Provider value={ctx}>
          <ServerCard />
        </Ctx.Provider>,
      );
      expect(out).toContain(status === 'installing' ? 'disabled="">Initializing…' : '>Initialize<');
      expect(out).not.toContain('scripts/remote.sh');
      expect(out).not.toContain('>Disconnect<');
    }
  });

  it('offers an upgrade only to a release install, and a note to a source checkout', () => {
    const render = (server: ServerState) =>
      renderToStaticMarkup(
        <Ctx.Provider
          value={{
            model: EMPTY_MODEL,
            dispatch: () => {},
            server,
            connections: [server],
            selectServer: () => {},
            call: async () => {
              throw new Error('unexpected RPC while rendering');
            },
            loadEvents: () => {},
            act: async (fn) => fn(),
            setView: () => {},
            deleteAgent: () => {},
          }}
        >
          <ServerCard />
        </Ctx.Provider>,
      );
    const dora: ServerState = {
      name: 'instabox:dora',
      label: 'dora',
      status: 'connected',
      version: '0.4.3',
      install: 'release',
    };
    const behind = render({ ...dora, newer: '0.4.4' });
    expect(behind).toContain('Anchi 0.4.3');
    expect(behind).toContain('>Upgrade to 0.4.4<');
    expect(render(dora)).not.toContain('Upgrade to');
    const source = render({ ...dora, install: 'source', newer: '0.4.4' });
    expect(source).not.toContain('Upgrade to');
    expect(source).toContain('scripts/remote.sh instabox:dora');
    const running = render({ ...dora, upgrading: true });
    expect(running).toContain('disabled="">Upgrading…');
  });
});

describe('getting started', () => {
  it('prepares the environment only after the system dialog', async () => {
    const sent: string[] = [];
    const read = async (method: string) => void sent.push(method);
    let asked = '';
    await expect(
      guardedCall('setup.prepare', { runtime: 'codex', confirm: true }, read, async (q) => {
        asked = q.detail;
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(asked).toContain('vault.key');
    expect(sent, 'refused: only the status was read').toEqual(['setup.status']);
    for (const method of ['setup.run', 'setup.reset']) {
      expect(() => checkCall(method, {})).toThrow(/does not call/);
    }
  });

  it('asks to unlock, not to install, when unlocking is all preparing does', async () => {
    const status = {
      vm: 'running',
      installed: true,
      vaultUnlocked: false,
      vaultKeyPresent: true,
      guestOutdated: false,
      preparedRuntimes: ['codex'],
    } as SetupStatus;
    const ask = async (s: Partial<SetupStatus>) => {
      let message = '';
      const read = async (method: string) =>
        method === 'setup.status' ? { ...status, ...s } : null;
      await guardedCall('setup.prepare', { runtime: 'codex', confirm: true }, read, async (q) => {
        message = q.message;
        return false;
      }).catch(() => undefined);
      return message;
    };
    expect(await ask({})).toBe('Unlock the vault?');
    for (const other of [
      { installed: false },
      { guestOutdated: true },
      { preparedRuntimes: [] },
      { vaultUnlocked: true },
    ]) {
      expect(await ask(other), JSON.stringify(other)).toBe('Prepare the Anchi environment?');
    }
    expect(vaultLocked({ ...status })).toBe(true);
    expect(vaultLocked({ ...status, error: 'GUEST_UNAVAILABLE' })).toBe(false);
    expect(
      vaultLocked({ ...status, vaultKeyPresent: false }),
      'a new vault, not a locked one',
    ).toBe(false);
  });

  it('remembers the guide per server, so switching to a new server opens it again', () => {
    const store = new Map<string, string>();
    const saved = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    try {
      setOnboarded('local');
      expect(onboarded('local')).toBe(true);
      expect(onboarded('instabox:anchi-newuser')).toBe(false);
    } finally {
      globalThis.localStorage = saved;
    }
  });

  it('says where to sign in to Codex when the server has no login', () => {
    expect(codexLoginHelp('HOST_LOGIN_MISSING', 'instabox:anchi-newuser')).toBe(
      'anchi-newuser has no Codex login yet. Run instabox ssh anchi-newuser, then codex login --device-auth there, then Set up again.',
    );
    expect(codexLoginHelp('HOST_LOGIN_EXPIRED', 'ssh:dev@box')).toContain('Run ssh dev@box,');
    expect(codexLoginHelp('HOST_LOGIN_MISSING', 'local')).toBe(
      'This computer has no Codex login yet. Run codex login, then Set up again.',
    );
    expect(codexLoginHelp('GUEST_UNAVAILABLE', 'local')).toBeUndefined();
  });

  it('maps where the daemon says the user is to the guide stage', () => {
    expect(stageFor('environment')).toBe('prepare');
    expect(stageFor('vault')).toBe('prepare');
    expect(stageFor('runtime')).toBe('runtime');
    expect(stageFor('agent')).toBe('start');
    expect(stageFor('task')).toBe('start');
    expect(stageFor('done')).toBe('done');
  });
});

describe('approval choices', () => {
  it('requires native confirmation for builder delegation grants too', async () => {
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      if (method === 'builder.proposal')
        return {
          agentId: 'lead',
          kind: 'update',
          agentYaml: 'runtime: codex\ndelegates: [dev, reviewer]\n',
        };
      return { fixed: { delegates: ['dev'] } };
    };
    await expect(
      guardedCall('builder.apply', { proposalId: 'p-1' }, read, async (q) => {
        expect(q.detail).toContain('delegate tasks to @reviewer');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(sent).toEqual(['builder.proposal', 'agents.settings']);
  });

  it('shows recipients excluding self and explains when the remote daemon needs updating', () => {
    const props = {
      agentId: 'lead',
      agents: ['lead', 'dev', 'reviewer'],
      legacy: ['dev'],
      onChange: () => {},
    };
    const html = renderToStaticMarkup(<DelegationChoices {...props} value={['dev', 'gone']} />);
    expect(html).not.toContain('@lead');
    expect(html).toContain('@reviewer');
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('unavailable team member');
    const old = renderToStaticMarkup(<DelegationChoices {...props} value={undefined} />);
    expect(old).toContain('Update this machine');
    expect(old).not.toContain('checkbox');
  });

  it('refuses new delegation grants when the native confirmation is cancelled', async () => {
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return { current: { delegates: ['dev'], connectors: [], workspaces: [] } };
    };
    await expect(
      guardedCall(
        'agents.update',
        {
          agentId: 'project-manager',
          patch: { delegates: ['dev', 'pr-approve'] },
          apply: true,
        },
        read,
        async (q) => {
          expect(q.detail).toContain('delegate tasks to @pr-approve');
          return false;
        },
      ),
    ).rejects.toThrow('cancelled');
    expect(sent).toEqual(['agents.settings']);
    sent.length = 0;
    await guardedCall(
      'agents.update',
      {
        agentId: 'project-manager',
        patch: { delegates: [] },
        apply: true,
      },
      read,
      async () => {
        throw new Error('revocation must not ask for more access');
      },
    );
    expect(sent).toEqual(['agents.settings', 'agents.update']);
  });

  const recorder = () => {
    const sent: string[] = [];
    return {
      sent,
      read: async (method: string) => {
        sent.push(method);
        return method === 'agents.settings'
          ? { current: { connectors: [], workspaces: [], highRisk: { disable: ['github-merge'] } } }
          : null;
      },
    };
  };

  it('lets X and Reddit post without asking only after the system dialog with the warning', async () => {
    for (const id of ['x', 'reddit']) {
      const { sent, read } = recorder();
      let detail = '';
      await expect(
        guardedCall('services.setMode', { id, mode: 'auto' }, read, async (q) => {
          detail = q.detail;
          return false;
        }),
      ).rejects.toThrow('cancelled');
      expect(detail).toContain('publicly under your account');
      expect(sent, `${id}: refused, nothing sent`).toEqual([]);
    }
    const never = async () => {
      throw new Error('asked');
    };
    for (const params of [
      { id: 'x', mode: 'ask' },
      { id: 'gmail', mode: 'auto' },
    ]) {
      await expect(
        guardedCall('services.setMode', params, recorder().read, never),
      ).resolves.toBeNull();
    }
  });

  it('disconnects a service only after the system dialog says what is revoked', async () => {
    const { sent, read } = recorder();
    let question = { message: '', detail: '' };
    await expect(
      guardedCall('services.disconnect', { id: 'gmail', account: 'work' }, read, async (q) => {
        question = q;
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(sent, 'refused, nothing sent').toEqual([]);
    expect(question.message).toBe('Disconnect Gmail account work?');
    expect(question.detail).toContain('revokes it at Google');

    await guardedCall('services.disconnect', { id: 'notion' }, read, async (q) => {
      expect(q.detail).toContain('remove the connection in Notion yourself');
      return true;
    });
    expect(sent).toEqual(['services.disconnect']);

    const never = async () => {
      throw new Error('asked');
    };
    for (const params of [
      { id: 'github' },
      { id: 'toString' },
      { id: 'gmail', account: 'Bad Name' },
    ]) {
      await expect(guardedCall('services.disconnect', params, read, never)).rejects.toThrow(
        /unknown service|invalid account/,
      );
    }
    expect(sent, 'invalid calls never reach the daemon').toEqual(['services.disconnect']);
  });

  it('asks before an agent may do a new high-risk operation without approval', async () => {
    const asked: string[] = [];
    const ask = async (q: { detail: string }) => {
      asked.push(q.detail);
      return false;
    };
    const update = (disable: string[]) => ({
      agentId: 'dev',
      apply: true,
      base: 'b',
      patch: { highRisk: { disable } },
    });
    await expect(
      guardedCall(
        'agents.update',
        update(['github-merge', 'github-push-main']),
        recorder().read,
        ask,
      ),
    ).rejects.toThrow('cancelled');
    expect(asked[0]).toContain('github-push-main');
    expect(asked[0]).not.toContain('github-merge');
    await guardedCall('agents.update', update([]), recorder().read, ask);
    expect(asked).toHaveLength(1);
  });
});

it('requires native confirmation before trusting a peer or opening its listener', async () => {
  const sent: string[] = [];
  const read = async (method: string) => {
    sent.push(method);
    return null;
  };
  const config = {
    label: 'local',
    listen: '127.0.0.1',
    port: 9847,
    address: 'tls://127.0.0.1:9847',
  };
  await expect(
    guardedCall('peers.configure', config, read, async (q) => {
      expect(q.detail).toContain('127.0.0.1:9847');
      return false;
    }),
  ).rejects.toThrow('cancelled');
  await expect(
    guardedCall(
      'peers.admit',
      {
        record: {
          node: 'a'.repeat(32),
          label: 'newuser',
          address: config.address,
          certificate: 'public certificate',
          revision: 1,
          agents: [],
          signature: 'signature',
        },
      },
      read,
      async (q) => {
        expect(q.detail).toContain('introduce or revoke');
        return false;
      },
    ),
  ).rejects.toThrow('cancelled');
  expect(sent).toEqual([]);
  expect(() =>
    checkCall('peers.configure', { ...config, address: 'https://example.com' }),
  ).toThrow();
});
