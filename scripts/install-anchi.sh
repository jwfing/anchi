#!/bin/bash
# Installs or updates the agent-team guest components on a remote server (ANCHI_GUEST=local):
# trusted services (including the egress proxy), the task-cell manager and the cell runner.
# Explicit copies only, no host mounts.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=guest/arch.sh
source guest/arch.sh
require_guest_local
refuse_if_tasks_running
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
guest_root rm -rf "$stage"
guest_sh mkdir -p "$stage/anchi-cell"
guest_copy "$stage" guest/cell.env guest/arch.sh guest/install-gmail.sh guest/install-anchi.sh \
  guest/anchi_cell.py guest/anchi_prebuilt.py guest/bootstrap.sh guest/anchi-build-base.sh guest/anchi-build-runtime-*.sh guest/check-anchi.py guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py \
  guest/check-security.py guest/check-connectors.py services systemd
guest_copy "$stage/anchi-cell" "$runner/runner.mjs" "$runner/forward.mjs" "$runner/mcp.mjs"
if [[ -f guest/prebuilt.json ]]; then
  guest_copy "$stage" guest/prebuilt.json
fi
# install-gmail.sh rewrites installed.json; without the version it would record `unknown`.
guest_root env SECURE_VM_RUNTIME_VERSION="$(anchi_runtime_version)" bash "$stage/install-gmail.sh"
guest_root bash "$stage/install-anchi.sh"
