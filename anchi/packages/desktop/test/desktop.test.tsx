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
import { switchLoginStartup } from '../src/main/startup.ts';
import { type AppContext, Ctx } from '../src/renderer/App.tsx';
import type { ServerState } from '../src/shared.ts';
import { count } from '../src/renderer/format.ts';
import { guideUrl, needsOAuthApp, TOKEN_SOURCE } from '../src/renderer/guides.ts';
import { ConnectorLogo, connectorName } from '../src/renderer/logos.tsx';
import { Markdown } from '../src/renderer/markdown.tsx';
import { agentActivity, EMPTY_MODEL, reduce } from '../src/renderer/model.ts';
import { toolSummary, transcript } from '../src/renderer/transcript.ts';
import {
  auditHosts,
  composerMode,
  historyTasks,
  reachChips,
  shownTask,
} from '../src/renderer/views/Agent.tsx';
import { plainWords } from '../src/renderer/access.ts';
import { DelegationChoices, settingsPatch } from '../src/renderer/views/AgentSettings.tsx';
import { ApprovalCard } from '../src/renderer/views/Approvals.tsx';
import { TEMPLATES } from '../src/renderer/views/Builder.tsx';
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
  it('allows the explicit deletion and reset flows while blocking single setup steps and shutdown', () => {
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
      'setup.run',
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
      'tasks.delete',
      'setup.resetPreview',
      'setup.reset',
    ]);
    // The word that resets is typed by the user and checked before anything is asked or sent.
    expect(() => checkCall('setup.reset', {})).toThrow(/type reset/);
    expect(() => checkCall('setup.reset', { confirm: 'Reset' })).toThrow(/type reset/);
    for (const profile of ['', 'a b', '../x', 'x'.repeat(65), 7]) {
      expect(() => checkCall('connectors.awsProfile', { profile }), String(profile)).toThrow(
        /AWS profile/,
      );
    }
    expect(() => checkCall('tasks.delete', {})).toThrow(/choose a task/);
    expect(() => checkCall('tasks.delete', { taskId: ['t-1'] })).toThrow(/choose a task/);
  });

  it('deletes a task only after a dialog that says what the daemon would delete', async () => {
    const row = (id: string, parentId: string | null, title: string) => ({
      id,
      agentId: 'dev',
      title,
      parentId,
      rootId: 't-root',
    });
    const tree = [
      row('t-root', null, 'the task above'),
      row('t-1', 't-root', 'tidy\u001b[31m the repo'),
      row('t-2', 't-1', 'delegated'),
      row('t-3', 't-2', 'delegated again'),
      row('t-4', 't-root', 'a sibling'),
    ];
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return method === 'tasks.tree' ? tree : { deleted: 3 };
    };
    await expect(
      guardedCall('tasks.delete', { taskId: 't-1' }, read, async (q) => {
        expect(q.message).toBe('Delete this task of @dev?');
        expect(q.detail).toContain('“tidy the repo” (t-1) and the 2 tasks it delegated');
        expect(q.detail).not.toContain('\u001b');
        expect(q.detail).toContain('cannot be undone');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(sent, 'nothing is deleted when the dialog is cancelled').toEqual(['tasks.tree']);
    await guardedCall('tasks.delete', { taskId: 't-1' }, read, async () => true);
    expect(sent).toEqual(['tasks.tree', 'tasks.tree', 'tasks.delete']);
    await expect(
      guardedCall('tasks.delete', { taskId: 't-gone' }, read, async () => true),
    ).rejects.toThrow('task not found');
  });

  it('resets only when no task runs, after a dialog that says what is deleted and kept', async () => {
    const preview = { vm: 'running', busy: 0, cells: 2, home: '/h/.anchi', vaultKey: '/h/key' };
    const sent: string[] = [];
    const reader = (states: object[]) => async (method: string) => {
      sent.push(method);
      return method === 'setup.resetPreview' ? states.shift() : { vm: 'missing' };
    };
    await expect(
      guardedCall(
        'setup.reset',
        { confirm: 'reset' },
        reader([{ ...preview, busy: 1 }]),
        async () => {
          throw new Error('asked while a task runs');
        },
      ),
    ).rejects.toThrow('1 task is running or queued');
    await expect(
      guardedCall('setup.reset', { confirm: 'reset' }, reader([preview]), async (q) => {
        expect(q.detail).toContain('every AI account and connection must be connected again');
        expect(q.detail).toContain('2 idle task cells are closed first');
        expect(q.detail).toContain('Kept: the vault key (/h/key) and /h/.anchi');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    await expect(
      guardedCall(
        'setup.reset',
        { confirm: 'reset' },
        reader([preview, { ...preview, busy: 1 }]),
        async () => true,
      ),
    ).rejects.toThrow('A task started during confirmation');
    expect(sent, 'refused every time: the reset was never sent').not.toContain('setup.reset');
    await guardedCall(
      'setup.reset',
      { confirm: 'reset' },
      reader([preview, preview]),
      async () => true,
    );
    expect(sent.at(-1)).toBe('setup.reset');
  });

  it('imports the gh login or an AWS profile only after a dialog that says what agents get', async () => {
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return { id: 'github', connected: true };
    };
    await expect(
      guardedCall('connectors.importGh', {}, read, async (q) => {
        expect(q.detail).toContain('every scope of that login');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    await expect(
      guardedCall('connectors.awsProfile', { profile: 'dev-readonly' }, read, async (q) => {
        expect(q.message).toBe('Connect AWS through the profile dev-readonly?');
        expect(q.detail).toContain('whatever the profile’s role allows');
        return false;
      }),
    ).rejects.toThrow('cancelled');
    expect(sent, 'cancelled: no credential was read').toEqual([]);
    await guardedCall('connectors.importGh', {}, read, async () => true);
    expect(sent).toEqual(['connectors.importGh']);
  });

  it('lets an agent reach a new host only after a dialog that says what that allows', async () => {
    for (const host of ['', '*.example.com', 'a b', 'https://x.io', 'x'.repeat(260), 7]) {
      expect(
        () => checkCall('agents.allowHost', { agentId: 'dev', host }),
        String(host).slice(0, 20),
      ).toThrow(/one host name/);
    }
    expect(() => checkCall('agents.allowHost', { agentId: '../x', host: 'x.io' })).toThrow();
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return { egress: ['github.com', 'x.io'] };
    };
    await expect(
      guardedCall(
        'agents.allowHost',
        { agentId: 'dev', host: ' Registry.NPMJS.org ' },
        read,
        async (q) => {
          expect(q.message).toBe('Let @dev reach registry.npmjs.org?');
          expect(q.detail).toContain('including the contents of shared folders');
          return false;
        },
      ),
    ).rejects.toThrow('cancelled');
    expect(sent, 'cancelled: the agent file was not changed').toEqual([]);
    await guardedCall('agents.allowHost', { agentId: 'dev', host: 'x.io' }, read, async () => true);
    expect(sent).toEqual(['agents.allowHost']);
    // Reading what agents reached changes nothing and needs no dialog.
    await guardedCall('access.summary', {}, read, async () => {
      throw new Error('asked for a read');
    });
  });

  it('asks before an agent stops asking for its writes or starts tasks by itself', async () => {
    const current = {
      connectors: ['github', 'x'],
      workspaces: [],
      delegates: [],
      highRisk: { disable: [] },
      approvals: { github: 'ask' },
      triggers: [{ schedule: '0 9 * * *', text: 'daily' }],
    };
    const sent: string[] = [];
    const read = async (method: string) => {
      sent.push(method);
      return method === 'agents.settings' ? { current } : { applied: true };
    };
    const apply = (patch: object, answer: (detail: string) => boolean) =>
      guardedCall('agents.update', { agentId: 'dev', patch, apply: true }, read, async (q) =>
        answer(q.detail),
      );
    let detail = '';
    await expect(
      apply(
        {
          approvals: { x: 'auto' },
          triggers: [
            { schedule: '0 9 * * *', text: 'daily' },
            { schedule: '*/5 * * * *\u001b[31m', text: 'often' },
          ],
        },
        (d) => {
          detail = d;
          return false;
        },
      ),
    ).rejects.toThrow('cancelled');
    expect(detail).toContain('• write through github without asking you');
    expect(detail).toContain('• write through x without asking you');
    expect(detail).toContain('• start tasks by itself on the schedule */5 * * * *');
    expect(detail, 'the schedule it already had is not asked again').not.toContain('0 9 * * *');
    expect(detail).not.toContain('\u001b');
    expect(sent, 'cancelled: nothing was saved').toEqual(['agents.settings']);
    // Asking for more approvals, or dropping a schedule, narrows: no dialog.
    await apply({ approvals: { github: 'ask', x: 'ask' }, triggers: [] }, () => {
      throw new Error('asked for a narrowing change');
    });
    expect(sent.at(-1)).toBe('agents.update');
  });

  it('asks before an agent reaches more hosts, not before it reaches fewer', async () => {
    const settings = (egress: string[] | null) => ({
      current: { connectors: [], workspaces: [], delegates: [], highRisk: { disable: [] }, egress },
    });
    const asked: string[] = [];
    const apply = (egress: string[] | null, now: string[] | null) =>
      guardedCall(
        'agents.update',
        { agentId: 'dev', patch: { egress }, apply: true },
        async (method) => (method === 'agents.settings' ? settings(now) : { applied: true }),
        async (q) => {
          asked.push(q.detail);
          return false;
        },
      );
    await expect(apply(['github.com', 'evil.example'], ['github.com'])).rejects.toThrow(
      'cancelled',
    );
    expect(asked.at(-1)).toContain('• reach evil.example');
    expect(asked.at(-1)).not.toContain('github.com');
    await expect(apply(null, ['github.com'])).rejects.toThrow('cancelled');
    expect(asked.at(-1)).toContain('• reach any public website');
    // Starting a list, or shortening one, only narrows.
    await apply(['github.com'], null);
    await apply([], ['github.com']);
    expect(asked).toHaveLength(2);
  });

  it('switches start at login only after its dialog, through the CLI, on this computer', async () => {
    const ran: string[][] = [];
    let item = false;
    const deps = (answer: boolean, platform = 'darwin') => ({
      platform,
      installed: () => item,
      confirm: async (q: { message: string; detail: string }) => {
        expect(q.message).toMatch(/log in|at login/);
        return answer;
      },
      run: async (args: string[]) => {
        ran.push(args);
        item = args.at(-1) === 'install';
      },
    });
    expect(await switchLoginStartup(true, deps(false)), 'declined: nothing installed').toBe(false);
    expect(ran).toEqual([]);
    expect(await switchLoginStartup(true, deps(true))).toBe(true);
    expect(ran).toEqual([['--server', 'local', 'daemon', 'install']]);
    // Removing it stops a daemon that login started, so it is asked too.
    expect(await switchLoginStartup(false, deps(false)), 'declined: still installed').toBe(true);
    expect(await switchLoginStartup(false, deps(true))).toBe(false);
    expect(ran.at(-1)).toEqual(['--server', 'local', 'daemon', 'uninstall']);
    await expect(switchLoginStartup('yes', deps(true))).rejects.toThrow('choose on or off');
    await expect(switchLoginStartup(true, deps(true, 'win32'))).rejects.toThrow(/Windows/);
    expect(ran).toHaveLength(2);
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
    // The band that agent text cannot draw comes first.
    expect(out.indexOf('Anchi · needs your approval')).toBeLessThan(
      out.indexOf('Approve a write by @assistant?'),
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
  const task = (over: Partial<TaskRow>) =>
    ({
      id: 't-1',
      agentId: 'dev',
      title: 'go',
      status: 'done',
      trigger: 'user',
      ...over,
    }) as TaskRow;

  it('continues a task whose turn has ended, and starts a new one only when asked', () => {
    expect(composerMode(task({ status: 'done' }), false)).toBe('continue');
    expect(composerMode(task({ status: 'failed' }), false)).toBe('continue');
    expect(composerMode(task({ status: 'cancelled' }), false)).toBe('continue');
    expect(composerMode(task({ status: 'done' }), true), 'Start a new task').toBe('new');
    expect(composerMode(undefined, false), 'no task yet').toBe('new');
  });

  it('takes no reply while a turn runs, nor for a task only watched through its parent', () => {
    expect(composerMode(task({ status: 'running' }), false)).toBe('wait');
    expect(composerMode(task({ status: 'queued' }), false)).toBe('wait');
    expect(
      composerMode(task({ peer: { kind: 'mirror', observed: true } as TaskRow['peer'] }), false),
    ).toBe('observed');
  });

  it('shows the chosen task while it exists, else the newest', () => {
    const tasks = [task({ id: 'a', createdAt: 1 }), task({ id: 'b', createdAt: 2 })];
    expect(shownTask(tasks, 'a')?.id).toBe('a');
    expect(shownTask(tasks, undefined)?.id).toBe('b');
    expect(shownTask(tasks, 'deleted')?.id).toBe('b');
    expect(shownTask([], 'a')).toBeUndefined();
  });

  it('narrows history by state and by words in the title or the result, newest first', () => {
    const tasks = [
      task({ id: 'a', createdAt: 1, title: 'Fix login', result: 'opened a pull request' }),
      task({ id: 'b', createdAt: 2, title: 'Upgrade eslint', status: 'failed' }),
      task({ id: 'c', createdAt: 3, title: 'Review login PR', status: 'running' }),
    ];
    const ids = (
      ...args: Parameters<typeof historyTasks> extends [unknown, ...infer R] ? R : never
    ) => historyTasks(tasks, ...args).map((t) => t.id);
    expect(ids('all', '', [])).toEqual(['c', 'b', 'a']);
    expect(ids('running', '', [])).toEqual(['c']);
    expect(ids('failed', '', [])).toEqual(['b']);
    expect(ids('needs', '', [{ task: 'a' } as Approval])).toEqual(['a']);
    expect(ids('all', 'LOGIN', [])).toEqual(['c', 'a']);
    expect(ids('all', 'pull request', []), 'words in the result').toEqual(['a']);
    expect(ids('failed', 'login', [])).toEqual([]);
  });

  it('says in the header what the agent thinks with and what it can reach', () => {
    const agent = { runtime: 'codex', connectors: ['github'] } as AgentSummary;
    expect(reachChips(agent).map((c) => c.text)).toEqual([
      'ChatGPT',
      'GitHub',
      'No access to your files',
    ]);
    expect(
      reachChips({ ...agent, connectors: [], workspaces: ['shop (ro)'] }).map((c) => c.text),
    ).toEqual(['ChatGPT', '1 shared folder']);
  });

  it('counts what each host was asked and what was refused in the task record', () => {
    const audit = {
      hosts: [
        { host: 'api.github.com', requests: 9, injected: 7, decisions: { inject: 7, pass: 2 } },
        {
          host: 'evil.example\u001b[0m',
          requests: 2,
          injected: 0,
          decisions: { 'egress-denied': 2 },
        },
      ],
    } as never;
    expect(auditHosts(audit)).toEqual([
      { host: 'api.github.com', note: '9 requests · 7 with your account', refused: false },
      { host: 'evil.example', note: '2 requests · 2 refused', refused: true },
    ]);
  });
});

describe('new agent templates', () => {
  it('asks the builder for an agent with a valid id and only connectors that exist', () => {
    const known: string[] = [...CONNECTOR_IDS, ...SERVICE_CONNECTORS];
    for (const t of TEMPLATES) {
      expect(t.request, t.id).toContain(`with the id ${t.id} `);
      expect(t.id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      const named = [...t.request.matchAll(/the ([a-z ]+?) connectors?\b/g)].flatMap((m) =>
        m[1]!.split(' and '),
      );
      for (const id of named) expect(known, `${t.id}: ${id}`).toContain(id);
      // A template never asks for access without the user's approval of what it writes.
      if (named.length) expect(t.request, t.id).toMatch(/ask me|my approval/);
    }
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'reviewer',
      'developer',
      'inbox',
      'researcher',
      'social',
    ]);
  });
});

describe('access in plain words', () => {
  const fixed = { approvals: {}, egress: null, sandbox: 'cell', delegates: [] };
  const none = { connectors: [], workspaces: [], delegates: [], highRisk: { disable: [] } };
  const text = (lines: ReturnType<typeof plainWords>, can: boolean) =>
    lines.filter((l) => l.can === can).map((l) => l.text);

  it('says an agent with nothing granted reaches no account and no file', () => {
    const lines = plainWords(none, fixed);
    expect(text(lines, true)).toEqual(['Reaches any public website']);
    expect(text(lines, false)).toEqual([
      'Cannot read any file on this computer',
      'Cannot use any of your connected accounts',
      'Cannot hand work to another agent',
      'Never sees a password or token: Anchi adds them outside its cell',
    ]);
  });

  it('names each grant, and marks write access and skipped approvals', () => {
    const lines = plainWords(
      {
        connectors: ['github', 'gmail'],
        workspaces: [
          { path: 'shop', mode: 'ro' },
          { path: 'notes\u001b[31m', mode: 'rw' },
        ],
        delegates: ['reviewer'],
        highRisk: { disable: ['github.merge'] },
      },
      {
        ...fixed,
        approvals: { github: 'ask' },
        egress: ['github.com'],
        highRiskGlobal: ['x.post'],
      },
      (id) => id.toUpperCase(),
    );
    expect(text(lines, true)).toEqual([
      'Acts through GITHUB; anything that writes waits for you',
      'Acts through GMAIL; high-risk operations wait for you',
      'Reads files in shop',
      'Reads and changes files in notes',
      'Hands work to @reviewer',
      'Reaches only github.com',
      'Does without asking: github.merge, x.post',
    ]);
    expect(lines.filter((l) => l.warn).map((l) => l.text)).toEqual([
      'Reads and changes files in notes',
      'Does without asking: github.merge, x.post',
    ]);
    expect(text(lines, false)).toEqual([
      'Cannot read files outside the shared folders',
      'Cannot use an account that is not switched on here',
      'Never sees a password or token: Anchi adds them outside its cell',
    ]);
  });

  it('follows the approvals and schedules of the draft, before they are saved', () => {
    const lines = plainWords(
      {
        ...none,
        connectors: ['github'],
        approvals: { github: 'ask' },
        triggers: [{ schedule: '0 9 * * *', text: 'daily' }],
      },
      // What the file says now is not what the draft says.
      { ...fixed, approvals: {} },
    );
    expect(text(lines, true)).toContain('Acts through github; anything that writes waits for you');
    expect(lines.find((l) => l.text === 'Starts tasks by itself: 1 schedule')?.warn).toBe(true);
    // The draft's hosts, not the file's.
    expect(
      text(plainWords({ ...none, egress: ['github.com'] }, { ...fixed, egress: null }), true),
    ).toEqual(['Reaches only github.com']);
    expect(
      text(plainWords({ ...none, egress: null }, { ...fixed, egress: ['a.io'] }), true),
    ).toEqual(['Reaches any public website']);
  });

  it('says so when no website may be reached, and falls back to the fixed delegates', () => {
    const lines = plainWords(
      { ...none, delegates: undefined },
      { ...fixed, egress: [], delegates: ['ops'] },
    );
    expect(text(lines, false)).toContain('Cannot reach any website of its own choosing');
    expect(text(lines, true)).toContain('Hands work to @ops');
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
    expect(out.match(/>Set up</g)).toHaveLength(1);
    // Codex signs in to ChatGPT in the browser; importing a Codex CLI login is the other way.
    expect(out).toContain('>Sign in again with ChatGPT<');
    expect(out).toContain('>Import Codex login<');
    // Claude signs in in the browser too; pasting a token or API key is the other way.
    expect(out).toMatch(
      /class="btn btn-small runtime-action btn-primary"[^>]*>Sign in with Claude</,
    );
    expect(out).toContain('>Paste a token or API key<');
    const fresh = html(
      <Runtimes
        status={{ ...status, codex: { ...status.codex!, connected: false } } as SetupStatus}
        server="instabox:anchi-dora"
        onChange={() => undefined}
      />,
    );
    expect(fresh).toMatch(
      /class="btn btn-small runtime-action btn-primary"[^>]*>Sign in with ChatGPT</,
    );
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
    // Single setup steps stay out of reach; a reset needs its typed word and its own dialog.
    expect(() => checkCall('setup.run', {})).toThrow(/does not call/);
    expect(() => checkCall('setup.reset', {})).toThrow(/type reset to confirm/);
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
