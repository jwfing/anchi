#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v limactl >/dev/null || { echo 'Install Lima first: brew install lima' >&2; exit 1; }
if limactl list --format '{{.Name}}' | grep -qx secure-vm; then
  limactl start --tty=false secure-vm
else
  limactl start --tty=false --name=secure-vm lima/secure-vm.yaml
fi
# Explicit copy, never a host-home or project filesystem mount.
limactl shell secure-vm -- mkdir -p /tmp/secure-vm-bootstrap
limactl copy guest/bootstrap.sh guest/cell-run guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py guest/install-gmail.sh secure-vm:/tmp/secure-vm-bootstrap/
limactl copy guest/agent.py guest/check-inference.py secure-vm:/tmp/secure-vm-bootstrap/
limactl copy -r services systemd secure-vm:/tmp/secure-vm-bootstrap/
limactl shell secure-vm -- sudo bash /tmp/secure-vm-bootstrap/bootstrap.sh
limactl shell secure-vm -- sudo bash /tmp/secure-vm-bootstrap/install-gmail.sh
