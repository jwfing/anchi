#!/bin/bash
# Architecture mapping and guest helpers shared by guest installers and host scripts. Source it;
# do not execute.
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
# This Anchi's version: the workspace package in a checkout, the manifest in a release.
anchi_runtime_version() {
  local name version
  for name in anchi/package.json manifest.json; do
    [[ -f $name ]] || continue
    # The first "version" key: the package's own in package.json, the only one in manifest.json.
    version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$name" | head -n 1)
    if [[ -n $version ]]; then
      echo "$version"
      return
    fi
  done
  echo unknown
}
# The guest scripts run on the guest itself: a remote server where Anchi runs with
# ANCHI_GUEST=local (such as an instabox VM). On a computer without a guest (ANCHI_GUEST=host,
# the default) there is nothing for them to install, so they refuse. `guest_sh` runs as the
# login user, `guest_root` as root, `guest_copy <dir> <path>...` copies files or folders into a
# directory the login user owns.
guest_local() { [[ ${ANCHI_GUEST:-host} == local ]]; }
require_guest_local() {
  guest_local && return 0
  echo 'This script installs the guest onto the machine it runs on: a remote server with ANCHI_GUEST=local' >&2
  echo '(docs/REMOTE_SERVER.md). The host placement (no VM, the default) has no guest to install.' >&2
  return 1
}
guest_sh() { "$@"; }
guest_root() { sudo -n "$@"; }
guest_copy() {
  local dir=$1
  shift
  cp -R "$@" "$dir/"
}
# Installing restarts the egress proxy, which cuts every running cell off the network and so
# ends its task. Refuse while task cells run (live check cells, `chk-*`, do not count), unless
# ANCHI_FORCE_RESTART=1. A server before its first install has no cells.
refuse_if_tasks_running() {
  local running
  [[ ${ANCHI_FORCE_RESTART:-} == 1 ]] && return 0
  # Parsed by the guest's Python.
  running=$(guest_root /usr/bin/python3 -c '
import json, subprocess
out = subprocess.run(["anchi-cell", "list"], capture_output=True, text=True).stdout
try:
    cells = json.loads(out).get("cells", [])
except ValueError:
    cells = []
print(" ".join(c["task"] for c in cells if c.get("active") and not c["task"].startswith("chk-")))
' 2>/dev/null || true)
  if [[ -n $running ]]; then
    echo "Task cells are live: $running" >&2
    echo "Installing restarts the egress proxy, which cuts them off the network. A cell stays up for 10 minutes" >&2
    echo "after its task's last turn; wait for running tasks to finish and idle cells to close (scripts/anchi tasks)," >&2
    echo "or cancel the tasks, then run this again. ANCHI_FORCE_RESTART=1 installs anyway." >&2
    return 1
  fi
}
