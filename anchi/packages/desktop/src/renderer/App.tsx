import type { Notifications } from '@anchi/protocol';
import {
  createContext,
  type Dispatch,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ServerState } from '../shared.ts';
import { allEvents, call, message } from './api.ts';
import { type Action, agentActivity, EMPTY_MODEL, type Model, reduce } from './model.ts';
import { Avatar, Icon } from './ui.tsx';
import { AgentView } from './views/Agent.tsx';
import { ApprovalsView } from './views/Approvals.tsx';
import { BuilderView } from './views/Builder.tsx';
import { SettingsView } from './views/Settings.tsx';
import { onboarded, setOnboarded, WelcomeView } from './views/Welcome.tsx';
import { welcomeStep } from '@anchi/core/welcome';
import { UsageView } from './views/Usage.tsx';

export const BUILDER = 'builder';

export type View =
  | { kind: 'agent'; agentId: string }
  | { kind: 'builder' }
  | { kind: 'approvals' }
  | { kind: 'usage' }
  | { kind: 'settings' }
  | { kind: 'welcome' };

export interface AppContext {
  model: Model;
  dispatch: Dispatch<Action>;
  server: ServerState;
  /** Loads a task's whole transcript once; later events arrive as notifications. */
  loadEvents(taskId: string): void;
  /** Runs a daemon action, showing its error instead of throwing. */
  act<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined>;
  setView(view: View): void;
}

/** Exported for tests, which give a view its own context. */
export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside the app');
  return ctx;
}

export function App() {
  const [model, dispatch] = useReducer(reduce, EMPTY_MODEL);
  const [server, setServer] = useState<ServerState>({ name: 'local', status: 'connecting' });
  const [view, setView] = useState<View>({ kind: 'builder' });
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  const loading = useRef(new Set<string>());

  const say = useCallback((text: string, error = false) => {
    setFlash({ text, error });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), error ? 8000 : 3000);
  }, []);

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const value = await fn();
        if (done) say(done);
        return value;
      } catch (err) {
        say(message(err), true);
        return undefined;
      }
    },
    [say],
  );

  const loadEvents = useCallback((taskId: string) => {
    if (loading.current.has(taskId)) return;
    loading.current.add(taskId);
    allEvents(taskId)
      .then((events) => dispatch({ type: 'events', taskId, events }))
      .catch(() => loading.current.delete(taskId));
  }, []);

  useEffect(() => {
    void window.anchi.server().then(setServer);
    const offServer = window.anchi.onServer(setServer);
    const offNotify = window.anchi.onNotify((name, params) => {
      const p = params as Notifications[keyof Notifications];
      switch (name as keyof Notifications) {
        case 'event': {
          const e = p as Notifications['event'];
          dispatch({ type: 'event', taskId: e.taskId, seq: e.seq, event: e.event, ts: Date.now() });
          break;
        }
        case 'tasks':
          dispatch({ type: 'tasks', tasks: [(p as Notifications['tasks']).task] });
          break;
        case 'agents':
          dispatch({ type: 'agents', agents: (p as Notifications['agents']).agents });
          break;
        case 'approvals':
          dispatch({ type: 'approvals', approvals: (p as Notifications['approvals']).approvals });
          break;
        case 'proposal':
          dispatch({ type: 'proposal', proposal: (p as Notifications['proposal']).proposal });
          break;
        case 'tasksDeleted':
          void call('tasks.list', { limit: 500 }).then((tasks) =>
            dispatch({ type: 'tasks', tasks, replace: true }),
          );
          break;
        case 'oauth': {
          const o = p as Notifications['oauth'];
          say(o.ok ? `${o.id} connected` : `${o.id}: ${o.error ?? 'sign-in failed'}`, !o.ok);
          break;
        }
      }
    });
    return () => {
      offServer();
      offNotify();
    };
  }, [say]);

  // Everything is read again on each (re)connection: notifications missed meanwhile are lost.
  useEffect(() => {
    if (server.status !== 'connected') return;
    loading.current.clear();
    void Promise.all([
      call('agents.list').then((agents) => dispatch({ type: 'agents', agents })),
      call('tasks.list', { limit: 500 }).then((tasks) =>
        dispatch({ type: 'tasks', tasks, replace: true }),
      ),
      call('approvals.list').then((approvals) => dispatch({ type: 'approvals', approvals })),
    ]).catch((err) => say(message(err), true));
  }, [server.status, server.name, say]);

  // The guide opens on a window that has not finished it, unless this server needs nothing.
  const [guided, setGuided] = useState(onboarded());
  useEffect(() => {
    if (guided) return;
    if (server.status !== 'connected') {
      if (server.status === 'error') setView({ kind: 'welcome' });
      return;
    }
    void Promise.all([
      call('setup.status'),
      call('agents.list'),
      call('tasks.list', { limit: 500 }),
    ])
      .then(([status, agents, tasks]) => {
        if (welcomeStep(status, agents, tasks) === 'done') {
          setOnboarded();
          setGuided(true);
        } else setView({ kind: 'welcome' });
      })
      .catch(() => setView({ kind: 'welcome' }));
  }, [guided, server.status, server.name]);

  const ctx: AppContext = { model, dispatch, server, loadEvents, act, setView };
  const team = model.agents.filter((a) => a.id !== BUILDER);
  const pendingProposals = Object.keys(model.proposals).length;

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <img className="logo" src="icon.svg" alt="" />
            <span>Anchi</span>
          </div>
          <button
            type="button"
            className="server"
            onClick={() => setView({ kind: 'settings' })}
            aria-label={`Server ${server.name}, ${server.status}. Open settings`}
          >
            <span className={`dot dot-${server.status}`} />
            <span className="mono">{server.name}</span>
            <span className="muted">{server.status === 'connected' ? '' : server.status}</span>
          </button>
          {server.status === 'error' && <span className="topbar-error">{server.error}</span>}
          <div className="spacer" />
          {flash && (
            <div className={flash.error ? 'flash flash-error' : 'flash'} role="status">
              {flash.text}
            </div>
          )}
        </header>

        <div className="body">
          <nav className="rail" aria-label="Main">
            <RailButton
              label="Team"
              icon="chat"
              active={view.kind === 'agent' || view.kind === 'builder'}
              onClick={() =>
                setView(team[0] ? { kind: 'agent', agentId: team[0].id } : { kind: 'builder' })
              }
            />
            <RailButton
              label="Approvals"
              icon="shield"
              badge={model.approvals.length}
              active={view.kind === 'approvals'}
              onClick={() => setView({ kind: 'approvals' })}
            />
            <RailButton
              label="Usage"
              icon="chart"
              active={view.kind === 'usage'}
              onClick={() => setView({ kind: 'usage' })}
            />
            <div className="spacer" />
            <RailButton
              label="Settings"
              icon="gear"
              active={view.kind === 'settings'}
              onClick={() => setView({ kind: 'settings' })}
            />
          </nav>

          {(view.kind === 'agent' || view.kind === 'builder') && (
            <aside className="agents" aria-label="Agents">
              <button
                type="button"
                className={`new-agent ${view.kind === 'builder' ? 'selected' : ''}`}
                onClick={() => setView({ kind: 'builder' })}
              >
                <span className="new-agent-icon">
                  <Icon name={pendingProposals ? 'sparkle' : 'plus'} size={16} />
                </span>
                <span className="col">
                  <span className="strong">
                    {pendingProposals ? `Proposal waiting (${pendingProposals})` : 'New agent'}
                  </span>
                  <span className="small muted">Describe it to the builder</span>
                </span>
              </button>
              <div className="section-label">TEAM · {team.length}</div>
              {team.map((a) => {
                const activity = agentActivity(model, a);
                const selected = view.kind === 'agent' && view.agentId === a.id;
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`agent-row ${selected ? 'selected' : ''}`}
                    onClick={() => setView({ kind: 'agent', agentId: a.id })}
                    aria-current={selected}
                  >
                    <span className="avatar-wrap">
                      <Avatar id={a.id} />
                      <span className={`presence presence-${activity.tone}`} />
                    </span>
                    <span className="col grow min0">
                      <span className="row between">
                        <span className="strong">@{a.id}</span>
                        <span className="mono small muted">{a.runtime ?? ''}</span>
                      </span>
                      <span className={`small ellipsis tone-${activity.tone}`}>
                        {activity.text}
                      </span>
                    </span>
                  </button>
                );
              })}
              {!team.length && server.status === 'connected' && (
                <p className="small muted pad">No agents yet. Describe one to the builder.</p>
              )}
            </aside>
          )}

          {view.kind === 'agent' && <AgentView key={view.agentId} agentId={view.agentId} />}
          {view.kind === 'builder' && <BuilderView />}
          {view.kind === 'approvals' && <ApprovalsView />}
          {view.kind === 'usage' && <UsageView />}
          {view.kind === 'settings' && <SettingsView />}
          {view.kind === 'welcome' && (
            <WelcomeView
              onFinish={() => {
                setGuided(true);
                setView(team[0] ? { kind: 'agent', agentId: team[0].id } : { kind: 'builder' });
              }}
            />
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function RailButton({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: 'chat' | 'shield' | 'chart' | 'gear';
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rail-button ${active ? 'active' : ''}`}
      aria-label={badge ? `${label}, ${badge} waiting` : label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  );
}
