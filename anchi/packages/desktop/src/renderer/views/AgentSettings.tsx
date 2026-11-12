import { sanitizeLine } from '@anchi/core/sanitize';
import type {
  AgentPatch,
  AgentSettings,
  AgentSettingValues,
  AgentUpdate,
  Effort,
  RuntimeId,
  WorkspaceSetting,
} from '@anchi/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import { ConnectorLogo, connectorName } from '../logos.tsx';
import { plainWords } from '../access.ts';
import { accountName, Icon, runtimeName } from '../ui.tsx';
import { Diff } from './Builder.tsx';
import { DeleteAgentAction } from './DeleteAgent.tsx';

const EFFORTS: (Effort | '')[] = ['', 'low', 'medium', 'high', 'xhigh'];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `draft` that differ from `current`, as `agents.update` takes them. */
export function settingsPatch(current: AgentSettingValues, draft: AgentSettingValues): AgentPatch {
  const patch: AgentPatch = {};
  for (const key of Object.keys(draft) as (keyof AgentSettingValues)[]) {
    if (!same(current[key], draft[key])) Object.assign(patch, { [key]: draft[key] });
  }
  return patch;
}

/** An agent's editable settings: edit, review the change to its file, apply. */
/**
 * `access` shows what the agent can reach (connections, folders, teammates) beside the same
 * settings in plain words; `advanced` shows the rest. Both edit one draft, so a change made in
 * one is still there in the other, and is reviewed and applied the same way.
 */
export function AgentSettingsView({
  agentId,
  part,
}: {
  agentId: string;
  part: 'access' | 'advanced';
}) {
  const { act, server, call } = useApp();
  const [settings, setSettings] = useState<AgentSettings>();
  const [draft, setDraft] = useState<AgentSettingValues>();
  const [review, setReview] = useState<AgentUpdate>();

  const load = useCallback(() => {
    void act(() => call('agents.settings', { agentId })).then((s) => {
      if (!s) return;
      setSettings(s);
      setDraft(s.current);
      setReview(undefined);
    });
  }, [act, agentId, call]);
  useEffect(() => {
    if (server.status === 'connected') load();
  }, [server.status, load]);

  if (!settings || !draft) return <div className="scroll settings-form muted">Loading…</div>;
  const { current, fixed, inventory, inherited } = settings;
  // A daemon older than per-agent high-risk exemptions sends neither field.
  const highRiskIds = inventory.highRisk ?? [];
  const exempt = draft.highRisk?.disable ?? [];
  const patch = settingsPatch(current, draft);
  const changed = Object.keys(patch).length > 0;
  const edit = (next: Partial<AgentSettingValues>) => {
    setDraft({ ...draft, ...next });
    setReview(undefined);
  };
  const from = (key: keyof AgentSettingValues) =>
    inherited.includes(key) && same(current[key], draft[key]) ? (
      <span className="small muted normal"> · from {fixed.extends ?? 'the template'}</span>
    ) : null;
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  if (!settings.editable) {
    return (
      <div className="scroll settings-form">
        <div className="banner">
          These settings cannot be changed here
          {settings.reason ? `: ${sanitizeLine(settings.reason)}` : '.'}
        </div>
        <DeleteAgentAction agentId={agentId} />
      </div>
    );
  }

  const access = part === 'access';
  const words = plainWords(draft, fixed, connectorName);
  const pending = Object.keys(patch).length;

  return (
    <div className="agent-settings">
      <div className="scroll settings-form">
        {fixed.execution && (
          <section className="card">
            <h2>Runs on another machine</h2>
            <p>
              @{sanitizeLine(agentId)} runs as @{sanitizeLine(fixed.execution.agent)} on{' '}
              <strong>{sanitizeLine(fixed.execution.server)}</strong>.
            </p>
            <p>
              Manage its AI account, instructions, connections, skills, folders and security policy
              on that machine. Its credentials stay there.
            </p>
            <p>That machine’s agent must also be allowed the teammates selected here.</p>
            <p className="small muted">
              Use New agent to change this member’s name, description or machine. Existing tasks
              keep their original machine.
            </p>
          </section>
        )}

        {access && (
          <div className="access-grid">
            <div className="col gap-m">
              {!fixed.execution && (
                <>
                  <section className="card">
                    <h2>Connections{from('connectors')}</h2>
                    <p className="small muted">
                      Accounts this agent may act through. It never sees the password or token.
                    </p>
                    {inventory.connectors.map((c) => (
                      <label key={c.id} className="check-row">
                        <input
                          type="checkbox"
                          checked={draft.connectors.includes(c.id)}
                          onChange={() => edit({ connectors: toggle(draft.connectors, c.id) })}
                        />
                        <ConnectorLogo id={c.id} />
                        <span className="strong">{connectorName(c.id)}</span>
                        <span className="small muted">
                          {c.connected === false
                            ? 'not connected yet: connect it in Settings'
                            : fixed.approvals[c.id] === 'ask'
                              ? 'writes wait for you'
                              : ''}
                        </span>
                      </label>
                    ))}
                  </section>

                  <Workspaces
                    value={draft.workspaces}
                    dirs={inventory.workspaces.dirs}
                    shared={inventory.workspaces.shared}
                    label={from('workspaces')}
                    onChange={(workspaces) => edit({ workspaces })}
                  />
                </>
              )}

              <section className="card">
                <h2>Teammates{from('delegates')}</h2>
                <p className="small muted">
                  Agents @{sanitizeLine(agentId)} may hand work to on {sanitizeLine(server.label)}.
                  Handing off never passes its own access along: each teammate keeps its own.
                </p>
                <DelegationChoices
                  agentId={agentId}
                  agents={inventory.agents}
                  labels={Object.fromEntries(
                    (inventory.peerAgents ?? []).map((a) => [
                      a.id,
                      `@${a.id.split('/')[1]} · ${a.machine}${a.online ? '' : ' (offline)'}`,
                    ]),
                  )}
                  value={draft.delegates}
                  legacy={fixed.delegates}
                  onChange={(delegates) => edit({ delegates })}
                />
              </section>

              {!fixed.execution && highRiskIds.length > 0 && (
                <section className="card">
                  <h2>Without asking{from('highRisk')}</h2>
                  <p className="small muted">
                    These operations wait for your approval. Tick one to let this agent do it
                    without asking; Anchi confirms that in a system dialog.
                  </p>
                  {highRiskIds.map((id) => {
                    const global = fixed.highRiskGlobal?.includes(id);
                    return (
                      <label key={id} className="check-row">
                        <input
                          type="checkbox"
                          checked={global || exempt.includes(id)}
                          disabled={global}
                          onChange={() => edit({ highRisk: { disable: toggle(exempt, id) } })}
                        />
                        <span className="mono">{id}</span>
                        <span className="small muted">
                          {global ? 'without asking for every agent (settings.yaml)' : ''}
                        </span>
                      </label>
                    );
                  })}
                </section>
              )}
            </div>

            {!fixed.execution && (
              <aside className="plain-words" aria-label="In plain words">
                <span className="row gap-s strong">
                  <Icon name="shield" size={16} /> In plain words
                </span>
                {words.map((w) => (
                  <span key={w.text} className={`plain-line ${w.warn ? 'plain-warn' : ''}`}>
                    <Icon name={w.can ? 'check' : 'x'} size={14} className={w.can ? 'yes' : 'no'} />
                    <span>{w.text}</span>
                  </span>
                ))}
                <span className="small muted">
                  Follows what is selected on the left, before you save.
                </span>
              </aside>
            )}
          </div>
        )}

        {!access && !fixed.execution && (
          <>
            <section className="card">
              <h2>Name</h2>
              <div className="grid2">
                <label className="field">
                  <span className="small strong">Name{from('name')}</span>
                  <input value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
                </label>
                <label className="field">
                  <span className="small strong">Description{from('description')}</span>
                  <input
                    value={draft.description}
                    onChange={(e) => edit({ description: e.target.value })}
                  />
                </label>
              </div>
            </section>

            <section className="card">
              <h2>AI account and model</h2>
              <div className="grid3">
                <label className="field">
                  <span className="small strong">Account{from('runtime')}</span>
                  <select
                    value={draft.runtime}
                    onChange={(e) => edit({ runtime: e.target.value as RuntimeId })}
                  >
                    {inventory.runtimes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {accountName(r.id)} ({runtimeName(r.id)})
                        {r.connected === false ? ' · not set up' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="small strong">Model{from('model')}</span>
                  <input
                    value={draft.model}
                    placeholder="the account's default"
                    spellCheck={false}
                    onChange={(e) => edit({ model: e.target.value.trim() })}
                  />
                </label>
                <label className="field">
                  <span className="small strong">Thinking effort{from('effort')}</span>
                  <select
                    value={draft.effort}
                    onChange={(e) => edit({ effort: e.target.value as Effort | '' })}
                  >
                    {EFFORTS.map((e) => (
                      <option key={e} value={e}>
                        {e || "the account's default"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="card">
              <h2>Instructions{from('prompt')}</h2>
              {fixed.promptFile ? (
                <p className="small muted">
                  The instructions come from {sanitizeLine(fixed.promptFile)}. Edit that file to
                  change them.
                </p>
              ) : (
                <>
                  <div className="segmented" role="group" aria-label="Prompt mode">
                    {(['append', 'replace'] as const).map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        aria-pressed={draft.prompt.mode === mode}
                        onClick={() => edit({ prompt: { ...draft.prompt, mode } })}
                      >
                        {mode === 'append' ? 'Add to the template' : 'Replace the template'}
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    <span className="sr-only">Instructions</span>
                    <textarea
                      className="prompt-edit"
                      rows={8}
                      value={draft.prompt.text}
                      onChange={(e) => edit({ prompt: { ...draft.prompt, text: e.target.value } })}
                    />
                  </label>
                </>
              )}
            </section>

            <section className="card">
              <h2>Skills{from('skills')}</h2>
              {!inventory.skills.length && (
                <p className="small muted">No skills installed. Add them in Settings → Skills.</p>
              )}
              {inventory.skills.map((s) => (
                <label key={s.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.skills.includes(s.id)}
                    onChange={() => edit({ skills: toggle(draft.skills, s.id) })}
                  />
                  <span className="strong">{sanitizeLine(s.id)}</span>
                  <span className="small muted ellipsis">{sanitizeLine(s.description)}</span>
                </label>
              ))}
              {draft.skills
                .filter((id) => !inventory.skills.some((s) => s.id === id))
                .map((id) => (
                  <div key={id} className="small tone-bad">
                    {sanitizeLine(id)} is not installed
                  </div>
                ))}
            </section>

            <section className="card">
              <h2>
                Set in the agent file <span className="small muted normal">· read-only here</span>
              </h2>
              <dl className="facts">
                <dt>Schedules</dt>
                <dd>
                  {fixed.triggers.length ? fixed.triggers.map(sanitizeLine).join(' · ') : 'none'}
                </dd>
                <dt>Websites</dt>
                <dd>
                  {fixed.egress === null
                    ? 'any public website'
                    : fixed.egress.map(sanitizeLine).join(', ') || 'none'}
                </dd>
                <dt>Asks first</dt>
                <dd>
                  {Object.entries(fixed.approvals)
                    .map(([k, v]) => `${sanitizeLine(k)}: ${sanitizeLine(v)}`)
                    .join(' · ') || 'the defaults'}
                </dd>
                {fixed.extends && (
                  <>
                    <dt>Template</dt>
                    <dd>{sanitizeLine(fixed.extends)}</dd>
                  </>
                )}
                <dt>Image</dt>
                <dd>{sanitizeLine(fixed.image)}</dd>
                <dt>Sandbox</dt>
                <dd>{sanitizeLine(fixed.sandbox)}</dd>
              </dl>
              <p className="small muted">
                Change these in the agent file, or ask the builder under New agent.
              </p>
            </section>
          </>
        )}

        {review && (
          <section
            className="card review"
            aria-label="Review the change"
            ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
          >
            <div className="trusted">
              <Icon name="shield" size={14} /> Drawn by Anchi from the agent file it would write.
            </div>
            {review.diff ? <Diff text={review.diff} /> : <p className="small muted">No change.</p>}
            {review.errors.map((e, i) => (
              <div key={i} className="banner banner-error">
                Cannot apply: {sanitizeLine(e)}
              </div>
            ))}
            {review.warnings.map((w, i) => (
              <div key={i} className="banner banner-warn">
                ! {sanitizeLine(w)}
              </div>
            ))}
          </section>
        )}
        {!access && <DeleteAgentAction agentId={agentId} />}
      </div>
      <div className="save-bar">
        <span className={`dot ${changed ? 'dot-approval' : 'dot-off'}`} />
        <span className="strong">
          {changed ? `${pending} ${pending === 1 ? 'change' : 'changes'} not saved` : 'No changes'}
        </span>
        <span className="small muted grow">
          New access is confirmed in a system dialog before it is saved.
        </span>
        <button
          type="button"
          className="btn"
          disabled={!changed}
          onClick={() => {
            setDraft(current);
            setReview(undefined);
          }}
        >
          Discard changes
        </button>
        {review ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={review.errors.length > 0 || !review.diff}
            onClick={async () => {
              const done = await act(
                () => call('agents.update', { agentId, patch, apply: true, base: review.base }),
                `@${agentId} saved`,
              );
              if (done?.applied) load();
            }}
          >
            Apply
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!changed}
            onClick={() =>
              void act(() => call('agents.update', { agentId, patch })).then(
                (r) => r && setReview(r),
              )
            }
          >
            Review changes
          </button>
        )}
      </div>
    </div>
  );
}

export function DelegationChoices({
  agentId,
  agents,
  labels = {},
  value,
  legacy,
  onChange,
}: {
  agentId: string;
  agents: string[];
  labels?: Record<string, string>;
  value: string[] | undefined;
  legacy: string[];
  onChange(value: string[]): void;
}) {
  if (value === undefined)
    return (
      <p className="small muted">
        Delegates to: {legacy.map((id) => `@${sanitizeLine(id)}`).join(', ') || 'none'}. Update this
        machine’s daemon to edit delegation here.
      </p>
    );
  const choices = [...new Set([...agents, ...value])].filter((id) => id !== agentId);
  if (!choices.length)
    return (
      <p className="small muted">
        Create another agent or join a peer machine to delegate work to it.
      </p>
    );
  return (
    <>
      {choices.map((id) => {
        const checked = value.includes(id);
        return (
          <label key={id} className="check-row">
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && value.length >= 50}
              onChange={() => onChange(checked ? value.filter((d) => d !== id) : [...value, id])}
            />
            <span className="strong">{sanitizeLine(labels[id] ?? `@${id}`)}</span>
            {!agents.includes(id) && (
              <span className="small tone-warn">unavailable team member</span>
            )}
          </label>
        );
      })}
    </>
  );
}

function Workspaces({
  value,
  dirs,
  shared,
  label,
  onChange,
}: {
  value: WorkspaceSetting[];
  dirs: string[];
  shared: boolean | null;
  label: React.ReactNode;
  onChange: (next: WorkspaceSetting[]) => void;
}) {
  const unused = dirs.filter((d) => !value.some((w) => w.path === d));
  return (
    <section className="card">
      <h2>Folders on this machine{label}</h2>
      <p className="small muted">
        The agent sees only the folders under ~/AnchiWorkspaces that you share here. Everything else
        stays invisible to it.
        {shared === false ? ' The secure room does not share them yet.' : ''}
      </p>
      {value.map((w, i) => (
        <div key={w.path} className="check-row">
          <span className="mono grow ellipsis">{sanitizeLine(w.path)}</span>
          <div className="segmented" role="group" aria-label={`${w.path} access`}>
            {(['ro', 'rw'] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                aria-pressed={w.mode === mode}
                onClick={() => onChange(value.map((x, j) => (j === i ? { ...x, mode } : x)))}
              >
                {mode === 'ro' ? 'Read only' : 'Read and change'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      {unused.length > 0 && (
        <label className="field">
          <span className="sr-only">Share a folder</span>
          <select
            value=""
            onChange={(e) =>
              e.target.value && onChange([...value, { path: e.target.value, mode: 'ro' }])
            }
          >
            <option value="">Share a folder…</option>
            {unused.map((d) => (
              <option key={d} value={d}>
                {sanitizeLine(d)}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
