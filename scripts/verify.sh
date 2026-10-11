#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/vm-name.sh
source scripts/vm-name.sh
vm_name=$(anchi_vm_name)
for script in check-cell.py check-gmail.py check-connectors.py; do
  limactl shell "$vm_name" -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 "/opt/secure-vm/$script"
done
limactl shell "$vm_name" -- sudo /usr/bin/python3 /opt/secure-vm/check-security.py
