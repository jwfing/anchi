import type { MethodName, Notifications } from '@anchi/protocol';

/**
 * The daemon methods the window may call. The renderer draws agent text, so it is treated as
 * the most exposed part of the app: what deletes, resets or stops things stays in the CLI.
 */
export const DESKTOP_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'daemon.status',
  'agents.list',
  'agents.settings',
  'agents.createPreview',
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
  'connectors.set',
  'connectors.remove',
  'builder.proposal',
  'builder.apply',
  'builder.discard',
  'approvals.list',
  'approvals.decide',
  'triggers.list',
  'skills.list',
  'usage.summary',
  'usage.quota',
  'services.setMode',
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
  return { method: method as MethodName, params };
}

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
