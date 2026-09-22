const fs = require('node:fs/promises');
const path = require('node:path');
const { validateProtectedDirectory } = require('./directory-store.cjs');
class FileBroker {
  constructor({ directories, runtime, notify = () => {} }) {
    Object.assign(this, { directories, runtime, notify });
    this.grants = new Map();
    this.tail = Promise.resolve();
    this.queued = 0;
  }
  serial(work) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  /**
   * confirmed=true follows a native consent dialog and pins the directory identity.
   * confirmed=false restores a persisted grant only when the identity still matches.
   */
  activate(id, { confirmed = true } = {}) {
    return this.serial(async () => {
      const item = this.directories.directories.find((d) => d.id === id);
      if (!item) throw Error('DIRECTORY_NOT_FOUND');
      validateProtectedDirectory(item.path, item.mode, this.directories.protectedPaths);
      if ((await fs.realpath(item.path)) !== item.path) throw Error('DIRECTORY_CHANGED');
      const stat = await fs.stat(item.path, { bigint: true });
      if (!stat.isDirectory()) throw Error('INVALID_DIRECTORY');
      const identity = [String(stat.dev), String(stat.ino)];
      if (confirmed) {
        if (!item.identity || item.identity.join() !== identity.join())
          await this.directories.recordIdentity?.(id, identity);
      } else if (!item.identity) throw Error('CONSENT_REQUIRED');
      else if (item.identity.join() !== identity.join()) throw Error('DIRECTORY_CHANGED');
      this.restoreErrors?.delete(id);
      this.grants.set(id, { ...item, identity });
    });
  }
  /** Restore persisted grants at launch; failures stay pending with a reason for the UI. */
  async restore() {
    this.restoreErrors = new Map();
    for (const item of this.directories.directories) {
      try {
        await this.activate(item.id, { confirmed: false });
      } catch (error) {
        this.restoreErrors.set(
          item.id,
          /^[A-Z_]+$/.test(error.message) ? error.message : 'DIRECTORY_UNAVAILABLE',
        );
      }
    }
    return this.restoreErrors;
  }
  revoke(id) {
    // Disable new requests immediately; wait for the bounded in-flight operation.
    this.grants.delete(id);
    this.restoreErrors?.delete(id);
    return this.serial(() => {
      this.grants.delete(id);
    });
  }
  async request(request) {
    if (this.queued >= 8) throw Error('FILE_QUEUE_FULL');
    this.queued++;
    try {
      return await this.serial(async () => {
        if (
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          Object.keys(request).some((k) => !['op', 'grant', 'path', 'text'].includes(k))
        )
          throw Error('INVALID_FILE_REQUEST');
        if (request.op === 'grants')
          return {
            grants: [...this.grants.values()].map((d) => ({
              id: d.id,
              name: path.basename(d.path),
              mode: d.mode,
            })),
          };
        const grant = this.grants.get(request.grant);
        if (!grant) throw Error('DIRECTORY_NOT_AUTHORIZED');
        const result = await this.runtime.input(
          await this.runtime.python(),
          [path.join(this.runtime.root, 'scripts/host-files.py')],
          { grant, request },
        );
        const target = typeof request.path === 'string' ? request.path : '';
        this.notify({
          type: 'activity',
          text: `文件访问 ${request.op} · ${path.basename(grant.path)}/${target} · ${result.ok ? '完成' : '拒绝'}`,
        });
        if (!result.ok) throw Error(result.error);
        if (Buffer.byteLength(JSON.stringify(result.result)) > 48000)
          throw Error('FILE_RESPONSE_TOO_LARGE');
        return result.result;
      });
    } finally {
      this.queued--;
    }
  }
}
module.exports = { FileBroker };
