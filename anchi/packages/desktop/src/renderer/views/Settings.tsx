import { PeerSettings } from './PeerSettings.tsx';
import { sanitizeLine } from '@anchi/core/sanitize';
import {
  CONNECTOR_IDS,
  type ConnectorId,
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
import { useApp } from '../App.tsx';
import type { ProbeResult, SavedServer } from '@anchi/daemon/client';
import { message, type Call } from '../api.ts';
import { ConnectorLogo, connectorName } from '../logos.tsx';
import { count } from '../format.ts';
import { Icon } from '../ui.tsx';
import { guideUrl, needsOAuthApp, TOKEN_SOURCE } from '../guides.ts';
import { onVaultUnlocked, vaultLocked, VaultLockedCard } from '../vault.tsx';

export function SettingsView() {
  const { act, server, setView, call } = useApp();
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

  return (
    <main className="main page scroll">
      <div className="row between">
        <h1>Settings · {sanitizeLine(server.label)}</h1>
        <button type="button" className="btn" onClick={() => setView({ kind: 'welcome' })}>
          Getting started
        </button>
      </div>
      <ServerCard />
      {server.status === 'connected' && <PeerSettings key={server.name} />}
      {server.status === 'connected' && status && (
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
          {vaultLocked(status) ? (
            <VaultLockedCard status={status} onUnlocked={refresh} />
          ) : (
            <>
              <Runtimes status={status} server={server.name} onChange={refresh} />
              <div className="grid2">
                <ProxyConnectors status={status} onChange={refresh} />
                <Services status={status} onChange={refresh} />
              </div>
            </>
          )}
        </>
      )}
      {server.status === 'connected' && (
        <Skills skills={skills} local={server.name === 'local'} onChange={refresh} />
      )}
    </main>
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
      <h2>Skills</h2>
      <p className="small muted">
        Instructions agents can load. Assign them in an agent's Settings tab. A GitHub skill stays
        at the commit it was added at until you update it.
      </p>
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
      <h2>Machines</h2>
      <p className="small muted">
        Select a machine to manage its runtimes, connectors, services and skills. Your other
        machines stay connected.
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
              {saved && saved.name !== 'local' && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={node.status === 'installing'}
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
  const [provider, setProvider] = useState<Provider>('instabox');
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
      <div className="segmented" role="group" aria-label="Provider">
        <button
          type="button"
          aria-pressed={provider === 'instabox'}
          onClick={() => setProvider('instabox')}
        >
          instabox (recommended)
        </button>
        <button type="button" aria-pressed={provider === 'ssh'} onClick={() => setProvider('ssh')}>
          Any SSH host
        </button>
      </div>
      <p className="small muted">
        {provider === 'instabox'
          ? 'An instabox machine you are signed in to with the instabox CLI.'
          : 'A Linux VM from any provider that ssh on this computer reaches with a key (no password prompt), as in ~/.ssh/config.'}
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
          {busy ? 'Connecting and preparing…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
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
    fields?: Field[];
    note: string;
    save: (call: Call, v: Record<string, string>, server: string) => Promise<unknown>;
  }
> = {
  codex: {
    name: 'Codex',
    note: 'Imports the ChatGPT login of the server machine. Run codex login there first.',
    save: (call, _, server) =>
      call('setup.importCodex').catch((err: unknown) => {
        throw new Error(codexLoginHelp(message(err), server) ?? message(err));
      }),
  },
  claude: {
    name: 'Claude Code',
    fields: [
      {
        key: 'token',
        label: 'Token or API key',
        secret: true,
        placeholder: 'from claude setup-token, or an Anthropic API key',
      },
    ],
    note: 'Stored in the vault on the server, never shown again.',
    save: (call, v) => call('setup.importClaude', { token: v.token! }),
  },
  hermes: {
    name: 'Hermes',
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
    <section className="card">
      <h2>
        Runtimes <span className="small muted normal">· on {server}</span>
      </h2>
      <div className="grid3">
        {(Object.keys(RUNTIMES) as RuntimeId[]).map((id) => {
          const rt = RUNTIMES[id];
          const { ok, detail } = runtimeState(status, id);
          return (
            <div key={id} className="runtime">
              <div className="row between">
                <span className="strong">{rt.name}</span>
                <span className={`tag ${ok ? 'tag-ok' : 'tag-off'}`}>
                  {ok ? 'Connected' : 'Not set up'}
                </span>
              </div>
              <span className="small muted">{sanitizeLine(detail)}</span>
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
                {open === id ? 'Cancel' : ok ? 'Replace' : 'Set up'}
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

function ProxyConnectors({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const { act, call } = useApp();
  const [editing, setEditing] = useState<TokenConnectorId | undefined>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const byId = new Map(status.connectors.map((c) => [c.id, c]));
  const close = (id: string) => {
    setEditing(undefined);
    buttons.current.get(id)?.focus();
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
              ) : tokenId ? (
                <button
                  type="button"
                  className="btn btn-small"
                  ref={(el) => void (el ? buttons.current.set(id, el) : buttons.current.delete(id))}
                  aria-expanded={editing === tokenId}
                  aria-controls={`connect-${id}`}
                  onClick={() => setEditing(editing === tokenId ? undefined : tokenId)}
                >
                  {editing === tokenId ? 'Cancel' : 'Connect'}
                </button>
              ) : (
                <span className="small muted">anchi setup connector aws</span>
              )}
            </div>
            {tokenId && editing === tokenId && (
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
            )}
          </div>
        );
      })}
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

export function Services({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
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
    <section className="card">
      <h2>
        Services <span className="small muted normal">· act for agents, writes auto or ask</span>
      </h2>
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
                  auto
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
                  ask
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
              <OAuthAppForm
                id={s.id}
                done={() => {
                  setEditing(undefined);
                  onChange();
                }}
                onCancel={() => close(s.id)}
              />
            )}
            {tokenLabel && editing === s.id && (
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
            )}
          </div>
        );
      })}
    </section>
  );
}
