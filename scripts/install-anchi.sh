#!/bin/bash
# Installs or updates the agent-team guest components: trusted services (including the egress
# proxy), the task-cell manager and the cell runner. Explicit copies only, no host mounts.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/vm-name.sh
source scripts/vm-name.sh
vm_name=$(anchi_vm_name)
# shellcheck source=guest/arch.sh
source guest/arch.sh
if guest_local || limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -Fqx "$vm_name Running"; then
  refuse_if_tasks_running "$vm_name"
fi
runner=anchi/packages/cell-runner/dist
if [[ -f manifest.json ]]; then
  for file in runner.mjs forward.mjs mcp.mjs; do
    [[ -f $runner/$file ]] || { echo "Incomplete Anchi release: missing $file" >&2; exit 1; }
  done
elif [[ ! -f $runner/mcp.mjs || ${ANCHI_REBUNDLE:-1} == 1 ]]; then
  command -v pnpm >/dev/null || { echo 'pnpm is required to bundle the cell runner' >&2; exit 1; }
  # From anchi/, where package.json pins pnpm (corepack reads the pin from the working directory).
  (cd anchi && pnpm --dir packages/cell-runner run bundle >/dev/null)
fi
stage=/tmp/anchi-bootstrap
guest_root "$vm_name" rm -rf "$stage"
guest_sh "$vm_name" mkdir -p "$stage/anchi-cell"
guest_copy "$vm_name" "$stage" guest/cell.env guest/arch.sh guest/install-gmail.sh guest/install-anchi.sh \
  guest/anchi_cell.py guest/anchi_prebuilt.py guest/bootstrap.sh guest/anchi-build-base.sh guest/anchi-build-runtime-*.sh guest/anchi-workspaces.sh guest/check-anchi.py guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py \
  guest/check-security.py guest/check-connectors.py services systemd
guest_copy "$vm_name" "$stage/anchi-cell" "$runner/runner.mjs" "$runner/forward.mjs" "$runner/mcp.mjs"
if [[ -f guest/prebuilt.json ]]; then
  guest_copy "$vm_name" "$stage" guest/prebuilt.json
fi
# install-gmail.sh rewrites installed.json; without the version it would record `unknown`.
guest_root "$vm_name" env SECURE_VM_RUNTIME_VERSION="$(anchi_runtime_version)" bash "$stage/install-gmail.sh"
guest_root "$vm_name" bash "$stage/install-anchi.sh"
