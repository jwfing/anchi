const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { overlaps } = require('../shared/protocol.cjs');

const SCHEMA_VERSION = 1;
function validateMode(mode) {
  if (!['ro', 'rw'].includes(mode)) throw Error('INVALID_MODE');
}
function validateDirectory(chosen, home, entries) {
  if (!path.isAbsolute(chosen) || path.normalize(chosen) !== chosen)
    throw Error('INVALID_DIRECTORY');
  const system = [
    '/',
    '/System',
    '/Library',
    '/etc',
    '/private',
    '/usr',
    '/bin',
    '/sbin',
    '/dev',
    '/var',
  ];
  const secrets = [
    '.ssh',
    '.aws',
    '.kube',
    '.codex',
    '.config',
    '.lima',
    '.hermes',
    '.gnupg',
    'Library',
  ];
  if (
    chosen === home ||
    system.some((p) => chosen === p || (p !== '/' && chosen.startsWith(p + '/'))) ||
    secrets.some((p) => overlaps(chosen, path.join(home, p)))
  )
    throw Error('SENSITIVE_DIRECTORY_NOT_ALLOWED');
  if (entries.some((d) => overlaps(chosen, d.path))) throw Error('DIRECTORY_OVERLAPS');
}

/** Stores plans only. No mount, filesystem capability or grant is created here. */
class DirectoryStore {
  constructor(file, home, io = fs) {
    this.file = file;
    this.home = home;
    this.io = io;
    this.entries = [];
    this.tail = Promise.resolve();
    this.loadFailed = false;
  }
  get directories() {
    return this.entries.map((d) => ({ ...d }));
  }

  async load() {
    try {
      const stat = await this.io.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw Error('INVALID_SETTINGS');
      const value = JSON.parse(await this.io.readFile(this.file, 'utf8'));
      // Migrate the unversioned desktop prototype in memory; commit on the next edit.
      if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION)
        throw Error('UNSUPPORTED_SETTINGS_VERSION');
      if (!Array.isArray(value.directories) || value.directories.length > 100)
        throw Error('INVALID_SETTINGS');
      const next = [],
        ids = new Set();
      for (const d of value.directories) {
        if (
          !d ||
          typeof d.id !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(d.id) ||
          ids.has(d.id) ||
          typeof d.path !== 'string'
        )
          throw Error('INVALID_SETTINGS');
        validateMode(d.mode);
        validateDirectory(d.path, this.home, next);
        ids.add(d.id);
        next.push({ id: d.id, path: d.path, mode: d.mode, status: 'pending' });
      }
      this.entries = next;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // Preserve corrupt/unknown data; never silently overwrite it with a fresh store.
      this.loadFailed = true;
      throw error;
    }
  }

  mutate(build) {
    const result = this.tail.then(async () => {
      if (this.loadFailed) throw Error('SETTINGS_RECOVERY_REQUIRED');
      const next = await build(this.directories);
      await this.io.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await this.io.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ schemaVersion: SCHEMA_VERSION, directories: next }, null, 2),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.io.rename(temp, this.file);
        this.entries = next;
      } finally {
        await this.io.unlink(temp).catch(() => {});
      }
      return this.directories;
    });
    this.tail = result.catch(() => {});
    return result;
  }

  add(file, mode) {
    validateMode(mode);
    return this.mutate(async (next) => {
      if (next.length >= 100) throw Error('DIRECTORY_LIMIT');
      const chosen = await this.io.realpath(file);
      if (!(await this.io.stat(chosen)).isDirectory()) throw Error('INVALID_DIRECTORY');
      validateDirectory(chosen, this.home, next);
      next.push({ id: randomUUID(), path: chosen, mode, status: 'pending' });
      return next;
    });
  }

  update(id, mode) {
    validateMode(mode);
    return this.mutate((next) => {
      const item = next.find((d) => d.id === id);
      if (!item) throw Error('DIRECTORY_NOT_FOUND');
      item.mode = mode;
      return next;
    });
  }

  remove(id) {
    return this.mutate((next) => {
      if (!next.some((d) => d.id === id)) throw Error('DIRECTORY_NOT_FOUND');
      return next.filter((d) => d.id !== id);
    });
  }
}
module.exports = { DirectoryStore, validateDirectory };
