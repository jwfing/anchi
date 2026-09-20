const fs = require('node:fs/promises');
const path = require('node:path');
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
  activate(id) {
    return this.serial(async () => {
      const item = this.directories.directories.find((d) => d.id === id);
      if (!item) throw Error('DIRECTORY_NOT_FOUND');
      if ((await fs.realpath(item.path)) !== item.path) throw Error('DIRECTORY_CHANGED');
      const stat = await fs.stat(item.path, { bigint: true });
      if (!stat.isDirectory()) throw Error('INVALID_DIRECTORY');
      this.grants.set(id, { ...item, identity: [String(stat.dev), String(stat.ino)] });
    });
  }
  revoke(id) {
    // Disable new requests immediately; wait for the bounded in-flight operation.
    this.grants.delete(id);
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
          '/usr/bin/python3',
          [path.join(this.runtime.root, 'scripts/host-files.py')],
          { grant, request },
        );
        this.notify({
          type: 'activity',
          text: `文件访问 ${request.op} · ${grant.id} · ${result.ok ? '完成' : '拒绝'}`,
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
