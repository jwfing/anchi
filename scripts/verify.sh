#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/vm-name.sh
source scripts/vm-name.sh
vm_name=$(anchi_vm_name)
# shellcheck source=guest/arch.sh
source guest/arch.sh
for script in check-cell.py check-gmail.py check-connectors.py; do
  guest_root "$vm_name" /usr/local/sbin/secure-cell-run /usr/bin/python3 "/opt/secure-vm/$script"
done
guest_root "$vm_name" /usr/bin/python3 /opt/secure-vm/check-security.py
