#!/bin/bash
# Build one relocatable release archive. Run on the target OS/CPU in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  *) echo 'Release targets: Apple Silicon macOS and glibc Linux x86_64' >&2; exit 1 ;;
esac
output=${1:-artifacts/releases}
mkdir -p "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root=$stage/anchi
mkdir -p "$root/bin" "$root/runtime"
version=$(node -p "JSON.parse(require('fs').readFileSync('anchi/package.json')).version")
# Use the same pinned Node version as the cells. Verify the official download before packing.
# shellcheck source=guest/cell.env
source guest/cell.env
node_archive=node-v$SECURE_NODE_VERSION-$target.tar.gz
curl -fsSL --retry 3 "https://nodejs.org/dist/v$SECURE_NODE_VERSION/SHASUMS256.txt" -o "$stage/sums"
curl -fsSL --retry 3 "https://nodejs.org/dist/v$SECURE_NODE_VERSION/$node_archive" -o "$stage/$node_archive"
expected=$(awk -v name="$node_archive" '$2 == name { print $1 }' "$stage/sums")
actual=$(shasum -a 256 "$stage/$node_archive" | awk '{print $1}')
[[ ${#expected} == 64 && "$expected" == "$actual" ]] || { echo 'Node checksum mismatch' >&2; exit 1; }
tar -xzf "$stage/$node_archive" -C "$stage"
cp "$stage/node-v$SECURE_NODE_VERSION-$target/bin/node" "$root/runtime/node"
cp "$stage/node-v$SECURE_NODE_VERSION-$target/LICENSE" "$root/runtime/LICENSE"
node anchi/scripts/bundle-release.mjs "$root"
cp -R guest services systemd lima "$root/"
mkdir -p "$root/scripts"
cp scripts/up.sh scripts/install-anchi.sh scripts/vault.py "$root/scripts/"
# Exclude Python caches even when packaging a developer's checkout.
find "$root" -type d -name __pycache__ -exec rm -rf {} +
cp license.md "$root/LICENSE"
printf '{"version":"%s","target":"%s"}\n' "$version" "$target" > "$root/manifest.json"
cat > "$root/bin/anchi" <<'SH'
#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/runtime/node" "$root/lib/cli.mjs" "$@"
SH
chmod +x "$root/bin/anchi"
"$root/bin/anchi" --version
"$root/bin/anchi" --help >/dev/null
archive=anchi-$target.tar.gz
tar -czf "$output/$archive" -C "$stage" anchi
(cd "$output" && shasum -a 256 "$archive" > "$archive.sha256")
echo "Built $output/$archive"
