import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { SERVICE_CONNECTORS } from '@anchi/core';
import { CONNECTOR_IDS } from '@anchi/protocol';
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
import { type AppContext, Ctx } from '../src/renderer/App.tsx';
import { ConnectorLogo, connectorName } from '../src/renderer/logos.tsx';
import { Markdown } from '../src/renderer/markdown.tsx';
import { agentActivity, EMPTY_MODEL, reduce } from '../src/renderer/model.ts';
import { toolSummary, transcript } from '../src/renderer/transcript.ts';
import { clampWidth, PANEL_WIDTH } from '../src/renderer/ui.tsx';
import { TaskTurn } from '../src/renderer/views/Agent.tsx';
import { settingsPatch } from '../src/renderer/views/AgentSettings.tsx';
import { ApprovalCard } from '../src/renderer/views/Approvals.tsx';
import {
  codexLoginHelp,
  ProbeNote,
  Runtimes,
  SecretForm,
} from '../src/renderer/views/Settings.tsx';
import { onboarded, setOnboarded, stageFor } from '../src/renderer/views/Welcome.tsx';

const ev = (seq: number, event: StoredEvent['event']): StoredEvent => ({ seq, ts: seq, event });

describe('bridge', () => {
  it('lets the window call what it shows, and nothing that deletes, resets or stops', () => {
    expect(checkCall('tasks.create', { agentId: 'dev', text: 'x' }).method).toBe('tasks.create');
    expect(checkCall('approvals.decide', { id: 'a', allow: false }).method).toBe(
      'approvals.decide',
    );
    expect(checkCall('setup.importHermes', {}).method).toBe('setup.importHermes');
    for (const method of [
      'daemon.shutdown',
      'setup.reset',
      'setup.run',
      'agents.delete',
      'tasks.delete',
      'agents.allowHost',
      'nope',
      42,
    ]) {
      expect(() => checkCall(method, {}), String(method)).toThrow(/does not call/);
    }
    expect([...DESKTOP_METHODS].filter((m) => /delete|reset|shutdown|setup\.run/.test(m))).toEqual(
      [],
    );
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

describe('servers', () => {
  const note = (probe: Parameters<typeof ProbeNote>[0]['added']['probe']) =>
    renderToStaticMarkup(
      <ProbeNote
        added={{ saved: { name: 'box', target: 'ssh:dev@box' }, probe }}
        onUse={() => {}}
      />,
    );

  it('says what to run when a saved host has no Anchi yet, and offers a server that answers', () => {
    expect(
      note({ kind: 'bridge-missing', detail: 'x', hint: 'scripts/remote.sh ssh:dev@box' }),
    ).toContain('scripts/remote.sh ssh:dev@box');
    expect(note({ kind: 'ok' })).toContain('Use box');
    expect(note({ kind: 'unreachable', detail: 'no route\u001b[31m' })).toContain('no route');
    expect(note({ kind: 'unreachable', detail: 'no route\u001b[31m' })).not.toContain('\u001b');
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
    expect(sent, 'refused: nothing prepared').toEqual([]);
    for (const method of ['setup.run', 'setup.reset']) {
      expect(() => checkCall(method, {})).toThrow(/does not call/);
    }
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
