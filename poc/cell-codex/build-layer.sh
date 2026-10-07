#!/bin/bash
# Guest root. Builds the "codex" agent layer as an overlay upper directory on
# top of the shared base rootfs. The build runs inside a cell whose only
# network path is the PoC proxy; it never sees real credentials.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
codex_version=${CODEX_VERSION:-0.160.0}
case $(uname -m) in
  aarch64) codex_target=aarch64-unknown-linux-musl ;;
  x86_64) codex_target=x86_64-unknown-linux-musl ;;
  *) echo "unsupported arch" >&2; exit 1 ;;
esac

layer=$POC/layers/codex
build=$POC/build
cleanup() {
  umountpoint() { mountpoint -q "$1" && umount "$1"; }
  umountpoint "$build/merged" || true
  proxy_down
}
trap cleanup EXIT

rm -rf "$layer" "$build"
install -d -m 0755 "$layer/upper" "$build/work" "$build/merged"
mount -t overlay overlay -o "lowerdir=$BASE,upperdir=$layer/upper,workdir=$build/work" "$build/merged"
proxy_up
install -m 0644 "$here/cell-build.sh" "$RUN/"

cell_flags "$build/merged"
t0=$(date +%s)
# Build cell: cell root with namespaced capabilities (needed by dpkg), still
# --private-network and user-namespaced.
"${CELL[@]}" --machine=anchi-poc-build --tmpfs=/tmp:mode=1777 \
  --setenv=CODEX_VERSION="$codex_version" --setenv=CODEX_TARGET="$codex_target" \
  -- /bin/sh -c "$FWD sh $RUN/cell-build.sh"
echo "== build took $(( $(date +%s) - t0 )) s; layer size: $(du -sh "$layer/upper" | cut -f1)"
echo "== proxy log for the build"
proxy_log
