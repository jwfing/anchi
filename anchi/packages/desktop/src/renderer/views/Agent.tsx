import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { TaskRow } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
import { call } from '../api.ts';
import { count, duration, tokens } from '../format.ts';
import { Markdown } from '../markdown.tsx';
import { agentTasks } from '../model.ts';
import { doing, toolSummary, transcript } from '../transcript.ts';
import { Avatar, Composer, Linked, Splitter, StatusPill, usePanelWidth } from '../ui.tsx';
import { AgentSettingsView } from './AgentSettings.tsx';
import { ApprovalCard } from './Approvals.tsx';
import { TaskPanel } from './TaskPanel.tsx';

/** Transcripts loaded with the conversation: the newest ones, the rest when opened. */
const PRELOAD = 15;

export function AgentView({ agentId }: { agentId: string }) {
  const { model, loadEvents, act, server } = useApp();
  const agent = model.agents.find((a) => a.id === agentId);
  const tasks = agentTasks(model, agentId);
  const [selected, setSelected] = useState<string | undefined>(tasks.at(-1)?.id);
  // Bumped by "Continue this task" so the panel focuses its reply box.
  const [replyFocus, setReplyFocus] = useState(0);
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [tab, setTab] = useState<'conversation' | 'settings'>('conversation');
  const end = useRef<HTMLDivElement>(null);

  const recent = tasks
    .slice(-PRELOAD)
    .map((t) => t.id)
    .join(' ');
  useEffect(() => {
    for (const id of recent.split(' ').filter(Boolean)) loadEvents(id);
  }, [recent, loadEvents]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [tasks.length]);

  if (!agent) return <main className="main empty">This agent no longer exists.</main>;
  const selectedTask = selected ? model.tasks[selected] : undefined;

  return (
    <>
      <main className="main">
        <div className="main-head">
          <Avatar id={agent.id} size={36} />
          <div className="col grow min0">
            <span className="row min0">
              <span className="title ellipsis">
                @{agent.id} <span className="muted normal">· {sanitizeLine(agent.name)}</span>
              </span>
              <span className="tag tag-off server-tag" title="The server this agent runs on">
                on {server.name}
              </span>
            </span>
            <span className="small muted ellipsis">
              {[
                agent.runtime,
                agent.model,
                agent.connectors.length ? agent.connectors.join(', ') : 'no connectors',
                agent.skills?.length ? count(agent.skills.length, 'skill') : '',
                agent.delegates?.length
                  ? `delegates to ${agent.delegates.map((d) => '@' + d).join(', ')}`
                  : '',
                agent.triggers ? count(agent.triggers, 'trigger') : '',
                `up to ${count(agent.maxTasks, 'task')}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="segmented" role="tablist" aria-label="Agent view">
            {(['conversation', 'settings'] as const).map((t) => (
              <button
                type="button"
                role="tab"
                key={t}
                aria-selected={tab === t}
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
              >
                {t === 'conversation' ? 'Conversation' : 'Settings'}
              </button>
            ))}
          </div>
        </div>
        {agent.error && (
          <div className="banner banner-error">
            This agent cannot run: {sanitizeLine(agent.error)}
          </div>
        )}

        {tab === 'settings' ? (
          <AgentSettingsView agentId={agent.id} />
        ) : (
          <>
            <div className="scroll conversation">
              <div className="center small muted">
                Each message below starts a new task in a new session. To continue a task, open it
                and reply beside it.
              </div>
              {tasks.map((t) => (
                <TaskTurn
                  key={t.id}
                  task={t}
                  selected={t.id === selected}
                  onSelect={() => {
                    setSelected(t.id);
                    setReplyFocus(0);
                  }}
                  onContinue={() => {
                    setSelected(t.id);
                    setReplyFocus((n) => n + 1);
                  }}
                />
              ))}
              <div ref={end} />
            </div>

            <Composer
              label={`New task for @${agent.id}`}
              placeholder={`Give @${agent.id} a new task…`}
              hint={`New task, new session · ${agent.running} running · ${agent.queued} queued (up to ${agent.maxTasks} at once)`}
              disabled={!!agent.error}
              onSend={async (text) => {
                const task = await act(() => call('tasks.create', { agentId, text }));
                if (task) setSelected(task.id);
              }}
            />
          </>
        )}
      </main>
      {tab === 'conversation' && selectedTask && (
        <>
          <Splitter width={panelWidth} onResize={setPanelWidth} />
          <TaskPanel
            key={selectedTask.id}
            task={selectedTask}
            width={panelWidth}
            focusReply={replyFocus}
          />
        </>
      )}
    </>
  );
}

export function TaskTurn({
  task,
  selected,
  onSelect,
  onContinue,
}: {
  task: TaskRow;
  selected: boolean;
  onSelect: () => void;
  onContinue: () => void;
}) {
  const { model } = useApp();
  const items = useMemo(() => transcript(model.events[task.id] ?? []), [model.events, task.id]);
  const approvals = model.approvals.filter((a) => a.task === task.id);
  const children = Object.values(model.tasks).filter((t) => t.parentId === task.id);
  const firstInput = items.find((i) => i.kind === 'input');
  const tools = items.filter((i) => i.kind === 'tools');
  const progress = items.filter((i) => i.kind === 'progress').at(-1);
  const active = task.status === 'running' || task.status === 'queued';
  const now = doing(items);
  const elapsed = task.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : 0;

  return (
    <>
      <div className={`bubble-user ${task.trigger !== 'user' ? 'bubble-system' : ''}`}>
        {task.trigger !== 'user' && <div className="small bubble-from">from {task.trigger}</div>}
        <Linked
          text={
            firstInput && firstInput.kind === 'input' ? firstInput.text : sanitizeLine(task.title)
          }
        />
      </div>
      <article className={`task-card ${selected ? 'selected' : ''}`}>
        <button
          type="button"
          className="task-card-head"
          onClick={onSelect}
          aria-label={`Open task ${task.id}`}
        >
          <StatusPill status={task.status} waiting={approvals.length > 0} />
          <span className="mono small muted">{task.id}</span>
          <span className="small muted">
            {task.startedAt ? duration(elapsed) : 'not started'} · {task.turns} turn
            {task.turns === 1 ? '' : 's'}
            {task.inputTokens
              ? ` · ${tokens(task.inputTokens)} in / ${tokens(task.outputTokens)} out`
              : ''}
          </span>
        </button>
        <div className="task-card-body">
          {active && progress && progress.kind === 'progress' && (
            <div className="progress">✻ {progress.text.split('\n')[0]}</div>
          )}
          {tools.length > 0 && (
            <button type="button" className="tools" onClick={onSelect}>
              ▸ {toolSummary(tools.flatMap((t) => (t.kind === 'tools' ? t.calls : [])))}
            </button>
          )}
          {!active && task.result && (
            <div className="result">
              <div className="strong">{task.status === 'done' ? 'Result' : 'Needs attention'}</div>
              <Markdown
                text={sanitize(
                  task.result.length > 4000 ? `${task.result.slice(0, 4000)}…` : task.result,
                )}
              />
            </div>
          )}
          {active && now && (
            <div className="doing small">
              <span className="spinner" aria-hidden="true" />
              Doing: <span className="mono">{now}</span>
            </div>
          )}
          {children.length > 0 && (
            <div className="chips">
              {children.map((c) => (
                <span key={c.id} className="chip">
                  ↳ @{c.agentId} · {c.status}
                </span>
              ))}
            </div>
          )}
          {!active && (
            <button type="button" className="btn btn-small continue" onClick={onContinue}>
              Continue this task
            </button>
          )}
        </div>
        {approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
      </article>
    </>
  );
}
