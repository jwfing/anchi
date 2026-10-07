/** @jsxRuntime automatic */
import type {
  AgentSummary,
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
  | { kind: 'help' }
  | { kind: 'approval'; approval: Approval }
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

export function App({ client, initialAgents, initialTasks, onMouse, compose }: AppProps) {
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
  const [input, setInput] = useState('');
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

  // A new held write opens its dialog unless another dialog is up; ^A reopens it.
  useEffect(() => {
    const fresh = approvals.find((a) => !seenApprovals.current.has(a.id));
    for (const a of approvals) seenApprovals.current.add(a.id);
    if (fresh && !modal) setModal({ kind: 'approval', approval: fresh });
    if (modal?.kind === 'approval' && !approvals.some((a) => a.id === modal.approval.id)) {
      setModal(null);
    }
  }, [approvals, modal]);
  useEffect(() => {
    void client
      .call('approvals.list')
      .then((list) => setApprovals(list ?? []))
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
      client.on('approvals', ({ approvals: next }) => setApprovals(next)),
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
  const mainWidth = Math.max(30, columns - SIDEBAR_WIDTH);
  const textWidth = mainWidth - 4;
  const bodyHeight = rows - 1;
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
  /** ^T: expands every tool-call group of the shown task, or collapses them all. */
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

  const submit = (raw = input) => {
    const text = raw.trim();
    if (!text || !agent) return;
    setInput('');
    setScroll(0);
    if (text === '/new') {
      setFocusTask((f) => ({ ...f, [agent.id]: null }));
      return say('the next message starts a new task');
    }
    if (text === '/verbose') return setVerbose((v) => !v);
    if (text === '/quit') return exit();
    const followUp = task && task.status !== 'running' && task.status !== 'queued';
    if (task && !followUp) return say('wait for the current turn to finish, or Esc to cancel it');
    const call = followUp
      ? client.call('tasks.send', { taskId: task.id, text })
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
    }).then(() => setInput(result.replace(/\n+$/, '')));
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

  usePaste((text) => {
    if (modal?.kind === 'secret' || modal?.kind === 'text') editModalInput((v) => v + text.trim());
    else if (!modal && agent) setInput((v) => v + text);
  });

  useInput((ch, key) => {
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
      if (key.escape || key.return || ch === 'q' || ch === '?') setModal(null);
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

    // ── global ──
    if (key.ctrl && ch === 'n') return move(1);
    if (key.ctrl && ch === 'p') return move(-1);
    if (key.ctrl && ch === 'c') return exit();
    if (key.ctrl && ch === 'o' && proposals.length) {
      return setModal({ kind: 'proposal', proposal: proposals.at(-1)!, scroll: 0 });
    }
    if (key.ctrl && ch === 't') return toggleAllGroups();
    if (key.ctrl && ch === 'v') return setVerbose((v) => !v);
    if (key.ctrl && ch === 'a' && approvals.length) {
      return setModal({ kind: 'approval', approval: approvals[0]! });
    }
    if (key.tab) return setFocus((f) => (f === 'side' ? 'main' : 'side'));

    // ── sidebar ──
    if (focus === 'side') {
      if (key.upArrow || ch === 'k') return move(-1);
      if (key.downArrow || ch === 'j') return move(1);
      if (key.home || ch === 'g') return setSelected(items[0]);
      if (key.end || ch === 'G') return setSelected(items.at(-1));
      if (key.pageUp || ch === '[') return turnPage(page - 1, true);
      if (key.pageDown || ch === ']') return turnPage(page + 1, true);
      if (ch === '1') return setSelected(CONFIG[0]);
      if (ch === '2') return setSelected(BUILDER);
      if (ch === '3') return turnPage(page, true);
      if (key.return || key.rightArrow || ch === 'l') return setFocus('main');
      if (ch === '?') return setModal({ kind: 'help' });
      if (ch === '/') {
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
      }
      if (ch === 'q') return exit();
      return;
    }
    // In the main pane, Esc (and ← outside the chat) goes back to the sidebar.
    const back = () => setFocus('side');

    // ── task detail ──
    if (detail) {
      if (ch === 'q') return exit();
      if (ch === '?') return setModal({ kind: 'help' });
      if (key.escape || key.leftArrow || ch === 'h') return back();
      if (key.return) {
        // Continue the task in its agent's chat.
        setFocusTask((f) => ({ ...f, [detail.agentId]: detail.id }));
        return setSelected(detail.agentId);
      }
      if (ch === 'c' && (detail.status === 'running' || detail.status === 'queued')) {
        return void client
          .call('tasks.cancel', { taskId: detail.id })
          .catch((e: Error) => say(e.message));
      }
      if (ch === '[') return turnPage(page - 1);
      if (ch === ']') return turnPage(page + 1);
      if (ch === 'D' && detail.status !== 'running' && detail.status !== 'queued') {
        return setModal({
          kind: 'confirm',
          title: `Delete ${detail.id}`,
          body: `Delete this task, the tasks it delegated and their transcripts from ~/.anchi. This cannot be undone.`,
          action: async () => {
            await client.call('tasks.delete', { taskId: detail.id });
            setSelected(detail.agentId);
          },
        });
      }
      if (key.pageUp)
        return setScroll((s) => Math.min(maxScroll, s + Math.floor(transcriptHeight / 2)));
      if (key.pageDown) return setScroll((s) => Math.max(0, s - Math.floor(transcriptHeight / 2)));
      if (key.upArrow || ch === 'k') return setScroll((s) => Math.min(maxScroll, s + 1));
      if (key.downArrow || ch === 'j') return setScroll((s) => Math.max(0, s - 1));
      return;
    }

    // ── menu views ──
    if (isMenu) {
      if (ch === 'q') return exit();
      if (ch === '?') return setModal({ kind: 'help' });
      if (key.escape || key.leftArrow || ch === 'h') return back();
      if (current === 'skills') {
        const list = skills ?? [];
        if (key.upArrow || ch === 'k') return setSkillCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || ch === 'j')
          return setSkillCursor((c) => Math.min(list.length - 1, c + 1));
        if (ch === 'a') {
          return setModal({
            kind: 'text',
            title: 'Add a skill',
            label:
              'A local directory with a SKILL.md, or a GitHub URL such as https://github.com/owner/repo/tree/main/skills/name (fetched at its current commit)',
            input: '',
            submit: async (source) => {
              const skill = await client.call('skills.add', { source: source.trim() });
              refreshSkills();
              say(`skill ${skill.id} added; assign it with skills: [${skill.id}] in an agent`);
            },
          });
        }
        const skill = list[skillCursor];
        if (ch === 'd' && skill) {
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
      if (current === 'connectors') {
        const ids: ConnectorId[] = ['github', 'aws', 'linear'];
        const services: ServiceConnectorId[] = ['gmail', 'drive', 'notion', 'slack'];
        if (key.upArrow || ch === 'k') return setConnectorCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || ch === 'j')
          return setConnectorCursor((c) => Math.min(ids.length + services.length - 1, c + 1));
        if (connectorCursor >= ids.length) {
          const sid = services[connectorCursor - ids.length]!;
          const status = setup?.services?.find((x) => x.id === sid);
          if (key.return || ch === 'c') {
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
              const { url } = await client.call('services.googleLogin', { id: sid });
              say(`sign in to Google in your browser (${url.slice(0, 60)}…)`);
            }, `opened Google sign-in for ${sid}`);
          }
          if (ch === 'm' && status) {
            const mode = status.mode === 'ask' ? 'auto' : 'ask';
            return runAction(
              () => client.call('services.setMode', { id: sid, mode }),
              `${sid} writes: ${mode === 'ask' ? 'ask for approval' : 'automatic'}`,
            );
          }
          if (ch === 'd' && status?.connected) {
            return setModal({
              kind: 'confirm',
              title: `Disconnect ${sid}`,
              body: `Remove the ${sid} credential from the vault${sid === 'gmail' || sid === 'drive' ? ' and revoke it at Google' : ''}.`,
              action: () => client.call('services.disconnect', { id: sid }),
            });
          }
          return;
        }
        const id = ids[connectorCursor]!;
        if (key.return || ch === 'c') return openConnector(id);
        if (ch === 'g' && id === 'github') {
          return setModal({
            kind: 'confirm',
            title: 'Import the gh CLI token',
            body:
              'Read the token the GitHub CLI on this Mac is logged in with (`gh auth token`) and store ' +
              'it in the VM vault. It carries every scope of your gh login, usually broader than a ' +
              'fine-grained token limited to the repositories the agents need.',
            action: () => client.call('connectors.importGh'),
          });
        }
        if (ch === 'p' && id === 'aws') {
          return setModal({
            kind: 'text',
            title: 'Connect AWS through a profile',
            label:
              'AWS profile on this Mac (for SSO, run `aws sso login --profile …` first). Anchi ' +
              'exports its temporary credentials and refreshes them before they expire.',
            input: '',
            submit: (profile) => client.call('connectors.awsProfile', { profile }),
          });
        }
        if (ch === 'd') {
          return setModal({
            kind: 'confirm',
            title: `Disconnect ${id}`,
            body: `Remove the ${id} credential from the vault. Agents with this connector lose access.`,
            action: () => client.call('connectors.remove', { id }),
          });
        }
      }
      if (current === 'runtimes' && (ch === 's' || ch === 'I' || ch === 'u')) {
        const step = (
          {
            s: ['vm-start', 'Start the VM', 'Start the secure-vm VM.'],
            I: [
              'install',
              'Install or update',
              'Create or update the secure-vm VM, install the trusted services and the agent ' +
                'team, and build the base image. This takes several minutes.',
            ],
            u: [
              'vault-unlock',
              'Unlock the vault',
              'Send the vault key from ~/.config/secure-vm/vault.key on this Mac to the VM, ' +
                'where it is kept in memory only.',
            ],
          } as const
        )[ch];
        const [action, title, body] = step;
        return setModal({
          kind: 'confirm',
          title,
          body,
          action: () => {
            setSetupLog([]);
            return client.call('setup.run', { action });
          },
        });
      }
      if (current === 'runtimes' && ch === 'c') {
        return setModal({ kind: 'secret', connector: 'claude', index: 0, values: {}, input: '' });
      }
      if (current === 'runtimes' && ch === 'i') {
        return setModal({
          kind: 'confirm',
          title: 'Import Codex login',
          body:
            'Read the access token and account id from ~/.codex/auth.json on this Mac and store them in the ' +
            'VM vault. The refresh token stays on this Mac. Cells never receive the token.',
          action: () => client.call('setup.importCodex'),
        });
      }
      if (ch === 'r') return refreshSetup();
      return;
    }

    // ── agent chat ──
    if (key.ctrl && ch === 'x') {
      setFocusTask((f) => ({ ...f, [current]: null }));
      return say('the next message starts a new task');
    }
    if (key.ctrl && ch === 'e') return editDraft();
    if (key.ctrl && ch === 'u') return setInput('');
    if (key.pageUp)
      return setScroll((s) => Math.min(maxScroll, s + Math.floor(transcriptHeight / 2)));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - Math.floor(transcriptHeight / 2)));
    if (key.upArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
    if (key.downArrow) return setScroll((s) => Math.max(0, s - 1));
    if (key.escape) {
      // Esc first cancels a running turn, then clears the draft, then leaves the chat.
      if (task && (task.status === 'running' || task.status === 'queued')) {
        void client.call('tasks.cancel', { taskId: task.id });
        return say(`cancelling ${task.id}`);
      }
      if (input) return setInput('');
      return back();
    }
    if (key.return) return submit();
    if (key.backspace || key.delete) return setInput((v) => [...v].slice(0, -1).join(''));
    if (ch && !key.ctrl && !key.meta) {
      // Fast typing or a non-bracketed paste can deliver text and Enter in one chunk.
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) return submit(input + ch.slice(0, nl));
      setInput((v) => v + ch);
    }
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
        <ModalView modal={modal} width={columns} height={rows} />
      </Box>
    );
  }

  const header = detail
    ? `${detail.id} · @${detail.agentId} · ${detail.status}${detail.parentId ? ` · delegated by ${detail.parentId}` : ''}${detail.trigger !== 'user' && detail.trigger !== 'delegation' ? ` · ${detail.trigger}` : ''}`
    : agent
      ? `@${agent.id} · ${sanitizeLine(agent.name)}  ${agent.runtime ?? ''} · ${agent.connectors.join(', ') || 'no connectors'}${
          agent.triggers ? ` · ⏰ ${agent.triggers}` : ''
        }${task ? ` · ${task.id} (${task.status})` : ' · new task'}`
      : CONFIG_LABEL[current as ConfigItem];
  const busy = detail?.status === 'running' || detail?.status === 'queued';
  const status =
    flash ||
    (focus === 'side'
      ? '↑↓ select · Enter/→ open · [ ] task page · / filter tasks · 1 2 3 sections · Tab pane · ? help'
      : detail
        ? `Enter continue in @${detail.agentId}${busy ? ' · c cancel' : ' · D delete'} · ↑↓ PgUp/PgDn scroll · [ ] page · ^T tools · Esc sidebar · ? help`
        : agent
          ? 'Enter send · ^X new task · Esc cancel/sidebar · ^E editor · ^T tools · ^V verbose · PgUp/PgDn · Tab sidebar'
          : current === 'connectors'
            ? '↑↓ choose · Enter connect · g github from gh · p aws profile · m service writes auto/ask · d disconnect · Esc'
            : current === 'skills'
              ? '↑↓ choose · a add · d remove · Esc sidebar'
              : current === 'runtimes'
                ? 's start VM · I install · u unlock vault · i Codex login · c Claude token · r refresh · Esc sidebar'
                : 'Esc sidebar · ? help · q quit') + (proposals.length ? ' · ^O proposal' : '');
  const statusLine = approvals.length
    ? `⏸ ${approvals.length} write${approvals.length === 1 ? '' : 's'} waiting for approval (^A) · ${status}`
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
                <Text wrap="truncate-start">
                  <Text color="cyan">› </Text>
                  {input}
                  <Text inverse> </Text>
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
      <Text dimColor wrap="truncate">
        {statusLine}
      </Text>
    </Box>
  );
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

function ModalView({ modal, width, height }: { modal: Modal; width: number; height: number }) {
  const inner = width - 6;
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
        <Text>{`task       ${sanitizeLine(a.task)}`}</Text>
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
        <Text bold>[y] approve · [n] deny · Esc decide later (^A)</Text>
      </Box>
    );
  }
  if (modal.kind === 'help') {
    const keys: [string, string][] = [
      ['Tab / Shift+Tab', 'switch between the sidebar and the main pane (or click either)'],
      ['Ctrl+N / Ctrl+P', 'next / previous sidebar item, from anywhere'],
      ['', ''],
      ['Sidebar', ''],
      ['↑ ↓  k j', 'move'],
      ['Home End  g G', 'first / last item'],
      ['1 2 3', 'Configure / Agents / Tasks'],
      ['PgUp PgDn  [ ]', 'previous / next page of tasks (or the wheel, or ‹ prev / next ›)'],
      ['/', 'filter tasks: @agent, status:failed, words'],
      ['Enter → l', 'open the item in the main pane'],
      ['', ''],
      ['Main pane', ''],
      ['Esc', 'chat: cancel the running turn, then clear the draft, then back to the sidebar'],
      ['Esc ← h', 'other views: back to the sidebar'],
      ['↑ ↓  PgUp PgDn', 'scroll the transcript (or the wheel)'],
      ['Enter', 'chat: send · task: continue it in the chat · connectors: connect'],
      ['c  D', 'task: cancel it · delete it with its delegated tasks'],
      ['Ctrl+X  Ctrl+E', 'chat: new task · compose in $EDITOR'],
      ['Ctrl+T  Ctrl+V', 'expand tool calls (or click one) · verbose tool output'],
      ['Ctrl+O', 'reopen the pending builder proposal'],
      ['Ctrl+A', 'review a write waiting for your approval'],
      ['q  Ctrl+C', 'quit (the daemon and running tasks keep going)'],
    ];
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
        {keys.map(([k, v], i) => (
          <Text key={i} wrap="truncate" bold={!v && Boolean(k)}>
            {v ? `${k.padEnd(18)}${v}` : k || ' '}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text dimColor>Esc or ? to close</Text>
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
  const room = height - 6 - (p.errors.length ? p.errors.length + 1 : 0);
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
      <Text bold>
        {p.errors.length ? '' : '[y] write these files · '}[n] discard · Esc decide later (^O) · ↑↓
        scroll
      </Text>
    </Box>
  );
}
