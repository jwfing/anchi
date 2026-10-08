import type { AgentPatch, AgentSettings, WorkspaceSetting } from '@anchi/protocol';

/** Connectors in the order the panel shows them, also when the VM could not be asked. */
const CONNECTORS = ['github', 'aws', 'linear', 'gmail', 'drive', 'notion', 'slack'];

/** What the panel has selected. */
export interface SettingsState {
  skills: string[];
  connectors: string[];
  workspaces: WorkspaceSetting[];
}

export type SettingsRow =
  | { kind: 'header'; text: string }
  | {
      kind: 'skill' | 'connector' | 'workspace';
      id: string;
      label: string;
      mark: string;
      note: string;
    };

export const initialSettings = (data: AgentSettings): SettingsState => ({
  skills: [...data.current.skills],
  connectors: [...data.current.connectors],
  workspaces: data.current.workspaces.map((w) => ({ ...w })),
});

/** Rows of the panel: every available item, plus selected ones that no longer exist. */
export function settingsRows(data: AgentSettings, state: SettingsState): SettingsRow[] {
  const inv = data.inventory;
  const rows: SettingsRow[] = [{ kind: 'header', text: 'SKILLS' }];
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
    text: `WORKSPACES (~/AnchiWorkspaces)${inv.workspaces.shared === false ? ' · not shared with the VM yet: Runtimes, W' : ''}`,
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
          ? 'writes go straight to your Mac'
          : '',
    });
  }
  return rows;
}

/** Space on a row: skills and connectors switch on and off; workspaces go off → ro → rw → off. */
export function toggleSetting(state: SettingsState, row: SettingsRow): SettingsState {
  if (row.kind === 'header') return state;
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
  const patch: AgentPatch = {};
  if (!same(sorted(state.skills), sorted(data.current.skills))) patch.skills = state.skills;
  if (!same(sorted(state.connectors), sorted(data.current.connectors))) {
    patch.connectors = CONNECTORS.filter((c) => state.connectors.includes(c));
  }
  if (!same(state.workspaces, data.current.workspaces)) patch.workspaces = state.workspaces;
  return patch;
}
