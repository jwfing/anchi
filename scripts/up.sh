#!/bin/bash
set -euo pipefail
vm_name=${QISUO_INSTALL_VM:-${ANCHI_INSTALL_VM:-secure-vm}}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
cd "$(dirname "$0")/.."
command -v limactl >/dev/null || { echo 'Install Lima first: brew install lima' >&2; exit 1; }
# Source tree carries desktop/package.json; the packaged runtime carries manifest.json.
runtime_version=$(python3 - <<'PY'
import json
for name in ('desktop/package.json', 'manifest.json'):
    try:
        print(json.load(open(name))['version'])
        break
    except (OSError, KeyError, ValueError):
        pass
else:
    print('unknown')
PY
)
if limactl list --format '{{.Name}}' | grep -Fqx "$vm_name"; then
  limactl start --tty=false "$vm_name"
else
  limactl start --tty=false --name="$vm_name" lima/secure-vm.yaml
fi
# Explicit copy, never a host-home or project filesystem mount.
limactl shell "$vm_name" -- mkdir -p /tmp/secure-vm-bootstrap
limactl copy guest/cell.env guest/arch.sh guest/bootstrap.sh guest/cell-run guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py guest/install-gmail.sh "$vm_name":/tmp/secure-vm-bootstrap/
limactl copy guest/agent.py guest/check-inference.py guest/check-security.py "$vm_name":/tmp/secure-vm-bootstrap/
limactl copy -r services systemd "$vm_name":/tmp/secure-vm-bootstrap/
limactl shell "$vm_name" -- sudo bash /tmp/secure-vm-bootstrap/bootstrap.sh
limactl shell "$vm_name" -- sudo env SECURE_VM_RUNTIME_VERSION="$runtime_version" bash /tmp/secure-vm-bootstrap/install-gmail.sh
