import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type HomeLayout, homeLayout, resolvePath } from '../paths.ts';
import {
  type AgentLayer,
  agentLayerSchema,
  BASE_IMAGE,
  type ImageRecipe,
  imageRecipeSchema,
  type ResolvedAgentConfig,
  resolvedAgentSchema,
} from './schema.ts';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'ConfigError';
  }
}

export interface ResolvedAgent extends ResolvedAgentConfig {
  /** Files merged to produce this agent, base template first. */
  sourceFiles: string[];
}

export function parseYamlAs<T>(raw: string, schema: z.ZodType<T>, file?: string): T {
  let value: unknown;
  try {
    value = parseYaml(raw) ?? {};
  } catch (err) {
    throw new ConfigError(`invalid YAML: ${(err as Error).message}`, file);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConfigError(`\n${z.prettifyError(parsed.error)}`, file);
  return parsed.data;
}

function readYaml<T>(file: string, schema: z.ZodType<T>): T {
  return parseYamlAs(readFileSync(file, 'utf8'), schema, file);
}

function listIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ['.yaml', '.yml'].includes(extname(f)))
    .map((f) => basename(f, extname(f)))
    .sort();
}

export function listAgentIds(layout: HomeLayout = homeLayout()): string[] {
  return listIds(layout.agentsDir);
}

export function listImageIds(layout: HomeLayout = homeLayout()): string[] {
  return listIds(layout.imagesDir);
}

function findYaml(dir: string, id: string): string | undefined {
  return ['.yaml', '.yml'].map((ext) => join(dir, id + ext)).find((f) => existsSync(f));
}

export function agentFile(layout: HomeLayout, id: string): string {
  return findYaml(layout.agentsDir, id) ?? join(layout.agentsDir, `${id}.yaml`);
}

export function imageFile(layout: HomeLayout, id: string): string {
  return findYaml(layout.imagesDir, id) ?? join(layout.imagesDir, `${id}.yaml`);
}

/** Loads one layer and inlines its prompt file, resolved relative to the declaring file. */
function loadLayer(file: string): AgentLayer {
  const layer = readYaml(file, agentLayerSchema);
  if (layer.prompt?.file) {
    const promptFile = resolvePath(layer.prompt.file, dirname(file));
    if (!existsSync(promptFile))
      throw new ConfigError(`prompt file not found: ${promptFile}`, file);
    const { file: _file, ...prompt } = layer.prompt;
    layer.prompt = { ...prompt, text: readFileSync(promptFile, 'utf8') };
  }
  return layer;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars in `over` replace those in `base`. */
export function mergeLayers<T>(base: T, over: T): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = mergeLayers(out[k], v);
  }
  return out as T;
}

export function resolveAgent(id: string, layout: HomeLayout = homeLayout()): ResolvedAgent {
  const file0 = findYaml(layout.agentsDir, id);
  if (!file0) throw new ConfigError(`agent "${id}" not found in ${layout.agentsDir}`);

  const chain: { file: string; layer: AgentLayer }[] = [];
  let file: string | undefined = file0;
  while (file) {
    if (chain.some((c) => c.file === file)) throw new ConfigError('circular "extends"', file);
    const layer = loadLayer(file);
    chain.unshift({ file, layer });
    if (!layer.extends) break;
    const parent = layer.extends;
    file = findYaml(layout.templatesDir, parent);
    if (!file) {
      throw new ConfigError(
        `template "${parent}" not found in ${layout.templatesDir}`,
        chain[0]!.file,
      );
    }
  }

  let merged: AgentLayer = {};
  for (const { layer } of chain) merged = mergeLayers(merged, layer);
  const { extends: _extends, id: declared, ...rest } = merged;
  if (declared !== undefined && declared !== id) {
    throw new ConfigError(`id "${declared}" does not match the file name "${id}"`, file0);
  }
  const candidate = { ...rest, id, name: rest.name ?? id, prompt: rest.prompt ?? {} };
  const parsed = resolvedAgentSchema.safeParse(candidate);
  if (!parsed.success) throw new ConfigError(`\n${z.prettifyError(parsed.error)}`, file0);
  const agent = parsed.data;
  if (agent.image !== BASE_IMAGE && !findYaml(layout.imagesDir, agent.image)) {
    throw new ConfigError(`image "${agent.image}" not found in ${layout.imagesDir}`, file0);
  }
  return { ...agent, sourceFiles: chain.map((c) => c.file) };
}

export interface LoadedImage {
  id: string;
  recipe: ImageRecipe;
  /** Content hash of the normalized recipe; a changed hash means the image must be rebuilt. */
  hash: string;
}

export function imageHash(recipe: ImageRecipe): string {
  const normalized = { from: recipe.from, packages: recipe.packages, run: recipe.run };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export function loadImage(id: string, layout: HomeLayout = homeLayout()): LoadedImage {
  if (id === BASE_IMAGE) {
    const recipe = imageRecipeSchema.parse({});
    return { id, recipe, hash: 'base' };
  }
  const file = findYaml(layout.imagesDir, id);
  if (!file) throw new ConfigError(`image "${id}" not found in ${layout.imagesDir}`);
  const recipe = readYaml(file, imageRecipeSchema);
  if (recipe.id !== undefined && recipe.id !== id) {
    throw new ConfigError(`id "${recipe.id}" does not match the file name "${id}"`, file);
  }
  return { id, recipe, hash: imageHash(recipe) };
}
