const fs = require('node:fs/promises');
const path = require('node:path');
const { describe } = require('./platform.cjs');
/** Known installation paths only: the renderer can never supply executable paths. */
async function executable(
  name,
  { access = fs.access, readdir = fs.readdir, platform = describe() } = {},
) {
  const candidates = [...(platform.tools[name] || [])];
  if (name === 'codex') {
    const versions = await readdir(platform.nvmDirectory).catch(() => []);
    candidates.push(
      ...versions
        .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
        .sort()
        .reverse()
        .map((v) => path.join(platform.nvmDirectory, v, 'bin/codex')),
    );
  }
  for (const file of candidates) {
    try {
      await access(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}
module.exports = { executable };
