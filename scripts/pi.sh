#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Prompt is passed via stdin. No token or host credential file enters the cell.
exec limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run \
  /opt/node/bin/node /opt/secure-pi/agent.mjs "$@"
