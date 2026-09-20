#!/bin/bash
set -euo pipefail
exec limactl shell secure-vm -- sudo /usr/bin/python3 /opt/secure-vm/services/policy_admin.py "$@"
