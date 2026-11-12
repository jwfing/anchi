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
import { accountName, Icon } from '../ui.tsx';
import { message } from '../api.ts';
import { CodexSignIn, Runtimes, ServerCard } from './Settings.tsx';

/**
 * Whether this window finished or skipped the guide for a server: a server switched to later may
 * still need preparing. Storage may be refused.
 */
export function onboarded(server: string): boolean {
  try {
    return localStorage.getItem(`anchi.onboarded:${server}`) === '1';
  } catch {
    return false;
  }
}
export function setOnboarded(server: string) {
  try {
    localStorage.setItem(`anchi.onboarded:${server}`, '1');
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
  const { model, server, act, setView, call } = useApp();
  const [status, setStatus] = useState<SetupStatus>();
  const [machines, setMachines] = useState(false);
  const [details, setDetails] = useState(false);
  const [failed, setFailed] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);

  const refresh = useCallback(() => {
    void call('setup.status')
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, [call]);
  useEffect(() => {
    if (server.status === 'connected') refresh();
  }, [server.status, server.name, refresh]);
  useEffect(
    () =>
      window.anchi.onNotify((origin, name, params) => {
        if (origin !== server.name || name !== 'setup') return;
        const { line } = params as Notifications['setup'];
        setLines((l) => [...l.slice(-200), sanitizeLine(line)]);
      }),
    [server.name],
  );
  // A preparation started elsewhere (or before the window closed) is followed until it ends.
  useEffect(() => {
    if (!status?.preparing) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [status?.preparing, refresh]);

  const agents = model.agents.filter((a) => a.id !== BUILDER);
  const step = status ? welcomeStep(status, model.agents, Object.values(model.tasks)) : undefined;
  const stage: Stage | 'done' = server.status !== 'connected' || !step ? 'machine' : stageFor(step);
  // The three cards: the secure room (with where it runs), an AI account, the first agent.
  const at = stage === 'done' ? 3 : stage === 'start' ? 2 : stage === 'runtime' ? 1 : 0;
  const state = (n: number) => (n < at ? 'done' : n === at ? 'now' : 'later');
  const where = server.name === 'local' ? 'this computer' : sanitizeLine(server.label);

  const prepare = async () => {
    if (!status) return;
    setPreparing(true);
    setFailed('');
    setLines([]);
    try {
      await call('setup.prepare', { runtime: suggestedRuntime(status), confirm: true });
    } catch (err) {
      // Declining the system dialog is not a failure to explain.
      const text = message(err);
      if (text !== 'cancelled') setFailed(sanitizeLine(text));
    }
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
    setOnboarded(server.name);
    onFinish();
    setView({ kind: 'agent', agentId: agent.id });
  };

  const mark = (n: number) => (
    <span className={`step-mark step-${state(n)}`}>
      {state(n) === 'done' ? <Icon name="check" size={14} /> : n + 1}
    </span>
  );
  const finish = () => {
    setOnboarded(server.name);
    onFinish();
  };

  return (
    <main className="main welcome">
      <aside className="welcome-promise">
        <div className="col gap-m">
          <h1>Agents that work for you, inside a sealed room.</h1>
          <Promise
            icon="key"
            title="Your accounts stay in a vault"
            text="Agents use GitHub or Gmail through Anchi. They never see the password or the token."
          />
          <Promise
            icon="lock"
            title="Every task runs in its own sealed cell"
            text="It cannot read your files unless you share a folder with it."
          />
          <Promise
            icon="shield"
            title="Risky actions wait for you"
            text="Sending, posting and merging ask first. You approve or deny in one click."
          />
        </div>
        <span className="small muted">
          Runs on {where}.{' '}
          <button type="button" className="link" onClick={() => setMachines(!machines)}>
            {machines ? 'Hide machines' : 'Use another machine'}
          </button>
        </span>
      </aside>
      <div className="welcome-steps scroll">
        <div className="row between">
          <div className="col gap-s">
            <h2 className="welcome-title">Three steps to your first agent</h2>
            <span className="muted">Nothing here needs a terminal.</span>
          </div>
          <button type="button" className="btn" onClick={finish}>
            {stage === 'done' ? 'Go to your agents' : 'Skip for now'}
          </button>
        </div>

        {(machines || server.status !== 'connected') && (
          <section className="card">
            <h3>Where Anchi runs</h3>
            <p className="small muted">
              Anchi keeps its agents, accounts and task cells on one machine. Start with this
              computer; a remote server can be added now or later.
            </p>
            <ServerCard />
          </section>
        )}

        <section
          className={`step-card step-card-${state(0)}`}
          aria-current={at === 0 ? 'step' : undefined}
        >
          {mark(0)}
          <div className="col grow gap-s min0">
            <div className="row between">
              <h3>{at > 0 ? 'The secure room is ready' : 'Set up the secure room'}</h3>
              {lines.length > 0 && (
                <button type="button" className="link small" onClick={() => setDetails(!details)}>
                  {details ? 'Hide details' : 'Show details'}
                </button>
              )}
            </div>
            {server.status !== 'connected' ? (
              <span className="small muted">
                {server.status === 'error'
                  ? `Anchi cannot reach ${where}. Choose a machine above.`
                  : `Starting Anchi on ${where}…`}
              </span>
            ) : at > 0 ? (
              <span className="small muted">
                The sealed space agents run in, and the vault that holds your accounts, on {where}.
              </span>
            ) : status?.host?.missing.length ? (
              <>
                <span>Anchi needs {status.host.missing.join(', ')} first.</span>
                <pre className="mono small">{status.host.installHint}</pre>
                <div className="row">
                  <button type="button" className="btn" onClick={refresh}>
                    Check again
                  </button>
                </div>
              </>
            ) : (
              status && (
                <>
                  <span className="small muted">
                    {nextSetupAction(status) === 'vm-start'
                      ? 'The secure room is stopped. Setting up starts it.'
                      : nextSetupAction(status) === 'install'
                        ? `Installs the sealed space agents run in, the vault and the gatekeeper on ${where}. The first time takes several minutes.`
                        : 'Unlocks the vault that holds your accounts.'}
                  </span>
                  <div className="row gap">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={preparing || !!status.preparing}
                      onClick={() => void prepare()}
                    >
                      {preparing || status.preparing ? 'Setting up…' : 'Set up'}
                    </button>
                    <span className="small muted">
                      Anchi asks once before it installs anything.
                    </span>
                  </div>
                  {(preparing || status.preparing) && (
                    <div className="progress-bar" role="progressbar" aria-label="Setting up">
                      <span />
                    </div>
                  )}
                  {failed && !preparing && (
                    <div className="thread-recover" role="alert">
                      <span className="small grow">
                        Setting up stopped: {failed} What already finished is kept; setting up again
                        continues from there.
                      </span>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => void prepare()}
                      >
                        Try again
                      </button>
                    </div>
                  )}
                </>
              )
            )}
            {details && lines.length > 0 && (
              <pre className="setup-log mono small" aria-live="polite">
                {lines.slice(-12).join('\n')}
              </pre>
            )}
            {(preparing || status?.preparing) && !details && lines.length > 0 && (
              <span className="small muted ellipsis" aria-live="polite">
                {lines.at(-1)}
              </span>
            )}
          </div>
        </section>

        <section
          className={`step-card step-card-${state(1)}`}
          aria-current={at === 1 ? 'step' : undefined}
        >
          {mark(1)}
          <div className="col grow gap-s min0">
            <h3>{at > 1 ? 'An AI account is connected' : 'Sign in to an AI account'}</h3>
            <span className="small muted">
              {at < 1
                ? preparing || status?.preparing
                  ? 'Claude and other providers are available as soon as the secure room is ready.'
                  : 'Available as soon as the secure room is ready.'
                : 'Agents think with an account you already have: ChatGPT, Claude, or any OpenAI-compatible provider. One is enough.'}
            </span>
            {at === 0 && status && (preparing || status.preparing) && (
              <div className="col gap-s">
                <span className="small">
                  While the secure room is being set up, you can already sign in to ChatGPT. Anchi
                  stores the login in the vault as soon as it exists.
                </span>
                <CodexSignIn server={server.name} connected={false} onDone={refresh} />
              </div>
            )}
            {at === 1 && status && (
              <>
                <Runtimes status={status} server={server.name} onChange={refresh} />
                {runtimeReady(status) && (
                  <div className="row">
                    <button type="button" className="btn btn-primary" onClick={refresh}>
                      Continue
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section
          className={`step-card step-card-${state(2)}`}
          aria-current={at === 2 ? 'step' : undefined}
        >
          {mark(2)}
          <div className="col grow gap-s min0">
            <h3>
              {at > 2
                ? 'You are set up'
                : at === 2 && agents.length
                  ? `Give ${agents[0]!.id} a first task`
                  : 'Meet your first agent'}
            </h3>
            {at < 2 && (
              <span className="small muted">
                Pick a ready-made agent and give it a first task. No folder or account is shared.
              </span>
            )}
            {at === 2 &&
              status &&
              (agents.length ? (
                <>
                  <span className="small muted">
                    Each runs in its own cell and shows up in the agent's conversation.
                  </span>
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
                  <span className="small muted">
                    @dev thinks with {accountName(suggestedRuntime(status))}, with no connections
                    and no access to your files. Change it later, or describe other agents under New
                    agent.
                  </span>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void startAgent()}
                    >
                      Create @dev
                    </button>
                  </div>
                </>
              ))}
            {at > 2 && (
              <span className="small muted">
                Your agents are ready. Describe new ones under New agent, or give one a task.
              </span>
            )}
          </div>
        </section>

        <div className="recovery">
          <Icon name="key" size={18} />
          <span className="col grow gap-xs">
            <span className="strong">Keep a copy of your recovery key</span>
            <span className="small">
              <span className="mono">~/.config/anchi/vault.key</span> on {where} is the only way to
              read the accounts you connect. Back it up once the secure room is set up.
            </span>
          </span>
        </div>
      </div>
    </main>
  );
}

function Promise({
  icon,
  title,
  text,
}: {
  icon: 'key' | 'lock' | 'shield';
  title: string;
  text: string;
}) {
  return (
    <div className="row gap top">
      <span className="template-icon promise-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="col gap-xs">
        <span className="strong">{title}</span>
        <span className="small muted">{text}</span>
      </span>
    </div>
  );
}
