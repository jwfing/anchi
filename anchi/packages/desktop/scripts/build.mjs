// Bundles the desktop app into dist/: the Electron main process and preload as CommonJS, the
// renderer as one browser script with its page and stylesheet. Fetches Electron's binary when
// the install skipped it. The icon comes from assets/: the landing page's mark, padded for docks.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(join(dist, 'renderer'), { recursive: true });

const electronDir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
if (!existsSync(join(electronDir, 'path.txt'))) {
  const res = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const node = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
};
await build({
  ...node,
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(dist, 'main.cjs'),
  external: ['electron'],
});
await build({
  ...node,
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(dist, 'preload.cjs'),
  external: ['electron'],
});
await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome140',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: process.env.ANCHI_DESKTOP_DEBUG !== '1',
  entryPoints: [join(root, 'src/renderer/index.tsx')],
  outfile: join(dist, 'renderer/app.js'),
});
for (const file of ['index.html', 'app.css']) {
  copyFileSync(join(root, 'src/renderer', file), join(dist, 'renderer', file));
}
copyFileSync(join(root, 'assets/icon.svg'), join(dist, 'renderer/icon.svg'));
copyFileSync(join(root, 'assets/icon.png'), join(dist, 'icon.png'));
