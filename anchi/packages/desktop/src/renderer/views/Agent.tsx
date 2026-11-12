import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { AgentSummary, Approval, TaskAudit, TaskRow } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentLabel, useApp } from '../App.tsx';
import { message } from '../api.ts';
import { ago, count, duration, tokens } from '../format.ts';
import { connectorName } from '../logos.tsx';
import { Markdown } from '../markdown.tsx';
import { agentTasks } from '../model.ts';
import { doing, transcript } from '../transcript.ts';
import { accountName, Avatar, Composer, Icon, Linked, StatusPill } from '../ui.tsx';
import { AgentSettingsView } from './AgentSettings.tsx';
import { ApprovalCard } from './Approvals.tsx';
import { TranscriptItem } from './TaskPanel.tsx';

type Tab = 'chat' | 'access' | 'advanced';
const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'access', label: 'Access' },
  { id: 'advanced', label: 'Advanced' },
];

/**
 * What the one message box does. A task whose turn has ended is continued in its own session;
 * a new task is a deliberate choice, because it starts a new session that knows nothing of this
 * one. A running turn takes no reply, and a task watched through its parent takes none here.
 */
export type ComposerMode = 'new' | 'continue' | 'wait' | 'observed';
export function composerMode(task: TaskRow | undefined, fresh: boolean): ComposerMode {
  if (!task || fresh) return 'new';
  if (task.peer?.kind === 'mirror' && task.peer.observed) return 'observed';
  return task.status === 'running' || task.status === 'queued' ? 'wait' : 'continue';
}

/** The task the conversation shows: the chosen one while it exists, else the newest. */
export function shownTask(tasks: TaskRow[], chosen: string | undefined): TaskRow | undefined {
  return tasks.find((t) => t.id === chosen) ?? tasks.at(-1);
}

export type HistoryFilter = 'all' | 'running' | 'needs' | 'failed';
const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'needs', label: 'Needs you' },
  { id: 'failed', label: 'Failed' },
];

/** An agent's tasks for History: newest first, narrowed by state and by words in title or result. */
export function historyTasks(
  tasks: TaskRow[],
  filter: HistoryFilter,
  text: string,
  approvals: Approval[],
): TaskRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return tasks
    .filter((t) => {
      if (filter === 'running' && t.status !== 'running' && t.status !== 'queued') return false;
      if (filter === 'needs' && !approvals.some((a) => a.task === t.id)) return false;
      if (filter === 'failed' && t.status !== 'failed') return false;
      const hay = `${t.title}\n${t.result ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** What the header says an agent can reach, from its summary. */
export function reachChips(agent: AgentSummary): { text: string; tone: 'off' | 'ok' }[] {
  const chips: { text: string; tone: 'off' | 'ok' }[] = [];
  if (agent.runtime) chips.push({ text: accountName(agent.runtime), tone: 'off' });
  for (const id of agent.connectors) chips.push({ text: connectorName(id), tone: 'ok' });
  const folders = agent.workspaces?.length ?? 0;
  chips.push(
    folders
      ? { text: count(folders, 'shared folder'), tone: 'ok' }
      : { text: 'No access to your files', tone: 'off' },
  );
  return chips;
}

const started = (task: TaskRow) =>
  task.trigger === 'user' ? 'started by you' : `started by ${sanitizeLine(task.trigger)}`;

export function AgentView({ agentId }: { agentId: string }) {
  const { model, act, server, call } = useApp();
  const agent = model.agents.find((a) => a.id === agentId);
  const tasks = agentTasks(model, agentId);
  const [tab, setTab] = useState<Tab>('chat');
  const [history, setHistory] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const [record, setRecord] = useState(false);

  if (!agent) return <main className="main empty">This agent no longer exists.</main>;
  const task = fresh ? undefined : shownTask(tasks, chosen);
  const mode = composerMode(task, fresh);
  const name = agentLabel(agent);
  const open = (id: string) => {
    setChosen(id);
    setFresh(false);
    setHistory(false);
  };

  return (
    <div
      className="agent-workspace"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && record) {
          e.preventDefault();
          setRecord(false);
        }
      }}
    >
      <main className="main">
        <div className="main-head">
          <Avatar id={agent.peer?.agent ?? agent.id} size={36} />
          <div className="col grow min0 gap-xs">
            <span className="row min0">
              <span className="title ellipsis">{name}</span>
              {name !== `@${agent.peer?.agent ?? agent.id}` && (
                <span className="small muted head-id">@{agent.peer?.agent ?? agent.id}</span>
              )}
              {(agent.peer || agent.execution) && (
                <span className="tag tag-off server-tag" title="The machine this agent runs on">
                  on {sanitizeLine(agent.peer?.machine ?? agent.execution?.server ?? server.label)}
                </span>
              )}
            </span>
            <span className="chips">
              {reachChips(agent).map((c) => (
                <span key={c.text} className={`chip chip-${c.tone}`}>
                  {c.text}
                </span>
              ))}
            </span>
          </div>
          {tab === 'chat' && (
            <button
              type="button"
              className={`btn btn-ghost ${history ? 'pressed' : ''}`}
              aria-pressed={history}
              onClick={() => {
                setHistory(!history);
                setRecord(false);
              }}
            >
              <Icon name="clock" size={15} /> History
            </button>
          )}
          <div className="segmented" role="tablist" aria-label="Agent view">
            {TABS.map((t) => (
              <button
                type="button"
                role="tab"
                key={t.id}
                aria-selected={tab === t.id}
                aria-pressed={tab === t.id}
                onClick={() => {
                  setRecord(false);
                  setTab(t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {agent.error && (
          <div className="banner banner-error">
            This agent cannot run: {sanitizeLine(agent.error)}
          </div>
        )}

        {tab !== 'chat' ? (
          agent.peer ? (
            <div className="pad">
              AI account, connections, skills and teammates belong to{' '}
              {sanitizeLine(agent.peer.machine)}. Open that machine in Settings to edit this agent.
              Task history here contains work submitted through {sanitizeLine(server.label)}.
            </div>
          ) : (
            <AgentSettingsView agentId={agent.id} part={tab} />
          )
        ) : history ? (
          <History
            agentId={agentId}
            tasks={tasks}
            chosen={task?.id}
            onOpen={open}
            onGone={() => setChosen(undefined)}
          />
        ) : (
          <>
            <div className="scroll conversation thread-pane">
              {task ? (
                <Thread key={task.id} task={task} onRecord={() => setRecord(!record)} />
              ) : (
                <div className="thread-empty">
                  <Avatar id={agent.peer?.agent ?? agent.id} size={48} />
                  <span className="strong">
                    {tasks.length ? `A new task for ${name}` : `Give ${name} a first task`}
                  </span>
                  <span className="small muted">
                    A new task starts fresh: it remembers nothing from earlier tasks.
                    {agent.description ? ` ${sanitizeLine(agent.description)}` : ''}
                  </span>
                </div>
              )}
            </div>
            <div className="thread-composer">
              <Composer
                label={mode === 'continue' ? `Reply to ${name}` : `New task for ${name}`}
                placeholder={
                  mode === 'wait'
                    ? 'Wait for this turn to end to reply'
                    : mode === 'observed'
                      ? 'Reply from the machine that started this task'
                      : mode === 'continue'
                        ? `Reply to ${name}…`
                        : `Give ${name} a new task…`
                }
                disabled={!!agent.error || mode === 'wait' || mode === 'observed'}
                onSend={async (text) => {
                  if (mode === 'continue' && task) {
                    return act(() => call('tasks.send', { taskId: task.id, text }));
                  }
                  const created = await act(() => call('tasks.create', { agentId, text }));
                  if (created) open(created.id);
                }}
              />
              <div className="composer-mode">
                {mode === 'new' ? (
                  <>
                    <span className="chip chip-ok">New task</span>
                    {tasks.length > 0 && (
                      <button type="button" className="link small" onClick={() => setFresh(false)}>
                        Back to the current task
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="chip chip-ok">
                      {mode === 'continue' ? 'Continuing this task' : 'This task is working'}
                    </span>
                    <button type="button" className="link small" onClick={() => setFresh(true)}>
                      Start a new task
                    </button>
                  </>
                )}
                <span className="grow" />
                <span className="small muted row gap-xs">
                  <Icon name="lock" size={12} />
                  {agent.peer
                    ? `Runs on ${sanitizeLine(agent.peer.machine)}`
                    : 'Runs in a sealed cell. Your passwords and tokens never enter it.'}
                </span>
              </div>
            </div>
          </>
        )}
      </main>
      {record && task && tab === 'chat' && !history && (
        <TaskRecord key={task.id} task={task} onClose={() => setRecord(false)} />
      )}
    </div>
  );
}

/** One task read as a conversation: what was asked, what the agent did and said, what waits. */
function Thread({ task, onRecord }: { task: TaskRow; onRecord: () => void }) {
  const { model, loadEvents, act, call } = useApp();
  useEffect(() => {
    loadEvents(task.id);
  }, [task.id, loadEvents]);
  const items = useMemo(() => transcript(model.events[task.id] ?? []), [model.events, task.id]);
  const approvals = model.approvals.filter((a) => a.task === task.id);
  const children = Object.values(model.tasks).filter((t) => t.parentId === task.id);
  const active = task.status === 'running' || task.status === 'queued';
  const now = doing(items);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, approvals.length]);
  const observed = task.peer?.kind === 'mirror' && task.peer.observed;
  const elapsed = task.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : 0;

  return (
    <div className="thread">
      <div className="thread-meta small muted">
        <span>
          {ago(task.createdAt)} · {started(task)}
        </span>
        <StatusPill status={task.status} waiting={approvals.length > 0} />
        <span>
          {task.startedAt ? duration(elapsed) : 'not started'}
          {task.inputTokens
            ? ` · ${tokens(task.inputTokens)} in / ${tokens(task.outputTokens)} out`
            : ''}
        </span>
        <button type="button" className="link small" onClick={onRecord}>
          What it touched
        </button>
      </div>
      {!items.some((i) => i.kind === 'input') && (
        <div className={`bubble-user ${task.trigger !== 'user' ? 'bubble-system' : ''}`}>
          <Linked text={sanitizeLine(task.title)} />
        </div>
      )}
      {items.map((i) =>
        i.kind === 'input' ? (
          <div key={i.seq} className={`bubble-user ${i.fromTask ? 'bubble-system' : ''}`}>
            {i.fromTask && <div className="small bubble-from">from another task</div>}
            <Linked text={i.text} />
          </div>
        ) : i.kind === 'message' ? (
          <div key={i.seq} className="thread-message">
            <Markdown text={i.text} />
          </div>
        ) : (
          <div key={i.seq} className="thread-aside">
            <TranscriptItem item={i} />
          </div>
        ),
      )}
      {!items.length &&
        (observed ? (
          <span className="small muted">
            Open the machine that runs this task for its full transcript.
          </span>
        ) : (
          !task.result && <span className="small muted">Loading…</span>
        ))}
      {!items.some((i) => i.kind === 'message') && !active && task.result && (
        <div className="thread-message">
          <Markdown text={sanitize(task.result.slice(0, 20_000))} />
        </div>
      )}
      {children.length > 0 && (
        <div className="chips">
          {children.map((c) => (
            <span key={c.id} className="chip">
              ↳ handed to @{sanitizeLine(c.agentId)} · {c.status}
              {c.execution ? ` · ${sanitizeLine(c.execution.server)}` : ''}
            </span>
          ))}
        </div>
      )}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} full />
      ))}
      {active && (
        <div className="doing small">
          <span className="spinner" aria-hidden="true" />
          {now ? (
            <>
              Doing: <span className="mono">{now}</span>
            </>
          ) : task.status === 'queued' ? (
            'Waiting for a free slot…'
          ) : (
            'Working…'
          )}
          {!observed && (
            <button
              type="button"
              className="link small"
              onClick={() =>
                void act(() => call('tasks.cancel', { taskId: task.id }), 'cancellation requested')
              }
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {!observed && (task.status === 'failed' || task.status === 'cancelled') && (
        <div className="thread-recover">
          <span className="small">
            This task {task.status === 'failed' ? 'failed' : 'was cancelled'}.
          </span>
          <TaskActions task={task} compact />
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

/** Retry in the same session, start over with the original request, or cancel what runs. */
function TaskActions({ task, compact }: { task: TaskRow; compact?: boolean }) {
  const { act, call } = useApp();
  const active = task.status === 'running' || task.status === 'queued';
  const again = task.status === 'failed' || task.status === 'cancelled';
  const size = compact ? 'btn btn-small' : 'btn';
  return (
    <>
      {again && (
        <>
          <button
            type="button"
            className={size}
            title="Continues this task from where it stopped, in the same session"
            onClick={() =>
              void act(
                () => call('tasks.retry', { taskId: task.id }),
                'retrying in the same session',
              )
            }
          >
            <Icon name="retry" size={14} /> Retry
          </button>
          <button
            type="button"
            className={size}
            title="Creates a new task with the original request; nothing carries over"
            onClick={() =>
              void act(() => call('tasks.retry', { taskId: task.id, fresh: true }), 'started over')
            }
          >
            Start over
          </button>
        </>
      )}
      {active && (
        <button
          type="button"
          className={size}
          title="Stops the agent now; anything waiting for approval is refused"
          onClick={() =>
            void act(() => call('tasks.cancel', { taskId: task.id }), 'cancellation requested')
          }
        >
          <Icon name="stop" size={14} /> Cancel task
        </button>
      )}
    </>
  );
}

/** Every task of the agent, to find one, read what became of it, and act on it. */
function History({
  agentId,
  tasks,
  chosen,
  onOpen,
  onGone,
}: {
  agentId: string;
  tasks: TaskRow[];
  chosen: string | undefined;
  onOpen: (taskId: string) => void;
  onGone: () => void;
}) {
  const { model, act, call, dispatch } = useApp();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(chosen);
  // The window holds the newest tasks; words also search the older ones on the machine.
  useEffect(() => {
    const words = text.trim();
    if (words.length < 2) return;
    const timer = setTimeout(() => {
      void call('tasks.search', { agentId, text: words, limit: 200 })
        .then((found) => dispatch({ type: 'tasks', tasks: found }))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [agentId, text, call, dispatch]);
  const shown = historyTasks(tasks, filter, text, model.approvals);
  const task = shown.find((t) => t.id === selected) ?? shown[0];
  const children = task ? Object.values(model.tasks).filter((t) => t.parentId === task.id) : [];
  const active = task?.status === 'running' || task?.status === 'queued';
  const elapsed = task?.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : 0;

  return (
    <div className="history">
      <div className="history-list" aria-label="Tasks">
        <label className="search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search this agent’s tasks</span>
          <input
            value={text}
            placeholder="Search this agent’s tasks"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`chip chip-button ${filter === f.id ? 'chip-on' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="history-rows scroll">
          {shown.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`history-row ${t.id === task?.id ? 'selected' : ''}`}
              aria-current={t.id === task?.id}
              onClick={() => setSelected(t.id)}
              onDoubleClick={() => onOpen(t.id)}
            >
              <span className="row gap-xs min0">
                {t.trigger !== 'user' && <Icon name="clock" size={13} />}
                <span className="strong ellipsis">{sanitizeLine(t.title)}</span>
              </span>
              <span className="row between">
                <StatusPill
                  status={t.status}
                  waiting={model.approvals.some((a) => a.task === t.id)}
                />
                <span className="small muted">{ago(t.createdAt)}</span>
              </span>
            </button>
          ))}
          {!shown.length && (
            <p className="small muted pad">{tasks.length ? 'No task matches.' : 'No tasks yet.'}</p>
          )}
        </div>
      </div>
      {task ? (
        <div className="history-detail scroll">
          <div className="col gap-s">
            <h2>{sanitizeLine(task.title)}</h2>
            <span className="row gap small muted">
              <StatusPill
                status={task.status}
                waiting={model.approvals.some((a) => a.task === task.id)}
              />
              <span>
                {started(task)} · {ago(task.createdAt)}
              </span>
              <span className="mono">{task.id}</span>
            </span>
          </div>
          <div className="stats">
            <Stat
              label={task.finishedAt ? 'Ran for' : 'Running for'}
              value={task.startedAt ? duration(elapsed) : '—'}
            />
            <Stat label="Replies" value={String(task.turns)} />
            <Stat
              label="Tokens"
              value={`${tokens(task.inputTokens)} in · ${tokens(task.outputTokens)} out`}
            />
          </div>
          <div className="row gap wrap">
            <button type="button" className="btn btn-primary" onClick={() => onOpen(task.id)}>
              Open conversation
            </button>
            <TaskActions task={task} />
            <span className="grow" />
            <button
              type="button"
              className="btn btn-danger-quiet"
              disabled={active}
              title={active ? 'Cancel the task before deleting it' : undefined}
              onClick={() =>
                void act(() => call('tasks.delete', { taskId: task.id }), 'task deleted').then(
                  (done) => {
                    if (!done) return;
                    setSelected(undefined);
                    if (task.id === chosen) onGone();
                  },
                )
              }
            >
              <Icon name="trash" size={14} /> Delete…
            </button>
          </div>
          {children.length > 0 && (
            <section className="card">
              <h3>Handed off</h3>
              {children.map((c) => (
                <span key={c.id} className="row gap small">
                  <Avatar id={c.agentId} size={22} />
                  <span className="strong">@{sanitizeLine(c.agentId)}</span>
                  <span className="muted ellipsis grow">{sanitizeLine(c.title)}</span>
                  <StatusPill status={c.status} />
                </span>
              ))}
            </section>
          )}
          {task.result && !active && (
            <section className="card">
              <h3>{task.status === 'done' ? 'Result' : 'How it ended'}</h3>
              <Markdown
                text={sanitize(
                  task.result.length > 4000 ? `${task.result.slice(0, 4000)}…` : task.result,
                )}
              />
            </section>
          )}
        </div>
      ) : (
        <div className="history-detail empty">Choose a task on the left.</div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="small muted">{label}</div>
      <div className="strong">{value}</div>
    </div>
  );
}

/** How many of a host's requests each decision made, in words. */
export function auditHosts(audit: TaskAudit): { host: string; note: string; refused: boolean }[] {
  return audit.hosts.map((h) => {
    const denied = Object.entries(h.decisions)
      .filter(([d]) => d.includes('deny') || d.includes('denied'))
      .reduce((n, [, c]) => n + c, 0);
    return {
      host: sanitizeLine(h.host),
      note: `${count(h.requests, 'request')}${h.injected ? ` · ${h.injected} with your account` : ''}${denied ? ` · ${denied} refused` : ''}`,
      refused: denied > 0,
    };
  });
}

/**
 * What a task reached, from the egress proxy's audit log: the proxy sits outside the cell, so
 * the agent cannot edit this record.
 */
function TaskRecord({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const { call } = useApp();
  const [audit, setAudit] = useState<TaskAudit>();
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    void call('tasks.audit', { taskId: task.id }).then(setAudit, (err) =>
      setError(sanitizeLine(message(err))),
    );
  };
  useEffect(load, [task.id]);
  const accounts = audit ? Object.entries(audit.injected) : [];
  return (
    <aside className="record" role="dialog" aria-label="What this task touched">
      <div className="row between">
        <span className="strong">What this task touched</span>
        <button
          type="button"
          className="btn drawer-close"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="small muted">
        Recorded by Anchi outside the sealed cell, so the agent cannot edit it.
      </p>
      {error && <div className="banner banner-error">{error}</div>}
      {!audit && !error && <p className="small muted">Loading…</p>}
      {audit && (
        <div className="record-body scroll">
          {audit.savedOnly && (
            <div className="banner banner-warn">
              The secure room could not be read: this is what Anchi saved earlier.
            </div>
          )}
          <RecordSection title="Accounts used">
            {accounts.map(([rule, n]) => (
              <RecordRow
                key={rule}
                icon="link"
                text={sanitizeLine(rule)}
                note={count(n, 'request')}
              />
            ))}
            {audit.bridge.map((b) => (
              <RecordRow
                key={`${b.service}:${b.operation}`}
                icon="link"
                text={`${sanitizeLine(b.service)} · ${sanitizeLine(b.operation)}`}
                note={count(b.calls, 'call')}
              />
            ))}
            {audit.held.map((h, i) => (
              <RecordRow
                key={i}
                icon="shield"
                text={`${sanitizeLine(h.operation)} on ${sanitizeLine(h.host)}`}
                note={sanitizeLine(h.outcome)}
                warn
              />
            ))}
            {!accounts.length && !audit.bridge.length && !audit.held.length && (
              <span className="small muted">None of your accounts.</span>
            )}
          </RecordSection>
          <RecordSection title="Websites reached">
            {auditHosts(audit).map((h) => (
              <RecordRow key={h.host} icon="globe" text={h.host} note={h.note} warn={h.refused} />
            ))}
            {!audit.hosts.length && <span className="small muted">None.</span>}
          </RecordSection>
          <RecordSection title="Refused">
            {audit.refused.slice(0, 20).map((r, i) => (
              <RecordRow
                key={i}
                icon="x"
                text={`${sanitizeLine(r.method)} ${sanitizeLine(r.host)}`}
                note={sanitizeLine(r.reason || r.decision)}
                warn
              />
            ))}
            {!audit.refused.length && <span className="small muted">Nothing was refused.</span>}
          </RecordSection>
          <RecordSection title="Checks">
            <RecordRow
              icon="shield"
              text="Credential scan before closing"
              note={audit.scan ? sanitizeLine(audit.scan) : 'not run yet'}
            />
            <RecordRow icon="lock" text="Sealed cells used" note={String(audit.cells)} />
            {Object.keys(audit.credentialsSent).length > 0 && (
              <RecordRow
                icon="key"
                text="Credentials the cell sent itself"
                note={Object.entries(audit.credentialsSent)
                  .map(([k, n]) => `${sanitizeLine(k)}: ${n}`)
                  .join(' · ')}
              />
            )}
          </RecordSection>
          {audit.truncated && (
            <p className="small muted">
              Showing the latest of {audit.total} recorded requests. The full log is in{' '}
              <span className="mono">anchi audit {task.id}</span>.
            </p>
          )}
        </div>
      )}
      <button type="button" className="btn btn-small" onClick={load}>
        Refresh
      </button>
    </aside>
  );
}

function RecordSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="record-section">
      <span className="section-label">{title.toUpperCase()}</span>
      {children}
    </section>
  );
}

function RecordRow({
  icon,
  text,
  note,
  warn,
}: {
  icon: 'link' | 'globe' | 'shield' | 'x' | 'lock' | 'key';
  text: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <span className="record-row">
      <Icon name={icon} size={14} />
      <span className="grow min0 ellipsis" title={text}>
        {text}
      </span>
      <span className={`small ${warn ? 'tone-approval' : 'muted'}`}>{note}</span>
    </span>
  );
}
