import type { AgentSettings } from '@anchi/protocol';
import { describe, expect, it } from 'vitest';
import {
  initialSettings,
  settingsPatch,
  settingsRows,
  toggleSetting,
} from '../src/tui/settings.ts';

const data: AgentSettings = {
  agentId: 'dev',
  editable: true,
  current: {
    name: 'Dev',
    description: '',
    runtime: 'codex',
    model: 'gpt-5.5',
    effort: '',
    prompt: { mode: 'append', text: 'Be careful.\nTest first.\n' },
    skills: ['review', 'gone'],
    connectors: ['github'],
    workspaces: [{ path: 'docs', mode: 'ro', name: 'notes' }],
  },
  inherited: ['model'],
  fixed: {
    extends: 'base',
    image: 'codex',
    sandbox: 'cell',
    delegates: [],
    triggers: ['schedule 0 9 * * 1-5'],
    approvals: { github: 'ask' },
    egress: null,
  },
  inventory: {
    skills: [{ id: 'review', name: 'review', description: 'Reviews' }],
    connectors: [],
    workspaces: { shared: false, dirs: ['docs', 'web'] },
    runtimes: [
      { id: 'codex', connected: true },
      { id: 'claude-code', connected: false },
    ],
    agents: [],
    images: [],
  },
};

const items = (state: ReturnType<typeof initialSettings>) =>
  settingsRows(data, state).filter((r) => r.kind !== 'header');

describe('settings panel', () => {
  it('lists what exists, what is selected and what is missing', () => {
    const rows = settingsRows(data, initialSettings(data));
    const selectable = items(initialSettings(data)).filter((r) => r.kind !== 'field');
    expect(selectable.map((r) => `${r.mark} ${r.id} ${r.note}`)).toEqual([
      '[x] review Reviews',
      '[x] gone not installed',
      '[x] github ',
      '[ ] aws ',
      '[ ] linear ',
      '[ ] gmail ',
      '[ ] drive ',
      '[ ] notion ',
      '[ ] slack ',
      '[ro] docs ',
      '[  ] web ',
    ]);
    expect(rows.find((r) => r.kind === 'header' && r.text.startsWith('WORKSPACES'))).toMatchObject({
      text: expect.stringContaining('not shared with the VM yet'),
    });
  });

  it('toggles and sends only what changed, keeping workspace names', () => {
    let state = initialSettings(data);
    const row = (id: string) =>
      settingsRows(data, state).find((r) => r.kind !== 'header' && r.id === id)!;
    expect(settingsPatch(data, state)).toEqual({});
    state = toggleSetting(state, row('gone'));
    state = toggleSetting(state, row('docs')); // ro → rw
    state = toggleSetting(state, row('web')); // off → ro
    expect(settingsPatch(data, state)).toEqual({
      skills: ['review'],
      workspaces: [
        { path: 'docs', mode: 'rw', name: 'notes' },
        { path: 'web', mode: 'ro' },
      ],
    });
    state = toggleSetting(state, row('docs')); // rw → off
    state = toggleSetting(state, row('slack'));
    state = toggleSetting(state, row('aws'));
    expect(settingsPatch(data, state).connectors).toEqual(['github', 'aws', 'slack']);
    expect(settingsPatch(data, state).workspaces).toEqual([{ path: 'web', mode: 'ro' }]);
  });

  it('shows the agent settings, inherited values and the read-only rest', () => {
    const state = initialSettings(data);
    expect(
      items(state)
        .filter((r) => r.kind === 'field')
        .map((r) => `${r.id}: ${r.note}`),
    ).toEqual([
      'name: Dev',
      'description: (none)',
      'runtime: codex · connected',
      'model: gpt-5.5 · from template base',
      'effort: (runtime default)',
      "promptMode: append: after the runtime's own instructions",
      'prompt: 2 lines',
    ]);
    const text = settingsRows(data, state)
      .filter((r) => r.kind === 'header')
      .map((r) => (r.kind === 'header' ? r.text : ''));
    expect(text).toContain('    │ Be careful.');
    expect(text).toEqual(
      expect.arrayContaining([
        '  template    base',
        '  approvals   github: ask',
        '  egress      any public host',
        '  triggers    schedule 0 9 * * 1-5',
      ]),
    );
    const file = { ...data, fixed: { ...data.fixed, promptFile: 'p.md' } };
    expect(settingsRows(file, state).some((r) => r.kind === 'field' && r.id === 'prompt')).toBe(
      false,
    );
    expect(settingsPatch(file, { ...state, promptText: 'other' })).toEqual({});
  });

  it('cycles runtime, effort and prompt mode, and sends changed values only', () => {
    let state = initialSettings(data);
    const row = (id: string) => items(state).find((r) => r.id === id)!;
    state = toggleSetting(state, row('runtime'));
    expect(row('runtime').note).toBe('claude-code · not connected yet: Runtimes');
    expect(row('runtime').mark).toBe('*');
    state = toggleSetting(state, row('effort'));
    state = toggleSetting(state, row('effort'));
    expect(row('effort').note).toBe('medium · codex only: claude-code ignores it');
    state = toggleSetting(state, row('promptMode'));
    state = {
      ...state,
      model: '',
      name: ' Developer ',
      promptText: 'Be careful.\nTest first.\n\n',
    };
    expect(settingsPatch(data, state)).toEqual({
      name: 'Developer',
      runtime: 'claude-code',
      model: '',
      effort: 'medium',
      prompt: { mode: 'replace' },
    });
    state = toggleSetting(state, row('runtime'));
    for (const _ of [1, 2, 3]) state = toggleSetting(state, row('effort')); // → high → xhigh → unset
    expect(state.effort).toBe('');
    expect(settingsPatch(data, { ...state, promptText: 'New.' }).prompt).toEqual({
      mode: 'replace',
      text: 'New.',
    });
  });
});
