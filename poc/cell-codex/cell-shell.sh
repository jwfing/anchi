#!/bin/bash
# Guest root. Runs one command as the agent user in a task cell built from the
# codex layer, without the proxy (no network at all). For local probes.
#   cell-shell.sh 'command string'
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
layer=$POC/layers/codex/upper
image=$POC/images/codex
install -d -m 0755 "$image" "$RUN"
mountpoint -q "$image" || mount -t overlay overlay -o "ro,lowerdir=$layer:$BASE" "$image"
trap 'mountpoint -q "$image" && umount "$image"' EXIT
cell_flags "$image"
"${CELL[@]}" --volatile=overlay --machine=anchi-poc-sh --user=agent --drop-capability=all \
  --tmpfs=/tmp:mode=1777,size=256M --setenv=HOME=/home/agent -- /bin/sh -c "cd /home/agent; $1"
