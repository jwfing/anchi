#!/bin/bash
set -euo pipefail
vm_name=${QISUO_INSTALL_VM:-${ANCHI_INSTALL_VM:-secure-vm}}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
cd "$(dirname "$0")/.."
# shellcheck source=guest/arch.sh
source guest/arch.sh
vm_type=$(host_vm_type "$(uname -s)")
if [[ $vm_type == qemu ]]; then
  command -v limactl >/dev/null || { echo 'Install Lima 2.2.0+ from https://github.com/lima-vm/lima/releases (see docs/GETTING_STARTED.md)' >&2; exit 1; }
  # Lima falls back to slow software emulation without KVM; refuse instead.
  # shellcheck disable=SC2016  # $USER is for the user to type
  [[ -r /dev/kvm && -w /dev/kvm ]] || { echo '/dev/kvm is missing or not accessible: enable CPU virtualization, then: sudo usermod -aG kvm "$USER" and log in again' >&2; exit 1; }
  qemu=qemu-system-$(uname -m)
  command -v "$qemu" >/dev/null || { echo "Install QEMU first ($qemu), for example: sudo apt-get install -y qemu-system-x86 qemu-utils" >&2; exit 1; }
else
  command -v limactl >/dev/null || { echo 'Install Lima first: brew install lima' >&2; exit 1; }
fi
# The version of the checkout, recorded in the VM's installed.json.
runtime_version=$(python3 - <<'PY'
import json
for name in ('anchi/package.json', 'manifest.json'):
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
  limactl start --tty=false --name="$vm_name" --vm-type="$vm_type" lima/secure-vm.yaml
fi
# Explicit copy, never a host-home or project filesystem mount.
limactl shell "$vm_name" -- mkdir -p /tmp/secure-vm-bootstrap
limactl copy guest/cell.env guest/arch.sh guest/bootstrap.sh guest/cell-run guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py guest/install-gmail.sh "$vm_name":/tmp/secure-vm-bootstrap/
limactl copy guest/check-security.py guest/check-connectors.py "$vm_name":/tmp/secure-vm-bootstrap/
limactl copy -r services systemd "$vm_name":/tmp/secure-vm-bootstrap/
limactl shell "$vm_name" -- sudo bash /tmp/secure-vm-bootstrap/bootstrap.sh
limactl shell "$vm_name" -- sudo env SECURE_VM_RUNTIME_VERSION="$runtime_version" bash /tmp/secure-vm-bootstrap/install-gmail.sh
