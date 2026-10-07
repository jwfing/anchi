// Trust-zone dependency check. Host packages (core, daemon, tui) must never load a runtime
// SDK or the cell runner; the cell runner must never load a host package. Checks both the
// package manifests and every import in the sources.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../packages/', import.meta.url).pathname;
const RUNTIME = [/^@openai\/codex/, /^@anthropic-ai\//, /^@mariozechner\/pi/];
const FORBIDDEN = {
  protocol: [/^@anchi\/(?!protocol$)/, ...RUNTIME],
  core: [/^@anchi\/(cell-runner|daemon|tui)$/, ...RUNTIME],
  daemon: [/^@anchi\/(cell-runner|tui)$/, ...RUNTIME],
  tui: [/^@anchi\/cell-runner$/, ...RUNTIME],
  'cell-runner': [/^@anchi\/(core|daemon|tui)$/],
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const problems = [];
for (const [pkg, rules] of Object.entries(FORBIDDEN)) {
  const dir = join(root, pkg);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const dep of declared) {
    if (rules.some((r) => r.test(dep))) problems.push(`${pkg}/package.json depends on ${dep}`);
  }
  for (const file of files(join(dir, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (rules.some((r) => r.test(spec))) problems.push(`${file} imports ${spec}`);
      if (spec.startsWith('../../')) problems.push(`${file} reaches into another package: ${spec}`);
    }
  }
}
if (problems.length) {
  console.error(`Trust-zone dependency violations:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('trust-zone dependencies ok');
