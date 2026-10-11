#!/bin/bash
set -euo pipefail
# shellcheck source=scripts/vm-name.sh
source "$(dirname "$0")/vm-name.sh"
exec limactl shell "$(anchi_vm_name)" -- sudo /usr/bin/python3 /opt/secure-vm/services/policy_admin.py "$@"
