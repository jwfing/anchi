/**
 * Key bindings: named actions, bound per context to keystrokes or chords.
 *
 * Every action is reachable through the leader key (Ctrl+X by default) followed by one key, so
 * nothing depends on a chord a terminal or multiplexer may take. Lists and views that take no
 * text also bind plain keys, and a few frequent keys (Tab, Enter, Esc, arrows) are direct.
 * Text inputs keep standard line editing; those keys are fixed (see `LINE_EDIT_KEYS`).
 */

export const CONTEXTS = [
  'global',
  'sidebar',
  'chat',
  'task',
  'runtimes',
  'skills',
  'connectors',
  'usage',
] as const;
export type Context = (typeof CONTEXTS)[number];

interface ActionInfo {
  title: string;
  /** Contexts where binding it makes sense; `global` actions can be bound in any context. */
  contexts: readonly Context[];
}

export const ACTIONS = {
  'app:quit': { title: 'Quit (the daemon and running tasks keep going)', contexts: ['global'] },
  'app:help': { title: 'Keys of this view', contexts: ['global'] },
  'app:palette': { title: 'Command palette', contexts: ['global'] },
  'focus:toggle': { title: 'Switch between the sidebar and the main pane', contexts: ['global'] },
  'focus:main': { title: 'Open the selected item', contexts: ['sidebar'] },
  'focus:sidebar': {
    title: 'Back to the sidebar',
    contexts: ['task', 'runtimes', 'skills', 'connectors', 'usage'],
  },
  'nav:next': { title: 'Next sidebar item', contexts: ['global'] },
  'nav:prev': { title: 'Previous sidebar item', contexts: ['global'] },
  'nav:first': { title: 'First sidebar item', contexts: ['sidebar'] },
  'nav:last': { title: 'Last sidebar item', contexts: ['sidebar'] },
  'nav:configure': { title: 'Go to Configure', contexts: ['global'] },
  'nav:agents': { title: 'Go to Agents', contexts: ['global'] },
  'nav:tasks': { title: 'Go to Tasks', contexts: ['global'] },
  'nav:builder': { title: 'Open the agent builder', contexts: ['global'] },
  'tasks:filter': { title: 'Filter tasks (@agent, status:failed, words)', contexts: ['global'] },
  'tasks:pagePrev': { title: 'Previous page of tasks', contexts: ['sidebar', 'task'] },
  'tasks:pageNext': { title: 'Next page of tasks', contexts: ['sidebar', 'task'] },
  'task:new': { title: 'New task (a new session) for this agent', contexts: ['global'] },
  'task:cancel': { title: 'Cancel the running task', contexts: ['global'] },
  'task:continue': { title: "Continue the task in its agent's chat", contexts: ['task'] },
  'task:retry': { title: 'Run a failed or cancelled task again', contexts: ['global'] },
  'task:access': {
    title: 'External access of the task: hosts, credentials injected, refusals (audit log)',
    contexts: ['global'],
  },
  'usage:period': { title: 'Usage: next period (24 hours, 7 days, 30 days)', contexts: ['usage'] },
  'usage:group': { title: 'Usage: group by agent, model, runtime or day', contexts: ['usage'] },
  'usage:refresh': { title: 'Usage: refresh', contexts: ['usage'] },
  'task:delete': { title: 'Delete the task and the tasks it delegated', contexts: ['task'] },
  'approvals:open': { title: 'Review a write waiting for approval', contexts: ['global'] },
  'agent:delete': {
    title: 'Delete the agent with its tasks and its files in the VM',
    contexts: ['global'],
  },
  'sidebar:delete': { title: 'Delete the selected agent or task', contexts: ['sidebar'] },
  'agent:settings': {
    title: 'Agent settings: skills, connectors, workspaces',
    contexts: ['global'],
  },
  'builder:proposal': { title: 'Reopen the pending builder proposal', contexts: ['global'] },
  'transcript:tools': { title: 'Expand or collapse tool calls', contexts: ['global'] },
  'transcript:verbose': { title: 'Verbose tool output', contexts: ['global'] },
  'scroll:up': { title: 'Scroll up', contexts: ['chat', 'task', 'usage'] },
  'scroll:down': { title: 'Scroll down', contexts: ['chat', 'task', 'usage'] },
  'scroll:pageUp': { title: 'Scroll up a page', contexts: ['chat', 'task'] },
  'scroll:pageDown': { title: 'Scroll down a page', contexts: ['chat', 'task'] },
  'chat:submit': { title: 'Send', contexts: ['chat'] },
  'chat:escape': {
    title: 'Cancel the running turn, then clear the draft, then back to the sidebar',
    contexts: ['chat'],
  },
  'chat:editor': { title: 'Compose in $EDITOR', contexts: ['chat'] },
  'list:up': { title: 'Move up', contexts: ['skills', 'connectors'] },
  'list:down': { title: 'Move down', contexts: ['skills', 'connectors'] },
  'setup:vmStart': { title: 'Start the VM', contexts: ['runtimes'] },
  'setup:install': { title: 'Install or update', contexts: ['runtimes'] },
  'setup:unlock': { title: 'Unlock the vault', contexts: ['runtimes'] },
  'setup:workspaces': { title: 'Share ~/AnchiWorkspaces with the VM', contexts: ['runtimes'] },
  'setup:codex': { title: 'Import the Codex login', contexts: ['runtimes'] },
  'setup:claude': { title: 'Connect Claude Code', contexts: ['runtimes'] },
  'setup:refresh': { title: 'Refresh', contexts: ['runtimes', 'connectors'] },
  'skills:add': { title: 'Add a skill (local directory or GitHub URL)', contexts: ['skills'] },
  'skills:remove': { title: 'Remove the skill', contexts: ['skills'] },
  'skills:update': {
    title: 'Update the skill to the latest commit of its URL',
    contexts: ['skills'],
  },
  'connectors:connect': { title: 'Connect', contexts: ['connectors'] },
  'connectors:ghImport': { title: 'GitHub: import the gh CLI token', contexts: ['connectors'] },
  'connectors:awsProfile': { title: 'AWS: connect through a profile', contexts: ['connectors'] },
  'connectors:mode': { title: 'Service writes: automatic or ask', contexts: ['connectors'] },
  'connectors:disconnect': { title: 'Disconnect', contexts: ['connectors'] },
} as const satisfies Record<string, ActionInfo>;
export type ActionId = keyof typeof ACTIONS;
export const isAction = (s: string): s is ActionId => Object.hasOwn(ACTIONS, s);

export const DEFAULT_LEADER = 'ctrl+x';

/** Plain keys every view without a text input shares. */
const VIEW: Record<string, ActionId> = { '?': 'app:help', q: 'app:quit' };
const BACK: Record<string, ActionId> = {
  esc: 'focus:sidebar',
  left: 'focus:sidebar',
  h: 'focus:sidebar',
};
const LIST: Record<string, ActionId> = {
  up: 'list:up',
  k: 'list:up',
  down: 'list:down',
  j: 'list:down',
};

/** Default bindings; `<leader>` stands for the configured leader key. */
export const DEFAULT_BINDINGS: Record<Context, Record<string, ActionId>> = {
  global: {
    tab: 'focus:toggle',
    'shift+tab': 'focus:toggle',
    'ctrl+n': 'nav:next',
    'ctrl+p': 'nav:prev',
    '<leader> q': 'app:quit',
    '<leader> ?': 'app:help',
    '<leader> space': 'app:palette',
    '<leader> p': 'app:palette',
    '<leader> j': 'nav:next',
    '<leader> k': 'nav:prev',
    '<leader> 1': 'nav:configure',
    '<leader> 2': 'nav:agents',
    '<leader> 3': 'nav:tasks',
    '<leader> b': 'nav:builder',
    '<leader> /': 'tasks:filter',
    '<leader> n': 'task:new',
    '<leader> c': 'task:cancel',
    '<leader> r': 'task:retry',
    '<leader> l': 'task:access',
    '<leader> a': 'approvals:open',
    '<leader> s': 'agent:settings',
    '<leader> D': 'agent:delete',
    '<leader> o': 'builder:proposal',
    '<leader> t': 'transcript:tools',
    '<leader> v': 'transcript:verbose',
  },
  sidebar: {
    ...VIEW,
    up: 'nav:prev',
    k: 'nav:prev',
    down: 'nav:next',
    j: 'nav:next',
    home: 'nav:first',
    g: 'nav:first',
    end: 'nav:last',
    G: 'nav:last',
    pageup: 'tasks:pagePrev',
    '[': 'tasks:pagePrev',
    pagedown: 'tasks:pageNext',
    ']': 'tasks:pageNext',
    '1': 'nav:configure',
    '2': 'nav:agents',
    '3': 'nav:tasks',
    enter: 'focus:main',
    right: 'focus:main',
    l: 'focus:main',
    '/': 'tasks:filter',
    s: 'agent:settings',
    D: 'sidebar:delete',
  },
  chat: {
    enter: 'chat:submit',
    esc: 'chat:escape',
    up: 'scroll:up',
    down: 'scroll:down',
    pageup: 'scroll:pageUp',
    pagedown: 'scroll:pageDown',
    'ctrl+g': 'chat:editor',
    '<leader> e': 'chat:editor',
  },
  task: {
    ...VIEW,
    ...BACK,
    enter: 'task:continue',
    c: 'task:cancel',
    R: 'task:retry',
    a: 'task:access',
    D: 'task:delete',
    '[': 'tasks:pagePrev',
    ']': 'tasks:pageNext',
    up: 'scroll:up',
    k: 'scroll:up',
    down: 'scroll:down',
    j: 'scroll:down',
    pageup: 'scroll:pageUp',
    pagedown: 'scroll:pageDown',
  },
  runtimes: {
    ...VIEW,
    ...BACK,
    s: 'setup:vmStart',
    I: 'setup:install',
    u: 'setup:unlock',
    W: 'setup:workspaces',
    i: 'setup:codex',
    c: 'setup:claude',
    r: 'setup:refresh',
  },
  usage: {
    ...VIEW,
    ...BACK,
    p: 'usage:period',
    b: 'usage:group',
    r: 'usage:refresh',
    up: 'scroll:up',
    k: 'scroll:up',
    down: 'scroll:down',
    j: 'scroll:down',
  },
  skills: { ...VIEW, ...BACK, ...LIST, a: 'skills:add', d: 'skills:remove', u: 'skills:update' },
  connectors: {
    ...VIEW,
    ...BACK,
    ...LIST,
    enter: 'connectors:connect',
    c: 'connectors:connect',
    g: 'connectors:ghImport',
    p: 'connectors:awsProfile',
    m: 'connectors:mode',
    d: 'connectors:disconnect',
    r: 'setup:refresh',
  },
};

/**
 * Keys that cannot be bound: the terminal delivers Ctrl+M as Enter, Ctrl+I as Tab and Ctrl+[ as
 * Esc, and Ctrl+C always quits.
 */
export const RESERVED = new Set(['ctrl+c', 'ctrl+m', 'ctrl+i', 'ctrl+[']);

/** Line editing in text inputs; fixed, so they cannot be bound in `chat`. */
export const LINE_EDIT_KEYS = new Set([
  'left',
  'right',
  'home',
  'end',
  'backspace',
  'ctrl+a',
  'ctrl+e',
  'ctrl+b',
  'ctrl+f',
  'ctrl+d',
  'ctrl+h',
  'ctrl+k',
  'ctrl+u',
  'ctrl+w',
  'alt+b',
  'alt+f',
  'alt+d',
  'alt+backspace',
]);

// ── keystrokes ────────────────────────────────────────────

/** The parts of Ink's `Key` that name a keystroke. */
export interface InkKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
}

/** The canonical name of one keystroke, or undefined for text (several characters, IME input). */
export function strokeOf(ch: string, key: InkKey): string | undefined {
  const mods = (k: string) =>
    `${key.ctrl ? 'ctrl+' : ''}${key.meta ? 'alt+' : ''}${key.shift ? 'shift+' : ''}${k}`;
  if (key.return) return mods('enter');
  if (key.tab) return key.shift ? 'shift+tab' : 'tab';
  if (key.escape) return 'esc';
  if (key.upArrow) return mods('up');
  if (key.downArrow) return mods('down');
  if (key.leftArrow) return mods('left');
  if (key.rightArrow) return mods('right');
  if (key.pageUp) return mods('pageup');
  if (key.pageDown) return mods('pagedown');
  if (key.home) return mods('home');
  if (key.end) return mods('end');
  if (key.backspace || key.delete) return key.meta ? 'alt+backspace' : 'backspace';
  if ([...ch].length !== 1) return undefined;
  if (key.ctrl) return `ctrl+${ch.toLowerCase()}`;
  if (key.meta) return `alt+${ch === ' ' ? 'space' : ch}`;
  if (ch === ' ') return 'space';
  return ch;
}

/**
 * Splits an input chunk that mixes keys and text, as Ink delivers it when several keys arrive in
 * one read (`\x18q` for Ctrl+X then q): control characters become Ctrl keys, ESC before a
 * character becomes Alt, and the text between stays text. Enter inside text stays text.
 */
export function splitChunk(ch: string, key: InkKey): [string, InkKey][] {
  const chars = [...ch];
  // eslint-disable-next-line no-control-regex
  if (chars.length < 2 || !/[\x01-\x08\x0b\x0c\x0e-\x1b\x7f]/.test(ch)) return [[ch, key]];
  const out: [string, InkKey][] = [];
  let text = '';
  const flush = () => {
    if (text) out.push([text, {}]);
    text = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const code = c.codePointAt(0)!;
    if (c === '\r' || c === '\n' || code >= 0x20) {
      if (code === 0x7f) {
        flush();
        out.push(['', { backspace: true }]);
      } else text += c;
      continue;
    }
    flush();
    if (c === '\t') out.push(['', { tab: true }]);
    else if (c === '\x1b') {
      const nextChar = chars[i + 1];
      if (nextChar === undefined) out.push(['', { escape: true }]);
      else if (nextChar === '[' || nextChar === 'O') {
        // An escape sequence (an arrow key) mixed into text: keep the rest as one chunk.
        out.push([chars.slice(i).join(''), key]);
        return out;
      } else {
        out.push([nextChar, { meta: true }]);
        i++;
      }
    } else out.push([String.fromCharCode(code + 96), { ctrl: true }]);
  }
  flush();
  return out;
}

const ALIASES: Record<string, string> = {
  escape: 'esc',
  return: 'enter',
  pgup: 'pageup',
  pgdn: 'pagedown',
  control: 'ctrl',
  meta: 'alt',
  option: 'alt',
  opt: 'alt',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};
const NAMED = new Set([
  'enter',
  'esc',
  'tab',
  'space',
  'up',
  'down',
  'left',
  'right',
  'pageup',
  'pagedown',
  'home',
  'end',
  'backspace',
]);

/** Canonical form of a keystroke written in a config (`Ctrl+X`, `shift+g`, `Escape`), or an error. */
export function parseStroke(text: string): string | Error {
  const raw = text.trim();
  if (!raw) return new Error('empty key');
  if ([...raw].length === 1) return raw === ' ' ? 'space' : raw;
  const parts = raw.split('+');
  // `ctrl++` and `+` name the plus key.
  const last = raw.endsWith('++') || raw === '+' ? '+' : parts.at(-1)!;
  const modParts = raw.endsWith('++') ? parts.slice(0, -2) : parts.slice(0, -1);
  const mods = new Set<string>();
  for (const m of modParts) {
    const name = ALIASES[m.toLowerCase()] ?? m.toLowerCase();
    if (name !== 'ctrl' && name !== 'alt' && name !== 'shift') {
      return new Error(`unknown modifier "${m}" in "${text}"`);
    }
    mods.add(name);
  }
  let key =
    ALIASES[last.toLowerCase()] ?? (NAMED.has(last.toLowerCase()) ? last.toLowerCase() : last);
  if ([...key].length !== 1 && !NAMED.has(key))
    return new Error(`unknown key "${last}" in "${text}"`);
  if ([...key].length === 1 && /[a-z]/i.test(key)) {
    // Letters: `shift+g` is `G`; with Ctrl, case does not exist.
    if (mods.has('ctrl')) key = key.toLowerCase();
    else if (mods.delete('shift')) key = key.toUpperCase();
  }
  if (key === 'tab' && mods.has('shift') && mods.size === 1) return 'shift+tab';
  return `${mods.has('ctrl') ? 'ctrl+' : ''}${mods.has('alt') ? 'alt+' : ''}${mods.has('shift') ? 'shift+' : ''}${key}`;
}

/** Strokes of a binding (`<leader> n`, `ctrl+x ctrl+e`), with the leader substituted. */
export function parseSequence(text: string, leader: string): string[] | Error {
  const out: string[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (part === '<leader>') {
      out.push(leader);
      continue;
    }
    const stroke = parseStroke(part);
    if (stroke instanceof Error) return stroke;
    out.push(stroke);
  }
  if (!out.length || out.length > 3) return new Error(`"${text}": use one to three keys`);
  return out;
}

// ── key maps ──────────────────────────────────────────────

/** Bindings of one context: the space-joined stroke sequence → action. */
export type Bindings = Map<string, ActionId>;
export interface KeyMap {
  leader: string;
  contexts: Record<Context, Bindings>;
}

export interface KeyConfig {
  leader?: string;
  bindings?: { context: string; bindings: Record<string, string | null> }[];
}

/** Defaults merged with a user configuration, and the problems found in it (each skipped). */
export function buildKeyMap(config: unknown = {}): { keymap: KeyMap; warnings: string[] } {
  const warnings: string[] = [];
  const cfg = (config && typeof config === 'object' ? config : {}) as KeyConfig;
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    warnings.push('the file must hold an object with "leader" and "bindings"');
  }
  let leader = DEFAULT_LEADER;
  if (cfg.leader !== undefined) {
    const parsed =
      typeof cfg.leader === 'string' ? parseStroke(cfg.leader) : new Error('not a string');
    if (parsed instanceof Error) warnings.push(`leader: ${parsed.message}`);
    else if (RESERVED.has(parsed) || LINE_EDIT_KEYS.has(parsed) || !/^(ctrl|alt)\+/.test(parsed)) {
      warnings.push(
        `leader: ${parsed} cannot be the leader (use Ctrl or Alt with a key that does not edit text)`,
      );
    } else leader = parsed;
  }
  const contexts = Object.fromEntries(CONTEXTS.map((c) => [c, new Map()])) as Record<
    Context,
    Bindings
  >;
  for (const ctx of CONTEXTS) {
    for (const [keys, action] of Object.entries(DEFAULT_BINDINGS[ctx])) {
      const seq = parseSequence(keys, leader);
      if (seq instanceof Error) throw new Error(`default binding ${ctx} "${keys}": ${seq.message}`);
      // A default on the key chosen as leader would never fire; its leader binding remains.
      if (seq.join(' ') !== leader) contexts[ctx].set(seq.join(' '), action);
    }
  }
  const blocks = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  if (cfg.bindings !== undefined && !Array.isArray(cfg.bindings))
    warnings.push('"bindings" must be a list');
  for (const block of blocks) {
    const ctx = block?.context as Context;
    if (!CONTEXTS.includes(ctx)) {
      warnings.push(`unknown context "${String(block?.context)}" (use ${CONTEXTS.join(', ')})`);
      continue;
    }
    for (const [keys, action] of Object.entries(block.bindings ?? {})) {
      const seq = parseSequence(keys, leader);
      if (seq instanceof Error) {
        warnings.push(`${ctx}: ${seq.message}`);
        continue;
      }
      const id = seq.join(' ');
      if (seq.some((s) => RESERVED.has(s))) {
        warnings.push(`${ctx}: "${keys}" uses a reserved key (${[...RESERVED].join(', ')})`);
        continue;
      }
      if (ctx === 'chat' && LINE_EDIT_KEYS.has(seq[0]!)) {
        warnings.push(`chat: "${keys}" edits text in the input and cannot be bound there`);
        continue;
      }
      if (action === null) {
        contexts[ctx].delete(id);
        continue;
      }
      if (id === leader) {
        warnings.push(`${ctx}: "${keys}" is the leader key; bind "<leader> …" instead`);
        continue;
      }
      if (typeof action !== 'string' || !isAction(action)) {
        warnings.push(`${ctx}: unknown action "${String(action)}" for "${keys}"`);
        continue;
      }
      const allowed: readonly Context[] = ACTIONS[action].contexts;
      if (!allowed.includes(ctx) && !allowed.includes('global')) {
        warnings.push(`${ctx}: ${action} works only in ${allowed.join(', ')}`);
        continue;
      }
      contexts[ctx].set(id, action);
    }
  }
  return { keymap: { leader, contexts }, warnings };
}

export const DEFAULT_KEYMAP = buildKeyMap().keymap;

export type Resolution =
  { kind: 'action'; action: ActionId } | { kind: 'pending' } | { kind: 'none' };

/**
 * What a sequence of strokes does in the active contexts, most specific first. A sequence that
 * starts a longer binding waits for the next key, as in Claude Code's chords.
 */
export function resolve(
  keymap: KeyMap,
  active: readonly Context[],
  seq: readonly string[],
): Resolution {
  const id = seq.join(' ');
  const prefix = `${id} `;
  for (const ctx of active) {
    for (const key of keymap.contexts[ctx].keys())
      if (key.startsWith(prefix)) return { kind: 'pending' };
  }
  for (const ctx of active) {
    const action = keymap.contexts[ctx].get(id);
    if (action) return { kind: 'action', action };
  }
  return { kind: 'none' };
}

/** Bindings that continue `seq` in the active contexts: next stroke → action (which-key). */
export function continuations(
  keymap: KeyMap,
  active: readonly Context[],
  seq: readonly string[],
): [string, ActionId][] {
  const prefix = `${seq.join(' ')} `;
  const out = new Map<string, ActionId>();
  for (const ctx of active) {
    for (const [key, action] of keymap.contexts[ctx]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!out.has(rest)) out.set(rest, action);
    }
  }
  return [...out];
}

/** The keys bound to `action` in the active contexts, most specific first. */
export function keysFor(keymap: KeyMap, active: readonly Context[], action: ActionId): string[] {
  const out: string[] = [];
  for (const ctx of active) {
    for (const [key, a] of keymap.contexts[ctx])
      if (a === action && !out.includes(key)) out.push(key);
  }
  return out;
}

const LABELS: Record<string, string> = {
  enter: 'Enter',
  esc: 'Esc',
  tab: 'Tab',
  'shift+tab': 'Shift+Tab',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  backspace: 'Backspace',
};

/** Display form: `ctrl+x n` → `^X n`, `alt+b` → `Alt+B`, `pageup` → `PgUp`. */
export function keyLabel(keys: string): string {
  return keys
    .split(' ')
    .map((s) => {
      if (LABELS[s]) return LABELS[s];
      const parts = s.split('+');
      const key = parts.pop()!;
      if (parts.length === 1 && parts[0] === 'ctrl' && [...key].length === 1) {
        return `^${key.toUpperCase()}`;
      }
      const mods = parts.map((m) => m[0]!.toUpperCase() + m.slice(1));
      return [...mods, LABELS[key] ?? key].join('+');
    })
    .join(' ');
}

/** A starting configuration: the leader, and examples of rebinding and unbinding. */
export const KEYS_TEMPLATE = `{
  "leader": "${DEFAULT_LEADER}",
  "bindings": [
    {
      "context": "global",
      "bindings": {
        "ctrl+n": null,
        "ctrl+p": null
      }
    }
  ]
}
`;
