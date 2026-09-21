const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
/** ANCHI_* is canonical; QISUO_* remains accepted for existing release environments. */
function releaseConfiguration(env) {
  const get = (name) => env['ANCHI_' + name] ?? env['QISUO_' + name];
  if (get('RELEASE') !== '1') return null;
  const identity = get('SIGN_IDENTITY');
  const team = get('APPLE_TEAM');
  const profile = get('NOTARY_PROFILE');
  const bundleId = get('BUNDLE_ID');
  if (
    !team ||
    !/^[A-Z0-9]{10}$/.test(team) ||
    !identity?.startsWith('Developer ID Application: ') ||
    !identity.endsWith(`(${team})`) ||
    !profile ||
    !bundleId ||
    !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/.test(bundleId) ||
    bundleId.startsWith('local.')
  )
    throw Error('RELEASE_CONFIGURATION_REQUIRED');
  return { identity, team, profile, bundleId };
}
async function preflight(config) {
  const { stdout } = await exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!stdout.includes(`"${config.identity}"`)) throw Error('DEVELOPER_ID_CERTIFICATE_MISSING');
  await exec(
    '/usr/bin/xcrun',
    ['notarytool', 'history', '--keychain-profile', config.profile, '--output-format', 'json'],
    { timeout: 60000 },
  );
}
async function notarize(app, out, config) {
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const archive = path.join(out, 'Anchi-notarization.zip');
  await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
  const { stdout } = await exec(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      archive,
      '--keychain-profile',
      config.profile,
      '--wait',
      '--output-format',
      'json',
    ],
    { timeout: 30 * 60 * 1000 },
  );
  const receipt = JSON.parse(stdout);
  await fs.writeFile(path.join(out, 'notarization.json'), JSON.stringify(receipt, null, 2));
  if (receipt.status !== 'Accepted') throw Error('NOTARIZATION_NOT_ACCEPTED');
  await exec('/usr/bin/xcrun', ['stapler', 'staple', app]);
  await exec('/usr/bin/xcrun', ['stapler', 'validate', app]);
  await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  // Rebuild after stapling: downloadable archive must carry the ticket.
  const release = path.join(out, 'Anchi-mac-arm64.zip');
  await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, release]);
  const sha256 = createHash('sha256')
    .update(await fs.readFile(release))
    .digest('hex');
  await fs.writeFile(release + '.sha256', sha256 + '  ' + path.basename(release) + '\n');
  await fs.unlink(archive);
  return { notarizationId: receipt.id, archive: path.basename(release), sha256 };
}
module.exports = { releaseConfiguration, preflight, notarize };
