import { PeerSettings } from './PeerSettings.tsx';
import { sanitizeLine } from '@anchi/core/sanitize';
import {
  type AccessSummary,
  CONNECTOR_IDS,
  type ConnectorId,
  type Notifications,
  type ServiceConnectorId,
  type ServiceConnectorStatus,
  type SetupStatus,
  type SkillAddResult,
  type SkillInfo,
  type SkillUpdate,
  TOKEN_CONNECTOR_IDS,
  type TokenConnectorId,
} from '@anchi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MachinePicker, useApp } from '../App.tsx';
import type { ReleaseUpdate } from '../api.ts';
import type { ProbeResult, SavedServer } from '@anchi/daemon/client';
import { message, type Call } from '../api.ts';
import { ConnectorLogo, connectorName } from '../logos.tsx';
import { count } from '../format.ts';
import { Icon, Modal } from '../ui.tsx';
import { guideUrl, needsOAuthApp, TOKEN_SOURCE } from '../guides.ts';
import { onVaultUnlocked, vaultLocked, VaultLockedCard } from '../vault.tsx';

/** The sections of Settings, in the order of its navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'accounts', label: 'AI accounts', icon: 'sparkle' },
  { id: 'connections', label: 'Connections', icon: 'link' },
  { id: 'skills', label: 'Skills', icon: 'book' },
  { id: 'machines', label: 'Machines', icon: 'server' },
  { id: 'security', label: 'Security & recovery', icon: 'key' },
  { id: 'about', label: 'About & updates', icon: 'info' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

const SECTION_INTRO: Record<SettingsSection, string> = {
  accounts: 'The accounts your agents think with. One is enough.',
  connections:
    'Accounts your agents can act through. The credentials stay in the vault and Anchi makes the call for the agent.',
  skills:
    "Instructions agents can load. Assign them in an agent's Advanced tab. A GitHub skill stays at the commit it was added at until you update it.",
  machines:
    'Where your agents run. Most people only need this computer. Each machine keeps its own accounts and vault.',
  security: 'The parts that keep agents sealed, and how to get back in if something breaks.',
  about: 'The version of Anchi on this computer and on the selected machine.',
};

/** Sections whose content belongs to the selected machine; the others are about the app. */
const MACHINE_SCOPED: readonly SettingsSection[] = [
  'accounts',
  'connections',
  'skills',
  'security',
];

export function SettingsView({ section = 'accounts' }: { section?: SettingsSection }) {
  const { act, server, connections, setView, call } = useApp();
  const [status, setStatus] = useState<SetupStatus>();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const refresh = useCallback(() => {
    void act(() => call('setup.status')).then((s) => s && setStatus(s));
    void act(() => call('skills.list')).then((s) => s && setSkills(s));
  }, [act, call]);
  useEffect(() => {
    if (server.status === 'connected') refresh();
  }, [server.status, server.name, refresh]);
  useEffect(() => onVaultUnlocked(refresh), [refresh]);
  const title = SETTINGS_SECTIONS.find((s) => s.id === section)!.label;
  const connected = server.status === 'connected';
  const locked = !!status && vaultLocked(status);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        <h1>Settings</h1>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            type="button"
            key={s.id}
            className={`side-button ${s.id === section ? 'active' : ''}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => setView({ kind: 'settings', section: s.id })}
          >
            <Icon name={s.icon} size={17} />
            <span className="grow ellipsis">{s.label}</span>
          </button>
        ))}
      </nav>
      <main className="main page scroll settings-page">
        <div className="row between top">
          <div className="col gap-s grow">
            <h1>{title}</h1>
            <p className="muted">{SECTION_INTRO[section]}</p>
          </div>
          {connections.length > 1 && MACHINE_SCOPED.includes(section) && <MachinePicker />}
        </div>
        {MACHINE_SCOPED.includes(section) && !connected && (
          <div className="banner banner-warn">
            {sanitizeLine(server.label)} is {server.status}. Connect it under Machines to change
            these settings.
          </div>
        )}
        {section === 'accounts' &&
          connected &&
          status &&
          (locked ? (
            <VaultLockedCard status={status} onUnlocked={refresh} />
          ) : (
            <Runtimes status={status} server={server.name} onChange={refresh} />
          ))}
        {section === 'connections' &&
          connected &&
          status &&
          (locked ? (
            <VaultLockedCard status={status} onUnlocked={refresh} />
          ) : (
            <Connections status={status} onChange={refresh} />
          ))}
        {section === 'skills' && connected && (
          <Skills skills={skills} local={server.name === 'local'} onChange={refresh} />
        )}
        {section === 'machines' && (
          <>
            <ServerCard />
            {connected && (
              <details className="card more">
                <summary>
                  <Icon name="chevron" size={14} className="team-chevron" />
                  <span className="col grow">
                    <span className="strong">Link machines into a team</span>
                    <span className="small muted">
                      Let agents on different machines hand work to each other
                    </span>
                  </span>
                </summary>
                <PeerSettings key={server.name} />
              </details>
            )}
          </>
        )}
        {section === 'security' && connected && status && (
          <Security status={status} onChange={refresh} />
        )}
        {section === 'about' && <About status={connected ? status : undefined} />}
      </main>
    </div>
  );
}

/** Proxy connectors and service connectors are one thing to the user: accounts agents act through. */
export function Connections({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  return (
    <>
      <section className="card connections">
        <ProxyConnectors status={status} onChange={onChange} bare />
        <Services status={status} onChange={onChange} bare />
      </section>
      <div className="banner banner-ok">
        Connecting an account does not give it to any agent. You choose per agent, under Access.
      </div>
    </>
  );
}

/** The vault, the environment that seals agents, and the way back when a part of it is broken. */
export function Security({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const { act, call, server } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const where = server.name === 'local' ? 'this computer' : sanitizeLine(server.label);
  useEffect(
    () =>
      window.anchi.onNotify((origin, name, params) => {
        if (origin !== server.name || (name !== 'setup' && name !== 'reset')) return;
        const { line } = params as Notifications['setup'];
        setLines((l) => [...l.slice(-200), sanitizeLine(line)]);
      }),
    [server.name],
  );
  const repair = async () => {
    setBusy(true);
    setLines([]);
    await act(
      () =>
        call('setup.prepare', { runtime: status.preparedRuntimes?.[0] ?? 'codex', confirm: true }),
      'Environment checked',
    );
    setBusy(false);
    onChange();
  };
  const [typed, setTyped] = useState('');
  const [startup, setStartup] = useState<boolean>();
  useEffect(() => {
    if (server.name !== 'local') return;
    let current = true;
    void window.anchi
      .loginStartup()
      .then((on) => current && setStartup(on))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [server.name]);
  const reset = async () => {
    setBusy(true);
    setLines([]);
    const done = await act(() => call('setup.reset', { confirm: typed }), 'Anchi was reset');
    setBusy(false);
    setTyped('');
    if (done) onChange();
  };
  const running = status.vm === 'running' && status.installed;
  return (
    <>
      {vaultLocked(status) ? (
        <VaultLockedCard status={status} onUnlocked={onChange} />
      ) : (
        <section className="card">
          <div className="row between">
            <h2>Vault</h2>
            <span className={`tag ${status.vaultUnlocked ? 'tag-ok' : 'tag-off'}`}>
              {status.vaultUnlocked ? 'Unlocked' : 'Not ready'}
            </span>
          </div>
          <p className="small muted">Holds every account you connected, encrypted.</p>
          <dl className="facts">
            <dt>Recovery key</dt>
            <dd>
              <span className="mono">~/.config/anchi/vault.key</span> on {where}. It is the only way
              to read the stored accounts: keep a copy somewhere safe.
            </dd>
          </dl>
        </section>
      )}
      <section className="card">
        <div className="row between">
          <h2>Secure room</h2>
          <span className={`tag ${running ? 'tag-ok' : 'tag-off'}`}>
            {running ? 'Running' : sanitizeLine(status.vm)}
          </span>
        </div>
        <p className="small muted">The sealed virtual computer agents run in, on {where}.</p>
        <dl className="facts">
          <dt>Size</dt>
          <dd>
            {status.vmSize?.current
              ? `${status.vmSize.current.cpus} CPUs · ${status.vmSize.current.memoryGiB} GiB`
              : 'not reported'}
          </dd>
          <dt>Version</dt>
          <dd>
            app {status.appVersion ?? '?'} · secure room {status.guestVersion ?? '?'}
            {status.guestOutdated ? ' · needs an update: use Check & repair' : ''}
          </dd>
          <dt>Shared folders</dt>
          <dd>{status.workspaces ? 'available' : 'not available on this machine'}</dd>
        </dl>
        <div className="row gap">
          <button
            type="button"
            className="btn"
            disabled={busy || !!status.preparing}
            onClick={() => void repair()}
          >
            {busy || status.preparing ? 'Checking…' : 'Check & repair'}
          </button>
          <span className="small muted">
            Starts what is stopped, updates what is outdated and unlocks the vault. Asks first.
          </span>
        </div>
        {(busy || lines.length > 0) && (
          <pre className="setup-log mono small" aria-live="polite">
            {lines.slice(-12).join('\n') || 'Starting…'}
          </pre>
        )}
      </section>
      <section className="card">
        <div className="row between">
          <h2>Background service</h2>
          <span className="tag tag-ok">Running</span>
        </div>
        <p className="small muted">
          Keeps agents and schedules working when this window is closed. Anchi starts it when the
          app opens.
        </p>
        {server.name === 'local' ? (
          <div className="row gap">
            <span className="grow">Start when I log in</span>
            <span className="small muted">
              {startup === undefined ? '' : startup ? 'On' : 'Off'}
            </span>
            <button
              type="button"
              className="btn btn-small"
              role="switch"
              aria-checked={!!startup}
              disabled={startup === undefined}
              onClick={() =>
                void act(() => window.anchi.setLoginStartup(!startup)).then(
                  (now) => now !== undefined && setStartup(now),
                )
              }
            >
              {startup ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        ) : (
          <p className="small muted">
            On a remote machine it starts with the machine. Stopping it is done there, with{' '}
            <span className="mono">anchi daemon stop</span>.
          </p>
        )}
      </section>
      <AccessReport />
      <section className="card card-danger">
        <h2>Reset Anchi on {where}</h2>
        <p className="small">
          Deletes the secure room with everything in it: every AI account and connection must be
          connected again. Agent files, task history and the recovery key are kept, and shared
          folders on disk are not touched. Refused while a task runs.
        </p>
        <form
          className="row gap wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed === 'reset' && !busy) void reset();
          }}
        >
          <label className="field">
            <span className="sr-only">Type reset to confirm</span>
            <input
              value={typed}
              placeholder="Type reset to confirm"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-danger" disabled={typed !== 'reset' || busy}>
            Reset…
          </button>
          <span className="small muted">Anchi asks once more in a system dialog.</span>
        </form>
      </section>
    </>
  );
}

/** What agents reached over the last week, from the audit rows the daemon has. */
function AccessReport() {
  const { act, call } = useApp();
  const [report, setReport] = useState<AccessSummary>();
  const load = () =>
    void act(() => call('access.summary', { since: Date.now() - 7 * 86_400_000 })).then(
      (r) => r && setReport(r),
    );
  return (
    <section className="card">
      <div className="row between">
        <h2>What agents reached</h2>
        <button type="button" className="btn btn-small" onClick={load}>
          {report ? 'Refresh' : 'Open the report for the last 7 days'}
        </button>
      </div>
      <p className="small muted">
        Recorded by the gatekeeper outside the cells: which agent sent how many requests, and what
        was refused or held.
      </p>
      {report && (
        <>
          {report.partial && (
            <div className="banner banner-warn">
              Some running tasks could not be read; their requests are missing here.
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Tasks</th>
                <th>Requests</th>
                <th>Websites</th>
                <th>Refused</th>
                <th>Held</th>
                <th>Own credentials</th>
              </tr>
            </thead>
            <tbody>
              {report.agents.map((a) => (
                <tr key={a.agent}>
                  <td>@{sanitizeLine(a.agent)}</td>
                  <td>{a.tasks}</td>
                  <td>{a.requests}</td>
                  <td>{a.hosts}</td>
                  <td className={a.refused ? 'tone-warn' : ''}>{a.refused}</td>
                  <td>{a.held}</td>
                  <td className={a.credentialsOther ? 'tone-warn' : ''}>{a.credentialsOther}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!report.agents.length && <p className="small muted">No task ran in this period.</p>}
          {report.hosts.length > 0 && (
            <dl className="facts">
              <dt>Most requested</dt>
              <dd>
                {report.hosts
                  .slice(0, 8)
                  .map((h) => `${sanitizeLine(h.host)} (${h.requests})`)
                  .join(' · ')}
              </dd>
              {report.refused.length > 0 && (
                <>
                  <dt>Last refused</dt>
                  <dd>
                    {report.refused
                      .slice(0, 5)
                      .map(
                        (r) =>
                          `@${sanitizeLine(r.agent)} → ${sanitizeLine(r.host)} (${sanitizeLine(r.reason || r.decision)})`,
                      )
                      .join(' · ')}
                  </dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

function About({ status }: { status?: SetupStatus }) {
  const { server, setView } = useApp();
  const [update, setUpdate] = useState<ReleaseUpdate | null>(null);
  useEffect(() => {
    let current = true;
    void window.anchi
      .update()
      .then((u) => current && setUpdate(u))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      <section className="card">
        <h2>Anchi</h2>
        <dl className="facts">
          <dt>This app</dt>
          <dd>
            {update
              ? `${update.currentVersion} · ${update.version} is available`
              : 'up to date, or not checked yet'}
          </dd>
          <dt>{sanitizeLine(server.label)}</dt>
          <dd>
            {server.version ? `Anchi ${sanitizeLine(server.version)}` : 'version not reported'}
            {status?.guestVersion ? ` · secure room ${sanitizeLine(status.guestVersion)}` : ''}
          </dd>
        </dl>
        {update && (
          <div className="row gap">
            <button
              type="button"
              className="btn"
              onClick={() => void window.anchi.openExternal(update.url)}
            >
              What’s new
            </button>
            <span className="small muted">Upgrade a machine under Machines.</span>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Getting started</h2>
        <p className="small muted">
          Open the guide again to prepare a machine, connect an AI account or create a first agent.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setView({ kind: 'welcome' })}>
            Open the guide
          </button>
        </div>
      </section>
    </>
  );
}

/** The skills on the server: add from GitHub or (local server) a folder, update, remove. */
export function Skills({
  skills,
  local,
  onChange,
}: {
  skills: SkillInfo[];
  local: boolean;
  onChange: () => void;
}) {
  const { act, call, server } = useApp();
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<SkillAddResult>();
  const [updates, setUpdates] = useState<Record<string, SkillUpdate>>({});
  const added = (r: SkillAddResult | null | undefined) => {
    if (!r) return;
    setResult(r);
    setUrl('');
    onChange();
  };
  return (
    <section className="card">
      <form
        className="row gap wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => call('skills.add', { source: url.trim() })).then(added);
        }}
      >
        <label className="field grow">
          <span className="sr-only">GitHub address of a skill or a collection</span>
          <input
            value={url}
            spellCheck={false}
            placeholder="https://github.com/owner/repo/tree/main/skills/name"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!url.trim()}>
          Add from GitHub
        </button>
        {local && (
          <button
            type="button"
            className="btn"
            onClick={() => void act(() => window.anchi.addSkillFolder(server.name)).then(added)}
          >
            Add a folder…
          </button>
        )}
      </form>
      {result && (
        <div className="banner">
          {result.added.length
            ? `Added ${result.added.map((a) => sanitizeLine(a.id)).join(', ')}.`
            : 'Nothing added.'}
          {result.skipped.map((x, i) => (
            <div key={i} className="small tone-warn">
              Skipped: {sanitizeLine(x)}
            </div>
          ))}
        </div>
      )}
      {skills.map((s) => {
        const u = updates[s.id];
        return (
          <div key={s.id} className="skill-group">
            <div className="skill-row">
              <span className="strong">{sanitizeLine(s.id)}</span>
              <span className="small muted grow ellipsis">{sanitizeLine(s.description)}</span>
              <span className="mono small muted ellipsis skill-source">
                {sanitizeLine(s.source)}
                {s.commit ? ` @ ${s.commit.slice(0, 7)}` : ''}
              </span>
              {s.commit && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    void act(() => call('skills.checkUpdate', { id: s.id })).then(
                      (r) => r && setUpdates({ ...updates, [s.id]: r }),
                    )
                  }
                >
                  Check for update
                </button>
              )}
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  void act(() => call('skills.remove', { id: s.id }), `${s.id} removed`).then(
                    (r) => r !== undefined && onChange(),
                  )
                }
              >
                Remove
              </button>
            </div>
            {u && (
              <div className="drawer">
                {u.upToDate ? (
                  <span className="small">Up to date at {u.latest.slice(0, 7)}.</span>
                ) : (
                  <>
                    <span className="small">
                      {u.current?.slice(0, 7) ?? 'unknown'} → {u.latest.slice(0, 7)}:{' '}
                      {[
                        u.added.length && `${u.added.length} added`,
                        u.changed.length && `${u.changed.length} changed`,
                        u.removed.length && `${u.removed.length} removed`,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'no file changes'}
                    </span>
                    <div className="mono small muted">
                      {[
                        ...u.added.map((f) => `+ ${f}`),
                        ...u.changed.map((f) => `~ ${f}`),
                        ...u.removed.map((f) => `- ${f}`),
                      ]
                        .slice(0, 40)
                        .map((line) => (
                          <div key={line}>{sanitizeLine(line)}</div>
                        ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-small drawer-save"
                      onClick={() =>
                        void act(
                          () => call('skills.update', { id: s.id, commit: u.latest }),
                          `${s.id} updated`,
                        ).then((r) => {
                          if (!r) return;
                          const { [s.id]: _, ...rest } = updates;
                          setUpdates(rest);
                          onChange();
                        })
                      }
                    >
                      Update to {u.latest.slice(0, 7)}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!skills.length && <p className="small muted">No skills yet.</p>}
    </section>
  );
}

type Provider = 'instabox' | 'ssh';

/** Where the daemon, vault and cells run: this computer, or a saved remote server. */
export function ServerCard() {
  const { server, connections, selectServer } = useApp();
  const [servers, setServers] = useState<SavedServer[]>([{ name: 'local', target: 'local' }]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ saved: SavedServer; probe: ProbeResult }>();
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    }
  };
  useEffect(() => {
    void window.anchi.servers().then(setServers);
  }, [server.name, connections.length]);
  return (
    <section className="card">
      <p className="small muted">
        Select a machine to manage its AI accounts, connections and skills. Your other machines stay
        connected.
      </p>
      {connections.map((node) => {
        const active = node.name === server.name;
        const saved = servers.find((s) => s.target === node.name);
        return (
          <div key={node.name} className={`machine-row ${active ? 'selected' : ''}`}>
            <button
              type="button"
              className="machine-choice"
              aria-pressed={active}
              aria-label={`Configure ${node.label}`}
              onClick={() => selectServer(node.name)}
            >
              <span className="machine-icon">
                <Icon name="server" size={20} />
              </span>
              <span className="col grow min0">
                <span className="strong ellipsis">{sanitizeLine(node.label)}</span>
                <span className="small muted ellipsis">
                  {sanitizeLine(node.name === 'local' ? 'This computer' : node.name)}
                  {node.version ? ` · Anchi ${node.version}` : ''}
                </span>
              </span>
              <span className="machine-status small">
                <span className={`dot dot-${node.status}`} />
                {node.status}
              </span>
              {active && <Icon name="check" size={18} />}
            </button>
            <div className="row gap machine-actions">
              {node.status === 'needs-setup' || node.status === 'installing' ? (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={node.status === 'installing'}
                  onClick={() =>
                    void run(async () => {
                      if (await window.anchi.initializeServer(node.name)) {
                        setAdded(undefined);
                        selectServer(node.name);
                      }
                    })
                  }
                >
                  {node.status === 'installing' ? 'Initializing…' : 'Initialize'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    void run(() =>
                      window.anchi.connectServer(
                        node.name,
                        node.status === 'disconnected' || node.status === 'error',
                      ),
                    )
                  }
                >
                  {node.status === 'disconnected' || node.status === 'error'
                    ? 'Connect'
                    : 'Disconnect'}
                </button>
              )}
              {((node.newer && node.install === 'release') || node.upgrading) && (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={node.upgrading}
                  onClick={() => void run(() => window.anchi.upgradeServer(node.name))}
                >
                  {node.upgrading ? 'Upgrading…' : `Upgrade to ${node.newer}`}
                </button>
              )}
              {saved && saved.name !== 'local' && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={node.status === 'installing' || node.upgrading}
                  onClick={() =>
                    void run(() => window.anchi.removeServer(saved.name).then(setServers))
                  }
                >
                  Remove
                </button>
              )}
            </div>
            {node.error && (
              <p className="small tone-warn machine-error">{sanitizeLine(node.error)}</p>
            )}
            {node.upgrading && (
              <p className="small muted machine-error">
                Upgrading Anchi, then updating the secure room’s parts. Tasks can start again when
                it finishes.
              </p>
            )}
            {node.newer && node.install === 'source' && (
              <p className="small muted machine-error">
                Anchi {node.newer} is available. This machine runs Anchi from a source checkout:
                upgrade it from the checkout
                {node.name === 'local' ? '' : ` (scripts/remote.sh ${sanitizeLine(node.name)})`}.
              </p>
            )}
          </div>
        );
      })}
      {added && <ProbeNote added={added} onUse={() => selectServer(added.saved.target)} />}
      {adding ? (
        <AddServer
          onCancel={() => setAdding(false)}
          onAdded={(result) => {
            setAdded(result);
            setAdding(false);
            void window.anchi.servers().then(setServers);
            if (result.probe.kind === 'ok') selectServer(result.saved.target);
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn-small runtime-action"
          onClick={() => {
            setAdded(undefined);
            setAdding(true);
          }}
        >
          Add a machine
        </button>
      )}
      {error && <div className="banner banner-error">{error}</div>}
    </section>
  );
}

function AddServer({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (result: { saved: SavedServer; probe: ProbeResult }) => void;
}) {
  const [provider, setProvider] = useState<Provider>('ssh');
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = `${provider}:${where.trim()}`;
  return (
    <form
      className="drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        window.anchi
          .addServer(name.trim(), target)
          .then(onAdded, (err) => setError(message(err)))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{provider === 'ssh' ? 'Add a machine over SSH' : 'Add an instabox box'}</h2>
      <p className="small muted">
        {provider === 'ssh'
          ? 'Any Linux server that ssh on this computer already reaches with a key (no password prompt), as in ~/.ssh/config. Anchi uses your SSH keys and stores no password.'
          : 'A box you are signed in to with the instabox command line.'}
      </p>
      <div className="grid2">
        <label className="field">
          <span className="small strong">Name</span>
          <input
            value={name}
            placeholder="my-server"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="small strong">{provider === 'instabox' ? 'Machine' : 'Host'}</span>
          <input
            value={where}
            placeholder={
              provider === 'instabox' ? 'anchi-server' : 'dev@203.0.113.7 or a Host alias'
            }
            spellCheck={false}
            onChange={(e) => setWhere(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      <div className="row gap">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !name.trim() || !where.trim()}
        >
          {busy ? 'Checking…' : 'Check and save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="grow" />
        <button
          type="button"
          className="link small"
          onClick={() => {
            setProvider(provider === 'ssh' ? 'instabox' : 'ssh');
            setWhere('');
          }}
        >
          {provider === 'ssh' ? 'Other ways: add an instabox box' : 'Add over SSH instead'}
        </button>
      </div>
    </form>
  );
}

/** What trying a newly saved server found, and the next step. */
export function ProbeNote({
  added: { saved, probe },
  onUse,
}: {
  added: { saved: SavedServer; probe: ProbeResult };
  onUse: () => void;
}) {
  if (probe.kind === 'ok') {
    return (
      <div className="banner row gap">
        <span className="grow">{saved.name} answers.</span>
        <button type="button" className="btn btn-small" onClick={onUse}>
          Use {saved.name}
        </button>
      </div>
    );
  }
  if (probe.kind === 'bridge-missing') {
    return (
      <div className="banner banner-warn">
        Saved {saved.name}. Choose Initialize on its machine card to install Anchi, then continue
        with environment setup.
      </div>
    );
  }
  return (
    <div className="banner banner-warn">
      Saved {saved.name}, but it did not answer: {sanitizeLine(probe.detail)}
    </div>
  );
}

/** Refusal codes from the VM's admin scripts, in words; anything else shows as it came. */
const REFUSALS: Record<string, string> = {
  HERMES_BASE_URL_INVALID:
    'Use an https address on a public host name, with no port, user, query or fragment.',
  HERMES_BASE_URL_RESERVED:
    'Anchi already sends a credential to that host (Anthropic, GitHub, AWS…). Use another endpoint.',
  HERMES_API_KEY_REQUIRED: 'Enter the API key: 8 to 500 printable characters, no spaces.',
  HERMES_MODEL_INVALID: 'Enter the model id the endpoint expects, such as vendor/model-name.',
};

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

/**
 * A credential form that opens under the row it belongs to; the row's own button, now Cancel,
 * or Escape closes it. Errors stay in the form. Values go to the main process and the daemon, then into the vault on stdin.
 */
export function SecretForm({
  id,
  fields,
  note,
  submit,
  onCancel,
}: {
  id: string;
  fields: Field[];
  note: React.ReactNode;
  submit: (values: Record<string, string>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = fields.every((f) => values[f.key]?.trim());
  return (
    <form
      id={id}
      className="drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError('');
        const trimmed = Object.fromEntries(fields.map((f) => [f.key, values[f.key]!.trim()]));
        submit(trimmed)
          .catch((err) => {
            const text = message(err);
            setError(REFUSALS[text] ?? text);
          })
          .finally(() => setBusy(false));
      }}
    >
      <p className="small muted">{note}</p>
      {fields.map((f, i) => (
        <label key={f.key} className="field">
          <span className="small strong">{f.label}</span>
          <input
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            autoFocus={i === 0}
          />
        </label>
      ))}
      {error && <div className="banner banner-error">{error}</div>}
      <button type="submit" className="btn btn-primary drawer-save" disabled={!ready || busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

type RuntimeId = 'codex' | 'claude' | 'hermes';

const CODEX_LOGIN: Record<string, string> = {
  HOST_LOGIN_MISSING: 'has no Codex login yet',
  HOST_LOGIN_EXPIRED: 'has a Codex login that expired',
  HOST_LOGIN_UNAVAILABLE: 'has a Codex login Anchi could not read',
};

/**
 * The daemon reads the Codex login of the machine it runs on, so a remote server needs its own:
 * the codes become what to run, and where.
 */
export function codexLoginHelp(code: string, server: string): string | undefined {
  const state = CODEX_LOGIN[code];
  if (!state) return undefined;
  if (server === 'local') return `This computer ${state}. Run codex login, then Set up again.`;
  const host = server.slice(server.indexOf(':') + 1);
  const shell = server.startsWith('instabox:') ? `instabox ssh ${host}` : `ssh ${host}`;
  return `${host} ${state}. Run ${shell}, then codex login --device-auth there, then Set up again.`;
}

/** How each runtime is set up from here: its host login imported, or a form. */
const RUNTIMES: Record<
  RuntimeId,
  {
    name: string;
    /** What the user calls the account behind the runtime. */
    account: string;
    fields?: Field[];
    note: string;
    save: (call: Call, v: Record<string, string>, server: string) => Promise<unknown>;
  }
> = {
  codex: {
    name: 'Codex',
    account: 'ChatGPT',
    note: "Or import the server machine's own Codex login (codex login).",
    save: (call, _, server) =>
      call('setup.importCodex').catch((err: unknown) => {
        throw new Error(codexLoginHelp(message(err), server) ?? message(err));
      }),
  },
  claude: {
    name: 'Claude Code',
    account: 'Claude',
    fields: [
      {
        key: 'token',
        label: 'Token or API key',
        secret: true,
        placeholder: 'from claude setup-token, or an Anthropic API key',
      },
    ],
    note: 'Or paste a token from claude setup-token, or an API key. Stored in the vault on the server, never shown again.',
    save: (call, v) => call('setup.importClaude', { token: v.token! }),
  },
  hermes: {
    name: 'Hermes',
    account: 'Other provider',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://openrouter.ai/api/v1' },
      { key: 'model', label: 'Model', placeholder: "the endpoint's model id" },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
    note: 'Any OpenAI-compatible endpoint. The key is stored in the vault on the server.',
    save: (call, v) =>
      call('setup.importHermes', { baseUrl: v.baseUrl!, model: v.model!, apiKey: v.apiKey! }),
  },
};

function runtimeState(status: SetupStatus, id: RuntimeId): { ok: boolean; detail: string } {
  switch (id) {
    case 'codex':
      return {
        ok: status.codex.connected,
        detail: status.codex.expiresAt
          ? `token valid until ${new Date(status.codex.expiresAt).toLocaleString()}`
          : status.hostLogins?.codex.state === 'ready'
            ? 'a login is ready to import'
            : 'ChatGPT subscription login',
      };
    case 'claude':
      return {
        ok: status.claude.connected,
        detail:
          status.claude.kind === 'api_key'
            ? 'Anthropic API key'
            : status.claude.kind === 'oauth'
              ? 'subscription token'
              : 'subscription token or API key',
      };
    case 'hermes':
      return {
        ok: !!status.hermes?.connected,
        detail: status.hermes?.connected
          ? `${status.hermes.baseUrl ?? ''} · ${status.hermes.model ?? ''}`
          : 'OpenAI-compatible endpoint',
      };
  }
}

export function Runtimes({
  status,
  server,
  onChange,
}: {
  status: SetupStatus;
  server: string;
  onChange: () => void;
}) {
  const { act, call } = useApp();
  const [open, setOpen] = useState<RuntimeId>();
  const buttons = useRef(new Map<RuntimeId, HTMLButtonElement>());
  const close = (id: RuntimeId) => {
    setOpen(undefined);
    buttons.current.get(id)?.focus();
  };
  return (
    <section className="accounts">
      <div className="grid3">
        {(Object.keys(RUNTIMES) as RuntimeId[]).map((id) => {
          const rt = RUNTIMES[id];
          const { ok, detail } = runtimeState(status, id);
          return (
            <div key={id} className="runtime">
              <div className="row between">
                <span className="strong">
                  {rt.account} <span className="small muted normal">· {rt.name}</span>
                </span>
                <span className={`tag ${ok ? 'tag-ok' : 'tag-off'}`}>
                  {ok ? 'Connected' : 'Not set up'}
                </span>
              </div>
              <span className="small muted">{sanitizeLine(detail)}</span>
              {id === 'codex' && <CodexSignIn server={server} connected={ok} onDone={onChange} />}
              {id === 'claude' && <ClaudeSignIn server={server} connected={ok} onDone={onChange} />}
              <button
                type="button"
                className="btn btn-small runtime-action"
                ref={(el) => void (el ? buttons.current.set(id, el) : buttons.current.delete(id))}
                aria-expanded={rt.fields ? open === id : undefined}
                aria-controls={rt.fields ? `runtime-${id}` : undefined}
                onClick={() => {
                  if (rt.fields) return setOpen(open === id ? undefined : id);
                  void act(() => rt.save(call, {}, server), `${rt.name} connected`).then(
                    (r) => r && onChange(),
                  );
                }}
              >
                {open === id
                  ? 'Cancel'
                  : id === 'codex'
                    ? 'Import Codex login'
                    : id === 'claude'
                      ? 'Paste a token or API key'
                      : ok
                        ? 'Replace'
                        : 'Set up'}
              </button>
              {!rt.fields && <span className="small muted">{rt.note}</span>}
              {rt.fields && open === id && (
                <SecretForm
                  id={`runtime-${id}`}
                  fields={rt.fields}
                  note={rt.note}
                  submit={async (v) => {
                    await rt.save(call, v, server);
                    setOpen(undefined);
                    onChange();
                  }}
                  onCancel={() => close(id)}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * ChatGPT sign-in for Codex without a terminal: the daemon (on whichever machine) starts a
 * device-code login and returns a page and code; the user finishes in any browser, and the
 * daemon's `codexSignIn` notification ends the wait.
 */
export function CodexSignIn({
  server,
  connected,
  onDone,
}: {
  server: string;
  connected: boolean;
  onDone: () => void;
}) {
  const { act, call } = useApp();
  const [code, setCode] = useState<{ verificationUrl: string; userCode: string }>();
  const [failed, setFailed] = useState<string>();
  useEffect(
    () =>
      window.anchi.onNotify((origin, name, params) => {
        if (origin !== server || name !== 'codexSignIn') return;
        const p = params as Notifications['codexSignIn'];
        setCode(undefined);
        if (p.state === 'done') {
          setFailed(undefined);
          onDone();
        } else setFailed(sanitizeLine(p.message ?? 'The sign-in did not finish.'));
      }),
    [server, onDone],
  );
  const start = async () => {
    setFailed(undefined);
    const started = await act(() => call('setup.codexSignIn'));
    if (!started) return;
    setCode(started);
    void window.anchi.openExternal(started.verificationUrl);
  };
  if (code) {
    return (
      <div className="col gap" aria-live="polite">
        <span className="small">
          In the browser page that opened, sign in to ChatGPT and enter this code:
        </span>
        <span className="mono strong user-code">{sanitizeLine(code.userCode)}</span>
        <div className="row gap wrap">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void window.anchi.openExternal(code.verificationUrl)}
          >
            Open the page again
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              void act(() => call('setup.codexSignInCancel')).then(() => setCode(undefined))
            }
          >
            Cancel
          </button>
        </div>
        <span className="small muted">
          Waiting for the browser… The code expires in 15 minutes.
        </span>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`btn btn-small runtime-action ${connected ? '' : 'btn-primary'}`}
        onClick={() => void start()}
      >
        {connected ? 'Sign in again with ChatGPT' : 'Sign in with ChatGPT'}
      </button>
      {failed && <span className="small tone-error">{failed}</span>}
    </>
  );
}

/**
 * Claude sign-in without a terminal: the daemon runs `claude setup-token` and returns the page.
 * On this computer the page finishes by itself; for a remote server it shows a code to paste
 * here. The daemon's `claudeSignIn` notification ends the wait.
 */
function ClaudeSignIn({
  server,
  connected,
  onDone,
}: {
  server: string;
  connected: boolean;
  onDone: () => void;
}) {
  const { act, call } = useApp();
  const [page, setPage] = useState<{ url: string; codeRequired: boolean }>();
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState<string>();
  useEffect(
    () =>
      window.anchi.onNotify((origin, name, params) => {
        if (origin !== server || name !== 'claudeSignIn') return;
        const p = params as Notifications['claudeSignIn'];
        setPage(undefined);
        setCode('');
        if (p.state === 'done') {
          setFailed(undefined);
          onDone();
        } else setFailed(sanitizeLine(p.message ?? 'The sign-in did not finish.'));
      }),
    [server, onDone],
  );
  const start = async () => {
    setFailed(undefined);
    const started = await act(() => call('setup.claudeSignIn'));
    if (!started) return;
    setPage(started);
    void window.anchi.openExternal(started.url);
  };
  if (page) {
    return (
      <form
        className="col gap"
        aria-live="polite"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => call('setup.claudeSignInCode', { code: code.trim() }));
        }}
      >
        <span className="small">
          {page.codeRequired
            ? 'Sign in to Claude in the browser page that opened, then paste the code it shows:'
            : 'Sign in to Claude in the browser page that opened. Anchi finishes by itself; if the page shows a code instead, paste it here:'}
        </span>
        <label className="field">
          <span className="sr-only">Code from the Claude page</span>
          <input
            value={code}
            spellCheck={false}
            autoComplete="off"
            placeholder="Code from the page"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <div className="row gap wrap">
          <button type="submit" className="btn btn-small btn-primary" disabled={!code.trim()}>
            Send code
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void window.anchi.openExternal(page.url)}
          >
            Open the page again
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              void act(() => call('setup.claudeSignInCancel')).then(() => setPage(undefined))
            }
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`btn btn-small runtime-action ${connected ? '' : 'btn-primary'}`}
        onClick={() => void start()}
      >
        {connected ? 'Sign in again with Claude' : 'Sign in with Claude'}
      </button>
      {failed && <span className="small tone-error">{failed}</span>}
    </>
  );
}

/** Opens the connector's setup guide in the browser. */
function GuideLink({
  id,
  label = 'Setup guide ↗',
}: {
  id: ConnectorId | ServiceConnectorId;
  label?: string;
}) {
  const url = guideUrl(id);
  return (
    <button
      type="button"
      className="link"
      title={url}
      onClick={() => void window.anchi.openExternal(url)}
    >
      {label}
    </button>
  );
}

function TokenNote({ id }: { id: ConnectorId | ServiceConnectorId }) {
  return (
    <>
      {TOKEN_SOURCE[id]} <GuideLink id={id} />
      <br />
      Stored in the vault on the server, never shown again.
    </>
  );
}

/**
 * The OAuth app a browser sign-in needs: Google's client JSON, picked in a native dialog, or the
 * Client ID of an X or Reddit app. Sign in appears once the server has it.
 */
function OAuthAppForm({
  id,
  done,
  onCancel,
}: {
  id: ServiceConnectorId;
  done: () => void;
  onCancel: () => void;
}) {
  const { act, call, server } = useApp();
  if (id === 'gmail' || id === 'drive') {
    return (
      <div
        id={`connect-${id}`}
        className="drawer"
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <p className="small muted">
          Create a Desktop app OAuth client in Google Cloud with Gmail API and Drive API enabled,
          download its JSON and choose it here. Gmail and Drive share it. <GuideLink id={id} />
        </p>
        <button
          type="button"
          className="btn btn-primary drawer-save"
          autoFocus
          onClick={() =>
            void act(
              () => window.anchi.importGoogleClient(server.name),
              'Google client imported',
            ).then((imported) => imported && done())
          }
        >
          Choose client JSON…
        </button>
      </div>
    );
  }
  const reddit = id === 'reddit';
  return (
    <SecretForm
      id={`connect-${id}`}
      fields={[
        { key: 'clientId', label: 'Client ID' },
        ...(reddit ? [{ key: 'developerUsername', label: 'Developer username (without u/)' }] : []),
      ]}
      note={
        <>
          {reddit
            ? 'An installed app with approved Data API access and the redirect URI http://127.0.0.1:48174/callback.'
            : 'A Native App with OAuth 2.0 and the callback URL http://127.0.0.1:48173/callback.'}{' '}
          <GuideLink id={id} />
        </>
      }
      submit={async (v) => {
        await (reddit
          ? call('services.redditClient', {
              clientId: v.clientId!,
              developerUsername: v.developerUsername!,
            })
          : call('services.xClient', { clientId: v.clientId! }));
        done();
      }}
      onCancel={onCancel}
    />
  );
}

function ProxyConnectors({
  status,
  onChange,
  bare,
}: {
  status: SetupStatus;
  onChange: () => void;
  /** Inside another card: no card and no heading of its own. */
  bare?: boolean;
}) {
  const { act, call } = useApp();
  const [editing, setEditing] = useState<ConnectorId | undefined>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const byId = new Map(status.connectors.map((c) => [c.id, c]));
  const close = (id: string) => {
    setEditing(undefined);
    buttons.current.get(id)?.focus();
  };
  return (
    <Group bare={bare} title="Connectors" note="the proxy adds the credential">
      {CONNECTOR_IDS.map((id: ConnectorId) => {
        const c = byId.get(id);
        const tokenId = (TOKEN_CONNECTOR_IDS as readonly string[]).includes(id)
          ? (id as TokenConnectorId)
          : undefined;
        return (
          <div key={id} className="connector-group">
            <div className="connector-row">
              <span className={`dot ${c?.connected ? 'dot-connected' : 'dot-off'}`} />
              <ConnectorLogo id={id} />
              <span className="strong connector-id">{connectorName(id)}</span>
              <span className="small muted grow ellipsis">
                {c?.connected ? (
                  sanitizeLine(c.account ?? 'connected')
                ) : (
                  <GuideLink id={id} label="How to connect ↗" />
                )}
              </span>
              {c?.connected ? (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    void act(() => call('connectors.remove', { id }), `${id} disconnected`).then(
                      onChange,
                    )
                  }
                >
                  Disconnect
                </button>
              ) : (
                <>
                  {id === 'github' && (
                    <button
                      type="button"
                      className="btn btn-small"
                      title="Uses the login of the gh command line on this machine"
                      onClick={() =>
                        void act(() => call('connectors.importGh'), 'GitHub connected').then(
                          (done) => done && onChange(),
                        )
                      }
                    >
                      Use the gh login
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-small"
                    ref={(el) =>
                      void (el ? buttons.current.set(id, el) : buttons.current.delete(id))
                    }
                    aria-expanded={editing === id}
                    aria-controls={`connect-${id}`}
                    onClick={() => setEditing(editing === id ? undefined : id)}
                  >
                    {editing === id ? 'Cancel' : tokenId ? 'Connect' : 'Use an AWS profile'}
                  </button>
                </>
              )}
            </div>
            {id === 'aws' && editing === 'aws' && (
              <Modal title={'Connect AWS through a profile'} onClose={() => close(id)}>
                <SecretForm
                  id="connect-aws"
                  fields={[{ key: 'profile', label: 'Profile name', placeholder: 'dev-readonly' }]}
                  note={
                    <>
                      A profile of the AWS command line on this machine, such as an SSO profile.
                      Anchi keeps its temporary credentials renewed. Agents with the AWS connection
                      can do what the profile’s role allows: choose a narrow one.{' '}
                      <GuideLink id="aws" />
                    </>
                  }
                  submit={async (v) => {
                    await call('connectors.awsProfile', { profile: v.profile! });
                    setEditing(undefined);
                    onChange();
                  }}
                  onCancel={() => close(id)}
                />
              </Modal>
            )}
            {tokenId && editing === tokenId && (
              <Modal title={`Connect ${connectorName(id)}`} onClose={() => close(id)}>
                <SecretForm
                  id={`connect-${id}`}
                  fields={[{ key: 'token', label: `${id} token`, secret: true }]}
                  note={<TokenNote id={id} />}
                  submit={async (v) => {
                    await call('connectors.set', { id: tokenId, token: v.token! });
                    setEditing(undefined);
                    onChange();
                  }}
                  onCancel={() => close(id)}
                />
              </Modal>
            )}
          </div>
        );
      })}
    </Group>
  );
}

const SIGN_IN: Partial<
  Record<ServiceConnectorId, 'services.googleLogin' | 'services.xLogin' | 'services.redditLogin'>
> = {
  gmail: 'services.googleLogin',
  drive: 'services.googleLogin',
  x: 'services.xLogin',
  reddit: 'services.redditLogin',
};

interface DisconnectTarget {
  /** A Google account by name; absent for the service itself. */
  account?: string;
  /** What the provider calls the account, such as the email address. */
  label: string | null;
  /** Disconnected here, but the provider has not confirmed the revocation: disconnect again. */
  pending: boolean;
}

/** What a Disconnect button acts on, one per entry. */
export function disconnectable(s: ServiceConnectorStatus): DisconnectTarget[] {
  const accounts = s.accounts.filter((a) => a.connected || a.revocationPending);
  if (accounts.length) {
    return accounts.map((a) => ({ account: a.name, label: a.account, pending: !a.connected }));
  }
  return s.connected || s.revocationPending ? [{ label: s.account, pending: !s.connected }] : [];
}

/** Services that connect with a pasted token instead of a browser sign-in. */
const TOKEN_LABEL: Partial<Record<ServiceConnectorId, string>> = {
  notion: 'Notion token (ntn_…)',
  slack: 'Slack bot token (xoxb-…)',
};

export function Services({
  status,
  onChange,
  bare,
}: {
  status: SetupStatus;
  onChange: () => void;
  bare?: boolean;
}) {
  const { act, call } = useApp();
  const [editing, setEditing] = useState<ServiceConnectorId | undefined>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const close = (id: string) => {
    setEditing(undefined);
    buttons.current.get(id)?.focus();
  };
  const toggle = (id: ServiceConnectorId, label: string) => (
    <button
      type="button"
      className="btn btn-small"
      ref={(el) => void (el ? buttons.current.set(id, el) : buttons.current.delete(id))}
      aria-expanded={editing === id}
      aria-controls={`connect-${id}`}
      onClick={() => setEditing(editing === id ? undefined : id)}
    >
      {editing === id ? 'Cancel' : label}
    </button>
  );
  const signIn = (id: ServiceConnectorId) => {
    const method = SIGN_IN[id];
    if (!method) return;
    void act(
      () => (method === 'services.googleLogin' ? call(method, { id }) : call(method)),
      'sign-in opened in your browser',
    );
  };
  return (
    <Group bare={bare} title="Services" note="act for agents, writes auto or ask">
      {status.services.map((s) => {
        const tokenLabel = TOKEN_LABEL[s.id];
        const targets = disconnectable(s);
        // Several Google accounts each get a row of their own under the service's.
        const perAccount = targets.length > 1;
        const disconnect = (t: DisconnectTarget) => (
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              void act(
                () =>
                  call(
                    'services.disconnect',
                    t.account ? { id: s.id, account: t.account } : { id: s.id },
                  ),
                `${connectorName(s.id)}${t.account && perAccount ? ` ${t.account}` : ''} disconnected`,
              ).then(onChange)
            }
          >
            {t.pending ? 'Revoke again' : 'Disconnect'}
          </button>
        );
        return (
          <div key={s.id} className="connector-group">
            <div className="connector-row">
              <span className={`dot ${s.connected ? 'dot-connected' : 'dot-off'}`} />
              <ConnectorLogo id={s.id} />
              <span className="strong connector-id">{connectorName(s.id)}</span>
              <span className="small muted grow ellipsis">
                {perAccount ? (
                  count(targets.filter((t) => !t.pending).length, 'account')
                ) : s.connected ? (
                  sanitizeLine(
                    s.accounts.map((a) => a.account ?? a.name).join(', ') ||
                      s.account ||
                      'connected',
                  )
                ) : s.reauthRequired ? (
                  'sign in again'
                ) : targets[0]?.pending ? (
                  'revocation pending'
                ) : needsOAuthApp(s.id, status) ? (
                  <GuideLink id={s.id} label="Needs an OAuth app ↗" />
                ) : (
                  <GuideLink id={s.id} label="How to connect ↗" />
                )}
              </span>
              {!perAccount && targets[0] && disconnect(targets[0])}
              {!s.connected && SIGN_IN[s.id] && !needsOAuthApp(s.id, status) && (
                <button type="button" className="btn btn-small" onClick={() => signIn(s.id)}>
                  Sign in
                </button>
              )}
              {!s.connected && tokenLabel && toggle(s.id, 'Connect')}
              {!s.connected && needsOAuthApp(s.id, status) && toggle(s.id, 'Add app')}
              <div className="segmented" role="group" aria-label={`${s.id} writes`}>
                <button
                  type="button"
                  aria-pressed={s.mode === 'auto'}
                  onClick={() =>
                    void act(() => call('services.setMode', { id: s.id, mode: 'auto' })).then(
                      onChange,
                    )
                  }
                >
                  Allow
                </button>
                <button
                  type="button"
                  aria-pressed={s.mode === 'ask'}
                  className="ask"
                  onClick={() =>
                    void act(() => call('services.setMode', { id: s.id, mode: 'ask' })).then(
                      onChange,
                    )
                  }
                >
                  Ask first
                </button>
              </div>
            </div>
            {perAccount &&
              targets.map((t) => (
                <div key={t.account} className="connector-row account-row">
                  <span className="connector-id">{t.account}</span>
                  <span className="small muted grow ellipsis">
                    {t.pending ? 'revocation pending' : sanitizeLine(t.label ?? 'connected')}
                  </span>
                  {disconnect(t)}
                </div>
              ))}
            {editing === s.id && needsOAuthApp(s.id, status) && (
              <Modal
                title={`${connectorName(s.id)} needs an app of your own`}
                onClose={() => close(s.id)}
              >
                <OAuthAppForm
                  id={s.id}
                  done={() => {
                    setEditing(undefined);
                    onChange();
                  }}
                  onCancel={() => close(s.id)}
                />
              </Modal>
            )}
            {tokenLabel && editing === s.id && (
              <Modal title={`Connect ${connectorName(s.id)}`} onClose={() => close(s.id)}>
                <SecretForm
                  id={`connect-${s.id}`}
                  fields={[{ key: 'token', label: tokenLabel, secret: true }]}
                  note={<TokenNote id={s.id} />}
                  submit={async (v) => {
                    await call('services.setToken', { id: s.id, token: v.token! });
                    setEditing(undefined);
                    onChange();
                  }}
                  onCancel={() => close(s.id)}
                />
              </Modal>
            )}
          </div>
        );
      })}
    </Group>
  );
}

/** A card with its heading, or only its rows when another card holds them. */
function Group({
  bare,
  title,
  note,
  children,
}: {
  bare?: boolean;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  if (bare) return <>{children}</>;
  return (
    <section className="card">
      <h2>
        {title} <span className="small muted normal">· {note}</span>
      </h2>
      {children}
    </section>
  );
}
