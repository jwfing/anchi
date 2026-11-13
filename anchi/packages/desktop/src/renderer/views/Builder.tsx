import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { AgentSettings, BuilderProposal, RuntimeId } from '@anchi/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDER, useApp } from '../App.tsx';
import { Markdown } from '../markdown.tsx';
import { agentTasks } from '../model.ts';
import { transcript } from '../transcript.ts';
import { plainWords } from '../access.ts';
import { connectorName } from '../logos.tsx';
import { accountName, Composer, Icon, type IconName, Linked } from '../ui.tsx';
import { TranscriptItem } from './TaskPanel.tsx';

/** Ready-made requests to the builder: a job, and the access it should ask for. */
export const TEMPLATES: {
  id: string;
  icon: IconName;
  title: string;
  about: string;
  needs: string[];
  request: string;
}[] = [
  {
    id: 'reviewer',
    icon: 'code',
    title: 'Code reviewer',
    about: 'Reads pull requests and leaves review comments.',
    needs: ['GitHub'],
    request:
      'Create an agent with the id reviewer that reviews pull requests on GitHub and leaves review comments. It needs the github connector and no shared folder. Writes to GitHub must ask me first.',
  },
  {
    id: 'developer',
    icon: 'pen',
    title: 'Developer',
    about: 'Fixes issues in a folder you share and opens pull requests.',
    needs: ['GitHub', '1 folder'],
    request:
      'Create an agent with the id developer that fixes issues in one shared folder and opens pull requests. It needs the github connector. Ask me which folder to share, read-write. Writes to GitHub must ask me first.',
  },
  {
    id: 'inbox',
    icon: 'mail',
    title: 'Inbox assistant',
    about: 'Sorts mail and drafts replies. Asks before sending.',
    needs: ['Gmail'],
    request:
      'Create an agent with the id inbox that sorts my Gmail and drafts replies. It needs the gmail connector and no shared folder. It must ask me before sending anything.',
  },
  {
    id: 'researcher',
    icon: 'search',
    title: 'Researcher',
    about: 'Searches the web and writes a summary with sources.',
    needs: ['Web only'],
    request:
      'Create an agent with the id researcher that searches the web and writes a summary with its sources. It needs no connector and no shared folder.',
  },
  {
    id: 'social',
    icon: 'globe',
    title: 'Social drafter',
    about: 'Drafts posts for X and Reddit. Never posts without you.',
    needs: ['X', 'Reddit'],
    request:
      'Create an agent with the id social that drafts posts for X and Reddit. It needs the x and reddit connectors and no shared folder. It must never post without my approval.',
  },
];

/**
 * New agent: describe the job to the builder, or start from a template or a blank agent. The
 * builder is one conversation: the view continues its latest task until a new one starts.
 * Nothing exists until the proposal on the right is applied.
 */
export function BuilderView() {
  const { model, loadEvents, act, call } = useApp();
  const tasks = agentTasks(model, BUILDER);
  const [fresh, setFresh] = useState(false);
  const [seed, setSeed] = useState({ n: 0, text: '' });
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
            <span className="title">New agent</span>
            <span className="small muted">
              Describe the job, or start from a template. You review what the agent can reach before
              it exists.
            </span>
          </div>
          {task && (
            <button type="button" className="btn" onClick={() => setFresh(true)}>
              Start again
            </button>
          )}
        </div>
        <div className="scroll conversation builder-pane">
          {!task && (
            <Starters
              onTemplate={(text) => setSeed((s) => ({ n: s.n + 1, text }))}
              account={builder?.runtime}
            />
          )}
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
              <span className="spinner" aria-hidden="true" /> Drafting the agent…
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="thread-composer">
          <Composer
            key={seed.n}
            initialText={seed.text}
            label="Describe the agent"
            placeholder={
              busy
                ? 'Wait for the draft'
                : task
                  ? 'Ask for a change…'
                  : 'Describe what this agent should do…'
            }
            disabled={busy}
            onSend={async (text) => {
              if (task) return act(() => call('tasks.send', { taskId: task.id, text }));
              const created = await act(() => call('tasks.create', { agentId: BUILDER, text }));
              if (created) setFresh(false);
            }}
          />
          <span className="small muted">
            Drafting uses{' '}
            {builder?.runtime ? accountName(builder.runtime) : 'your first AI account'}. It sees
            your skills, connections, folders and agents, and writes nothing until you create the
            agent.
          </span>
        </div>
      </main>
      {proposal && <ProposalPanel proposal={proposal} />}
    </>
  );
}

/**
 * Where a new agent starts: a template (a request the user can still edit), a blank agent with
 * no model call, or, for a team on several machines, a member that runs on another one.
 */
function Starters({
  onTemplate,
  account,
}: {
  onTemplate: (request: string) => void;
  account?: string;
}) {
  const { act, dispatch, server, call } = useApp();
  const [agentId, setAgentId] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>(
    account === 'claude-code' || account === 'hermes' ? account : 'codex',
  );
  const [nodes, setNodes] = useState<{ name: string; target: string }[]>([]);
  const [node, setNode] = useState('');
  const [worker, setWorker] = useState('');
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    let current = true;
    setNode('');
    setNodes([]);
    if (server.status !== 'connected') return;
    void call('team.nodes')
      .then((value) => {
        if (current) setNodes(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [call, server.status, server.name]);
  const valid =
    /^[a-z0-9][a-z0-9-]{0,39}$/.test(agentId) &&
    (!node || /^[a-z0-9][a-z0-9-]{0,39}$/.test(worker));
  const preview = async () => {
    const proposal = await act(() =>
      node
        ? call('team.preview', { agentId, execution: { server: node, agent: worker } })
        : call('agents.createPreview', { agentId, runtime }),
    );
    if (proposal) dispatch({ type: 'proposal', proposal });
  };
  return (
    <div className="templates">
      <span className="section-label">START FROM A TEMPLATE</span>
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.id}
            className="template"
            onClick={() => onTemplate(t.request)}
          >
            <span className="template-icon">
              <Icon name={t.icon} size={18} />
            </span>
            <span className="strong">{t.title}</span>
            <span className="small muted">{t.about}</span>
            <span className="chips">
              {t.needs.map((n) => (
                <span key={n} className="chip chip-off">
                  {n}
                </span>
              ))}
            </span>
          </button>
        ))}
        <button
          type="button"
          className={`template ${blank ? 'selected' : ''}`}
          aria-expanded={blank}
          onClick={() => setBlank(!blank)}
        >
          <span className="template-icon">
            <Icon name="plus" size={18} />
          </span>
          <span className="strong">Blank agent</span>
          <span className="small muted">No connections and no files. Add access later.</span>
          <span className="chips">
            <span className="chip chip-off">Nothing shared</span>
          </span>
        </button>
      </div>
      <p className="small muted">
        A template fills in the request below; edit it, then send. A blank agent is made without a
        model call.
      </p>
      {blank && (
        <div className="starter">
          <div className="row gap wrap bottom">
            <label className="field">
              <span className="small muted">Agent id</span>
              <input
                value={agentId}
                placeholder="reviewer"
                autoFocus
                onChange={(e) => setAgentId(e.target.value.toLowerCase())}
              />
            </label>
            {nodes.length > 0 && (
              <label className="field">
                <span className="small muted">Runs on</span>
                <select value={node} onChange={(e) => setNode(e.target.value)}>
                  <option value="">This machine</option>
                  {nodes.map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {node ? (
              <label className="field">
                <span className="small muted">Existing agent on {sanitizeLine(node)}</span>
                <input
                  value={worker}
                  placeholder="developer"
                  onChange={(e) => setWorker(e.target.value.toLowerCase())}
                />
              </label>
            ) : (
              <label className="field">
                <span className="small muted">AI account</span>
                <select value={runtime} onChange={(e) => setRuntime(e.target.value as RuntimeId)}>
                  <option value="codex">ChatGPT (Codex)</option>
                  <option value="claude-code">Claude (Claude Code)</option>
                  <option value="hermes">Other provider (Hermes)</option>
                </select>
              </label>
            )}
            <button type="button" className="btn" disabled={!valid} onClick={() => void preview()}>
              Review
            </button>
          </div>
          {node && (
            <p className="small muted">
              The member uses that machine’s agent and its access. Tasks, results and approvals
              appear in this team.
            </p>
          )}
        </div>
      )}
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

/**
 * The proposal as Anchi read it from the builder's files, under the band agent text cannot draw:
 * first what the agent could reach, in plain words, then the file itself for those who read it.
 */
function ProposalPanel({ proposal: p }: { proposal: BuilderProposal }) {
  const { act, dispatch, setView, call } = useApp();
  const [settings, setSettings] = useState<AgentSettings>();
  useEffect(() => {
    let current = true;
    setSettings(undefined);
    // An older daemon, or a proposal that does not parse, has no settings: the file still shows.
    void call('agents.settings', { proposalId: p.id })
      .then((s) => current && setSettings(s))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [call, p.id]);
  const title =
    p.kind === 'create'
      ? 'Review before creating'
      : p.kind === 'replace'
        ? 'Review: replaces the whole file'
        : 'Review the changes';
  const done = () => dispatch({ type: 'proposalDone', proposalId: p.id });
  const words = settings ? plainWords(settings.current, settings.fixed, connectorName) : [];
  return (
    <section className="panel proposal" aria-label="Proposal review">
      <div className="approval-band">
        <Icon name="shield" size={14} />
        <span className="approval-band-title">Anchi · {title}</span>
      </div>
      <div className="panel-head">
        <span className="proposal-title">
          {settings?.current.name && settings.current.name !== p.agentId
            ? sanitizeLine(settings.current.name)
            : `@${sanitizeLine(p.agentId)}`}
        </span>
        <span className="mono small muted">@{sanitizeLine(p.agentId)}</span>
      </div>
      <div className="scroll grow panel-section">
        {settings && (
          <>
            <span className="section-label">WHAT IT COULD REACH</span>
            <span className="plain-line">
              <Icon name="sparkle" size={14} className="yes" />
              <span>
                Thinks with {accountName(settings.current.runtime)}
                {settings.current.model ? ` (${sanitizeLine(settings.current.model)})` : ''}
              </span>
            </span>
            {words.map((w) => (
              <span key={w.text} className={`plain-line ${w.warn ? 'plain-warn' : ''}`}>
                <Icon name={w.can ? 'check' : 'x'} size={14} className={w.can ? 'yes' : 'no'} />
                <span>{w.text}</span>
              </span>
            ))}
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
        <details className="file-view" open={!settings}>
          <summary>View the agent file</summary>
          <Diff text={p.agentDiff} />
          {p.imageDiff && (
            <>
              <span className="section-label">IMAGE RECIPE</span>
              <Diff text={p.imageDiff} />
            </>
          )}
        </details>
        <p className="small muted">
          Nothing is granted until you {p.kind === 'create' ? 'create the agent' : 'apply this'}. A
          new teammate or another machine is confirmed in a system dialog.
        </p>
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
          {p.kind === 'create' ? 'Create agent' : 'Apply'}
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
