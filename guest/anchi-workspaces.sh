#!/bin/bash
# Linux hosts: Lima shares ~/AnchiWorkspaces over 9p at $raw, where the guest kernel checks the
# host's owner uid, so the agent's uid in its cells could not write. bindfs presents the share at
# /mnt/anchi-host with the host owner mapped to the agent's uid: the agent owns its files in the
# cell, files it creates stay the host user's, and no other VM user can write. macOS hosts mount
# virtiofs at /mnt/anchi-host directly and have no $raw. Run as guest root; idempotent.
set -euo pipefail
raw=/mnt/anchi-host-raw/share
dest=/mnt/anchi-host
# shellcheck source=guest/cell.env
source /opt/secure-vm/cell.env
agent=$((SECURE_CELL_UID_BASE + SECURE_CELL_AGENT_UID))
mountpoint -q "$raw" || exit 0
# Only root reaches the raw share.
chmod 0700 "$(dirname "$raw")"
if mountpoint -q "$dest"; then
  [[ ${1:-} == remount ]] || exit 0
  umount "$dest"
fi
mkdir -p "$dest"
owner=$(stat -c %u "$raw")
group=$(stat -c %g "$raw")
bindfs -o allow_other,nodev,nosuid \
  --map="$owner/$agent:@$group/@$agent" "$raw" "$dest"
