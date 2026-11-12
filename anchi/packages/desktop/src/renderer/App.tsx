import { sanitizeLine } from '@anchi/core/sanitize';
import type { AgentSummary, Notifications } from '@anchi/protocol';
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReleaseUpdate, ServerState } from '../shared.ts';
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
import { useDesktopUpdate } from './updates.tsx';
import { AgentView } from './views/Agent.tsx';
import { DeleteAgentDialog } from './views/DeleteAgent.tsx';
import { attention, attentionCount, NeedsYouView } from './views/NeedsYou.tsx';
import { BuilderView } from './views/Builder.tsx';
import { type SettingsSection, SettingsView } from './views/Settings.tsx';
import { StartingView } from './views/Starting.tsx';
import { onboarded, setOnboarded, WelcomeView } from './views/Welcome.tsx';
import { welcomeStep } from '@anchi/core/welcome';
import { UsageView } from './views/Usage.tsx';
import { onVaultUnlocked, roomDown, vaultLocked } from './vault.tsx';

export const BUILDER = 'builder';

export type View =
  | { kind: 'agent'; agentId: string }
  | { kind: 'builder' }
  | { kind: 'inbox' }
  | { kind: 'usage' }
  | { kind: 'settings'; section?: SettingsSection }
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
  deleteAgent(agentId: string): void;
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
  const [update, postpone] = useDesktopUpdate();
  const waiting = attentionCount(attention(fleet, connections, update));
  const openAgent = (name: string, agentId: string) => {
    selectServer(name);
    setView({ kind: 'agent', agentId });
  };
  return (
    <div className="app">
      {connections.map((node) => (
        <MachineSync key={node.name} server={node} dispatch={dispatch} say={say} />
      ))}
      <div className="notifications">
        {flash && (
          <div className={flash.error ? 'flash flash-error' : 'flash'} role="status">
            {sanitizeLine(flash.text)}
          </div>
        )}
      </div>
      <div className="body">
        {view.kind !== 'welcome' && (
          <Sidebar
            fleet={fleet}
            connections={connections}
            selected={server.name}
            view={view}
            waiting={waiting}
            setView={setView}
            onSelect={openAgent}
            onBuilder={(name) => {
              selectServer(name);
              setView({ kind: 'builder' });
            }}
          />
        )}
        <ScopedView
          key={`${server.name}:${server.status}`}
          server={server}
          connections={connections}
          model={fleet[server.name] ?? EMPTY_MODEL}
          fleet={fleet}
          update={update}
          onPostpone={postpone}
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
    // Whether the vault is locked decides what the sidebar and the inbox say; an older daemon
    // or a machine still being prepared may not answer, which is not an error to show.
    const setup = () =>
      void call('setup.status')
        .then((status) => send({ type: 'setup', status }))
        .catch(() => undefined);
    setup();
    const timer = setInterval(setup, 60_000);
    const offVault = onVaultUnlocked(setup);
    void Promise.all([
      call('agents.list').then((agents) => send({ type: 'agents', agents })),
      tasks(),
      call('approvals.list').then((approvals) => send({ type: 'approvals', approvals })),
    ]).catch(fail);
    return () => {
      current = false;
      off();
      offVault();
      clearInterval(timer);
    };
  }, [server.name, server.label, server.status, dispatch, say]);
  return null;
}

/**
 * The one navigation column: what waits for the user, the agents, then usage and settings. It
 * stays in every view, so an agent is always one click away.
 */
export function Sidebar({
  fleet,
  connections,
  selected,
  view,
  waiting,
  setView,
  onSelect,
  onBuilder,
}: {
  fleet: Fleet;
  connections: ServerState[];
  selected: string;
  view: View;
  /** Held writes and notices, from every machine. */
  waiting: number;
  setView(view: View): void;
  onSelect(server: string, agentId: string): void;
  onBuilder(server: string): void;
}) {
  return (
    <nav className="sidebar" aria-label="Main">
      <SideButton
        label="Needs you"
        icon="inbox"
        badge={waiting}
        active={view.kind === 'inbox'}
        onClick={() => setView({ kind: 'inbox' })}
      />
      <SideButton
        label="New agent"
        icon="plus"
        active={view.kind === 'builder'}
        onClick={() => setView({ kind: 'builder' })}
      />
      <div className="sidebar-team">
        <TeamList
          fleet={fleet}
          connections={connections}
          selected={selected}
          view={view}
          onSelect={onSelect}
          onBuilder={onBuilder}
        />
      </div>
      <Protection
        fleet={fleet}
        connections={connections}
        onOpen={(inbox) =>
          setView(inbox ? { kind: 'inbox' } : { kind: 'settings', section: 'machines' })
        }
      />
      <div className="sidebar-foot">
        <SideButton
          label="Usage"
          icon="chart"
          active={view.kind === 'usage'}
          onClick={() => setView({ kind: 'usage' })}
        />
        <SideButton
          label="Settings"
          icon="gear"
          active={view.kind === 'settings'}
          onClick={() => setView({ kind: 'settings' })}
        />
      </div>
    </nav>
  );
}

/**
 * What protects the agents, in a line: a single machine's connection and vault, or how many
 * machines are connected. A locked vault sends the user to the inbox, where it is unlocked.
 */
function Protection({
  fleet,
  connections,
  onOpen,
}: {
  fleet: Fleet;
  connections: ServerState[];
  onOpen(inbox: boolean): void;
}) {
  const connected = connections.filter((s) => s.status === 'connected');
  const only = connections.length === 1 ? connections[0] : undefined;
  // A locked vault or a stopped secure room: agents there cannot work until it is seen to.
  const locked = connected.filter((s) => {
    const setup = fleet[s.name]?.setup;
    return setup && (vaultLocked(setup) || roomDown(setup));
  });
  const stopped = locked.some((s) => {
    const setup = fleet[s.name]?.setup;
    return setup && roomDown(setup);
  });
  const agents = connected.reduce(
    (n, s) => n + (fleet[s.name]?.agents ?? []).filter((a) => a.id !== BUILDER && !a.peer).length,
    0,
  );
  const place = only
    ? only.name === 'local'
      ? 'This computer'
      : sanitizeLine(only.label)
    : `${connected.length}/${connections.length} machines`;
  const state = only ? only.status : connected.length ? 'connected' : 'error';
  const ok = state === 'connected' && !locked.length;
  const title = ok
    ? 'Protected'
    : locked.length
      ? stopped
        ? 'Secure room stopped'
        : 'Vault locked'
      : 'Not connected';
  const detail = locked.length
    ? stopped
      ? 'Agents cannot start tasks'
      : 'Agents cannot use your accounts'
    : state === 'connected'
      ? `${place} · ${agents} ${agents === 1 ? 'agent' : 'agents'} sealed`
      : `${place} · ${only ? only.status : 'none connected'}`;
  return (
    <button
      type="button"
      className={`protection ${ok ? '' : 'protection-warn'}`}
      title={only ? `${only.name}: ${only.status}` : detail}
      aria-label={`${title}. ${detail}. ${locked.length ? 'Open Needs you' : 'Open machines'}`}
      onClick={() => onOpen(locked.length > 0)}
    >
      <span className="row gap-s">
        <span className={`dot dot-${locked.length ? 'error' : state}`} />
        <span className="strong">{title}</span>
      </span>
      <span className="small muted ellipsis">{detail}</span>
    </button>
  );
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
  const groups = connections.map((server) => ({
    server,
    via: server.name,
    model: fleet[server.name] ?? EMPTY_MODEL,
    agents: (fleet[server.name]?.agents ?? []).filter((a) => a.id !== BUILDER && !a.peer),
  }));
  const direct = new Set(
    groups
      .filter((g) => g.server.status === 'connected')
      .flatMap((g) => g.agents.map((a) => a.node).filter(Boolean)),
  );
  const seen = new Set<string>();
  for (const source of [...connections].sort(
    (a, b) => Number(b.name === selected) - Number(a.name === selected),
  )) {
    const model = fleet[source.name] ?? EMPTY_MODEL;
    if (source.status !== 'connected') continue;
    for (const agent of model.agents) {
      const peer = agent.peer;
      if (!peer || direct.has(peer.node) || seen.has(peer.node)) continue;
      seen.add(peer.node);
      groups.push({
        server: {
          name: `peer:${peer.node}`,
          label: peer.machine,
          status: peer.online ? 'connected' : 'error',
        },
        via: source.name,
        model,
        agents: model.agents.filter((a) => a.peer?.node === peer.node),
      });
    }
  }
  const total = groups.reduce((n, g) => n + g.agents.length, 0);
  // With one machine and no discovered peers there is nothing to tell apart: no host heading.
  const flat = groups.length === 1;
  return (
    <>
      <div className="section-label">AGENTS · {total}</div>
      {groups.map(({ server, via, model, agents }) => {
        const proposals = server.name.startsWith('peer:') ? 0 : Object.keys(model.proposals).length;
        const rows = (
          <>
            {!!proposals && (
              <button className="btn btn-small" onClick={() => onBuilder(server.name)}>
                {flat ? 'Proposals' : `Proposals on ${sanitizeLine(server.label)}`} ({proposals})
              </button>
            )}
            {agents.map((agent) => {
              const activity = agentActivity(model, agent);
              const tone = server.status === 'connected' ? activity.tone : 'idle';
              const active = selected === via && view.kind === 'agent' && view.agentId === agent.id;
              return (
                <button
                  type="button"
                  key={agent.id}
                  className={`agent-row ${active ? 'selected' : ''}`}
                  aria-current={active}
                  aria-label={`@${agent.peer?.agent ?? agent.id} on ${server.label}`}
                  onClick={() => onSelect(via, agent.id)}
                >
                  <span className={`avatar-wrap ${tone === 'working' ? 'avatar-working' : ''}`}>
                    <Avatar id={agent.peer?.agent ?? agent.id} />
                    {tone !== 'working' && <span className={`presence presence-${tone}`} />}
                  </span>
                  <span className="col grow min0">
                    <span className="strong ellipsis">{agentLabel(agent)}</span>
                    {(() => {
                      const preview =
                        server.status === 'connected'
                          ? sanitizeLine(activity.text)
                          : 'Offline · last known state';
                      return (
                        <span
                          className={`small agent-preview ellipsis tone-${activity.tone}`}
                          title={preview}
                        >
                          {preview}
                        </span>
                      );
                    })()}
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
          </>
        );
        return flat ? (
          <div key={server.name} className="team-group">
            {rows}
          </div>
        ) : (
          <TeamGroup key={server.name} server={server} count={agents.length}>
            {rows}
          </TeamGroup>
        );
      })}
    </>
  );
}

/** What an agent is called: its name when it has one of its own, else its id. */
export function agentLabel(agent: AgentSummary): string {
  const id = agent.peer?.agent ?? agent.id;
  const name = sanitizeLine(agent.name ?? '').trim();
  return name && name !== id ? name : `@${sanitizeLine(id)}`;
}

function TeamGroup({
  server,
  count,
  children,
}: {
  server: ServerState;
  count: number;
  children: ReactNode;
}) {
  const key = `anchi.team.hostCollapsed:${server.name}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== '1';
    } catch {
      return true;
    }
  });
  return (
    <details
      className="team-group"
      open={open}
      aria-label={`Agents on ${server.label}`}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try {
          if (next) localStorage.removeItem(key);
          else localStorage.setItem(key, '1');
        } catch {
          // Storage refused: the preference lasts until this list unmounts.
        }
      }}
    >
      <summary className="team-host" title={server.name}>
        <Icon name="chevron" size={14} className="team-chevron" />
        <span className={`dot dot-${server.status}`} />
        <span className="col grow min0">
          <span className="strong ellipsis">{sanitizeLine(server.label)}</span>
          <span className="small muted">{server.status}</span>
        </span>
        <span className="team-host-count">
          {count}
          <span className="sr-only"> agents</span>
        </span>
      </summary>
      {children}
    </details>
  );
}

function ScopedView({
  server,
  connections,
  model,
  fleet,
  update,
  onPostpone,
  dispatchFleet,
  act,
  selectServer,
  view,
  setView,
}: {
  server: ServerState;
  connections: ServerState[];
  model: Model;
  fleet: Fleet;
  update: ReleaseUpdate | null;
  onPostpone: () => void;
  dispatchFleet: Dispatch<FleetAction>;
  act: AppContext['act'];
  selectServer: AppContext['selectServer'];
  view: View;
  setView(view: View): void;
}) {
  const [deleting, setDeleting] = useState<string>();
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
        // Someone whose agents already finished work is not new: a stopped secure room or a
        // locked vault is theirs to fix from Needs you, not a reason to start the guide again.
        const used =
          agents.some((a) => a.id !== BUILDER) &&
          tasks.some((t) => t.agentId !== BUILDER && t.status === 'done');
        if (used || welcomeStep(status, agents, tasks) === 'done') setOnboarded(server.name);
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
    deleteAgent: setDeleting,
  };
  const team = model.agents.filter((a) => a.id !== BUILDER);
  return (
    <Ctx.Provider value={ctx}>
      <div className="machine-content">
        {connections.length > 1 &&
          view.kind !== 'settings' &&
          view.kind !== 'agent' &&
          view.kind !== 'inbox' &&
          view.kind !== 'welcome' && (
            <div className="machine-toolbar">
              <MachinePicker />
              <span className="small muted">Tasks belong to the selected machine</span>
            </div>
          )}
        {(view.kind === 'settings' || view.kind === 'inbox') && (
          <ConnectionBanner onOpen={() => setView({ kind: 'settings', section: 'machines' })} />
        )}
        <div className="machine-body">
          {view.kind === 'settings' ? (
            <SettingsView section={view.section} />
          ) : view.kind === 'inbox' ? (
            <NeedsYouView
              fleet={fleet}
              connections={connections}
              update={update}
              onPostpone={onPostpone}
            />
          ) : view.kind === 'welcome' ? (
            <WelcomeView
              onFinish={() =>
                setView(team[0] ? { kind: 'agent', agentId: team[0].id } : { kind: 'builder' })
              }
            />
          ) : server.status !== 'connected' ? (
            <StartingView />
          ) : (
            <>
              {view.kind === 'agent' && <AgentView key={view.agentId} agentId={view.agentId} />}
              {view.kind === 'builder' && <BuilderView />}
              {view.kind === 'usage' && <UsageView />}
            </>
          )}
        </div>
      </div>
      {deleting && (
        <DeleteAgentDialog
          agentId={deleting}
          onClose={() => {
            setDeleting(undefined);
            if (
              view.kind === 'agent' &&
              view.agentId === deleting &&
              !model.agents.some((a) => a.id === deleting)
            )
              navigate({ kind: 'builder' });
          }}
        />
      )}
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

/** Says so while the window is not talking to its server; otherwise the sidebar's dot is enough. */
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
        Machines
      </button>
    </div>
  );
}

function SideButton({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: 'inbox' | 'chart' | 'gear' | 'plus';
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`side-button ${active ? 'active' : ''}`}
      aria-label={badge ? `${label}, ${badge} waiting` : label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
      <span className="grow ellipsis">{label}</span>
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  );
}
