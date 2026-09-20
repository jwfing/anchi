#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 ]]
src=$(cd "$(dirname "$0")" && pwd)
node_version=22.23.2
node_sha=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
node_dir=/opt/secure-vm/node-v${node_version}-linux-arm64
if [[ ! -x "$node_dir/bin/node" ]]; then
  python3 - "$node_version" "$node_sha" <<'PY'
import hashlib,sys,urllib.request
from pathlib import Path
version,expected=sys.argv[1:]
path=Path('/tmp/secure-node.tar.xz')
with urllib.request.urlopen('https://nodejs.org/dist/v'+version+'/node-v'+version+'-linux-arm64.tar.xz',timeout=60) as source:
    data=source.read(50*1024*1024)
if hashlib.sha256(data).hexdigest()!=expected:
    raise SystemExit('Node distribution checksum mismatch')
path.write_bytes(data)
PY
  tar -xJf /tmp/secure-node.tar.xz -C /opt/secure-vm
fi
export PATH="$node_dir/bin:/usr/bin:/bin"
build=/opt/secure-vm/pi-build
install -d -m 0755 "$build"
install -m 0644 "$src/pi/package.json" "$src/pi/package-lock.json" "$src/pi/agent.mjs" "$src/pi/bridge.mjs" "$src/pi/protocol.mjs" "$src/pi/sessions.mjs" "$src/pi/host-files.mjs" "$build/"
npm ci --prefix "$build" --ignore-scripts --no-audit --no-fund
root=/var/lib/secure-vm/rootfs
install -d -m 0755 "$root/opt/node" "$root/opt/secure-pi"
cp -a "$node_dir/." "$root/opt/node/"
cp -a "$build/." "$root/opt/secure-pi/"
chown -R 524288:524288 "$root/opt/node" "$root/opt/secure-pi"
install -o 524288 -g 524288 -m 0644 "$src/check-pi.py" "$root/opt/secure-vm/check-pi.py"
echo 'pi 0.85.1 and Node 22.23.2 installed in read-only cell rootfs; no credentials installed in cell.'
