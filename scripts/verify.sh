#!/bin/bash
# Live isolation and service checks of the guest (a remote server, ANCHI_GUEST=local).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=guest/arch.sh
source guest/arch.sh
require_guest_local
for script in check-cell.py check-gmail.py check-connectors.py; do
  guest_root /usr/local/sbin/secure-cell-run /usr/bin/python3 "/opt/secure-vm/$script"
done
guest_root /usr/bin/python3 /opt/secure-vm/check-security.py
