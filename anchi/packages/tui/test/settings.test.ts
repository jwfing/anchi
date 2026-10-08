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
    skills: ['review', 'gone'],
    connectors: ['github'],
    workspaces: [{ path: 'docs', mode: 'ro', name: 'notes' }],
  },
  inventory: {
    skills: [{ id: 'review', name: 'review', description: 'Reviews' }],
    connectors: [],
    workspaces: { shared: false, dirs: ['docs', 'web'] },
    agents: [],
    images: [],
  },
};

describe('settings panel', () => {
  it('lists what exists, what is selected and what is missing', () => {
    const rows = settingsRows(data, initialSettings(data));
    const items = rows.filter((r) => r.kind !== 'header');
    expect(items.map((r) => `${r.mark} ${r.id} ${r.note}`)).toEqual([
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
});
