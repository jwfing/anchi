import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'use 1–40 lowercase letters, digits or "-"');

export const runtimeSchema = z.enum(['codex', 'claude-code']);
export type Runtime = z.infer<typeof runtimeSchema>;

/** Connectors whose credentials the egress proxy injects into the agent's requests. */
export const PROXY_CONNECTORS = ['github', 'aws', 'linear'] as const;
/** Connectors served by trusted VM services, reached through per-cell sockets. */
export const SERVICE_CONNECTORS = ['gmail', 'drive', 'notion', 'slack'] as const;
export const connectorSchema = z.enum([...PROXY_CONNECTORS, ...SERVICE_CONNECTORS]);
export type Connector = z.infer<typeof connectorSchema>;

export const approvalModeSchema = z.enum(['auto', 'ask']);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/** Five-field cron expression (minute hour day-of-month month day-of-week). */
const cronSchema = z
  .string()
  .regex(/^(\S+\s+){4}\S+$/, 'use a five-field cron expression such as "0 9 * * 1-5"');

const pollSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('linear-issues'),
    team: z.string().max(40).optional(),
    label: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
  }),
  z.strictObject({
    type: z.literal('github-issues'),
    /** A GitHub search query, such as `repo:o/r is:issue is:open label:agent`. */
    query: z.string().min(1).max(300),
  }),
]);

/** Starts tasks without the user: on a schedule, or for each new item a poll finds. */
export const triggerSchema = z.union([
  z.strictObject({ schedule: cronSchema, text: z.string().min(1).max(20_000) }),
  z.strictObject({
    poll: pollSchema,
    /** Task text; `{title}`, `{url}` and `{id}` are replaced with the new item's values. */
    text: z.string().min(1).max(20_000),
    every: z.number().int().min(1).max(1440).default(5).optional(),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** A path segment under ~/AnchiWorkspaces: no separators, no `.` or `..`, no control characters. */
const segment = z
  .string()
  .regex(/^[A-Za-z0-9._ -]{1,100}$/)
  .refine((s) => s !== '.' && s !== '..' && s.trim() === s, 'invalid path segment');

/** A directory of the Mac (under ~/AnchiWorkspaces) bound into the agent's cells. */
export const workspaceSchema = z.strictObject({
  /** Relative to ~/AnchiWorkspaces, such as `projects/webapp`. */
  path: z
    .string()
    .max(500)
    .refine((p) => p.split('/').every((s) => segment.safeParse(s).success), {
      message: 'use a path relative to ~/AnchiWorkspaces, without "..", leading "/" or empty parts',
    }),
  /** `ro` (default) or `rw`: writes go straight to the Mac. */
  mode: z.enum(['ro', 'rw']).default('ro'),
  /** Name under /home/agent/workspaces; the last path segment by default. */
  name: idSchema.optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const WORKSPACE_ROOT = '~/AnchiWorkspaces';
export const workspaceName = (w: { path: string; name?: string }) =>
  w.name ??
  (w.path
    .split('/')
    .at(-1)!
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40) ||
    'workspace');

/** `cell`: the cell is the only boundary. `codex-workspace-write` adds Codex's own sandbox. */
export const sandboxSchema = z.enum(['cell', 'codex-workspace-write']);
export type Sandbox = z.infer<typeof sandboxSchema>;

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);

/** Built-in image every recipe starts from: Debian base, Node, Codex, Claude Code and the runner. */
export const BASE_IMAGE = 'codex';

/**
 * An agent or template file before `extends` is applied. Every field is optional here;
 * the merged result is validated against `resolvedAgentSchema`.
 */
export const agentLayerSchema = z.strictObject({
  id: idSchema.optional(),
  name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  extends: idSchema.optional(),
  runtime: runtimeSchema.optional(),
  model: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,80}$/)
    .optional(),
  effort: effortSchema.optional(),
  prompt: z
    .strictObject({
      mode: z.enum(['replace', 'append']).optional(),
      text: z.string().max(100_000).optional(),
      file: z.string().optional(),
    })
    .optional(),
  /** Upstream services the proxy injects credentials for. Nothing else is injected. */
  connectors: z.array(connectorSchema).optional(),
  /** Image recipe id in `images/`, or the built-in base image. */
  image: idSchema.optional(),
  /** Reserved. Phase 1 cells always reach the network through the egress proxy. */
  network: z.literal('proxy').optional(),
  sandbox: sandboxSchema.optional(),
  /** Agents this agent may delegate tasks to. */
  delegates: z.array(idSchema).max(50).optional(),
  triggers: z.array(triggerSchema).max(20).optional(),
  /** Skill ids in `skills/`, copied into the cell at task start. */
  skills: z.array(idSchema).max(50).optional(),
  /** Per connector: `ask` holds writes for approval in the TUI. Reads are never held. */
  approvals: z.partialRecord(connectorSchema, approvalModeSchema).optional(),
  workspaces: z.array(workspaceSchema).max(10).optional(),
});
export type AgentLayer = z.infer<typeof agentLayerSchema>;

export const resolvedAgentSchema = z
  .strictObject({
    id: idSchema,
    name: z.string(),
    description: z.string().optional(),
    runtime: runtimeSchema,
    model: z.string().optional(),
    effort: effortSchema.optional(),
    prompt: z.strictObject({
      mode: z.enum(['replace', 'append']).default('append'),
      text: z.string().default(''),
    }),
    connectors: z
      .array(connectorSchema)
      .default([])
      .refine((c) => new Set(c).size === c.length, 'connectors must not repeat'),
    image: idSchema.default(BASE_IMAGE),
    network: z.literal('proxy').default('proxy'),
    sandbox: sandboxSchema.default('cell'),
    delegates: z.array(idSchema).default([]),
    triggers: z.array(triggerSchema).default([]),
    skills: z.array(idSchema).default([]),
    approvals: z.partialRecord(connectorSchema, approvalModeSchema).default({}),
    workspaces: z.array(workspaceSchema).max(10).default([]),
  })
  .refine((a) => new Set(a.workspaces.map(workspaceName)).size === a.workspaces.length, {
    message: 'workspaces need distinct names; set name: for one of them',
    path: ['workspaces'],
  })
  .refine((a) => a.runtime === 'codex' || a.sandbox === 'cell', {
    message: 'sandbox codex-workspace-write needs runtime codex',
    path: ['sandbox'],
  })
  .refine(
    (a) =>
      Object.keys(a.approvals).every((c) => (PROXY_CONNECTORS as readonly string[]).includes(c)),
    {
      message:
        'approvals apply to github, aws and linear; writes to gmail, drive, notion and slack follow their connector policy',
      path: ['approvals'],
    },
  )
  .refine((a) => !a.delegates.includes(a.id), {
    message: 'an agent cannot delegate to itself',
    path: ['delegates'],
  });
export type ResolvedAgentConfig = z.infer<typeof resolvedAgentSchema>;

const aptPackage = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,99}$/, 'not a Debian package name');

/**
 * An image recipe: packages and commands run as root in a build cell on top of the base image.
 * The build cell reaches the network through the proxy with no credential injection.
 */
export const imageRecipeSchema = z.strictObject({
  id: idSchema.optional(),
  description: z.string().max(500).optional(),
  from: z.literal(BASE_IMAGE).default(BASE_IMAGE),
  packages: z.array(aptPackage).max(200).default([]),
  run: z.array(z.string().min(1).max(4000)).max(50).default([]),
});
export type ImageRecipe = z.infer<typeof imageRecipeSchema>;
