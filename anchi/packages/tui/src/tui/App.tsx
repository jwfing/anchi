/** @jsxRuntime automatic */
import type {
  AgentPatch,
  AgentSettings,
  AgentSummary,
  AgentUpdate,
  Approval,
  BuilderProposal,
  ConnectorId,
  ServiceConnectorId,
  SkillInfo,
  ConnectorSecret,
  SetupStatus,
  StoredEvent,
  TaskRow,
  TaskStatus,
} from '@anchi/protocol';
import type { DaemonClient } from '@anchi/daemon';
import { readFile, stat } from 'node:fs/promises';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitize, sanitizeLine } from '../sanitize.ts';
import {
  ACTIONS,
  type ActionId,
  type Context,
  continuations,
  DEFAULT_KEYMAP,
  type InkKey,
  type KeyMap,
  keyLabel,
  keysFor,
  LINE_EDIT_KEYS,
  resolve,
  splitChunk,
  strokeOf,
} from './keys.ts';
import { type Draft, draftOf, EMPTY_DRAFT, edit, insert, inputWindow } from './lineedit.ts';
import {
  initialSettings,
  type SettingsRow,
  type SettingsState,
  settingsPatch,
  settingsRows,
  toggleSetting,
} from './settings.ts';
import { type Line, type Tone, transcriptLines, truncate } from './lines.ts';
import type { MouseEvent } from './mouse.ts';

export const SIDEBAR_WIDTH = 28;
const BUILDER = 'builder';
const CONFIG = ['runtimes', 'skills', 'connectors'] as const;
type ConfigItem = (typeof CONFIG)[number];
const CONFIG_LABEL: Record<ConfigItem, string> = {
  runtimes: 'Runtimes',
  skills: 'Skills',
  connectors: 'Connectors',
};
/** Sidebar item of a task (agent ids cannot contain ':'). */
const TASK_ITEM = 'task:';
/** Terminal row (1-based) of the sidebar's first row (its title). */
export const SIDEBAR_FIRST_ROW = 2;

/** One row of the sidebar; `item` rows can be selected, `pager` rows turn the task page. */
type SideRow =
  | { kind: 'title' | 'header' | 'note'; text: string }
  | { kind: 'item'; item: string }
  | { kind: 'pager'; page: number; pages: number };

/** Rows above the task list: title, three headers, config items, builder, agents. */
function sidebarFixedRows(agentCount: number): number {
  return 1 + 3 + CONFIG.length + 1 + Math.max(1, agentCount);
}
/** Screen row (1-based) of the first transcript line: border, header and rule above it. */
export const TRANSCRIPT_FIRST_ROW = 4;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TASK_COLOR: Record<TaskStatus, string> = {
  queued: 'blue',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  cancelled: 'gray',
};
const TONE: Record<Tone, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  user: { color: 'cyan', bold: true },
  assistant: {},
  tool: { color: 'yellow' },
  toolOut: { dimColor: true },
  error: { color: 'red' },
  warn: { color: 'yellow' },
  dim: { dimColor: true },
  system: { color: 'blue' },
};

type SecretField = { key: string; label: string; masked: boolean; optional?: boolean };
/** Masked inputs: connector credentials, and the Claude Code token (`claude`). */
type SecretTarget = ConnectorId | 'claude' | 'notion' | 'slack';
const SECRET_FIELDS: Record<SecretTarget, SecretField[]> = {
  notion: [
    { key: 'token', label: 'Notion internal integration secret (ntn_… or secret_…)', masked: true },
  ],
  slack: [{ key: 'token', label: 'Slack bot token (xoxb-…)', masked: true }],
  claude: [
    {
      key: 'token',
      label: 'Claude Code token from `claude setup-token` (sk-ant-oat01-…), or an API key',
      masked: true,
    },
  ],
  github: [{ key: 'token', label: 'GitHub fine-grained token (github_pat_…)', masked: true }],
  linear: [{ key: 'token', label: 'Linear API key (lin_api_…)', masked: true }],
  aws: [
    { key: 'accessKeyId', label: 'Access key id of a dedicated IAM principal', masked: false },
    { key: 'secretAccessKey', label: 'Secret access key', masked: true },
    { key: 'region', label: 'Region (e.g. us-east-1)', masked: false },
    {
      key: 'sessionToken',
      label: 'Session token (only for ASIA… keys; Enter to skip)',
      masked: true,
      optional: true,
    },
  ],
};

type Modal =
  | { kind: 'proposal'; proposal: BuilderProposal; scroll: number }
  | {
      kind: 'secret';
      connector: SecretTarget;
      index: number;
      values: Record<string, string>;
      input: string;
    }
  | { kind: 'confirm'; title: string; body: string; action: () => Promise<unknown> }
  | { kind: 'help'; context: Context; scroll: number }
  | { kind: 'palette'; context: Context; query: string; cursor: number }
  | { kind: 'approval'; approval: Approval }
  | {
      kind: 'settings';
      agentId: string;
      /** Set when the panel edits a builder proposal instead of the agent's file. */
      proposalId?: string;
      data: AgentSettings | null;
      state: SettingsState | null;
      cursor: number;
    }
  | {
      kind: 'settingsReview';
      agentId: string;
      patch: AgentPatch;
      update: AgentUpdate;
      /** The panel to return to on n or Esc. */
      back: Extract<Modal, { kind: 'settings' }>;
    }
  | {
      kind: 'text';
      title: string;
      label: string;
      input: string;
      submit: (value: string) => Promise<unknown>;
      /** Enter with an empty input submits it (clears a filter). */
      allowEmpty?: boolean;
    };

export interface AppProps {
  client: DaemonClient;
  initialAgents: AgentSummary[];
  initialTasks: TaskRow[];
  onMouse?(handler: (e: MouseEvent) => void): void;
  /** Opens $EDITOR on a draft and returns the edited text (CJK input fallback). */
  compose?(draft: string): string;
  /** Effective key bindings (defaults merged with ~/.anchi/keybindings.json). */
  keymap?: KeyMap;
  /** Problems found in the key configuration; shown once. */
  keyWarnings?: string[];
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Tasks matching a filter: `@agent` or `agent:x`, `status:x`, and words in title, result or id. */
export function filterTasks(tasks: TaskRow[], filter: string): TaskRow[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tasks;
  return tasks.filter((t) =>
    words.every((w) => {
      if (w.startsWith('@')) return t.agentId === w.slice(1);
      if (w.startsWith('agent:')) return t.agentId === w.slice(6);
      if (w.startsWith('status:')) return t.status === w.slice(7);
      return `${t.id} ${t.title} ${t.result ?? ''}`.toLowerCase().includes(w);
    }),
  );
}

function relTime(ms: number | null): string {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function useSpinner(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [active]);
  return frame;
}

export function App({
  client,
  initialAgents,
  initialTasks,
  onMouse,
  compose,
  keymap = DEFAULT_KEYMAP,
  keyWarnings = [],
}: AppProps) {
  const { exit, suspendTerminal } = useApp() as ReturnType<typeof useApp> & {
    suspendTerminal?: (fn: () => void) => Promise<void>;
  };
  const { columns, rows } = useWindowSize();
  const [agents, setAgents] = useState(initialAgents);
  const [tasks, setTasks] = useState(initialTasks);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // Which pane takes the keys: the sidebar or the main pane (chat, task, settings).
  const [focus, setFocus] = useState<'side' | 'main'>('main');
  const [taskPage, setTaskPage] = useState(0);
  // `@agent status:failed words` over the loaded tasks; empty shows all.
  const [taskFilter, setTaskFilter] = useState('');
  const [focusTask, setFocusTask] = useState<Record<string, string | null>>({});
  const [logs, setLogs] = useState<Record<string, StoredEvent[]>>({});
  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT);
  // Mirrors the draft synchronously: keys and text from one input chunk build on each other.
  const draftRef = useRef<Draft>(EMPTY_DRAFT);
  const setDraft = (next: Draft | ((d: Draft) => Draft)) => {
    draftRef.current = typeof next === 'function' ? next(draftRef.current) : next;
    setDraftState(draftRef.current);
  };
  const input = draft.text;
  // Keys of a chord typed so far (the leader, then more); a ref so one input chunk sees them all.
  const [pending, setPendingState] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const [connectorCursor, setConnectorCursor] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillCursor, setSkillCursor] = useState(0);
  const refreshSkills = useCallback(() => {
    void client
      .call('skills.list')
      .then((list) => setSkills(list ?? []))
      .catch(() => setSkills([]));
  }, [client]);
  const [verbose, setVerbose] = useState(false);
  // Tool-call groups the user expanded, by group id (`<task>:g<seq>`).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [proposals, setProposals] = useState<BuilderProposal[]>([]);
  // Writes the egress proxy holds for the user, oldest first.
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const seenApprovals = useRef(new Set<string>());
  // A notification is newer than the initial list; a late list answer must not undo it.
  const approvalsNotified = useRef(false);
  const [flash, setFlash] = useState('');
  const loading = useRef(new Set<string>());

  const userAgents = agents.filter((a) => a.id !== BUILDER);
  const shownTasks = useMemo(() => filterTasks(tasks, taskFilter), [tasks, taskFilter]);
  const items: string[] = [
    ...CONFIG,
    BUILDER,
    ...userAgents.map((a) => a.id),
    ...shownTasks.map((t) => TASK_ITEM + t.id),
  ];
  // Selection is by item, so new tasks arriving at the top do not move it.
  const current = selected && items.includes(selected) ? selected : (userAgents[0]?.id ?? BUILDER);
  const isMenu = (CONFIG as readonly string[]).includes(current);
  const detail = current.startsWith(TASK_ITEM)
    ? tasks.find((t) => TASK_ITEM + t.id === current)
    : undefined;
  const agent = isMenu || detail ? undefined : agents.find((a) => a.id === current);
  const frame = useSpinner(tasks.some((t) => t.status === 'running'));

  const say = useCallback((msg: string) => {
    setFlash(sanitizeLine(msg));
    setTimeout(() => setFlash((f) => (f === sanitizeLine(msg) ? '' : f)), 5000);
  }, []);

  const refreshSetup = useCallback(() => {
    void client
      .call('setup.status')
      .then(setSetup)
      .catch((e: Error) => say(e.message));
  }, [client, say]);

  // A new held write opens its dialog once no other dialog is up; approvals:open reopens it.
  useEffect(() => {
    const fresh = approvals.find((a) => !seenApprovals.current.has(a.id));
    if (fresh && !modal) {
      seenApprovals.current.add(fresh.id);
      setModal({ kind: 'approval', approval: fresh });
    }
    if (modal?.kind === 'approval' && !approvals.some((a) => a.id === modal.approval.id)) {
      setModal(null);
    }
  }, [approvals, modal]);
  useEffect(() => {
    void client
      .call('approvals.list')
      .then((list) => {
        if (!approvalsNotified.current) setApprovals(list ?? []);
      })
      .catch(() => {});
  }, [client]);

  // ── daemon subscriptions ────────────────────────────────
  useEffect(() => {
    const offs = [
      client.on('agents', ({ agents: next }) => setAgents(next)),
      client.on('tasks', ({ task }) =>
        setTasks((all) =>
          [task, ...all.filter((t) => t.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt),
        ),
      ),
      client.on('event', ({ taskId, seq, event }) => {
        if (seq === undefined) return;
        setLogs((all) => {
          const cur = all[taskId];
          if (!cur) return all;
          if (cur.length && cur.at(-1)!.seq >= seq) return all;
          return { ...all, [taskId]: [...cur, { seq, ts: Date.now(), event }] };
        });
      }),
      client.on('setup', ({ line }) => setSetupLog((log) => [...log, line].slice(-8))),
      client.on('approvals', ({ approvals: next }) => {
        approvalsNotified.current = true;
        setApprovals(next);
      }),
      client.on('oauth', ({ id, ok, error }) => {
        say(ok ? `${id} connected` : `${id}: ${error ?? 'sign-in failed'}`);
        refreshSetup();
      }),
      client.on('tasksDeleted', () => {
        void client
          .call('tasks.list', { limit: 500 })
          .then((list) => setTasks(list ?? []))
          .catch(() => {});
      }),
      client.on('proposal', ({ proposal }) => {
        setProposals((p) => [...p.filter((x) => x.agentId !== proposal.agentId), proposal]);
        setModal({ kind: 'proposal', proposal, scroll: 0 });
      }),
    ];
    client.onClose(() => exit(new Error('daemon connection closed')));
    return () => {
      for (const off of offs) off();
    };
  }, [client, exit]);

  useEffect(() => {
    if (current === 'runtimes' || current === 'connectors') refreshSetup();
    if (current === 'skills') refreshSkills();
    setScroll(0);
  }, [current, refreshSetup]);

  // The task shown for an agent: the one chosen, else its latest; null means "new task".
  const agentTasks = agent ? tasks.filter((t) => t.agentId === agent.id) : [];
  const chosen = agent ? focusTask[agent.id] : undefined;
  const task = detail
    ? detail
    : chosen === null
      ? undefined
      : (agentTasks.find((t) => t.id === chosen) ?? agentTasks[0]);

  useEffect(() => {
    const id = task?.id;
    if (!id || logs[id] || loading.current.has(id)) return;
    loading.current.add(id);
    void client.call('tasks.events', { taskId: id }).then((events) => {
      loading.current.delete(id);
      setLogs((all) => {
        const streamed = all[id] ?? [];
        const last = events.at(-1)?.seq ?? 0;
        return { ...all, [id]: [...events, ...streamed.filter((e) => e.seq > last)] };
      });
    });
  }, [client, task?.id, logs]);

  // ── layout ──────────────────────────────────────────────
  /** The context whose bindings apply, before the global ones. */
  const context: Context =
    focus === 'side' ? 'sidebar' : detail ? 'task' : isMenu ? (current as Context) : 'chat';
  const active: Context[] = [context, 'global'];
  // While a chord is pending, the keys that can follow it (which-key), above the status line.
  const next = pending.length ? continuations(keymap, active, pending) : [];
  const whichKeyRows = next.length ? Math.ceil(next.length / 2) + 1 : 0;
  const mainWidth = Math.max(30, columns - SIDEBAR_WIDTH);
  const textWidth = mainWidth - 4;
  const bodyHeight = rows - 1 - whichKeyRows;
  // The chat has an input box below the transcript; a task's detail has two meta lines above it.
  const transcriptHeight = Math.max(3, bodyHeight - (detail ? 7 : 8));
  const transcriptFirstRow = TRANSCRIPT_FIRST_ROW + (detail ? 2 : 0);

  // Task pages fill the sidebar below the fixed rows (header, page rows, pager).
  const pageSize = Math.max(3, bodyHeight - 2 - sidebarFixedRows(userAgents.length) - 1);
  const pages = Math.max(1, Math.ceil(shownTasks.length / pageSize));
  const detailIndex = detail ? shownTasks.indexOf(detail) : -1;
  const page = Math.min(
    detailIndex >= 0 ? Math.floor(detailIndex / pageSize) : taskPage,
    pages - 1,
  );
  const sideRows: SideRow[] = [
    { kind: 'title', text: '安栖 Anchi' },
    { kind: 'header', text: 'CONFIGURE' },
    ...CONFIG.map((item) => ({ kind: 'item' as const, item })),
    { kind: 'header', text: 'AGENTS' },
    { kind: 'item', item: BUILDER },
    ...(userAgents.length
      ? userAgents.map((a) => ({ kind: 'item' as const, item: a.id }))
      : [{ kind: 'note' as const, text: 'none yet — use the builder' }]),
    {
      kind: 'header',
      text: `TASKS${pages > 1 ? ` ${page + 1}/${pages}` : ''}${taskFilter ? ' · filtered' : ''}`,
    },
    ...(shownTasks.length
      ? shownTasks
          .slice(page * pageSize, (page + 1) * pageSize)
          .map((t) => ({ kind: 'item' as const, item: TASK_ITEM + t.id }))
      : [{ kind: 'note' as const, text: taskFilter ? 'no task matches' : 'no tasks yet' }]),
    ...(pages > 1 ? [{ kind: 'pager' as const, page, pages }] : []),
  ];
  const sideRowsRef = useRef(sideRows);
  sideRowsRef.current = sideRows;
  const lines = useMemo<Line[]>(
    () =>
      transcriptLines(task ? (logs[task.id] ?? []) : [], textWidth, {
        verbose,
        expanded,
        live: task?.status === 'running',
        prefix: task ? `${task.id}:` : '',
      }),
    [logs, task?.id, task?.status, textWidth, verbose, expanded],
  );
  // Input box: border and padding take four columns, the prompt two.
  const inputView = inputWindow(draft, textWidth - 6);
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(
    Math.max(0, lines.length - transcriptHeight - offset),
    lines.length - offset,
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const firstRowRef = useRef(transcriptFirstRow);
  firstRowRef.current = transcriptFirstRow;

  const toggleGroup = (id: string) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /** transcript:tools: expands every tool-call group of the shown task, or collapses them all. */
  const toggleAllGroups = () => {
    const ids = [...new Set(lines.flatMap((l) => (l.group ? [l.group] : [])))];
    setExpanded((all) => {
      const next = new Set(all);
      const open = ids.some((id) => !all.has(id));
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // ── actions ─────────────────────────────────────────────
  const fallback = userAgents[0]?.id ?? BUILDER;
  // From the previous selection, so several keys in one input chunk all count.
  const move = (d: number) =>
    setSelected((prev) => {
      const from = items.indexOf(prev && items.includes(prev) ? prev : fallback);
      return items[(from + d + items.length) % items.length];
    });
  /** Shows another page of tasks; a selected task moves to the first task of that page. */
  /** Shows another page of tasks; with `select` (or a task selected), its first task. */
  const turnPage = (to: number, select = false) => {
    const next = Math.max(0, Math.min(pages - 1, to));
    setTaskPage(next);
    const first = shownTasks[next * pageSize];
    if ((detail || select) && first) setSelected(TASK_ITEM + first.id);
  };
  const turnPageRef = useRef(turnPage);
  turnPageRef.current = turnPage;
  const pageRef = useRef(page);
  pageRef.current = page;

  // The agent whose next message starts a new task: a ref, so text arriving in the same input
  // chunk as ^X n already goes to a new task.
  const newTaskFor = useRef<string | null>(null);
  const startNewTask = (id: string) => {
    newTaskFor.current = id;
    setFocusTask((f) => ({ ...f, [id]: null }));
  };

  const submit = (raw = draftRef.current.text) => {
    const text = raw.trim();
    if (!text || !agent) return;
    setDraft(EMPTY_DRAFT);
    setScroll(0);
    if (text === '/new') {
      startNewTask(agent.id);
      return say('the next message starts a new task');
    }
    if (text === '/verbose') return setVerbose((v) => !v);
    if (text === '/quit') return exit();
    const shown = newTaskFor.current === agent.id ? undefined : task;
    newTaskFor.current = null;
    const followUp = shown && shown.status !== 'running' && shown.status !== 'queued';
    if (shown && !followUp) return say('wait for the current turn to finish, or Esc to cancel it');
    const call = followUp
      ? client.call('tasks.send', { taskId: shown.id, text })
      : client.call('tasks.create', { agentId: agent.id, text });
    void call
      .then((t) => setFocusTask((f) => ({ ...f, [agent.id]: t.id })))
      .catch((e: Error) => say(e.message));
  };

  const editDraft = () => {
    if (!compose || !suspendTerminal) return say('set $EDITOR to compose in an editor');
    let result = input;
    void suspendTerminal(() => {
      result = compose(input);
    }).then(() => setDraft(draftOf(result.replace(/\n+$/, ''))));
  };

  const openConnector = (id: ConnectorId) =>
    setModal({ kind: 'secret', connector: id, index: 0, values: {}, input: '' });

  /** Edits the input of the open text or secret dialog from its latest state (fast typing). */
  const editModalInput = (edit: (value: string) => string) =>
    setModal((m) =>
      m && (m.kind === 'text' || m.kind === 'secret') ? { ...m, input: edit(m.input) } : m,
    );

  const runAction = (action: () => Promise<unknown>, done: string) => {
    void action()
      .then(() => {
        say(done);
        refreshSetup();
      })
      .catch((e: Error) => say(e.message));
  };

  // ── key bindings ────────────────────────────────────────
  const setPending = (seq: string[]) => {
    pendingRef.current = seq;
    setPendingState(seq);
    clearTimeout(pendingTimer.current);
    // An unfinished chord is dropped after three seconds, as in Claude Code.
    if (seq.length) pendingTimer.current = setTimeout(() => setPending([]), 3000);
  };
  useEffect(() => () => clearTimeout(pendingTimer.current), []);
  // A dialog that opens mid-chord (a held write arriving) ends the chord.
  useEffect(() => {
    if (modal && pendingRef.current.length) setPending([]);
  }, [modal]);
  useEffect(() => {
    if (keyWarnings.length) {
      say(
        `keybindings.json: ${keyWarnings.length} problem${keyWarnings.length === 1 ? '' : 's'} (run \`anchi keys\`)`,
      );
    }
  }, [keyWarnings, say]);

  const back = () => setFocus('side');
  const halfPage = Math.floor(transcriptHeight / 2);
  const connectorIds: ConnectorId[] = ['github', 'aws', 'linear'];
  const serviceIds: ServiceConnectorId[] = ['gmail', 'drive', 'notion', 'slack'];

  const setupStep = (step: 'vm-start' | 'install' | 'workspaces' | 'vault-unlock') => {
    const [title, body] = (
      {
        'vm-start': ['Start the VM', 'Start the secure-vm VM.'],
        install: [
          'Install or update',
          'Create or update the secure-vm VM, install the trusted services and the agent ' +
            'team, and build the base image. This takes several minutes.',
        ],
        workspaces: [
          'Share ~/AnchiWorkspaces',
          'Mount ~/AnchiWorkspaces into the VM so agents can be given directories of this Mac ' +
            '(workspaces: in an agent). The VM restarts: running tasks stop, and the vault is ' +
            'unlocked again afterwards.',
        ],
        'vault-unlock': [
          'Unlock the vault',
          'Send the vault key from ~/.config/secure-vm/vault.key on this Mac to the VM, ' +
            'where it is kept in memory only.',
        ],
      } as const
    )[step];
    setModal({
      kind: 'confirm',
      title,
      body,
      action: () => {
        setSetupLog([]);
        return client.call('setup.run', { action: step });
      },
    });
  };

  /** Opens the settings panel of an agent, or of a pending builder proposal. */
  const openSettings = (target: { agentId: string } | { proposalId: string; agentId: string }) => {
    const proposalId = 'proposalId' in target ? target.proposalId : undefined;
    setModal({
      kind: 'settings',
      agentId: target.agentId,
      proposalId,
      data: null,
      state: null,
      cursor: 0,
    });
    void client
      .call('agents.settings', proposalId ? { proposalId } : { agentId: target.agentId })
      .then((data) => {
        if (!data.editable) {
          setModal(null);
          return say(data.reason ?? `@${data.agentId} cannot be edited here`);
        }
        setModal((m) =>
          m?.kind === 'settings' && m.agentId === target.agentId && !m.data
            ? { ...m, data, state: initialSettings(data) }
            : m,
        );
      })
      .catch((e: Error) => {
        setModal(null);
        say(e.message);
      });
  };

  /** Shows what the panel's changes do to the agent file, or revises the proposal. */
  const reviewSettings = (m: Extract<Modal, { kind: 'settings' }>) => {
    if (!m.data || !m.state) return;
    const patch = settingsPatch(m.data, m.state);
    if (!Object.keys(patch).length) {
      setModal(m.proposalId ? (proposalModal(m.proposalId) ?? null) : null);
      return say('nothing changed');
    }
    if (m.proposalId) {
      return void client
        .call('builder.revise', { proposalId: m.proposalId, patch })
        .then((proposal) => {
          setProposals((p) => p.map((x) => (x.id === proposal.id ? proposal : x)));
          setModal({ kind: 'proposal', proposal, scroll: 0 });
        })
        .catch((e: Error) => say(e.message));
    }
    void client
      .call('agents.update', { agentId: m.agentId, patch })
      .then((update) =>
        setModal({ kind: 'settingsReview', agentId: m.agentId, patch, update, back: m }),
      )
      .catch((e: Error) => say(e.message));
  };
  const proposalModal = (id: string): Modal | undefined => {
    const proposal = proposals.find((p) => p.id === id);
    return proposal ? { kind: 'proposal', proposal, scroll: 0 } : undefined;
  };

  /** Runs a bound action in the current view. */
  const run = (action: ActionId): void => {
    const running = (t?: TaskRow) => t && (t.status === 'running' || t.status === 'queued');
    switch (action) {
      case 'app:quit':
        return exit();
      case 'app:help':
        return setModal({ kind: 'help', context, scroll: 0 });
      case 'app:palette':
        return setModal({ kind: 'palette', context, query: '', cursor: 0 });
      case 'focus:toggle':
        return setFocus((f) => (f === 'side' ? 'main' : 'side'));
      case 'focus:main':
        return setFocus('main');
      case 'focus:sidebar':
        return back();
      case 'nav:next':
        return move(1);
      case 'nav:prev':
        return move(-1);
      case 'nav:first':
        return setSelected(items[0]);
      case 'nav:last':
        return setSelected(items.at(-1));
      case 'nav:configure':
        return setSelected(CONFIG[0]);
      case 'nav:agents':
        return setSelected(userAgents[0]?.id ?? BUILDER);
      case 'nav:tasks':
        return turnPage(page, true);
      case 'nav:builder':
        setSelected(BUILDER);
        return setFocus('main');
      case 'tasks:pagePrev':
        return turnPage(page - 1, context === 'sidebar');
      case 'tasks:pageNext':
        return turnPage(page + 1, context === 'sidebar');
      case 'tasks:filter':
        return setModal({
          kind: 'text',
          title: 'Filter tasks',
          label:
            '@agent, status:done|failed|running|cancelled|queued and words; Enter on empty shows all',
          input: taskFilter,
          allowEmpty: true,
          submit: async (value) => {
            setTaskFilter(value.trim());
            setTaskPage(0);
          },
        });
      case 'task:new': {
        const id = agent?.id ?? detail?.agentId;
        if (!id) return say('select an agent first');
        setSelected(id);
        setFocus('main');
        startNewTask(id);
        return say(`the next message starts a new task (a new session) for @${id}`);
      }
      case 'task:cancel': {
        const t = detail ?? task;
        if (!running(t)) return say('no running task here');
        return void client
          .call('tasks.cancel', { taskId: t!.id })
          .catch((e: Error) => say(e.message));
      }
      case 'task:continue':
        if (!detail) return;
        setFocusTask((f) => ({ ...f, [detail.agentId]: detail.id }));
        return setSelected(detail.agentId);
      case 'task:delete':
        if (!detail || running(detail))
          return say('a running task cannot be deleted; cancel it first');
        return setModal({
          kind: 'confirm',
          title: `Delete ${detail.id}`,
          body: `Delete this task, the tasks it delegated and their transcripts from ~/.anchi. This cannot be undone.`,
          action: async () => {
            await client.call('tasks.delete', { taskId: detail.id });
            setSelected(detail.agentId);
          },
        });
      case 'agent:settings': {
        const id = agent?.id ?? detail?.agentId;
        if (!id) return say('select an agent first');
        return openSettings({ agentId: id });
      }
      case 'approvals:open':
        if (!approvals.length) return say('no write is waiting for approval');
        return setModal({ kind: 'approval', approval: approvals[0]! });
      case 'builder:proposal':
        if (!proposals.length) return say('no builder proposal is waiting');
        return setModal({ kind: 'proposal', proposal: proposals.at(-1)!, scroll: 0 });
      case 'transcript:tools':
        return toggleAllGroups();
      case 'transcript:verbose':
        return setVerbose((v) => !v);
      case 'scroll:up':
        return setScroll((s) => Math.min(maxScroll, s + 1));
      case 'scroll:down':
        return setScroll((s) => Math.max(0, s - 1));
      case 'scroll:pageUp':
        return setScroll((s) => Math.min(maxScroll, s + halfPage));
      case 'scroll:pageDown':
        return setScroll((s) => Math.max(0, s - halfPage));
      case 'chat:submit':
        return submit();
      case 'chat:escape':
        // Esc first cancels a running turn, then clears the draft, then leaves the chat.
        if (running(task)) {
          void client.call('tasks.cancel', { taskId: task!.id });
          return say(`cancelling ${task!.id}`);
        }
        if (draftRef.current.text) return setDraft(EMPTY_DRAFT);
        return back();
      case 'chat:editor':
        return editDraft();
      case 'list:up':
        if (current === 'skills') return setSkillCursor((c) => Math.max(0, c - 1));
        return setConnectorCursor((c) => Math.max(0, c - 1));
      case 'list:down':
        if (current === 'skills')
          return setSkillCursor((c) => Math.min((skills ?? []).length - 1, c + 1));
        return setConnectorCursor((c) =>
          Math.min(connectorIds.length + serviceIds.length - 1, c + 1),
        );
      case 'setup:vmStart':
        return setupStep('vm-start');
      case 'setup:install':
        return setupStep('install');
      case 'setup:unlock':
        return setupStep('vault-unlock');
      case 'setup:workspaces':
        return setupStep('workspaces');
      case 'setup:codex':
        return setModal({
          kind: 'confirm',
          title: 'Import Codex login',
          body:
            'Read the access token and account id from ~/.codex/auth.json on this Mac and store them in the ' +
            'VM vault. The refresh token stays on this Mac. Cells never receive the token.',
          action: () => client.call('setup.importCodex'),
        });
      case 'setup:claude':
        return setModal({ kind: 'secret', connector: 'claude', index: 0, values: {}, input: '' });
      case 'setup:refresh':
        return refreshSetup();
      case 'skills:add':
        return setModal({
          kind: 'text',
          title: 'Add a skill',
          label:
            'A local directory with a SKILL.md, or a GitHub URL such as https://github.com/owner/repo/tree/main/skills/name (fetched at its current commit)',
          input: '',
          submit: async (raw) => {
            const source = raw.trim();
            const guess = source.replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? '';
            setModal({
              kind: 'text',
              title: 'Skill id',
              label: `The id agents list it by (1–40 lowercase letters, digits or "-"). Enter keeps "${guess}".`,
              input: '',
              allowEmpty: true,
              submit: async (id) => {
                const skill = await client.call('skills.add', {
                  source,
                  id: id.trim() || undefined,
                });
                refreshSkills();
                say(
                  `skill ${skill.id} added; give it to agents with ${keyLabel(keysFor(keymap, ['global'], 'agent:settings')[0] ?? '')} in their chat`,
                );
              },
            });
          },
        });
      case 'skills:update': {
        const skill = (skills ?? [])[skillCursor];
        if (!skill) return;
        if (!skill.commit)
          return say(`${skill.id} was added from a local directory; add it again to refresh it`);
        say(`checking ${skill.id}…`);
        return void client
          .call('skills.checkUpdate', { id: skill.id })
          .then((u) => {
            if (u.upToDate) return say(`${u.id} is up to date (${u.latest.slice(0, 10)})`);
            const list = (label: string, files: string[]) =>
              files.length
                ? `\n${label}: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` and ${files.length - 8} more` : ''}`
                : '';
            setModal({
              kind: 'confirm',
              title: `Update skill ${u.id}`,
              body:
                `${u.url}\n${u.current?.slice(0, 10) ?? '?'} → ${u.latest.slice(0, 10)}` +
                list('added', u.added) +
                list('changed', u.changed) +
                list('removed', u.removed) +
                '\n\nSkill content is untrusted, like any agent input. Agents get the new version on their next cell.',
              action: async () => {
                await client.call('skills.update', { id: u.id, commit: u.latest });
                refreshSkills();
              },
            });
          })
          .catch((e: Error) => say(e.message));
      }
      case 'skills:remove': {
        const skill = (skills ?? [])[skillCursor];
        if (!skill) return;
        return setModal({
          kind: 'confirm',
          title: `Remove skill ${skill.id}`,
          body: 'Agents that list this skill fail to start until it is added again or removed from them.',
          action: async () => {
            await client.call('skills.remove', { id: skill.id });
            refreshSkills();
          },
        });
      }
    }
    // Connectors: the cursor is on a proxy connector or, below them, on a service.
    const sid =
      connectorCursor >= connectorIds.length
        ? serviceIds[connectorCursor - connectorIds.length]!
        : undefined;
    const id = sid ? undefined : connectorIds[connectorCursor]!;
    const status = sid ? setup?.services?.find((x) => x.id === sid) : undefined;
    switch (action) {
      case 'connectors:connect':
        if (id) return openConnector(id);
        if (sid === 'notion' || sid === 'slack') {
          return setModal({ kind: 'secret', connector: sid, index: 0, values: {}, input: '' });
        }
        if (!setup?.googleClient) {
          return setModal({
            kind: 'text',
            title: 'Google OAuth client',
            label:
              'Path of the Desktop app OAuth client JSON from Google Cloud (needed once for Gmail and Drive)',
            input: '',
            submit: async (path) => {
              const text = await readClientFile(path.trim());
              await client.call('services.googleClient', { json: text });
              refreshSetup();
              say('Google client stored; press Enter again to sign in');
            },
          });
        }
        return runAction(async () => {
          const { url } = await client.call('services.googleLogin', { id: sid! });
          say(`sign in to Google in your browser (${url.slice(0, 60)}…)`);
        }, `opened Google sign-in for ${sid}`);
      case 'connectors:ghImport':
        if (id !== 'github') return say('select github first');
        return setModal({
          kind: 'confirm',
          title: 'Import the gh CLI token',
          body:
            'Read the token the GitHub CLI on this Mac is logged in with (`gh auth token`) and store ' +
            'it in the VM vault. It carries every scope of your gh login, usually broader than a ' +
            'fine-grained token limited to the repositories the agents need.',
          action: () => client.call('connectors.importGh'),
        });
      case 'connectors:awsProfile':
        if (id !== 'aws') return say('select aws first');
        return setModal({
          kind: 'text',
          title: 'Connect AWS through a profile',
          label:
            'AWS profile on this Mac (for SSO, run `aws sso login --profile …` first). Anchi ' +
            'exports its temporary credentials and refreshes them before they expire.',
          input: '',
          submit: (profile) => client.call('connectors.awsProfile', { profile }),
        });
      case 'connectors:mode': {
        if (!sid || !status) return say('select a service (gmail, drive, notion, slack) first');
        const mode = status.mode === 'ask' ? 'auto' : 'ask';
        return runAction(
          () => client.call('services.setMode', { id: sid, mode }),
          `${sid} writes: ${mode === 'ask' ? 'ask for approval' : 'automatic'}`,
        );
      }
      case 'connectors:disconnect':
        if (sid) {
          if (!status?.connected) return;
          return setModal({
            kind: 'confirm',
            title: `Disconnect ${sid}`,
            body: `Remove the ${sid} credential from the vault${sid === 'gmail' || sid === 'drive' ? ' and revoke it at Google' : ''}.`,
            action: () => client.call('services.disconnect', { id: sid }),
          });
        }
        return setModal({
          kind: 'confirm',
          title: `Disconnect ${id}`,
          body: `Remove the ${id} credential from the vault. Agents with this connector lose access.`,
          action: () => client.call('connectors.remove', { id: id! }),
        });
    }
  };

  usePaste((text) => {
    if (modal?.kind === 'secret' || modal?.kind === 'text') editModalInput((v) => v + text.trim());
    else if (modal?.kind === 'palette')
      setModal({ ...modal, query: modal.query + text.trim(), cursor: 0 });
    else if (!modal && agent) setDraft((d) => insert(d, text));
  });

  /** One keystroke or a run of text; `useInput` splits mixed chunks into these. */
  const handleInput = (ch: string, key: InkKey) => {
    // ── modals take every key ──
    if (modal?.kind === 'approval') {
      const { approval } = modal;
      if (key.escape) return setModal(null);
      if (ch === 'y' || ch === 'n') {
        setModal(null);
        return void client
          .call('approvals.decide', { id: approval.id, allow: ch === 'y' })
          .then(() => say(`${ch === 'y' ? 'approved' : 'denied'}: ${approval.operation}`))
          .catch((e: Error) => say(e.message));
      }
      return;
    }
    if (modal?.kind === 'proposal') {
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: modal.scroll + 1 });
      if (key.escape) return setModal(null);
      if (ch === 's') {
        return openSettings({ proposalId: modal.proposal.id, agentId: modal.proposal.agentId });
      }
      if (ch === 'n') {
        void client.call('builder.discard', { proposalId: modal.proposal.id });
        setProposals((p) => p.filter((x) => x.id !== modal.proposal.id));
        setModal(null);
        return say('proposal discarded');
      }
      if (ch === 'y' && !modal.proposal.errors.length) {
        const { proposal } = modal;
        setModal(null);
        setProposals((p) => p.filter((x) => x.id !== proposal.id));
        void client
          .call('builder.apply', { proposalId: proposal.id })
          .then(() => say(`@${proposal.agentId} saved`))
          .catch((e: Error) => say(e.message));
      }
      return;
    }
    if (modal?.kind === 'secret') {
      const field = SECRET_FIELDS[modal.connector][modal.index]!;
      if (key.escape) return setModal(null);
      if (key.backspace || key.delete) return editModalInput((v) => [...v].slice(0, -1).join(''));
      if (key.return) {
        if (!modal.input && !field.optional) return;
        const values = { ...modal.values, ...(modal.input ? { [field.key]: modal.input } : {}) };
        if (modal.index + 1 < SECRET_FIELDS[modal.connector].length) {
          return setModal({ ...modal, index: modal.index + 1, values, input: '' });
        }
        setModal(null);
        if (modal.connector === 'notion' || modal.connector === 'slack') {
          const id = modal.connector;
          return runAction(
            () => client.call('services.setToken', { id, token: values.token ?? '' }),
            `${id} connected`,
          );
        }
        if (modal.connector === 'claude') {
          return runAction(
            () => client.call('setup.importClaude', { token: values.token ?? '' }),
            'Claude Code connected',
          );
        }
        const secret = { id: modal.connector, ...values } as ConnectorSecret;
        return runAction(
          () => client.call('connectors.set', secret),
          `${modal.connector} connected`,
        );
      }
      if (ch && !key.ctrl && !key.meta) editModalInput((v) => v + ch.replace(/[\r\n]/g, ''));
      return;
    }
    if (modal?.kind === 'text') {
      if (key.escape) return setModal(null);
      if (key.backspace || key.delete) return editModalInput((v) => [...v].slice(0, -1).join(''));
      if (key.return) {
        if (!modal.input && !modal.allowEmpty) return;
        const { submit, input, title } = modal;
        setModal(null);
        return runAction(() => submit(input), `${title}: done`);
      }
      if (ch && !key.ctrl && !key.meta) editModalInput((v) => v + ch.replace(/[\r\n]/g, ''));
      return;
    }
    if (modal?.kind === 'help') {
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: modal.scroll + 1 });
      if (key.escape || key.return || ch === 'q' || ch === '?') setModal(null);
      return;
    }
    if (modal?.kind === 'palette') {
      const entries = paletteEntries(keymap, modal.context, modal.query);
      if (key.escape) return setModal(null);
      if (key.return) {
        const entry = entries[modal.cursor];
        setModal(null);
        return entry ? run(entry.action) : undefined;
      }
      if (key.upArrow || (key.ctrl && ch === 'p'))
        return setModal({ ...modal, cursor: Math.max(0, modal.cursor - 1) });
      if (key.downArrow || (key.ctrl && ch === 'n'))
        return setModal({ ...modal, cursor: Math.min(entries.length - 1, modal.cursor + 1) });
      if (key.backspace || key.delete)
        return setModal({ ...modal, query: [...modal.query].slice(0, -1).join(''), cursor: 0 });
      if (key.ctrl && ch === 'u') return setModal({ ...modal, query: '', cursor: 0 });
      if (ch && !key.ctrl && !key.meta)
        setModal((m) =>
          m?.kind === 'palette'
            ? { ...m, query: m.query + ch.replace(/[\r\n]/g, ''), cursor: 0 }
            : m,
        );
      return;
    }
    if (modal?.kind === 'settings') {
      if (key.escape)
        return setModal(modal.proposalId ? (proposalModal(modal.proposalId) ?? null) : null);
      if (!modal.data || !modal.state) return;
      // From the latest panel state: keys repeated faster than a render all count.
      type Panel = Extract<Modal, { kind: 'settings' }>;
      const edit = (f: (m: Panel, items: SettingsRow[]) => Partial<Panel>) =>
        setModal((m) => {
          if (m?.kind !== 'settings' || !m.data || !m.state) return m;
          const items = settingsRows(m.data, m.state).filter((r) => r.kind !== 'header');
          return { ...m, ...f(m, items) };
        });
      if (key.upArrow || ch === 'k') return edit((m) => ({ cursor: Math.max(0, m.cursor - 1) }));
      if (key.downArrow || ch === 'j') {
        return edit((m, items) => ({ cursor: Math.min(items.length - 1, m.cursor + 1) }));
      }
      if (ch === ' ') {
        return edit((m, items) =>
          items[m.cursor] ? { state: toggleSetting(m.state!, items[m.cursor]!) } : {},
        );
      }
      if (key.return) {
        return setModal((m) => {
          if (m?.kind === 'settings') queueMicrotask(() => reviewSettings(m));
          return m;
        });
      }
      return;
    }
    if (modal?.kind === 'settingsReview') {
      if (ch === 'y' && !modal.update.errors.length) {
        const { agentId, patch, update } = modal;
        setModal(null);
        return void client
          .call('agents.update', { agentId, patch, apply: true, base: update.base })
          .then(() => say(`@${agentId} settings saved; its next cell uses them`))
          .catch((e: Error) => say(e.message));
      }
      if (ch === 'n' || key.escape) setModal(modal.back);
      return;
    }
    if (modal?.kind === 'confirm') {
      if (ch === 'y') {
        const { action, title } = modal;
        setModal(null);
        return runAction(action, `${title}: done`);
      }
      if (ch === 'n' || key.escape) setModal(null);
      return;
    }

    // ── bindings ──
    const stroke = strokeOf(ch, key);
    if (stroke === 'ctrl+c') return exit();
    if (pendingRef.current.length && !stroke && [...ch].length > 1) {
      // Text after the leader in one read: its first character finishes the chord.
      const [first, ...rest] = [...ch];
      handleInput(first!, {});
      return handleInput(rest.join(''), {});
    }
    if (pendingRef.current.length) {
      const seq = [...pendingRef.current, stroke ?? ch];
      setPending([]);
      if (stroke === 'esc' || !stroke) return;
      const found = resolve(keymap, active, seq);
      if (found.kind === 'pending') return setPending(seq);
      if (found.kind === 'action') return run(found.action);
      return say(
        `${keyLabel(seq.join(' '))} is not bound here (${keyLabel(keymap.leader)} ? lists the keys)`,
      );
    }
    if (context === 'chat') {
      // The input keeps standard line editing, and printable keys are always text.
      if (stroke && LINE_EDIT_KEYS.has(stroke)) {
        return setDraft((d) => edit(d, stroke) ?? d);
      }
      // Named and modified keys are longer than one character (`ctrl+a`, `enter`).
      if (ch && (!stroke || stroke === 'space' || [...stroke].length === 1)) {
        // Fast typing or a non-bracketed paste can deliver text and Enter in one chunk.
        const nl = ch.search(/[\r\n]/);
        if (nl >= 0) return submit(insert(draftRef.current, ch.slice(0, nl)).text);
        return setDraft((d) => insert(d, ch));
      }
    }
    if (!stroke) return;
    const found = resolve(keymap, active, [stroke]);
    if (found.kind === 'pending') return setPending([stroke]);
    if (found.kind === 'action') return run(found.action);
  };
  useInput((ch, key) => {
    for (const [c, k] of splitChunk(ch, key)) handleInput(c, k);
  });

  useEffect(() => {
    onMouse?.((e) => {
      const side = e.x <= SIDEBAR_WIDTH;
      // The wheel scrolls the transcript, or turns task pages over the sidebar.
      if (e.kind === 'wheelUp' || e.kind === 'wheelDown') {
        const up = e.kind === 'wheelUp';
        if (side) return turnPageRef.current(pageRef.current + (up ? -1 : 1));
        return setScroll((s) => (up ? s + 3 : Math.max(0, s - 3)));
      }
      if (e.kind !== 'press' || e.button !== 0) return;
      setFocus(side ? 'side' : 'main');
      if (!side) {
        const line = visibleRef.current[e.y - firstRowRef.current];
        if (line?.group) toggleGroup(line.group);
        return;
      }
      const row = sideRowsRef.current[e.y - SIDEBAR_FIRST_ROW];
      if (row?.kind === 'item') setSelected(row.item);
      // The pager reads "‹ prev  ·  next ›": its left half goes back, its right half forward.
      if (row?.kind === 'pager')
        turnPageRef.current(row.page + (e.x <= SIDEBAR_WIDTH / 2 ? -1 : 1));
    });
  }, [onMouse]);

  // ── render ──────────────────────────────────────────────
  if (modal) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <ModalView modal={modal} width={columns} height={rows} keymap={keymap} />
      </Box>
    );
  }

  const header = detail
    ? `${detail.id} · @${detail.agentId} · ${detail.status}${detail.parentId ? ` · delegated by ${detail.parentId}` : ''}${detail.trigger !== 'user' && detail.trigger !== 'delegation' ? ` · ${detail.trigger}` : ''}`
    : agent
      ? `@${agent.id} · ${sanitizeLine(agent.name)}  ${agent.runtime ?? ''} · ${agent.connectors.join(', ') || 'no connectors'}${
          agent.triggers ? ` · ⏰ ${agent.triggers}` : ''
        }${
          agent.workspaces?.length ? ` · 📁 ${agent.workspaces.join(', ')}` : ''
        }${agent.skills?.length ? ` · 🧩 ${agent.skills.join(', ')}` : ''}${task ? ` · ${task.id} (${task.status})` : ' · new task'}`
      : CONFIG_LABEL[current as ConfigItem];
  const busy = detail?.status === 'running' || detail?.status === 'queued';
  /** `key label` for an action in this view, from the effective bindings (shortest first). */
  const hint = (action: ActionId, label: string) => {
    const keys = keysFor(keymap, active, action).sort(
      (a, b) => a.split(' ').length - b.split(' ').length,
    );
    return keys[0] ? `${keyLabel(keys[0])} ${label}` : '';
  };
  const hints: [ActionId, string][] =
    context === 'sidebar'
      ? [
          ['focus:main', 'open'],
          ['tasks:pageNext', 'task page'],
          ['tasks:filter', 'filter'],
          ['focus:toggle', 'pane'],
        ]
      : context === 'task'
        ? [
            ['task:continue', `continue in @${detail?.agentId}`],
            busy ? ['task:cancel', 'cancel'] : ['task:delete', 'delete'],
            ['scroll:pageUp', 'scroll'],
            ['focus:sidebar', 'sidebar'],
          ]
        : context === 'chat'
          ? [
              ['chat:submit', 'send'],
              ['task:new', 'new task'],
              ['chat:escape', 'cancel/sidebar'],
              ['agent:settings', 'settings'],
              ['chat:editor', 'editor'],
              ['transcript:tools', 'tools'],
            ]
          : context === 'connectors'
            ? [
                ['connectors:connect', 'connect'],
                ['connectors:ghImport', 'github from gh'],
                ['connectors:awsProfile', 'aws profile'],
                ['connectors:mode', 'service writes'],
                ['connectors:disconnect', 'disconnect'],
              ]
            : context === 'skills'
              ? [
                  ['skills:add', 'add'],
                  ['skills:update', 'update'],
                  ['skills:remove', 'remove'],
                  ['focus:sidebar', 'sidebar'],
                ]
              : [
                  ['setup:vmStart', 'start VM'],
                  ['setup:install', 'install'],
                  ['setup:unlock', 'unlock'],
                  ['setup:workspaces', 'workspaces'],
                  ['setup:codex', 'Codex'],
                  ['setup:claude', 'Claude'],
                ];
  const status = pending.length
    ? `${keyLabel(pending.join(' '))} …  (Esc cancels)`
    : flash ||
      [
        ...hints.map(([a, l]) => hint(a, l)),
        proposals.length ? hint('builder:proposal', 'proposal') : '',
        hint('app:palette', 'commands'),
        hint('app:help', 'keys'),
      ]
        .filter(Boolean)
        .join(' · ');
  const statusLine =
    approvals.length && !pending.length
      ? `⏸ ${approvals.length} write${approvals.length === 1 ? '' : 's'} waiting for approval (${keyLabel(keysFor(keymap, active, 'approvals:open')[0] ?? '')}) · ${status}`
      : status;
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={bodyHeight}>
        <Sidebar
          focused={focus === 'side'}
          rows={sideRows}
          agents={agents}
          tasks={tasks}
          current={current}
          height={bodyHeight}
          frame={frame}
        />
        <Box
          flexDirection="column"
          width={mainWidth}
          height={bodyHeight}
          borderStyle="round"
          borderColor={focus === 'main' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Text bold wrap="truncate">
            {header}
          </Text>
          <Text dimColor>{'─'.repeat(textWidth)}</Text>
          {agent ? (
            <>
              <Box flexDirection="column" height={transcriptHeight}>
                {agent.error ? (
                  <Text color="red">{sanitize(agent.error)}</Text>
                ) : visible.length ? (
                  visible.map((l, i) => (
                    <Text key={i} {...TONE[l.tone]} wrap="truncate">
                      {l.text || ' '}
                    </Text>
                  ))
                ) : (
                  <Text dimColor>
                    {current === BUILDER
                      ? 'Describe the agent you want: its job, the services it needs, the tools it uses.'
                      : `Give @${agent.id} a task. It runs in a fresh cell; credentials stay outside.`}
                  </Text>
                )}
              </Box>
              <Text dimColor>{offset > 0 ? `↓ ${offset} more lines (PgDn)` : ' '}</Text>
              <Box borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text wrap="truncate">
                  <Text color="cyan">› </Text>
                  {inputView.before}
                  <Text inverse>{inputView.at}</Text>
                  {inputView.after}
                </Text>
              </Box>
            </>
          ) : detail ? (
            <>
              <Text wrap="truncate">
                <Text color={TASK_COLOR[detail.status]}>{detail.status}</Text>
                {`  created ${new Date(detail.createdAt).toLocaleString()}`}
                {detail.finishedAt && detail.startedAt
                  ? ` · ran ${duration(detail.finishedAt - detail.startedAt)}`
                  : detail.startedAt
                    ? ` · started ${relTime(detail.startedAt)} ago`
                    : ''}
                {` · ${detail.turns} turn${detail.turns === 1 ? '' : 's'}`}
                {detail.inputTokens || detail.outputTokens
                  ? ` · ${tokens(detail.inputTokens)} in / ${tokens(detail.outputTokens)} out`
                  : ''}
              </Text>
              <Text color="blue" wrap="truncate">
                {[
                  ...detail.links.map(sanitizeLine),
                  ...tasks
                    .filter((t) => t.parentId === detail.id)
                    .map((t) => `↳ ${t.id} @${t.agentId} ${t.status}`),
                ].join('  ') || ' '}
              </Text>
              <Box flexDirection="column" height={transcriptHeight}>
                {visible.length ? (
                  visible.map((l, i) => (
                    <Text key={i} {...TONE[l.tone]} wrap="truncate">
                      {l.text || ' '}
                    </Text>
                  ))
                ) : (
                  <Text dimColor>Loading…</Text>
                )}
              </Box>
              <Text dimColor>{offset > 0 ? `↓ ${offset} more lines (PgDn)` : ' '}</Text>
            </>
          ) : current === 'connectors' ? (
            <ConnectorsView setup={setup} cursor={connectorCursor} />
          ) : current === 'runtimes' ? (
            <RuntimesView setup={setup} log={setupLog} />
          ) : (
            <SkillsView skills={skills} cursor={skillCursor} />
          )}
        </Box>
      </Box>
      {whichKeyRows ? <WhichKey next={next} width={columns} /> : null}
      <Text dimColor wrap="truncate">
        {statusLine}
      </Text>
    </Box>
  );
}

/** The keys that can follow the pending chord, in two columns. */
function WhichKey({ next, width }: { next: [string, ActionId][]; width: number }) {
  const half = Math.ceil(next.length / 2);
  const col = Math.floor((width - 4) / 2);
  const cell = ([k, a]: [string, ActionId]) =>
    truncate(`${keyLabel(k).padEnd(6)} ${ACTIONS[a].title}`, col - 1).padEnd(col);
  return (
    <Box flexDirection="column" paddingX={1} height={half + 1}>
      <Text bold color="cyan">
        Next key
      </Text>
      {Array.from({ length: half }, (_, i) => (
        <Text key={i} wrap="truncate">
          {cell(next[i]!)}
          {next[i + half] ? cell(next[i + half]!) : ''}
        </Text>
      ))}
    </Box>
  );
}

/** Actions for the command palette in a context, filtered by the query (subsequence match). */
export function paletteEntries(
  keymap: KeyMap,
  context: Context,
  query: string,
): { action: ActionId; title: string; keys: string }[] {
  const active: Context[] = [context, 'global'];
  const q = query.toLowerCase().replace(/\s+/g, '');
  const matches = (text: string) => {
    let i = 0;
    for (const c of text.toLowerCase()) if (c === q[i]) i++;
    return i === q.length;
  };
  return (Object.keys(ACTIONS) as ActionId[])
    .filter((a) => {
      const ctx: readonly Context[] = ACTIONS[a].contexts;
      return (ctx.includes(context) || ctx.includes('global')) && a !== 'app:palette';
    })
    .map((a) => ({
      action: a,
      title: ACTIONS[a].title,
      keys: keysFor(keymap, active, a).map(keyLabel).join(', '),
    }))
    .filter((e) => matches(`${e.title} ${e.action}`))
    .sort((x, y) => {
      // Titles containing the query as typed first, then this view's own commands.
      const rank = (e: { action: ActionId; title: string }) =>
        (e.title.toLowerCase().includes(query.toLowerCase()) ? 0 : 2) +
        ((ACTIONS[e.action].contexts as readonly Context[]).includes(context) ? 0 : 1);
      return rank(x) - rank(y);
    });
}

function Sidebar(props: {
  focused: boolean;
  rows: SideRow[];
  agents: AgentSummary[];
  tasks: TaskRow[];
  current: string;
  height: number;
  frame: number;
}) {
  const { focused, rows, agents, tasks, current, height, frame } = props;
  const inner = SIDEBAR_WIDTH - 4;
  const spin = SPINNER[frame % SPINNER.length]!;
  const running = (id: string) => tasks.some((t) => t.agentId === id && t.status === 'running');
  const item = (key: string) => {
    if ((CONFIG as readonly string[]).includes(key)) {
      return { glyph: '·', color: undefined, text: CONFIG_LABEL[key as ConfigItem] };
    }
    if (key.startsWith(TASK_ITEM)) {
      const t = tasks.find((x) => TASK_ITEM + x.id === key)!;
      const glyph =
        t.status === 'running'
          ? spin
          : t.status === 'done'
            ? '✓'
            : t.status === 'failed'
              ? '✗'
              : t.status === 'cancelled'
                ? '–'
                : '◇';
      const branch = t.depth > 0 ? '↳' : '';
      return {
        glyph,
        color: TASK_COLOR[t.status],
        text: `${branch}@${t.agentId} ${sanitizeLine(t.title)}`,
      };
    }
    if (key === BUILDER) {
      return { glyph: running(BUILDER) ? spin : '✎', color: 'magenta', text: 'Agent builder' };
    }
    const a = agents.find((x) => x.id === key);
    const glyph = a?.error ? '✗' : running(key) ? spin : a?.queued ? '◇' : '○';
    const color = a?.error ? 'red' : running(key) ? 'yellow' : 'gray';
    return { glyph, color, text: key };
  };
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={height}
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {rows.map((row, i) => {
        if (row.kind === 'title')
          return (
            <Text key={i} bold>
              {row.text}
            </Text>
          );
        if (row.kind === 'header')
          return (
            <Text key={i} dimColor bold>
              {row.text}
            </Text>
          );
        if (row.kind === 'note')
          return (
            <Text key={i} dimColor wrap="truncate">
              {`  ${row.text}`}
            </Text>
          );
        if (row.kind === 'pager') {
          const prev = row.page > 0 ? '‹ prev' : '      ';
          const next = row.page < row.pages - 1 ? 'next ›' : '      ';
          return (
            <Text key={i} color="cyan">
              {`${prev}${' '.repeat(Math.max(1, inner - 12))}${next}`}
            </Text>
          );
        }
        if (row.kind !== 'item') return null;
        const { glyph, color, text } = item(row.item);
        // The selection is inverse while the sidebar has the keys, underlined otherwise.
        const on = current === row.item;
        return (
          <Text
            key={i}
            inverse={on && focused}
            bold={on}
            underline={on && !focused}
            wrap="truncate"
          >
            <Text color={color}>{glyph}</Text> {truncate(text, inner - 2).padEnd(inner - 2)}
          </Text>
        );
      })}
    </Box>
  );
}

function ConnectorsView({ setup, cursor }: { setup: SetupStatus | null; cursor: number }) {
  if (!setup) return <Text dimColor>Loading…</Text>;
  const notes: Record<string, string> = {
    github: 'API (bearer) and git over HTTPS; key and secret APIs are denied',
    aws: 'requests re-signed by the proxy; use a dedicated least-privilege principal',
    linear: 'GraphQL API key; API key management is denied',
  };
  return (
    <Box flexDirection="column">
      {!setup.vaultUnlocked ? (
        <Text color="red">The vault is locked: run scripts/vault.py unlock.</Text>
      ) : null}
      {setup.connectors.map((c, i) => (
        <Box key={c.id} flexDirection="column">
          <Text inverse={i === cursor}>
            <Text color={c.connected ? 'green' : 'gray'}>{c.connected ? '●' : '○'}</Text>{' '}
            {c.id.padEnd(8)}
            {c.connected ? sanitizeLine(c.account ?? 'connected') : 'not connected'}
            {c.profile ? ` · profile ${sanitizeLine(c.profile)}` : ''}
          </Text>
          <Text dimColor>{`  ${notes[c.id]}`}</Text>
        </Box>
      ))}
      <Text bold dimColor>
        SERVICES
      </Text>
      {(setup.services ?? []).map((c, i) => (
        <Box key={c.id} flexDirection="column">
          <Text inverse={i + setup.connectors.length === cursor}>
            <Text color={c.reauthRequired ? 'red' : c.connected ? 'green' : 'gray'}>
              {c.connected ? '●' : '○'}
            </Text>{' '}
            {c.id.padEnd(8)}
            {c.reauthRequired
              ? 'sign in again'
              : c.connected
                ? sanitizeLine(c.account ?? 'connected')
                : 'not connected'}
            {` · writes ${c.mode === 'ask' ? 'ask' : 'auto'}`}
          </Text>
        </Box>
      ))}
      <Text dimColor>
        Secrets go from this screen to the VM vault. They are never stored on this Mac or shown
        again. Google tokens are obtained in the VM.
      </Text>
    </Box>
  );
}

/** Reads the Google client JSON the user points at (on this Mac). */
async function readClientFile(path: string): Promise<string> {
  const home = process.env.HOME ?? '';
  const file = path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
  if ((await stat(file)).size > 16_384) throw new Error('that file is too large for a client JSON');
  return readFile(file, 'utf8');
}

function SkillsView({ skills, cursor }: { skills: SkillInfo[] | null; cursor: number }) {
  if (!skills) return <Text dimColor>Loading…</Text>;
  return (
    <Box flexDirection="column">
      {skills.length ? null : <Text dimColor>No skills yet. Press a to add one.</Text>}
      {skills.map((s, i) => (
        <Box key={s.id} flexDirection="column">
          <Text inverse={i === cursor} wrap="truncate">
            {`${s.id.padEnd(20)}${sanitizeLine(s.name)}`}
          </Text>
          <Text dimColor wrap="truncate">
            {`  ${sanitizeLine(s.description)}${s.commit ? ` · ${sanitizeLine(s.source)} @ ${s.commit.slice(0, 10)}` : ' · local'}`}
          </Text>
        </Box>
      ))}
      <Text dimColor>
        Agents use skills listed in their `skills:` field. Skill content is untrusted, like any
        agent input.
      </Text>
    </Box>
  );
}

function RuntimesView({ setup, log }: { setup: SetupStatus | null; log: string[] }) {
  if (!setup) return <Text dimColor>Loading…</Text>;
  const c = setup.codex;
  const expired = c.expiresAt !== null && c.expiresAt < Date.now();
  return (
    <Box flexDirection="column">
      <Text>
        VM: <Text color={setup.vm === 'running' ? 'green' : 'red'}>{setup.vm}</Text> · vault:{' '}
        <Text color={setup.vaultUnlocked ? 'green' : 'red'}>
          {setup.vaultUnlocked ? 'unlocked' : 'locked'}
        </Text>{' '}
        · base image:{' '}
        <Text color={setup.installed ? 'green' : 'yellow'}>
          {setup.installed ? 'built' : 'not built yet'}
        </Text>
      </Text>
      <Text>
        Codex (ChatGPT subscription):{' '}
        {c.connected ? (
          <Text color={expired ? 'red' : 'green'}>
            {expired
              ? 'token expired — press i to re-import'
              : `connected, token valid until ${new Date(c.expiresAt!).toLocaleString()}`}
          </Text>
        ) : (
          <Text color="yellow">not connected — run `codex login` on this Mac, then press i</Text>
        )}
      </Text>
      <Text>
        Workspaces:{' '}
        {setup.workspaces ? (
          <Text color="green">~/AnchiWorkspaces is shared with the VM</Text>
        ) : (
          <Text dimColor>not set up — press W to share ~/AnchiWorkspaces</Text>
        )}
      </Text>
      <Text>
        Claude Code:{' '}
        {setup.claude?.connected ? (
          <Text color="green">
            connected ({setup.claude.kind === 'api_key' ? 'API key' : 'subscription token'})
          </Text>
        ) : (
          <Text color="yellow">
            not connected — run `claude setup-token` on this Mac, then press c
          </Text>
        )}
      </Text>
      {log.length ? (
        <Box flexDirection="column" marginTop={1}>
          {log.map((line, i) => (
            <Text key={i} dimColor wrap="truncate">
              {sanitizeLine(line)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

const CONTEXT_LABEL: Record<Context, string> = {
  global: 'Everywhere',
  sidebar: 'Sidebar',
  chat: 'Agent chat',
  task: 'Task',
  runtimes: 'Runtimes',
  skills: 'Skills',
  connectors: 'Connectors',
};

/** Rows of the help: the view's bindings, then the global ones, then fixed keys. */
export function helpRows(keymap: KeyMap, context: Context): [string, string][] {
  const group = (ctx: Context, skip: Set<ActionId>): [string, string][] => {
    const byAction = new Map<ActionId, string[]>();
    for (const [keys, action] of keymap.contexts[ctx]) {
      if (skip.has(action)) continue;
      byAction.set(action, [...(byAction.get(action) ?? []), keyLabel(keys)]);
    }
    return [...byAction].map(([a, keys]) => [keys.join('  '), ACTIONS[a].title]);
  };
  const own = context === 'global' ? [] : group(context, new Set());
  const ownActions = new Set([...keymap.contexts[context].values()]);
  const rows: [string, string][] = [];
  if (own.length) rows.push([CONTEXT_LABEL[context], ''], ...own, ['', '']);
  rows.push(
    [`Everywhere (leader ${keyLabel(keymap.leader)}, then a key)`, ''],
    ...group('global', context === 'global' ? new Set() : ownActions),
  );
  if (context === 'chat') {
    rows.push(
      ['', ''],
      ['Text input (fixed)', ''],
      ['← →  ^B ^F', 'move by character'],
      ['Alt+B Alt+F', 'move by word'],
      ['Home End  ^A ^E', 'start / end of the line'],
      ['Backspace ^D', 'delete before / at the cursor'],
      ['^W Alt+D', 'delete the word before / after'],
      ['^U ^K', 'delete to the start / end of the line'],
    );
  }
  rows.push(
    ['', ''],
    ['Fixed', ''],
    ['Ctrl+C', 'quit'],
    ['y n Esc', 'approval, confirmation and proposal dialogs'],
    ['Space Enter', 'agent settings: select, then review the change (s in a proposal)'],
  );
  return rows;
}

function ModalView({
  modal,
  width,
  height,
  keymap,
}: {
  modal: Modal;
  width: number;
  height: number;
  keymap: KeyMap;
}) {
  const inner = width - 6;
  const label = (action: ActionId) => keyLabel(keysFor(keymap, ['global'], action)[0] ?? '');
  if (modal.kind === 'secret') {
    const fields = SECRET_FIELDS[modal.connector];
    const field = fields[modal.index]!;
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold color="cyan">
          Connect {modal.connector} ({modal.index + 1}/{fields.length})
        </Text>
        <Text>{field.label}</Text>
        <Box borderStyle="round" paddingX={1}>
          <Text>
            {field.masked ? '•'.repeat(Math.min([...modal.input].length, inner - 4)) : modal.input}
            <Text inverse> </Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>
          Enter next · Esc cancel · this screen is drawn by Anchi, not by an agent
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'approval') {
    const a = modal.approval;
    const left = Math.max(0, Math.round(a.timeout - (Date.now() - a.createdAt) / 1000));
    const room = Math.max(3, height - 12);
    const lines = sanitize(a.summary).split('\n').slice(0, room);
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="red"
        paddingX={2}
      >
        <Text bold color="red">
          Approve a write by @{sanitizeLine(a.agent)}?
        </Text>
        {a.reason ? <Text color="yellow">{`why        ${sanitizeLine(a.reason)}`}</Text> : null}
        <Text wrap="truncate">{`started by ${sanitizeLine(a.origin || a.task)}`}</Text>
        <Text>{`connector  ${sanitizeLine(a.connector)} (${sanitizeLine(a.host)})`}</Text>
        <Text wrap="truncate">{`operation  ${sanitizeLine(a.operation)}`}</Text>
        <Text dimColor>{`refused automatically in about ${left} s`}</Text>
        <Text> </Text>
        <Box flexDirection="column" height={room}>
          {lines.map((l, i) => (
            <Text key={i} wrap="truncate">
              {truncate(l, Math.max(10, width - 6)) || ' '}
            </Text>
          ))}
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>The content above comes from the agent. This dialog is drawn by Anchi.</Text>
        <Text bold>{`[y] approve · [n] deny · Esc decide later (${label('approvals:open')})`}</Text>
      </Box>
    );
  }
  if (modal.kind === 'help') {
    const rows = helpRows(keymap, modal.context);
    const room = Math.max(3, height - 4);
    const start = Math.min(modal.scroll, Math.max(0, rows.length - room));
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold color="cyan">
          Keys
        </Text>
        <Box flexDirection="column" height={room}>
          {rows.slice(start, start + room).map(([k, v], i) => (
            <Text key={i} wrap="truncate" bold={!v && Boolean(k)}>
              {v ? `${k.padEnd(20)}${v}` : k || ' '}
            </Text>
          ))}
        </Box>
        <Text dimColor wrap="truncate">
          ↑↓ scroll · Esc or ? close · change keys in ~/.anchi/keybindings.json (`anchi keys`)
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'palette') {
    const entries = paletteEntries(keymap, modal.context, modal.query);
    const room = Math.max(3, height - 6);
    const first = Math.max(0, modal.cursor - room + 1);
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold color="cyan">
          Commands · {CONTEXT_LABEL[modal.context]}
        </Text>
        <Box borderStyle="single" paddingX={1}>
          <Text>
            {sanitizeLine(modal.query)}
            <Text inverse> </Text>
          </Text>
        </Box>
        <Box flexDirection="column" height={room}>
          {entries.length ? (
            entries.slice(first, first + room).map((e, i) => (
              <Text key={e.action} inverse={first + i === modal.cursor} wrap="truncate">
                {`${truncate(e.title, inner - 22).padEnd(inner - 20)}${e.keys}`}
              </Text>
            ))
          ) : (
            <Text dimColor>No command matches.</Text>
          )}
        </Box>
        <Text dimColor>Type to filter · ↑↓ choose · Enter run · Esc close</Text>
      </Box>
    );
  }
  if (modal.kind === 'text') {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold color="cyan">
          {modal.title}
        </Text>
        <Text>{modal.label}</Text>
        <Box borderStyle="single" paddingX={1}>
          <Text>{sanitizeLine(modal.input)}█</Text>
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>
          Enter confirm · Esc cancel · this screen is drawn by Anchi, not by an agent
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'confirm') {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="yellow"
        paddingX={2}
      >
        <Text bold color="yellow">
          {modal.title}
        </Text>
        <Text>{modal.body}</Text>
        <Box flexGrow={1} />
        <Text bold>[y] confirm · [n] cancel</Text>
      </Box>
    );
  }
  if (modal.kind === 'settings') {
    const frame = (children: React.ReactNode, foot: string) => (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold color="cyan">
          {modal.proposalId
            ? `Proposal for @${modal.agentId}: settings`
            : `@${modal.agentId}: settings`}
        </Text>
        {children}
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate">
          {foot}
        </Text>
      </Box>
    );
    if (!modal.data || !modal.state) return frame(<Text dimColor>Loading…</Text>, 'Esc close');
    const rows = settingsRows(modal.data, modal.state);
    const items = rows.filter((r) => r.kind !== 'header');
    const at = rows.indexOf(items[modal.cursor]!);
    const room = Math.max(3, height - 5);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), rows.length - room));
    return frame(
      <Box flexDirection="column" height={room}>
        {rows.slice(first, first + room).map((r, i) =>
          r.kind === 'header' ? (
            <Text key={i} dimColor bold={!r.text.startsWith(' ')} wrap="truncate">
              {r.text}
            </Text>
          ) : (
            <Text key={i} inverse={first + i === at} wrap="truncate">
              {`${r.mark.padEnd(5)}${truncate(sanitizeLine(r.label), 30).padEnd(31)}`}
              <Text dimColor={first + i !== at}>
                {truncate(sanitizeLine(r.note), Math.max(10, inner - 38))}
              </Text>
            </Text>
          ),
        )}
      </Box>,
      `↑↓ choose · Space ${'select (workspaces: off → ro → rw)'} · Enter ${modal.proposalId ? 'update the proposal' : 'review the change'} · Esc cancel`,
    );
  }
  if (modal.kind === 'settingsReview') {
    const u = modal.update;
    const lines = sanitize(u.diff || '(no change)').split('\n');
    const room = Math.max(3, height - 7 - u.errors.length - u.warnings.length);
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="magenta"
        paddingX={2}
      >
        <Text bold color="magenta">
          @{modal.agentId}: save these settings?
        </Text>
        <Box flexDirection="column" height={room}>
          {lines.slice(0, room).map((l, i) => (
            <Text
              key={i}
              wrap="truncate"
              color={l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined}
            >
              {truncate(l, inner) || ' '}
            </Text>
          ))}
        </Box>
        {u.errors.map((e, i) => (
          <Text key={`e${i}`} color="red" wrap="truncate">
            {`✗ ${sanitizeLine(e)}`}
          </Text>
        ))}
        {u.warnings.map((w, i) => (
          <Text key={`w${i}`} color="yellow" wrap="truncate">
            {`! ${sanitizeLine(w)}`}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text
          bold
        >{`${u.errors.length ? '' : '[y] save · '}[n] back to the settings · Esc back`}</Text>
      </Box>
    );
  }
  const p = modal.proposal;
  const body: { text: string; color?: string }[] = [];
  const add = (text: string, color?: string) => {
    for (const line of sanitize(text).split('\n'))
      body.push({ text: truncate(line, inner), color });
  };
  add(`Agent @${p.agentId}`);
  for (const l of (p.agentDiff || '(unchanged)').split('\n'))
    add(l, l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined);
  if (p.imageYaml) {
    add('');
    add('Image recipe (built in a proxy-only build cell; commands run as root in the image)');
    for (const l of (p.imageDiff || '(unchanged)').split('\n'))
      add(l, l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined);
  }
  const room = height - 6 - (p.errors.length ? p.errors.length + 1 : 0) - (p.warnings?.length ?? 0);
  const start = Math.min(modal.scroll, Math.max(0, body.length - room));
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="double"
      borderColor="magenta"
      paddingX={2}
    >
      <Text bold color="magenta">
        Builder proposal — review before anything is written
      </Text>
      <Box flexDirection="column" height={room}>
        {body.slice(start, start + room).map((l, i) => (
          <Text key={i} color={l.color} wrap="truncate">
            {l.text || ' '}
          </Text>
        ))}
      </Box>
      {p.errors.length ? (
        <Box flexDirection="column">
          <Text color="red" bold>
            Cannot apply:
          </Text>
          {p.errors.map((e, i) => (
            <Text key={i} color="red" wrap="truncate">
              {truncate(sanitizeLine(e), inner)}
            </Text>
          ))}
        </Box>
      ) : null}
      {(p.warnings ?? []).map((w, i) => (
        <Text key={`w${i}`} color="yellow" wrap="truncate">
          {`! ${truncate(sanitizeLine(w), inner - 2)}`}
        </Text>
      ))}
      <Text bold>
        {`${p.errors.length ? '' : '[y] write these files · '}[s] settings · [n] discard · Esc decide later (${label('builder:proposal')}) · ↑↓ scroll`}
      </Text>
    </Box>
  );
}
