import { sanitizeLine } from '@anchi/core/sanitize';
import {
  FIRST_TASK,
  nextSetupAction,
  runtimeReady,
  suggestedRuntime,
  welcomeStep,
  type WelcomeStep,
} from '@anchi/core/welcome';
import type { Notifications, SetupStatus } from '@anchi/protocol';
import { useCallback, useEffect, useState } from 'react';
import { BUILDER, useApp } from '../App.tsx';
import { call } from '../api.ts';
import { Icon } from '../ui.tsx';
import { Runtimes, ServerCard } from './Settings.tsx';

const ONBOARDED = 'anchi.onboarded';

/** Whether this window finished or skipped the guide; storage may be refused. */
export function onboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED) === '1';
  } catch {
    return false;
  }
}
export function setOnboarded() {
  try {
    localStorage.setItem(ONBOARDED, '1');
  } catch {
    // The guide shows again next time.
  }
}

/** The guide's stages, in order; each covers one or more of the daemon's welcome steps. */
type Stage = 'machine' | 'prepare' | 'runtime' | 'start';
const STAGES: { id: Stage; title: string; covers: WelcomeStep[] }[] = [
  { id: 'machine', title: 'Choose where Anchi runs', covers: [] },
  { id: 'prepare', title: 'Prepare the environment', covers: ['environment', 'vault'] },
  { id: 'runtime', title: 'Connect a runtime', covers: ['runtime'] },
  { id: 'start', title: 'Meet your first agent', covers: ['agent', 'task'] },
];

/** The stage a status puts the user in, once the machine is chosen. */
export function stageFor(step: WelcomeStep): Stage | 'done' {
  return step === 'done' ? 'done' : STAGES.find((s) => s.covers.includes(step))!.id;
}

const STARTERS = [
  { label: 'Review a function', text: FIRST_TASK },
  {
    label: 'Summarize notes',
    text: 'Summarize these notes in three bullet points, then list the action items:\n\nMet the infra team. Database migration moves to next Tuesday. Alice owns the rollback plan. We still need a decision on the backup window; Bob will ask finance about the storage budget.',
  },
  {
    label: 'Explain a command',
    text: 'Explain what `find . -name "*.log" -mtime +7 -delete` does, what could go wrong, and a safer way to run it first. Do not run it.',
  },
];

export function WelcomeView({ onFinish }: { onFinish: () => void }) {
  const { model, server, act, setView } = useApp();
  const [status, setStatus] = useState<SetupStatus>();
  const [machineChosen, setMachineChosen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);

  const refresh = useCallback(() => {
    void call('setup.status')
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, []);
  useEffect(() => {
    if (server.status === 'connected') refresh();
  }, [server.status, server.name, refresh]);
  useEffect(
    () =>
      window.anchi.onNotify((name, params) => {
        if (name !== 'setup') return;
        const { line } = params as Notifications['setup'];
        setLines((l) => [...l.slice(-200), sanitizeLine(line)]);
      }),
    [],
  );
  // A preparation started elsewhere (or before the window closed) is followed until it ends.
  useEffect(() => {
    if (!status?.preparing) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [status?.preparing, refresh]);

  const agents = model.agents.filter((a) => a.id !== BUILDER);
  const step = status ? welcomeStep(status, model.agents, Object.values(model.tasks)) : undefined;
  const stage: Stage | 'done' =
    !machineChosen || server.status !== 'connected' || !step ? 'machine' : stageFor(step);
  const index = stage === 'done' ? STAGES.length : STAGES.findIndex((s) => s.id === stage);

  const prepare = async () => {
    if (!status) return;
    setPreparing(true);
    setLines([]);
    await act(
      () => call('setup.prepare', { runtime: suggestedRuntime(status), confirm: true }),
      'environment ready',
    );
    setPreparing(false);
    refresh();
  };

  const startAgent = async () => {
    if (!status) return;
    const proposal = await act(() =>
      call('agents.createPreview', { agentId: 'dev', runtime: suggestedRuntime(status) }),
    );
    if (!proposal) return;
    await act(() => call('builder.apply', { proposalId: proposal.id }), '@dev created');
  };

  const giveTask = async (text: string) => {
    const agent = agents[0];
    if (!agent) return;
    const task = await act(() => call('tasks.create', { agentId: agent.id, text }));
    if (!task) return;
    setOnboarded();
    onFinish();
    setView({ kind: 'agent', agentId: agent.id });
  };

  return (
    <main className="main page scroll welcome">
      <div className="row between">
        <h1>Getting started</h1>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOnboarded();
            onFinish();
          }}
        >
          {stage === 'done' ? 'Go to your team' : 'Skip for now'}
        </button>
      </div>
      <ol className="stepper">
        {STAGES.map((s, i) => (
          <li
            key={s.id}
            className={i < index ? 'step-done' : i === index ? 'step-now' : 'step-later'}
            aria-current={i === index ? 'step' : undefined}
          >
            <span className="step-mark">{i < index ? <Icon name="check" size={14} /> : i + 1}</span>
            {s.title}
          </li>
        ))}
      </ol>

      {stage === 'machine' && (
        <>
          <p className="muted">
            Anchi keeps its agents, credentials and task cells on a server. Start with this
            computer; you can add a remote server now or later.
          </p>
          <ServerCard />
          <button
            type="button"
            className="btn btn-primary runtime-action"
            disabled={server.status !== 'connected'}
            onClick={() => setMachineChosen(true)}
          >
            {server.status === 'connected'
              ? `Continue with ${server.name}`
              : `Waiting for ${server.name}…`}
          </button>
        </>
      )}

      {stage === 'prepare' && status && (
        <section className="card">
          <h2>Prepare {server.name === 'local' ? 'this computer' : server.name}</h2>
          {status.host?.missing.length ? (
            <>
              <p>Anchi needs {status.host.missing.join(', ')} first.</p>
              <pre className="mono small">{status.host.installHint}</pre>
              <button type="button" className="btn runtime-action" onClick={refresh}>
                Check again
              </button>
            </>
          ) : (
            <>
              <p className="small muted">
                {nextSetupAction(status) === 'vm-start'
                  ? 'The Anchi VM is stopped. Preparing starts it.'
                  : nextSetupAction(status) === 'install'
                    ? 'Preparing installs the Anchi VM, its services and a runtime image. The first time takes several minutes.'
                    : 'Preparing unlocks the vault that holds your credentials.'}
              </p>
              <button
                type="button"
                className="btn btn-primary runtime-action"
                disabled={preparing || !!status.preparing}
                onClick={() => void prepare()}
              >
                {preparing || status.preparing ? 'Preparing…' : 'Prepare'}
              </button>
              {(preparing || status.preparing || lines.length > 0) && (
                <pre className="setup-log mono small" aria-live="polite">
                  {lines.slice(-12).join('\n') || 'Starting…'}
                </pre>
              )}
            </>
          )}
        </section>
      )}

      {stage === 'runtime' && status && (
        <>
          <p className="muted">
            Agents run on Codex (a ChatGPT login), Claude Code (a Claude subscription token or API
            key) or Hermes (any OpenAI-compatible endpoint). One is enough to start.
          </p>
          <Runtimes status={status} server={server.name} onChange={refresh} />
          {runtimeReady(status) && (
            <button type="button" className="btn btn-primary runtime-action" onClick={refresh}>
              Continue
            </button>
          )}
        </>
      )}

      {stage === 'start' && status && (
        <section className="card">
          {agents.length ? (
            <>
              <h2>Give @{agents[0]!.id} a first task</h2>
              <p className="small muted">
                Each runs in its own cell and shows up in the agent's conversation.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button
                    type="button"
                    key={s.label}
                    className="starter"
                    onClick={() => void giveTask(s.text)}
                  >
                    <span className="strong">{s.label}</span>
                    <span className="small muted">{s.text.split('\n')[0]}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <h2>Create a starter agent</h2>
              <p className="small muted">
                @dev runs on {suggestedRuntime(status)} with no connectors and no access to your
                files. Change it later in its Settings tab, or describe other agents to the builder.
              </p>
              <button
                type="button"
                className="btn btn-primary runtime-action"
                onClick={() => void startAgent()}
              >
                Create @dev
              </button>
            </>
          )}
        </section>
      )}

      {stage === 'done' && (
        <section className="card">
          <h2>You are set up</h2>
          <p className="small muted">
            Your team is ready. Describe new agents to the builder, or give an agent a task.
          </p>
        </section>
      )}
    </main>
  );
}
