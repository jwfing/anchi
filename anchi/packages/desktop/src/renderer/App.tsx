import { sanitizeLine } from '@anchi/core/sanitize';
import type { Notifications } from '@anchi/protocol';
import {
  createContext,
  type Dispatch,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ServerState } from '../shared.ts';
import { allEvents, machineCall, type Call, message } from './api.ts';
import {
  type Action,
  agentActivity,
  EMPTY_MODEL,
  type Model,
  type Fleet,
  type FleetAction,
  reduceFleet,
} from './model.ts';
import { Avatar, Icon } from './ui.tsx';
import { AgentView } from './views/Agent.tsx';
import { ApprovalsView } from './views/Approvals.tsx';
import { BuilderView } from './views/Builder.tsx';
import { SettingsView } from './views/Settings.tsx';
import { onboarded, setOnboarded, WelcomeView } from './views/Welcome.tsx';
import { welcomeStep } from '@anchi/core/welcome';
import { UsageView } from './views/Usage.tsx';
import { VaultBanner } from './vault.tsx';

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
  connections: ServerState[];
  selectServer(name: string): void;
  call: Call;
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

const LOCAL: ServerState = { name: 'local', label: 'local', status: 'connecting' };

export function App() {
  const [fleet, dispatch] = useReducer(reduceFleet, {});
  const [connections, setConnections] = useState<ServerState[]>([LOCAL]);
  const [selected, setSelected] = useState('local');
  const [view, setView] = useState<View>({ kind: 'builder' });
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  const say = useCallback((text: string, error = false) => {
    setFlash({ text, error });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), error ? 8000 : 3000);
  }, []);
  const act = useCallback(
    async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (done) say(done);
        return result;
      } catch (err) {
        say(message(err), true);
        return undefined;
      }
    },
    [say],
  );
  const selectServer = useCallback(
    (name: string) => {
      setSelected(name);
      setView((current) => (current.kind === 'agent' ? { kind: 'builder' } : current));
      void act(() => window.anchi.setServer(name));
    },
    [act],
  );
  useEffect(() => {
    let current = true;
    let notified = false;
    const receive = (states: ServerState[]) => {
      if (!current) return;
      setConnections(states);
      dispatch({ type: 'retain', servers: states.map((s) => s.name) });
    };
    const off = window.anchi.onConnections((states) => {
      notified = true;
      receive(states);
    });
    void window.anchi.connections().then((states) => {
      if (!notified) receive(states);
    });
    void window.anchi.server().then((server) => {
      if (current) setSelected(server.name);
    });
    return () => {
      current = false;
      off();
    };
  }, []);
  const server = connections.find((s) => s.name === selected) ?? connections[0] ?? LOCAL;
  const team = (fleet[server.name] ?? EMPTY_MODEL).agents.filter((a) => a.id !== BUILDER);
  const approvals = Object.values(fleet).reduce((count, m) => count + m.approvals.length, 0);
  const connected = connections.filter((s) => s.status === 'connected').length;
  const openAgent = (name: string, agentId: string) => {
    selectServer(name);
    setView({ kind: 'agent', agentId });
  };
  return (
    <div className="app">
      {connections.map((node) => (
        <MachineSync key={node.name} server={node} dispatch={dispatch} say={say} />
      ))}
      {flash && (
        <div className={flash.error ? 'flash flash-error' : 'flash'} role="status">
          {sanitizeLine(flash.text)}
        </div>
      )}
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
            badge={approvals}
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
          <button
            type="button"
            className="rail-button"
            title={`${connected}/${connections.length} machines connected`}
            aria-label={`${connected} machines connected. Open settings`}
            onClick={() => setView({ kind: 'settings' })}
          >
            <Icon name="server" size={20} />
            <span className={`rail-dot dot-${connected ? 'connected' : 'error'}`} />
          </button>
          <RailButton
            label="Settings"
            icon="gear"
            active={view.kind === 'settings'}
            onClick={() => setView({ kind: 'settings' })}
          />
        </nav>
        {(view.kind === 'agent' || view.kind === 'builder') && (
          <aside className="agents" aria-label="Agents on all machines">
            <button
              type="button"
              className={`new-agent ${view.kind === 'builder' ? 'selected' : ''}`}
              onClick={() => setView({ kind: 'builder' })}
            >
              <span className="new-agent-icon">
                <Icon name="plus" size={16} />
              </span>
              <span className="col">
                <span className="strong">New agent</span>
                <span className="small muted">Choose a machine in the builder</span>
              </span>
            </button>
            <TeamList
              fleet={fleet}
              connections={connections}
              selected={server.name}
              view={view}
              onSelect={openAgent}
              onBuilder={(name) => {
                selectServer(name);
                setView({ kind: 'builder' });
              }}
            />
          </aside>
        )}
        <ScopedView
          key={`${server.name}:${server.status}`}
          server={server}
          connections={connections}
          model={fleet[server.name] ?? EMPTY_MODEL}
          dispatchFleet={dispatch}
          act={act}
          selectServer={selectServer}
          view={view}
          setView={setView}
        />
      </div>
    </div>
  );
}

/** A machine stays subscribed while another machine's view is selected. */
function MachineSync({
  server,
  dispatch,
  say,
}: {
  server: ServerState;
  dispatch: Dispatch<FleetAction>;
  say(text: string, error?: boolean): void;
}) {
  useEffect(() => {
    if (server.status !== 'connected') return;
    let current = true;
    const call = machineCall(server.name);
    const send = (action: Action) => {
      if (current) dispatch({ type: 'machine', server: server.name, action });
    };
    const fail = (err: unknown) => {
      if (current) say(`${server.label}: ${message(err)}`, true);
    };
    const tasks = () =>
      call('tasks.list', { limit: 500 }).then((tasks) =>
        send({ type: 'tasks', tasks, replace: true }),
      );
    const off = window.anchi.onNotify((origin, name, params) => {
      if (origin !== server.name) return;
      switch (name as keyof Notifications) {
        case 'event': {
          const e = params as Notifications['event'];
          send({ type: 'event', taskId: e.taskId, seq: e.seq, event: e.event, ts: Date.now() });
          break;
        }
        case 'tasks':
          send({ type: 'tasks', tasks: [(params as Notifications['tasks']).task] });
          break;
        case 'agents':
          send({ type: 'agents', agents: (params as Notifications['agents']).agents });
          break;
        case 'approvals':
          send({ type: 'approvals', approvals: (params as Notifications['approvals']).approvals });
          break;
        case 'proposal':
          send({ type: 'proposal', proposal: (params as Notifications['proposal']).proposal });
          break;
        case 'tasksDeleted':
          void tasks().catch(fail);
          break;
        case 'oauth': {
          const o = params as Notifications['oauth'];
          say(
            `${server.label}: ${o.id} ${o.ok ? 'connected' : (o.error ?? 'sign-in failed')}`,
            !o.ok,
          );
          break;
        }
      }
    });
    void Promise.all([
      call('agents.list').then((agents) => send({ type: 'agents', agents })),
      tasks(),
      call('approvals.list').then((approvals) => send({ type: 'approvals', approvals })),
    ]).catch(fail);
    return () => {
      current = false;
      off();
    };
  }, [server.name, server.label, server.status, dispatch, say]);
  return null;
}

export function TeamList({
  fleet,
  connections,
  selected,
  view,
  onSelect,
  onBuilder,
}: {
  fleet: Fleet;
  connections: ServerState[];
  selected: string;
  view: View;
  onSelect(server: string, agentId: string): void;
  onBuilder(server: string): void;
}) {
  const total = Object.values(fleet).reduce(
    (n, m) => n + m.agents.filter((a) => a.id !== BUILDER).length,
    0,
  );
  return (
    <>
      <div className="section-label">TEAM · {total}</div>
      {connections.map((server) => {
        const model = fleet[server.name] ?? EMPTY_MODEL;
        const agents = model.agents.filter((a) => a.id !== BUILDER);
        const proposals = Object.keys(model.proposals).length;
        return (
          <section key={server.name} aria-label={`Agents on ${server.label}`}>
            <div className="section-label row gap">
              <span className={`dot dot-${server.status}`} />
              {sanitizeLine(server.label)} · {server.status}
            </div>
            {!!proposals && (
              <button className="btn btn-small" onClick={() => onBuilder(server.name)}>
                Proposals on {sanitizeLine(server.label)} ({proposals})
              </button>
            )}
            {agents.map((agent) => {
              const activity = agentActivity(model, agent);
              const active =
                selected === server.name && view.kind === 'agent' && view.agentId === agent.id;
              return (
                <button
                  type="button"
                  key={agent.id}
                  className={`agent-row ${active ? 'selected' : ''}`}
                  aria-current={active}
                  aria-label={`@${agent.id} on ${server.label}`}
                  onClick={() => onSelect(server.name, agent.id)}
                >
                  <span className="avatar-wrap">
                    <Avatar id={agent.id} />
                    <span
                      className={`presence presence-${server.status === 'connected' ? activity.tone : 'idle'}`}
                    />
                  </span>
                  <span className="col grow min0">
                    <span className="strong ellipsis">@{sanitizeLine(agent.id)}</span>
                    <span className="small muted ellipsis">
                      {sanitizeLine(
                        agent.execution
                          ? `${server.label} → ${agent.execution.server}`
                          : server.label,
                      )}
                      {agent.runtime ? ` · ${agent.runtime}` : ''}
                    </span>
                    <span className={`small agent-preview tone-${activity.tone}`}>
                      {server.status === 'connected'
                        ? sanitizeLine(activity.text)
                        : 'Offline · last known state'}
                    </span>
                  </span>
                </button>
              );
            })}
            {!agents.length && (
              <p className="small muted pad">
                {server.status === 'connected'
                  ? 'No agents yet.'
                  : 'Agents appear when this machine connects.'}
              </p>
            )}
          </section>
        );
      })}
    </>
  );
}

function ScopedView({
  server,
  connections,
  model,
  dispatchFleet,
  act,
  selectServer,
  view,
  setView,
}: {
  server: ServerState;
  connections: ServerState[];
  model: Model;
  dispatchFleet: Dispatch<FleetAction>;
  act: AppContext['act'];
  selectServer: AppContext['selectServer'];
  view: View;
  setView(view: View): void;
}) {
  const call = useMemo(() => machineCall(server.name), [server.name]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const navigate = useCallback(
    (next: View) => {
      if (active.current) setView(next);
    },
    [setView],
  );
  const dispatch = useCallback(
    (action: Action) => dispatchFleet({ type: 'machine', server: server.name, action }),
    [server.name, dispatchFleet],
  );
  const loading = useRef(new Set<string>());
  const loadEvents = useCallback(
    (taskId: string) => {
      if (loading.current.has(taskId) || server.status !== 'connected') return;
      loading.current.add(taskId);
      void allEvents(call, taskId)
        .then((events) => {
          if (active.current) dispatch({ type: 'events', taskId, events });
        })
        .catch(() => loading.current.delete(taskId));
    },
    [call, dispatch, server.status],
  );
  useEffect(() => {
    if (onboarded(server.name) || server.status !== 'connected') return;
    let current = true;
    void Promise.all([
      call('setup.status'),
      call('agents.list'),
      call('tasks.list', { limit: 500 }),
    ])
      .then(([status, agents, tasks]) => {
        if (!current) return;
        if (welcomeStep(status, agents, tasks) === 'done') setOnboarded(server.name);
        else setView({ kind: 'welcome' });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [call, server.name, server.status, setView]);
  const ctx: AppContext = {
    model,
    dispatch,
    server,
    connections,
    selectServer,
    call,
    loadEvents,
    act,
    setView: navigate,
  };
  const team = model.agents.filter((a) => a.id !== BUILDER);
  return (
    <Ctx.Provider value={ctx}>
      <div className="machine-content">
        {view.kind !== 'settings' && view.kind !== 'agent' && (
          <div className="machine-toolbar">
            <MachinePicker />
            <span className="small muted">Tasks belong to the selected machine</span>
          </div>
        )}
        <ConnectionBanner onOpen={() => setView({ kind: 'settings' })} />
        {server.status === 'connected' && <VaultBanner />}
        <div className="machine-body">
          {view.kind === 'settings' ? (
            <SettingsView />
          ) : view.kind === 'welcome' ? (
            <WelcomeView
              onFinish={() =>
                setView(team[0] ? { kind: 'agent', agentId: team[0].id } : { kind: 'builder' })
              }
            />
          ) : server.status !== 'connected' ? (
            <main className="main empty">
              {sanitizeLine(server.label)} is {server.status}. Connect it in Settings to open tasks
              and make changes.
            </main>
          ) : (
            <>
              {view.kind === 'agent' && <AgentView key={view.agentId} agentId={view.agentId} />}
              {view.kind === 'builder' && <BuilderView />}
              {view.kind === 'approvals' && <ApprovalsView />}
              {view.kind === 'usage' && <UsageView />}
            </>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function MachinePicker() {
  const { server, connections, selectServer } = useApp();
  return (
    <label className="machine-picker">
      <Icon name="server" size={18} />
      <span className="sr-only">Machine</span>
      <select
        aria-label="Machine"
        value={server.name}
        onChange={(e) => selectServer(e.target.value)}
      >
        {connections.map((node) => (
          <option key={node.name} value={node.name}>
            {node.label} · {node.status}
          </option>
        ))}
      </select>
      <Icon name="down" size={16} />
    </label>
  );
}

/** Says so while the window is not talking to its server; otherwise the rail's dot is enough. */
function ConnectionBanner({ onOpen }: { onOpen: () => void }) {
  const { server } = useApp();
  if (server.status === 'connected') return null;
  return (
    <div className={`conn-banner conn-${server.status}`} role="status">
      <span className={`dot dot-${server.status}`} />
      <span className="grow">
        {server.status === 'connecting'
          ? `Connecting to ${sanitizeLine(server.label)}…`
          : `Not connected to ${sanitizeLine(server.label)}${server.error ? `: ${sanitizeLine(server.error)}` : ''}`}
      </span>
      <button type="button" className="btn btn-small" onClick={onOpen}>
        Server settings
      </button>
    </div>
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
