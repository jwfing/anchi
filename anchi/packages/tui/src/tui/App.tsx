/** @jsxRuntime automatic */
import type {
  AccessSummary,
  QuotaInfo,
  TaskAudit,
  UsageRow,
  AgentDeletionPreview,
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
  SetupAction,
  RuntimeId,
  VmSize,
  StoredEvent,
  TaskRow,
  TaskStatus,
} from '@anchi/protocol';
import { CONNECTOR_IDS } from '@anchi/protocol';
import type { DaemonClient } from '@anchi/daemon';
import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitize, sanitizeLine } from '@anchi/core';
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
import { type Draft, draftOf, EMPTY_DRAFT, edit, insert, inputRows } from './lineedit.ts';
import {
  accessLines,
  accessSummaryLines,
  GROUPS,
  PERIODS,
  refusedHosts,
  type ReportLine,
  usageLines,
} from './reports.ts';
import {
  initialSettings,
  isTextField,
  MODEL,
  type SettingsRow,
  type SettingsState,
  settingsPatch,
  settingsRows,
  TEXT_FIELDS,
  type TextField,
  toggleSetting,
} from './settings.ts';
import { type Line, type Tone, transcriptLines, truncate, wrap } from './lines.ts';
import type { MouseEvent } from './mouse.ts';
import { completePath, type PathKind } from './pathcomplete.ts';
import { ApprovalsView, TeamView, WelcomeView } from './UsabilityViews.tsx';
import {
  agentTaskLines,
  welcomeStep,
  nextSetupAction,
  runtimeReady,
  recoveryFor,
  continued,
  resultLines,
  setupPhase,
  turnActivity,
  suggestedRuntime,
  FIRST_TASK,
} from './usability.ts';

export const SIDEBAR_WIDTH = 28;
const BUILDER = 'builder';
const STARTER_RUNTIMES = ['codex', 'claude-code', 'hermes'] as const;
const HOME = ['welcome', 'team', 'approvals'] as const;
const CONFIG = ['runtimes', 'skills', 'connectors', 'usage', 'access'] as const;
type ConfigItem = (typeof CONFIG)[number] | (typeof HOME)[number];
const CONFIG_LABEL: Record<ConfigItem, string> = {
  welcome: 'Getting started',
  team: 'Team overview',
  approvals: 'Approvals',
  runtimes: 'Runtimes',
  skills: 'Skills',
  connectors: 'Connectors',
  usage: 'Usage',
  access: 'Access',
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
  return 1 + 4 + HOME.length + CONFIG.length + 1 + Math.max(1, agentCount);
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
/** The Google account used when an agent names none (accounts connected before are this one). */
const DEFAULT_ACCOUNT = 'default';
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

/** One transcript row: its tone, and the styled runs of rendered markdown when it has them. */
function LineText({ line }: { line: Line }) {
  return (
    <Text {...TONE[line.tone]} wrap="truncate">
      {line.spans?.length
        ? line.spans.map((s, i) => (
            <Text
              key={i}
              bold={s.bold}
              italic={s.italic}
              underline={s.underline}
              strikethrough={s.strike}
              dimColor={s.dim}
              color={s.code ? 'green' : undefined}
            >
              {s.text}
            </Text>
          ))
        : line.text || ' '}
    </Text>
  );
}

type SecretField = { key: string; label: string; masked: boolean; optional?: boolean };
/** Masked inputs: connector credentials, the Claude Code token and Hermes's endpoint. */
type SecretTarget = ConnectorId | 'claude' | 'hermes' | 'notion' | 'slack';
const serviceIds: ServiceConnectorId[] = ['gmail', 'drive', 'notion', 'slack', 'x', 'reddit'];
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
  hermes: [
    {
      key: 'baseUrl',
      label: 'Base URL of an OpenAI-compatible API, e.g. https://openrouter.ai/api/v1',
      masked: false,
    },
    { key: 'apiKey', label: 'API key for that endpoint (stays in the VM vault)', masked: true },
    { key: 'model', label: 'Default model, e.g. nousresearch/hermes-4-405b', masked: false },
  ],
  github: [{ key: 'token', label: 'GitHub fine-grained token (github_pat_…)', masked: true }],
  linear: [{ key: 'token', label: 'Linear API key (lin_api_…)', masked: true }],
  posthog: [{ key: 'token', label: 'PostHog personal API key (phx_…)', masked: true }],
  sentry: [{ key: 'token', label: 'Sentry user auth token (sntryu_…)', masked: true }],
  firecrawl: [{ key: 'token', label: 'Firecrawl API key (fc-…)', masked: true }],
  figma: [{ key: 'token', label: 'Figma personal access token (figd_…)', masked: true }],
  discord: [{ key: 'token', label: 'Discord bot token', masked: true }],
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
  | { kind: 'createAgent'; pick: number }
  | { kind: 'quickSetup'; pick: number }
  | {
      kind: 'problem';
      message: string;
      retry?: () => Promise<unknown>;
      taskId?: string;
      scroll: number;
    }
  | { kind: 'setupLog'; scroll: number }
  | { kind: 'composeReview'; text: string; target: string; send: () => void; scroll: number }
  | { kind: 'proposal'; proposal: BuilderProposal; scroll: number }
  | {
      kind: 'secret';
      connector: SecretTarget;
      index: number;
      values: Record<string, string>;
      input: string;
      /** Tab shows a masked field's input to check it; the next field starts masked again. */
      revealed?: boolean;
    }
  | { kind: 'confirm'; title: string; body: string; action: () => Promise<unknown> }
  | { kind: 'help'; context: Context; scroll: number }
  | { kind: 'palette'; context: Context; active: Context[]; query: string; cursor: number }
  | { kind: 'approval'; approval: Approval; scroll: number; decision?: boolean }
  | {
      kind: 'settings';
      agentId: string;
      /** Set when the panel edits a builder proposal instead of the agent's file. */
      proposalId?: string;
      data: AgentSettings | null;
      state: SettingsState | null;
      cursor: number;
      /** A text field being typed in the panel. */
      editing?: { field: TextField; input: string; error?: string };
    }
  | { kind: 'retry'; taskId: string; agentId: string; status: TaskStatus }
  | {
      kind: 'access';
      taskId: string;
      agentId: string;
      data: TaskAudit | null;
      scroll: number;
      error?: string;
      /** Choosing a refused host to allow: its index in refusedHosts. */
      pick?: number;
    }
  | {
      kind: 'deleteAgent';
      agentId: string;
      preview: AgentDeletionPreview | null;
      /** What the user typed; the agent id confirms. */
      input: string;
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
      /** A path on this computer: Tab completes it. */
      paths?: PathKind;
      /** Entries listed by the last Tab with several matches. */
      candidates?: string[];
    };

export interface AppProps {
  client: DaemonClient;
  initialAgents: AgentSummary[];
  initialTasks: TaskRow[];
  initialView?: string;
  onMouse?(handler: (e: MouseEvent) => void): void;
  /** Turns the terminal's mouse reporting on or off (off: the terminal selects text natively). */
  setMouse?(on: boolean): void;
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
  initialView,
  onMouse,
  setMouse,
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
  const [selected, setSelected] = useState<string | undefined>(initialView);
  // Which pane takes the keys: the sidebar or the main pane (chat, task, settings).
  const [focus, setFocus] = useState<'side' | 'main'>('main');
  const [taskPage, setTaskPage] = useState(0);
  // `@agent status:failed words` over the loaded tasks; empty shows all.
  const [taskFilter, setTaskFilter] = useState('');
  const [focusTask, setFocusTask] = useState<Record<string, string | null>>({});
  const [logs, setLogs] = useState<Record<string, StoredEvent[]>>({});
  // Keys of a chord typed so far (the leader, then more); a ref so one input chunk sees them all.
  const [pending, setPendingState] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drafts = useRef<Record<string, Draft>>({});
  const draftRef = useRef<Draft>(EMPTY_DRAFT);
  const [, renderDraft] = useState(0);
  const [scrolls, setScrolls] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<Record<string, boolean>>({});
  const [teamCursor, setTeamCursor] = useState(0);
  const [approvalCursor, setApprovalCursor] = useState(0);
  /** y or n pressed in the Approvals view for one write; Enter confirms it. */
  const [approvalPick, setApprovalPick] = useState<{ id: string; allow: boolean } | null>(null);
  /** Ticks every second while the Approvals view counts down its writes' timeouts. */
  const [clock, setClock] = useState(() => Date.now());
  const sending = useRef(new Set<string>());
  const [connectorCursor, setConnectorCursor] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillCursor, setSkillCursor] = useState(0);
  const [usage, setUsage] = useState<{ rows: UsageRow[] | null; quota: QuotaInfo[] | null }>({
    rows: null,
    quota: null,
  });
  const [usagePeriod, setUsagePeriod] = useState(1);
  const [usageGroup, setUsageGroup] = useState(0);
  const refreshUsage = useCallback(
    (period: number, group: number) => {
      setUsage({ rows: null, quota: null });
      void client
        .call('usage.summary', { since: Date.now() - PERIODS[period]!.ms, by: GROUPS[group] })
        .then((rows) => setUsage((u) => ({ ...u, rows })))
        .catch(() => setUsage((u) => ({ ...u, rows: [] })));
      void client
        .call('usage.quota')
        .then((quota) => setUsage((u) => ({ ...u, quota })))
        .catch(() => setUsage((u) => ({ ...u, quota: [] })));
    },
    [client],
  );
  const [access, setAccess] = useState<AccessSummary | null>(null);
  const [accessPeriod, setAccessPeriod] = useState(1);
  const refreshAccess = useCallback(
    (period: number) => {
      setAccess(null);
      void client
        .call('access.summary', { since: Date.now() - PERIODS[period]!.ms })
        .then(setAccess)
        .catch((e: Error) => reportProblem(e));
    },
    [client],
  );
  const refreshSkills = useCallback(() => {
    void client
      .call('skills.list')
      .then((list) => {
        const sorted = sortSkills(list ?? []);
        setSkills(sorted);
        // Removing the last skill leaves the cursor past the end.
        setSkillCursor((c) => Math.max(0, Math.min(c, sorted.length - 1)));
      })
      .catch(() => setSkills([]));
  }, [client]);
  const [verbose, setVerbose] = useState(false);
  // Tool-call groups the user expanded, by group id (`<task>:g<seq>`).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  // Selection mode: mouse reporting off, transcript full width without borders, so the
  // terminal's own selection copies clean text.
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    if (selecting) {
      setMouse?.(false);
      return () => setMouse?.(true);
    }
  }, [selecting, setMouse]);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [proposals, setProposals] = useState<BuilderProposal[]>([]);
  // Writes the egress proxy holds for the user, oldest first.
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [problem, setProblem] = useState<{
    message: string;
    retry?: () => Promise<unknown>;
    taskId?: string;
  } | null>(null);
  const [setupProgress, setSetupProgress] = useState<{
    action: SetupAction;
    phase: string;
    running: boolean;
    failed?: boolean;
    /** When the step started, for the elapsed time next to the phase. */
    startedAt: number;
  } | null>(null);
  const setupRunning = useRef(false);
  const watchingPreparation = useRef(false);
  const quickRuntime = useRef<RuntimeId | null>(null);
  // A notification is newer than the initial list; a late list answer must not undo it.
  const approvalsNotified = useRef(false);
  const [flash, setFlash] = useState('');
  const loading = useRef(new Set<string>());
  /** Live events of a task whose history is still being fetched, by task. */
  const arriving = useRef<Record<string, StoredEvent[]>>({});

  const userAgents = agents.filter((a) => a.id !== BUILDER);
  const shownTasks = useMemo(() => filterTasks(tasks, taskFilter), [tasks, taskFilter]);
  const items: string[] = [
    ...HOME,
    ...CONFIG,
    BUILDER,
    ...userAgents.map((a) => a.id),
    ...shownTasks.map((t) => TASK_ITEM + t.id),
  ];
  // Selection is by item, so new tasks arriving at the top do not move it.
  const current = selected && items.includes(selected) ? selected : (userAgents[0]?.id ?? BUILDER);
  const isMenu = ([...HOME, ...CONFIG] as readonly string[]).includes(current);
  const detail = current.startsWith(TASK_ITEM)
    ? tasks.find((t) => TASK_ITEM + t.id === current)
    : undefined;
  const agent = isMenu || detail ? undefined : agents.find((a) => a.id === current);
  const frame = useSpinner(
    tasks.some((t) => t.status === 'running') || Boolean(setupProgress?.running),
  );

  const say = useCallback((msg: string) => {
    setFlash(sanitizeLine(msg));
    setTimeout(() => setFlash((f) => (f === sanitizeLine(msg) ? '' : f)), 5000);
  }, []);

  const reportProblem = useCallback(
    (error: unknown, retry?: () => Promise<unknown>, taskId?: string) => {
      const message = sanitize(error instanceof Error ? error.message : String(error));
      setProblem((previous) => ({
        message,
        retry: retry ?? (previous?.message === message ? previous.retry : undefined),
        taskId: taskId ?? (previous?.message === message ? previous.taskId : undefined),
      }));
    },
    [],
  );

  const refreshSetup = useCallback(() => {
    void client
      .call('setup.status')
      .then(setSetup)
      .catch((e: Error) => reportProblem(e, () => client.call('setup.status')));
  }, [client, reportProblem]);
  useEffect(refreshSetup, [refreshSetup]);
  useEffect(() => {
    if (!setup?.preparing) {
      if (watchingPreparation.current && !setupRunning.current) setSetupProgress(null);
      watchingPreparation.current = false;
      return;
    }
    watchingPreparation.current = true;
    const timer = setInterval(refreshSetup, 3000);
    return () => clearInterval(timer);
  }, [setup?.preparing, refreshSetup]);

  // Pending approvals never steal input focus. Only an explicit review action opens one.
  useEffect(() => {
    if (modal?.kind === 'approval' && !approvals.some((a) => a.id === modal.approval.id))
      setModal(null);
  }, [approvals, modal]);
  // The Approvals view: the chosen row stays in range, and a choice dies with its write.
  useEffect(() => {
    setApprovalCursor((c) => Math.min(c, Math.max(0, approvals.length - 1)));
    setApprovalPick((p) => (p && approvals.some((a) => a.id === p.id) ? p : null));
  }, [approvals]);
  useEffect(() => {
    if (current !== 'approvals' || !approvals.length) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current, approvals.length]);
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
        const stored = { seq, ts: Date.now(), event };
        // While the history is being fetched, keep what arrives meanwhile for the fetch to
        // merge (kept here, not in state: a state updater runs later, when the fetch may be
        // over). A task nobody looks at is not kept.
        if (loading.current.has(taskId)) (arriving.current[taskId] ??= []).push(stored);
        setLogs((all) => {
          const cur = all[taskId];
          if (!cur) return all;
          if (cur.length && cur.at(-1)!.seq >= seq) return all;
          return { ...all, [taskId]: [...cur, stored] };
        });
      }),
      client.on('setup', ({ action, line }) => {
        setSetupLog((log) => [...log, sanitizeLine(line)].slice(-500));
        setSetupProgress((p) => ({
          action,
          running: true,
          startedAt: p?.running ? p.startedAt : Date.now(),
          phase:
            /download|fetch|pulling|runtime image|anchi-image|base image|rootfs|debootstrap|install-anchi|bootstrap|trusted|egress|services/i.test(
              line,
            ) || line.startsWith('$ ')
              ? setupPhase(action, line)
              : (p?.phase ?? setupPhase(action, line)),
        }));
      }),
      client.on('approvals', ({ approvals: next }) => {
        approvalsNotified.current = true;
        setApprovals(next);
      }),
      client.on('oauth', ({ id, account, ok, error }) => {
        const which = account && account !== DEFAULT_ACCOUNT ? `${id} (${account})` : id;
        say(ok ? `${which} connected` : `${which}: ${error ?? 'sign-in failed'}`);
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
    if (current === 'runtimes' || current === 'connectors' || current === 'welcome') refreshSetup();
    if (current === 'skills') refreshSkills();
    if (current === 'usage') refreshUsage(usagePeriod, usageGroup);
    if (current === 'access') refreshAccess(accessPeriod);
  }, [current, refreshSetup]);

  const agentTasks = agent ? tasks.filter((t) => t.agentId === agent.id) : [];
  // The builder is one conversation: its view continues a task. Every other agent's view lists
  // its tasks and starts a new one with each message; a task's own view continues it.
  const chatMode = agent?.id === BUILDER;
  // The builder's task shown: the one chosen, else its latest; null means "new task".
  const chosen = agent ? focusTask[agent.id] : undefined;
  const task = detail
    ? detail
    : !chatMode || chosen === null
      ? undefined
      : (agentTasks.find((t) => t.id === chosen) ?? agentTasks[0]);

  const conversationKey = `${current}:${task?.id ?? 'new'}`;
  const draftKey = useRef(conversationKey);
  draftKey.current = conversationKey;
  const draft = drafts.current[conversationKey] ?? EMPTY_DRAFT;
  draftRef.current = draft;
  const input = draft.text;
  const setDraft = (next: Draft | ((d: Draft) => Draft)) => {
    const value =
      typeof next === 'function' ? next(drafts.current[draftKey.current] ?? EMPTY_DRAFT) : next;
    drafts.current[draftKey.current] = value;
    draftRef.current = value;
    renderDraft((n) => n + 1);
  };
  const scroll = scrolls[conversationKey] ?? 0;
  const setScroll = (next: number | ((n: number) => number)) =>
    setScrolls((all) => ({
      ...all,
      [conversationKey]: typeof next === 'function' ? next(all[conversationKey] ?? 0) : next,
    }));
  const scrollRef = useRef(setScroll);
  scrollRef.current = setScroll;
  // A task's view shows a finished task's result, unless the user asked for the transcript or
  // kept talking in it (then it is a conversation, and a reply must not fold it away).
  const showHistory = history[conversationKey] ?? (!detail || continued(logs[detail.id] ?? []));
  const isFinished = task && ['done', 'failed', 'cancelled'].includes(task.status);

  useEffect(() => {
    const ids =
      current === 'team'
        ? tasks.filter((t) => t.status === 'running').map((t) => t.id)
        : agent && !chatMode
          ? agentTasks.filter((t) => t.status === 'running').map((t) => t.id)
          : task
            ? [task.id]
            : [];
    for (const id of ids) {
      if (logs[id] || loading.current.has(id)) continue;
      loading.current.add(id);
      // A whole transcript can be larger than one frame allows: pages until one comes back empty.
      void (async () => {
        const events: StoredEvent[] = [];
        for (;;) {
          const page = await client.call('tasks.events', {
            taskId: id,
            afterSeq: events.at(-1)?.seq ?? 0,
          });
          if (!page.length) break;
          events.push(...page);
        }
        setLogs((all) => {
          // The fetch ends here, when its result lands: events that arrived meanwhile follow
          // the last page, once each, and later ones append to the state as usual.
          const live = arriving.current[id] ?? [];
          delete arriving.current[id];
          loading.current.delete(id);
          const last = events.at(-1)?.seq ?? 0;
          const seen = new Set<number>();
          const tail = [...(all[id] ?? []), ...live]
            .filter((e) => e.seq > last && !seen.has(e.seq) && seen.add(e.seq))
            .sort((a, b) => a.seq - b.seq);
          return { ...all, [id]: [...events, ...tail] };
        });
      })().catch((e) => {
        delete arriving.current[id];
        loading.current.delete(id);
        reportProblem(e);
      });
    }
  }, [client, current, tasks, task?.id]);

  // ── layout ──────────────────────────────────────────────
  /** The context whose bindings apply, before the global ones. */
  const context: Context =
    focus === 'side' ? 'sidebar' : detail ? 'task' : isMenu ? (current as Context) : 'chat';
  // A task's view has an input too: text and the input's keys first, then its own bindings.
  const active: Context[] = context === 'task' ? ['chat', 'task', 'global'] : [context, 'global'];
  // Named at the end of a result view; absent when the user unbound it.
  const historyKey = keyLabel(keysFor(keymap, active, 'task:history')[0] ?? '') || undefined;
  const typing = context === 'chat' || context === 'task';
  // While a chord is pending, the keys that can follow it (which-key), above the status line.
  const next = pending.length ? continuations(keymap, active, pending) : [];
  const whichKeyRows = next.length ? Math.ceil(next.length / 2) + 1 : 0;
  const sideWidth = columns < 72 || selecting ? 0 : SIDEBAR_WIDTH;
  const mainWidth = Math.max(20, columns - sideWidth);
  const textWidth = selecting ? mainWidth : mainWidth - 4;
  const bodyHeight = rows - 1 - whichKeyRows;
  // The chat has an input box below the transcript; a task's detail has two meta lines above it.
  const composer = inputRows(
    draft,
    Math.max(2, textWidth - 6),
    Math.max(1, Math.min(5, rows - 14)),
  );
  const transcriptHeight = Math.max(1, bodyHeight - (detail ? 11 : 9) - composer.rows.length);
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
    { kind: 'header', text: 'HOME' },
    ...HOME.map((item) => ({ kind: 'item' as const, item })),
    { kind: 'header', text: 'CONFIGURE' },
    ...CONFIG.map((item) => ({ kind: 'item' as const, item })),
    { kind: 'header', text: 'AGENTS' },
    { kind: 'item', item: BUILDER },
    ...(userAgents.length
      ? userAgents.map((a) => ({ kind: 'item' as const, item: a.id }))
      : [{ kind: 'note' as const, text: 'none yet — Getting started' }]),
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
      agent && !chatMode
        ? agentTaskLines(agentTasks, logs, textWidth)
        : isFinished && !showHistory
          ? resultLines(task, textWidth, tasks, historyKey)
          : transcriptLines(task ? (logs[task.id] ?? []) : [], textWidth, {
              verbose,
              expanded,
              live: task?.status === 'running',
              prefix: task ? `${task.id}:` : '',
            }),
    [agent, chatMode, logs, task, tasks, showHistory, historyKey, textWidth, verbose, expanded],
  );
  // Input box: border and padding take four columns, the prompt two.
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(
    Math.max(0, lines.length - transcriptHeight - offset),
    lines.length - offset,
  );
  // Under a running turn's transcript: a spinner, how long it has run and what it is doing.
  const working =
    task && (task.status === 'running' || task.status === 'queued')
      ? `${SPINNER[frame % SPINNER.length]} ${
          task.status === 'queued'
            ? 'queued'
            : `working${task.startedAt ? ` ${duration(Date.now() - task.startedAt)}` : ''} · ${turnActivity(logs[task.id] ?? [])}`
        }`
      : '';
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
  const fallback = current;
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
    draftKey.current = `${id}:new`;
    draftRef.current = drafts.current[draftKey.current] ?? EMPTY_DRAFT;
    setFocusTask((f) => ({ ...f, [id]: null }));
  };

  const submit = (raw = draftRef.current.text, reviewed = false) => {
    const text = raw.trim();
    // A task's view replies to the task; an agent's view starts a task (the builder's continues).
    const agentId = detail?.agentId ?? agent?.id;
    if (!text || !agentId || sending.current.has(draftKey.current)) return;
    if (text === '/new') {
      setDraft(EMPTY_DRAFT);
      if (chatMode) startNewTask(agentId);
      else if (detail) setSelected(agentId);
      return;
    }
    if (text === '/verbose') {
      setDraft(EMPTY_DRAFT);
      return setVerbose((v) => !v);
    }
    if (text === '/quit') return exit();
    const shown = detail ?? (chatMode && newTaskFor.current !== agentId ? task : undefined);
    if (shown && ['running', 'queued'].includes(shown.status))
      return reportProblem(
        new Error(
          'This task is still running. Wait for it to finish or explicitly stop it. Your draft is kept.',
        ),
      );
    if (text.includes('\n') && !reviewed)
      return setModal({
        kind: 'composeReview',
        text,
        target: `@${agentId} · ${shown ? 'Continue: ' + shown.title : 'New task'}`,
        send: () => submit(raw, true),
        scroll: 0,
      });
    const key = draftKey.current;
    const saved = draftRef.current;
    sending.current.add(key);
    const call = shown
      ? client.call('tasks.send', { taskId: shown.id, text })
      : client.call('tasks.create', { agentId, text });
    void call
      .then((t) => {
        // Do not erase edits made while sending, or a draft in another conversation.
        const latest = drafts.current[key] ?? saved;
        if (latest.text === saved.text) drafts.current[key] = EMPTY_DRAFT;
        else if (chatMode) drafts.current[`${agentId}:${t.id}`] = latest;
        setTasks((all) => [t, ...all.filter((x) => x.id !== t.id)]);
        if (chatMode) {
          setFocusTask((f) => (f[agentId] === chosen ? { ...f, [agentId]: t.id } : f));
          if (newTaskFor.current === agentId) newTaskFor.current = null;
        } else if (!shown) say(`${t.id} started for @${agentId}`);
        setProblem(null);
      })
      .catch((e) => reportProblem(e))
      .finally(() => {
        sending.current.delete(key);
        renderDraft((n) => n + 1);
      });
  };

  const editDraft = () => {
    if (!compose || !suspendTerminal) return say('set $EDITOR to compose in an editor');
    let result = input;
    void suspendTerminal(() => {
      result = compose(input);
    }).then(() => setDraft(draftOf(result.replace(/\n+$/, ''))));
  };

  /** Edits the prompt of the open settings panel in $EDITOR. */
  const editPrompt = () => {
    if (!compose) return say('set $EDITOR to edit the prompt');
    if (modal?.kind !== 'settings' || !modal.state) return;
    let result = modal.state.promptText;
    // Without a terminal to hand over (tests), the editor runs in place.
    const hand = suspendTerminal ?? (async (fn: () => void) => fn());
    void hand(() => {
      result = compose(result);
    }).then(() =>
      setModal((m) =>
        m?.kind === 'settings' && m.state ? { ...m, state: { ...m.state, promptText: result } } : m,
      ),
    );
  };

  const openConnector = (id: ConnectorId) =>
    setModal({ kind: 'secret', connector: id, index: 0, values: {}, input: '' });

  /** Edits the input of the open text or secret dialog from its latest state (fast typing). */
  const editModalInput = (edit: (value: string) => string) =>
    setModal((m) =>
      m && m.kind === 'text'
        ? { ...m, input: edit(m.input), candidates: undefined }
        : m && m.kind === 'secret'
          ? { ...m, input: edit(m.input) }
          : m,
    );

  const runAction = (action: () => Promise<unknown>, done: string) => {
    void action()
      .then(() => {
        say(done);
        refreshSetup();
      })
      .catch((e: Error) => reportProblem(e));
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
  // Usage and Access scroll from the top; their lines, computed once here, say how far.
  const reportLines = useMemo<ReportLine[]>(
    () =>
      current === 'access'
        ? accessSummaryLines(access, accessPeriod, textWidth)
        : current === 'usage'
          ? usageLines(usage.rows, usage.quota, usagePeriod, GROUPS[usageGroup]!, textWidth)
          : [],
    [current, access, accessPeriod, usage, usagePeriod, usageGroup, textWidth],
  );
  const reportHeight = bodyHeight - 4;
  const reportMax = Math.max(0, reportLines.length - reportHeight);
  const reportPage = Math.max(1, reportHeight - 1);
  /** How far the open modal can scroll, as its last render found; the key handlers stop there. */
  const modalMax = useRef(0);
  // PgUp and PgDn in the skills list move the cursor by what the list shows.
  const skillPage = skillListRows(bodyHeight - 4);
  const connectorIds = CONNECTOR_IDS;

  const performSetup = async (step: SetupAction, vmSize?: VmSize) => {
    if (setupRunning.current)
      throw new Error('Environment setup is already running. Open installation progress.');
    setupRunning.current = true;
    setSetupLog([]);
    const startedAt = Date.now();
    setSetupProgress({ action: step, phase: setupPhase(step, ''), running: true, startedAt });
    try {
      const status = await client.call('setup.run', { action: step, vmSize });
      setSetup(status);
      setSetupProgress({ action: step, phase: 'Completed', running: false, startedAt });
      setProblem(null);
    } catch (e) {
      setSetupProgress((p) => p && { ...p, running: false, failed: true });
      reportProblem(e, () => performSetup(step, vmSize));
      throw e;
    } finally {
      setupRunning.current = false;
    }
  };
  const prepare = async (runtime: RuntimeId) => {
    if (setupRunning.current) throw new Error('Environment setup is already running.');
    setupRunning.current = true;
    quickRuntime.current = runtime;
    setSetupLog([]);
    const startedAt = Date.now();
    setSetupProgress({
      action: 'install',
      phase: `Preparing ${runtime}`,
      running: true,
      startedAt,
    });
    try {
      const status = await client.call('setup.prepare', { runtime, confirm: true });
      setSetup(status);
      setSetupProgress({ action: 'install', phase: 'Ready', running: false, startedAt });
      setProblem(null);
      // Existing host logins are imported by the daemon as soon as the vault is ready.
      if (!runtimeReady(status, runtime)) {
        if (runtime === 'codex' && status.hostLogins?.codex.state !== 'ready') {
          say('Run codex login on this computer, then press i to use that login.');
        } else
          run(
            runtime === 'codex'
              ? 'setup:codex'
              : runtime === 'claude-code'
                ? 'setup:claude'
                : 'setup:hermes',
          );
      }
    } catch (e) {
      setSetupProgress((p) => p && { ...p, running: false, failed: true });
      reportProblem(e, () => prepare(runtime));
      throw e;
    } finally {
      setupRunning.current = false;
    }
  };
  const confirmPrepare = (runtime: RuntimeId) => {
    const size = setup?.vm === 'missing' ? setup.vmSize?.default : undefined;
    setModal({
      kind: 'confirm',
      title: `Prepare ${runtime}`,
      body:
        `Prepare an isolated local environment and ${runtime}, and initialize or unlock credential storage. ` +
        (size
          ? `Recommended resources: ${size.cpus} CPUs and ${size.memoryGiB} GiB of memory. `
          : '') +
        'Available Codex and Claude Code logins on this computer are imported automatically into the vault. ' +
        'Existing keys are kept. Back up ~/.config/anchi/vault.key. No folders are shared and no model is called. ' +
        'Completed steps are reused if you retry. Advanced resource settings are available in Runtimes (I).',
      action: () => prepare(runtime),
    });
  };
  /** A new VM's CPUs, then its memory: half of this computer, changed before it is created. */
  const askVmSize = ({ default: suggested, host }: NonNullable<SetupStatus['vmSize']>) => {
    const whole = (raw: string, min: number, max: number, what: string) => {
      const n = Number(raw.trim());
      if (!/^\d+$/.test(raw.trim()) || n < min || n > max) {
        throw new Error(`${what} must be a whole number from ${min} to ${max}`);
      }
      return n;
    };
    setModal({
      kind: 'text',
      title: 'New VM: CPUs',
      label: `CPUs for the anchi-vm VM. This computer has ${host.cpus}; half is ${suggested.cpus}.`,
      input: String(suggested.cpus),
      submit: async (rawCpus) => {
        const cpus = whole(rawCpus, 1, host.cpus, 'CPUs');
        setModal({
          kind: 'text',
          title: 'New VM: memory',
          label: `Memory in GiB for the anchi-vm VM. This computer has ${host.memoryGiB} GiB; half is ${suggested.memoryGiB}. Each working cell may use up to 2 GB.`,
          input: String(suggested.memoryGiB),
          submit: async (rawGiB) => {
            const memoryGiB = whole(rawGiB, 2, host.memoryGiB, 'Memory');
            setModal({
              kind: 'confirm',
              title: 'Install',
              body:
                `Create the anchi-vm VM with ${cpus} CPUs and ${memoryGiB} GiB of memory, install ` +
                'the trusted services and the agent team, and build the base image. This downloads ' +
                'the VM image, Debian packages and the base image tools: several minutes, up to half ' +
                'an hour on a slow network. Later changes: limactl edit anchi-vm --cpus N --memory N.',
              action: () => performSetup('install', { cpus, memoryGiB }),
            });
          },
        });
      },
    });
  };
  const setupStep = (step: SetupAction) => {
    if (setupRunning.current) return setModal({ kind: 'setupLog', scroll: 0 });
    if (step === 'install' && setup?.vm === 'missing' && setup.vmSize) {
      return askVmSize(setup.vmSize);
    }
    const [title, body] = (
      {
        'vault-init': [
          'Initialize the vault',
          'Create the local master key and unlock the vault. Back up ~/.config/anchi/vault.key. Existing encrypted accounts require their original key.',
        ],
        'vm-start': ['Start the VM', 'Start the anchi-vm VM.'],
        install: [
          'Install or update',
          'Create or update the anchi-vm VM, install the trusted services and the agent ' +
            'team, and build the base image. A first installation downloads the VM image, Debian ' +
            'packages and the base image tools: several minutes, up to half an hour on a slow ' +
            'network; an update reuses what is done.',
        ],
        workspaces: [
          'Share ~/AnchiWorkspaces',
          'Mount ~/AnchiWorkspaces into the VM so agents can be given directories of this computer ' +
            '(workspaces: in an agent). The VM restarts: running tasks stop, and the vault is ' +
            'unlocked again afterwards.',
        ],
        'vault-unlock': [
          'Unlock the vault',
          'Send the vault key from ~/.config/anchi/vault.key on this computer to the VM, ' +
            'where it is kept in memory only.',
        ],
      } as const
    )[step];
    setModal({
      kind: 'confirm',
      title,
      body,
      action: () => performSetup(step),
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

  /** Asks to delete an agent, listing everything that goes and what stays. */
  const openDelete = (id: string) => {
    setModal({ kind: 'deleteAgent', agentId: id, preview: null, input: '' });
    void client
      .call('agents.deletePreview', { agentId: id })
      .then((preview) =>
        setModal((m) => (m?.kind === 'deleteAgent' && m.agentId === id ? { ...m, preview } : m)),
      )
      .catch((e: Error) => {
        setModal(null);
        say(e.message);
      });
  };

  const deleteAgent = (id: string) => {
    setModal(null);
    say(`deleting @${id}…`);
    void client
      .call('agents.delete', { agentId: id, confirm: id })
      .then((r) => {
        setSelected(BUILDER);
        setFocusTask((f) => {
          const { [id]: _gone, ...rest } = f;
          return rest;
        });
        say(
          `@${id} deleted with ${r.deletedTasks} task${r.deletedTasks === 1 ? '' : 's'}` +
            (r.editedAgents.length || r.editedTemplates.length
              ? `; removed from the delegates of ${[...r.editedAgents.map((a) => `@${a}`), ...r.editedTemplates.map((t) => `template ${t}`)].join(', ')}`
              : '') +
            (r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''),
        );
      })
      .catch((e: Error) => reportProblem(e));
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
        .catch((e: Error) => reportProblem(e));
    }
    void client
      .call('agents.update', { agentId: m.agentId, patch })
      .then((update) =>
        setModal({ kind: 'settingsReview', agentId: m.agentId, patch, update, back: m }),
      )
      .catch((e: Error) => reportProblem(e));
  };
  const proposalModal = (id: string): Modal | undefined => {
    const proposal = proposals.find((p) => p.id === id);
    return proposal ? { kind: 'proposal', proposal, scroll: 0 } : undefined;
  };

  /** Asks for the Google Cloud Desktop app OAuth client JSON (for Gmail and Drive). */
  const importGoogleClient = () =>
    setModal({
      kind: 'text',
      title: 'Google OAuth client',
      label:
        'Path of the Desktop app OAuth client JSON from Google Cloud (needed once for Gmail and Drive; it takes precedence over a built-in client)',
      input: '',
      paths: { extensions: ['.json'] },
      submit: async (path) => {
        const text = await readClientFile(path.trim());
        await client.call('services.googleClient', { json: text });
        refreshSetup();
        say('Google client stored; press Enter to sign in');
      },
    });
  /** Opens Google sign-in in the browser for one account of Gmail or Drive. */
  const googleLogin = (id: ServiceConnectorId, account: string) =>
    runAction(
      async () => {
        const { url } = await client.call('services.googleLogin', { id, account });
        say(`sign in to Google in your browser (${url.slice(0, 60)}…)`);
      },
      `opened Google sign-in for ${id}${account === DEFAULT_ACCOUNT ? '' : ` (${account})`}`,
    );

  const redditLogin = () =>
    runAction(() => client.call('services.redditLogin'), 'opened Reddit sign-in in your browser');
  const importRedditClient = () =>
    setModal({
      kind: 'text',
      title: 'Reddit installed app Client ID',
      input: '',
      label:
        'Use an installed app with approved Reddit Data API access. Register callback ' +
        'http://127.0.0.1:48174/callback. Paste its Client ID (not a secret or password). ' +
        'Disconnect Reddit before changing the client. See docs/REDDIT_SETUP.md.',
      submit: async (clientId) => {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(clientId.trim()))
          throw new Error('BAD_REDDIT_CLIENT_ID');
        setModal({
          kind: 'text',
          title: 'Reddit app developer username',
          input: '',
          label:
            'The Reddit username of the app developer, without u/. Used to identify API requests. ' +
            'Posts and comments always require your approval.',
          submit: async (developerUsername) => {
            await client.call('services.redditClient', {
              clientId: clientId.trim(),
              developerUsername: developerUsername.trim(),
            });
            refreshSetup();
            await client.call('services.redditLogin');
            say('sign in to Reddit in your browser');
          },
        });
      },
    });

  const xLogin = () =>
    runAction(() => client.call('services.xLogin'), 'opened X sign-in in your browser');
  const importXClient = () =>
    setModal({
      kind: 'text',
      title: 'X native app Client ID',
      input: '',
      label:
        'Create a Native App with OAuth 2.0 in the X Developer Console. Register callback ' +
        'http://127.0.0.1:48173/callback, then paste its Client ID here (not an API key or client secret). ' +
        'X bills API usage: set a spending limit there. Anchi reads posts and mentions; publishing always asks. ' +
        'Disconnect X before changing the client. See docs/X_SETUP.md.',
      submit: async (clientId) => {
        await client.call('services.xClient', { clientId: clientId.trim() });
        refreshSetup();
        await client.call('services.xLogin');
        say('sign in to X in your browser');
      },
    });

  /** Runs a bound action in the current view. */
  const run = (action: ActionId): void => {
    const running = (t?: TaskRow) => t && (t.status === 'running' || t.status === 'queued');
    const chosenApproval = approvals[Math.min(approvalCursor, Math.max(0, approvals.length - 1))];
    switch (action) {
      case 'nav:welcome':
        setSelected('welcome');
        setFocus('main');
        return;
      case 'nav:team':
        setSelected('team');
        setFocus('main');
        return;
      case 'nav:approvals':
        setSelected('approvals');
        setFocus('main');
        return;
      case 'welcome:next': {
        if (!setup) return refreshSetup();
        if (setupRunning.current) return setModal({ kind: 'setupLog', scroll: 0 });
        if (setup.preparing)
          return say(`Preparing ${setup.preparing}; this screen refreshes automatically.`);
        if (setup.host?.missing.length) return refreshSetup();
        const stage = welcomeStep(setup, agents, tasks);
        if (setup.quickSetup && (stage === 'environment' || stage === 'vault')) {
          if (
            runtimeReady(setup) ||
            setup.hostLogins?.codex.state === 'ready' ||
            setup.hostLogins?.claude.state === 'ready'
          )
            return confirmPrepare(suggestedRuntime(setup));
          return setModal({
            kind: 'quickSetup',
            pick: STARTER_RUNTIMES.indexOf(suggestedRuntime(setup)),
          });
        }
        if (setup.quickSetup && stage === 'runtime') {
          const runtime = quickRuntime.current ?? suggestedRuntime(setup);
          return run(
            runtime === 'codex'
              ? 'setup:codex'
              : runtime === 'claude-code'
                ? 'setup:claude'
                : 'setup:hermes',
          );
        }
        if (setup.quickSetup && stage === 'agent') {
          const runtime =
            quickRuntime.current && runtimeReady(setup, quickRuntime.current)
              ? quickRuntime.current
              : suggestedRuntime(setup);
          return runAction(async () => {
            if (!setup.preparedRuntimes?.includes(runtime)) await prepare(runtime);
            const proposal = await client.call('agents.createPreview', { agentId: 'dev', runtime });
            setProposals((p) => [...p, proposal]);
            setModal({ kind: 'proposal', proposal, scroll: 0 });
          }, 'Starter ready for review');
        }
        const action = nextSetupAction(setup);
        if (action) return setupStep(action);
        const step = welcomeStep(setup, agents, tasks);
        if (step === 'runtime') return say('Choose i for Codex, c for Claude Code or h for Hermes');
        if (step === 'agent') return run('agent:create');
        if (step === 'done') return run('nav:team');
        const first = userAgents.find((a) => runtimeReady(setup, a.runtime));
        if (first) {
          setSelected(first.id);
          setFocus('main');
          if (setup.quickSetup && !drafts.current[`${first.id}:new`]?.text) {
            startNewTask(first.id);
            setDraft(draftOf(FIRST_TASK));
          }
        }
        return;
      }
      case 'team:open': {
        const agent = userAgents[Math.min(teamCursor, userAgents.length - 1)];
        if (agent) {
          setSelected(agent.id);
          setFocus('main');
        }
        return;
      }
      case 'problem:open': {
        const issue =
          problem ??
          (task?.status === 'failed'
            ? { message: task.result ?? 'Task failed', taskId: task.id }
            : null);
        if (issue) setModal({ kind: 'problem', ...issue, scroll: 0 });
        else say('No unresolved problem');
        return;
      }
      case 'setup:logs':
        return setModal({ kind: 'setupLog', scroll: 0 });
      case 'task:history':
        return setHistory((all) => ({ ...all, [conversationKey]: !showHistory }));
      case 'chat:newline':
        return setDraft((d) => insert(d, '\n'));
      case 'setup:init':
        return setupStep('vault-init');
      case 'app:quit':
        return exit();
      case 'app:help':
        return setModal({ kind: 'help', context, scroll: 0 });
      case 'app:palette':
        // The task view's input takes the chat actions too: list them.
        return setModal({ kind: 'palette', context, active, query: '', cursor: 0 });
      case 'app:select':
        return setSelecting(true);
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
        return setSelected('runtimes');
      case 'nav:agents':
        return setSelected(userAgents[0]?.id ?? BUILDER);
      case 'nav:tasks':
        return turnPage(page, true);
      case 'nav:builder':
        setSelected(BUILDER);
        return setFocus('main');
      case 'agent:create':
        return setModal({
          kind: 'createAgent',
          pick: Math.max(
            0,
            STARTER_RUNTIMES.findIndex((r) => setup && runtimeReady(setup, r)),
          ),
        });
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
        if (id !== BUILDER) return say(`each message here starts a new task for @${id}`);
        startNewTask(id);
        return say(`the next message starts a new task (a new session) for @${id}`);
      }
      case 'task:cancel': {
        const t = detail ?? task;
        if (!running(t)) return say('no running task here');
        return setModal({
          kind: 'confirm',
          title: 'Stop this task?',
          body: `Stop ${t!.id} (@${t!.agentId}). Its work and transcript are kept; you can continue it later.`,
          action: () => client.call('tasks.cancel', { taskId: t!.id }),
        });
      }
      case 'task:access': {
        const t = detail ?? task;
        if (!t) return say('select a task first');
        setModal({ kind: 'access', taskId: t.id, agentId: t.agentId, data: null, scroll: 0 });
        return void client
          .call('tasks.audit', { taskId: t.id })
          .then((data) =>
            setModal((m) => (m?.kind === 'access' && m.taskId === t.id ? { ...m, data } : m)),
          )
          .catch((e: Error) =>
            setModal((m) =>
              m?.kind === 'access' && m.taskId === t.id ? { ...m, error: e.message } : m,
            ),
          );
      }
      case 'usage:period': {
        const next = (usagePeriod + 1) % PERIODS.length;
        setUsagePeriod(next);
        return refreshUsage(next, usageGroup);
      }
      case 'usage:group': {
        const next = (usageGroup + 1) % GROUPS.length;
        setUsageGroup(next);
        return refreshUsage(usagePeriod, next);
      }
      case 'usage:refresh':
        return refreshUsage(usagePeriod, usageGroup);
      case 'access:period': {
        const next = (accessPeriod + 1) % PERIODS.length;
        setAccessPeriod(next);
        return refreshAccess(next);
      }
      case 'access:refresh':
        return refreshAccess(accessPeriod);
      case 'task:retry': {
        const t = detail ?? task;
        if (!t || (t.status !== 'failed' && t.status !== 'cancelled')) {
          return say('only a failed or cancelled task can run again');
        }
        return setModal({ kind: 'retry', taskId: t.id, agentId: t.agentId, status: t.status });
      }
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
      case 'agent:delete': {
        if (!agent || agent.id === BUILDER)
          return say('select an agent first (the builder cannot be deleted)');
        return openDelete(agent.id);
      }
      case 'sidebar:delete':
        if (detail) return run('task:delete');
        return run('agent:delete');
      case 'agent:settings': {
        const id = agent?.id ?? detail?.agentId;
        if (!id) return say('select an agent first');
        return openSettings({ agentId: id });
      }
      case 'approvals:open':
        if (!approvals.length) return say('no write is waiting for approval');
        return setModal({
          kind: 'approval',
          approval: (current === 'approvals' ? chosenApproval : undefined) ?? approvals[0]!,
          scroll: 0,
        });
      case 'approvals:approve':
      case 'approvals:deny':
        if (!chosenApproval) return say('no write is waiting for approval');
        return setApprovalPick({ id: chosenApproval.id, allow: action === 'approvals:approve' });
      case 'approvals:confirm': {
        if (!chosenApproval) return say('no write is waiting for approval');
        if (approvalPick?.id !== chosenApproval.id)
          return say('select y (approve) or n (deny) first, then Enter');
        const { allow } = approvalPick;
        const { id, operation } = chosenApproval;
        setApprovalPick(null);
        return void client
          .call('approvals.decide', { id, allow })
          .then(() => say(`${allow ? 'approved' : 'denied'}: ${sanitizeLine(operation)}`))
          .catch(reportProblem);
      }
      case 'approvals:task':
        if (!chosenApproval) return say('no write is waiting for approval');
        if (!tasks.some((t) => t.id === chosenApproval.task))
          return say(`${chosenApproval.task} is not in the task list`);
        setSelected(TASK_ITEM + chosenApproval.task);
        setFocus('main');
        return;
      case 'builder:proposal':
        if (!proposals.length) return say('no builder proposal is waiting');
        return setModal({ kind: 'proposal', proposal: proposals.at(-1)!, scroll: 0 });
      case 'transcript:tools':
        return toggleAllGroups();
      case 'transcript:verbose':
        return setVerbose((v) => !v);
      // Report views and Getting started count rows from the top; the transcript from the
      // bottom. Both stop at their last line, so the other direction answers at once.
      case 'scroll:up':
        if (context === 'usage' || context === 'access' || context === 'welcome')
          return setScroll((s) => Math.max(0, s - 1));
        return setScroll((s) => Math.min(maxScroll, s + 1));
      case 'scroll:down':
        if (context === 'usage' || context === 'access')
          return setScroll((s) => Math.min(reportMax, s + 1));
        if (context === 'welcome') return setScroll((s) => s + 1);
        return setScroll((s) => Math.max(0, s - 1));
      case 'scroll:pageUp':
        if (context === 'usage' || context === 'access')
          return setScroll((s) => Math.max(0, s - reportPage));
        return setScroll((s) => Math.min(maxScroll, s + halfPage));
      case 'scroll:pageDown':
        if (context === 'usage' || context === 'access')
          return setScroll((s) => Math.min(reportMax, s + reportPage));
        return setScroll((s) => Math.max(0, s - halfPage));
      case 'chat:submit':
        return submit();
      case 'chat:escape':
        return back();
      case 'chat:editor':
        return editDraft();
      case 'list:up':
        if (current === 'approvals') {
          setApprovalPick(null);
          return setApprovalCursor((c) => Math.max(0, c - 1));
        }
        if (current === 'team') return setTeamCursor((c) => Math.max(0, c - 1));
        if (current === 'skills') return setSkillCursor((c) => Math.max(0, c - 1));
        return setConnectorCursor((c) => Math.max(0, c - 1));
      case 'list:down':
        if (current === 'approvals') {
          setApprovalPick(null);
          return setApprovalCursor((c) => Math.min(Math.max(0, approvals.length - 1), c + 1));
        }
        if (current === 'team') return setTeamCursor((c) => Math.min(userAgents.length - 1, c + 1));
        if (current === 'skills')
          return setSkillCursor((c) => Math.min((skills ?? []).length - 1, c + 1));
        return setConnectorCursor((c) =>
          Math.min(connectorIds.length + serviceIds.length - 1, c + 1),
        );
      case 'list:pageUp':
        return setSkillCursor((c) => Math.max(0, c - skillPage));
      case 'list:pageDown':
        return setSkillCursor((c) => Math.min((skills ?? []).length - 1, c + skillPage));
      case 'list:first':
        return setSkillCursor(0);
      case 'list:last':
        return setSkillCursor(Math.max(0, (skills ?? []).length - 1));
      case 'setup:vmStart':
        return setupStep('vm-start');
      case 'setup:install':
        return setupStep('install');
      case 'setup:unlock':
        return setupStep(setup?.vaultKeyPresent === false ? 'vault-init' : 'vault-unlock');
      case 'setup:workspaces':
        return setupStep('workspaces');
      case 'setup:codex':
        return setModal({
          kind: 'confirm',
          title: 'Import Codex login',
          body:
            'Read the access token and account id from ~/.codex/auth.json on this computer and store them in the ' +
            'VM vault. The refresh token stays on this computer. Cells never receive the token.',
          action: () => client.call('setup.importCodex'),
        });
      case 'setup:claude':
        return setModal({ kind: 'secret', connector: 'claude', index: 0, values: {}, input: '' });
      case 'setup:hermes':
        return setModal({ kind: 'secret', connector: 'hermes', index: 0, values: {}, input: '' });
      case 'setup:refresh':
        return refreshSetup();
      case 'skills:add':
        return setModal({
          kind: 'text',
          title: 'Add a skill',
          label:
            'A local directory with a SKILL.md, or a GitHub URL such as https://github.com/owner/repo/tree/main/skills/name (fetched at its current commit). A directory or repository of skills adds each one.',
          input: '',
          paths: { dirsOnly: true },
          submit: async (raw) => {
            const source = /^https:\/\//.test(raw.trim()) ? raw.trim() : localPath(raw.trim());
            const guess = source.replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? '';
            setModal({
              kind: 'text',
              title: 'Skill id',
              label: `The id agents list it by (1–40 lowercase letters, digits or "-"). Enter keeps "${guess}"; a collection keeps each skill's directory name.`,
              input: '',
              allowEmpty: true,
              submit: async (id) => {
                const { added, skipped } = await client.call('skills.add', {
                  source,
                  id: id.trim() || undefined,
                });
                refreshSkills();
                const what =
                  added.length === 1
                    ? `skill ${added[0]!.id} added`
                    : `${added.length} skills added`;
                say(
                  `${what}${skipped.length ? ` (${skipped.length} skipped: ${skipped.join('; ')})` : ''}; give them to agents with ${keyLabel(keysFor(keymap, ['global'], 'agent:settings')[0] ?? '')} in their chat`,
                );
              },
            });
          },
        });
      case 'skills:update': {
        const skill = (skills ?? [])[skillCursor];
        if (!skill) return;
        if (!skill.commit)
          return say(
            `${skill.id} was added from a local directory; press a and give the same directory to refresh it`,
          );
        say(`checking ${skill.id}…`);
        return void client
          .call('skills.checkUpdate', { id: skill.id })
          .then((u) => {
            if (u.upToDate) return say(`${u.id} is up to date (${u.latest.slice(0, 10)})`);
            // File names come from the skill repository's tree: untrusted, like its content.
            const list = (label: string, files: string[]) =>
              files.length
                ? `\n${label}: ${files.slice(0, 8).map(sanitizeLine).join(', ')}${files.length > 8 ? ` and ${files.length - 8} more` : ''}`
                : '';
            setModal({
              kind: 'confirm',
              title: `Update skill ${u.id}`,
              body:
                `${sanitizeLine(u.url)}\n${u.current?.slice(0, 10) ?? '?'} → ${u.latest.slice(0, 10)}` +
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
          .catch((e: Error) => reportProblem(e));
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
        if (sid === 'x') return setup?.xClient ? xLogin() : importXClient();
        if (sid === 'reddit') return setup?.redditClient ? redditLogin() : importRedditClient();
        if (sid === 'notion' || sid === 'slack') {
          return setModal({ kind: 'secret', connector: sid, index: 0, values: {}, input: '' });
        }
        if (!setup?.googleClient) return importGoogleClient();
        // Enter signs in again the account that needs it, else the default one.
        return googleLogin(
          sid!,
          status?.accounts.find((a) => a.reauthRequired)?.name ?? DEFAULT_ACCOUNT,
        );
      case 'connectors:account':
        if (sid !== 'gmail' && sid !== 'drive') return say('select gmail or drive first');
        if (!setup?.googleClient) return importGoogleClient();
        return setModal({
          kind: 'text',
          title: `Another Google account for ${sid}`,
          label: `A name for the account (lowercase letters, digits, "-" or "_"), e.g. work. Agents pick it with accounts: { ${sid}: <name> }. Connected: ${
            status?.accounts.map((a) => a.name).join(', ') || 'none'
          }.`,
          input: '',
          submit: async (name) => {
            if (!ACCOUNT_NAME.test(name.trim()))
              throw new Error(`"${name}" is not an account name`);
            await googleLogin(sid, name.trim());
          },
        });
      case 'connectors:googleClient':
        if (setup?.googleClientSource !== 'user') return importGoogleClient();
        return setModal({
          kind: 'confirm',
          title: 'Remove your Google OAuth client',
          body:
            "Gmail and Drive go back to Anchi's built-in client when this version ships one, " +
            'otherwise to none until you import one again. Disconnect every Google account first: ' +
            'their tokens belong to this client.',
          action: async () => {
            await client.call('services.removeGoogleClient');
            refreshSetup();
          },
        });
      case 'connectors:redditClient':
        return importRedditClient();
      case 'connectors:xClient':
        return importXClient();
      case 'connectors:ghImport':
        if (id !== 'github') return say('select github first');
        return setModal({
          kind: 'confirm',
          title: 'Import the gh CLI token',
          body:
            'Read the token the GitHub CLI on this computer is logged in with (`gh auth token`) and store ' +
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
            'AWS profile on this computer (for SSO, run `aws sso login --profile …` first). Anchi ' +
            'exports its temporary credentials and refreshes them before they expire.',
          input: '',
          submit: (profile) => client.call('connectors.awsProfile', { profile }),
        });
      case 'connectors:mode': {
        if (!sid || !status)
          return say('select a service (gmail, drive, notion, slack, x, reddit) first');
        if (sid === 'x' || sid === 'reddit')
          return say(
            `${sid === 'x' ? 'X posts' : 'Reddit posts and comments'} always require approval; reads are automatic`,
          );
        const mode = status.mode === 'ask' ? 'auto' : 'ask';
        return runAction(
          () => client.call('services.setMode', { id: sid, mode }),
          `${sid} writes: ${mode === 'ask' ? 'ask for approval' : 'automatic'}`,
        );
      }
      case 'connectors:disconnect':
        if (sid) {
          // Google services: one of their accounts (connected, or a revocation to retry).
          const accounts = (status?.accounts ?? []).filter(
            (a) => a.connected || a.revocationPending,
          );
          if (accounts.length > 1) {
            return setModal({
              kind: 'text',
              title: `Disconnect a ${sid} account`,
              label: `Which account to remove from the vault and revoke at Google: ${accounts
                .map((a) => `${a.name}${a.account ? ` (${sanitizeLine(a.account)})` : ''}`)
                .join(', ')}`,
              input: '',
              submit: async (name) => {
                if (!accounts.some((a) => a.name === name.trim()))
                  throw new Error(`${sid} has no account "${name}"`);
                await client.call('services.disconnect', { id: sid, account: name.trim() });
                refreshSetup();
              },
            });
          }
          const account = accounts[0]?.name;
          if (!status?.connected && !status?.revocationPending && !account) return;
          return setModal({
            kind: 'confirm',
            title: `Disconnect ${sid}${account && account !== DEFAULT_ACCOUNT ? ` (${account})` : ''}`,
            body: `Remove the ${sid} credential from the vault${sid === 'gmail' || sid === 'drive' ? ' and revoke it at Google' : ''}.`,
            action: () =>
              client.call('services.disconnect', account ? { id: sid, account } : { id: sid }),
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
    else if (modal?.kind === 'settings' && modal.editing) {
      const { field } = modal.editing;
      setModal((m) =>
        m?.kind === 'settings' && m.editing
          ? {
              ...m,
              editing: {
                field,
                input: (m.editing.input + sanitizeLine(text.trim())).slice(0, TEXT_FIELDS[field]),
              },
            }
          : m,
      );
    } else if (modal?.kind === 'palette')
      setModal({ ...modal, query: modal.query + text.trim(), cursor: 0 });
    else if (!modal && agent && focus === 'main')
      setDraft((d) => insert(d, sanitize(text).replace(/\r\n?/g, '\n')));
  });

  /** One keystroke or a run of text; `useInput` splits mixed chunks into these. */
  const handleInput = (ch: string, key: InkKey) => {
    if (key.ctrl && ch === 'c') return exit();
    if (selecting) {
      // Scrolling still works (terminals turn the wheel into arrows here); anything else ends it.
      if (key.upArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
      if (key.downArrow) return setScroll((s) => Math.max(0, s - 1));
      if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + transcriptHeight));
      if (key.pageDown) return setScroll((s) => Math.max(0, s - transcriptHeight));
      return setSelecting(false);
    }
    /** One row or a page further down a modal, never past its last line. */
    const down = (scroll: number, step = 1) => Math.min(modalMax.current, scroll + step);
    // ── modals take every key ──
    if (modal?.kind === 'composeReview') {
      if (key.escape) return setModal(null);
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: down(modal.scroll) });
      if (key.return) {
        const send = modal.send;
        setModal(null);
        send();
      }
      return;
    }
    if (modal?.kind === 'setupLog') {
      if (key.escape) return setModal(null);
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: down(modal.scroll) });
      return;
    }
    if (modal?.kind === 'problem') {
      if (key.escape) return setModal(null);
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: down(modal.scroll) });
      if (ch === 'd') {
        setProblem(null);
        return setModal(null);
      }
      if (ch === 'r' && modal.retry) {
        const retry = modal.retry;
        setModal(null);
        return runAction(retry, 'Retry completed');
      }
      if (key.return) {
        const issue = modal;
        const recovery = recoveryFor(issue.message);
        setModal(null);
        if (recovery.action === 'setup') return run('nav:welcome');
        if (recovery.action === 'codex') return run('setup:codex');
        if (recovery.action === 'claude') return run('setup:claude');
        if (issue.taskId) {
          const failed = tasks.find((t) => t.id === issue.taskId);
          if (failed && recovery.action !== 'access')
            return setModal({
              kind: 'retry',
              taskId: failed.id,
              agentId: failed.agentId,
              status: failed.status,
            });
        }
        if (recovery.action === 'access') return run('task:access');
        return void client.call('tasks.list', { limit: 500 }).then(setTasks).catch(reportProblem);
      }
      return;
    }
    if (modal?.kind === 'approval') {
      const { approval } = modal;
      if (key.escape) return setModal(null);
      if (key.home) return setModal({ ...modal, scroll: 0 });
      if (key.end) return setModal({ ...modal, scroll: modalMax.current });
      if (key.upArrow || key.pageUp)
        return setModal({
          ...modal,
          scroll: Math.max(0, modal.scroll - (key.pageUp ? halfPage : 1)),
        });
      if (key.downArrow || key.pageDown)
        return setModal({ ...modal, scroll: down(modal.scroll, key.pageDown ? halfPage : 1) });
      if (ch === 'y' || ch === 'n') return setModal({ ...modal, decision: ch === 'y' });
      if (key.return && modal.decision !== undefined) {
        const allow = modal.decision;
        setModal(null);
        return void client
          .call('approvals.decide', { id: approval.id, allow })
          .then(() => say(`${allow ? 'approved' : 'denied'}: ${approval.operation}`))
          .catch(reportProblem);
      }
      return;
    }
    if (modal?.kind === 'quickSetup') {
      if (key.escape) return setModal(null);
      if (key.upArrow) return setModal({ ...modal, pick: Math.max(0, modal.pick - 1) });
      if (key.downArrow)
        return setModal({ ...modal, pick: Math.min(STARTER_RUNTIMES.length - 1, modal.pick + 1) });
      if (key.return) return confirmPrepare(STARTER_RUNTIMES[modal.pick]!);
      return;
    }
    if (modal?.kind === 'createAgent') {
      if (key.escape) return setModal(null);
      if (key.upArrow) return setModal({ ...modal, pick: Math.max(0, modal.pick - 1) });
      if (key.downArrow)
        return setModal({ ...modal, pick: Math.min(STARTER_RUNTIMES.length - 1, modal.pick + 1) });
      if (key.return) {
        const runtime = STARTER_RUNTIMES[modal.pick]!;
        return setModal({
          kind: 'text',
          title: 'Name your starter agent',
          label: `${runtime} · lowercase letters, digits and hyphens; for example dev`,
          input: '',
          submit: async (agentId) => {
            const proposal = await client.call('agents.createPreview', {
              agentId: agentId.trim(),
              runtime,
            });
            setProposals((p) => [...p, proposal]);
            setModal({ kind: 'proposal', proposal, scroll: 0 });
          },
        });
      }
      return;
    }
    if (modal?.kind === 'proposal') {
      if (key.upArrow) return setModal({ ...modal, scroll: Math.max(0, modal.scroll - 1) });
      if (key.downArrow) return setModal({ ...modal, scroll: down(modal.scroll) });
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
        // The daemon keeps a proposal it refused (the file changed since the review): so does
        // the list, and ^X o shows it again.
        void client
          .call('builder.apply', { proposalId: proposal.id })
          .then((updated) => {
            setProposals((p) => p.filter((x) => x.id !== proposal.id));
            setAgents(updated);
            setSelected(proposal.agentId);
            setFocus('main');
            if (setup?.quickSetup && !userAgents.length) {
              startNewTask(proposal.agentId);
              if (!draftRef.current.text) setDraft(draftOf(FIRST_TASK));
            }
            say(`@${proposal.agentId} saved`);
          })
          .catch((e: Error) => reportProblem(e));
      }
      return;
    }
    if (modal?.kind === 'secret') {
      const field = SECRET_FIELDS[modal.connector][modal.index]!;
      if (key.escape) return setModal(null);
      if (key.tab && field.masked) return setModal({ ...modal, revealed: !modal.revealed });
      if (key.backspace || key.delete) return editModalInput((v) => [...v].slice(0, -1).join(''));
      // A pasted token that is wrong goes in one key, as in a shell.
      if (key.ctrl && ch === 'u') return editModalInput(() => '');
      if (key.ctrl && ch === 'w') return editModalInput((v) => v.replace(/\S+\s*$/, ''));
      if (key.return) {
        if (!modal.input && !field.optional) return;
        const values = { ...modal.values, ...(modal.input ? { [field.key]: modal.input } : {}) };
        if (modal.index + 1 < SECRET_FIELDS[modal.connector].length) {
          return setModal({ ...modal, index: modal.index + 1, values, input: '', revealed: false });
        }
        setModal(null);
        if (modal.connector === 'notion' || modal.connector === 'slack') {
          const id = modal.connector;
          return runAction(
            () => client.call('services.setToken', { id, token: values.token ?? '' }),
            `${id} connected`,
          );
        }
        if (modal.connector === 'hermes') {
          return runAction(
            () =>
              client.call('setup.importHermes', {
                baseUrl: values.baseUrl ?? '',
                apiKey: values.apiKey ?? '',
                model: values.model ?? '',
              }),
            'Hermes endpoint stored',
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
      if (key.tab && modal.paths) {
        // A URL (a GitHub skill) is not a path.
        if (/^[a-z]+:\/\//i.test(modal.input)) return;
        return setModal({ ...modal, ...completePath(modal.input, modal.paths) });
      }
      if (key.backspace || key.delete) return editModalInput((v) => [...v].slice(0, -1).join(''));
      if (key.ctrl && ch === 'u') return editModalInput(() => '');
      if (key.ctrl && ch === 'w') return editModalInput((v) => v.replace(/\S+\s*$/, ''));
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
      if (key.downArrow) return setModal({ ...modal, scroll: down(modal.scroll) });
      if (key.escape || key.return || ch === 'q' || ch === '?') setModal(null);
      return;
    }
    if (modal?.kind === 'palette') {
      const entries = paletteEntries(keymap, modal.context, modal.query, modal.active);
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
    if (modal?.kind === 'settings' && modal.editing && modal.state) {
      const { field } = modal.editing;
      // From the latest input, as for the other dialogs (fast typing).
      const typing = (f: (v: string) => string) =>
        setModal((m) =>
          m?.kind === 'settings' && m.editing
            ? {
                ...m,
                editing: { field, input: f(m.editing.input).slice(0, TEXT_FIELDS[field]) },
              }
            : m,
        );
      if (key.escape) return setModal({ ...modal, editing: undefined });
      if (key.backspace || key.delete) return typing((v) => [...v].slice(0, -1).join(''));
      if (key.return) {
        return setModal((m) => {
          if (m?.kind !== 'settings' || !m.editing || !m.state) return m;
          const { input } = m.editing;
          if (field === 'model' && !MODEL.test(input.trim())) {
            const error = 'a model id has letters, digits and . _ - : / @ +';
            return { ...m, editing: { ...m.editing, error } };
          }
          return { ...m, editing: undefined, state: { ...m.state, [field]: input } };
        });
      }
      if (ch && !key.ctrl && !key.meta) typing((v) => v + ch.replace(/[\r\n]/g, ''));
      return;
    }
    if (modal?.kind === 'settings') {
      if (key.escape)
        return setModal(modal.proposalId ? (proposalModal(modal.proposalId) ?? null) : null);
      if (!modal.data || !modal.state) return;
      if (ch === 'D' && !modal.proposalId) return openDelete(modal.agentId);
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
        const row = settingsRows(modal.data, modal.state).filter((r) => r.kind !== 'header')[
          modal.cursor
        ];
        if (row?.kind === 'field' && row.id === 'prompt') return editPrompt();
        if (row?.kind === 'field' && isTextField(row.id)) {
          return setModal({ ...modal, editing: { field: row.id, input: modal.state[row.id] } });
        }
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
    if (modal?.kind === 'deleteAgent') {
      if (key.escape) return setModal(null);
      if (key.return) {
        if (modal.preview && modal.input === modal.agentId) return deleteAgent(modal.agentId);
        return;
      }
      if (key.backspace || key.delete) {
        return setModal((m) =>
          m?.kind === 'deleteAgent' ? { ...m, input: [...m.input].slice(0, -1).join('') } : m,
        );
      }
      if (ch && !key.ctrl && !key.meta) {
        return setModal((m) =>
          m?.kind === 'deleteAgent'
            ? { ...m, input: (m.input + ch.replace(/[\r\n]/g, '')).slice(0, 40) }
            : m,
        );
      }
      return;
    }
    if (modal?.kind === 'access' && modal.pick !== undefined) {
      const hosts = modal.data ? refusedHosts(modal.data) : [];
      if (key.escape) return setModal({ ...modal, pick: undefined });
      if (key.upArrow || ch === 'k')
        return setModal({ ...modal, pick: Math.max(0, modal.pick - 1) });
      if (key.downArrow || ch === 'j') {
        return setModal({ ...modal, pick: Math.min(hosts.length - 1, modal.pick + 1) });
      }
      const host = hosts[modal.pick];
      if (key.return && host) {
        const { agentId } = modal;
        return setModal({
          kind: 'confirm',
          title: `Allow ${sanitizeLine(host)} for @${agentId}`,
          body: `Adds exactly this host to the egress list in ~/.anchi/agents/${agentId}.yaml. Its cells can then reach it and send it whatever they read. It applies from the agent's next cell.`,
          action: () => client.call('agents.allowHost', { agentId, host }),
        });
      }
      return;
    }
    if (modal?.kind === 'access') {
      if (key.escape || ch === 'q') return setModal(null);
      if (ch === 'e') {
        if (!modal.data || !refusedHosts(modal.data).length) {
          return say('no host was refused by the egress list in this task');
        }
        return setModal({ ...modal, pick: 0 });
      }
      const step = key.pageUp || key.pageDown ? 10 : 1;
      if (key.upArrow || key.pageUp || ch === 'k') {
        return setModal((m) =>
          m?.kind === 'access' ? { ...m, scroll: Math.max(0, m.scroll - step) } : m,
        );
      }
      if (key.downArrow || key.pageDown || ch === 'j') {
        return setModal((m) => (m?.kind === 'access' ? { ...m, scroll: down(m.scroll, step) } : m));
      }
      return;
    }
    if (modal?.kind === 'retry') {
      if (key.escape) return setModal(null);
      if (ch !== 'c' && ch !== 'n') return;
      const { taskId: id, agentId } = modal;
      setModal(null);
      return void client
        .call('tasks.retry', { taskId: id, fresh: ch === 'n' })
        .then((t) => {
          // Watch it run: in the task's view (the builder's in its chat).
          if (agentId === BUILDER) {
            setFocusTask((f) => ({ ...f, [agentId]: t.id }));
            setSelected(agentId);
          } else setSelected(TASK_ITEM + t.id);
          setFocus('main');
          say(t.id === id ? `${id} continues` : `${id} started again as ${t.id}`);
        })
        .catch((e: Error) => reportProblem(e));
    }
    if (modal?.kind === 'settingsReview') {
      if (ch === 'y' && !modal.update.errors.length) {
        const { agentId, patch, update } = modal;
        setModal(null);
        return void client
          .call('agents.update', { agentId, patch, apply: true, base: update.base })
          .then(() => say(`@${agentId} settings saved; its next cell uses them`))
          .catch((e: Error) => reportProblem(e));
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
    if (typing) {
      // The input keeps standard line editing, and printable keys are always text.
      if (stroke && LINE_EDIT_KEYS.has(stroke)) {
        return setDraft((d) => edit(d, stroke) ?? d);
      }
      // Named and modified keys are longer than one character (`ctrl+a`, `enter`).
      if (ch && (!stroke || stroke === 'space' || [...stroke].length === 1)) {
        // Fast typing or a non-bracketed paste can deliver text and Enter in one chunk.
        const nl = ch.search(/[\r\n]/);
        if (nl >= 0) {
          if (ch.endsWith('\r') && !ch.slice(0, -1).match(/[\r\n]/)) {
            setDraft((d) => insert(d, ch.slice(0, -1)));
            return submit();
          }
          return setDraft((d) => insert(d, sanitize(ch).replace(/\r\n?/g, '\n')));
        }
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
      if (modal) return;
      const side = sideWidth > 0 ? e.x <= sideWidth : focus === 'side';
      // The wheel scrolls the transcript, or turns task pages over the sidebar.
      if (e.kind === 'wheelUp' || e.kind === 'wheelDown') {
        const up = e.kind === 'wheelUp';
        if (side) return turnPageRef.current(pageRef.current + (up ? -1 : 1));
        return scrollRef.current((s) => (up ? s + 3 : Math.max(0, s - 3)));
      }
      if (e.kind !== 'press' || e.button !== 0) return;
      setFocus(side ? 'side' : 'main');
      if (!side) {
        const line = visibleRef.current[e.y - firstRowRef.current];
        if (line?.group) toggleGroup(line.group);
        if (line?.task) setSelected(TASK_ITEM + line.task);
        return;
      }
      const row = sideRowsRef.current[e.y - SIDEBAR_FIRST_ROW];
      if (row?.kind === 'item') setSelected(row.item);
      // The pager reads "‹ prev  ·  next ›": its left half goes back, its right half forward.
      if (row?.kind === 'pager')
        turnPageRef.current(row.page + (e.x <= SIDEBAR_WIDTH / 2 ? -1 : 1));
    });
  }, [onMouse, sideWidth, modal, focus]);

  // ── render ──────────────────────────────────────────────
  if (modal) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <ModalView
          modal={modal}
          width={columns}
          height={rows}
          keymap={keymap}
          setupLog={setupLog}
          progress={setupProgress?.phase}
          maxScroll={modalMax}
        />
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
        }${agent.skills?.length ? ` · 🧩 ${agent.skills.join(', ')}` : ''}${chatMode ? (task ? ` · ${task.id} (${task.status})` : ' · new task') : ''}`
      : CONFIG_LABEL[current as ConfigItem];
  const busy = detail?.status === 'running' || detail?.status === 'queued';
  /** `key label` for an action in this view, from the effective bindings (shortest first). */
  const hint = (action: ActionId, label: string) => {
    const keys = keysFor(
      keymap,
      action.startsWith('chat:') ? ['chat', 'global'] : active,
      action,
    ).sort((a, b) => a.split(' ').length - b.split(' ').length);
    return keys[0] ? `${keyLabel(keys[0])} ${label}` : '';
  };
  const hints: [ActionId, string][] =
    context === 'welcome'
      ? [
          ['welcome:next', 'continue'],
          ['setup:codex', 'Codex'],
          ['setup:claude', 'Claude'],
          ['setup:hermes', 'Hermes'],
          ['setup:logs', 'logs'],
        ]
      : context === 'approvals'
        ? [
            ['approvals:approve', 'select approve'],
            ['approvals:deny', 'select deny'],
            ['approvals:confirm', 'confirm'],
            ['list:down', 'choose'],
            ['approvals:open', 'full dialog'],
            ['approvals:task', 'open the task'],
          ]
        : context === 'team'
          ? [
              ['team:open', 'open'],
              ['list:down', 'choose'],
              ['approvals:open', 'review approvals'],
            ]
          : context === 'sidebar'
            ? [
                ['focus:main', 'open'],
                ['tasks:pageNext', 'task page'],
                ['tasks:filter', 'filter'],
                ['focus:toggle', 'pane'],
              ]
            : context === 'task'
              ? [
                  ['chat:submit', 'reply'],
                  ['task:history', showHistory ? 'result' : 'history'],
                  ['task:access', 'access'],
                  ...((detail?.status === 'failed' || detail?.status === 'cancelled'
                    ? [['task:retry', 'retry']]
                    : []) as [ActionId, string][]),
                  busy ? ['task:cancel', 'cancel'] : ['task:delete', 'delete'],
                  ['task:new', `new task for @${detail?.agentId}`],
                  ['chat:escape', 'sidebar'],
                ]
              : context === 'chat'
                ? [
                    ['chat:submit', chatMode ? 'send' : 'start task'],
                    ['chat:newline', 'newline'],
                    ...((chatMode ? [['task:new', 'new task']] : []) as [ActionId, string][]),
                    ['chat:escape', 'sidebar'],
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
                      ['connectors:account', 'another Google account'],
                      ['connectors:googleClient', 'Google client'],
                      ['connectors:xClient', 'X client'],
                      ['connectors:redditClient', 'Reddit client'],
                    ]
                  : context === 'usage'
                    ? [
                        ['usage:period', PERIODS[usagePeriod]!.label],
                        ['usage:group', `by ${GROUPS[usageGroup]}`],
                        ['usage:refresh', 'refresh'],
                      ]
                    : context === 'access'
                      ? [
                          ['access:period', PERIODS[accessPeriod]!.label],
                          ['access:refresh', 'refresh'],
                        ]
                      : context === 'skills'
                        ? [
                            ['list:down', 'choose'],
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
                            ['setup:hermes', 'Hermes'],
                          ];
  const status = pending.length
    ? `${keyLabel(pending.join(' '))} …  (Esc cancels)`
    : (problem ? `! ${hint('problem:open', 'resolve')} · ${sanitizeLine(problem.message)}` : '') ||
      flash ||
      [
        ...hints.map(([a, l]) => hint(a, l)),
        proposals.length ? hint('builder:proposal', 'proposal') : '',
        problem || task?.status === 'failed' ? hint('problem:open', 'resolve problem') : '',
      ]
        .filter(Boolean)
        .join(' · ');
  // Always visible at the right, so a narrow window never cuts off the way to every other key.
  const menuHint =
    pending.length || selecting
      ? ''
      : [hint('app:palette', 'commands'), hint('app:help', 'keys')].filter(Boolean).join(' · ');
  const statusLine = selecting
    ? 'Selection mode: drag to select, copy with your terminal · ↑↓ PgUp PgDn scroll · any other key ends'
    : approvals.length && !pending.length
      ? `⏸ ${approvals.length} write${approvals.length === 1 ? '' : 's'} waiting for approval (${keyLabel(keysFor(keymap, active, 'approvals:open')[0] ?? '')}) · ${status}`
      : status;
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={bodyHeight}>
        {!selecting && (sideWidth > 0 || focus === 'side') ? (
          <Sidebar
            focused={focus === 'side'}
            rows={sideRows}
            agents={agents}
            tasks={tasks}
            current={current}
            height={bodyHeight}
            frame={frame}
            pending={approvals.length}
          />
        ) : null}
        <Box
          flexDirection="column"
          display={sideWidth === 0 && focus === 'side' && !selecting ? 'none' : 'flex'}
          width={mainWidth}
          height={bodyHeight}
          borderStyle={selecting ? undefined : 'round'}
          borderColor={focus === 'main' ? 'cyan' : 'gray'}
          paddingX={selecting ? 0 : 1}
          paddingY={selecting ? 1 : 0}
        >
          <Text bold wrap="truncate">
            {header}
          </Text>
          <Text dimColor>{'─'.repeat(textWidth)}</Text>
          {current === 'welcome' ? (
            <WelcomeView
              setup={setup}
              agents={agents}
              tasks={tasks}
              width={textWidth}
              height={bodyHeight - 4}
              scroll={scroll}
              busy={
                setupProgress?.running
                  ? `${SPINNER[frame % SPINNER.length]} ${setupProgress.phase} · ${duration(Date.now() - setupProgress.startedAt)}`
                  : setup?.preparing
                    ? `Preparing ${setup.preparing} · completed steps are reused`
                    : ''
              }
              nextKey={hint('welcome:next', 'continue')}
            />
          ) : current === 'approvals' ? (
            <ApprovalsView
              approvals={approvals}
              cursor={Math.min(approvalCursor, Math.max(0, approvals.length - 1))}
              pick={approvalPick}
              now={clock}
              width={textWidth}
              height={bodyHeight - 4}
              keys={{
                select: `${hint('approvals:approve', 'select approve')} · ${hint('approvals:deny', 'select deny')} · ${hint('approvals:confirm', 'confirm')}`,
                confirm: hint('approvals:confirm', 'confirm'),
                open: hint('approvals:open', 'review full content'),
              }}
            />
          ) : current === 'team' ? (
            <TeamView
              agents={userAgents}
              tasks={tasks}
              approvals={approvals}
              logs={logs}
              cursor={Math.min(teamCursor, userAgents.length - 1)}
              height={bodyHeight - 4}
              hints={`${hint('nav:welcome', 'Getting started')} · ${hint('nav:builder', 'Agent builder')}`}
            />
          ) : agent ? (
            <>
              <Box flexDirection="column" height={transcriptHeight}>
                {agent.error ? (
                  <Text color="red">{sanitize(agent.error)}</Text>
                ) : visible.length ? (
                  visible.map((l, i) => <LineText key={i} line={l} />)
                ) : (
                  <Text dimColor>
                    {current === BUILDER
                      ? 'Describe the agent you want: its job, the services it needs, the tools it uses.'
                      : `Give @${agent.id} a task. Each message starts a new task in a fresh cell; credentials stay outside. Open a task (click it, or in the sidebar) to talk to it.`}
                  </Text>
                )}
              </Box>
              {offset > 0 ? (
                <Text dimColor>{`↓ ${offset} more lines (PgDn)`}</Text>
              ) : (
                <Text color="cyan" wrap="truncate">
                  {(chatMode && working) || ' '}
                </Text>
              )}
              <Text color="cyan" wrap="truncate">
                {chatMode
                  ? `To @${agent.id} · ${task ? `Continue: ${sanitizeLine(task.title)}` : 'New task (new session)'} · ${hint('task:new', 'new task')}`
                  : `New task for @${agent.id} · ${agentTasks.filter((t) => t.status === 'running').length} running · ${agentTasks.filter((t) => t.status === 'queued').length} queued (up to ${agent.maxTasks ?? 3} at once) · click a task to open it`}
              </Text>
              <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
                {composer.rows.map((row, i) => (
                  <Text key={i} wrap="truncate">
                    <Text color="cyan">{i ? '  ' : '› '}</Text>
                    {row.before}
                    {row.cursor ? <Text inverse>{row.at}</Text> : row.at}
                    {row.after}
                  </Text>
                ))}
              </Box>
              <Text dimColor wrap="truncate">
                {sending.current.has(conversationKey)
                  ? 'Sending…'
                  : `${hint('chat:submit', input.includes('\n') ? 'preview & send' : 'send')} · ${hint('chat:newline', 'newline')} · ${hint('chat:editor', 'editor')}${composer.hiddenAbove || composer.hiddenBelow ? ' · more draft lines above/below' : ''}`}
              </Text>
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
                  visible.map((l, i) => <LineText key={i} line={l} />)
                ) : (
                  <Text dimColor>Loading…</Text>
                )}
              </Box>
              {offset > 0 ? (
                <Text dimColor>{`↓ ${offset} more lines (PgDn)`}</Text>
              ) : (
                <Text color="cyan" wrap="truncate">
                  {working || ' '}
                </Text>
              )}
              <Text color="cyan" wrap="truncate">
                {busy
                  ? `Reply to ${detail.id} · send it when this turn ends (your draft is kept)`
                  : `Reply to ${detail.id} · continues its session · ${hint('task:new', 'new task')}`}
              </Text>
              <Box
                borderStyle="round"
                borderColor={busy ? 'gray' : 'cyan'}
                paddingX={1}
                flexDirection="column"
              >
                {composer.rows.map((row, i) => (
                  <Text key={i} wrap="truncate">
                    <Text color="cyan">{i ? '  ' : '› '}</Text>
                    {row.before}
                    {row.cursor ? <Text inverse>{row.at}</Text> : row.at}
                    {row.after}
                  </Text>
                ))}
              </Box>
              <Text dimColor wrap="truncate">
                {sending.current.has(conversationKey)
                  ? 'Sending…'
                  : `${hint('chat:submit', input.includes('\n') ? 'preview & send' : 'send')} · ${hint('chat:newline', 'newline')} · ${hint('chat:editor', 'editor')} · ${hint('task:cancel', 'cancel')} · ${hint('task:access', 'access')}${composer.hiddenAbove || composer.hiddenBelow ? ' · more draft lines above/below' : ''}`}
              </Text>
            </>
          ) : current === 'connectors' ? (
            <ConnectorsView
              setup={setup}
              cursor={connectorCursor}
              width={textWidth}
              height={bodyHeight - 4}
            />
          ) : current === 'runtimes' ? (
            <RuntimesView setup={setup} log={setupLog.slice(-6)} progress={setupProgress?.phase} />
          ) : current === 'access' || current === 'usage' ? (
            <Report lines={reportLines} height={reportHeight} scroll={scroll} />
          ) : (
            <SkillsView
              skills={skills}
              cursor={skillCursor}
              width={textWidth}
              height={bodyHeight - 4}
            />
          )}
        </Box>
      </Box>
      {whichKeyRows ? <WhichKey next={next} width={columns} /> : null}
      <Box flexDirection="row" width={columns}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate">
            {statusLine}
          </Text>
        </Box>
        {menuHint ? (
          <Box flexShrink={0} paddingLeft={1}>
            <Text color="cyan">{menuHint}</Text>
          </Box>
        ) : null}
      </Box>
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
  /** The contexts whose actions apply (a task's view also takes the chat's). */
  active: readonly Context[] = [context, 'global'],
): { action: ActionId; title: string; keys: string }[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const matches = (text: string) => {
    let i = 0;
    for (const c of text.toLowerCase()) if (c === q[i]) i++;
    return i === q.length;
  };
  return (Object.keys(ACTIONS) as ActionId[])
    .filter((a) => {
      const ctx: readonly Context[] = ACTIONS[a].contexts;
      return ctx.some((c) => active.includes(c)) && a !== 'app:palette';
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
  /** Writes waiting for approval, shown on the Approvals item. */
  pending: number;
}) {
  const { focused, rows, agents, tasks, current, height, frame, pending } = props;
  const inner = SIDEBAR_WIDTH - 4;
  const spin = SPINNER[frame % SPINNER.length]!;
  const running = (id: string) => tasks.some((t) => t.agentId === id && t.status === 'running');
  const item = (key: string) => {
    if (key === 'approvals' && pending) {
      return { glyph: '⏸', color: 'yellow', text: `${CONFIG_LABEL.approvals} ${pending}` };
    }
    if (([...HOME, ...CONFIG] as readonly string[]).includes(key)) {
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

function ConnectorsView({
  setup,
  cursor,
  width,
  height,
}: {
  setup: SetupStatus | null;
  cursor: number;
  width: number;
  height: number;
}) {
  if (!setup) return <Text dimColor>Loading…</Text>;
  // A reopened TUI can still be connected to a daemon from before the source update.
  const missing = setup.services?.length
    ? serviceIds.filter((id) => !setup.services!.some((s) => s.id === id))
    : [];
  const notes: Record<string, string> = {
    github: 'API (bearer) and git over HTTPS; key and secret APIs are denied',
    aws: 'requests re-signed by the proxy; use a dedicated least-privilege principal',
    linear: 'GraphQL API key; API key management is denied',
    posthog: 'US or EU Cloud API; key management is denied',
    sentry: 'API (sentry.io); token creation is denied',
    firecrawl: 'scrape, crawl and search; fetches any URL, beyond an egress list',
    figma: 'REST API; webhooks wait for approval',
    discord: 'bot REST API, no gateway; webhook tokens are denied',
  };
  type Row = { text: string; color?: string; dim?: boolean; bold?: boolean; selected?: boolean };
  const lines: Row[] = [];
  const add = (text: string, style: Omit<Row, 'text'> = {}) => {
    for (const part of wrap(text, width)) lines.push({ text: part, ...style });
  };
  let selectedRow = 0;
  const select = (index: number) => {
    if (index === cursor) selectedRow = lines.length;
    return index === cursor;
  };
  if (missing.length) {
    add(`Daemon missing connectors: ${missing.join(', ')}`, { color: 'yellow' });
    add('After tasks finish: anchi daemon stop', { color: 'yellow' });
    add('Then anchi setup install and reopen Anchi.', { color: 'yellow' });
  }
  if (!setup.vaultUnlocked)
    add('The vault is locked. Open Getting started to initialize or unlock it.', { color: 'red' });
  // One column for every id, the services' too, so firecrawl does not push its row out.
  const idWidth = Math.max(8, ...setup.connectors.map((c) => c.id.length)) + 1;
  setup.connectors.forEach((c, i) => {
    add(
      `${c.connected ? '●' : '○'} ${c.id.padEnd(idWidth)}${
        c.connected ? sanitizeLine(c.account ?? 'connected') : 'not connected'
      }${c.profile ? ` · profile ${sanitizeLine(c.profile)}` : ''}`,
      { selected: select(i), color: c.connected ? 'green' : undefined },
    );
    add(`  ${notes[c.id]}`, { dim: true });
  });
  add('SERVICES', { bold: true, dim: true });
  add(
    `  Google client (Gmail, Drive): ${
      setup.googleClientSource === 'builtin'
        ? 'built-in'
        : setup.googleClientSource === 'user' || setup.googleClient
          ? 'your own'
          : 'none yet — Enter on gmail or drive imports one'
    } · o to change`,
    { dim: true },
  );
  (setup.services ?? []).forEach((c, i) => {
    const accounts = (c.accounts ?? []).filter((a) => a.connected || a.revocationPending);
    const listAccounts =
      accounts.length > 1 || accounts.some((a) => a.name !== 'default' || a.revocationPending);
    const google = c.id === 'gmail' || c.id === 'drive';
    const social = c.id === 'x' || c.id === 'reddit';
    const signInPending = !c.connected && !c.reauthRequired && setup.googleClient && google;
    const status = c.reauthRequired
      ? 'sign in again'
      : c.revocationPending && social
        ? 'revocation pending — disconnect again'
        : c.connected
          ? sanitizeLine(c.account ?? 'connected')
          : signInPending
            ? setup.googleClientSource === 'builtin'
              ? 'press Enter to sign in with Google'
              : 'client stored — press Enter to sign in'
            : google && !setup.googleClient
              ? 'needs a Google OAuth client first — Enter imports yours (docs/GMAIL_SETUP.md)'
              : c.id === 'x'
                ? setup.xClient
                  ? 'press Enter to sign in with X'
                  : 'needs an X native app Client ID — Enter to configure'
                : c.id === 'reddit'
                  ? setup.redditClient
                    ? 'press Enter to sign in with Reddit'
                    : 'needs an approved Reddit installed app — Enter to configure'
                  : 'not connected';
    add(
      `${c.connected ? '●' : '○'} ${c.id.padEnd(idWidth)}${status} · writes ${
        social ? 'always ask' : c.mode === 'ask' ? 'ask' : 'auto'
      }`,
      {
        selected: select(i + setup.connectors.length),
        color: c.reauthRequired
          ? 'red'
          : c.connected
            ? 'green'
            : signInPending
              ? 'yellow'
              : undefined,
      },
    );
    if (listAccounts)
      for (const a of accounts)
        add(
          `  └ ${sanitizeLine(a.name).padEnd(10)}${
            a.revocationPending
              ? 'revocation pending — disconnect again'
              : a.reauthRequired
                ? 'sign in again (Enter)'
                : sanitizeLine(a.account ?? 'connected')
          }`,
          { dim: !a.reauthRequired, color: a.reauthRequired ? 'red' : undefined },
        );
  });
  const room = Math.max(1, height - 2);
  const start = listWindow(lines.length, selectedRow, room);
  const count = setup.connectors.length + (setup.services?.length ?? 0);
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={room} flexShrink={0}>
        {lines.slice(start, start + room).map((line, i) => (
          <Text
            key={i}
            color={line.color}
            dimColor={line.dim}
            bold={line.bold}
            inverse={line.selected}
            wrap="truncate"
          >
            {line.text}
          </Text>
        ))}
      </Box>
      <Text
        dimColor
        wrap="truncate"
      >{`${Math.min(cursor + 1, count)}/${count} connectors · ↑↓ choose · Enter connect`}</Text>
      <Text dimColor wrap="truncate">
        Credentials stay in the VM vault.
      </Text>
    </Box>
  );
}

/** A path typed in the TUI as an absolute path: `~/` is the home directory, relative is the cwd. */
function localPath(path: string): string {
  const home = process.env.HOME ?? '';
  return resolvePath(path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path);
}

/** Reads the Google client JSON the user points at (on this computer). */
async function readClientFile(path: string): Promise<string> {
  const file = localPath(path);
  if ((await stat(file)).size > 16_384) throw new Error('that file is too large for a client JSON');
  return readFile(file, 'utf8');
}

/** Where a skill came from: `owner/repo @ 1be8e34` for GitHub, `local` for a directory. */
export function skillSource(skill: SkillInfo): string {
  if (!skill.commit) return 'local';
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)/.exec(skill.source);
  const repo = m ? m[1]! : sanitizeLine(skill.source);
  return `${repo} @ ${skill.commit.slice(0, 7)}`;
}

/** Skills of one repository sit together, so a whole collection can be updated or removed in turn. */
export function sortSkills(skills: SkillInfo[]): SkillInfo[] {
  const group = (s: SkillInfo) => (s.commit ? `0${skillSource(s)}` : '1');
  return [...skills].sort((a, b) => group(a).localeCompare(group(b)) || a.id.localeCompare(b.id));
}

/** Rows the skill list gets: the view keeps a counter above it and two lines below. */
const skillListRows = (height: number) => Math.max(1, height - 3);

/** The first row shown, so that the cursor stays visible with context around it. */
function listWindow(count: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), count - rows));
}

function SkillsView({
  skills,
  cursor,
  width,
  height,
}: {
  skills: SkillInfo[] | null;
  cursor: number;
  width: number;
  height: number;
}) {
  if (!skills) return <Text dimColor>Loading…</Text>;
  if (!skills.length) return <Text dimColor>No skills yet. Press a to add one.</Text>;
  const rows = skillListRows(height);
  const start = listWindow(skills.length, cursor, rows);
  const shown = skills.slice(start, start + rows);
  // One line each: the id in a column as wide as the longest id, then where it came from.
  const idWidth = Math.min(32, Math.max(...skills.map((s) => s.id.length)));
  const selected = skills[cursor];
  return (
    <Box flexDirection="column" height={Math.max(1, height)}>
      <Text dimColor wrap="truncate">
        {`${Math.min(cursor + 1, skills.length)}/${skills.length}${start > 0 ? ' · ↑ more' : ''}${
          start + rows < skills.length ? ' · ↓ more' : ''
        }`}
      </Text>
      {shown.map((s, i) => (
        <Text key={s.id} inverse={start + i === cursor} wrap="truncate">
          {truncate(`${s.id.padEnd(idWidth)}  ${skillSource(s)}`, width)}
        </Text>
      ))}
      <Text dimColor wrap="truncate">
        {selected ? truncate(sanitizeLine(selected.description) || '—', width) : ''}
      </Text>
      <Text dimColor wrap="truncate">
        Agents use skills listed in their `skills:` field · content is untrusted, like any agent
        input
      </Text>
    </Box>
  );
}

function RuntimesView({
  setup,
  log,
  progress,
}: {
  setup: SetupStatus | null;
  log: string[];
  progress?: string;
}) {
  if (!setup) return <Text dimColor>Loading…</Text>;
  const c = setup.codex;
  const expired = c.expiresAt !== null && c.expiresAt < Date.now();
  const size = setup.vmSize?.current;
  return (
    <Box flexDirection="column">
      <Text>
        VM:{' '}
        <Text color={setup.vm === 'running' ? 'green' : 'red'}>
          {setup.vm}
          {size ? ` (${size.cpus} CPUs, ${size.memoryGiB} GiB)` : ''}
        </Text>{' '}
        · vault:{' '}
        <Text color={setup.vaultUnlocked ? 'green' : 'red'}>
          {setup.vaultUnlocked ? 'unlocked' : 'locked'}
        </Text>{' '}
        · base image:{' '}
        <Text color={setup.installed ? 'green' : 'yellow'}>
          {setup.installed ? 'built' : 'not built yet'}
        </Text>
      </Text>
      {setup.error ? (
        <Text color="red">
          {`The VM runs but could not be asked: ${sanitizeLine(setup.error)} · r to check again; I reinstalls its components if it keeps failing`}
        </Text>
      ) : null}
      {setup.vm === 'running' && setup.installed && setup.guestOutdated !== undefined ? (
        <Text>
          Components:{' '}
          {setup.guestOutdated ? (
            <Text color="red">
              {`installed by Anchi ${setup.guestVersion ?? 'an older release'}; this is ${setup.appVersion} — press I to update them`}
            </Text>
          ) : (
            <Text color="green">{`Anchi ${setup.guestVersion ?? setup.appVersion}`}</Text>
          )}
        </Text>
      ) : null}
      <Text>
        Codex (ChatGPT subscription):{' '}
        {c.connected ? (
          <Text color={expired ? 'red' : 'green'}>
            {expired
              ? 'token expired — run `codex` on this computer once (it refreshes the login), then press i to re-import'
              : `connected, token valid until ${new Date(c.expiresAt!).toLocaleString()}`}
          </Text>
        ) : (
          <Text color="yellow">
            not connected — run `codex login` on this computer, then press i
          </Text>
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
        {setup.claude?.connected && !runtimeReady(setup, 'claude-code') ? (
          <Text color="yellow">
            login expired — open Claude Code on this computer to refresh it
          </Text>
        ) : setup.claude?.connected ? (
          <Text color="green">
            connected ({setup.claude.kind === 'api_key' ? 'API key' : 'subscription token'})
          </Text>
        ) : (
          <Text color="yellow">
            not connected — sign in to Claude Code on this computer, or press c to paste a token
          </Text>
        )}
      </Text>
      <Text>
        Hermes:{' '}
        {setup.hermes?.connected ? (
          <Text color="green">
            {sanitizeLine(setup.hermes.baseUrl ?? '')} · {sanitizeLine(setup.hermes.model ?? '')}
          </Text>
        ) : (
          <Text color="yellow">
            not set up — press h for an OpenAI-compatible endpoint and API key
          </Text>
        )}
      </Text>
      {progress ? (
        <Text color="cyan">
          {progress} · use the command palette for Installation progress and logs
        </Text>
      ) : null}
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
  welcome: 'Getting started',
  team: 'Team overview',
  approvals: 'Approvals',
  sidebar: 'Sidebar',
  chat: 'Agent view (each message starts a task; the builder continues one)',
  task: 'Task (the input replies to the task)',
  runtimes: 'Runtimes',
  skills: 'Skills',
  connectors: 'Connectors',
  usage: 'Usage',
  access: 'Access',
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
  // A task's view has the chat's input; its own bindings come after the input's.
  const own = [
    ...(context === 'task' ? group('chat', new Set()) : []),
    ...(context === 'global' ? [] : group(context, new Set())),
  ];
  const ownActions = new Set([
    ...keymap.contexts[context].values(),
    ...(context === 'task' ? keymap.contexts.chat.values() : []),
  ]);
  const rows: [string, string][] = [];
  if (own.length) rows.push([CONTEXT_LABEL[context], ''], ...own, ['', '']);
  rows.push(
    [`Everywhere (leader ${keyLabel(keymap.leader)}, then a key)`, ''],
    ...group('global', context === 'global' ? new Set() : ownActions),
  );
  if (context === 'chat' || context === 'task') {
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
    ['y/n then Enter', 'approval: select a decision, then confirm'],
    ['y n Esc', 'confirmation and proposal dialogs'],
    ['Space Enter', 'agent settings: change or select, then review the change (s in a proposal)'],
  );
  return rows;
}

/** Report lines in a fixed height, from line `scroll`. */
function Report({
  lines,
  height,
  scroll,
}: {
  lines: ReportLine[];
  height: number;
  scroll: number;
}) {
  const start = Math.min(scroll, Math.max(0, lines.length - height));
  return (
    <Box flexDirection="column" height={height}>
      {lines.slice(start, start + height).map((l, i) => (
        <Text key={i} color={l.color} bold={l.bold} dimColor={l.dim} wrap="truncate">
          {l.text || ' '}
        </Text>
      ))}
    </Box>
  );
}

function ModalView({
  modal,
  width,
  height,
  keymap,
  setupLog,
  progress,
  maxScroll,
}: {
  setupLog: string[];
  progress?: string;
  modal: Modal;
  width: number;
  height: number;
  keymap: KeyMap;
  /** Written here as each scrolling dialog lays out: how far it can scroll. */
  maxScroll: { current: number };
}) {
  const inner = width - 6;
  /** The first visible line, and the dialog's scroll limit for the key handlers. */
  const first = (scroll: number, count: number, room: number) => {
    maxScroll.current = Math.max(0, count - room);
    return Math.min(scroll, maxScroll.current);
  };
  const label = (action: ActionId) => keyLabel(keysFor(keymap, ['global'], action)[0] ?? '');
  if (modal.kind === 'composeReview' || modal.kind === 'setupLog' || modal.kind === 'problem') {
    const recovery = modal.kind === 'problem' ? recoveryFor(modal.message) : undefined;
    const title =
      modal.kind === 'composeReview'
        ? `Review message · ${modal.target}`
        : modal.kind === 'setupLog'
          ? `Installation · ${progress ?? 'Not started'}`
          : recovery!.title;
    const content =
      modal.kind === 'composeReview'
        ? modal.text
        : modal.kind === 'setupLog'
          ? setupLog.join('\n') || 'No installation logs yet.'
          : `${recovery!.explanation}\n\nDetails\n${modal.message}`;
    const lines = wrap(sanitize(content), Math.max(2, inner));
    const heightInside = Math.max(1, height - 5);
    const start = first(modal.scroll, lines.length, heightInside);
    const footer =
      modal.kind === 'composeReview'
        ? 'Enter send · Esc keep editing · ↑↓ scroll'
        : modal.kind === 'setupLog'
          ? '↑↓ scroll · Esc close (installation continues)'
          : `Enter ${recovery!.label}${modal.retry ? ' · r retry failed setup step' : ''} · d dismiss · Esc close · ↑↓ details`;
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
      >
        <Text bold wrap="truncate">
          {sanitizeLine(title)}
        </Text>
        <Report lines={lines.map((text) => ({ text }))} height={heightInside} scroll={start} />
        <Text wrap="truncate">{footer}</Text>
      </Box>
    );
  }
  if (modal.kind === 'createAgent' || modal.kind === 'quickSetup') {
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
          {modal.kind === 'quickSetup' ? 'Choose your runtime' : 'Create a starter agent'}
        </Text>
        <Text>
          {modal.kind === 'quickSetup'
            ? 'Choose the account you want to use. Anchi prepares its environment next.'
            : 'Choose a runtime. Connect it in Runtimes before running a task.'}
        </Text>
        <Text> </Text>
        {STARTER_RUNTIMES.map((runtime, i) => (
          <Text key={runtime} color={i === modal.pick ? 'cyan' : undefined}>
            {i === modal.pick ? '› ' : '  '}
            {runtime}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>
          {modal.kind === 'quickSetup'
            ? 'Preparation uses no model quota. Your account is connected afterwards.'
            : 'No model call · no connectors or shared folders · any public host; the proposal review comes next'}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          ↑/↓ choose · Enter continue · Esc cancel · this screen is drawn by Anchi, not by an agent
        </Text>
      </Box>
    );
  }
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
            {field.masked && !modal.revealed
              ? '•'.repeat(Math.min([...modal.input].length, inner - 4))
              : sanitizeLine(modal.input)}
            <Text inverse> </Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>
          Enter next · Esc cancel
          {field.masked ? ` · Tab ${modal.revealed ? 'hide' : 'show'} the input` : ''} · ^U clear ·
          this screen is drawn by Anchi, not by an agent
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'approval') {
    const a = modal.approval;
    const left = Math.max(0, Math.round(a.timeout - (Date.now() - a.createdAt) / 1000));
    const room = Math.max(3, height - 13);
    const lines = wrap(sanitize(a.summary), Math.max(10, inner));
    const start = first(modal.scroll, lines.length, room);
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
          {lines.slice(start, start + room).map((l, i) => (
            <Text key={i} wrap="truncate">
              {l || ' '}
            </Text>
          ))}
        </Box>
        <Box flexGrow={1} />
        <Text
          dimColor
        >{`↑↓ PgUp/PgDn · Home/End · lines ${start + 1}–${Math.min(start + room, lines.length)}/${lines.length}`}</Text>
        <Text dimColor>The content above comes from the agent. This dialog is drawn by Anchi.</Text>
        <Text bold>
          {modal.decision === undefined
            ? `[y] select approve · [n] select deny · Esc decide later (${label('approvals:open')})`
            : `${modal.decision ? 'Approve' : 'Deny'} selected · Enter confirm · Esc decide later`}
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'help') {
    const rows = helpRows(keymap, modal.context);
    const room = Math.max(3, height - 4);
    const start = first(modal.scroll, rows.length, room);
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
    const entries = paletteEntries(keymap, modal.context, modal.query, modal.active);
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
        {modal.candidates?.length ? (
          <Text dimColor wrap="wrap">
            {modal.candidates
              .slice(0, Math.max(1, (height - 12) * 4))
              .map(sanitizeLine)
              .join('   ')}
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text dimColor>
          {`Enter confirm · ${modal.paths ? 'Tab complete the path · ' : ''}^U clear · Esc cancel · this screen is drawn by Anchi, not by an agent`}
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
        {/* Bodies quote names and text from outside (a skill's files): never raw. */}
        <Text>{sanitize(modal.body)}</Text>
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
    const { editing } = modal;
    const items = rows.filter((r) => r.kind !== 'header');
    const at = rows.indexOf(items[modal.cursor]!);
    const room = Math.max(3, height - 5);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), rows.length - room));
    return frame(
      <Box flexDirection="column" height={room}>
        {rows.slice(first, first + room).map((r, i) =>
          r.kind === 'header' ? (
            // Prompt lines and other values come from the agent file (or the builder).
            <Text key={i} dimColor bold={!r.text.startsWith(' ')} wrap="truncate">
              {truncate(sanitizeLine(r.text), inner)}
            </Text>
          ) : (
            <Text key={i} inverse={first + i === at} wrap="truncate">
              {`${r.mark.padEnd(5)}${truncate(sanitizeLine(r.label), 30).padEnd(31)}`}
              <Text dimColor={first + i !== at && !(editing && r.id === editing.field)}>
                {editing && r.kind === 'field' && r.id === editing.field
                  ? `${sanitizeLine(editing.input).slice(-Math.max(10, inner - 39))}█`
                  : truncate(sanitizeLine(r.note), Math.max(10, inner - 38))}
              </Text>
            </Text>
          ),
        )}
      </Box>,
      editing
        ? `${editing.error ? `✗ ${editing.error}` : `Type the ${editing.field}${editing.field === 'model' ? ' (empty: the runtime default)' : ''}`} · Enter keep · Esc undo`
        : `↑↓ choose · Space change · Enter ${modal.proposalId ? 'update the proposal' : 'review the change'}${modal.proposalId ? '' : ' · D delete the agent'} · Esc cancel`,
    );
  }
  if (modal.kind === 'deleteAgent') {
    const p = modal.preview;
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const lines: { text: string; color?: string }[] = p
      ? [
          { text: 'Deleted, and not recoverable:' },
          {
            text: `  ${p.exists ? `the agent file ~/.anchi/agents/${p.agentId}.yaml` : 'the agent file is already gone'}`,
          },
          {
            text: `  ${plural(p.tasks, 'task')} and their transcripts${p.delegated ? `, with ${plural(p.delegated, 'task')} other agents did for them` : ''}`,
          },
          ...(p.running
            ? [{ text: `  ${p.running} running or queued: cancelled first`, color: 'yellow' }]
            : []),
          ...(p.triggers
            ? [{ text: `  ${plural(p.triggers, 'trigger')} and what they have seen` }]
            : []),
          {
            text: '  in the VM: its home (work directory, Codex and Claude sessions), its skills and its policy rules',
          },
          ...(p.delegatedBy.length || p.delegatedByTemplates.length
            ? [
                {
                  text: `Changed: removed from the delegates of ${[...p.delegatedBy.map((a) => `@${a}`), ...p.delegatedByTemplates.map((t) => `template ${t}`)].join(', ')}`,
                },
              ]
            : []),
          { text: '' },
          {
            text: `Kept: ${p.workspaces.length ? p.workspaces.map((w) => `~/AnchiWorkspaces/${w}`).join(', ') : 'directories of your computer'} (workspaces are never touched), and the audit logs.`,
            color: 'green',
          },
        ]
      : [{ text: 'Loading…' }];
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
          Delete @{modal.agentId}?
        </Text>
        {lines.map((l, i) => (
          <Text key={i} color={l.color} wrap="truncate">
            {truncate(sanitizeLine(l.text), inner) || ' '}
          </Text>
        ))}
        <Text> </Text>
        <Text>{`Type ${modal.agentId} to confirm:`}</Text>
        <Box borderStyle="single" paddingX={1}>
          <Text>
            {sanitizeLine(modal.input)}
            <Text inverse> </Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        <Text bold>
          {modal.input === modal.agentId && p ? 'Enter delete · Esc cancel' : 'Esc cancel'}
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'access') {
    const lines: ReportLine[] = modal.error
      ? [{ text: sanitizeLine(modal.error), color: 'red' }]
      : modal.data
        ? accessLines(modal.data, inner)
        : [{ text: 'Reading the audit log in the VM…', dim: true }];
    const room = Math.max(3, height - 4);
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
          External access of {modal.taskId}
        </Text>
        {modal.pick !== undefined && modal.data ? (
          <Box flexDirection="column" height={room}>
            <Text>
              Allow a host this task was refused (it comes from the agent&apos;s requests):
            </Text>
            {refusedHosts(modal.data)
              .slice(0, room - 1)
              .map((h, i) => (
                <Text key={h} color={i === modal.pick ? 'cyan' : undefined} wrap="truncate">
                  {i === modal.pick ? '› ' : '  '}
                  {sanitizeLine(h)}
                </Text>
              ))}
          </Box>
        ) : (
          <Report lines={lines} height={room} scroll={first(modal.scroll, lines.length, room)} />
        )}
        <Text dimColor wrap="truncate">
          {modal.pick !== undefined
            ? '↑↓ choose · Enter review · Esc back'
            : `↑↓ PgUp PgDn scroll${modal.data && refusedHosts(modal.data).length ? ' · e allow a refused host' : ''} · Esc close · from the egress proxy's audit log; hosts and paths come from the agent`}
        </Text>
      </Box>
    );
  }
  if (modal.kind === 'retry') {
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
          Run {modal.taskId} (@{modal.agentId}) again?
        </Text>
        <Text>{`It ${modal.status === 'failed' ? 'failed' : 'was cancelled'}.`}</Text>
        <Text> </Text>
        <Text>
          [c] continue in the same session: the agent is told why it stopped and keeps the work it
          had done
        </Text>
        <Text>[n] start over: a new task with the same request, in a new session</Text>
        <Box flexGrow={1} />
        <Text bold>[c] continue · [n] new task · Esc cancel</Text>
      </Box>
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
  add(
    p.kind === 'update'
      ? `Changes to @${p.agentId} (only the + and - lines change; comments and other fields stay)`
      : p.kind === 'replace'
        ? `@${p.agentId}: replaces its whole file`
        : `New agent @${p.agentId}`,
  );
  for (const l of (p.agentDiff || '(unchanged)').split('\n'))
    add(l, l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined);
  if (p.imageYaml) {
    add('');
    add('Image recipe (built in a proxy-only build cell; commands run as root in the image)');
    for (const l of (p.imageDiff || '(unchanged)').split('\n'))
      add(l, l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined);
  }
  const room = height - 6 - (p.errors.length ? p.errors.length + 1 : 0) - (p.warnings?.length ?? 0);
  const start = first(modal.scroll, body.length, room);
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
        Agent proposal — review before anything is written
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
