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
# How host scripts reach the guest: through Lima from the host, or directly when Anchi runs inside
# the guest itself (ANCHI_GUEST=local: a remote server such as an instabox VM). `guest_sh` runs as
# the login user, `guest_root` as root, `guest_copy <vm> <dir> <path>...` copies files or folders
# into a guest directory the login user owns.
guest_local() { [[ ${ANCHI_GUEST:-lima} == local ]]; }
guest_sh() {
  local vm=$1
  shift
  if guest_local; then "$@"; else limactl shell "$vm" -- "$@"; fi
}
guest_root() {
  local vm=$1
  shift
  if guest_local; then sudo -n "$@"; else limactl shell "$vm" -- sudo -n "$@"; fi
}
guest_copy() {
  local vm=$1 dir=$2
  shift 2
  if guest_local; then cp -R "$@" "$dir/"; else limactl copy -r "$@" "$vm:$dir/"; fi
}
# Installing restarts the egress proxy, which cuts every running cell off the network and so
# ends its task. Refuse while task cells run (live check cells, `chk-*`, do not count), unless
# ANCHI_FORCE_RESTART=1. A VM that is not running has no cells.
refuse_if_tasks_running() {
  local vm=$1 running
  [[ ${ANCHI_FORCE_RESTART:-} == 1 ]] && return 0
  running=$(guest_root "$vm" anchi-cell list 2>/dev/null | python3 -c '
import json, sys
try:
    cells = json.load(sys.stdin).get("cells", [])
except ValueError:
    cells = []
print(" ".join(c["task"] for c in cells if c.get("active") and not c["task"].startswith("chk-")))
' || true)
  if [[ -n $running ]]; then
    echo "Task cells are live in the VM: $running" >&2
    echo "Installing restarts the egress proxy, which cuts them off the network. A cell stays up for 10 minutes" >&2
    echo "after its task's last turn; wait for running tasks to finish and idle cells to close (scripts/anchi tasks)," >&2
    echo "or cancel the tasks, then run this again. ANCHI_FORCE_RESTART=1 installs anyway." >&2
    return 1
  fi
}
