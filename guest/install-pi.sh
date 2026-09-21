#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 ]]
src=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=guest/cell.env
source "$src/cell.env"
# shellcheck source=guest/arch.sh
source "$src/arch.sh"
node_arch=$(node_arch "$(uname -m)")
node_version=$SECURE_NODE_VERSION
node_sha=$(node_sha256 "$node_arch")
node_dir=/opt/secure-vm/node-v${node_version}-linux-${node_arch}
if [[ ! -x "$node_dir/bin/node" ]]; then
  python3 - "$node_version" "$node_sha" "$node_arch" <<'PY'
import hashlib,sys,urllib.request
from pathlib import Path
version,expected,arch=sys.argv[1:]
path=Path('/tmp/secure-node.tar.xz')
with urllib.request.urlopen('https://nodejs.org/dist/v'+version+'/node-v'+version+'-linux-'+arch+'.tar.xz',timeout=60) as source:
    data=source.read(60*1024*1024)
if hashlib.sha256(data).hexdigest()!=expected:
    raise SystemExit('Node distribution checksum mismatch')
path.write_bytes(data)
PY
  tar -xJf /tmp/secure-node.tar.xz -C /opt/secure-vm
fi
export PATH="$node_dir/bin:/usr/bin:/bin"
build=/opt/secure-vm/pi-build
install -d -m 0755 "$build"
install -m 0644 "$src"/pi/*.mjs "$src/pi/package.json" "$src/pi/package-lock.json" "$build/"
npm ci --prefix "$build" --ignore-scripts --no-audit --no-fund
installed_pi=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$build/node_modules/@earendil-works/pi-coding-agent/package.json")
[[ "$installed_pi" == "$SECURE_PI_VERSION" ]] || { echo "Installed pi $installed_pi does not match cell.env $SECURE_PI_VERSION" >&2; exit 1; }
root=/var/lib/secure-vm/rootfs
install -d -m 0755 "$root/opt/node" "$root/opt/secure-pi"
cp -a "$node_dir/." "$root/opt/node/"
cp -a "$build/." "$root/opt/secure-pi/"
chown -R "$SECURE_CELL_UID_BASE:$SECURE_CELL_UID_BASE" "$root/opt/node" "$root/opt/secure-pi"
install -o "$SECURE_CELL_UID_BASE" -g "$SECURE_CELL_UID_BASE" -m 0644 "$src/check-pi.py" "$root/opt/secure-vm/check-pi.py"
echo "pi $SECURE_PI_VERSION and Node $node_version installed in read-only cell rootfs; no credentials installed in cell."
