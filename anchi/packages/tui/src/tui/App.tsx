/** @jsxRuntime automatic */
import type {
  AgentSummary,
  BuilderProposal,
  ConnectorId,
  ConnectorSecret,
  SetupStatus,
  StoredEvent,
  TaskRow,
  TaskStatus,
} from '@anchi/protocol';
import type { DaemonClient } from '@anchi/daemon';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitize, sanitizeLine } from '../sanitize.ts';
import { type Line, type Tone, transcriptLines, truncate } from './lines.ts';
import type { MouseEvent } from './mouse.ts';

export const SIDEBAR_WIDTH = 28;
const BUILDER = 'builder';
const MENU = ['runtimes', 'skills', 'connectors', BUILDER, 'tasks'] as const;
type MenuItem = (typeof MENU)[number];
const MENU_LABEL: Record<MenuItem, string> = {
  runtimes: 'Runtimes',
  skills: 'Skills',
  connectors: 'Connectors',
  builder: 'Agent builder',
  tasks: 'Tasks',
};
/** Terminal row (1-based) of the first sidebar entry. */
export const SIDEBAR_FIRST_ROW = 3;

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
const SECRET_FIELDS: Record<ConnectorId, SecretField[]> = {
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
      connector: ConnectorId;
      index: number;
      values: Record<string, string>;
      input: string;
    }
  | { kind: 'confirm'; title: string; body: string; action: () => Promise<unknown> }
  | {
      kind: 'text';
      title: string;
      label: string;
      input: string;
      submit: (value: string) => Promise<unknown>;
    };

export interface AppProps {
  client: DaemonClient;
  initialAgents: AgentSummary[];
  initialTasks: TaskRow[];
  onMouse?(handler: (e: MouseEvent) => void): void;
  /** Opens $EDITOR on a draft and returns the edited text (CJK input fallback). */
  compose?(draft: string): string;
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
  const [cursor, setCursor] = useState<number>(MENU.length);
  const [focusTask, setFocusTask] = useState<Record<string, string | null>>({});
  const [logs, setLogs] = useState<Record<string, StoredEvent[]>>({});
  const [input, setInput] = useState('');
  const [scroll, setScroll] = useState(0);
  const [taskCursor, setTaskCursor] = useState(0);
  const [connectorCursor, setConnectorCursor] = useState(0);
  const [verbose, setVerbose] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [proposals, setProposals] = useState<BuilderProposal[]>([]);
  const [flash, setFlash] = useState('');
  const loading = useRef(new Set<string>());

  const userAgents = agents.filter((a) => a.id !== BUILDER);
  const items: string[] = [...MENU, ...userAgents.map((a) => a.id)];
  const current = items[Math.min(cursor, items.length - 1)] ?? 'tasks';
  const isMenu = (MENU as readonly string[]).includes(current) && current !== BUILDER;
  const agent = isMenu ? undefined : agents.find((a) => a.id === current);
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
    setScroll(0);
  }, [current, refreshSetup]);

  // The task shown for an agent: the one chosen, else its latest; null means "new task".
  const agentTasks = agent ? tasks.filter((t) => t.agentId === agent.id) : [];
  const chosen = agent ? focusTask[agent.id] : undefined;
  const task =
    chosen === null ? undefined : (agentTasks.find((t) => t.id === chosen) ?? agentTasks[0]);

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
  const transcriptHeight = Math.max(3, bodyHeight - 8);
  const lines = useMemo<Line[]>(
    () => transcriptLines(task ? (logs[task.id] ?? []) : [], textWidth, verbose),
    [logs, task?.id, textWidth, verbose],
  );
  const maxScroll = Math.max(0, lines.length - transcriptHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(
    Math.max(0, lines.length - transcriptHeight - offset),
    lines.length - offset,
  );

  // ── actions ─────────────────────────────────────────────
  const move = (d: number) => setCursor((c) => (c + d + items.length) % items.length);

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

  const runAction = (action: () => Promise<unknown>, done: string) => {
    void action()
      .then(() => {
        say(done);
        refreshSetup();
      })
      .catch((e: Error) => say(e.message));
  };

  usePaste((text) => {
    if (modal?.kind === 'secret' || modal?.kind === 'text')
      setModal({ ...modal, input: modal.input + text.trim() });
    else if (!modal && agent) setInput((v) => v + text);
  });

  useInput((ch, key) => {
    // ── modals take every key ──
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
      if (key.backspace || key.delete)
        return setModal({ ...modal, input: [...modal.input].slice(0, -1).join('') });
      if (key.return) {
        if (!modal.input && !field.optional) return;
        const values = { ...modal.values, ...(modal.input ? { [field.key]: modal.input } : {}) };
        if (modal.index + 1 < SECRET_FIELDS[modal.connector].length) {
          return setModal({ ...modal, index: modal.index + 1, values, input: '' });
        }
        setModal(null);
        const secret = { id: modal.connector, ...values } as ConnectorSecret;
        return runAction(
          () => client.call('connectors.set', secret),
          `${modal.connector} connected`,
        );
      }
      if (ch && !key.ctrl && !key.meta)
        setModal({ ...modal, input: modal.input + ch.replace(/[\r\n]/g, '') });
      return;
    }
    if (modal?.kind === 'text') {
      if (key.escape) return setModal(null);
      if (key.backspace || key.delete)
        return setModal({ ...modal, input: [...modal.input].slice(0, -1).join('') });
      if (key.return) {
        if (!modal.input) return;
        const { submit, input, title } = modal;
        setModal(null);
        return runAction(() => submit(input), `${title}: done`);
      }
      if (ch && !key.ctrl && !key.meta)
        setModal({ ...modal, input: modal.input + ch.replace(/[\r\n]/g, '') });
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

    // ── menu views ──
    if (isMenu) {
      if (ch === 'q') return exit();
      if (key.tab) return move(key.shift ? -1 : 1);
      if (current === 'tasks') {
        if (key.upArrow || ch === 'k') return setTaskCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || ch === 'j')
          return setTaskCursor((c) => Math.min(tasks.length - 1, c + 1));
        const t = tasks[taskCursor];
        if (key.return && t) {
          setFocusTask((f) => ({ ...f, [t.agentId]: t.id }));
          const i = items.indexOf(t.agentId);
          if (i >= 0) setCursor(i);
          return;
        }
        if (ch === 'c' && t && (t.status === 'running' || t.status === 'queued')) {
          return void client
            .call('tasks.cancel', { taskId: t.id })
            .catch((e: Error) => say(e.message));
        }
      }
      if (current === 'connectors') {
        const ids: ConnectorId[] = ['github', 'aws', 'linear'];
        if (key.upArrow || ch === 'k') return setConnectorCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || ch === 'j')
          return setConnectorCursor((c) => Math.min(ids.length - 1, c + 1));
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
    if (key.tab) return move(key.shift ? -1 : 1);
    if (key.ctrl && ch === 'x') {
      setFocusTask((f) => ({ ...f, [current]: null }));
      return say('the next message starts a new task');
    }
    if (key.ctrl && ch === 'e') return editDraft();
    if (key.ctrl && ch === 'u') return setInput('');
    if (key.ctrl && ch === 'v') return setVerbose((v) => !v);
    if (key.pageUp)
      return setScroll((s) => Math.min(maxScroll, s + Math.floor(transcriptHeight / 2)));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - Math.floor(transcriptHeight / 2)));
    if (key.upArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
    if (key.downArrow) return setScroll((s) => Math.max(0, s - 1));
    if (key.escape) {
      if (task && (task.status === 'running' || task.status === 'queued')) {
        void client.call('tasks.cancel', { taskId: task.id });
        return say(`cancelling ${task.id}`);
      }
      return setInput('');
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
      if (e.kind === 'wheelUp') return setScroll((s) => s + 3);
      if (e.kind === 'wheelDown') return setScroll((s) => Math.max(0, s - 3));
      if (
        e.kind === 'press' &&
        e.button === 0 &&
        e.x <= SIDEBAR_WIDTH &&
        e.y >= SIDEBAR_FIRST_ROW
      ) {
        const row = e.y - SIDEBAR_FIRST_ROW;
        // Menu rows, a header row, then agents.
        const i = row < MENU.length ? row : row - 1;
        if (i >= 0 && i < items.length && row !== MENU.length) setCursor(i);
      }
    });
  }, [onMouse, items.length]);

  // ── render ──────────────────────────────────────────────
  if (modal) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <ModalView modal={modal} width={columns} height={rows} />
      </Box>
    );
  }

  const header = agent
    ? `@${agent.id} · ${sanitizeLine(agent.name)}  ${agent.runtime ?? ''} · ${agent.connectors.join(', ') || 'no connectors'}${
        task ? ` · ${task.id} (${task.status})` : ' · new task'
      }`
    : MENU_LABEL[current as MenuItem];
  const status =
    flash ||
    (agent
      ? '^N/^P select · Enter send · ^X new task · Esc cancel · ^E editor · ^V verbose · PgUp/PgDn scroll'
      : current === 'connectors'
        ? '↑↓ choose · Enter connect · g github from gh · p aws profile · d disconnect · q quit'
        : current === 'runtimes'
          ? 's start VM · I install · u unlock vault · i import Codex login · r refresh · q quit'
          : current === 'tasks'
            ? '↑↓ choose · Enter open · c cancel · ^N/^P select · q quit'
            : '^N/^P select · q quit') + (proposals.length ? ' · ^O proposal' : '');

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={bodyHeight}>
        <Sidebar
          agents={userAgents}
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
          borderColor="gray"
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
          ) : current === 'tasks' ? (
            <TasksView
              tasks={tasks}
              cursor={taskCursor}
              height={bodyHeight - 4}
              width={textWidth}
            />
          ) : current === 'connectors' ? (
            <ConnectorsView setup={setup} cursor={connectorCursor} />
          ) : current === 'runtimes' ? (
            <RuntimesView setup={setup} log={setupLog} />
          ) : (
            <Box flexDirection="column">
              <Text>Skills are planned for a later phase.</Text>
              <Text dimColor>Agents get their instructions from their prompt for now.</Text>
            </Box>
          )}
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        {status}
      </Text>
    </Box>
  );
}

function Sidebar(props: {
  agents: AgentSummary[];
  tasks: TaskRow[];
  current: string;
  height: number;
  frame: number;
}) {
  const { agents, tasks, current, height, frame } = props;
  const inner = SIDEBAR_WIDTH - 4;
  const running = (id: string) => tasks.some((t) => t.agentId === id && t.status === 'running');
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={height}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>安栖 Anchi</Text>
      {MENU.map((m) => (
        <Text key={m} inverse={current === m} bold={current === m}>
          {truncate(
            `${m === BUILDER && running(BUILDER) ? SPINNER[frame % SPINNER.length] : '·'} ${MENU_LABEL[m]}`,
            inner,
          ).padEnd(inner)}
        </Text>
      ))}
      <Text dimColor>AGENTS</Text>
      {agents.map((a) => {
        const glyph = a.error
          ? '✗'
          : running(a.id)
            ? SPINNER[frame % SPINNER.length]!
            : a.queued
              ? '◇'
              : '○';
        const color = a.error ? 'red' : running(a.id) ? 'yellow' : 'gray';
        return (
          <Text key={a.id} inverse={current === a.id} bold={current === a.id}>
            <Text color={color}>{glyph}</Text> {truncate(a.id, inner - 2).padEnd(inner - 2)}
          </Text>
        );
      })}
      {agents.length === 0 ? <Text dimColor>none yet — use the builder</Text> : null}
    </Box>
  );
}

function TasksView({
  tasks,
  cursor,
  height,
  width,
}: {
  tasks: TaskRow[];
  cursor: number;
  height: number;
  width: number;
}) {
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), tasks.length - height));
  if (!tasks.length) return <Text dimColor>No tasks yet.</Text>;
  return (
    <Box flexDirection="column" height={height}>
      {tasks.slice(start, start + height).map((t, i) => {
        const link = t.links[0] ? `  ${t.links[0]}` : '';
        return (
          <Text key={t.id} inverse={start + i === cursor} wrap="truncate">
            <Text color={TASK_COLOR[t.status]}>{t.status.padEnd(10)}</Text>
            {`@${t.agentId}`.padEnd(14)}
            {relTime(t.finishedAt ?? t.startedAt ?? t.createdAt).padEnd(9)}
            {truncate(sanitizeLine(t.title), Math.max(10, width - 36 - link.length))}
            <Text color="blue">{sanitizeLine(link)}</Text>
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
      <Text dimColor>
        Secrets go from this screen to the VM vault. They are never stored on this Mac or shown
        again.
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
      <Text dimColor>Claude Code arrives in phase 2.</Text>
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
