// Packages the desktop app for a release, on the OS it is for: an Anchi.app on Apple silicon macOS,
// an Electron directory with an `anchi-desktop` executable on Linux x64. The app code goes in the
// bundle's resources/app, so it runs on its own; it finds the `anchi` CLI on the login shell's PATH.
//   node anchi/packages/desktop/scripts/package.mjs
// writes artifacts/releases/anchi-desktop-<target>.tar.gz and its .sha256.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '../../..');
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(repo, 'anchi/package.json'), 'utf8'));
const target = { 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64' }[
  `${process.platform}-${process.arch}`
];
if (!target) throw new Error('Release targets: Apple Silicon macOS and Linux x64');

const run = (cmd, ...args) => {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};
run(process.execPath, join(root, 'scripts/build.mjs'));

const stage = mkdtempSync(join(tmpdir(), 'anchi-desktop-'));
/** What resources/app holds: the bundles, the page and the icon, with Electron's entry point. */
function addApp(dir) {
  mkdirSync(dir, { recursive: true });
  for (const file of ['main.cjs', 'preload.cjs', 'icon.png', 'renderer', 'remote']) {
    cpSync(join(dist, file), join(dir, file), { recursive: true });
  }
  const manifest = { name: 'anchi-desktop', productName: 'Anchi', version, main: 'main.cjs' };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

let top;
if (target === 'darwin-arm64') {
  top = 'Anchi.app';
  const bundle = join(stage, top);
  // build.mjs has made dist/Anchi.app: Electron renamed, with Anchi's name, bundle id and icon.
  run('ditto', join(dist, 'Anchi.app'), bundle);
  rmSync(join(bundle, 'Contents/anchi-stamp'));
  rmSync(join(bundle, 'Contents/Resources/default_app.asar'), { force: true });
  addApp(join(bundle, 'Contents/Resources/app'));
  const plist = join(bundle, 'Contents/Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    run('plutil', '-replace', key, '-string', version, plist);
  }
  // Ad hoc, as for the source run: Apple silicon runs only signed code. Not a publisher signature.
  run('codesign', '--force', '--deep', '--sign', '-', bundle);
  run('codesign', '--verify', '--deep', '--strict', bundle);
} else {
  top = 'anchi-desktop';
  const dir = join(stage, top);
  const electronDir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  cpSync(join(electronDir, 'dist'), dir, { recursive: true, verbatimSymlinks: true });
  renameSync(join(dir, 'electron'), join(dir, 'anchi-desktop'));
  rmSync(join(dir, 'resources/default_app.asar'), { force: true });
  addApp(join(dir, 'resources/app'));
  cpSync(join(dist, 'icon.png'), join(dir, 'icon.png'));
}

const output = join(repo, 'artifacts/releases');
mkdirSync(output, { recursive: true });
const archive = join(output, `anchi-desktop-${target}.tar.gz`);
// COPYFILE_DISABLE keeps macOS tar from adding ._ resource-fork files.
const packed = spawnSync('tar', ['-czf', archive, '-C', stage, top], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (packed.status !== 0) throw new Error('tar failed');
rmSync(stage, { recursive: true, force: true });
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
console.log(`Built ${archive}`);
