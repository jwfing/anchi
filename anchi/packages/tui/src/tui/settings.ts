import type {
  AgentPatch,
  AgentSettings,
  AgentSettingValues,
  Effort,
  WorkspaceSetting,
} from '@anchi/protocol';

/** Connectors in the order the panel shows them, also when the VM could not be asked. */
const CONNECTORS = ['github', 'aws', 'linear', 'gmail', 'drive', 'notion', 'slack'];
const RUNTIMES = ['codex', 'claude-code'] as const;
const EFFORTS: (Effort | '')[] = ['', 'low', 'medium', 'high', 'xhigh'];

/** What the panel has selected. */
export interface SettingsState {
  name: string;
  description: string;
  runtime: AgentSettingValues['runtime'];
  model: string;
  effort: Effort | '';
  promptMode: 'append' | 'replace';
  promptText: string;
  skills: string[];
  connectors: string[];
  workspaces: WorkspaceSetting[];
}

/** Single values: typed in the panel, switched with Space, or (the prompt) edited in $EDITOR. */
export type FieldId =
  'name' | 'description' | 'runtime' | 'model' | 'effort' | 'promptMode' | 'prompt';
export type TextField = 'name' | 'description' | 'model';
/** Fields typed in the panel, with their limits. */
export const TEXT_FIELDS: Record<TextField, number> = { name: 100, description: 500, model: 80 };
export const isTextField = (id: string): id is TextField => Object.hasOwn(TEXT_FIELDS, id);
export const MODEL = /^[a-zA-Z0-9._-]{0,80}$/;

export type SettingsRow =
  | { kind: 'header'; text: string }
  | {
      kind: 'field' | 'skill' | 'connector' | 'workspace';
      id: string;
      label: string;
      mark: string;
      note: string;
    };

export const initialSettings = (data: AgentSettings): SettingsState => ({
  name: data.current.name,
  description: data.current.description,
  runtime: data.current.runtime,
  model: data.current.model,
  effort: data.current.effort,
  promptMode: data.current.prompt.mode,
  promptText: data.current.prompt.text,
  skills: [...data.current.skills],
  connectors: [...data.current.connectors],
  workspaces: data.current.workspaces.map((w) => ({ ...w })),
});

/** The prompt as compared and saved: one trailing newline when it has several lines. */
export const promptText = (text: string) => {
  const t = text.replace(/\s+$/, '');
  return t.includes('\n') ? `${t}\n` : t;
};

/** Rows of the panel: the agent's own settings, every available item, then what it cannot edit. */
export function settingsRows(data: AgentSettings, state: SettingsState): SettingsRow[] {
  const inv = data.inventory;
  const cur = data.current;
  const from = data.fixed.extends ? ` · from template ${data.fixed.extends}` : '';
  const inherited = (k: keyof AgentSettingValues, changed: boolean) =>
    !changed && data.inherited.includes(k) ? from : '';
  const field = (id: FieldId, label: string, changed: boolean, note: string): SettingsRow => ({
    kind: 'field',
    id,
    label,
    mark: changed ? '*' : '',
    note,
  });
  const runtime = inv.runtimes.find((r) => r.id === state.runtime)?.connected;
  const rows: SettingsRow[] = [
    { kind: 'header', text: 'GENERAL' },
    field(
      'name',
      'name',
      state.name !== cur.name,
      `${state.name || data.agentId}${inherited('name', state.name !== cur.name)}`,
    ),
    field(
      'description',
      'description',
      state.description !== cur.description,
      `${state.description || '(none)'}${inherited('description', state.description !== cur.description)}`,
    ),
    field(
      'runtime',
      'runtime',
      state.runtime !== cur.runtime,
      `${state.runtime}${runtime === true ? ' · connected' : runtime === false ? ' · not connected yet: Runtimes' : ''}${inherited('runtime', state.runtime !== cur.runtime)}`,
    ),
    field(
      'model',
      'model',
      state.model !== cur.model,
      `${state.model || '(runtime default)'}${inherited('model', state.model !== cur.model)}`,
    ),
    field(
      'effort',
      'effort',
      state.effort !== cur.effort,
      `${state.effort || '(runtime default)'}${state.runtime === 'codex' ? '' : ' · codex only: claude-code ignores it'}${inherited('effort', state.effort !== cur.effort)}`,
    ),
  ];
  const lines = state.promptText ? state.promptText.replace(/\n$/, '').split('\n') : [];
  if (data.fixed.promptFile) {
    rows.push({ kind: 'header', text: `PROMPT · from ${data.fixed.promptFile} (edit that file)` });
  } else {
    const changed =
      state.promptMode !== cur.prompt.mode ||
      promptText(state.promptText) !== promptText(cur.prompt.text);
    rows.push(
      { kind: 'header', text: 'PROMPT' },
      field(
        'promptMode',
        'mode',
        state.promptMode !== cur.prompt.mode,
        `${state.promptMode === 'append' ? "append: after the runtime's own instructions" : "replace: instead of the runtime's own instructions"}${inherited('prompt', changed)}`,
      ),
      field(
        'prompt',
        'text ($EDITOR)',
        promptText(state.promptText) !== promptText(cur.prompt.text),
        lines.length
          ? `${lines.length} line${lines.length === 1 ? '' : 's'}${inherited('prompt', changed)}`
          : '(empty)',
      ),
    );
  }
  for (const l of lines.slice(0, 3)) rows.push({ kind: 'header', text: `    │ ${l}` });
  if (lines.length > 3) rows.push({ kind: 'header', text: `    │ … ${lines.length - 3} more` });
  rows.push({ kind: 'header', text: 'SKILLS' });
  const skills = [
    ...inv.skills,
    ...state.skills
      .filter((id) => !inv.skills.some((s) => s.id === id))
      .map((id) => ({ id, name: id, description: '' })),
  ];
  if (!skills.length)
    rows.push({ kind: 'header', text: '  none installed: Configure › Skills, a' });
  for (const s of skills) {
    const missing = !inv.skills.some((x) => x.id === s.id);
    rows.push({
      kind: 'skill',
      id: s.id,
      label: s.id,
      mark: state.skills.includes(s.id) ? '[x]' : '[ ]',
      note: missing ? 'not installed' : s.description || s.name,
    });
  }
  rows.push({ kind: 'header', text: 'CONNECTORS' });
  const known = new Map(inv.connectors.map((c) => [c.id, c.connected]));
  for (const id of CONNECTORS) {
    const connected = known.get(id);
    rows.push({
      kind: 'connector',
      id,
      label: id,
      mark: state.connectors.includes(id) ? '[x]' : '[ ]',
      note: connected === true ? 'connected' : connected === false ? 'not connected' : '',
    });
  }
  rows.push({
    kind: 'header',
    text: `WORKSPACES (~/AnchiWorkspaces; Space: off → ro → rw)${inv.workspaces.shared === false ? ' · not shared with the VM yet: Runtimes, W' : ''}`,
  });
  const dirs = [
    ...inv.workspaces.dirs,
    ...state.workspaces.map((w) => w.path).filter((p) => !inv.workspaces.dirs.includes(p)),
  ];
  if (!dirs.length) rows.push({ kind: 'header', text: '  no directories yet' });
  for (const path of dirs) {
    const w = state.workspaces.find((x) => x.path === path);
    rows.push({
      kind: 'workspace',
      id: path,
      label: path,
      mark: w ? (w.mode === 'rw' ? '[rw]' : '[ro]') : '[  ]',
      note: !inv.workspaces.dirs.includes(path)
        ? 'missing'
        : w?.mode === 'rw'
          ? 'writes go straight to your computer'
          : '',
    });
  }
  const f = data.fixed;
  const fixed = (label: string, value: string) =>
    rows.push({ kind: 'header', text: `  ${label.padEnd(12)}${value}` });
  rows.push({ kind: 'header', text: 'OTHER SETTINGS · change them in the agent file' });
  if (f.extends) fixed('template', f.extends);
  fixed('image', f.image);
  fixed('sandbox', f.sandbox);
  fixed('delegates', f.delegates.join(', ') || 'none');
  const approvals = Object.entries(f.approvals).map(([c, m]) => `${c}: ${m}`);
  fixed('approvals', approvals.join(', ') || 'none');
  fixed(
    'egress',
    f.egress ? f.egress.join(', ') || 'none (runtime and connectors only)' : 'any public host',
  );
  if (f.accounts) {
    const accounts = Object.entries(f.accounts).map(([c, a]) => `${c}: ${a}`);
    fixed('accounts', accounts.join(', '));
  }
  if (!f.triggers.length) fixed('triggers', 'none');
  f.triggers.forEach((t, i) => fixed(i ? '' : 'triggers', t));
  return rows;
}

/**
 * Space on a row: skills and connectors switch on and off; workspaces go off → ro → rw → off;
 * runtime, effort and prompt mode go to their next value. Text fields are typed in the panel.
 */
export function toggleSetting(state: SettingsState, row: SettingsRow): SettingsState {
  if (row.kind === 'header') return state;
  if (row.kind === 'field') {
    const next = <T>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;
    if (row.id === 'runtime') return { ...state, runtime: next(RUNTIMES, state.runtime) };
    if (row.id === 'effort') return { ...state, effort: next(EFFORTS, state.effort) };
    if (row.id === 'promptMode') {
      return { ...state, promptMode: state.promptMode === 'append' ? 'replace' : 'append' };
    }
    return state;
  }
  const flip = (list: string[]) =>
    list.includes(row.id) ? list.filter((x) => x !== row.id) : [...list, row.id];
  if (row.kind === 'skill') return { ...state, skills: flip(state.skills) };
  if (row.kind === 'connector') return { ...state, connectors: flip(state.connectors) };
  const w = state.workspaces.find((x) => x.path === row.id);
  if (!w) return { ...state, workspaces: [...state.workspaces, { path: row.id, mode: 'ro' }] };
  if (w.mode === 'ro') {
    return {
      ...state,
      workspaces: state.workspaces.map((x) => (x.path === row.id ? { ...x, mode: 'rw' } : x)),
    };
  }
  return { ...state, workspaces: state.workspaces.filter((x) => x.path !== row.id) };
}

/** Only the fields that changed, so untouched parts of the file keep their formatting. */
export function settingsPatch(data: AgentSettings, state: SettingsState): AgentPatch {
  const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);
  const sorted = (l: string[]) => [...l].sort();
  const cur = data.current;
  const patch: AgentPatch = {};
  if (state.name.trim() !== cur.name) patch.name = state.name.trim();
  if (state.description.trim() !== cur.description) patch.description = state.description.trim();
  if (state.runtime !== cur.runtime) patch.runtime = state.runtime;
  if (state.model.trim() !== cur.model) patch.model = state.model.trim();
  if (state.effort !== cur.effort) patch.effort = state.effort;
  if (!data.fixed.promptFile) {
    const prompt: AgentPatch['prompt'] = {};
    if (state.promptMode !== cur.prompt.mode) prompt.mode = state.promptMode;
    const text = promptText(state.promptText);
    if (text !== promptText(cur.prompt.text)) prompt.text = text;
    if (Object.keys(prompt).length) patch.prompt = prompt;
  }
  if (!same(sorted(state.skills), sorted(data.current.skills))) patch.skills = state.skills;
  if (!same(sorted(state.connectors), sorted(data.current.connectors))) {
    patch.connectors = CONNECTORS.filter((c) => state.connectors.includes(c));
  }
  if (!same(state.workspaces, data.current.workspaces)) patch.workspaces = state.workspaces;
  return patch;
}
