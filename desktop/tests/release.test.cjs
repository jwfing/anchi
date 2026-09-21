const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseConfiguration } = require('../scripts/release.cjs');
test('release refuses missing identity, team, profile or owned bundle ID', () => {
  assert.equal(releaseConfiguration({}), null);
  assert.throws(() => releaseConfiguration({ QISUO_RELEASE: '1' }));
  const valid = {
    QISUO_RELEASE: '1',
    QISUO_SIGN_IDENTITY: 'Developer ID Application: Example (ABCDEFGHIJ)',
    QISUO_APPLE_TEAM: 'ABCDEFGHIJ',
    QISUO_NOTARY_PROFILE: 'qisuo',
    QISUO_BUNDLE_ID: 'com.example.qisuo',
  };
  assert.equal(releaseConfiguration(valid).bundleId, 'com.example.qisuo');
  for (const key of [
    'QISUO_SIGN_IDENTITY',
    'QISUO_APPLE_TEAM',
    'QISUO_NOTARY_PROFILE',
    'QISUO_BUNDLE_ID',
  ])
    assert.throws(() => releaseConfiguration({ ...valid, [key]: '' }));
  assert.throws(() => releaseConfiguration({ ...valid, QISUO_BUNDLE_ID: 'local.securevm.qisuo' }));
  const renamed = Object.fromEntries(
    Object.entries(valid).map(([k, v]) => [k.replace('QISUO_', 'ANCHI_'), v]),
  );
  assert.equal(releaseConfiguration(renamed).team, 'ABCDEFGHIJ');
  assert.equal(
    releaseConfiguration({ ...renamed, ANCHI_BUNDLE_ID: 'com.example.anchi' }).bundleId,
    'com.example.anchi',
  );
});
