#!/bin/bash
# Bootstraps the guest's prerequisites on a remote server (ANCHI_GUEST=local): the machine Anchi
# runs on is the guest, so the files are copied into a staging directory and installed as root.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=guest/arch.sh
source guest/arch.sh
require_guest_local
runtime_version=$(anchi_runtime_version)
refuse_if_tasks_running
# Explicit copy, never a host-home or project filesystem mount. The staging directory is
# cleared first: a server installed by an older release keeps /tmp, and a stale copy would
# reinstall files this release removed.
guest_root rm -rf /tmp/secure-vm-bootstrap
guest_sh mkdir -p /tmp/secure-vm-bootstrap
guest_copy /tmp/secure-vm-bootstrap guest/cell.env guest/arch.sh guest/bootstrap.sh guest/cell-run guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py guest/install-gmail.sh
guest_copy /tmp/secure-vm-bootstrap guest/check-security.py guest/check-connectors.py services systemd
guest_root bash /tmp/secure-vm-bootstrap/bootstrap.sh
guest_root env SECURE_VM_RUNTIME_VERSION="$runtime_version" bash /tmp/secure-vm-bootstrap/install-gmail.sh
