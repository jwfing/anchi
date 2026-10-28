import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { TaskRow } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
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
  const { model, loadEvents, act, server, call } = useApp();
  const agent = model.agents.find((a) => a.id === agentId);
  const tasks = agentTasks(model, agentId);
  const [details, setDetails] = useState<{ taskId: string; open: boolean }>();
  // Bumped by "Continue this task" so the panel focuses its reply box.
  const [replyFocus, setReplyFocus] = useState(0);
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [tab, setTab] = useState<'conversation' | 'settings'>('conversation');
  const end = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeDetails = () => {
    if (drawer.current?.contains(document.activeElement))
      opener.current?.focus({ preventScroll: true });
    setDetails((current) => current && { ...current, open: false });
  };
  const openDetails = (taskId: string, continueTask = false) => {
    if (
      document.activeElement instanceof HTMLElement &&
      !drawer.current?.contains(document.activeElement)
    ) {
      opener.current = document.activeElement;
    }
    setDetails((current) => ({
      taskId,
      open: continueTask || current?.taskId !== taskId || !current.open,
    }));
    setReplyFocus((n) => (continueTask ? n + 1 : 0));
  };
  useEffect(() => {
    if (details?.open && !replyFocus) {
      drawer.current
        ?.querySelector<HTMLButtonElement>('[aria-label="Close task details"]')
        ?.focus({ preventScroll: true });
    }
  }, [details?.open, details?.taskId, replyFocus]);

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
  const selectedTask = details ? model.tasks[details.taskId] : undefined;
  const open = !!selectedTask && details?.open === true && tab === 'conversation';

  return (
    <div
      className="agent-workspace"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          closeDetails();
        }
      }}
    >
      <main className="main">
        <div className="main-head">
          <Avatar id={agent.peer?.agent ?? agent.id} size={36} />
          <div className="col grow min0">
            <span className="row min0">
              <span className="title ellipsis">
                @{agent.peer?.agent ?? agent.id}{' '}
                <span className="muted normal">· {sanitizeLine(agent.name)}</span>
              </span>
              <span className="tag tag-off server-tag" title="The server this agent runs on">
                on {sanitizeLine(agent.peer?.machine ?? agent.execution?.server ?? server.label)}
              </span>
            </span>
            <span className="small muted ellipsis">
              {[
                ...(agent.execution
                  ? [`profile @${agent.execution.agent} on ${agent.execution.server}`]
                  : [
                      agent.runtime,
                      agent.model,
                      agent.connectors.length ? agent.connectors.join(', ') : 'no connectors',
                      agent.skills?.length ? count(agent.skills.length, 'skill') : '',
                    ]),
                agent.delegates?.length
                  ? `delegates to ${agent.delegates.map((d) => '@' + d).join(', ')}`
                  : '',
                agent.triggers ? count(agent.triggers, 'trigger') : '',
                agent.peer ? '' : `up to ${count(agent.maxTasks, 'task')}`,
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
                onClick={() => {
                  closeDetails();
                  setTab(t);
                }}
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
          agent.peer ? (
            <div className="pad">
              Runtime, connectors, skills and delegation belong to{' '}
              {sanitizeLine(agent.peer.machine)}. Open that machine in Settings to edit this agent.
              Task history here contains work submitted through {sanitizeLine(server.label)}.
            </div>
          ) : (
            <AgentSettingsView agentId={agent.id} />
          )
        ) : (
          <>
            <div className="scroll conversation agent-conversation">
              <div className="center small muted">
                Each message starts a new task. Click a task to show or hide its conversation.
              </div>
              {tasks.map((t) => (
                <TaskTurn
                  key={t.id}
                  task={t}
                  selected={open && t.id === details?.taskId}
                  onSelect={() => openDetails(t.id)}
                  onContinue={() => openDetails(t.id, true)}
                />
              ))}
              <div ref={end} />
            </div>

            <Composer
              label={`New task for @${agent.peer?.agent ?? agent.id}`}
              placeholder={`Give @${agent.peer?.agent ?? agent.id} a new task…`}
              hint={
                agent.peer
                  ? `Runs on ${sanitizeLine(agent.peer.machine)} · history submitted through ${sanitizeLine(server.label)}`
                  : `New task, new session · ${agent.running} running · ${agent.queued} queued (up to ${agent.maxTasks} at once)`
              }
              disabled={!!agent.error}
              onSend={async (text) => {
                const task = await act(() => call('tasks.create', { agentId, text }));
                if (task) openDetails(task.id);
              }}
            />
          </>
        )}
      </main>
      <div
        ref={drawer}
        id="task-details"
        className={`task-drawer ${open ? 'is-open' : ''}`}
        style={{ width: panelWidth }}
        inert={!open}
        aria-hidden={!open}
      >
        {selectedTask && (
          <>
            <Splitter width={panelWidth} onResize={setPanelWidth} />
            <TaskPanel
              key={selectedTask.id}
              task={selectedTask}
              focusReply={replyFocus}
              onClose={closeDetails}
            />
          </>
        )}
      </div>
    </div>
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
          aria-label={`${selected ? 'Hide' : 'Open'} task ${task.id}`}
          aria-expanded={selected}
          aria-controls="task-details"
        >
          <StatusPill status={task.status} waiting={approvals.length > 0} />
          <span className="mono small muted">{task.id}</span>
          {task.execution && (
            <span className="tag tag-off">{sanitizeLine(task.execution.server)}</span>
          )}
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
                  {c.execution ? ` · ${sanitizeLine(c.execution.server)}` : ''}
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
