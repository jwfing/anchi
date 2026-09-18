#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash scripts/cell.sh /usr/bin/python3 /opt/secure-vm/agent.py "$@"
