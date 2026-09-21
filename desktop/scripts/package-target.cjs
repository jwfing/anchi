/** Output names per supported host; packaging never cross-compiles. */
const TARGETS = Object.freeze({
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    directory: 'Anchi-darwin-arm64',
    archive: 'Anchi-mac-arm64.zip',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    directory: 'Anchi-linux-x64',
    archive: 'Anchi-linux-x64.tar.gz',
  },
});
function targetFor(info) {
  return TARGETS[info.id] ? { ...TARGETS[info.id] } : null;
}
module.exports = { targetFor, TARGETS };
