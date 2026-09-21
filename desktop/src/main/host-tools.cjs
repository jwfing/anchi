const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
/** Known installation paths only: the renderer can never supply executable paths. */
const KNOWN = {
  brew: ['/opt/homebrew/bin/brew'],
  python: ['/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3', '/usr/bin/python3'],
  codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
  limactl: ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl'],
};
async function executable(
  name,
  { access = fs.access, readdir = fs.readdir, home = os.homedir() } = {},
) {
  const candidates = [...(KNOWN[name] || [])];
  if (name === 'codex') {
    const base = path.join(home, '.nvm/versions/node');
    const versions = await readdir(base).catch(() => []);
    candidates.push(
      ...versions
        .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
        .sort()
        .reverse()
        .map((v) => path.join(base, v, 'bin/codex')),
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
module.exports = { executable, KNOWN };
