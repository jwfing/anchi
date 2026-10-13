#!/bin/bash
# Release CI only: run inside a disposable, privileged Debian container with no credentials.
# Native arm64 and x86_64 jobs build the same scripts used by guest image-build cells.
set -euo pipefail
[[ -f /.dockerenv && $(id -u) == 0 ]] || { echo 'Run in a disposable root Docker container' >&2; exit 1; }
[[ $# == 0 || ($# == 1 && $1 == --verify) ]] || { echo 'Usage: build-prebuilt.sh [--verify]' >&2; exit 1; }
cd /src
output=/output
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends debootstrap debian-archive-keyring ca-certificates curl xz-utils python3 e2fsprogs >/dev/null
# shellcheck source=guest/cell.env
source guest/cell.env
# shellcheck source=guest/arch.sh
source guest/arch.sh
# Overlay upper directories need a real filesystem, not Docker's own overlay upper layer.
truncate -s 16G /tmp/build.ext4
mkfs.ext4 -q /tmp/build.ext4
mkdir -p /buildfs
mount -o loop /tmp/build.ext4 /buildfs
base=/buildfs/rootfs
layers=/buildfs/layers
lib=/opt/secure-vm/anchi
mkdir -p "$lib" "$output" "$layers" /build
cp guest/cell.env /opt/secure-vm/cell.env
cp guest/bootstrap.sh guest/install-anchi.sh "$lib/"
cp guest/anchi-build-base.sh "$lib/build-base.sh"
for runtime in codex claude-code hermes; do
  cp "guest/anchi-build-runtime-$runtime.sh" "$lib/build-runtime-$runtime.sh"
done
debootstrap --force-check-gpg --variant=minbase --include=python3,iproute2,ca-certificates bookworm "$base" https://deb.debian.org/debian >/tmp/debootstrap.log 2>&1 || { tail -n 50 /tmp/debootstrap.log; exit 1; }
chroot "$base" /usr/sbin/useradd --uid "$SECURE_CELL_AGENT_UID" --user-group --home-dir /workspace --shell /bin/bash agent
mkdir -p "$base/workspace" "$base/opt/node" "$base/run/anchi-build"
cp /etc/resolv.conf "$base/etc/resolv.conf"
arch=$(node_arch "$(uname -m)")
curl -fsSL --retry 3 "https://nodejs.org/dist/v$SECURE_NODE_VERSION/node-v$SECURE_NODE_VERSION-linux-$arch.tar.xz" -o /tmp/node.tar.xz
echo "$(node_sha256 "$arch")  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz --strip-components=1 -C "$base/opt/node"
grep -E '^(ANCHI_|SECURE_CELL_AGENT_UID=)' guest/cell.env | sed 's/^/export /' >/build/env
merged=/buildfs/merged
mkdir -p "$merged"
cleanup() {
  umount "$merged/run/anchi-build" 2>/dev/null || true
  umount "$merged/proc" 2>/dev/null || true
  umount "$merged" 2>/dev/null || true
}
trap 'cleanup; umount /buildfs' EXIT
if [[ ${1:-} == --verify ]]; then
  python3 scripts/check-prebuilt.py "$output/prebuilt-$(uname -m).json"
  exit
fi
for image in codex runtime-codex runtime-claude-code runtime-hermes; do
  mkdir -p "$layers/$image/upper" "$layers/$image/work"
  lower=$base
  script=build-base.sh
  if [[ $image != codex ]]; then
    lower=$layers/codex/upper:$base
    script=build-$image.sh
  fi
  mount -t overlay overlay -o "lowerdir=$lower,upperdir=$layers/$image/upper,workdir=$layers/$image/work,metacopy=off,redirect_dir=off,index=off" "$merged"
  cp "$lib/$script" /build/build.sh
  mount --bind /build "$merged/run/anchi-build"
  mount -t proc proc "$merged/proc"
  chroot "$merged" /usr/bin/env -i HOME=/root PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/sh /run/anchi-build/build.sh
  cleanup
  tar --numeric-owner --xattrs --xattrs-include='trusted.overlay.opaque' -czf "$output/anchi-layer-$(uname -m)-$image.tar.gz" -C "$layers/$image/upper" .
done
python3 scripts/prebuilt-manifest.py "$output"
