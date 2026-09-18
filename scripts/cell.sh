#!/bin/bash
set -euo pipefail
exec limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run "$@"
