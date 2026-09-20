#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Must run as guest root' >&2; exit 1; }
src=$(cd "$(dirname "$0")" && pwd)
root=/var/lib/secure-vm/rootfs
base=/var/lib/secure-vm
install -d -m 0700 "$base"
if [[ ! -f /usr/share/keyrings/debian-archive-keyring.gpg ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends debian-archive-keyring
fi
if [[ ! -f "$base/rootfs-ready" ]]; then
  if [[ -e "$root" ]]; then
    if [[ ! -f "$base/rootfs-installing" ]]; then
      echo 'Unmanaged incomplete rootfs; manual inspection required.' >&2
      exit 1
    fi
    mv "$root" "$base/rootfs-incomplete-$(date +%s)-$$"
    echo 'Preserved interrupted rootfs; retrying clean bootstrap.'
  fi
  touch "$base/rootfs-installing"
  debootstrap --force-check-gpg --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
    --variant=minbase --include=python3,iproute2,ca-certificates bookworm "$root" https://deb.debian.org/debian
  chroot "$root" /usr/sbin/useradd --uid 1000 --user-group --home-dir /workspace --shell /bin/bash agent
  install -d "$root/workspace" "$root/opt/secure-vm"
  # Let nspawn shift image ownership once, before making the rootfs read-only.
  systemd-nspawn --quiet --register=no --settings=no --directory="$root" \
    --private-users=524288:65536 --private-users-ownership=chown \
    --private-network /bin/true
  touch "$base/rootfs-ready"
  rm -f "$base/rootfs-installing"
fi
install -d -o 525288 -g 525288 -m 0700 "$base/workspace"
install -d -o 524288 -g 524288 -m 0755 "$root/opt/secure-vm"
install -o 524288 -g 524288 -m 0644 "$src/check-cell.py" "$root/opt/secure-vm/check-cell.py"
install -m 0755 "$src/cell-run" /usr/local/sbin/secure-cell-run
install -d -m 0700 /var/lib/secure-vm-host-only
printf 'non-secret isolation canary\n' > /var/lib/secure-vm-host-only/canary
chmod 0600 /var/lib/secure-vm-host-only/canary
printf 'Bootstrap complete. Rootfs: %s; mapped agent UID: 525288\n' "$root"
