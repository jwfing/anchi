import { sanitizeLine } from '@anchi/core/sanitize';
import {
  CONNECTOR_IDS,
  type ConnectorId,
  type ServiceConnectorId,
  type SetupStatus,
  type SkillInfo,
  TOKEN_CONNECTOR_IDS,
  type TokenConnectorId,
} from '@anchi/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import { call, message } from '../api.ts';

export function SettingsView() {
  const { act, server } = useApp();
  const [status, setStatus] = useState<SetupStatus>();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const refresh = useCallback(() => {
    void act(() => call('setup.status')).then((s) => s && setStatus(s));
    void act(() => call('skills.list')).then((s) => s && setSkills(s));
  }, [act]);
  useEffect(() => {
    if (server.status === 'connected') refresh();
  }, [server.status, server.name, refresh]);

  return (
    <main className="main page scroll">
      <h1>Settings</h1>
      <ServerCard />
      {status && (
        <>
          <section className="card">
            <h2>Environment</h2>
            <dl className="facts">
              <dt>Guest</dt>
              <dd>
                {status.vm}
                {status.vmSize?.current
                  ? ` · ${status.vmSize.current.cpus} CPUs · ${status.vmSize.current.memoryGiB} GiB`
                  : ''}
              </dd>
              <dt>Vault</dt>
              <dd className={status.vaultUnlocked ? 'tone-ok strong' : 'tone-warn strong'}>
                {status.vaultUnlocked ? 'unlocked' : 'locked'}
              </dd>
              <dt>Version</dt>
              <dd>
                app {status.appVersion ?? '?'} · guest {status.guestVersion ?? '?'}
                {status.guestOutdated ? ' · outdated: run anchi setup install' : ''}
              </dd>
              <dt>Workspaces</dt>
              <dd>{status.workspaces ? 'shared' : 'not shared'}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Runtimes</h2>
            <div className="grid3">
              <Runtime
                name="Codex"
                ok={status.codex.connected}
                detail={
                  status.codex.expiresAt
                    ? `token valid until ${new Date(status.codex.expiresAt).toLocaleString()}`
                    : 'ChatGPT subscription login'
                }
              />
              <Runtime
                name="Claude Code"
                ok={status.claude.connected}
                detail={
                  status.claude.kind === 'api_key'
                    ? 'Anthropic API key'
                    : status.claude.kind === 'oauth'
                      ? 'subscription token'
                      : 'not connected'
                }
              />
              <Runtime
                name="Hermes"
                ok={!!status.hermes?.connected}
                detail={
                  status.hermes?.connected
                    ? `${status.hermes.baseUrl ?? ''} · ${status.hermes.model ?? ''}`
                    : 'OpenAI-compatible endpoint: set it up with anchi setup hermes'
                }
              />
            </div>
          </section>
          <div className="grid2">
            <ProxyConnectors status={status} onChange={refresh} />
            <Services status={status} onChange={refresh} />
          </div>
        </>
      )}
      <section className="card">
        <h2>Skills</h2>
        <p className="small muted">
          Assign skills in each agent's file or the TUI's settings panel. Add or update them with
          anchi skills.
        </p>
        {skills.map((s) => (
          <div key={s.id} className="skill-row">
            <span className="strong">{sanitizeLine(s.id)}</span>
            <span className="small muted grow">{sanitizeLine(s.description)}</span>
            <span className="mono small muted">
              {sanitizeLine(s.source)}
              {s.commit ? ` @ ${s.commit.slice(0, 7)}` : ''}
            </span>
          </div>
        ))}
        {!skills.length && <p className="small muted">No skills yet.</p>}
      </section>
    </main>
  );
}

function ServerCard() {
  const { server } = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const use = async (target: string) => {
    setError('');
    try {
      await window.anchi.setServer(target);
      setText('');
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <section className="card">
      <h2>Server</h2>
      <p className="small muted">
        The daemon, the vault and the task cells run on the server. Local runs them in a VM on this
        computer; a remote server (instabox:&lt;machine&gt; or ssh:&lt;host&gt;) keeps working while
        it sleeps.
      </p>
      <div className="row gap wrap">
        <span className={`dot dot-${server.status}`} />
        <span className="mono">{server.name}</span>
        <span className="small muted">
          {server.status}
          {server.error ? `: ${server.error}` : ''}
        </span>
      </div>
      <div className="row gap wrap">
        <label className="field grow">
          <span className="sr-only">Server</span>
          <input
            value={text}
            placeholder="local, instabox:anchi-server or ssh:dev@host"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!text.trim()}
          onClick={() => void use(text.trim())}
        >
          Use this server
        </button>
        {server.name !== 'local' && (
          <button type="button" className="btn" onClick={() => void use('local')}>
            Use this computer
          </button>
        )}
      </div>
      {error && <div className="banner banner-error">{error}</div>}
    </section>
  );
}

function Runtime({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="runtime">
      <div className="row between">
        <span className="strong">{name}</span>
        <span className={`small strong ${ok ? 'tone-ok' : 'muted'}`}>
          {ok ? 'connected' : 'not set up'}
        </span>
      </div>
      <span className="small muted">{sanitizeLine(detail)}</span>
    </div>
  );
}

function ProxyConnectors({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const { act } = useApp();
  const [editing, setEditing] = useState<TokenConnectorId | undefined>();
  const [token, setToken] = useState('');
  const byId = new Map(status.connectors.map((c) => [c.id, c]));
  const save = async () => {
    if (!editing) return;
    const ok = await act(
      () => call('connectors.set', { id: editing, token: token.trim() }),
      `${editing} connected`,
    );
    setToken('');
    setEditing(undefined);
    if (ok) onChange();
  };
  return (
    <section className="card">
      <h2>
        Connectors <span className="small muted normal">· the proxy adds the credential</span>
      </h2>
      {CONNECTOR_IDS.map((id: ConnectorId) => {
        const c = byId.get(id);
        const tokenId = (TOKEN_CONNECTOR_IDS as readonly string[]).includes(id)
          ? (id as TokenConnectorId)
          : undefined;
        return (
          <div key={id} className="connector-row">
            <span className={`dot ${c?.connected ? 'dot-connected' : 'dot-off'}`} />
            <span className="strong connector-id">{id}</span>
            <span className="small muted grow ellipsis">
              {c?.connected ? sanitizeLine(c.account ?? 'connected') : 'not connected'}
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
            ) : tokenId ? (
              <button type="button" className="btn btn-small" onClick={() => setEditing(tokenId)}>
                Connect
              </button>
            ) : (
              <span className="small muted">anchi setup connector aws</span>
            )}
          </div>
        );
      })}
      {editing && (
        <form
          className="secret"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field grow">
            <span className="small muted">
              {editing} token (stored in the vault on the server, never shown again)
            </span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={!token.trim()}>
            Save
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(undefined);
              setToken('');
            }}
          >
            Cancel
          </button>
        </form>
      )}
    </section>
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

function Services({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const { act } = useApp();
  const signIn = (id: ServiceConnectorId) => {
    const method = SIGN_IN[id];
    if (!method) return;
    void act(
      () => (method === 'services.googleLogin' ? call(method, { id }) : call(method)),
      'sign-in opened in your browser',
    );
  };
  return (
    <section className="card">
      <h2>
        Services <span className="small muted normal">· act for agents, writes auto or ask</span>
      </h2>
      {status.services.map((s) => {
        const fixedAsk = s.id === 'x' || s.id === 'reddit';
        return (
          <div key={s.id} className="connector-row">
            <span className={`dot ${s.connected ? 'dot-connected' : 'dot-off'}`} />
            <span className="strong connector-id">{s.id}</span>
            <span className="small muted grow ellipsis">
              {s.connected
                ? sanitizeLine(
                    s.accounts.map((a) => a.account ?? a.name).join(', ') ||
                      s.account ||
                      'connected',
                  )
                : s.reauthRequired
                  ? 'sign in again'
                  : 'not connected'}
            </span>
            {!s.connected && SIGN_IN[s.id] && (
              <button type="button" className="btn btn-small" onClick={() => signIn(s.id)}>
                Sign in
              </button>
            )}
            <div className="segmented" role="group" aria-label={`${s.id} writes`}>
              <button
                type="button"
                aria-pressed={s.mode === 'auto'}
                disabled={fixedAsk}
                onClick={() =>
                  void act(() => call('services.setMode', { id: s.id, mode: 'auto' })).then(
                    onChange,
                  )
                }
              >
                auto
              </button>
              <button
                type="button"
                aria-pressed={s.mode === 'ask'}
                className="ask"
                onClick={() =>
                  void act(() => call('services.setMode', { id: s.id, mode: 'ask' })).then(onChange)
                }
              >
                ask
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
