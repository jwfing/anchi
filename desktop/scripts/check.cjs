const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(cjs|mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.error || result.status !== 0) process.exit(1);
    }
  }
}
for (const directory of ['src', 'scripts', 'tests']) check(path.join(__dirname, '..', directory));
