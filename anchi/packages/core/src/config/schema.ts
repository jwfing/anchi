import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'use 1–40 lowercase letters, digits or "-"');

export const runtimeSchema = z.enum(['codex']);
export type Runtime = z.infer<typeof runtimeSchema>;

export const connectorSchema = z.enum(['github', 'aws', 'linear']);
export type Connector = z.infer<typeof connectorSchema>;

/** `cell`: the cell is the only boundary. `codex-workspace-write` adds Codex's own sandbox. */
export const sandboxSchema = z.enum(['cell', 'codex-workspace-write']);
export type Sandbox = z.infer<typeof sandboxSchema>;

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);

/** Built-in image every recipe starts from: Debian base, Node, Codex and the cell runner. */
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
});
export type AgentLayer = z.infer<typeof agentLayerSchema>;

export const resolvedAgentSchema = z.strictObject({
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
