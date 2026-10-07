#!/bin/bash
# Installs or updates the agent-team guest components: trusted services (including the egress
# proxy), the task-cell manager and the cell runner. Explicit copies only, no host mounts.
set -euo pipefail
vm_name=${ANCHI_INSTALL_VM:-secure-vm}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
cd "$(dirname "$0")/.."
runner=anchi/packages/cell-runner/dist
if [[ ! -f $runner/runner.mjs || ${ANCHI_REBUNDLE:-1} == 1 ]]; then
  command -v pnpm >/dev/null || { echo 'pnpm is required to bundle the cell runner' >&2; exit 1; }
  pnpm --dir anchi/packages/cell-runner run bundle >/dev/null
fi
stage=/tmp/anchi-bootstrap
limactl shell "$vm_name" -- bash -c "rm -rf $stage && mkdir -p $stage/anchi-cell"
limactl copy guest/cell.env guest/arch.sh guest/install-gmail.sh guest/install-anchi.sh \
  guest/anchi_cell.py guest/anchi-build-base.sh guest/check-anchi.py guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py \
  guest/agent.py guest/check-inference.py guest/check-security.py guest/check-connectors.py "$vm_name:$stage/"
limactl copy "$runner/runner.mjs" "$runner/forward.mjs" "$vm_name:$stage/anchi-cell/"
limactl copy -r services systemd "$vm_name:$stage/"
limactl shell "$vm_name" -- sudo bash "$stage/install-gmail.sh"
limactl shell "$vm_name" -- sudo bash "$stage/install-anchi.sh"
