import { peerNetworkConfigSchema, peerRecordSchema, peerNodeSchema } from '@anchi/protocol';
import { autoPublishWarning } from '@anchi/core/publish';
import { agentLayerSchema, idSchema, parseYamlAs, sanitizeLine } from '@anchi/core';
import type {
  AgentPatch,
  AgentDeletionPreview,
  AgentSettings,
  AgentSummary,
  BuilderProposal,
  MethodName,
  Notifications,
  RuntimeId,
  ServiceConnectorId,
  SetupStatus,
} from '@anchi/protocol';

/**
 * The daemon methods the window may call. The renderer draws agent text, so it is treated as
 * the most exposed part of the app: destructive actions require a native confirmation here.
 */
export const DESKTOP_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'daemon.status',
  'peers.configure',
  'peers.identity',
  'peers.directory',
  'peers.admit',
  'peers.remove',
  'agents.list',
  'agents.settings',
  'agents.createPreview',
  'team.nodes',
  'team.preview',
  'agents.update',
  'agents.deletePreview',
  'agents.delete',
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
  if (params === undefined || params === null) params = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
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
  'peers.configure': (p) => {
    peerNetworkConfigSchema.parse(p);
  },
  'peers.admit': (p) => {
    peerRecordSchema.parse((p as { record?: unknown }).record);
  },
  'peers.remove': (p) => {
    peerNodeSchema.parse((p as { node?: unknown }).node);
  },
  'agents.deletePreview': (p) => deletionParams(p, false),
  'agents.delete': (p) => deletionParams(p, true),
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

function deletionParams(params: object, apply: boolean): void {
  const p = params as { agentId?: unknown; confirm?: unknown };
  const id = idSchema.safeParse(p.agentId);
  if (!id.success || id.data === 'builder') throw new Error('choose an agent that can be deleted');
  const keys = apply ? ['agentId', 'confirm'] : ['agentId'];
  if (Object.keys(params).some((key) => !keys.includes(key)))
    throw new Error('invalid deletion parameters');
  if (apply && p.confirm !== id.data)
    throw new Error('type the exact agent id to confirm deletion');
}

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

export type Read = (method: MethodName, params: object) => Promise<unknown>;

/** What an agent-file patch adds to the agent's reach: connectors, directories, write access. */
export function widening(current: AgentSettings['current'], patch: AgentPatch): string[] {
  const out: string[] = [];
  for (const id of patch.connectors ?? []) {
    if (!current.connectors.includes(id)) out.push(`connector ${id}`);
  }
  for (const id of patch.delegates ?? []) {
    if (!current.delegates?.includes(id)) out.push(`delegate tasks to @${id}`);
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
  if (call.method === 'peers.configure') {
    const p = peerNetworkConfigSchema.parse(call.params);
    return {
      message: 'Enable peer networking on this machine?',
      detail: `Listen on ${p.listen}:${p.port} and advertise ${p.address}. Only enrolled machines with pinned identities can connect. Use an address reachable by every team machine.`,
      button: 'Configure networking',
    };
  }
  if (call.method === 'peers.admit') {
    const p = peerRecordSchema.parse((call.params as { record: unknown }).record);
    return {
      message: `Trust ${sanitizeLine(p.label)} as a team machine?`,
      detail: `Node ${p.node} at ${p.address}. This grants its daemon authority to assign work, relay approvals for its tasks, and introduce or revoke team machines. Only enroll machines you own and trust. Agent delegation still needs an explicit grant.`,
      button: 'Join team',
    };
  }
  if (call.method === 'peers.remove')
    return {
      message: 'Revoke this machine from the team?',
      detail: `Node ${(call.params as { node: string }).node}. Revocation spreads to reachable members; disconnected members learn it when they reconnect. Running work on the removed machine is not cancelled. This identity cannot rejoin.`,
      button: 'Revoke machine',
    };
  if (call.method === 'builder.apply') {
    const proposal = (await read('builder.proposal', call.params)) as BuilderProposal;
    const { execution, delegates = [] } = parseYamlAs(proposal.agentYaml, agentLayerSchema);
    let delegation = '';
    if (delegates.length) {
      const before =
        proposal.kind === 'create'
          ? []
          : ((await read('agents.settings', { agentId: proposal.agentId })) as AgentSettings).fixed
              .delegates;
      const added = delegates.filter((id) => !before.includes(id));
      if (added.length)
        delegation = `Allow @${proposal.agentId} to delegate tasks to ${added.map((id) => `@${id}`).join(', ')}. Recipients keep their own access and approval rules.`;
    }
    if (!execution)
      return delegation
        ? {
            message: `Grant delegation to @${proposal.agentId}?`,
            detail: delegation,
            button: 'Grant delegation',
          }
        : undefined;
    return {
      message: `Run @${proposal.agentId} on ${execution.server}?`,
      detail: `This member uses @${execution.agent} on ${execution.server}, including that profile's runtime, connectors, workspaces and security policy. Its credentials stay on that node. Tasks and approval content are returned to this team.${delegation ? `\n\n${delegation}` : ''}`,
      button: 'Use execution node',
    };
  }
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
  if (call.method === 'agents.delete') {
    const p = call.params as { agentId: string; confirm: string };
    const preview = (await read('agents.deletePreview', {
      agentId: p.agentId,
    })) as AgentDeletionPreview;
    if (preview.agentId !== p.agentId) throw new Error('agent changed; review deletion again');
    const references = [
      ...preview.delegatedBy.map((id) => `@${id}`),
      ...preview.delegatedByTemplates.map((id) => `template ${id}`),
    ];
    if (
      !(await confirm({
        message: `Delete @${p.agentId}?`,
        detail: `Permanently delete its agent file, ${preview.tasks} tasks and ${preview.delegated} delegated tasks with their transcripts, ${preview.triggers} triggers, and its VM home, sessions, skills and policy rules.\n\n${preview.running} running or queued tasks will be cancelled.${references.length ? `\nRemove its delegation grants from: ${references.map(sanitizeLine).join(', ')}.` : ''}\n\nWorkspaces and audit logs are kept. This cannot be undone.`,
        button: 'Delete agent',
      }))
    )
      throw new Error('cancelled');
    const latest = await read('agents.deletePreview', { agentId: p.agentId });
    if (JSON.stringify(latest) !== JSON.stringify(preview))
      throw new Error('Agent or tasks changed during confirmation; review deletion again.');
    return read(call.method, call.params);
  }
  const question = await confirmation(call, read);
  if (question && !(await confirm(question))) throw new Error('cancelled');
  return read(call.method, call.params);
}
