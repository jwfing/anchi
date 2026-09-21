const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Never copy workspace data, credentials, node_modules or logs into a release.
const SOURCES = {
  scripts: (name) => /\.(sh|py)$/.test(name),
  services: (name) => name.endsWith('.py'),
  guest: (name) => /\.(sh|py)$/.test(name) || ['cell-run', 'cell.env'].includes(name),
  systemd: (name) => /\.(service|socket|timer)$/.test(name),
  lima: (name) => name === 'secure-vm.yaml',
  pi: (name) => name.endsWith('.mjs') || ['package.json', 'package-lock.json'].includes(name),
};
async function bundleRuntime(root, destination, version) {
  const files = [];
  await fs.mkdir(destination, { recursive: true });
  for (const [folder, accepts] of Object.entries(SOURCES)) {
    for (const entry of (await fs.readdir(path.join(root, folder), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!accepts(entry.name)) continue;
      if (!entry.isFile()) throw Error('Runtime input must be a regular file: ' + entry.name);
      const relative = folder + '/' + entry.name;
      const bytes = await fs.readFile(path.join(root, relative));
      await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
      await fs.writeFile(path.join(destination, relative), bytes, { mode: 0o644 });
      files.push({
        path: relative,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
  }
  const manifest = { schemaVersion: 1, version, files };
  await fs.writeFile(
    path.join(destination, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}
module.exports = { bundleRuntime };
