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
import { call } from '../api.ts';
import { ConnectorLogo, connectorName } from '../logos.tsx';
import { Icon } from '../ui.tsx';
import { Diff } from './Builder.tsx';

const RUNTIME_NAMES: Record<RuntimeId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes',
};
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
export function AgentSettingsView({ agentId }: { agentId: string }) {
  const { act, server } = useApp();
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
  }, [act, agentId]);
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
      </div>
    );
  }

  return (
    <div className="scroll settings-form">
      <section className="card">
        <h2>Agent</h2>
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
        <h2>Runtime and model</h2>
        <div className="grid3">
          <label className="field">
            <span className="small strong">Runtime{from('runtime')}</span>
            <select
              value={draft.runtime}
              onChange={(e) => edit({ runtime: e.target.value as RuntimeId })}
            >
              {inventory.runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {RUNTIME_NAMES[r.id] ?? r.id}
                  {r.connected === false ? ' (not set up)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="small strong">Model{from('model')}</span>
            <input
              value={draft.model}
              placeholder="the runtime's default"
              spellCheck={false}
              onChange={(e) => edit({ model: e.target.value.trim() })}
            />
          </label>
          <label className="field">
            <span className="small strong">Reasoning effort{from('effort')}</span>
            <select
              value={draft.effort}
              onChange={(e) => edit({ effort: e.target.value as Effort | '' })}
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e || "the runtime's default"}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>System prompt{from('prompt')}</h2>
        {fixed.promptFile ? (
          <p className="small muted">
            The prompt comes from {sanitizeLine(fixed.promptFile)}. Edit that file to change it.
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
              <span className="sr-only">Prompt</span>
              <textarea
                className="prompt-edit"
                rows={10}
                value={draft.prompt.text}
                onChange={(e) => edit({ prompt: { ...draft.prompt, text: e.target.value } })}
              />
            </label>
          </>
        )}
      </section>

      <div className="grid2">
        <section className="card">
          <h2>Skills{from('skills')}</h2>
          {!inventory.skills.length && <p className="small muted">No skills installed.</p>}
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
          <h2>Connectors{from('connectors')}</h2>
          <p className="small muted">Credentials this agent's tasks may use.</p>
          {inventory.connectors.map((c) => (
            <label key={c.id} className="check-row">
              <input
                type="checkbox"
                checked={draft.connectors.includes(c.id)}
                onChange={() => edit({ connectors: toggle(draft.connectors, c.id) })}
              />
              <ConnectorLogo id={c.id} />
              <span className="strong">{connectorName(c.id)}</span>
              <span className="small muted">{c.connected === false ? 'not connected' : ''}</span>
            </label>
          ))}
        </section>
      </div>

      <Workspaces
        value={draft.workspaces}
        dirs={inventory.workspaces.dirs}
        shared={inventory.workspaces.shared}
        label={from('workspaces')}
        onChange={(workspaces) => edit({ workspaces })}
      />

      {highRiskIds.length > 0 && (
        <section className="card">
          <h2>High-risk operations{from('highRisk')}</h2>
          <p className="small muted">
            These wait for your approval. Tick one to let this agent's tasks do it without asking.
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

      <section className="card">
        <h2>
          Set in the agent file <span className="small muted normal">· read-only here</span>
        </h2>
        <dl className="facts">
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
          <dt>Delegates to</dt>
          <dd>{fixed.delegates.length ? fixed.delegates.map((d) => '@' + d).join(', ') : '—'}</dd>
          <dt>Triggers</dt>
          <dd>{fixed.triggers.length ? fixed.triggers.map(sanitizeLine).join(' · ') : '—'}</dd>
          <dt>Approvals</dt>
          <dd>
            {Object.entries(fixed.approvals)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ') || 'defaults'}
          </dd>
          <dt>Egress</dt>
          <dd>{fixed.egress === null ? 'any public host' : fixed.egress.join(', ') || 'none'}</dd>
        </dl>
      </section>

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
      <div className="settings-actions">
        <div className="row gap">
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
        </div>
      </div>
    </div>
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
      <h2>Workspaces{label}</h2>
      <p className="small muted">
        Directories under ~/AnchiWorkspaces this agent's tasks see.
        {shared === false ? ' The VM does not share them yet.' : ''}
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
                {mode === 'ro' ? 'read' : 'read-write'}
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
          <span className="sr-only">Add a workspace</span>
          <select
            value=""
            onChange={(e) =>
              e.target.value && onChange([...value, { path: e.target.value, mode: 'ro' }])
            }
          >
            <option value="">Add a directory…</option>
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
