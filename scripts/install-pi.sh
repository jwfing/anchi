#!/bin/bash
set -euo pipefail
vm_name=${QISUO_INSTALL_VM:-${ANCHI_INSTALL_VM:-secure-vm}}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
cd "$(dirname "$0")/.."
export QISUO_INSTALL_VM="$vm_name"
bash scripts/up.sh
limactl shell "$vm_name" -- mkdir -p /tmp/secure-vm-bootstrap/pi
limactl copy pi/package.json pi/package-lock.json pi/*.mjs "$vm_name":/tmp/secure-vm-bootstrap/pi/
limactl copy guest/cell.env guest/install-pi.sh guest/check-pi.py "$vm_name":/tmp/secure-vm-bootstrap/
limactl shell "$vm_name" -- sudo bash /tmp/secure-vm-bootstrap/install-pi.sh
