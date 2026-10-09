// The release has no node_modules: bundle the host and guest independently.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/cell-runner/package.json', import.meta.url));
const { build } = require('esbuild');
const out = resolve(process.argv[2]);
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'linked',
  metafile: true,
};
const inputs = new Set();
async function bundle(options) {
  const result = await build(options);
  for (const path of Object.keys(result.metafile.inputs)) inputs.add(resolve(root, path));
}
for (const [name, entry] of [
  ['cli', 'tui'],
  ['daemon', 'daemon'],
]) {
  await bundle({
    ...common,
    entryPoints: [`packages/${entry}/src/main.ts`],
    outfile: `${out}/lib/${name}.mjs`,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' },
    // Ink's optional developer-tools import is unreachable in production.
    external: ['./devtools.js'],
  });
}
for (const [name, entry] of [
  ['runner', 'main'],
  ['forward', 'forward-main'],
  ['mcp', 'mcp-main'],
]) {
  await bundle({
    ...common,
    entryPoints: [`packages/cell-runner/src/${entry}.ts`],
    outfile: `${out}/anchi/packages/cell-runner/dist/${name}.mjs`,
  });
}
const packages = new Set();
const notices = [];
for (const input of inputs) {
  let dir = dirname(input);
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  if (packages.has(dir) || !existsSync(join(dir, 'package.json'))) continue;
  packages.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.name?.startsWith('@anchi/')) continue;
  const licenses = readdirSync(dir).filter((name) => /^(license|copying|notice)(\.|$)/i.test(name));
  notices.push(
    `${pkg.name}@${pkg.version} (${pkg.license ?? 'see license below'})\n` +
      licenses.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n'),
  );
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), notices.sort().join('\n\n---\n\n'));
