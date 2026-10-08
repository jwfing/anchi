import { describe, expect, it } from 'vitest';
import {
  buildKeyMap,
  continuations,
  DEFAULT_KEYMAP,
  keyLabel,
  keysFor,
  parseSequence,
  parseStroke,
  resolve,
  splitChunk,
  strokeOf,
} from '../src/tui/keys.ts';

describe('keystrokes', () => {
  it('names what Ink reports', () => {
    expect(strokeOf('x', { ctrl: true })).toBe('ctrl+x');
    expect(strokeOf('X', { ctrl: true, shift: true })).toBe('ctrl+x');
    expect(strokeOf('b', { meta: true })).toBe('alt+b');
    expect(strokeOf('', { escape: true })).toBe('esc');
    expect(strokeOf('', { tab: true, shift: true })).toBe('shift+tab');
    expect(strokeOf('', { upArrow: true })).toBe('up');
    expect(strokeOf('', { delete: true })).toBe('backspace');
    expect(strokeOf('G', { shift: true })).toBe('G');
    expect(strokeOf(' ', {})).toBe('space');
    expect(strokeOf('的', {})).toBe('的');
    // Several characters in one chunk are text (paste, IME), not a key.
    expect(strokeOf('的错误', {})).toBeUndefined();
  });

  it('splits a chunk that mixes keys and text', () => {
    expect(splitChunk('\u0018q', {})).toEqual([
      ['x', { ctrl: true }],
      ['q', {}],
    ]);
    expect(splitChunk('ab\u0001c\r', {})).toEqual([
      ['ab', {}],
      ['a', { ctrl: true }],
      ['c\r', {}],
    ]);
    expect(splitChunk('x\u001bb\u001b', {})).toEqual([
      ['x', {}],
      ['b', { meta: true }],
      ['', { escape: true }],
    ]);
    expect(splitChunk('a\tb\u007f', {})).toEqual([
      ['a', {}],
      ['', { tab: true }],
      ['b', {}],
      ['', { backspace: true }],
    ]);
    // Plain text, CJK and a lone key are passed through untouched.
    expect(splitChunk('的错误\r', {})).toEqual([['的错误\r', {}]]);
    expect(splitChunk('x', { ctrl: true })).toEqual([['x', { ctrl: true }]]);
  });

  it('reads keys written in a config', () => {
    expect(parseStroke('Ctrl+X')).toBe('ctrl+x');
    expect(parseStroke('control+shift+X')).toBe('ctrl+shift+x');
    expect(parseStroke('shift+g')).toBe('G');
    expect(parseStroke('Escape')).toBe('esc');
    expect(parseStroke('option+b')).toBe('alt+b');
    expect(parseStroke('PgUp')).toBe('pageup');
    expect(parseStroke('shift+Tab')).toBe('shift+tab');
    expect(parseStroke('?')).toBe('?');
    expect(parseStroke('ctrl++')).toBe('ctrl++');
    expect(parseStroke('hyper+x')).toBeInstanceOf(Error);
    expect(parseStroke('ctrl+foo')).toBeInstanceOf(Error);
    expect(parseSequence('<leader> space', 'ctrl+x')).toEqual(['ctrl+x', 'space']);
    expect(parseSequence('ctrl+k ctrl+s', 'ctrl+x')).toEqual(['ctrl+k', 'ctrl+s']);
    expect(parseSequence('a b c d', 'ctrl+x')).toBeInstanceOf(Error);
  });

  it('labels keys for the footer and help', () => {
    expect(keyLabel('ctrl+x n')).toBe('^X n');
    expect(keyLabel('pageup')).toBe('PgUp');
    expect(keyLabel('alt+b')).toBe('Alt+b');
    expect(keyLabel('ctrl+shift+up')).toBe('Ctrl+Shift+↑');
    expect(keyLabel('ctrl+x space')).toBe('^X Space');
  });
});

describe('key maps', () => {
  it('reaches every global action through the leader', () => {
    const leaderBound = new Set(
      [...DEFAULT_KEYMAP.contexts.global]
        .filter(([k]) => k.startsWith('ctrl+x '))
        .map(([, a]) => a),
    );
    for (const action of new Set(DEFAULT_KEYMAP.contexts.global.values())) {
      if (action !== 'focus:toggle') expect(leaderBound, action).toContain(action);
    }
  });

  it('resolves chords, with the view before the global bindings', () => {
    const active = ['chat', 'global'] as const;
    expect(resolve(DEFAULT_KEYMAP, active, ['ctrl+x'])).toEqual({ kind: 'pending' });
    expect(resolve(DEFAULT_KEYMAP, active, ['ctrl+x', 'n'])).toEqual({
      kind: 'action',
      action: 'task:new',
    });
    expect(resolve(DEFAULT_KEYMAP, active, ['ctrl+x', 'z'])).toEqual({ kind: 'none' });
    expect(resolve(DEFAULT_KEYMAP, ['sidebar', 'global'], ['j'])).toEqual({
      kind: 'action',
      action: 'nav:next',
    });
    expect(resolve(DEFAULT_KEYMAP, ['task', 'global'], ['j'])).toEqual({
      kind: 'action',
      action: 'scroll:down',
    });
    const next = continuations(DEFAULT_KEYMAP, active, ['ctrl+x']);
    expect(next).toContainEqual(['e', 'chat:editor']);
    expect(next).toContainEqual(['n', 'task:new']);
    expect(keysFor(DEFAULT_KEYMAP, active, 'chat:editor')).toEqual(['ctrl+g', 'ctrl+x e']);
  });

  it('merges a user configuration and reports what it skips', () => {
    const { keymap, warnings } = buildKeyMap({
      leader: 'ctrl+g',
      bindings: [
        { context: 'global', bindings: { 'ctrl+n': null, 'alt+n': 'task:new' } },
        { context: 'chat', bindings: { 'ctrl+a': 'approvals:open', 'ctrl+y': 'chat:editor' } },
        { context: 'sidebar', bindings: { x: 'skills:add', 'ctrl+c': 'app:quit' } },
        { context: 'nowhere', bindings: {} },
        { context: 'task', bindings: { z: 'no:such' } },
      ],
    });
    // The leader moved every leader binding; the old leader is free.
    expect(resolve(keymap, ['chat', 'global'], ['ctrl+g', 'n'])).toEqual({
      kind: 'action',
      action: 'task:new',
    });
    expect(resolve(keymap, ['chat', 'global'], ['ctrl+x'])).toEqual({ kind: 'none' });
    expect(keymap.contexts.chat.get('ctrl+g')).toBeUndefined(); // the leader replaces it
    expect(resolve(keymap, ['chat', 'global'], ['ctrl+n'])).toEqual({ kind: 'none' });
    expect(resolve(keymap, ['chat', 'global'], ['alt+n'])).toEqual({
      kind: 'action',
      action: 'task:new',
    });
    expect(keymap.contexts.chat.get('ctrl+y')).toBe('chat:editor');
    expect(warnings).toHaveLength(5);
    expect(warnings.join('\n')).toMatch(/ctrl\+a.*edits text/);
    expect(warnings.join('\n')).toMatch(/skills:add works only in skills/);
    expect(warnings.join('\n')).toMatch(/reserved/);
    expect(warnings.join('\n')).toMatch(/unknown context "nowhere"/);
    expect(warnings.join('\n')).toMatch(/unknown action "no:such"/);
  });

  it('keeps the default leader when the configured one cannot work', () => {
    for (const leader of ['ctrl+a', 'ctrl+c', 'x', 'enter']) {
      const { keymap, warnings } = buildKeyMap({ leader });
      expect(keymap.leader).toBe('ctrl+x');
      expect(warnings).toHaveLength(1);
    }
    expect(buildKeyMap([]).warnings).toHaveLength(1);
    expect(buildKeyMap(null).warnings).toEqual([]);
  });
});
