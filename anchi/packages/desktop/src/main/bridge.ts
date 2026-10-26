import { autoPublishWarning } from '@anchi/core/publish';
import type {
  AgentPatch,
  AgentSettings,
  AgentSummary,
  MethodName,
  Notifications,
  RuntimeId,
  ServiceConnectorId,
  SetupStatus,
} from '@anchi/protocol';

/**
 * The daemon methods the window may call. The renderer draws agent text, so it is treated as
 * the most exposed part of the app: what deletes, resets or stops things stays in the CLI.
 */
export const DESKTOP_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'daemon.status',
  'agents.list',
  'agents.settings',
  'agents.createPreview',
  'agents.update',
  'tasks.create',
  'tasks.list',
  'tasks.search',
  'tasks.tree',
  'tasks.get',
  'tasks.send',
  'tasks.retry',
  'tasks.cancel',
  'tasks.audit',
  'tasks.events',
  'setup.status',
  'setup.importCodex',
  'setup.importClaude',
  'setup.importHermes',
  'setup.prepare',
  'connectors.set',
  'connectors.remove',
  'builder.proposal',
  'builder.apply',
  'builder.discard',
  'approvals.list',
  'approvals.decide',
  'triggers.list',
  'skills.list',
  'skills.add',
  'skills.checkUpdate',
  'skills.update',
  'skills.remove',
  'usage.summary',
  'usage.quota',
  'services.setMode',
  'services.setToken',
  'services.disconnect',
  'services.xClient',
  'services.redditClient',
  'services.googleLogin',
  'services.xLogin',
  'services.redditLogin',
]);

export const NOTIFICATIONS: readonly (keyof Notifications)[] = [
  'event',
  'tasks',
  'agents',
  'proposal',
  'oauth',
  'tasksDeleted',
  'approvals',
  'setup',
];

/** Checks a call from the window: an allowed method with a plain-object parameter. */
export function checkCall(
  method: unknown,
  params: unknown,
): { method: MethodName; params: object } {
  if (typeof method !== 'string' || !DESKTOP_METHODS.has(method as MethodName)) {
    throw new Error(`the desktop app does not call ${String(method).slice(0, 60)}`);
  }
  if (params === undefined || params === null) return { method: method as MethodName, params: {} };
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${method}: parameters must be an object`);
  }
  PARAMS[method as MethodName]?.(params);
  return { method: method as MethodName, params };
}

/** A GitHub address, the only skill source the window may name; folders come from a picker. */
export function githubSource(source: unknown): boolean {
  if (typeof source !== 'string' || source.length > 500) return false;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username;
  } catch {
    return false;
  }
}

/** Parameters the window may not choose, by method. */
const PARAMS: Partial<Record<MethodName, (params: object) => void>> = {
  'skills.add': (p) => {
    if (!githubSource((p as { source?: unknown }).source)) {
      throw new Error('skills.add: the window adds skills from https://github.com/ addresses');
    }
  },
  'services.disconnect': (p) => {
    const { id, account } = p as { id?: unknown; account?: unknown };
    if (typeof id !== 'string' || !Object.hasOwn(SERVICES, id)) {
      throw new Error('services.disconnect: unknown service');
    }
    if (account !== undefined && (typeof account !== 'string' || !ACCOUNT.test(account))) {
      throw new Error('services.disconnect: invalid account name');
    }
  },
};

const ACCOUNT = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Each service's name and what disconnecting does at the provider, for the dialog. */
const SERVICES: Record<ServiceConnectorId, { name: string; remote: string }> = {
  gmail: { name: 'Gmail', remote: 'revokes it at Google' },
  drive: { name: 'Google Drive', remote: 'revokes it at Google' },
  notion: {
    name: 'Notion',
    remote: 'cannot revoke it at Notion: remove the connection in Notion yourself',
  },
  slack: { name: 'Slack', remote: 'revokes it at Slack' },
  x: { name: 'X', remote: 'revokes it at X' },
  reddit: { name: 'Reddit', remote: 'revokes it at Reddit' },
};

/** Links from agent text open in the browser only as plain web pages. */
export function externalUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 2048) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** A question the main process asks in a native dialog, where the renderer cannot answer it. */
export interface Confirmation {
  message: string;
  detail: string;
  button: string;
}

type Read = (method: MethodName, params: object) => Promise<unknown>;

/** What an agent-file patch adds to the agent's reach: connectors, directories, write access. */
export function widening(current: AgentSettings['current'], patch: AgentPatch): string[] {
  const out: string[] = [];
  for (const id of patch.connectors ?? []) {
    if (!current.connectors.includes(id)) out.push(`connector ${id}`);
  }
  for (const w of patch.workspaces ?? []) {
    const before = current.workspaces.find((c) => c.path === w.path);
    if (!before) out.push(`workspace ${w.path} (${w.mode === 'rw' ? 'read-write' : 'read-only'})`);
    else if (w.mode === 'rw' && before.mode !== 'rw') out.push(`write access to ${w.path}`);
  }
  for (const id of patch.highRisk?.disable ?? []) {
    if (!current.highRisk?.disable.includes(id)) out.push(`${id} without asking you`);
  }
  return out;
}

/**
 * The confirmation a call needs before it reaches the daemon, if any. The renderer draws agent
 * text and could be made to send any allowed call, so a call that widens what agents reach is
 * confirmed here.
 */
export async function confirmation(
  call: { method: MethodName; params: object },
  read: Read,
): Promise<Confirmation | undefined> {
  if (call.method === 'agents.update') {
    const p = call.params as { agentId?: unknown; patch?: AgentPatch; apply?: unknown };
    if (p.apply !== true || typeof p.agentId !== 'string' || !p.patch) return undefined;
    const settings = (await read('agents.settings', { agentId: p.agentId })) as AgentSettings;
    const added = widening(settings.current, p.patch);
    if (!added.length) return undefined;
    return {
      message: `Give @${p.agentId} more access?`,
      detail: `Its tasks will be able to use:\n\n${added.map((a) => `• ${a}`).join('\n')}`,
      button: 'Give access',
    };
  }
  if (call.method === 'services.setMode') {
    const p = call.params as { id?: unknown; mode?: unknown };
    if (p.mode !== 'auto' || (p.id !== 'x' && p.id !== 'reddit')) return undefined;
    return {
      message: `Let agents post to ${p.id === 'x' ? 'X' : 'Reddit'} without asking?`,
      detail: autoPublishWarning(p.id),
      button: 'Post without asking',
    };
  }
  if (call.method === 'services.disconnect') {
    // Checked by PARAMS before this runs.
    const p = call.params as { id: ServiceConnectorId; account?: string };
    const { name, remote } = SERVICES[p.id];
    const which = p.account ? ` account ${p.account}` : '';
    return {
      message: `Disconnect ${name}${which}?`,
      detail: `Anchi removes the ${name}${which} credential from the vault on the server and ${remote}. Agents that use ${name} lose access until you connect it again.`,
      button: 'Disconnect',
    };
  }
  if (call.method === 'setup.prepare') {
    const runtime = String((call.params as { runtime?: unknown }).runtime ?? '');
    const s = (await read('setup.status', {}).catch(() => undefined)) as SetupStatus | undefined;
    if (
      s?.vm === 'running' &&
      s.installed &&
      !s.guestOutdated &&
      !s.vaultUnlocked &&
      s.vaultKeyPresent !== false &&
      s.preparedRuntimes?.includes(runtime as RuntimeId)
    ) {
      return {
        message: 'Unlock the vault?',
        detail:
          'Anchi unlocks the vault on the server with its vault key (~/.config/anchi/vault.key there). The credentials you stored become usable by its services again. Nothing is installed.',
        button: 'Unlock',
      };
    }
    return {
      message: 'Prepare the Anchi environment?',
      detail:
        `This starts or installs the Anchi VM on the server, its services and the ${runtime} runtime image, then unlocks the vault. The first install takes several minutes.\n\n` +
        'The vault key (~/.config/anchi/vault.key on the server) is the only way to read the credentials you store. Back it up once it exists.',
      button: 'Prepare',
    };
  }
  if (call.method === 'skills.remove') {
    const id = String((call.params as { id?: unknown }).id ?? '');
    const agents = (await read('agents.list', {})) as AgentSummary[];
    const users = agents.filter((a) => a.skills?.includes(id)).map((a) => '@' + a.id);
    return {
      message: `Remove the skill ${id}?`,
      detail:
        (users.length
          ? `${users.join(', ')} ${users.length === 1 ? 'lists' : 'list'} it and will not start until it is taken out of ${users.length === 1 ? 'its' : 'their'} settings or added again.`
          : 'No agent lists it.') + ' Its files are deleted from the server.',
      button: 'Remove',
    };
  }
  return undefined;
}

/** Checks a call from the window, asks what needs asking, then sends it. */
export async function guardedCall(
  method: unknown,
  params: unknown,
  read: Read,
  confirm: (question: Confirmation) => Promise<boolean>,
): Promise<unknown> {
  const call = checkCall(method, params);
  const question = await confirmation(call, read);
  if (question && !(await confirm(question))) throw new Error('cancelled');
  return read(call.method, call.params);
}
