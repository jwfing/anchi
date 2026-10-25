import { sanitizeLine } from '@anchi/core/sanitize';
import type { TaskRow } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
import { call } from '../api.ts';
import { ago, duration, tokens } from '../format.ts';
import { Markdown } from '../markdown.tsx';
import { type Item, toolSummary, transcript } from '../transcript.ts';
import { Composer, Linked, StatusPill } from '../ui.tsx';

/** The selected task: its numbers, delegated work, full transcript and replies. */
export function TaskPanel({
  task,
  width,
  focusReply,
}: {
  task: TaskRow;
  width: number;
  focusReply: number;
}) {
  const { model, loadEvents, act } = useApp();
  useEffect(() => {
    loadEvents(task.id);
  }, [task.id, loadEvents]);
  const items = useMemo(() => transcript(model.events[task.id] ?? []), [model.events, task.id]);
  const children = Object.values(model.tasks).filter((t) => t.parentId === task.id);
  const parent = task.parentId ? model.tasks[task.parentId] : undefined;
  const active = task.status === 'running' || task.status === 'queued';
  const end = useRef<HTMLDivElement>(null);
  const reply = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusReply) reply.current?.focus();
  }, [focusReply]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);
  const elapsed = task.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : 0;

  return (
    <aside className="panel" aria-label="Task details" style={{ width }}>
      <div className="panel-head">
        <span className="section-label">SELECTED TASK</span>
        <span className="strong">{sanitizeLine(task.title)}</span>
        <span className="row gap small">
          <StatusPill
            status={task.status}
            waiting={model.approvals.some((a) => a.task === task.id)}
          />
          <span className="mono muted">{task.id}</span>
        </span>
        <span className="small muted">
          trigger: {task.trigger} · created {ago(task.createdAt)}
          {parent ? ` · delegated by @${parent.agentId}` : ''}
        </span>
      </div>
      <div className="stats">
        <Stat
          label={task.finishedAt ? 'Ran for' : 'Running for'}
          value={task.startedAt ? duration(elapsed) : '—'}
        />
        <Stat label="Turns" value={String(task.turns)} />
        <Stat label="Tokens in" value={tokens(task.inputTokens)} />
        <Stat label="Tokens out" value={tokens(task.outputTokens)} />
      </div>
      {children.length > 0 && (
        <div className="panel-section">
          <span className="section-label">DELEGATED WORK</span>
          {children.map((c) => (
            <span key={c.id} className="small">
              ↳ @{c.agentId} · {c.status} · {sanitizeLine(c.title)}
            </span>
          ))}
        </div>
      )}
      <div className="panel-section grow scroll transcript">
        <span className="section-label">TRANSCRIPT</span>
        {items.map((i) => (
          <TranscriptItem key={i.seq} item={i} />
        ))}
        {!items.length && <span className="small muted">Loading…</span>}
        <div ref={end} />
      </div>
      <div className="panel-actions">
        {active ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void act(() => call('tasks.cancel', { taskId: task.id }), 'cancelled')}
          >
            Cancel task
          </button>
        ) : (
          (task.status === 'failed' || task.status === 'cancelled') && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void act(
                    () => call('tasks.retry', { taskId: task.id }),
                    'retrying in the same session',
                  )
                }
              >
                Retry
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void act(
                    () => call('tasks.retry', { taskId: task.id, fresh: true }),
                    'started over',
                  )
                }
              >
                Start over
              </button>
            </>
          )
        )}
      </div>
      <Composer
        label={`Reply to ${task.id}`}
        placeholder={
          active
            ? 'Wait for this turn to end to reply'
            : `Reply to ${task.id} · continues its session`
        }
        disabled={active}
        inputRef={reply}
        onSend={(text) => act(() => call('tasks.send', { taskId: task.id, text }))}
      />
    </aside>
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

export function TranscriptItem({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'input':
      return (
        <div className="t-input">
          › <Linked text={item.text} />
        </div>
      );
    case 'message':
      return (
        <div className="t-message">
          <Markdown text={item.text} />
        </div>
      );
    case 'progress':
      return <div className="t-progress">✻ {item.text}</div>;
    case 'notice':
      return <div className="t-notice">ℹ {item.text}</div>;
    case 'error':
      return (
        <div className="t-error">
          {item.fatal ? '✗' : '!'} {item.text}
        </div>
      );
    case 'tools':
      return (
        <div className="t-tools">
          <button
            type="button"
            className="tools"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? '▾' : '▸'} {toolSummary(item.calls)}
          </button>
          {open &&
            item.calls.map((c) => (
              <div key={c.id} className="t-call">
                <div className="mono small">
                  ▸ {c.name} {c.input.slice(0, 600)}
                </div>
                {c.output !== undefined && (
                  <div className={`mono small t-output ${c.isError ? 't-output-error' : ''}`}>
                    ⎿ {c.output.slice(0, 1200)}
                  </div>
                )}
              </div>
            ))}
        </div>
      );
  }
}
