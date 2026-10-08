#!/bin/bash
# Architecture and host mapping shared by guest installers and host scripts. Source it; do not execute.
node_arch() {
  case "$1" in
    aarch64 | arm64) echo arm64 ;;
    x86_64 | amd64) echo x64 ;;
    *)
      echo "Unsupported guest architecture: $1" >&2
      return 1
      ;;
  esac
}
node_sha256() {
  case "$1" in
    arm64) echo "$SECURE_NODE_SHA256_ARM64" ;;
    x64) echo "$SECURE_NODE_SHA256_X64" ;;
    *) return 1 ;;
  esac
}
host_vm_type() {
  case "$1" in
    Darwin) echo vz ;;
    Linux) echo qemu ;;
    *)
      echo "Unsupported host OS: $1" >&2
      return 1
      ;;
  esac
}
# Installing restarts the egress proxy, which cuts every running cell off the network and so
# ends its task. Refuse while task cells run (live check cells, `chk-*`, do not count), unless
# ANCHI_FORCE_RESTART=1. A VM that is not running has no cells.
refuse_if_tasks_running() {
  local vm=$1 running
  [[ ${ANCHI_FORCE_RESTART:-} == 1 ]] && return 0
  running=$(limactl shell "$vm" -- sudo -n anchi-cell list 2>/dev/null | python3 -c '
import json, sys
try:
    cells = json.load(sys.stdin).get("cells", [])
except ValueError:
    cells = []
print(" ".join(c["task"] for c in cells if c.get("active") and not c["task"].startswith("chk-")))
' || true)
  if [[ -n $running ]]; then
    echo "Tasks are running in the VM: $running" >&2
    echo "Installing restarts the egress proxy and would end them. Wait for them to finish (scripts/anchi tasks)," >&2
    echo "or cancel them, then run this again. ANCHI_FORCE_RESTART=1 installs anyway." >&2
    return 1
  fi
}
