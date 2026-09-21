const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { releaseConfiguration, preflight, notarize } = require('./release.cjs');
const { bundleRuntime } = require('./runtime-bundle.cjs');
const { describe } = require('../src/main/platform.cjs');
const { targetFor } = require('./package-target.cjs');

async function main() {
  const target = targetFor(describe());
  if (!target) throw Error('Packaging supports macOS arm64 and Linux x64 hosts only.');
  const config = releaseConfiguration(process.env);
  if (config && target.platform !== 'darwin') throw Error('RELEASE_UNSUPPORTED_PLATFORM');
  if (config) await preflight(config);
  const { packager } = await import('@electron/packager');
  const directory = path.resolve(__dirname, '..');
  const root = path.resolve(directory, '..');
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-package-'));
  try {
    const runtime = path.join(stage, 'runtime');
    const manifest = await bundleRuntime(root, runtime, pkg.version);
    const out = path.join(root, 'artifacts/releases', pkg.version, ...(config ? ['signed'] : []));
    await fs.mkdir(out, { recursive: true });
    // A failed replacement build must not retain a previous success manifest/archive.
    for (const name of [
      'build-manifest.json',
      'notarization.json',
      target.archive,
      target.archive + '.sha256',
    ])
      await fs.rm(path.join(out, name), { force: true });
    const results = await packager({
      dir: directory,
      name: pkg.productName,
      platform: target.platform,
      arch: target.arch,
      out,
      overwrite: true,
      asar: true,
      ...(target.platform === 'darwin'
        ? {
            appBundleId: config?.bundleId || 'local.anchi.desktop',
            ...(config
              ? {
                  osxSign: {
                    identity: config.identity,
                    optionsForFile: () => ({ hardenedRuntime: true }),
                  },
                }
              : {}),
          }
        : {}),
      appVersion: pkg.version,
      extraResource: [runtime, path.join(root, 'license.md')],
      ignore: [/^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/workspace\.json$/, /^\/\.prettier/],
    });
    let release = {};
    if (config)
      release = await notarize(path.join(results[0], pkg.productName + '.app'), out, config);
    else if (target.platform === 'linux') {
      // Unsigned tarball plus a checksum file; there is no signing story for Linux yet.
      const archive = path.join(out, target.archive);
      await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', out, target.directory]);
      const sha256 = createHash('sha256')
        .update(await fs.readFile(archive))
        .digest('hex');
      await fs.writeFile(archive + '.sha256', sha256 + '  ' + target.archive + '\n');
      release = { archive: target.archive, sha256 };
    }
    await fs.writeFile(
      path.join(out, 'build-manifest.json'),
      JSON.stringify(
        {
          version: pkg.version,
          platform: target.platform,
          arch: target.arch,
          electron: pkg.devDependencies.electron,
          signed: !!config,
          notarized: !!config,
          ...release,
          runtimeFileCount: manifest.files.length,
          runtimeManifestSha256: createHash('sha256')
            .update(await fs.readFile(path.join(runtime, 'manifest.json')))
            .digest('hex'),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(results.join('\n'));
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
