#!/bin/bash
# Guest root. Runs Claude Code as the agent user in a task cell built from the
# "claude" layer. The cell holds a placeholder CLAUDE_CODE_OAUTH_TOKEN; the
# real one only comes from ANCHI_POC_CLAUDE_TOKEN in this script's environment.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
layer=$POC/layers/claude/upper
image=$POC/images/claude
[[ -e $layer/usr/local/bin/claude || -L $layer/usr/local/bin/claude ]] || { echo "build the claude layer first" >&2; exit 1; }

cleanup() {
  mountpoint -q "$image" && umount "$image"
  proxy_down
}
trap cleanup EXIT
install -d -m 0755 "$image"
mountpoint -q "$image" || mount -t overlay overlay -o "ro,lowerdir=$layer:$BASE" "$image"
if [[ -z ${ANCHI_POC_CLAUDE_TOKEN:-} ]]; then
  export ANCHI_POC_CLAUDE_TOKEN=fake-not-real
  echo "proxy: using a FAKE Claude token"
fi
proxy_up
install -m 0644 "$here/cell-run-claude.sh" "$RUN/"

cell_flags "$image"
t0=$(date +%s%N)
"${CELL[@]}" --volatile=overlay --machine=anchi-poc-claude --user=agent --drop-capability=all \
  --tmpfs=/tmp:mode=1777,size=256M --setenv=HOME=/home/agent \
  -- /bin/sh -c "$FWD sh $RUN/cell-run-claude.sh" || echo "== cell exited non-zero"
echo "== cell wall time: $(( ($(date +%s%N) - t0) / 1000000 )) ms"
echo "== proxy log"
proxy_log
