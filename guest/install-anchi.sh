#!/bin/bash
# Installs the agent-team pieces: egress proxy service, task-cell manager and cell runner.
# Run after bootstrap.sh and install-gmail.sh (trusted services).
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Must run as guest root' >&2; exit 1; }
src=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=guest/cell.env
source "$src/cell.env"
rootfs=/var/lib/secure-vm/rootfs
# Node for the cell runner, in the read-only cell rootfs: pinned version, checked SHA-256.
# shellcheck source=guest/arch.sh
source "$src/arch.sh"
node_arch=$(node_arch "$(uname -m)")
node_dir=/opt/secure-vm/node-v${SECURE_NODE_VERSION}-linux-${node_arch}
if [[ ! -x $node_dir/bin/node ]]; then
  python3 - "$SECURE_NODE_VERSION" "$(node_sha256 "$node_arch")" "$node_arch" <<'PY'
import hashlib, sys, urllib.request
from pathlib import Path
version, expected, arch = sys.argv[1:]
url = f'https://nodejs.org/dist/v{version}/node-v{version}-linux-{arch}.tar.xz'
with urllib.request.urlopen(url, timeout=60) as source:
    data = source.read(60 * 1024 * 1024)
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Node distribution checksum mismatch')
Path('/tmp/secure-node.tar.xz').write_bytes(data)
PY
  tar -xJf /tmp/secure-node.tar.xz -C /opt/secure-vm
  rm -f /tmp/secure-node.tar.xz
fi
if [[ ! -x $rootfs/opt/node/bin/node ]] || ! cmp -s "$node_dir/bin/node" "$rootfs/opt/node/bin/node"; then
  rm -rf "$rootfs/opt/node" && install -d -m 0755 "$rootfs/opt/node"
  cp -a "$node_dir/." "$rootfs/opt/node/"
  chown -R "$SECURE_CELL_UID_BASE:$SECURE_CELL_UID_BASE" "$rootfs/opt/node"
fi
# Pi was retired with the desktop app; remove what it left in the cell rootfs.
rm -rf "$rootfs/opt/secure-pi" /opt/secure-vm/pi-build "$rootfs/opt/secure-vm/check-pi.py" \
  "$rootfs/opt/secure-vm/agent.py" "$rootfs/opt/secure-vm/check-inference.py"
for f in anchi-cell/runner.mjs anchi-cell/forward.mjs anchi-cell/mcp.mjs anchi_cell.py anchi-build-base.sh check-anchi.py; do
  [[ -f $src/$f ]] || { echo "missing $f in bootstrap bundle" >&2; exit 1; }
done
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends python3-venv
fi
id anchi-egress >/dev/null 2>&1 ||
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin anchi-egress
usermod -a -G secure-auth-clients anchi-egress

venv=/opt/anchi-egress/venv
want="$ANCHI_MITMPROXY_VERSION $ANCHI_BOTOCORE_VERSION"
have=$("$venv/bin/python" -c 'import mitmproxy.version as m, botocore; print(m.VERSION, botocore.__version__)' 2>/dev/null || true)
if [[ $have != "$want" ]]; then
  rm -rf "$venv"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet --disable-pip-version-check \
    "mitmproxy==$ANCHI_MITMPROXY_VERSION" "botocore==$ANCHI_BOTOCORE_VERSION"
fi

install -d -m 0755 /opt/secure-vm/services /opt/secure-vm/anchi
install -m 0644 "$src"/services/egress_rules.py "$src"/services/egress_proxy.py /opt/secure-vm/services/
install -m 0644 "$src/anchi-cell/runner.mjs" "$src/anchi-cell/forward.mjs" "$src/anchi-cell/mcp.mjs" /opt/secure-vm/anchi/
install -m 0644 "$src/anchi-build-base.sh" /opt/secure-vm/anchi/build-base.sh
install -m 0755 "$src/anchi_cell.py" /opt/secure-vm/anchi/anchi_cell.py
install -m 0755 "$src/check-anchi.py" /opt/secure-vm/check-anchi.py
ln -sf /opt/secure-vm/anchi/anchi_cell.py /usr/local/sbin/anchi-cell
ln -sf /opt/secure-vm/anchi/anchi_cell.py /usr/local/sbin/anchi-image
install -d -m 0700 /var/lib/anchi
install -d -m 0755 /var/lib/anchi/layers /var/lib/anchi/agents

install -m 0644 "$src/systemd/anchi-egress.service" /etc/systemd/system/
systemctl daemon-reload
# Network rules include the proxy user's backstop once the user exists.
systemctl restart secure-egress.service
systemctl enable anchi-egress.service
systemctl restart anchi-egress.service
ca=/var/lib/anchi-egress/mitm/mitmproxy-ca-cert.pem
for _ in $(seq 1 60); do
  [[ -S /run/anchi-egress/control.sock && -f $ca ]] && break
  sleep 0.5
done
[[ -S /run/anchi-egress/control.sock && -f $ca ]] || { echo 'egress proxy did not start' >&2; exit 1; }
install -m 0644 "$ca" /var/lib/anchi/proxy-ca.pem
cat "$rootfs/etc/ssl/certs/ca-certificates.crt" "$ca" >/var/lib/anchi/ca-bundle.pem.new
chmod 0644 /var/lib/anchi/ca-bundle.pem.new
mv /var/lib/anchi/ca-bundle.pem.new /var/lib/anchi/ca-bundle.pem
anchi-cell reap >/dev/null
echo 'Agent-team egress proxy and task-cell manager installed. Build the base image with: anchi-image build codex base'
