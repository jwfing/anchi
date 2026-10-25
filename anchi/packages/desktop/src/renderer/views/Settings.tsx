import { sanitizeLine } from '@anchi/core/sanitize';
import {
  CONNECTOR_IDS,
  type ConnectorId,
  type ServiceConnectorId,
  type SetupStatus,
  type SkillAddResult,
  type SkillInfo,
  type SkillUpdate,
  TOKEN_CONNECTOR_IDS,
  type TokenConnectorId,
} from '@anchi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
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
          <Runtimes status={status} server={server.name} onChange={refresh} />
          <div className="grid2">
            <ProxyConnectors status={status} onChange={refresh} />
            <Services status={status} onChange={refresh} />
          </div>
        </>
      )}
      <Skills skills={skills} local={server.name === 'local'} onChange={refresh} />
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
  const { act } = useApp();
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
            onClick={() => void act(() => window.anchi.addSkillFolder()).then(added)}
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
  note: string;
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

/** How each runtime is set up from here: its host login imported, or a form. */
const RUNTIMES: Record<
  RuntimeId,
  {
    name: string;
    fields?: Field[];
    note: string;
    save: (v: Record<string, string>) => Promise<unknown>;
  }
> = {
  codex: {
    name: 'Codex',
    note: 'Imports the ChatGPT login of the server machine. Run codex login there first.',
    save: () => call('setup.importCodex'),
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
    save: (v) => call('setup.importClaude', { token: v.token! }),
  },
  hermes: {
    name: 'Hermes',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://openrouter.ai/api/v1' },
      { key: 'model', label: 'Model', placeholder: "the endpoint's model id" },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
    note: 'Any OpenAI-compatible endpoint. The key is stored in the vault on the server.',
    save: (v) =>
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
  const { act } = useApp();
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
                  void act(() => rt.save({}), `${rt.name} connected`).then((r) => r && onChange());
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
                    await rt.save(v);
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

function ProxyConnectors({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const { act } = useApp();
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
                note="Stored in the vault on the server, never shown again."
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
