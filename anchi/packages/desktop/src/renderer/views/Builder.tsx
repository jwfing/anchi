import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { BuilderProposal, RuntimeId } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDER, useApp } from '../App.tsx';
import { call } from '../api.ts';
import { Markdown } from '../markdown.tsx';
import { agentTasks } from '../model.ts';
import { transcript } from '../transcript.ts';
import { Composer, Icon, Linked } from '../ui.tsx';
import { TranscriptItem } from './TaskPanel.tsx';

/** The builder is one conversation: the view continues its latest task until a new one starts. */
export function BuilderView() {
  const { model, loadEvents, act } = useApp();
  const tasks = agentTasks(model, BUILDER);
  const [fresh, setFresh] = useState(false);
  const task = fresh ? undefined : tasks.at(-1);
  useEffect(() => {
    if (task) loadEvents(task.id);
  }, [task?.id, loadEvents]);
  const items = useMemo(
    () => (task ? transcript(model.events[task.id] ?? []) : []),
    [model.events, task],
  );
  const busy = task?.status === 'running' || task?.status === 'queued';
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);
  const proposal = Object.values(model.proposals)[0];
  const builder = model.agents.find((a) => a.id === BUILDER);

  return (
    <>
      <main className="main">
        <div className="main-head">
          <span className="avatar builder-avatar">
            <Icon name="sparkle" />
          </span>
          <div className="col grow">
            <span className="title">Agent builder</span>
            <span className="small muted">
              Runs on {builder?.runtime ?? 'the first connected runtime'} · sees your skills,
              connectors, workspaces and agents · writes nothing until you apply
            </span>
          </div>
          {task && (
            <button type="button" className="btn" onClick={() => setFresh(true)}>
              New conversation
            </button>
          )}
        </div>
        <div className="scroll conversation">
          {!task && <Starters />}
          {items.map((i) =>
            i.kind === 'input' ? (
              <div key={i.seq} className="bubble-user">
                <Linked text={i.text} />
              </div>
            ) : i.kind === 'message' ? (
              <div key={i.seq} className="bubble-agent">
                <Markdown text={i.text} />
              </div>
            ) : (
              <div key={i.seq} className="bubble-aside">
                <TranscriptItem item={i} />
              </div>
            ),
          )}
          {busy && (
            <div className="doing small">
              <span className="spinner" aria-hidden="true" /> The builder is working…
            </div>
          )}
          <div ref={end} />
        </div>
        <Composer
          label="Message the builder"
          placeholder={
            busy ? 'Wait for the builder to answer' : 'Describe the agent, or ask for a change…'
          }
          disabled={busy}
          onSend={async (text) => {
            if (task) return act(() => call('tasks.send', { taskId: task.id, text }));
            const created = await act(() => call('tasks.create', { agentId: BUILDER, text }));
            if (created) setFresh(false);
          }}
        />
      </main>
      {proposal && <ProposalPanel proposal={proposal} />}
    </>
  );
}

/** A starter file without a model call: the agent's id and runtime, then the usual review. */
function Starters() {
  const { act, dispatch } = useApp();
  const [agentId, setAgentId] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>('codex');
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(agentId);
  return (
    <div className="starter">
      <p className="strong">Describe the agent you want below, or start from an empty one:</p>
      <div className="row gap wrap">
        <label className="field">
          <span className="small muted">Agent id</span>
          <input
            value={agentId}
            placeholder="reviewer"
            onChange={(e) => setAgentId(e.target.value.toLowerCase())}
          />
        </label>
        <label className="field">
          <span className="small muted">Runtime</span>
          <select value={runtime} onChange={(e) => setRuntime(e.target.value as RuntimeId)}>
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
            <option value="hermes">Hermes</option>
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={!valid}
          onClick={async () => {
            const proposal = await act(() => call('agents.createPreview', { agentId, runtime }));
            if (proposal) dispatch({ type: 'proposal', proposal });
          }}
        >
          Preview
        </button>
      </div>
    </div>
  );
}

function diffLines(diff: string) {
  return sanitize(diff)
    .split('\n')
    .filter((l) => !l.startsWith('---') && !l.startsWith('+++'))
    .map((l, i) => ({
      key: i,
      text: l,
      tone: l.startsWith('+')
        ? 'add'
        : l.startsWith('-')
          ? 'del'
          : l.startsWith('@@')
            ? 'hunk'
            : 'ctx',
    }));
}

/** A unified diff of an agent file, with the file header lines left out. */
export function Diff({ text }: { text: string }) {
  return (
    <div className="diff">
      {diffLines(text).map((l) => (
        <div key={l.key} className={`diff-${l.tone}`}>
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}

/** The proposal as Anchi read it from the builder's files: agent text cannot draw this panel. */
function ProposalPanel({ proposal: p }: { proposal: BuilderProposal }) {
  const { act, dispatch, setView } = useApp();
  const title =
    p.kind === 'create'
      ? 'NEW AGENT'
      : p.kind === 'replace'
        ? 'REPLACES THE WHOLE FILE'
        : 'CHANGES';
  const done = () => dispatch({ type: 'proposalDone', proposalId: p.id });
  return (
    <section className="panel proposal" aria-label="Proposal review">
      <div className="trusted">
        <Icon name="shield" size={14} /> Drawn by Anchi from the proposed file. Agent text cannot
        draw this panel.
      </div>
      <div className="panel-head">
        <span className="section-label">PROPOSAL · {title}</span>
        <span className="proposal-title">@{sanitizeLine(p.agentId)}</span>
      </div>
      <div className="scroll grow panel-section">
        <span className="section-label">AGENT FILE</span>
        <Diff text={p.agentDiff} />
        {p.imageDiff && (
          <>
            <span className="section-label">IMAGE RECIPE</span>
            <Diff text={p.imageDiff} />
          </>
        )}
        {p.errors.map((e, i) => (
          <div key={i} className="banner banner-error">
            Cannot apply: {sanitizeLine(e)}
          </div>
        ))}
        {p.warnings.map((w, i) => (
          <div key={i} className="banner banner-warn">
            ! {sanitizeLine(w)}
          </div>
        ))}
      </div>
      <div className="panel-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={p.errors.length > 0}
          onClick={async () => {
            const agents = await act(
              () => call('builder.apply', { proposalId: p.id }),
              `@${p.agentId} saved`,
            );
            if (!agents) return;
            dispatch({ type: 'agents', agents });
            done();
            setView({ kind: 'agent', agentId: p.agentId });
          }}
        >
          Apply
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-danger"
          onClick={async () => {
            await act(() => call('builder.discard', { proposalId: p.id }), 'proposal discarded');
            done();
          }}
        >
          Discard
        </button>
      </div>
    </section>
  );
}
