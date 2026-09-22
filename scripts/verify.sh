#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
vm_name=${ANCHI_INSTALL_VM:-secure-vm}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
for script in check-cell.py check-gmail.py check-inference.py check-connectors.py; do
  limactl shell "$vm_name" -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 "/opt/secure-vm/$script"
done
limactl shell "$vm_name" -- sudo /usr/bin/python3 /opt/secure-vm/check-security.py
