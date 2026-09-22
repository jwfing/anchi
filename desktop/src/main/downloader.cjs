const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const MANIFEST = require('../../host-tools.json');

/**
 * Pinned, checksum-verified host tool downloads for platforms without a package manager
 * flow. Nothing is extracted or made executable before the SHA-256 matches the manifest.
 */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function entriesFor(platformId) {
  return MANIFEST[platformId] || {};
}
function checkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('DOWNLOAD_HOST_NOT_ALLOWED');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname))
    throw Error('DOWNLOAD_HOST_NOT_ALLOWED');
  return url.href;
}
async function open(url, fetchImpl) {
  let current = checkUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual' });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Error('DOWNLOAD_FAILED');
      current = checkUrl(new URL(location, current).href);
      continue;
    }
    if (response.status !== 200 || !response.body) throw Error('DOWNLOAD_FAILED');
    return response;
  }
  throw Error('DOWNLOAD_TOO_MANY_REDIRECTS');
}
async function install(
  name,
  entry,
  {
    toolsDirectory,
    fetch: fetchImpl = globalThis.fetch,
    tar = '/usr/bin/tar',
    chmod = fs.chmod,
    maxBytes = MAX_BYTES,
  } = {},
) {
  const home = path.join(toolsDirectory, name);
  const target = path.join(home, entry.version);
  const installed = path.join(target, entry.install_as || entry.executable);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await fs.stat(installed).catch(() => null))) {
    const temporary = path.join(home, '.download-' + randomUUID());
    const partial = target + '.partial';
    try {
      const response = await open(entry.url, fetchImpl);
      const hash = createHash('sha256');
      let size = 0;
      const body =
        response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await pipeline(
          body,
          async function* (source) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > maxBytes) throw Error('DOWNLOAD_TOO_LARGE');
              hash.update(chunk);
              yield chunk;
            }
          },
          handle.createWriteStream(),
        );
      } finally {
        await handle.close();
      }
      if (hash.digest('hex') !== entry.sha256) throw Error('DOWNLOAD_CHECKSUM_MISMATCH');
      await fs.rm(partial, { recursive: true, force: true });
      await fs.mkdir(partial, { recursive: true, mode: 0o755 });
      await promisify(execFile)(tar, ['-xzf', temporary, '-C', partial]);
      if (entry.install_as)
        await fs.rename(path.join(partial, entry.executable), path.join(partial, entry.install_as));
      await chmod(path.join(partial, entry.install_as || entry.executable), 0o755);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(partial, target);
    } finally {
      await fs.rm(temporary, { force: true });
      await fs.rm(partial, { recursive: true, force: true });
    }
  }
  const link = path.join(home, 'current');
  const pending = link + '.' + randomUUID();
  await fs.symlink(entry.version, pending);
  await fs.rename(pending, link);
  return installed;
}
module.exports = { install, entriesFor, checkUrl, ALLOWED_HOSTS, MAX_BYTES };
