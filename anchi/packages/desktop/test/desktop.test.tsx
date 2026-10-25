import type { AgentSummary, Approval, StoredEvent, TaskRow } from '@anchi/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkCall, DESKTOP_METHODS, externalUrl } from '../src/main/bridge.ts';
import { type AppContext, Ctx } from '../src/renderer/App.tsx';
import { Markdown } from '../src/renderer/markdown.tsx';
import { agentActivity, EMPTY_MODEL, reduce } from '../src/renderer/model.ts';
import { toolSummary, transcript } from '../src/renderer/transcript.ts';
import { ApprovalCard } from '../src/renderer/views/Approvals.tsx';

const ev = (seq: number, event: StoredEvent['event']): StoredEvent => ({ seq, ts: seq, event });

describe('bridge', () => {
  it('lets the window call what it shows, and nothing that deletes, resets or stops', () => {
    expect(checkCall('tasks.create', { agentId: 'dev', text: 'x' }).method).toBe('tasks.create');
    expect(checkCall('approvals.decide', { id: 'a', allow: false }).method).toBe(
      'approvals.decide',
    );
    for (const method of [
      'daemon.shutdown',
      'setup.reset',
      'setup.run',
      'agents.delete',
      'tasks.delete',
      'skills.remove',
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
