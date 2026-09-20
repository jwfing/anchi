const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { releaseConfiguration, preflight, notarize } = require('./release.cjs');
const { bundleRuntime } = require('./runtime-bundle.cjs');

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Packaging currently supports macOS arm64 only.');
  const config = releaseConfiguration(process.env);
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
      'Anchi-mac-arm64.zip',
      'Anchi-mac-arm64.zip.sha256',
    ])
      await fs.rm(path.join(out, name), { force: true });
    const results = await packager({
      dir: directory,
      name: pkg.productName,
      platform: 'darwin',
      arch: 'arm64',
      out,
      overwrite: true,
      asar: true,
      appBundleId: config?.bundleId || 'local.securevm.qisuo',
      ...(config
        ? {
            osxSign: {
              identity: config.identity,
              optionsForFile: () => ({ hardenedRuntime: true }),
            },
          }
        : {}),
      appVersion: pkg.version,
      extraResource: [runtime],
      ignore: [/^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/workspace\.json$/, /^\/\.prettier/],
    });
    const release = config
      ? await notarize(path.join(results[0], pkg.productName + '.app'), out, config)
      : {};
    await fs.writeFile(
      path.join(out, 'build-manifest.json'),
      JSON.stringify(
        {
          version: pkg.version,
          platform: 'darwin',
          arch: 'arm64',
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
