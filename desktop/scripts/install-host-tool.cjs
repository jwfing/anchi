// Install one pinned host tool from desktop/host-tools.json for the current platform.
// First-run setup uses the same downloader; CI calls this directly. Stdlib only.
const { describe } = require('../src/main/platform.cjs');
const { entriesFor, install } = require('../src/main/downloader.cjs');
async function main() {
  const name = process.argv[2];
  const info = describe();
  const entry = entriesFor(info.id)[name];
  if (!entry) throw Error(`No pinned download for ${name} on ${info.id || 'unsupported platform'}`);
  console.log(await install(name, entry, { toolsDirectory: info.toolsDirectory }));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
