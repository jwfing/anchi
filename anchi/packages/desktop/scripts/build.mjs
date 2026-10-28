// Bundles the desktop app into dist/: the Electron main process and preload as CommonJS, the
// renderer as one browser script with its page and stylesheet. Fetches Electron's binary when
// the install skipped it. The icon comes from assets/: the landing page's mark, padded for docks.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

const repository = join(root, '../../..');
mkdirSync(join(dist, 'remote'), { recursive: true });
for (const file of [
  'scripts/bootstrap-server.sh',
  'landing/dist/install.sh',
  'scripts/anchi-bridge.py',
  'guest/anchi_data_dir.py',
]) {
  copyFileSync(join(repository, file), join(dist, 'remote', file.split('/').at(-1)));
}
writeFileSync(
  join(dist, 'remote/version'),
  JSON.parse(readFileSync(join(root, '../../package.json'), 'utf8')).version,
);

// macOS names an app in the menu bar and the Dock from its bundle, not from app.setName: give the
// source run its own copy of Electron.app, called Anchi, with the Anchi icon. Rebuilt only when
// Electron or the icon changes.
if (process.platform === 'darwin') {
  const bundle = join(dist, 'Anchi.app');
  const icon = readFileSync(join(root, 'assets/icon.png'));
  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
  const stamp = `2 ${version} ${createHash('sha256').update(icon).digest('hex')}`;
  const stampFile = join(bundle, 'Contents/anchi-stamp');
  if (!existsSync(stampFile) || readFileSync(stampFile, 'utf8') !== stamp) {
    const run = (cmd, ...args) => {
      const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
      if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
    };
    rmSync(bundle, { recursive: true, force: true });
    run('ditto', join(electronDir, 'dist/Electron.app'), bundle);
    // The executable's name is the process name (Activity Monitor, Force Quit); helpers still start.
    renameSync(join(bundle, 'Contents/MacOS/Electron'), join(bundle, 'Contents/MacOS/Anchi'));
    const plist = join(bundle, 'Contents/Info.plist');
    for (const [key, value] of [
      ['CFBundleExecutable', 'Anchi'],
      ['CFBundleName', 'Anchi'],
      ['CFBundleDisplayName', 'Anchi'],
      ['CFBundleIdentifier', 'dev.anchi.desktop'],
      ['CFBundleIconFile', 'anchi.icns'],
    ]) {
      run('plutil', '-replace', key, '-string', value, plist);
    }
    const iconset = join(mkdtempSync(join(tmpdir(), 'anchi-icon-')), 'anchi.iconset');
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [
        [1, ''],
        [2, '@2x'],
      ]) {
        const px = String(size * scale);
        const out = join(iconset, `icon_${size}x${size}${suffix}.png`);
        run('sips', '-z', px, px, join(root, 'assets/icon.png'), '--out', out);
      }
    }
    run('iconutil', '-c', 'icns', iconset, '-o', join(bundle, 'Contents/Resources/anchi.icns'));
    rmSync(dirname(iconset), { recursive: true, force: true });
    writeFileSync(stampFile, stamp);
    // Editing the bundle breaks Electron's signature; Apple silicon runs only signed code.
    run('codesign', '--force', '--deep', '--sign', '-', bundle);
  }
}
