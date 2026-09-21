const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveUserData } = require('../src/main/user-data.cjs');
test('profile directory migrates once and never loses a legacy profile', () => {
  const calls = [];
  const io = (present, failRename = false) => ({
    exists: (p) => present.includes(p),
    rename: (a, b) => {
      calls.push([a, b]);
      if (failRename) throw Error('EPERM');
    },
  });
  assert.deepEqual(resolveUserData('/app', io([])), { path: '/app/Anchi', migrated: false });
  assert.deepEqual(resolveUserData('/app', io(['/app/Anchi', '/app/Qisuo'])), {
    path: '/app/Anchi',
    migrated: false,
  });
  assert.deepEqual(resolveUserData('/app', io(['/app/Qisuo'])), {
    path: '/app/Anchi',
    migrated: true,
  });
  assert.deepEqual(calls, [['/app/Qisuo', '/app/Anchi']]);
  assert.deepEqual(resolveUserData('/app', io(['/app/Qisuo'], true)), {
    path: '/app/Qisuo',
    migrated: false,
  });
});
