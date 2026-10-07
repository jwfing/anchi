#!/bin/bash
# Guest root. Runs Codex and git as the agent user in a per-task cell:
#   rootfs = read-only overlay (codex layer over base) + --volatile=overlay.
# Proxy credentials are fake unless the caller passes ANCHI_POC_* variables.
#   ANCHI_POC_SANDBOX        codex --sandbox mode (default workspace-write)
#   ANCHI_POC_BWRAP_PROFILE  1 (default) loads a bwrap-only userns AppArmor
#                            profile for this run; 0 skips it
#   ANCHI_POC_PROMPT         overrides the tool-use prompt
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
layer=$POC/layers/codex/upper
image=$POC/images/codex
aa_profile=/etc/apparmor.d/anchi-poc-bwrap
[[ -x $layer/opt/codex/bin/codex ]] || { echo "build the layer first" >&2; exit 1; }

cleanup() {
  mountpoint -q "$image" && umount "$image"
  apparmor_parser -R "$aa_profile" 2>/dev/null || true
  rm -f "$aa_profile"
  proxy_down
}
trap cleanup EXIT
install -d -m 0755 "$image"
mountpoint -q "$image" || mount -t overlay overlay -o "ro,lowerdir=$layer:$BASE" "$image"

# Codex's own sandbox needs nested user namespaces, which Ubuntu's
# apparmor_restrict_unprivileged_userns blocks. Allow them for bwrap only,
# for the duration of this run.
if [[ ${ANCHI_POC_BWRAP_PROFILE:-1} == 1 ]]; then
  printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' \
    'profile anchi-poc-bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}' >"$aa_profile"
  apparmor_parser -r "$aa_profile" && echo "apparmor: bwrap userns profile loaded for this run"
fi
proxy_up
install -m 0644 "$here/make_placeholders.py" "$here/cell-run-codex.sh" "$RUN/"

default_prompt='Use your shell tool to run "git log --oneline -3" and "ls | head -5" in the current directory. Write both outputs to report.txt in the current directory. Then try to create /etc/anchi-probe and report whether it worked. Finish with one line: DONE.'
cell_flags "$image"
t0=$(date +%s%N)
"${CELL[@]}" --volatile=overlay --machine=anchi-poc-codex --user=agent --drop-capability=all \
  --tmpfs=/tmp:mode=1777,size=256M --setenv=HOME=/home/agent \
  --setenv=ANCHI_POC_PROMPT="${ANCHI_POC_PROMPT:-$default_prompt}" \
  --setenv=ANCHI_POC_SANDBOX="${ANCHI_POC_SANDBOX:-workspace-write}" \
  --setenv=ANCHI_POC_REPO="${ANCHI_POC_REPO:-openai/codex}" \
  --setenv=ANCHI_POC_CODEX_ACCOUNT_ID="${ANCHI_POC_CODEX_ACCOUNT_ID:-}" \
  -- /bin/sh -c "$FWD sh $RUN/cell-run-codex.sh" || echo "== cell exited non-zero"
echo "== cell wall time: $(( ($(date +%s%N) - t0) / 1000000 )) ms"
echo "== proxy log"
proxy_log
