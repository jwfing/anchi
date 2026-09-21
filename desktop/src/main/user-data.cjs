const fs = require('node:fs');
const path = require('node:path');
/**
 * One-time move of the pre-rename profile directory. Falls back to the legacy
 * directory when the rename fails so an existing installation keeps working.
 */
function resolveUserData(appData, { exists = fs.existsSync, rename = fs.renameSync } = {}) {
  const current = path.join(appData, 'Anchi');
  const legacy = path.join(appData, 'Qisuo');
  if (exists(current)) return { path: current, migrated: false };
  if (!exists(legacy)) return { path: current, migrated: false };
  try {
    rename(legacy, current);
    return { path: current, migrated: true };
  } catch {
    return { path: legacy, migrated: false };
  }
}
module.exports = { resolveUserData };
