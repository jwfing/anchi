#!/bin/bash
# Guest root. Runs Codex and git as the agent user in a per-task cell:
#   rootfs = read-only overlay (codex layer over base) + --volatile=overlay.
# Proxy credentials are fake unless the caller passes ANCHI_POC_* variables.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
layer=$POC/layers/codex/upper
image=$POC/images/codex
[[ -x $layer/usr/local/bin/codex ]] || { echo "build the layer first" >&2; exit 1; }

cleanup() {
  mountpoint -q "$image" && umount "$image"
  proxy_down
}
trap cleanup EXIT
install -d -m 0755 "$image"
mountpoint -q "$image" || mount -t overlay overlay -o "ro,lowerdir=$layer:$BASE" "$image"
proxy_up
install -m 0644 "$here/make_placeholders.py" "$here/cell-run-codex.sh" "$RUN/"

cell_flags "$image"
t0=$(date +%s%N)
"${CELL[@]}" --volatile=overlay --machine=anchi-poc-codex --user=agent --drop-capability=all \
  --tmpfs=/tmp:mode=1777,size=256M --setenv=HOME=/tmp/home \
  --setenv=ANCHI_POC_PROMPT="${ANCHI_POC_PROMPT:-Reply with exactly: hi}" \
  --setenv=ANCHI_POC_REPO="${ANCHI_POC_REPO:-openai/codex}" \
  --setenv=ANCHI_POC_CODEX_ACCOUNT_ID="${ANCHI_POC_CODEX_ACCOUNT_ID:-}" \
  -- /bin/sh -c "$FWD sh $RUN/cell-run-codex.sh" || echo "== cell exited non-zero"
echo "== cell wall time: $(( ($(date +%s%N) - t0) / 1000000 )) ms"
echo "== proxy log"
proxy_log
